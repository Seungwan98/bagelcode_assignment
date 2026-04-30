import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { AgentMessage, AgentRole, AgentState, Artifact, Run, RunEvent, RunMode, RunState } from '../protocol/types';
import { resolveAdapterForRole } from '../runner/agent-config';
import { createId, nowIso } from '../utils/ids';
import { appendJsonl, readJsonl } from '../utils/jsonl';

export function getAgentboardRoot(): string {
  const root = process.env.AGENTBOARD_STATE_DIR ?? '.agentboard/runs';
  return isAbsolute(root) ? root : join(/*turbopackIgnore: true*/ process.cwd(), root);
}

const DEFAULT_AGENTS: AgentRole[] = ['planner', 'engineer', 'reviewer'];
const DISPLAY_NAMES: Record<AgentRole, string> = {
  planner: 'Planner Agent',
  engineer: 'Engineer Agent',
  reviewer: 'Reviewer Agent',
};

export function runDir(runId: string): string {
  return join(getAgentboardRoot(), runId);
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

export function createAgentStates(roles: AgentRole[] = DEFAULT_AGENTS, mode: RunMode = 'mock'): AgentState[] {
  return roles.map((role) => ({
    id: role,
    role,
    displayName: DISPLAY_NAMES[role],
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

export async function createRun(input: { title: string; brief: string; mode: RunMode; agents?: AgentRole[] }): Promise<RunState> {
  const createdAt = nowIso();
  const run: Run = {
    id: createId('run'),
    title: input.title,
    brief: input.brief,
    status: 'created',
    mode: input.mode,
    createdAt,
    updatedAt: createdAt,
  };
  const state: RunState = { run, agents: createAgentStates(input.agents, input.mode) };
  await mkdir(runDir(run.id), { recursive: true });
  await mkdir(join(runDir(run.id), 'artifacts'), { recursive: true });
  await Promise.all(state.agents.map((agent) => mkdir(join(runDir(run.id), 'agents', agent.id), { recursive: true })));
  await writeState(run.id, state);
  await appendEvent(run.id, {
    id: createId('evt'),
    runId: run.id,
    type: 'run.created',
    actor: 'system',
    payload: { title: run.title, mode: run.mode },
    createdAt,
  });
  return state;
}

export async function readState(runId: string): Promise<RunState> {
  const body = await readFile(join(runDir(runId), 'state.json'), 'utf8');
  return JSON.parse(body) as RunState;
}

export async function writeState(runId: string, state: RunState): Promise<void> {
  await mkdir(runDir(runId), { recursive: true });
  await writeTextAtomic(join(runDir(runId), 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  await writeTextAtomic(join(runDir(runId), 'run.json'), `${JSON.stringify(state.run, null, 2)}\n`);
}

export async function updateRunStatus(runId: string, status: Run['status']): Promise<RunState> {
  const state = await readState(runId);
  const updatedAt = nowIso();
  state.run.status = status;
  state.run.updatedAt = updatedAt;
  if (status === 'completed' || status === 'failed' || status === 'stopped') state.run.completedAt = updatedAt;
  await writeState(runId, state);
  return state;
}

export async function updateAgentStatus(runId: string, agentId: string, status: AgentState['status']): Promise<void> {
  const state = await readState(runId);
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) return;
  agent.status = status;
  agent.lastMessageAt = nowIso();
  state.run.updatedAt = agent.lastMessageAt;
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

export async function writeArtifact(runId: string, body: string, createdBy = 'reviewer'): Promise<Artifact> {
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
