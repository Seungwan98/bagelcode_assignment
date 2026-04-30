import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sendMessage } from '../src/lib/bus/message-bus';
import { getAgentDefinition } from '../src/lib/runner/agent-definitions';
import { buildAgentPrompt, createAgentExecutionContext, runAgentConversation } from '../src/lib/runner/agent-session-runtime';
import { createRun, readMessages } from '../src/lib/store/file-store';

async function withStateDir<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENTBOARD_STATE_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'agentboard-runtime-state-'));
  process.env.AGENTBOARD_STATE_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.AGENTBOARD_STATE_DIR;
    else process.env.AGENTBOARD_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test('agent execution context uses the latest user turn and current handoffs', async () => withStateDir(async () => {
  const state = await createRun({ title: 'runtime', brief: '초기 요청', mode: 'mock' });
  await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '첫 요청' });
  await sendMessage({ runId: state.run.id, from: 'planner', to: 'engineer', kind: 'instruction', body: '오래된 handoff' });
  const latest = await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '최신 요청' });
  await sendMessage({ runId: state.run.id, from: 'planner', to: 'engineer', kind: 'instruction', body: '최신 handoff' });

  const context = createAgentExecutionContext(state, await readMessages(state.run.id));
  const prompt = buildAgentPrompt(getAgentDefinition('engineer'), context);

  assert.equal(context.turnUserMessageId, latest.id);
  assert.equal(context.userRequest, '최신 요청');
  assert.equal(context.handoffMessages.length, 1);
  assert.match(prompt, /최신 요청/);
  assert.match(prompt, /최신 handoff/);
  assert.doesNotMatch(prompt, /오래된 handoff/);
}));

test('agent conversation runtime emits fixed agent handoffs and user answer', async () => withStateDir(async () => {
  const state = await createRun({ title: 'runtime emit', brief: '런타임 구조를 설명해줘', mode: 'mock' });
  await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '런타임 구조를 설명해줘' });

  const result = await runAgentConversation({
    state,
    messages: await readMessages(state.run.id),
    invokeAgent: async ({ definition, context }) => `${definition.id} output for ${context.userRequest}`,
  });

  const messages = await readMessages(state.run.id);
  assert.equal(result.stopped, false);
  assert.equal(result.outputs.planner, 'planner output for 런타임 구조를 설명해줘');
  assert.ok(messages.some((message) => message.from === 'planner' && message.to === 'engineer' && message.kind === 'instruction'));
  assert.ok(messages.some((message) => message.from === 'engineer' && message.to === 'reviewer' && message.kind === 'result'));
  assert.ok(messages.some((message) => message.from === 'reviewer' && message.to === 'planner' && message.kind === 'review'));
  assert.ok(messages.some((message) => message.from === 'reviewer' && message.to === 'user' && message.kind === 'result'));
}));
