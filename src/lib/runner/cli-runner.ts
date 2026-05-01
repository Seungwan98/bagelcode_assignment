import type { AgentRole, RunState } from '@/lib/protocol/types';
import { resolveCliAdapterForRole, type CliAdapterKind } from '@/lib/runner/agent-config';
import { CliAgentAdapter, resolveCliCommandConfig } from '@/lib/runner/cli-agent-adapter';
import { clearContinuationWatchdog, scheduleContinuationWatchdog } from '@/lib/runner/continuation-watchdog';
import { runAgentConversation, type AgentExecutionInput } from '@/lib/runner/agent-session-runtime';
import { resolveTmuxCommandConfig, TmuxSessionAdapter } from '@/lib/runner/tmux-session-adapter';
import { appendEvent, readMessages, readState, updateAgentStatus, updateRunStatus, writeArtifact } from '@/lib/store/file-store';
import { createId, nowIso } from '@/lib/utils/ids';

const activeRuns = new Map<string, AbortController>();
const timers = new Map<string, NodeJS.Timeout>();

function scheduleCliContinuationIfRunning(runId: string): void {
  void readState(runId)
    .then((state) => {
      if (state.run.status === 'running') {
        scheduleContinuationWatchdog(runId, { isRunnerActive: isCliRunActive, restart: startCliRun });
      }
    })
    .catch(() => undefined);
}

export function validateCliRunnerConfig(roles: AgentRole[]): { ok: true } | { ok: false; message: string } {
  try {
    for (const role of roles) {
      const adapter = resolveCliAdapterForRole(role);
      resolveCliCommandConfig(adapter);
      if (adapter === 'tmux-codex') resolveTmuxCommandConfig();
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
  scheduleContinuationWatchdog(runId, { isRunnerActive: isCliRunActive, restart: startCliRun });
  const timer = setTimeout(() => {
    void runScript(runId, controller.signal).finally(() => {
      activeRuns.delete(runId);
      timers.delete(runId);
      scheduleCliContinuationIfRunning(runId);
    });
  }, 50);
  timer.unref?.();
  timers.set(runId, timer);
}

export function stopCliRun(runId: string): void {
  clearContinuationWatchdog(runId);
  clearTimeout(timers.get(runId));
  timers.delete(runId);
  activeRuns.get(runId)?.abort();
  activeRuns.delete(runId);
  void stopTmuxRunSessions(runId);
}

export function isCliRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

function adapterKindForRole(state: RunState, role: AgentRole): CliAdapterKind {
  const adapter = state.agents.find((agent) => agent.role === role)?.adapter;
  if (adapter === 'codex' || adapter === 'tmux-codex') return adapter;
  return resolveCliAdapterForRole(role);
}

async function stopTmuxRunSessions(runId: string): Promise<void> {
  try {
    const state = await readState(runId);
    const hasTmuxSession = Object.values(state.sessions ?? {}).some((session) => session?.adapter === 'tmux-codex');
    if (!hasTmuxSession) return;
    await new TmuxSessionAdapter('tmux-codex').stopRunSessions(runId);
  } catch {
    // Stop should be best-effort and must not break control actions.
  }
}

async function invokeAgent(input: {
  state: RunState;
  execution: AgentExecutionInput;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  const adapterKind = adapterKindForRole(input.state, input.execution.definition.id);
  const adapter = adapterKind === 'tmux-codex'
    ? new TmuxSessionAdapter(adapterKind)
    : new CliAgentAdapter(adapterKind);
  await updateAgentStatus(input.state.run.id, input.execution.definition.id, 'thinking');
  await appendEvent(input.state.run.id, {
    id: createId('evt'),
    runId: input.state.run.id,
    type: 'agent.started',
    actor: input.execution.definition.id,
    payload: {
      role: input.execution.definition.id,
      adapter: adapterKind,
      description: input.execution.definition.description,
      turnUserMessageId: input.execution.context.turnUserMessageId,
    },
    createdAt: nowIso(),
  });
  const result = await adapter.run({
    runId: input.state.run.id,
    role: input.execution.definition.id,
    prompt: input.prompt,
    signal: input.signal,
  });
  const body = result.stdout || '(CLI stdout이 비어 있습니다.)';
  await appendEvent(input.state.run.id, {
    id: createId('evt'),
    runId: input.state.run.id,
    type: 'message.sent',
    actor: input.execution.definition.id,
    payload: {
      adapterRun: true,
      summary: 'CLI adapter 출력이 AgentBoard session runtime에 저장되었습니다.',
      adapter: adapterKind,
      durationMs: result.durationMs,
      stdoutBytes: Buffer.byteLength(body, 'utf8'),
      sessionInjected: adapterKind === 'tmux-codex',
      stderr: result.stderr ? result.stderr.slice(0, 4000) : undefined,
    },
    createdAt: nowIso(),
  });
  return body;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function shouldStop(runId: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return true;
  try {
    return (await readState(runId)).run.status === 'stopped';
  } catch {
    return true;
  }
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
    const messages = await readMessages(runId);
    const result = await runAgentConversation({
      state,
      messages,
      shouldStop: () => shouldStop(runId, signal),
      invokeAgent: async (execution) => {
        currentRole = execution.definition.id;
        return invokeAgent({ state, execution, prompt: execution.prompt, signal });
      },
    });

    if (result.stopped) return;

    const finalReport = [
      '# AgentBoard CLI Collaboration Report',
      '',
      `- Run ID: ${runId}`,
      '- Mode: cli',
      `- Latest User Request: ${result.context.userRequest}`,
      `- Turn User Message ID: ${result.context.turnUserMessageId}`,
      `- Verification Iterations: ${result.verificationIterations}`,
      '',
      '## Orchestrator Plan',
      '',
      result.orchestratorPlan.steps.map((step, index) => `${index + 1}. ${step.agent}: ${step.task}`).join('\n'),
      '',
      '## Orchestrator Verdicts',
      '',
      result.orchestratorVerdicts.length
        ? result.orchestratorVerdicts.map((verdict, index) => `${index + 1}. ${verdict.status}: ${verdict.reason}`).join('\n')
        : 'Orchestrator 검증 없음',
      '',
      '## Orchestrator Output',
      '',
      result.outputs.orchestrator ?? '',
      '',
      '## Planner Output',
      '',
      result.outputs.planner ?? '',
      '',
      '## Engineer Output',
      '',
      result.outputs.engineer ?? '',
      '',
      '## Reviewer Output',
      '',
      result.outputs.reviewer ?? '',
    ].join('\n');
    await writeArtifact(runId, finalReport, 'orchestrator');

    for (const role of Object.keys(result.outputs)) {
      await updateAgentStatus(runId, role, 'done');
    }
    await updateRunStatus(runId, 'completed');
    await appendEvent(runId, {
      id: createId('evt'),
      runId,
      type: 'run.completed',
      actor: 'system',
      payload: { artifact: 'final-report.md', mode: 'cli' },
      createdAt: nowIso(),
    });
    clearContinuationWatchdog(runId);
  } catch (error) {
    const wasStopped = signal.aborted || (await readState(runId).then((state) => state.run.status === 'stopped').catch(() => false));
    if (wasStopped) return;
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
    clearContinuationWatchdog(runId);
  }
}
