import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createRun,
  deleteRun,
  implementationWorkspaceDir,
  readClientSession,
  readClientSessionSnapshot,
  readEvents,
  readState,
  updateRunStatus,
  writeState,
} from '../src/lib/store/file-store';

async function withStateDir<T>(fn: () => Promise<T>): Promise<T> {
  const previousDir = process.env.AGENTBOARD_STATE_DIR;
  const previousStaleMs = process.env.AGENTBOARD_STALE_RUN_MS;
  const dir = await mkdtemp(join(tmpdir(), 'agentboard-session-state-'));
  process.env.AGENTBOARD_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previousDir === undefined) delete process.env.AGENTBOARD_STATE_DIR;
    else process.env.AGENTBOARD_STATE_DIR = previousDir;
    if (previousStaleMs === undefined) delete process.env.AGENTBOARD_STALE_RUN_MS;
    else process.env.AGENTBOARD_STALE_RUN_MS = previousStaleMs;
    await rm(dir, { recursive: true, force: true });
  }
}

test('client sessions remember associated active and recent runs', async () => withStateDir(async () => {
  const state = await createRun({
    title: 'session run',
    brief: '브라우저 session에 run을 연결해줘',
    mode: 'mock',
    clientSessionId: 'client_test_session',
  });

  const storedState = await readState(state.run.id);
  const session = await readClientSession('client_test_session');
  const snapshot = await readClientSessionSnapshot('client_test_session');

  assert.equal(storedState.run.clientSessionId, 'client_test_session');
  assert.equal(session.activeRunId, state.run.id);
  assert.deepEqual(session.recentRunIds, [state.run.id]);
  assert.equal(snapshot.activeRun?.runId, state.run.id);
  assert.equal(snapshot.recentRuns[0]?.title, 'session run');
}));

test('client session snapshot drops completed runs from the active slot but keeps them resumable', async () => withStateDir(async () => {
  const state = await createRun({
    title: 'completed session run',
    brief: '완료된 run도 최근 기록에서 열 수 있어야 한다',
    mode: 'mock',
    clientSessionId: 'client_completed_session',
  });

  await updateRunStatus(state.run.id, 'running');
  assert.equal((await readClientSessionSnapshot('client_completed_session')).activeRun?.runId, state.run.id);

  await updateRunStatus(state.run.id, 'completed');
  const snapshot = await readClientSessionSnapshot('client_completed_session');

  assert.equal(snapshot.activeRun, undefined);
  assert.equal(snapshot.recentRuns[0]?.runId, state.run.id);
  assert.equal(snapshot.recentRuns[0]?.status, 'completed');
}));

test('stale running runs are marked safely when a session snapshot is read', async () => withStateDir(async () => {
  process.env.AGENTBOARD_STALE_RUN_MS = '1';
  const state = await createRun({
    title: 'stale session run',
    brief: '서버 재시작 뒤 running run을 안전하게 표시해줘',
    mode: 'mock',
    clientSessionId: 'client_stale_session',
  });
  await updateRunStatus(state.run.id, 'running');

  const oldState = await readState(state.run.id);
  oldState.run.updatedAt = new Date(Date.now() - 60_000).toISOString();
  await writeState(state.run.id, oldState);

  const snapshot = await readClientSessionSnapshot('client_stale_session');
  const staleState = await readState(state.run.id);
  const events = await readEvents(state.run.id);

  assert.equal(staleState.run.status, 'stale');
  assert.equal(snapshot.activeRun, undefined);
  assert.equal(snapshot.recentRuns[0]?.status, 'stale');
  assert.ok(events.some((event) => event.type === 'run.stale'));
}));

test('deleteRun removes completed run state and session references', async () => withStateDir(async () => {
  const state = await createRun({
    title: 'delete me',
    brief: '삭제 가능한 완료 run',
    mode: 'mock',
    clientSessionId: 'client_delete_session',
  });
  await updateRunStatus(state.run.id, 'completed');

  await deleteRun(state.run.id);

  const session = await readClientSession('client_delete_session');
  const snapshot = await readClientSessionSnapshot('client_delete_session');
  await assert.rejects(() => readState(state.run.id), { code: 'ENOENT' });
  assert.equal(session.activeRunId, undefined);
  assert.deepEqual(session.recentRunIds, []);
  assert.deepEqual(snapshot.recentRuns, []);
}));

test('deleteRun removes completed run workspace artifacts', async () => withStateDir(async () => {
  const state = await createRun({
    title: 'delete workspace',
    brief: 'workspace도 함께 삭제해야 한다',
    mode: 'mock',
    clientSessionId: 'client_delete_workspace_session',
  });
  const workspace = implementationWorkspaceDir(state.run.id);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'result.md'), 'workspace artifact');
  await updateRunStatus(state.run.id, 'completed');

  await deleteRun(state.run.id);

  await assert.rejects(() => access(workspace), { code: 'ENOENT' });
}));

test('deleteRun rejects active runs', async () => withStateDir(async () => {
  const state = await createRun({
    title: 'running delete',
    brief: '진행 중 삭제는 막아야 한다',
    mode: 'mock',
    clientSessionId: 'client_active_delete_session',
  });
  await updateRunStatus(state.run.id, 'running');

  await assert.rejects(() => deleteRun(state.run.id), /Run is in progress/);
  assert.equal((await readState(state.run.id)).run.status, 'running');
}));
