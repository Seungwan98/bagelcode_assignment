import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sendMessage } from '../src/lib/bus/message-bus';
import { createRun, readEvents, readMessages } from '../src/lib/store/file-store';

async function withStateDir<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENTBOARD_STATE_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'agentboard-state-'));
  process.env.AGENTBOARD_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.AGENTBOARD_STATE_DIR;
    else process.env.AGENTBOARD_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('message bus stores agent-to-agent message and delivery events', async () => withStateDir(async () => {
  const state = await createRun({ title: 'test', brief: 'brief', mode: 'mock' });
  const message = await sendMessage({
    runId: state.run.id,
    from: 'planner',
    to: 'engineer',
    kind: 'instruction',
    body: 'MVP 구조를 작성해줘',
  });

  const messages = await readMessages(state.run.id);
  const events = await readEvents(state.run.id);
  assert.equal(messages.at(-1)?.id, message.id);
  assert.equal(messages.at(-1)?.to, 'engineer');
  assert.ok(events.some((event) => event.type === 'message.sent'));
  assert.ok(events.some((event) => event.type === 'message.delivered'));
}));

test('user intervention is persisted as a first-class message event', async () => withStateDir(async () => {
  const state = await createRun({ title: 'test', brief: 'brief', mode: 'mock' });
  const message = await sendMessage({
    runId: state.run.id,
    from: 'user',
    to: 'engineer',
    kind: 'user_intervention',
    body: 'README 실행성을 우선해줘',
  });

  const messages = await readMessages(state.run.id);
  const events = await readEvents(state.run.id);
  assert.equal(messages.at(-1)?.id, message.id);
  assert.ok(events.some((event) => event.type === 'user.intervened'));
}));
