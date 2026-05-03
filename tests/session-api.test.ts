import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { POST as createRun } from '../src/app/api/runs/route';
import { DELETE as deleteRunRoute } from '../src/app/api/runs/[runId]/route';
import { GET as getWorkspace } from '../src/app/api/runs/[runId]/workspace/route';
import { GET as getWorkspaceFile } from '../src/app/api/runs/[runId]/workspace/file/route';
import { GET as getSession } from '../src/app/api/sessions/[clientSessionId]/route';
import { POST as activateRun } from '../src/app/api/sessions/[clientSessionId]/active-run/route';
import { implementationWorkspaceDir, updateRunStatus } from '../src/lib/store/file-store';

async function withStateDir<T>(fn: () => Promise<T>): Promise<T> {
  const previousDir = process.env.AGENTBOARD_STATE_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'agentboard-session-api-'));
  process.env.AGENTBOARD_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previousDir === undefined) delete process.env.AGENTBOARD_STATE_DIR;
    else process.env.AGENTBOARD_STATE_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
}

test('run creation API associates a client session with the new run', async () => withStateDir(async () => {
  const createResponse = await createRun(new Request('http://agentboard.test/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'API session run',
      brief: 'API route가 clientSessionId를 run에 연결해야 한다',
      mode: 'mock',
      clientSessionId: 'client_api_session',
    }),
  }));
  const created = await createResponse.json() as { ok: boolean; runId: string; clientSessionId?: string };

  assert.equal(createResponse.status, 200);
  assert.equal(created.ok, true);
  assert.equal(created.clientSessionId, 'client_api_session');

  const sessionResponse = await getSession(new Request('http://agentboard.test/api/sessions/client_api_session'), {
    params: Promise.resolve({ clientSessionId: 'client_api_session' }),
  });
  const snapshot = await sessionResponse.json() as {
    ok: boolean;
    activeRun?: { runId: string };
    recentRuns: Array<{ runId: string; title: string }>;
  };

  assert.equal(sessionResponse.status, 200);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.activeRun?.runId, created.runId);
  assert.deepEqual(snapshot.recentRuns.map((run) => run.runId), [created.runId]);
  assert.equal(snapshot.recentRuns[0]?.title, 'API session run');
}));

test('active-run API marks an opened run as the current browser session run', async () => withStateDir(async () => {
  const createResponse = await createRun(new Request('http://agentboard.test/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Direct URL run',
      brief: '직접 URL로 연 run도 현재 세션에 연결해야 한다',
      mode: 'mock',
    }),
  }));
  const created = await createResponse.json() as { ok: boolean; runId: string };

  assert.equal(created.ok, true);

  const activeResponse = await activateRun(new Request('http://agentboard.test/api/sessions/client_direct_session/active-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: created.runId }),
  }), {
    params: Promise.resolve({ clientSessionId: 'client_direct_session' }),
  });
  const active = await activeResponse.json() as { ok: boolean; session?: { activeRunId?: string; recentRunIds: string[] } };

  assert.equal(activeResponse.status, 200);
  assert.equal(active.ok, true);
  assert.equal(active.session?.activeRunId, created.runId);
  assert.deepEqual(active.session?.recentRunIds, [created.runId]);
}));

test('session APIs reject unsafe clientSessionId values', async () => withStateDir(async () => {
  const createResponse = await createRun(new Request('http://agentboard.test/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief: 'bad session id should fail',
      mode: 'mock',
      clientSessionId: '../bad',
    }),
  }));

  assert.equal(createResponse.status, 400);

  const sessionResponse = await getSession(new Request('http://agentboard.test/api/sessions/..%2Fbad'), {
    params: Promise.resolve({ clientSessionId: '..%2Fbad' }),
  });
  assert.equal(sessionResponse.status, 400);
}));

