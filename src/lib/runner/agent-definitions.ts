import type { AgentAdapterKind, AgentRole, MessageKind } from '@/lib/protocol/types';

export interface AgentDefinition {
  id: AgentRole;
  displayName: string;
  description: string;
  systemPrompt: string;
  adapter: AgentAdapterKind;
  handoffTo?: AgentRole;
  handoffKind: MessageKind;
  requiresAck?: boolean;
  userFacing?: boolean;
}

const AGENT_DEFINITIONS: Record<AgentRole, AgentDefinition> = {
  planner: {
    id: 'planner',
    displayName: 'Planner Agent',
    description: '사용자 요청을 해석하고 Engineer가 답할 수 있는 실행 방향을 만든다.',
    systemPrompt: [
      '너는 AgentBoard의 Planner Agent다.',
      '사용자의 최신 요청과 이전 대화 맥락을 읽고, Engineer Agent에게 전달할 답변 계획을 작성한다.',
      '사용자에게 직접 답하지 말고 문제 의도, 필요한 산출물, 구현/검증 관점을 짧게 정리한다.',
    ].join('\n'),
    adapter: 'codex',
    handoffTo: 'engineer',
    handoffKind: 'instruction',
    requiresAck: true,
  },
  engineer: {
    id: 'engineer',
    displayName: 'Engineer Agent',
    description: 'Planner의 방향을 받아 구체적인 해결/구현 관점으로 정리한다.',
    systemPrompt: [
      '너는 AgentBoard의 Engineer Agent다.',
      'Planner의 전달 내용과 현재 사용자 요청을 바탕으로 구체적인 해결 또는 구현 접근을 작성한다.',
      'Reviewer가 최종 답변을 만들 수 있도록 핵심 변경점, 영향 범위, 검증 관점을 포함한다.',
    ].join('\n'),
    adapter: 'codex',
    handoffTo: 'reviewer',
    handoffKind: 'result',
  },
  reviewer: {
    id: 'reviewer',
    displayName: 'Reviewer Agent',
    description: '앞선 Agent 결과를 검토하고 사용자에게 보여줄 최종 답변을 만든다.',
    systemPrompt: [
      '너는 AgentBoard의 Reviewer Agent다.',
      'Planner와 Engineer의 전달 내용을 검토하고, 사용자에게 직접 보여줄 최종 답변을 한국어로 작성한다.',
      '내부 협업 과정은 요약만 하고, 사용자의 질문에 대한 결론과 필요한 주의점을 명확히 답한다.',
    ].join('\n'),
    adapter: 'codex',
    handoffTo: 'planner',
    handoffKind: 'review',
    userFacing: true,
  },
};

export function getAgentDefinition(role: AgentRole): AgentDefinition {
  return AGENT_DEFINITIONS[role];
}

export function listAgentDefinitions(roles?: AgentRole[]): AgentDefinition[] {
  const selected = roles?.length ? roles : (Object.keys(AGENT_DEFINITIONS) as AgentRole[]);
  return selected.map(getAgentDefinition);
}
