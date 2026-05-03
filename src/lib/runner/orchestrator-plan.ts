import type { AgentRole, DeliverableType, RunState } from '@/lib/protocol/types';
import { DEFAULT_AGENT_EXECUTION_ORDER } from '@/lib/runner/orchestrator-strategy';

export type WorkerAgentRole = Exclude<AgentRole, 'orchestrator'>;

export interface ImplementationEvidence {
  workspacePath?: string;
  workspaceFiles: string[];
  reportedChangedFiles: string[];
  commandsRun: string[];
  testResults: string[];
}

export interface OrchestratorStep {
  agent: WorkerAgentRole;
  task: string;
  reason: string;
  expectedOutput: string;
}

export interface OrchestratorPlan {
  strategy: string;
  reason: string;
  deliverableType: DeliverableType;
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
export function inferDeliverableType(userRequest: string): DeliverableType {
  const request = userRequest.toLowerCase();
  const answerIntent = /계획|플랜|설명|방향|관점|방법|가이드|검토|리뷰|분석|요약|답변|알려줘|추천|plan|explain|review|analyze/.test(request);
  const implementationTarget = /앱|프로젝트|파일|코드|컴포넌트|페이지|api|ui|기능|버그|오류|에러|테스트|어댑터|adapter|runtime|프롬프트|prompt/.test(request);
  const implementationVerb = /구현해|개발해|수정해|고쳐|생성해|작성해|반영해|적용해|추가해|삭제해|fix|implement|build|create|add|update|delete|write/.test(request);

  if (/지시.*반영|조건.*(추가|반영)|요구사항.*(추가|반영)/.test(request)) return 'answer';
  if (answerIntent && !implementationTarget) return 'answer';
  if (implementationVerb && implementationTarget) return 'implementation';
  if (/실제\s*(구현|개발|수정|생성|작성)/.test(request)) return 'implementation';
  return 'answer';
}

export function emptyImplementationEvidence(workspacePath?: string): ImplementationEvidence {
  return {
    workspacePath,
    workspaceFiles: [],
    reportedChangedFiles: [],
    commandsRun: [],
    testResults: [],
  };
}

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
  return '앞선 Agent 결과의 정확성, 누락, 리스크를 검토하고 Orchestrator에게 품질 판단을 전달한다.';
}

function defaultReasonFor(role: WorkerAgentRole): string {
  if (role === 'planner') return '요청을 실행 가능한 형태로 정리해야 한다.';
  if (role === 'engineer') return '구체적인 기술 판단과 해결책이 필요하다.';
  return '최종 사용자 답변 전에 품질 게이트가 필요하다.';
}

function defaultExpectedOutputFor(role: WorkerAgentRole): string {
  if (role === 'planner') return 'Engineer가 사용할 수 있는 요구사항과 실행 방향';
  if (role === 'engineer') return 'Orchestrator가 검증할 수 있는 해결책과 검증 관점';
  return 'Orchestrator가 최종 답변에 반영할 품질 검토 리포트';
}

export function fallbackOrchestratorPlan(
  state: RunState,
  reason: string,
  parseError?: string,
  deliverableType: DeliverableType = inferDeliverableType(state.run.brief),
): OrchestratorPlan {
  const roles = enabledWorkerRoles(state);
  const fallbackRoles: WorkerAgentRole[] = roles.length ? roles : ['reviewer'];
  return orchestratorPlanFromRoles(fallbackRoles, reason, {
    strategy: 'fallback-linear-orchestrator',
    fallback: true,
    parseError,
    deliverableType,
  });
}

export function orchestratorPlanFromRoles(
  roles: WorkerAgentRole[],
  reason: string,
  options: { strategy?: string; fallback?: boolean; parseError?: string; deliverableType?: DeliverableType } = {},
): OrchestratorPlan {
  const fallbackRoles: WorkerAgentRole[] = roles.length ? roles : ['reviewer'];
  const finalResponder = fallbackRoles[fallbackRoles.length - 1];
  return {
    strategy: options.strategy ?? 'linear-orchestrator',
    reason,
    deliverableType: options.deliverableType ?? 'answer',
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

function jsonSources(raw: string): string[] {
  const trimmed = raw.trim();
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return [...fenced, trimmed];
}

function extractJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const source of jsonSources(raw)) {
    for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let index = start; index < source.length; index += 1) {
        const char = source[index];

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (char === '\\') {
            escaped = true;
          } else if (char === '"') {
            inString = false;
          }
          continue;
        }

        if (char === '"') {
          inString = true;
          continue;
        }

        if (char === '{') depth += 1;
        if (char === '}') depth -= 1;

        if (depth === 0) {
          const candidate = source.slice(start, index + 1);
          if (!seen.has(candidate)) {
            seen.add(candidate);
            candidates.push(candidate);
          }
          break;
        }
      }
    }
  }

  if (!candidates.length) throw new Error('orchestrator output does not contain a JSON object');
  return candidates;
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

