import type { AgentRole, MessageKind, RunState } from '@/lib/protocol/types';
import { sendMessage } from '@/lib/bus/message-bus';
import { resolveCliAdapterForRole, type CliAdapterKind } from '@/lib/runner/agent-config';
import { CliAgentAdapter, resolveCliCommandConfig } from '@/lib/runner/cli-agent-adapter';
import { appendEvent, readMessages, readState, updateAgentStatus, updateRunStatus, writeArtifact } from '@/lib/store/file-store';
import { createId, nowIso } from '@/lib/utils/ids';

const activeRuns = new Map<string, AbortController>();
const timers = new Map<string, NodeJS.Timeout>();

export function validateCliRunnerConfig(roles: AgentRole[]): { ok: true } | { ok: false; message: string } {
  try {
    for (const role of roles) {
      const adapter = resolveCliAdapterForRole(role);
      resolveCliCommandConfig(adapter);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'CLI adapter 설정이 올바르지 않습니다.' };
  }
}

export function startCliRun(runId: string): void {
  if (activeRuns.has(runId)) return;
  const controller = new AbortController();
  activeRuns.set(runId, controller);
  const timer = setTimeout(() => {
    void runScript(runId, controller.signal).finally(() => {
      activeRuns.delete(runId);
      timers.delete(runId);
    });
  }, 50);
  timer.unref?.();
  timers.set(runId, timer);
}

export function stopCliRun(runId: string): void {
  clearTimeout(timers.get(runId));
  timers.delete(runId);
  activeRuns.get(runId)?.abort();
  activeRuns.delete(runId);
}

function adapterKindForRole(state: RunState, role: AgentRole): CliAdapterKind {
  const adapter = state.agents.find((agent) => agent.role === role)?.adapter;
  if (adapter === 'codex') return adapter;
  return resolveCliAdapterForRole(role);
}

