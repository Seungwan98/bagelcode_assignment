import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sendMessage } from '../src/lib/bus/message-bus';
import { clearContinuationWatchdog, probeContinuationRun } from '../src/lib/runner/continuation-watchdog';
import {
  createRun,
  readEvents,
  readMessages,
  readState,
  updateContinuationState,
  updateRunStatus,
} from '../src/lib/store/file-store';

async function withStateDir<T>(fn: () => Promise<T>): Promise<T> {
  const previousDir = process.env.AGENTBOARD_STATE_DIR;
  const previousEnabled = process.env.AGENTBOARD_CONTINUATION_ENABLED;
  const dir = await mkdtemp(join(tmpdir(), 'agentboard-continuation-'));
  process.env.AGENTBOARD_STATE_DIR = dir;
  delete process.env.AGENTBOARD_CONTINUATION_ENABLED;
  try {
    return await fn();
  } finally {
    if (previousDir === undefined) delete process.env.AGENTBOARD_STATE_DIR;
    else process.env.AGENTBOARD_STATE_DIR = previousDir;
    if (previousEnabled === undefined) delete process.env.AGENTBOARD_CONTINUATION_ENABLED;
    else process.env.AGENTBOARD_CONTINUATION_ENABLED = previousEnabled;
    await rm(dir, { recursive: true, force: true });
  }
}

async function createIdleRunningRun(): Promise<string> {
  const state = await createRun({ title: 'continuation', brief: '끝날 때까지 계속해줘', mode: 'mock' });
  await sendMessage({
    runId: state.run.id,
    from: 'user',
    to: 'all',
    kind: 'user_intervention',
    body: '끝날 때까지 계속해줘',
  });
  await updateContinuationState(state.run.id, { idleTimeoutMs: 0 });
  await updateRunStatus(state.run.id, 'running');
  return state.run.id;
}

test('continuation watchdog injects a system prompt into an idle incomplete run', async () => withStateDir(async () => {
  const runId = await createIdleRunningRun();
  let restartCount = 0;

  const result = await probeContinuationRun(runId, {
    isRunnerActive: () => false,
    restart: () => {
      restartCount += 1;
    },
  });

  const [state, messages, events] = await Promise.all([
    readState(runId),
    readMessages(runId),
    readEvents(runId),
  ]);

  assert.equal(result.action, 'injected');
  assert.equal(restartCount, 1);
  assert.equal(state.continuation?.iteration, 1);
  assert.ok(messages.some((message) => (
    message.from === 'system'
    && message.to === 'orchestrator'
    && message.kind === 'instruction'
    && message.correlationId === 'continuation:1'
    && /Auto continuation 1\/5/.test(message.body)
  )));
  assert.ok(events.some((event) => event.type === 'continuation.injected'));
}));

test('continuation watchdog does not inject while a runner is active', async () => withStateDir(async () => {
  const runId = await createIdleRunningRun();

  const result = await probeContinuationRun(runId, {
    isRunnerActive: () => true,
    restart: () => assert.fail('active runner should not be restarted'),
  });
  clearContinuationWatchdog(runId);

  const messages = await readMessages(runId);
  assert.equal(result.action, 'runner-active');
  assert.ok(!messages.some((message) => message.correlationId?.startsWith('continuation:')));
}));

test('continuation watchdog marks a run stale after max iterations', async () => withStateDir(async () => {
  const runId = await createIdleRunningRun();
  await updateContinuationState(runId, { iteration: 1, maxIterations: 1, idleTimeoutMs: 0 });

  const result = await probeContinuationRun(runId, {
    isRunnerActive: () => false,
    restart: () => assert.fail('maxed continuation should not restart'),
  });

  const [state, events] = await Promise.all([
    readState(runId),
    readEvents(runId),
  ]);

  assert.equal(result.action, 'max-iterations');
  assert.equal(state.run.status, 'stale');
  assert.match(state.run.staleReason ?? '', /Continuation max iterations reached/);
  assert.ok(events.some((event) => event.type === 'continuation.max_iterations_reached'));
  assert.ok(events.some((event) => event.type === 'run.stale'));
}));

test('continuation watchdog skips terminal runs', async () => withStateDir(async () => {
  const runId = await createIdleRunningRun();
  await updateRunStatus(runId, 'completed');

  const result = await probeContinuationRun(runId, {
    isRunnerActive: () => false,
    restart: () => assert.fail('completed run should not restart'),
  });

  assert.deepEqual(result, { action: 'terminal', status: 'completed' });
}));
