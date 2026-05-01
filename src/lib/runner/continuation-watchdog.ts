import { sendMessage } from '@/lib/bus/message-bus';
import {
  appendEvent,
  getRunActivity,
  markRunStale,
  normalizeContinuationState,
  readState,
  updateContinuationState,
} from '@/lib/store/file-store';
import { createId, nowIso } from '@/lib/utils/ids';

export interface ContinuationWatchdogOptions {
  isRunnerActive: (runId: string) => boolean;
  restart: (runId: string) => void;
}

export type ContinuationProbeResult =
  | { action: 'missing' }
  | { action: 'disabled' }
  | { action: 'terminal'; status: string }
  | { action: 'runner-active' }
  | { action: 'waiting'; remainingMs: number }
  | { action: 'max-iterations' }
  | { action: 'injected'; iteration: number; messageId: string };

const timers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();
const generations = new Map<string, number>();
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'stale']);

function clearTimer(runId: string, bumpGeneration = false): void {
  const timer = timers.get(runId);
  if (timer) clearTimeout(timer);
  timers.delete(runId);
  if (bumpGeneration) generations.set(runId, (generations.get(runId) ?? 0) + 1);
}

async function resolveNextDelayMs(runId: string): Promise<number> {
  try {
    return normalizeContinuationState(await readState(runId)).idleTimeoutMs;
  } catch {
    return 15_000;
  }
}

export function clearContinuationWatchdog(runId: string): void {
  clearTimer(runId, true);
  inFlight.delete(runId);
}

export function scheduleContinuationWatchdog(runId: string, options: ContinuationWatchdogOptions, delayMs?: number): void {
  clearTimer(runId);
  const generation = (generations.get(runId) ?? 0) + 1;
  generations.set(runId, generation);
  const schedule = async () => {
    const resolvedDelay = delayMs ?? await resolveNextDelayMs(runId);
    if (generations.get(runId) !== generation) return;
    const timer = setTimeout(() => {
      void probeContinuationRun(runId, options).catch(() => undefined);
    }, Math.max(0, resolvedDelay));
    timer.unref?.();
    timers.set(runId, timer);
  };
  void schedule();
}

function buildContinuationPrompt(input: {
  iteration: number;
  maxIterations: number;
  latestActivityAt: string;
}): string {
  return [
    `Auto continuation ${input.iteration}/${input.maxIterations}`,
    '',
    '이전 Agent 실행이 완료 조건을 만족하지 못한 상태에서 idle로 판단되었습니다.',
    '현재 메시지, 이벤트, Agent 상태를 검토한 뒤 사용자 목적을 달성하기 위해 필요한 Agent에게 다시 배정하세요.',
    '이미 충분히 완료되었다면 최종 응답을 사용자에게 전달하고, 부족하다면 Planner/Engineer/Reviewer 중 필요한 Agent에게 구체적인 작업을 지시하세요.',
    '',
    `Latest activity: ${input.latestActivityAt}`,
  ].join('\n');
}

async function markMaxIterationsReached(runId: string, iteration: number, maxIterations: number): Promise<void> {
  const reason = `Continuation max iterations reached (${iteration}/${maxIterations}).`;
  await appendEvent(runId, {
    id: createId('evt'),
    runId,
    type: 'continuation.max_iterations_reached',
    actor: 'continuation-watchdog',
    payload: { iteration, maxIterations, reason },
    createdAt: nowIso(),
  });
  await markRunStale(runId, reason, { iteration, maxIterations });
}

export async function probeContinuationRun(
  runId: string,
  options: ContinuationWatchdogOptions,
): Promise<ContinuationProbeResult> {
  if (inFlight.has(runId)) return { action: 'runner-active' };
  inFlight.add(runId);

  try {
    let state;
    try {
      state = await readState(runId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { action: 'missing' };
      throw error;
    }

    const continuation = normalizeContinuationState(state);
    if (!continuation.enabled) return { action: 'disabled' };
    if (TERMINAL_STATUSES.has(state.run.status)) {
      clearContinuationWatchdog(runId);
      return { action: 'terminal', status: state.run.status };
    }
    if (state.run.status !== 'running') {
      scheduleContinuationWatchdog(runId, options, continuation.idleTimeoutMs);
      return { action: 'waiting', remainingMs: continuation.idleTimeoutMs };
    }
    if (options.isRunnerActive(runId)) {
      scheduleContinuationWatchdog(runId, options, continuation.idleTimeoutMs);
      return { action: 'runner-active' };
    }
    if (state.latestArtifact) {
      clearContinuationWatchdog(runId);
      return { action: 'terminal', status: 'artifact-ready' };
    }

    const activity = await getRunActivity(runId);
    const idleForMs = Date.now() - activity.latestActivityAtMs;
    if (idleForMs < continuation.idleTimeoutMs) {
      const remainingMs = continuation.idleTimeoutMs - idleForMs;
      scheduleContinuationWatchdog(runId, options, remainingMs);
      return { action: 'waiting', remainingMs };
    }

    if (continuation.iteration >= continuation.maxIterations) {
      await markMaxIterationsReached(runId, continuation.iteration, continuation.maxIterations);
      clearContinuationWatchdog(runId);
      return { action: 'max-iterations' };
    }

    const iteration = continuation.iteration + 1;
    const lastInjectedAt = nowIso();
    const updated = await updateContinuationState(runId, {
      iteration,
      lastInjectedAt,
      reason: `Run was idle for ${Math.max(0, idleForMs)}ms without completion.`,
      completedAt: undefined,
    });
    const message = await sendMessage({
      runId,
      from: 'system',
      to: 'orchestrator',
      kind: 'instruction',
      correlationId: `continuation:${iteration}`,
      body: buildContinuationPrompt({
        iteration,
        maxIterations: updated.maxIterations,
        latestActivityAt: activity.latestActivityAt,
      }),
    });
    await appendEvent(runId, {
      id: createId('evt'),
      runId,
      type: 'continuation.injected',
      actor: 'continuation-watchdog',
      payload: {
        iteration,
        maxIterations: updated.maxIterations,
        idleForMs,
        messageId: message.id,
      },
      createdAt: nowIso(),
    });
    options.restart(runId);
    return { action: 'injected', iteration, messageId: message.id };
  } finally {
    inFlight.delete(runId);
  }
}
