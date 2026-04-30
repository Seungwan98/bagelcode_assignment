import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sendMessage } from '../src/lib/bus/message-bus';
import { startMockRun } from '../src/lib/runner/mock-runner';
import { createRun, readArtifact, readMessages, readState } from '../src/lib/store/file-store';

async function withStateDir<T>(fn: () => Promise<T>): Promise<T> {
  const previousDir = process.env.AGENTBOARD_STATE_DIR;
  const previousScale = process.env.AGENTBOARD_MOCK_DELAY_SCALE;
  const dir = await mkdtemp(join(tmpdir(), 'agentboard-state-'));
  process.env.AGENTBOARD_STATE_DIR = dir;
  process.env.AGENTBOARD_MOCK_DELAY_SCALE = '0';
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

async function waitForCompletedRun(runId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await readState(runId);
    if (state.run.status === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('mock run did not complete within timeout');
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
  await waitForCompletedRun(state.run.id);

  const [completed, messages, artifact] = await Promise.all([
    readState(state.run.id),
    readMessages(state.run.id),
    readArtifact(state.run.id),
  ]);

  assert.equal(completed.run.status, 'completed');
  assert.ok(messages.some((message) => message.from === 'planner' && message.to === 'engineer'));
  assert.ok(messages.some((message) => message.from === 'engineer' && message.to === 'reviewer'));
  assert.ok(messages.some((message) => message.from === 'reviewer' && message.to === 'planner'));
  assert.match(artifact, /README 실행성을 최우선으로 반영해줘/);
}));
