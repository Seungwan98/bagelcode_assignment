import type { AgentMessage, AgentRole, RunState } from '@/lib/protocol/types';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createAgentManagers, type AgentManagers } from '@/lib/runner/agent-managers';
import type { AgentDefinition } from '@/lib/runner/agent-definitions';
import type { AgentPromptContext } from '@/lib/runner/agent-prompt-builder';
import {
  emptyImplementationEvidence,
  formatOrchestratorInterventionDecision,
  formatOrchestratorAssignment,
  formatOrchestratorPlanSummary,
  formatOrchestratorVerdict,
  implementationEvidenceFromText,
  inferDeliverableType,
  orchestratorPlanFromVerdict,
  orchestratorPlanFromRoles,
  parseOrchestratorInterventionDecision,
  parseOrchestratorPlan,
  parseOrchestratorVerdict,
  mergeImplementationEvidence,
  type OrchestratorInterventionDecision,
  type OrchestratorPlan,
  type OrchestratorVerdict,
  type WorkerAgentRole,
} from '@/lib/runner/orchestrator-plan';
import { appendEvent, implementationWorkspaceDir, readMessages, updateRunStatus } from '@/lib/store/file-store';
import { createId, nowIso } from '@/lib/utils/ids';
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
const MAX_IMPLEMENTATION_WORKSPACE_FILES = 80;

type InterventionDecisionOutcome = 'continue' | 'continue_with_intervention' | 'restart' | 'paused';

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
    { strategy: managers.orchestratorStrategy.id, fallback: true, deliverableType: inferDeliverableType(state.run.brief) },
  );
}

function nextStepAgent(plan: OrchestratorPlan, index: number): WorkerAgentRole | undefined {
  return plan.steps[index + 1]?.agent;
}

function maxVerificationIterations(): number {
  const configured = Number(process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS ?? DEFAULT_MAX_VERIFICATION_ITERATIONS);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_MAX_VERIFICATION_ITERATIONS;
  return Math.floor(configured);
}