async function invokeAgent(input: {
  state: RunState;
  role: AgentRole;
  to: string;
  kind: MessageKind;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  const adapterKind = adapterKindForRole(input.state, input.role);
  const adapter = new CliAgentAdapter(adapterKind);
  await updateAgentStatus(input.state.run.id, input.role, 'thinking');
  await appendEvent(input.state.run.id, {
    id: createId('evt'),
    runId: input.state.run.id,
    type: 'agent.started',
    actor: input.role,
    payload: { role: input.role, adapter: adapterKind },
    createdAt: nowIso(),
  });
  const result = await adapter.run({
    runId: input.state.run.id,
    role: input.role,
    prompt: input.prompt,
    signal: input.signal,
  });
  const body = result.stdout || '(CLI stdout이 비어 있습니다.)';
  await sendMessage({
    runId: input.state.run.id,
    from: input.role,
    to: input.to,
    kind: input.kind,
    body,
  });
  await appendEvent(input.state.run.id, {
    id: createId('evt'),
    runId: input.state.run.id,
    type: 'message.sent',
    actor: input.role,
    payload: {
      adapter: adapterKind,
      durationMs: result.durationMs,
      stderr: result.stderr ? result.stderr.slice(0, 4000) : undefined,
    },
    createdAt: nowIso(),
  });
  return body;
}

function buildPlannerPrompt(state: RunState): string {
  return [
    '너는 AgentBoard의 Planner Agent다.',
    '사용자 brief를 분석해서 Engineer Agent에게 전달할 실행 계획을 작성해라.',
    '출력은 한국어 Markdown으로, MVP 목표와 구현 순서를 짧게 정리해라.',
    '',
    `Run ID: ${state.run.id}`,
    `Brief: ${state.run.brief}`,
  ].join('\n');
}

function buildEngineerPrompt(state: RunState, plan: string): string {
  return [
    '너는 AgentBoard의 Engineer Agent다.',
    'Planner의 계획을 받아 구현 접근과 산출물 구조를 작성해라.',
    '출력은 한국어 Markdown으로, 파일/모듈/검증 관점을 포함해라.',
    '',
    `Brief: ${state.run.brief}`,
    '',
    'Planner output:',
    plan,
  ].join('\n');
}

async function buildReviewerPrompt(state: RunState, plan: string, engineeringResult: string): Promise<string> {
  const interventions = (await readMessages(state.run.id)).filter((message) => message.kind === 'user_intervention');
  const interventionSummary = interventions.length
    ? interventions.map((message, index) => `${index + 1}. to=${message.to}: ${message.body}`).join('\n')
    : '사용자 개입 없음';
  return [
    '너는 AgentBoard의 Reviewer Agent다.',
    'Planner와 Engineer의 결과, 사용자 개입을 반영해 최종 보고서를 작성해라.',
    '출력은 한국어 Markdown으로, 협업 증거와 최종 결론을 포함해라.',
    '',
    `Brief: ${state.run.brief}`,
    '',
    'Planner output:',
    plan,
    '',
    'Engineer output:',
    engineeringResult,
    '',
    'User interventions:',
    interventionSummary,
  ].join('\n');
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function runScript(runId: string, signal: AbortSignal): Promise<void> {
  let currentRole: AgentRole | null = null;
  try {
    await updateRunStatus(runId, 'running');
    await appendEvent(runId, {
      id: createId('evt'),
      runId,
      type: 'run.started',
      actor: 'system',
      payload: { mode: 'cli' },
      createdAt: nowIso(),
    });

    const state = await readState(runId);
    currentRole = 'planner';
    const plan = await invokeAgent({
      state,
      role: 'planner',
      to: 'engineer',
      kind: 'instruction',
      prompt: buildPlannerPrompt(state),
      signal,
    });

    currentRole = 'engineer';
    const engineeringResult = await invokeAgent({
      state,
      role: 'engineer',
      to: 'reviewer',
      kind: 'result',
      prompt: buildEngineerPrompt(state, plan),
      signal,
    });

    currentRole = 'reviewer';
    const reviewerResult = await invokeAgent({
      state,
      role: 'reviewer',
      to: 'planner',
      kind: 'review',
      prompt: await buildReviewerPrompt(state, plan, engineeringResult),
      signal,
    });

    const finalReport = [
      '# AgentBoard CLI Collaboration Report',
      '',
      `- Run ID: ${runId}`,
      '- Mode: cli',
      '',
      '## Planner Output',
      '',
      plan,
      '',
      '## Engineer Output',
      '',
      engineeringResult,
      '',
      '## Reviewer Output',
      '',
      reviewerResult,
    ].join('\n');
    await writeArtifact(runId, finalReport, 'reviewer');

    await updateAgentStatus(runId, 'planner', 'done');
    await updateAgentStatus(runId, 'engineer', 'done');
    await updateAgentStatus(runId, 'reviewer', 'done');
    await updateRunStatus(runId, 'completed');
    await appendEvent(runId, {
      id: createId('evt'),
      runId,
      type: 'run.completed',
      actor: 'system',
      payload: { artifact: 'final-report.md', mode: 'cli' },
      createdAt: nowIso(),
    });
  } catch (error) {
    const message = errorText(error);
    if (currentRole) await updateAgentStatus(runId, currentRole, 'failed').catch(() => undefined);
    await appendEvent(runId, {
      id: createId('evt'),
      runId,
      type: 'error',
      actor: currentRole ?? 'cli-runner',
      payload: { message },
      createdAt: nowIso(),
    }).catch(() => undefined);
    await writeArtifact(runId, `# AgentBoard CLI Run Failed\n\n${message}\n`, currentRole ?? 'cli-runner').catch(() => undefined);
    await updateRunStatus(runId, 'failed').catch(() => undefined);
  }
}

export async function acknowledgeCliIntervention(runId: string, to: string, body: string): Promise<void> {
  const target = to === 'all' ? 'planner' : to;
  await sendMessage({
    runId,
    from: target,
    to: 'user',
    kind: 'ack',
    body: `CLI mode에서 사용자 지시를 수신했습니다. 다음 agent prompt 또는 최종 artifact에 반영합니다: ${body}`,
  });
}