function parseJsonCandidate<T>(json: string): T {
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

function parseJsonObjects<T>(raw: string): T[] {
  const candidates = extractJsonObjectCandidates(raw);
  const parsed: T[] = [];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      parsed.push(parseJsonCandidate<T>(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  if (!parsed.length) throw lastError instanceof Error ? lastError : new Error('orchestrator output does not contain a parseable JSON object');
  return parsed;
}

function parseJsonObject<T>(raw: string): T {
  return parseJsonObjects<T>(raw)[0];
}

function normalizeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeDeliverableType(value: unknown, fallback: DeliverableType): DeliverableType {
  return value === 'implementation' || value === 'answer' ? value : fallback;
}

function extractListSection(raw: string, label: string): string[] {
  const sectionLabels = ['changedFiles', 'commandsRun', 'testResults', 'remainingRisks', 'workspaceFiles', 'reportedChangedFiles'];
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetLabelPattern = new RegExp(`^${escapedLabel}\\s*(?:[:：]\\s*(.*))?$`, 'i');
  const anyLabelPattern = new RegExp(`^(?:${sectionLabels.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*(?:[:：]\\s*.*)?$`, 'i');
  const collected: string[] = [];
  let collecting = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!collecting) {
      const match = trimmed.match(targetLabelPattern);
      if (!match) continue;
      collecting = true;
      if (match[1]?.trim()) collected.push(match[1].trim());
      continue;
    }

    if (anyLabelPattern.test(trimmed)) break;
    collected.push(line);
  }

  return collected.join('\n')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .map((line) => line.replace(/^["'`]|["'`,]$/g, '').trim())
    .filter((line) => line.length > 0 && !/^(없음|none|n\/a|\[\])$/i.test(line));
}

function extractJsonStringList(raw: string, key: string): string[] {
  try {
    const parsed = parseJsonObject<Record<string, unknown>>(raw);
    const value = parsed[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}

export function implementationEvidenceFromText(raw: string, workspacePath?: string): ImplementationEvidence {
  return {
    workspacePath,
    workspaceFiles: [],
    reportedChangedFiles: [
      ...extractJsonStringList(raw, 'changedFiles'),
      ...extractListSection(raw, 'changedFiles'),
    ],
    commandsRun: [
      ...extractJsonStringList(raw, 'commandsRun'),
      ...extractListSection(raw, 'commandsRun'),
    ],
    testResults: [
      ...extractJsonStringList(raw, 'testResults'),
      ...extractListSection(raw, 'testResults'),
    ],
  };
}

function mergeUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function mergeImplementationEvidence(
  left: ImplementationEvidence,
  right: ImplementationEvidence,
): ImplementationEvidence {
  return {
    workspacePath: left.workspacePath ?? right.workspacePath,
    workspaceFiles: mergeUnique([...left.workspaceFiles, ...right.workspaceFiles]),
    reportedChangedFiles: mergeUnique([...left.reportedChangedFiles, ...right.reportedChangedFiles]),
    commandsRun: mergeUnique([...left.commandsRun, ...right.commandsRun]),
    testResults: mergeUnique([...left.testResults, ...right.testResults]),
  };
}

function hasImplementationChangedFiles(state: RunState, evidence?: ImplementationEvidence): boolean {
  if (!evidence) return false;
  if (evidence.workspaceFiles.length > 0) return true;
  return state.run.mode === 'mock' && evidence.reportedChangedFiles.length > 0;
}

function hasImplementationVerification(evidence?: ImplementationEvidence): boolean {
  return Boolean(evidence && (evidence.commandsRun.length > 0 || evidence.testResults.length > 0));
}

function implementationEvidenceSummary(evidence?: ImplementationEvidence): string {
  if (!evidence) return '구현 증거 없음';
  return [
    evidence.workspacePath ? `workspace: ${evidence.workspacePath}` : undefined,
    `workspaceFiles: ${evidence.workspaceFiles.length}`,
    `reportedChangedFiles: ${evidence.reportedChangedFiles.length}`,
    `commandsRun: ${evidence.commandsRun.length}`,
    `testResults: ${evidence.testResults.length}`,
  ].filter((line): line is string => line !== undefined).join(', ');
}

function implementationEvidenceNextStep(reason: string): OrchestratorStep {
  return {
    agent: 'engineer',
    task: '실제 구현 산출물을 생성 또는 수정하고 changedFiles, commandsRun, testResults를 포함한 구현 증거를 보강한다.',
    reason,
    expectedOutput: '실제 변경 파일 목록, 실행한 명령, 검증 결과, 남은 리스크가 포함된 구현 결과',
  };
}

function implementationCompletionProblem(state: RunState, evidence?: ImplementationEvidence): string | undefined {
  if (!hasImplementationChangedFiles(state, evidence)) {
    return `실제 workspace 변경 파일이 확인되지 않았습니다. (${implementationEvidenceSummary(evidence)})`;
  }
  if (!hasImplementationVerification(evidence)) {
    return `실행 명령 또는 검증 결과가 확인되지 않았습니다. (${implementationEvidenceSummary(evidence)})`;
  }
  return undefined;
}

function appendFinalResponderIfNeeded(steps: OrchestratorStep[], finalResponder: WorkerAgentRole): OrchestratorStep[] {
  const existing = steps.find((step) => step.agent === finalResponder);
  if (existing) return [...steps.filter((step) => step.agent !== finalResponder), existing];
  return [
    ...steps,
    {
      agent: finalResponder,
      task: defaultTaskFor(finalResponder),
      reason: 'Orchestrator 검증 후보를 마지막으로 제공해야 한다.',
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

export function parseOrchestratorPlan(raw: string, state: RunState, userRequest = state.run.brief): OrchestratorPlan {
  const inferredDeliverableType = inferDeliverableType(userRequest);
  try {
    const parsedObjects = parseJsonObjects<{
      strategy?: unknown;
      reason?: unknown;
      deliverableType?: unknown;
      steps?: unknown;
      finalResponder?: unknown;
    }>(raw);
    const parsed = parsedObjects.find((candidate) => Array.isArray(candidate.steps)) ?? parsedObjects[0];
    const enabled = new Set(enabledWorkerRoles(state));
    const steps = normalizeSteps(parsed.steps, state);
    const deliverableType = normalizeDeliverableType(parsed.deliverableType, inferredDeliverableType);

    if (!steps.length) {
      return fallbackOrchestratorPlan(
        state,
        'Orchestrator가 실행 가능한 Agent step을 만들지 못해 기본 순서를 사용합니다.',
        undefined,
        deliverableType,
      );
    }

    let finalResponder: WorkerAgentRole = isWorkerRole(parsed.finalResponder) && enabled.has(parsed.finalResponder)
      ? parsed.finalResponder
      : steps[steps.length - 1].agent;

    if (!enabled.has(finalResponder)) finalResponder = steps[steps.length - 1].agent;

    return {
      strategy: normalizeText(parsed.strategy, 'dynamic-orchestrator'),
      reason: normalizeText(parsed.reason, 'Orchestrator가 사용자 요청에 맞춰 Agent 실행 계획을 선택했습니다.'),
      deliverableType,
      steps: appendFinalResponderIfNeeded(steps, finalResponder),
      finalResponder,
    };
  } catch (error) {
    return fallbackOrchestratorPlan(
      state,
      'Orchestrator 출력 JSON을 파싱하지 못해 기본 순서를 사용합니다.',
      error instanceof Error ? error.message : String(error),
      inferredDeliverableType,
    );
  }
}

export function parseOrchestratorVerdict(
  raw: string,
  state: RunState,
  candidateAnswer: string,
  options: {
    deliverableType?: DeliverableType;
    implementationEvidence?: ImplementationEvidence;
  } = {},
): OrchestratorVerdict {
  try {
    const parsedObjects = parseJsonObjects<{
      status?: unknown;
      reason?: unknown;
      userAnswer?: unknown;
      nextSteps?: unknown;
    }>(raw);
    const parsed = [...parsedObjects].reverse().find((candidate) => (
      candidate.status === 'complete' || candidate.status === 'incomplete'
    )) ?? parsedObjects[0];
    const status = parsed.status === 'incomplete' ? 'incomplete' : parsed.status === 'complete' ? 'complete' : undefined;
    const deliverableType = options.deliverableType ?? 'answer';
    const implementationEvidence = options.implementationEvidence
      ? mergeImplementationEvidence(options.implementationEvidence, implementationEvidenceFromText(candidateAnswer, options.implementationEvidence.workspacePath))
      : implementationEvidenceFromText(candidateAnswer);
    if (!status) {
      const problem = deliverableType === 'implementation'
        ? implementationCompletionProblem(state, implementationEvidence)
        : undefined;
      if (problem) {
        const incompleteReason = `Orchestrator 검증 결과 형식과 구현 증거가 부족해 완료 처리할 수 없습니다. ${problem}`;
        return {
          status: 'incomplete',
          reason: incompleteReason,
          userAnswer: candidateAnswer,
          nextSteps: [implementationEvidenceNextStep(incompleteReason)],
          fallback: true,
          parseError: 'missing status',
        };
      }
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
      const problem = deliverableType === 'implementation'
        ? implementationCompletionProblem(state, implementationEvidence)
        : undefined;
      if (problem) {
        const incompleteReason = `implementation 요청이지만 ${problem}`;
        return {
          status: 'incomplete',
          reason: incompleteReason,
          userAnswer: typeof parsed.userAnswer === 'string' ? parsed.userAnswer.trim() : undefined,
          nextSteps: [implementationEvidenceNextStep(incompleteReason)],
        };
      }
      return {
        status,
        reason,
        userAnswer: normalizeText(parsed.userAnswer, candidateAnswer),
        nextSteps: [],
      };
    }

    const nextSteps = normalizeSteps(parsed.nextSteps, state);
    const enabledRoles = enabledWorkerRoles(state);
    const fallbackAgent = enabledRoles.includes('engineer') ? 'engineer' : (enabledRoles[0] ?? 'reviewer');
    return {
      status,
      reason,
      userAnswer: typeof parsed.userAnswer === 'string' ? parsed.userAnswer.trim() : undefined,
      nextSteps: nextSteps.length ? nextSteps : [{
        agent: fallbackAgent,
        task: 'Orchestrator 검증 피드백을 반영해 후보 결과의 누락과 불명확성을 보완한다.',
        reason,
        expectedOutput: 'Orchestrator가 다시 검증할 수 있는 보완된 후보 결과',
      }],
    };
  } catch (error) {
    const deliverableType = options.deliverableType ?? 'answer';
    const implementationEvidence = options.implementationEvidence
      ? mergeImplementationEvidence(options.implementationEvidence, implementationEvidenceFromText(candidateAnswer, options.implementationEvidence.workspacePath))
      : implementationEvidenceFromText(candidateAnswer);
    const problem = deliverableType === 'implementation'
      ? implementationCompletionProblem(state, implementationEvidence)
      : undefined;
    if (problem) {
      const incompleteReason = `Orchestrator 검증 JSON을 파싱하지 못했고 구현 증거도 부족해 완료 처리할 수 없습니다. ${problem}`;
      return {
        status: 'incomplete',
        reason: incompleteReason,
        userAnswer: candidateAnswer,
        nextSteps: [implementationEvidenceNextStep(incompleteReason)],
        fallback: true,
        parseError: error instanceof Error ? error.message : String(error),
      };
    }
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
    const parsedObjects = parseJsonObjects<{
      action?: unknown;
      reason?: unknown;
      instruction?: unknown;
      question?: unknown;
    }>(raw);
    const parsed = [...parsedObjects].reverse().find((candidate) => (
      candidate.action === 'restart' || candidate.action === 'ask_user' || candidate.action === 'continue'
    )) ?? parsedObjects[0];
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
  deliverableType: DeliverableType = 'answer',
): OrchestratorPlan {
  const enabled = new Set(enabledWorkerRoles(state));
  const fallbackResponder = verdict.nextSteps.at(-1)?.agent ?? (enabled.has('engineer') ? 'engineer' : 'reviewer');
  const finalResponder = enabled.has(fallbackResponder) ? fallbackResponder : verdict.nextSteps.at(-1)?.agent ?? 'reviewer';
  return {
    strategy: 'orchestrator-feedback-loop',
    reason: `Orchestrator 검증 ${iteration}회차 피드백: ${verdict.reason}`,
    deliverableType,
    steps: appendFinalResponderIfNeeded(verdict.nextSteps, finalResponder),
    finalResponder,
  };
}

export function formatOrchestratorAssignment(plan: OrchestratorPlan, step: OrchestratorStep): string {
  return [
    `Orchestrator Strategy: ${plan.strategy}`,
    `Plan Reason: ${plan.reason}`,
    `Deliverable Type: ${plan.deliverableType}`,
    '',
    `Assigned Agent: ${step.agent}`,
    `Task: ${step.task}`,
    `Reason: ${step.reason}`,
    `Expected Output: ${step.expectedOutput}`,
    `Verification Candidate Provider: ${plan.finalResponder}`,
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
    `Deliverable Type: ${plan.deliverableType}`,
    `Verification Candidate Provider: ${plan.finalResponder}`,
    plan.fallback ? 'Fallback: true' : 'Fallback: false',
    plan.parseError ? `Parse Error: ${plan.parseError}` : undefined,
    '',
    'Steps:',
    steps,
  ].filter((line): line is string => line !== undefined).join('\n');
}
