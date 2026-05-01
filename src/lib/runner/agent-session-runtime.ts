import type { AgentMessage, AgentRole, RunState } from '@/lib/protocol/types';
import { createAgentManagers, type AgentManagers } from '@/lib/runner/agent-managers';
import type { AgentDefinition } from '@/lib/runner/agent-definitions';
import type { AgentPromptContext } from '@/lib/runner/agent-prompt-builder';
import {
  formatOrchestratorAssignment,
  formatOrchestratorPlanSummary,
  formatOrchestratorVerdict,
  orchestratorPlanFromVerdict,
  orchestratorPlanFromRoles,
  parseOrchestratorPlan,
  parseOrchestratorVerdict,
  type OrchestratorPlan,
  type OrchestratorVerdict,
  type WorkerAgentRole,
} from '@/lib/runner/orchestrator-plan';
export { buildAgentPrompt } from '@/lib/runner/agent-prompt-builder';

export type AgentExecutionContext = AgentPromptContext;

export interface AgentExecutionInput {
  definition: AgentDefinition;
  prompt: string;
  context: AgentExecutionContext;
}

export interface AgentConversationResult {
  context: AgentExecutionContext;
  outputs: Partial<Record<AgentRole, string>>;
  emittedMessages: AgentMessage[];
  orchestratorPlan: OrchestratorPlan;
  orchestratorVerdicts: OrchestratorVerdict[];
  verificationIterations: number;
  stopped: boolean;
  userAnswer?: string;
}

const MAX_CONTEXT_MESSAGES = 12;
const DEFAULT_MAX_VERIFICATION_ITERATIONS = 3;

function isUserFacingMessage(message: AgentMessage): boolean {
  return message.from === 'user' || message.to === 'user';
}

function isAgentHandoff(message: AgentMessage): boolean {
  return message.from !== 'user' && message.to !== 'user' && message.to !== 'all';
}

function latestTurnStart(messages: AgentMessage[]): { message: AgentMessage | undefined; index: number } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === 'user_intervention') return { message: messages[index], index };
  }
  return { message: undefined, index: -1 };
}

export function createAgentExecutionContext(state: RunState, messages: AgentMessage[]): AgentExecutionContext {
  const turn = latestTurnStart(messages);
  const userRequest = turn.message?.body ?? state.run.brief;
  const afterTurn = turn.index >= 0 ? messages.slice(turn.index + 1) : messages;

  return {
    runId: state.run.id,
    turnUserMessageId: turn.message?.id ?? 'initial-brief',
    userRequest,
    visibleConversation: messages.filter(isUserFacingMessage).slice(-MAX_CONTEXT_MESSAGES),
    handoffMessages: afterTurn.filter(isAgentHandoff),
  };
}

function isWorkerRole(role: AgentRole): role is WorkerAgentRole {
  return role !== 'orchestrator';
}

function isOrchestratorEnabled(state: RunState): boolean {
  return state.agents.some((agent) => agent.role === 'orchestrator');
}

function fallbackPlanFromStrategy(state: RunState, managers: AgentManagers): OrchestratorPlan {
  const roles = managers.orchestratorStrategy.selectRoles(state).filter(isWorkerRole);
  return orchestratorPlanFromRoles(
    roles,
    'Orchestrator Agent가 비활성화되어 configured strategy가 Agent 실행 순서를 선택했습니다.',
    { strategy: managers.orchestratorStrategy.id, fallback: true },
  );
}

function nextStepAgent(plan: OrchestratorPlan, index: number): WorkerAgentRole | undefined {
  return plan.steps[index + 1]?.agent;
}

function handoffKindFor(definition: AgentDefinition, nextAgent: WorkerAgentRole | undefined): AgentMessage['kind'] {
  if (!nextAgent) return definition.userFacing ? 'result' : definition.handoffKind;
  return definition.handoffKind;
}

