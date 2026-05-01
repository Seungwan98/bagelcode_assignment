import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  AgentMessage,
  AgentRole,
  AgentSessionHandle,
  AgentSessionStatus,
  AgentState,
  Artifact,
  ClientSession,
  ClientSessionRunSummary,
  ClientSessionSnapshot,
  ContinuationState,
  Run,
  RunEvent,
  RunMode,
  RunState,
} from '../protocol/types';
import { resolveAdapterForRole } from '../runner/agent-config';
import { getAgentDefinition } from '../runner/agent-definitions';
import { createId, nowIso } from '../utils/ids';
import { appendJsonl, readJsonl } from '../utils/jsonl';

export function getAgentboardRoot(): string {
  const root = process.env.AGENTBOARD_STATE_DIR ?? '.agentboard/runs';
  return isAbsolute(root) ? root : join(/*turbopackIgnore: true*/ process.cwd(), root);
}

const DEFAULT_AGENTS: AgentRole[] = ['orchestrator', 'planner', 'engineer', 'reviewer'];
const ACTIVE_RUN_STATUSES = new Set<Run['status']>(['created', 'running', 'paused']);
const CLIENT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;
const MAX_SESSION_RECENT_RUNS = 12;
const DEFAULT_STALE_RUN_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_CONTINUATION_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_CONTINUATION_MAX_ITERATIONS = 5;
const TERMINAL_RUN_STATUSES = new Set<Run['status']>(['completed', 'failed', 'stopped', 'stale']);
export function runDir(runId: string): string {
  return join(getAgentboardRoot(), runId);
}

export function normalizeClientSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!CLIENT_SESSION_ID_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

function requireClientSessionId(value: unknown): string {
  const normalized = normalizeClientSessionId(value);
  if (!normalized) throw new Error('Invalid client session id');
  return normalized;
}

export function clientSessionsDir(): string {
  return join(getAgentboardRoot(), '_sessions');
}

export function clientSessionPath(clientSessionId: string): string {
  return join(clientSessionsDir(), `${requireClientSessionId(clientSessionId)}.json`);
}

export function eventsPath(runId: string): string {
  return join(runDir(runId), 'events.jsonl');
}

export function messagesPath(runId: string): string {
  return join(runDir(runId), 'messages.jsonl');
}

export function agentInboxPath(runId: string, agentId: string): string {
  return join(runDir(runId), 'agents', agentId, 'inbox.jsonl');
}

export function artifactPath(runId: string): string {
  return join(runDir(runId), 'artifacts', 'final-report.md');
}

export function implementationWorkspaceDir(runId: string): string {
  const runsRoot = getAgentboardRoot();
  const defaultRunsRoot = join(/*turbopackIgnore: true*/ process.cwd(), '.agentboard/runs');
  const workspacesRoot = runsRoot === defaultRunsRoot
    ? join(/*turbopackIgnore: true*/ process.cwd(), '.agentboard/workspaces')
    : join(dirname(runsRoot), 'workspaces');
  return join(workspacesRoot, runId);
}

export function createAgentStates(roles: AgentRole[] = DEFAULT_AGENTS, mode: RunMode = 'mock'): AgentState[] {
  return roles.map((role) => ({
    id: role,
    role,
    displayName: getAgentDefinition(role).displayName,
    adapter: resolveAdapterForRole(role, mode),
    status: 'idle',
  }));
}

async function writeTextAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tempPath, body, 'utf8');
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function emptyClientSession(clientSessionId: string): ClientSession {
  const createdAt = nowIso();
  return {
    id: requireClientSessionId(clientSessionId),
    createdAt,
    updatedAt: createdAt,
    recentRunIds: [],
    runs: [],
  };
}

