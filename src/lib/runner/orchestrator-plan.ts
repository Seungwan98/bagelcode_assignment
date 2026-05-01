import type { AgentRole, RunState } from '@/lib/protocol/types';
import { DEFAULT_AGENT_EXECUTION_ORDER } from '@/lib/runner/orchestrator-strategy';

export type WorkerAgentRole = Exclude<AgentRole, 'orchestrator'>;

export interface OrchestratorStep {
  agent: WorkerAgentRole;
  task: string;
  reason: string;
  expectedOutput: string;
}

export interface OrchestratorPlan {
  strategy: string;
  reason: string;
  steps: OrchestratorStep[];
  finalResponder: WorkerAgentRole;
  fallback?: boolean;
  parseError?: string;
}

export interface OrchestratorVerdict {
  status: 'complete' | 'incomplete';
  reason: string;
  userAnswer?: string;
  nextSteps: OrchestratorStep[];
  fallback?: boolean;
  parseError?: string;
}

export interface OrchestratorInterventionDecision {
  action: 'continue' | 'restart' | 'ask_user';
  reason: string;
  instruction?: string;
  question?: string;
  fallback?: boolean;
  parseError?: string;
}

const WORKER_ROLES: WorkerAgentRole[] = ['planner', 'engineer', 'reviewer'];

function isWorkerRole(value: unknown): value is WorkerAgentRole {
  return typeof value === 'string' && WORKER_ROLES.includes(value as WorkerAgentRole);
}

function enabledWorkerRoles(state: RunState): WorkerAgentRole[] {
  const enabled = new Set(state.agents.map((agent) => agent.role));
  return DEFAULT_AGENT_EXECUTION_ORDER.filter((role): role is WorkerAgentRole => (
    role !== 'orchestrator' && enabled.has(role)
  ));
}

function defaultTaskFor(role: WorkerAgentRole): string {
  if (role === 'planner') return '사용자 요청의 의도, 목표, 제약, 필요한 산출물을 정리한다.';
  if (role === 'engineer') return '사용자 요청을 해결하기 위한 구체적인 기술 접근과 검증 관점을 작성한다.';
  return '앞선 Agent 결과를 검토하고 사용자에게 보여줄 최종 답변을 작성한다.';
}

function defaultReasonFor(role: WorkerAgentRole): string {
  if (role === 'planner') return '요청을 실행 가능한 형태로 정리해야 한다.';
  if (role === 'engineer') return '구체적인 기술 판단과 해결책이 필요하다.';
  return '사용자에게 최종 답변을 전달해야 한다.';
}

function defaultExpectedOutputFor(role: WorkerAgentRole): string {
  if (role === 'planner') return 'Engineer가 사용할 수 있는 요구사항과 실행 방향';
  if (role === 'engineer') return 'Reviewer가 검토할 수 있는 해결책과 검증 관점';
  return '사용자에게 전달할 최종 답변';
}

export function fallbackOrchestratorPlan(state: RunState, reason: string, parseError?: string): OrchestratorPlan {
  const roles = enabledWorkerRoles(state);
  const fallbackRoles: WorkerAgentRole[] = roles.length ? roles : ['reviewer'];
  return orchestratorPlanFromRoles(fallbackRoles, reason, {
    strategy: 'fallback-linear-orchestrator',
    fallback: true,
    parseError,
  });
}

export function orchestratorPlanFromRoles(
  roles: WorkerAgentRole[],
  reason: string,
  options: { strategy?: string; fallback?: boolean; parseError?: string } = {},
): OrchestratorPlan {
  const fallbackRoles: WorkerAgentRole[] = roles.length ? roles : ['reviewer'];
  const finalResponder = fallbackRoles.includes('reviewer') ? 'reviewer' : fallbackRoles[fallbackRoles.length - 1];
  return {
    strategy: options.strategy ?? 'linear-orchestrator',
    reason,
    steps: fallbackRoles.map((role) => ({
      agent: role,
      task: defaultTaskFor(role),
      reason: defaultReasonFor(role),
      expectedOutput: defaultExpectedOutputFor(role),
    })),
    finalResponder,
    fallback: options.fallback,
    parseError: options.parseError,
  };
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('orchestrator output does not contain a JSON object');
  return candidate.slice(start, end + 1);
}

function repairHardWrappedJsonStringLiterals(raw: string): string {
  let repaired = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      repaired += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === '\n' || char === '\r') {
      if (!repaired.endsWith(' ')) repaired += ' ';
      while (raw[index + 1] === ' ' || raw[index + 1] === '\t') index += 1;
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function parseJsonObject<T>(raw: string): T {
  const json = extractJsonObject(raw);
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    try {
      return JSON.parse(repairHardWrappedJsonStringLiterals(json)) as T;
    } catch {
      throw error;
    }
  }
}

function normalizeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function appendFinalResponderIfNeeded(steps: OrchestratorStep[], finalResponder: WorkerAgentRole): OrchestratorStep[] {
  const existing = steps.find((step) => step.agent === finalResponder);
  if (existing) return [...steps.filter((step) => step.agent !== finalResponder), existing];
  return [
    ...steps,
    {
      agent: finalResponder,
      task: defaultTaskFor(finalResponder),
      reason: '최종 사용자 답변을 생성해야 한다.',
      expectedOutput: defaultExpectedOutputFor(finalResponder),
    },
  ];
}

function normalizeSteps(rawSteps: unknown, state: RunState): OrchestratorStep[] {
  const enabled = new Set(enabledWorkerRoles(state));
  const seen = new Set<WorkerAgentRole>();
  const steps: OrchestratorStep[] = [];

  for (const rawStep of Array.isArray(rawSteps) ? rawSteps : []) {
    if (!rawStep || typeof rawStep !== 'object') continue;
    const step = rawStep as Partial<OrchestratorStep>;
    if (!isWorkerRole(step.agent) || !enabled.has(step.agent) || seen.has(step.agent)) continue;
    seen.add(step.agent);
    steps.push({
      agent: step.agent,
      task: normalizeText(step.task, defaultTaskFor(step.agent)),
      reason: normalizeText(step.reason, defaultReasonFor(step.agent)),
      expectedOutput: normalizeText(step.expectedOutput, defaultExpectedOutputFor(step.agent)),
    });
  }

  return steps;
}

