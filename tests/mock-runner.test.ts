import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { POST as controlRun } from '../src/app/api/runs/[runId]/control/route';
import { POST as postIntervention } from '../src/app/api/runs/[runId]/interventions/route';
import { sendMessage } from '../src/lib/bus/message-bus';
import { startMockRun } from '../src/lib/runner/mock-runner';
import { createRun, readArtifact, readEvents, readMessages, readState } from '../src/lib/store/file-store';

async function withStateDir<T>(fn: () => Promise<T>, delayScale = '0'): Promise<T> {
  const previousDir = process.env.AGENTBOARD_STATE_DIR;
  const previousScale = process.env.AGENTBOARD_MOCK_DELAY_SCALE;
  const dir = await mkdtemp(join(tmpdir(), 'agentboard-state-'));
  process.env.AGENTBOARD_STATE_DIR = dir;
  process.env.AGENTBOARD_MOCK_DELAY_SCALE = delayScale;
  try {
    return await fn();
  } finally {
    if (previousDir === undefined) delete process.env.AGENTBOARD_STATE_DIR;
    else process.env.AGENTBOARD_STATE_DIR = previousDir;
    if (previousScale === undefined) delete process.env.AGENTBOARD_MOCK_DELAY_SCALE;
    else process.env.AGENTBOARD_MOCK_DELAY_SCALE = previousScale;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitForRunStatus(runId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await readState(runId);
    if (state.run.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`mock run did not reach ${status} within timeout`);
}

test('mock runner completes collaboration and reflects user intervention in final artifact', async () => withStateDir(async () => {
  const state = await createRun({ title: 'mock run', brief: 'ASAP MVP', mode: 'mock' });
  await sendMessage({
    runId: state.run.id,
    from: 'user',
    to: 'engineer',
    kind: 'user_intervention',
    body: 'README 실행성을 최우선으로 반영해줘',
  });

  startMockRun(state.run.id);
  await waitForRunStatus(state.run.id, 'completed');

  const [completed, messages, artifact] = await Promise.all([
    readState(state.run.id),
    readMessages(state.run.id),
    readArtifact(state.run.id),
  ]);

  assert.equal(completed.run.status, 'completed');
  assert.ok(messages.some((message) => message.from === 'planner' && message.to === 'engineer'));
  assert.ok(messages.some((message) => message.from === 'engineer' && message.to === 'reviewer'));
  assert.ok(messages.some((message) => message.from === 'reviewer' && message.to === 'planner'));
  assert.ok(messages.some((message) => message.from === 'reviewer' && message.to === 'user' && /README 실행성/.test(message.body)));
  assert.match(artifact, /README 실행성을 최우선으로 반영해줘/);
}));

test('control stop cancels an in-progress mock run without completing the artifact', async () => withStateDir(async () => {
  const state = await createRun({ title: 'cancel run', brief: '멈출 수 있어야 한다', mode: 'mock' });
  startMockRun(state.run.id);
  await waitForRunStatus(state.run.id, 'running');

  const response = await controlRun(new Request(`http://agentboard.test/api/runs/${state.run.id}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  }), {
    params: Promise.resolve({ runId: state.run.id }),
  });

  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const [stopped, events, messages, artifact] = await Promise.all([
    readState(state.run.id),
    readEvents(state.run.id),
    readMessages(state.run.id),
    readArtifact(state.run.id),
  ]);

  assert.equal(stopped.run.status, 'stopped');
  assert.ok(events.some((event) => event.type === 'control.stopped'));
  assert.ok(!events.some((event) => event.type === 'run.completed'));
  assert.equal(messages.length, 0);
  assert.equal(artifact, '');
}, '0.2'));


test('intervention API starts a new agent answer turn after a completed run', async () => withStateDir(async () => {
  const state = await createRun({ title: 'chat turn', brief: '첫 요청', mode: 'mock' });
  await sendMessage({
    runId: state.run.id,
    from: 'user',
    to: 'all',
    kind: 'user_intervention',
    body: '첫 요청',
  });
  startMockRun(state.run.id);
  await waitForRunStatus(state.run.id, 'completed');

  const response = await postIntervention(new Request(`http://agentboard.test/api/runs/${state.run.id}/interventions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: '두 번째 질문에 답해줘', to: 'all' }),
  }), {
    params: Promise.resolve({ runId: state.run.id }),
  });

  assert.equal(response.status, 200);
  await waitForRunStatus(state.run.id, 'completed');

  const messages = await readMessages(state.run.id);
  const userMessages = messages.filter((message) => message.from === 'user');
  const agentAnswers = messages.filter((message) => message.from === 'reviewer' && message.to === 'user');

  assert.equal(userMessages.at(-1)?.body, '두 번째 질문에 답해줘');
  assert.ok(agentAnswers.at(-1)?.body.includes('두 번째 질문에 답해줘'));
}));

test('intervention API rejects a new prompt while agents are answering', async () => withStateDir(async () => {
  const state = await createRun({ title: 'busy turn', brief: '진행 중 요청', mode: 'mock' });
  startMockRun(state.run.id);
  await waitForRunStatus(state.run.id, 'running');

  const response = await postIntervention(new Request(`http://agentboard.test/api/runs/${state.run.id}/interventions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: '겹쳐 보내면 안 된다', to: 'all' }),
  }), {
    params: Promise.resolve({ runId: state.run.id }),
  });

  assert.equal(response.status, 409);
}, '0.2'));
