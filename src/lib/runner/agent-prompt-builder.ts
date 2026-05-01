import type { AgentMessage } from '@/lib/protocol/types';
import type { AgentDefinition } from '@/lib/runner/agent-definitions';

export interface AgentPromptContext {
  runId: string;
  turnUserMessageId: string;
  userRequest: string;
  visibleConversation: AgentMessage[];
  handoffMessages: AgentMessage[];
  orchestratorTask?: 'plan' | 'verify' | 'intervention';
  candidateAnswer?: string;
  verificationIteration?: number;
  maxVerificationIterations?: number;
  pendingInterventions?: AgentMessage[];
  interventionCheckpoint?: {
    currentAgent?: string;
    nextAgent?: string;
  };
}

function formatMessage(message: AgentMessage): string {
  return `- ${message.from} → ${message.to} (${message.kind}): ${message.body}`;
}

function formatMessages(messages: AgentMessage[], emptyText: string): string {
  if (!messages.length) return emptyText;
  return messages.map(formatMessage).join('\n');
}

function outputInstruction(definition: AgentDefinition): string {
  if (definition.id === 'orchestrator') {
    return [
      'orchestratorTask가 plan이면 사용자에게 직접 답하지 말고 AgentBoard 내부 실행 계획 JSON만 작성한다.',
      'orchestratorTask가 verify이면 후보 결과와 handoff context를 검증하고, 완료 시 Orchestrator 명의의 최종 사용자 답변을 verdict JSON userAnswer에 직접 작성한다.',
      'orchestratorTask가 intervention이면 진행 중 들어온 사용자 개입을 현재 flow에 어떻게 반영할지 decision JSON만 작성한다.',
      '반드시 하나의 JSON object만 출력한다. JSON 외의 설명, 마크다운, 코드블록은 출력하지 않는다.',
      '알 수 없는 값 대신 가장 가까운 허용값을 사용한다.',
    ].join('\n');
  }

  if (definition.id === 'reviewer') {
    return [
      '사용자에게 직접 전달할 최종 답변을 작성하지 않는다.',
      'Planner/Engineer 결과가 사용자 요청을 충족하는지 검토하는 품질 리포트만 작성한다.',
      '판정, 충족한 점, 누락/위험, Orchestrator 최종 답변 반영 권고를 짧게 포함한다.',
      '새로운 해결책을 임의로 확장하지 말고 필요한 보완 작업이 있으면 어떤 Agent가 보완해야 하는지 제안한다.',
    ].join('\n');
  }

  return [
    'Orchestrator가 배정한 업무를 수행하고, 다음 Agent 또는 Orchestrator가 바로 활용할 수 있는 결과만 작성한다.',
    '사용자에게 직접 말하는 형식은 피한다.',
    '불필요한 인사말이나 메타 설명은 생략한다.',
  ].join('\n');
}