function maxVerificationIterations(): number {
  const configured = Number(process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS ?? DEFAULT_MAX_VERIFICATION_ITERATIONS);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_MAX_VERIFICATION_ITERATIONS;
  return Math.floor(configured);
}

export async function runAgentConversation(input: {
  state: RunState;
  messages: AgentMessage[];
  invokeAgent: (input: AgentExecutionInput) => Promise<string>;
  shouldStop?: () => Promise<boolean>;
  managers?: Partial<AgentManagers>;
}): Promise<AgentConversationResult> {
  const managers = createAgentManagers(input.managers);
  const context = createAgentExecutionContext(input.state, input.messages);
  const outputs: Partial<Record<AgentRole, string>> = {};
  const emittedMessages: AgentMessage[] = [];
  const orchestratorVerdicts: OrchestratorVerdict[] = [];
  let userAnswer: string | undefined;
  let orchestratorPlan = fallbackPlanFromStrategy(input.state, managers);
  const orchestratorEnabled = isOrchestratorEnabled(input.state);
  const maxIterations = maxVerificationIterations();

  function stoppedResult(stopped: true): AgentConversationResult {
    return {
      context,
      outputs,
      emittedMessages,
      orchestratorPlan,
      orchestratorVerdicts,
      verificationIterations: orchestratorVerdicts.length,
      stopped,
      userAnswer,
    };
  }

  function recordOrchestratorOutput(raw: string): void {
    outputs.orchestrator = outputs.orchestrator
      ? `${outputs.orchestrator}\n\n--- Orchestrator Pass ---\n\n${raw}`
      : raw;
  }

  async function invokeOrchestratorPlan(): Promise<OrchestratorPlan> {
    const definition = managers.agentRegistry.get('orchestrator');
    const rawPlan = await input.invokeAgent({
      definition,
      prompt: managers.promptBuilder.build(definition, {
        ...context,
        orchestratorTask: 'plan',
      }),
      context: {
        ...context,
        orchestratorTask: 'plan',
      },
    });
    recordOrchestratorOutput(rawPlan);
    return parseOrchestratorPlan(rawPlan, input.state);
  }

  async function emitPlanMessages(plan: OrchestratorPlan): Promise<void> {
    if (!orchestratorEnabled) return;
    const summary = await managers.messageBus.send({
      runId: context.runId,
      from: 'orchestrator',
      to: 'all',
      kind: 'instruction',
      body: formatOrchestratorPlanSummary(plan),
    });
    context.handoffMessages.push(summary);
    emittedMessages.push(summary);

    for (const step of plan.steps) {
      const message = await managers.messageBus.send({
        runId: context.runId,
        from: 'orchestrator',
        to: step.agent,
        kind: 'instruction',
        body: formatOrchestratorAssignment(plan, step),
        requiresAck: true,
      });
      context.handoffMessages.push(message);
      emittedMessages.push(message);
    }
  }

  async function executePlan(plan: OrchestratorPlan): Promise<string> {
    let candidateAnswer = '';
    await emitPlanMessages(plan);

    for (const [index, step] of plan.steps.entries()) {
      if (await input.shouldStop?.()) return candidateAnswer;

      const definition = managers.agentRegistry.get(step.agent);
      const body = await input.invokeAgent({
        definition,
        prompt: managers.promptBuilder.build(definition, context),
        context,
      });
      outputs[step.agent] = body;

      if (await input.shouldStop?.()) return candidateAnswer;

      const nextAgent = nextStepAgent(plan, index);
      if (nextAgent) {
        const message = await managers.messageBus.send({
          runId: context.runId,
          from: definition.id,
          to: nextAgent,
          kind: handoffKindFor(definition, nextAgent),
          body,
        });
        context.handoffMessages.push(message);
        emittedMessages.push(message);
      }

      if (definition.id === plan.finalResponder) {
        const reviewMessage = await managers.messageBus.send({
          runId: context.runId,
          from: definition.id,
          to: 'orchestrator',
          kind: 'review',
          body,
        });
        context.handoffMessages.push(reviewMessage);
        emittedMessages.push(reviewMessage);
        candidateAnswer = body;

        if (!orchestratorEnabled) {
          const userMessage = await managers.messageBus.send({
            runId: context.runId,
            from: definition.id,
            to: 'user',
            kind: 'result',
            body,
          });
          context.visibleConversation.push(userMessage);
          emittedMessages.push(userMessage);
          userAnswer = body;
        }
      }
    }

    return candidateAnswer;
  }

  async function invokeOrchestratorVerdict(candidateAnswer: string, iteration: number): Promise<OrchestratorVerdict> {
    const definition = managers.agentRegistry.get('orchestrator');
    const verificationContext: AgentExecutionContext = {
      ...context,
      orchestratorTask: 'verify',
      candidateAnswer,
      verificationIteration: iteration,
      maxVerificationIterations: maxIterations,
    };
    const rawVerdict = await input.invokeAgent({
      definition,
      prompt: managers.promptBuilder.build(definition, verificationContext),
      context: verificationContext,
    });
    recordOrchestratorOutput(rawVerdict);
    const verdict = parseOrchestratorVerdict(rawVerdict, input.state, candidateAnswer);
    orchestratorVerdicts.push(verdict);

    const verdictMessage = await managers.messageBus.send({
      runId: context.runId,
      from: 'orchestrator',
      to: 'orchestrator',
      kind: 'review',
      body: formatOrchestratorVerdict(verdict, iteration),
    });
    context.handoffMessages.push(verdictMessage);
    emittedMessages.push(verdictMessage);
    return verdict;
  }

  async function sendOrchestratorAnswer(body: string): Promise<void> {
    const userMessage = await managers.messageBus.send({
      runId: context.runId,
      from: 'orchestrator',
      to: 'user',
      kind: 'result',
      body,
    });
    context.visibleConversation.push(userMessage);
    emittedMessages.push(userMessage);
    userAnswer = body;
  }

  if (orchestratorEnabled) {
    if (await input.shouldStop?.()) return stoppedResult(true);
    orchestratorPlan = await invokeOrchestratorPlan();
    if (await input.shouldStop?.()) return stoppedResult(true);
  }

  if (!orchestratorEnabled) {
    await executePlan(orchestratorPlan);
    if (await input.shouldStop?.()) return stoppedResult(true);
    return {
      context,
      outputs,
      emittedMessages,
      orchestratorPlan,
      orchestratorVerdicts,
      verificationIterations: orchestratorVerdicts.length,
      stopped: false,
      userAnswer,
    };
  }

  let currentPlan = orchestratorPlan;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (await input.shouldStop?.()) return stoppedResult(true);
    const candidateAnswer = await executePlan(currentPlan);
    if (await input.shouldStop?.()) return stoppedResult(true);

    const verdict = await invokeOrchestratorVerdict(candidateAnswer, iteration);
    if (await input.shouldStop?.()) return stoppedResult(true);

    if (verdict.status === 'complete') {
      await sendOrchestratorAnswer(verdict.userAnswer ?? candidateAnswer);
      break;
    }

    if (iteration >= maxIterations) {
      await sendOrchestratorAnswer([
        verdict.userAnswer || candidateAnswer,
        '',
        `Orchestrator가 ${iteration}/${maxIterations}회 검증 후에도 미완성 요소를 감지했습니다.`,
        `남은 리스크: ${verdict.reason}`,
      ].filter(Boolean).join('\n'));
      break;
    }

    currentPlan = orchestratorPlanFromVerdict(verdict, input.state, iteration + 1);
  }

  return {
    context,
    outputs,
    emittedMessages,
    orchestratorPlan,
    orchestratorVerdicts,
    verificationIterations: orchestratorVerdicts.length,
    stopped: false,
    userAnswer,
  };
}