test('run delete API removes a completed run from the client session', async () => withStateDir(async () => {
  const createResponse = await createRun(new Request('http://agentboard.test/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Delete API run',
      brief: '삭제 API가 세션 목록에서도 제거해야 한다',
      mode: 'mock',
      clientSessionId: 'client_delete_api_session',
    }),
  }));
  const created = await createResponse.json() as { ok: boolean; runId: string };
  await updateRunStatus(created.runId, 'completed');

  const deleteResponse = await deleteRunRoute(new Request(`http://agentboard.test/api/runs/${created.runId}`, {
    method: 'DELETE',
  }), {
    params: Promise.resolve({ runId: created.runId }),
  });
  assert.equal(deleteResponse.status, 200);

  const sessionResponse = await getSession(new Request('http://agentboard.test/api/sessions/client_delete_api_session'), {
    params: Promise.resolve({ clientSessionId: 'client_delete_api_session' }),
  });
  const snapshot = await sessionResponse.json() as { ok: boolean; recentRuns: Array<{ runId: string }>; activeRun?: { runId: string } };

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.activeRun, undefined);
  assert.deepEqual(snapshot.recentRuns, []);
}));

test('run delete API rejects running runs', async () => withStateDir(async () => {
  const createResponse = await createRun(new Request('http://agentboard.test/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Running delete API run',
      brief: '진행 중 삭제는 API에서 막아야 한다',
      mode: 'mock',
      clientSessionId: 'client_running_delete_api_session',
    }),
  }));
  const created = await createResponse.json() as { ok: boolean; runId: string };
  await updateRunStatus(created.runId, 'running');

  const deleteResponse = await deleteRunRoute(new Request(`http://agentboard.test/api/runs/${created.runId}`, {
    method: 'DELETE',
  }), {
    params: Promise.resolve({ runId: created.runId }),
  });
  const body = await deleteResponse.json() as { error?: { code?: string } };

  assert.equal(deleteResponse.status, 409);
  assert.equal(body.error?.code, 'RUN_IN_PROGRESS');
}));

test('workspace APIs list and read run workspace files safely', async () => withStateDir(async () => {
  const createResponse = await createRun(new Request('http://agentboard.test/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Workspace API run',
      brief: 'workspace 파일을 보여줘',
      mode: 'mock',
    }),
  }));
  const created = await createResponse.json() as { ok: boolean; runId: string };
  const workspace = implementationWorkspaceDir(created.runId);
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src', 'result.txt'), 'workspace result');

  const listResponse = await getWorkspace(new Request(`http://agentboard.test/api/runs/${created.runId}/workspace`), {
    params: Promise.resolve({ runId: created.runId }),
  });
  const list = await listResponse.json() as { ok: boolean; files: Array<{ path: string; size: number }> };

  assert.equal(listResponse.status, 200);
  assert.equal(list.ok, true);
  assert.deepEqual(list.files.map((file) => file.path), ['src/result.txt']);
  assert.equal(list.files[0]?.size, 'workspace result'.length);

  const fileResponse = await getWorkspaceFile(new Request(`http://agentboard.test/api/runs/${created.runId}/workspace/file?path=${encodeURIComponent('src/result.txt')}`), {
    params: Promise.resolve({ runId: created.runId }),
  });
  const file = await fileResponse.json() as { ok: boolean; file: { path: string; content: string } };

  assert.equal(fileResponse.status, 200);
  assert.equal(file.file.path, 'src/result.txt');
  assert.equal(file.file.content, 'workspace result');

  const unsafeResponse = await getWorkspaceFile(new Request(`http://agentboard.test/api/runs/${created.runId}/workspace/file?path=../state.json`), {
    params: Promise.resolve({ runId: created.runId }),
  });
  const unsafe = await unsafeResponse.json() as { error?: { code?: string } };

  assert.equal(unsafeResponse.status, 400);
  assert.equal(unsafe.error?.code, 'INVALID_PATH');
  await rm(workspace, { recursive: true, force: true });
}));