function runSummary(run: Run): ClientSessionRunSummary {
  return {
    runId: run.id,
    title: run.title,
    status: run.status,
    mode: run.mode,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

function isRunSummary(value: unknown): value is ClientSessionRunSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<ClientSessionRunSummary>;
  return Boolean(summary.runId && summary.title && summary.status && summary.mode && summary.createdAt && summary.updatedAt);
}

function isActiveRun(status: Run['status']): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

function sessionSort(left: ClientSessionRunSummary, right: ClientSessionRunSummary): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function staleRunAfterMs(): number {
  const configured = Number(process.env.AGENTBOARD_STALE_RUN_MS ?? DEFAULT_STALE_RUN_AFTER_MS);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_STALE_RUN_AFTER_MS;
  return configured;
}

function continuationIdleTimeoutMs(): number {
  const configured = Number(process.env.AGENTBOARD_CONTINUATION_IDLE_TIMEOUT_MS ?? DEFAULT_CONTINUATION_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured < 0) return DEFAULT_CONTINUATION_IDLE_TIMEOUT_MS;
  return configured;
}

function continuationMaxIterations(): number {
  const configured = Number(process.env.AGENTBOARD_CONTINUATION_MAX_ITERATIONS ?? DEFAULT_CONTINUATION_MAX_ITERATIONS);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_CONTINUATION_MAX_ITERATIONS;
  return Math.floor(configured);
}

function continuationEnabled(): boolean {
  return process.env.AGENTBOARD_CONTINUATION_ENABLED !== 'false';
}

export function createContinuationState(input: Partial<ContinuationState> = {}): ContinuationState {
  return {
    enabled: input.enabled ?? continuationEnabled(),
    iteration: input.iteration ?? 0,
    maxIterations: input.maxIterations ?? continuationMaxIterations(),
    idleTimeoutMs: input.idleTimeoutMs ?? continuationIdleTimeoutMs(),
    lastInjectedAt: input.lastInjectedAt,
    reason: input.reason,
    completedAt: input.completedAt,
  };
}

export function normalizeContinuationState(state: RunState): ContinuationState {
  return createContinuationState(state.continuation);
}

function shouldMarkRunningRunStale(run: Run, nowMs = Date.now()): boolean {
  if (run.status !== 'running') return false;
  const updatedAtMs = Date.parse(run.updatedAt);
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs > staleRunAfterMs();
}

export async function readClientSession(clientSessionId: string): Promise<ClientSession> {
  const id = requireClientSessionId(clientSessionId);
  try {
    const body = await readFile(clientSessionPath(id), 'utf8');
    const parsed = JSON.parse(body) as Partial<ClientSession>;
    const runs = Array.isArray(parsed.runs) ? parsed.runs.filter(isRunSummary) : [];
    const recentRunIds = Array.isArray(parsed.recentRunIds)
      ? parsed.recentRunIds.filter((runId): runId is string => typeof runId === 'string')
      : runs.map((run) => run.runId);
    return {
      id: parsed.id ?? id,
      createdAt: parsed.createdAt ?? nowIso(),
      updatedAt: parsed.updatedAt ?? parsed.createdAt ?? nowIso(),
      activeRunId: typeof parsed.activeRunId === 'string' ? parsed.activeRunId : undefined,
      recentRunIds,
      runs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyClientSession(id);
    throw error;
  }
}

async function writeClientSession(session: ClientSession): Promise<void> {
  await writeTextAtomic(clientSessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`);
}

export async function removeClientSessionRun(clientSessionId: string, runId: string): Promise<ClientSession> {
  const session = await readClientSession(clientSessionId);
  const runs = session.runs.filter((item) => item.runId !== runId).sort(sessionSort).slice(0, MAX_SESSION_RECENT_RUNS);
  const recentRunIds = session.recentRunIds.filter((item) => item !== runId);
  const activeRun = runs.find((item) => isActiveRun(item.status));
  const nextSession: ClientSession = {
    ...session,
    updatedAt: nowIso(),
    activeRunId: activeRun?.runId,
    recentRunIds,
    runs,
  };
  await writeClientSession(nextSession);
  return nextSession;
}

async function upsertClientSessionRun(run: Run): Promise<void> {
  if (!run.clientSessionId) return;
  const session = await readClientSession(run.clientSessionId);
  const nextSummary = runSummary(run);
  const byId = new Map(session.runs.map((item) => [item.runId, item]));
  byId.set(nextSummary.runId, nextSummary);
  const runs = [...byId.values()].sort(sessionSort).slice(0, MAX_SESSION_RECENT_RUNS);
  const activeRun = runs.find((item) => isActiveRun(item.status));
  await writeClientSession({
    ...session,
    updatedAt: nowIso(),
    activeRunId: activeRun?.runId,
    recentRunIds: runs.map((item) => item.runId),
    runs,
  });
}

async function markStaleRunningRunIfNeeded(state: RunState, now = new Date()): Promise<RunState> {
  if (!shouldMarkRunningRunStale(state.run, now.getTime())) return state;
  const staleAt = now.toISOString();
  state.run.status = 'stale';
  state.run.updatedAt = staleAt;
  state.run.completedAt = staleAt;
  state.run.staleReason = 'Run was still running after the local runner heartbeat window elapsed.';
  state.continuation = createContinuationState({
    ...normalizeContinuationState(state),
    completedAt: staleAt,
    reason: state.run.staleReason,
  });
  await writeState(state.run.id, state);
  await appendEvent(state.run.id, {
    id: createId('evt'),
    runId: state.run.id,
    type: 'run.stale',
    actor: 'session-store',
    payload: { staleAfterMs: staleRunAfterMs(), staleAt },
    createdAt: staleAt,
  });
  return state;
}

export async function readClientSessionSnapshot(clientSessionId: string): Promise<ClientSessionSnapshot> {
  const session = await readClientSession(clientSessionId);
  const runIds = [...new Set([...session.recentRunIds, ...session.runs.map((item) => item.runId)])];
  const runs: ClientSessionRunSummary[] = [];
  const staleRunIds: string[] = [];

  for (const runId of runIds) {
    try {
      const state = await markStaleRunningRunIfNeeded(await readState(runId));
      const summary = runSummary(state.run);
      if (summary.status === 'stale') staleRunIds.push(summary.runId);
      runs.push(summary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const recentRuns = runs.sort(sessionSort).slice(0, MAX_SESSION_RECENT_RUNS);
  const activeRun = recentRuns.find((item) => isActiveRun(item.status));
  const refreshedSession: ClientSession = {
    ...session,
    updatedAt: nowIso(),
    activeRunId: activeRun?.runId,
    recentRunIds: recentRuns.map((item) => item.runId),
    runs: recentRuns,
  };
  await writeClientSession(refreshedSession);
  return { session: refreshedSession, activeRun, recentRuns, staleRunIds };
}

export async function recordClientSessionRun(clientSessionId: string, runId: string): Promise<ClientSession> {
  const sessionId = requireClientSessionId(clientSessionId);
  const state = await readState(runId);
  if (state.run.clientSessionId !== sessionId) {
    state.run.clientSessionId = sessionId;
    state.run.updatedAt = nowIso();
    await writeState(runId, state);
  } else {
    await upsertClientSessionRun(state.run);
  }
  return readClientSession(sessionId);
}

export async function createRun(input: { title: string; brief: string; mode: RunMode; agents?: AgentRole[]; clientSessionId?: string }): Promise<RunState> {
  const createdAt = nowIso();
  const clientSessionId = input.clientSessionId ? requireClientSessionId(input.clientSessionId) : undefined;
  const run: Run = {
    id: createId('run'),
    title: input.title,
    brief: input.brief,
    status: 'created',
    mode: input.mode,
    clientSessionId,
    createdAt,
    updatedAt: createdAt,
  };
  const state: RunState = { run, agents: createAgentStates(input.agents, input.mode), continuation: createContinuationState() };
  await mkdir(runDir(run.id), { recursive: true });
  await mkdir(join(runDir(run.id), 'artifacts'), { recursive: true });
  await Promise.all(state.agents.map((agent) => mkdir(join(runDir(run.id), 'agents', agent.id), { recursive: true })));
  await writeState(run.id, state);
  await appendEvent(run.id, {
    id: createId('evt'),
    runId: run.id,
    type: 'run.created',
    actor: 'system',
    payload: { title: run.title, mode: run.mode, clientSessionId },
    createdAt,
  });
  return state;
}

export async function readState(runId: string): Promise<RunState> {
  const body = await readFile(join(runDir(runId), 'state.json'), 'utf8');
  return JSON.parse(body) as RunState;
}

export async function writeState(
  runId: string,
  state: RunState,
  options: { allowTerminalTransition?: boolean } = {},
): Promise<void> {
  try {
    const current = JSON.parse(await readFile(join(runDir(runId), 'state.json'), 'utf8')) as RunState;
    if (
      (current.run.status === 'stopped' && state.run.status !== 'stopped')
      || (
        !options.allowTerminalTransition
        && TERMINAL_RUN_STATUSES.has(current.run.status)
        && !TERMINAL_RUN_STATUSES.has(state.run.status)
      )
    ) {
      state.run = current.run;
      state.continuation = current.continuation;
      state.latestArtifact = current.latestArtifact ?? state.latestArtifact;
      state.sessions = current.sessions ?? state.sessions;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(runDir(runId), { recursive: true });
  await writeTextAtomic(join(runDir(runId), 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  await writeTextAtomic(join(runDir(runId), 'run.json'), `${JSON.stringify(state.run, null, 2)}\n`);
  await upsertClientSessionRun(state.run);
}

export async function updateRunStatus(runId: string, status: Run['status']): Promise<RunState> {
  const state = await readState(runId);
  const updatedAt = nowIso();
  state.run.status = status;
  state.run.updatedAt = updatedAt;
  if (status === 'completed' || status === 'failed' || status === 'stopped' || status === 'stale') {
    state.run.completedAt = updatedAt;
    state.continuation = createContinuationState({
      ...normalizeContinuationState(state),
      completedAt: updatedAt,
    });
  }
  await writeState(runId, state, { allowTerminalTransition: true });
  return state;
}

export async function resetContinuationState(runId: string): Promise<ContinuationState> {
  const state = await readState(runId);
  state.continuation = createContinuationState();
  state.run.updatedAt = nowIso();
  await writeState(runId, state);
  return state.continuation;
}

export async function updateContinuationState(
  runId: string,
  update: Partial<ContinuationState> | ((current: ContinuationState) => ContinuationState),
): Promise<ContinuationState> {
  const state = await readState(runId);
  const current = normalizeContinuationState(state);
  state.continuation = typeof update === 'function'
    ? update(current)
    : createContinuationState({ ...current, ...update });
  state.run.updatedAt = nowIso();
  await writeState(runId, state);
  return state.continuation;
}

export async function markRunStale(runId: string, reason: string, payload: Record<string, unknown> = {}): Promise<RunState> {
  const state = await readState(runId);
  const staleAt = nowIso();
  state.run.status = 'stale';
  state.run.updatedAt = staleAt;
  state.run.completedAt = staleAt;
  state.run.staleReason = reason;
  state.continuation = createContinuationState({
    ...normalizeContinuationState(state),
    completedAt: staleAt,
    reason,
  });
  await writeState(runId, state);
  await appendEvent(runId, {
    id: createId('evt'),
    runId,
    type: 'run.stale',
    actor: 'continuation-watchdog',
    payload: { reason, staleAt, ...payload },
    createdAt: staleAt,
  });
  return state;
}

export async function deleteRun(runId: string): Promise<void> {
  const state = await readState(runId);
  if (isActiveRun(state.run.status)) {
    throw new Error('Run is in progress');
  }
  await rm(runDir(runId), { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  if (state.run.clientSessionId) {
    await removeClientSessionRun(state.run.clientSessionId, runId);
  }
}

export async function updateAgentStatus(runId: string, agentId: string, status: AgentState['status']): Promise<void> {
  const state = await readState(runId);
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) return;
  agent.status = status;
  agent.lastMessageAt = nowIso();
  state.run.updatedAt = agent.lastMessageAt;
  const latest = await readState(runId).catch(() => state);
  if (TERMINAL_RUN_STATUSES.has(latest.run.status)) return;
  await writeState(runId, state);
  await appendEvent(runId, {
    id: createId('evt'),
    runId,
    type: 'agent.status_changed',
    actor: agentId,
    payload: { agentId, status },
    createdAt: nowIso(),
  });
}

export async function upsertAgentSessionHandle(
  runId: string,
  role: AgentRole,
  handle: AgentSessionHandle,
): Promise<AgentSessionHandle> {
  const state = await readState(runId);
  const updatedAt = nowIso();
  const nextHandle = { ...handle, updatedAt };
  state.sessions = { ...(state.sessions ?? {}), [role]: nextHandle };
  state.run.updatedAt = updatedAt;
  await writeState(runId, state);
  return nextHandle;
}

export async function updateAgentSessionStatus(
  runId: string,
  role: AgentRole,
  status: AgentSessionStatus,
  timestamps: Partial<Pick<AgentSessionHandle, 'lastInjectedAt' | 'lastCapturedAt' | 'lastCompletedAt'>> = {},
): Promise<AgentSessionHandle | undefined> {
  const state = await readState(runId);
  const existing = state.sessions?.[role];
  if (!existing) return undefined;
  const updatedAt = nowIso();
  const nextHandle: AgentSessionHandle = {
    ...existing,
    ...timestamps,
    status,
    updatedAt,
  };
  state.sessions = { ...(state.sessions ?? {}), [role]: nextHandle };
  state.run.updatedAt = updatedAt;
  await writeState(runId, state);
  return nextHandle;
}

export async function appendEvent(runId: string, event: RunEvent): Promise<void> {
  await appendJsonl(eventsPath(runId), event);
}

export async function readEvents(runId: string): Promise<RunEvent[]> {
  return readJsonl<RunEvent>(eventsPath(runId));
}

export async function appendMessage(message: AgentMessage): Promise<void> {
  await appendJsonl(messagesPath(message.runId), message);
  if (message.to !== 'all') await appendJsonl(agentInboxPath(message.runId, message.to), message);
}

export async function readMessages(runId: string): Promise<AgentMessage[]> {
  return readJsonl<AgentMessage>(messagesPath(runId));
}

export async function getRunActivity(runId: string): Promise<{ latestActivityAt: string; latestActivityAtMs: number }> {
  const [state, events, messages] = await Promise.all([
    readState(runId),
    readEvents(runId),
    readMessages(runId),
  ]);
  const candidates = [
    state.run.updatedAt,
    state.continuation?.lastInjectedAt,
    ...state.agents.map((agent) => agent.lastMessageAt),
    events.at(-1)?.createdAt,
    messages.at(-1)?.createdAt,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const latestActivityAtMs = candidates
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .reduce((latest, value) => Math.max(latest, value), 0);
  return {
    latestActivityAt: new Date(latestActivityAtMs || Date.now()).toISOString(),
    latestActivityAtMs: latestActivityAtMs || Date.now(),
  };
}

export async function writeArtifact(runId: string, body: string, createdBy = 'orchestrator'): Promise<Artifact> {
  const path = artifactPath(runId);
  const updatedAt = nowIso();
  const artifact: Artifact = {
    id: 'final-report',
    runId,
    title: 'Final Collaboration Report',
    path,
    mimeType: 'text/markdown',
    createdBy,
    createdAt: updatedAt,
    updatedAt,
  };
  const state = await readState(runId);
  state.latestArtifact = artifact;
  state.run.updatedAt = updatedAt;
  await writeTextAtomic(path, body);
  await writeState(runId, state);
  await appendEvent(runId, {
    id: createId('evt'),
    runId,
    type: 'artifact.updated',
    actor: createdBy,
    payload: { artifactId: artifact.id, title: artifact.title },
    createdAt: updatedAt,
  });
  return artifact;
}

export async function readArtifact(runId: string): Promise<string> {
  try {
    return await readFile(artifactPath(runId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