async function listWorkspaceFiles(root: string, current = root, files: string[] = []): Promise<string[]> {
  if (files.length >= MAX_IMPLEMENTATION_WORKSPACE_FILES) return files;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw error;
  }

  for (const entry of entries) {
    if (files.length >= MAX_IMPLEMENTATION_WORKSPACE_FILES) break;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next') continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await listWorkspaceFiles(root, path, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await stat(path).catch(() => undefined);
    if (!fileStat?.isFile()) continue;
    files.push(relative(root, path));
  }
  return files;
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
  const implementationWorkspace = implementationWorkspaceDir(context.runId);
  const processedInterventionIds = new Set(
    input.messages.filter((message) => message.kind === 'user_intervention').map((message) => message.id),
  );
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
    return parseOrchestratorPlan(rawPlan, input.state, context.userRequest);
  }

  async function collectImplementationEvidence(candidateAnswer: string) {
    const workspaceFiles = await listWorkspaceFiles(implementationWorkspace);
    const handoffEvidenceText = context.handoffMessages
      .filter((message) => message.from !== 'orchestrator')
      .map((message) => message.body)
      .join('\n\n');
    return mergeImplementationEvidence(
      mergeImplementationEvidence(
        {
          ...emptyImplementationEvidence(implementationWorkspace),
          workspaceFiles,
        },
        implementationEvidenceFromText(handoffEvidenceText, implementationWorkspace),
      ),
      implementationEvidenceFromText(candidateAnswer, implementationWorkspace),
    );
  }

  async function readPendingRuntimeInterventions(): Promise<AgentMessage[]> {
    const latestMessages = await readMessages(context.runId);
    return latestMessages.filter((message) => (
      message.kind === 'user_intervention'
      && !processedInterventionIds.has(message.id)
    ));
  }

  function markInterventionsProcessed(messages: AgentMessage[]): void {
    for (const message of messages) processedInterventionIds.add(message.id);
  }

  async function recordInterventionDecision(
    decision: OrchestratorInterventionDecision,
    pendingInterventions: AgentMessage[],
    target: string,
  ): Promise<void> {
    await appendEvent(context.runId, {
      id: createId('evt'),
      runId: context.runId,
      type: 'intervention.decision_made',
      actor: 'orchestrator',
      payload: {
        action: decision.action,
        reason: decision.reason,
        instruction: decision.instruction,
        question: decision.question,
        target,
        interventionIds: pendingInterventions.map((message) => message.id),
        interventionCount: pendingInterventions.length,
        fallback: decision.fallback,
        parseError: decision.parseError,
      },
      createdAt: nowIso(),
    });
  }

  async function invokeOrchestratorInterventionDecision(inputDecision: {
    pendingInterventions: AgentMessage[];
    currentAgent: AgentRole;
    nextAgent?: WorkerAgentRole;
    plan: OrchestratorPlan;
  }): Promise<OrchestratorInterventionDecision> {
    const definition = managers.agentRegistry.get('orchestrator');
    const decisionContext: AgentExecutionContext = {
      ...context,
      orchestratorTask: 'intervention',
      deliverableType: inputDecision.plan.deliverableType,
      implementationWorkspace,
      pendingInterventions: inputDecision.pendingInterventions,
      interventionCheckpoint: {
        currentAgent: inputDecision.currentAgent,
        nextAgent: inputDecision.nextAgent,
      },
    };
    const rawDecision = await input.invokeAgent({
      definition,
      prompt: managers.promptBuilder.build(definition, decisionContext),
      context: decisionContext,
    });
    recordOrchestratorOutput(rawDecision);
    return parseOrchestratorInterventionDecision(rawDecision, inputDecision.pendingInterventions);
  }

  async function handlePendingInterventions(inputDecision: {
    currentAgent: AgentRole;
    nextAgent?: WorkerAgentRole;
    plan: OrchestratorPlan;
  }): Promise<InterventionDecisionOutcome> {
    const pendingInterventions = await readPendingRuntimeInterventions();
    if (!pendingInterventions.length) return 'continue';

    context.visibleConversation.push(...pendingInterventions);
    markInterventionsProcessed(pendingInterventions);

    if (!orchestratorEnabled) return 'continue';

    const decision = await invokeOrchestratorInterventionDecision({
      pendingInterventions,
      currentAgent: inputDecision.currentAgent,
      nextAgent: inputDecision.nextAgent,
      plan: inputDecision.plan,
    });
    const decisionBody = formatOrchestratorInterventionDecision(decision, pendingInterventions);

    if (decision.action === 'ask_user') {
      const question = await managers.messageBus.send({
        runId: context.runId,
        from: 'orchestrator',
        to: 'user',
        kind: 'question',
        body: decision.question ?? '현재 작업을 중단할지, 기존 결과에 추가 조건으로 반영할지 알려주세요.',
      });
      context.visibleConversation.push(question);
      emittedMessages.push(question);
      await recordInterventionDecision(decision, pendingInterventions, 'user');
      await updateRunStatus(context.runId, 'paused');
      return 'paused';
    }

    const target = decision.action === 'restart'
      ? 'all'
      : (inputDecision.nextAgent ?? inputDecision.plan.finalResponder);
    const message = await managers.messageBus.send({
      runId: context.runId,
      from: 'orchestrator',
      to: target,
      kind: 'instruction',
      body: decisionBody,
      requiresAck: target !== 'all',
    });
    context.handoffMessages.push(message);
    emittedMessages.push(message);
    await recordInterventionDecision(decision, pendingInterventions, target);

    if (decision.action === 'restart') {
      const latestIntervention = pendingInterventions.at(-1);
      context.turnUserMessageId = latestIntervention?.id ?? context.turnUserMessageId;
      context.userRequest = decision.instruction
        ?? pendingInterventions.map((intervention) => intervention.body).join('\n');
      return 'restart';
    }

    return 'continue_with_intervention';
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

  async function executePlan(plan: OrchestratorPlan): Promise<{
    candidateAnswer: string;
    restarted: boolean;
    paused: boolean;
  }> {
    let candidateAnswer = '';
    await emitPlanMessages(plan);

    const initialInterventionOutcome = await handlePendingInterventions({
      currentAgent: 'orchestrator',
      nextAgent: plan.steps[0]?.agent,
      plan,
    });
    if (initialInterventionOutcome === 'paused') return { candidateAnswer, restarted: false, paused: true };
    if (initialInterventionOutcome === 'restart') return { candidateAnswer, restarted: true, paused: false };

    for (const [index, step] of plan.steps.entries()) {
      if (await input.shouldStop?.()) return { candidateAnswer, restarted: false, paused: false };

      const definition = managers.agentRegistry.get(step.agent);
      const stepContext: AgentExecutionContext = {
        ...context,
        deliverableType: plan.deliverableType,
        implementationWorkspace,
      };
      const body = await input.invokeAgent({
        definition,
        prompt: managers.promptBuilder.build(definition, stepContext),
        context: stepContext,
      });
      outputs[step.agent] = body;

      if (await input.shouldStop?.()) return { candidateAnswer, restarted: false, paused: false };

      const nextAgent = nextStepAgent(plan, index);
      if (nextAgent) {
        const message = await managers.messageBus.send({
          runId: context.runId,
          from: definition.id,
          to: nextAgent,
          kind: definition.handoffKind,
          body,
        });
        context.handoffMessages.push(message);
        emittedMessages.push(message);
      }

      if (definition.id === plan.finalResponder) {
        const candidateMessage = await managers.messageBus.send({
          runId: context.runId,
          from: definition.id,
          to: 'orchestrator',
          kind: definition.id === 'reviewer' ? 'review' : 'result',
          body,
        });
        context.handoffMessages.push(candidateMessage);
        emittedMessages.push(candidateMessage);
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

      const interventionOutcome = await handlePendingInterventions({
        currentAgent: definition.id,
        nextAgent,
        plan,
      });
      if (interventionOutcome === 'paused') return { candidateAnswer, restarted: false, paused: true };
      if (interventionOutcome === 'restart') return { candidateAnswer, restarted: true, paused: false };
    }

    return { candidateAnswer, restarted: false, paused: false };
  }

  async function invokeOrchestratorVerdict(
    candidateAnswer: string,
    iteration: number,
    plan: OrchestratorPlan,
  ): Promise<OrchestratorVerdict> {
    const definition = managers.agentRegistry.get('orchestrator');
    const implementationEvidence = await collectImplementationEvidence(candidateAnswer);
    const verificationContext: AgentExecutionContext = {
      ...context,
      orchestratorTask: 'verify',
      deliverableType: plan.deliverableType,
      implementationWorkspace,
      implementationEvidence,
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
    const verdict = parseOrchestratorVerdict(rawVerdict, input.state, candidateAnswer, {
      deliverableType: plan.deliverableType,
      implementationEvidence,
    });
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
    const execution = await executePlan(orchestratorPlan);
    if (execution.paused) return stoppedResult(true);
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
  let iteration = 1;
  while (iteration <= maxIterations) {
    if (await input.shouldStop?.()) return stoppedResult(true);
    const execution = await executePlan(currentPlan);
    if (execution.paused) return stoppedResult(true);
    if (execution.restarted) {
      if (await input.shouldStop?.()) return stoppedResult(true);
      currentPlan = await invokeOrchestratorPlan();
      orchestratorPlan = currentPlan;
      continue;
    }

    const finalInterventionOutcome = await handlePendingInterventions({
      currentAgent: 'orchestrator',
      plan: currentPlan,
    });
    if (finalInterventionOutcome === 'paused') return stoppedResult(true);
    if (finalInterventionOutcome === 'restart') {
      if (await input.shouldStop?.()) return stoppedResult(true);
      currentPlan = await invokeOrchestratorPlan();
      orchestratorPlan = currentPlan;
      continue;
    }

    const { candidateAnswer } = execution;
    if (await input.shouldStop?.()) return stoppedResult(true);

    const verdict = await invokeOrchestratorVerdict(candidateAnswer, iteration, currentPlan);
    if (await input.shouldStop?.()) return stoppedResult(true);

    const postVerdictInterventionOutcome = await handlePendingInterventions({
      currentAgent: 'orchestrator',
      plan: currentPlan,
    });
    if (postVerdictInterventionOutcome === 'paused') return stoppedResult(true);
    if (postVerdictInterventionOutcome === 'restart') {
      if (await input.shouldStop?.()) return stoppedResult(true);
      currentPlan = await invokeOrchestratorPlan();
      orchestratorPlan = currentPlan;
      continue;
    }
    if (postVerdictInterventionOutcome === 'continue_with_intervention') {
      currentPlan = orchestratorPlanFromRoles(
        [currentPlan.finalResponder],
        'Orchestrator 검증 중 도착한 사용자 개입을 최종 후보에 반영하기 위해 마지막 Agent를 다시 실행합니다.',
        {
          strategy: 'orchestrator-late-intervention',
          deliverableType: currentPlan.deliverableType,
        },
      );
      continue;
    }

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

    currentPlan = orchestratorPlanFromVerdict(verdict, input.state, iteration + 1, currentPlan.deliverableType);
    iteration += 1;
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