export function parseOrchestratorPlan(raw: string, state: RunState): OrchestratorPlan {
  try {
    const parsed = parseJsonObject<{
      strategy?: unknown;
      reason?: unknown;
      steps?: unknown;
      finalResponder?: unknown;
    }>(raw);
    const enabled = new Set(enabledWorkerRoles(state));
    const steps = normalizeSteps(parsed.steps, state);

    if (!steps.length) {
      return fallbackOrchestratorPlan(state, 'Orchestrator가 실행 가능한 Agent step을 만들지 못해 기본 순서를 사용합니다.');
    }

    let finalResponder: WorkerAgentRole = isWorkerRole(parsed.finalResponder) && enabled.has(parsed.finalResponder)
      ? parsed.finalResponder
      : (enabled.has('reviewer') ? 'reviewer' : steps[steps.length - 1].agent);

    if (!enabled.has(finalResponder)) finalResponder = steps[steps.length - 1].agent;

    return {
      strategy: normalizeText(parsed.strategy, 'dynamic-orchestrator'),
      reason: normalizeText(parsed.reason, 'Orchestrator가 사용자 요청에 맞춰 Agent 실행 계획을 선택했습니다.'),
      steps: appendFinalResponderIfNeeded(steps, finalResponder),
      finalResponder,
    };
  } catch (error) {
    return fallbackOrchestratorPlan(
      state,
      'Orchestrator 출력 JSON을 파싱하지 못해 기본 순서를 사용합니다.',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function parseOrchestratorVerdict(raw: string, state: RunState, candidateAnswer: string): OrchestratorVerdict {
  try {
    const parsed = parseJsonObject<{
      status?: unknown;
      reason?: unknown;
      userAnswer?: unknown;
      nextSteps?: unknown;
    }>(raw);
    const status = parsed.status === 'incomplete' ? 'incomplete' : parsed.status === 'complete' ? 'complete' : undefined;
    if (!status) {
      return {
        status: 'complete',
        reason: 'Orchestrator 검증 결과 형식을 해석하지 못해 후보 답변을 안전하게 최종 답변으로 사용합니다.',
        userAnswer: candidateAnswer,
        nextSteps: [],
        fallback: true,
        parseError: 'missing status',
      };
    }

    const reason = normalizeText(parsed.reason, status === 'complete'
      ? 'Orchestrator가 사용자 목적을 충족한다고 판단했습니다.'
      : 'Orchestrator가 사용자 목적을 아직 충족하지 못했다고 판단했습니다.');
    if (status === 'complete') {
      return {
        status,
        reason,
        userAnswer: normalizeText(parsed.userAnswer, candidateAnswer),
        nextSteps: [],
      };
    }

    const nextSteps = normalizeSteps(parsed.nextSteps, state);
    return {
      status,
      reason,
      userAnswer: typeof parsed.userAnswer === 'string' ? parsed.userAnswer.trim() : undefined,
      nextSteps: nextSteps.length ? nextSteps : [{
        agent: enabledWorkerRoles(state).includes('reviewer') ? 'reviewer' : (enabledWorkerRoles(state)[0] ?? 'reviewer'),
        task: 'Orchestrator 검증 피드백을 반영해 후보 답변의 누락과 불명확성을 보완한다.',
        reason,
        expectedOutput: 'Orchestrator가 다시 검증할 수 있는 보완된 후보 답변',
      }],
    };
  } catch (error) {
    return {
      status: 'complete',
      reason: 'Orchestrator 검증 JSON을 파싱하지 못해 후보 답변을 안전하게 최종 답변으로 사용합니다.',
      userAnswer: candidateAnswer,
      nextSteps: [],
      fallback: true,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseOrchestratorInterventionDecision(
  raw: string,
  pendingInterventions: { body: string }[],
): OrchestratorInterventionDecision {
  const fallbackInstruction = pendingInterventions.map((message) => message.body).join('\n');
  try {
    const parsed = parseJsonObject<{
      action?: unknown;
      reason?: unknown;
      instruction?: unknown;
      question?: unknown;
    }>(raw);
    const action = parsed.action === 'restart' || parsed.action === 'ask_user' || parsed.action === 'continue'
      ? parsed.action
      : undefined;
    if (!action) {
      return {
        action: 'continue',
        reason: 'Orchestrator 개입 판단 action을 해석하지 못해 현재 flow에 추가 조건으로 반영합니다.',
        instruction: fallbackInstruction,
        fallback: true,
        parseError: 'missing action',
      };
    }

    const reason = normalizeText(parsed.reason, 'Orchestrator가 진행 중 사용자 개입 처리 방식을 판단했습니다.');
    if (action === 'ask_user') {
      return {
        action,
        reason,
        question: normalizeText(parsed.question, '현재 작업을 중단할지, 기존 결과에 추가 조건으로 반영할지 알려주세요.'),
      };
    }
    return {
      action,
      reason,
      instruction: normalizeText(parsed.instruction, fallbackInstruction),
    };
  } catch (error) {
    return {
      action: 'continue',
      reason: 'Orchestrator 개입 판단 JSON을 파싱하지 못해 현재 flow에 추가 조건으로 반영합니다.',
      instruction: fallbackInstruction,
      fallback: true,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function orchestratorPlanFromVerdict(
  verdict: OrchestratorVerdict,
  state: RunState,
  iteration: number,
): OrchestratorPlan {
  const enabled = new Set(enabledWorkerRoles(state));
  const fallbackResponder = enabled.has('reviewer') ? 'reviewer' : verdict.nextSteps.at(-1)?.agent ?? 'reviewer';
  const finalResponder = enabled.has(fallbackResponder) ? fallbackResponder : verdict.nextSteps.at(-1)?.agent ?? 'reviewer';
  return {
    strategy: 'orchestrator-feedback-loop',
    reason: `Orchestrator 검증 ${iteration}회차 피드백: ${verdict.reason}`,
    steps: appendFinalResponderIfNeeded(verdict.nextSteps, finalResponder),
    finalResponder,
  };
}

export function formatOrchestratorAssignment(plan: OrchestratorPlan, step: OrchestratorStep): string {
  return [
    `Orchestrator Strategy: ${plan.strategy}`,
    `Plan Reason: ${plan.reason}`,
    '',
    `Assigned Agent: ${step.agent}`,
    `Task: ${step.task}`,
    `Reason: ${step.reason}`,
    `Expected Output: ${step.expectedOutput}`,
    `Final Responder: ${plan.finalResponder}`,
  ].join('\n');
}

export function formatOrchestratorVerdict(verdict: OrchestratorVerdict, iteration: number): string {
  const nextSteps = verdict.nextSteps.length
    ? verdict.nextSteps.map((step, index) => `${index + 1}. ${step.agent}: ${step.task}`).join('\n')
    : '없음';
  return [
    `Orchestrator Verdict: ${verdict.status}`,
    `Iteration: ${iteration}`,
    `Reason: ${verdict.reason}`,
    verdict.fallback ? 'Fallback: true' : 'Fallback: false',
    verdict.parseError ? `Parse Error: ${verdict.parseError}` : undefined,
    '',
    'Next Steps:',
    nextSteps,
  ].filter((line): line is string => line !== undefined).join('\n');
}

export function formatOrchestratorInterventionDecision(
  decision: OrchestratorInterventionDecision,
  pendingInterventions: { body: string }[],
): string {
  const interventions = pendingInterventions.map((message, index) => `${index + 1}. ${message.body}`).join('\n');
  return [
    `Orchestrator Intervention Decision: ${decision.action}`,
    `Reason: ${decision.reason}`,
    decision.fallback ? 'Fallback: true' : 'Fallback: false',
    decision.parseError ? `Parse Error: ${decision.parseError}` : undefined,
    '',
    'Pending User Interventions:',
    interventions || '없음',
    '',
    decision.question ? `Question: ${decision.question}` : undefined,
    decision.instruction ? `Instruction: ${decision.instruction}` : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');
}

export function formatOrchestratorPlanSummary(plan: OrchestratorPlan): string {
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step.agent}: ${step.task}`).join('\n');
  return [
    `Strategy: ${plan.strategy}`,
    `Reason: ${plan.reason}`,
    `Final Responder: ${plan.finalResponder}`,
    plan.fallback ? 'Fallback: true' : 'Fallback: false',
    plan.parseError ? `Parse Error: ${plan.parseError}` : undefined,
    '',
    'Steps:',
    steps,
  ].filter((line): line is string => line !== undefined).join('\n');
}
