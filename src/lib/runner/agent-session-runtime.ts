import type { AgentMessage, AgentRole, RunState } from '@/lib/protocol/types';
import { sendMessage } from '@/lib/bus/message-bus';
import { getAgentDefinition, type AgentDefinition } from '@/lib/runner/agent-definitions';

export interface AgentExecutionContext {
  runId: string;
  turnUserMessageId: string;
  userRequest: string;
  visibleConversation: AgentMessage[];
  handoffMessages: AgentMessage[];
}

export interface AgentExecutionInput {
  definition: AgentDefinition;
  prompt: string;
  context: AgentExecutionContext;
}

export interface AgentConversationResult {
  context: AgentExecutionContext;
  outputs: Partial<Record<AgentRole, string>>;
  emittedMessages: AgentMessage[];
  stopped: boolean;
  userAnswer?: string;
}

const MAX_CONTEXT_MESSAGES = 12;
const EXECUTION_ORDER: AgentRole[] = ['planner', 'engineer', 'reviewer'];

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

function formatMessage(message: AgentMessage): string {
  return `- ${message.from} → ${message.to} (${message.kind}): ${message.body}`;
}

function formatMessages(messages: AgentMessage[], emptyText: string): string {
  if (!messages.length) return emptyText;
  return messages.map(formatMessage).join('\n');
}

function outputInstruction(definition: AgentDefinition): string {
  if (definition.userFacing) {
    return [
      '사용자에게 직접 보여줄 최종 답변만 작성한다.',
      'Planner/Engineer 결과를 검토하되 내부 로그처럼 길게 나열하지 않는다.',
      '필요하면 한계나 다음 확인 사항을 짧게 덧붙인다.',
    ].join('\n');
  }

  return [
    `${definition.handoffTo ?? '다음 Agent'}에게 전달할 메시지만 작성한다.`,
    '사용자에게 직접 말하는 형식은 피하고, 다음 Agent가 바로 활용할 수 있게 작성한다.',
    '불필요한 인사말이나 메타 설명은 생략한다.',
  ].join('\n');
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

export function buildAgentPrompt(definition: AgentDefinition, context: AgentExecutionContext): string {
  return [
    definition.systemPrompt,
    '',
    '[Current User Request]',
    context.userRequest,
    '',
    '[Visible Conversation Summary]',
    formatMessages(context.visibleConversation, '아직 사용자-facing 대화가 없습니다.'),
    '',
    '[Agent Handoff Context]',
    formatMessages(context.handoffMessages, '이번 turn에서 아직 전달된 Agent 메시지가 없습니다.'),
    '',
    '[Required Output]',
    outputInstruction(definition),
  ].join('\n');
}

function orderedRoles(state: RunState): AgentRole[] {
  const enabled = new Set(state.agents.map((agent) => agent.role));
  return EXECUTION_ORDER.filter((role) => enabled.has(role));
}

export async function runAgentConversation(input: {
  state: RunState;
  messages: AgentMessage[];
  invokeAgent: (input: AgentExecutionInput) => Promise<string>;
  shouldStop?: () => Promise<boolean>;
}): Promise<AgentConversationResult> {
  const context = createAgentExecutionContext(input.state, input.messages);
  const outputs: Partial<Record<AgentRole, string>> = {};
  const emittedMessages: AgentMessage[] = [];
  let userAnswer: string | undefined;

  for (const role of orderedRoles(input.state)) {
    if (await input.shouldStop?.()) return { context, outputs, emittedMessages, stopped: true, userAnswer };

    const definition = getAgentDefinition(role);
    const body = await input.invokeAgent({
      definition,
      prompt: buildAgentPrompt(definition, context),
      context,
    });
    outputs[role] = body;

    if (await input.shouldStop?.()) return { context, outputs, emittedMessages, stopped: true, userAnswer };

    if (definition.handoffTo) {
      const message = await sendMessage({
        runId: context.runId,
        from: definition.id,
        to: definition.handoffTo,
        kind: definition.handoffKind,
        body,
        requiresAck: definition.requiresAck,
      });
      context.handoffMessages.push(message);
      emittedMessages.push(message);
    }

    if (definition.userFacing) {
      const message = await sendMessage({
        runId: context.runId,
        from: definition.id,
        to: 'user',
        kind: 'result',
        body,
      });
      context.visibleConversation.push(message);
      emittedMessages.push(message);
      userAnswer = body;
    }
  }

  return { context, outputs, emittedMessages, stopped: false, userAnswer };
}