export function buildAgentPrompt(definition: AgentDefinition, context: AgentPromptContext): string {
  const isPlanTask = context.orchestratorTask !== 'verify' && context.orchestratorTask !== 'intervention';
  const orchestratorContext = definition.id === 'orchestrator'
    ? [
      '[Orchestrator Task]',
      context.orchestratorTask ?? 'plan',
      '',
      isPlanTask ? '[Required Plan JSON]' : undefined,
      isPlanTask ? [
        '{',
        '  "strategy": "dynamic-orchestrator",',
        '  "reason": "이번 요청을 이렇게 라우팅하는 이유",',
        '  "steps": [',
        '    {',
        '      "agent": "planner" | "engineer" | "reviewer",',
        '      "task": "이 Agent에게 맡길 구체적인 작업",',
        '      "reason": "이 Agent가 필요한 이유",',
        '      "expectedOutput": "다음 Agent 또는 검증에 필요한 산출물"',
        '    }',
        '  ],',
        '  "finalResponder": "engineer"',
        '}',
        '',
        'finalResponder는 사용자에게 직접 답하는 Agent가 아니라 Orchestrator가 verify할 후보 결과를 마지막으로 제공하는 Agent다.',
        'Reviewer는 일반 답변 작성자가 아니라 품질 검토가 필요할 때만 사용한다.',
      ].join('\n') : undefined,
      isPlanTask ? '' : undefined,
      context.orchestratorTask === 'verify' ? '[Orchestrator Verification Candidate]' : undefined,
      context.orchestratorTask === 'verify' ? context.candidateAnswer ?? '(후보 답변 없음)' : undefined,
      context.orchestratorTask === 'verify' ? '' : undefined,
      context.orchestratorTask === 'verify' ? '[Verification Iteration]' : undefined,
      context.orchestratorTask === 'verify'
        ? `${context.verificationIteration ?? 1}/${context.maxVerificationIterations ?? 3}`
        : undefined,
      context.orchestratorTask === 'verify' ? '' : undefined,
      context.orchestratorTask === 'verify' ? '[Required Verdict JSON]' : undefined,
      context.orchestratorTask === 'verify' ? [
        '{',
        '  "status": "complete" | "incomplete",',
        '  "reason": "사용자 목적 충족/미충족 판단 이유",',
        '  "userAnswer": "complete일 때 Orchestrator가 사용자에게 전달할 최종 답변. incomplete이면 생략 가능",',
        '  "nextSteps": [',
        '    {',
        '      "agent": "planner" | "engineer" | "reviewer",',
        '      "task": "미완성일 때 다시 맡길 구체적인 작업",',
        '      "reason": "이 Agent에게 다시 맡기는 이유",',
        '      "expectedOutput": "다음 검증에 필요한 산출물"',
        '    }',
        '  ]',
        '}',
        '',
        'complete 규칙: nextSteps는 빈 배열이어야 한다.',
        'incomplete 규칙: nextSteps는 최소 1개 이상이어야 한다.',
      ].join('\n') : undefined,
      context.orchestratorTask === 'verify' ? '' : undefined,
      context.orchestratorTask === 'intervention' ? '[Pending User Interventions]' : undefined,
      context.orchestratorTask === 'intervention'
        ? formatMessages(context.pendingInterventions ?? [], '처리할 진행 중 사용자 개입이 없습니다.')
        : undefined,
      context.orchestratorTask === 'intervention' ? '' : undefined,
      context.orchestratorTask === 'intervention' ? '[Current Flow Checkpoint]' : undefined,
      context.orchestratorTask === 'intervention'
        ? [
          `currentAgent: ${context.interventionCheckpoint?.currentAgent ?? 'unknown'}`,
          `nextAgent: ${context.interventionCheckpoint?.nextAgent ?? 'none'}`,
        ].join('\n')
        : undefined,
      context.orchestratorTask === 'intervention' ? '' : undefined,
      context.orchestratorTask === 'intervention' ? '[Required Intervention Decision JSON]' : undefined,
      context.orchestratorTask === 'intervention' ? [
        '{',
        '  "action": "continue" | "restart" | "ask_user",',
        '  "reason": "이 개입을 이렇게 처리해야 하는 이유",',
        '  "instruction": "continue/restart일 때 다음 Agent 또는 새 flow에 전달할 지시",',
        '  "question": "ask_user일 때 사용자에게 되물을 질문"',
        '}',
        '',
        'continue 규칙: 현재 flow와 충돌하지 않는 추가 조건이면 사용한다.',
        'restart 규칙: 현재 방향과 충돌하거나 새 계획이 필요하면 사용한다.',
        'ask_user 규칙: 사용자의 의도가 모호해서 자동 판단하면 위험할 때만 사용한다.',
      ].join('\n') : undefined,
      context.orchestratorTask === 'intervention' ? '' : undefined,
    ].filter((line): line is string => line !== undefined)
    : [];

  return [
    definition.systemPrompt,
    '',
    '[Current User Request]',
    context.userRequest,
    '',
    ...orchestratorContext,
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
