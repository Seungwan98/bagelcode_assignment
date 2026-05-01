import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sendMessage } from '../src/lib/bus/message-bus';
import { getAgentDefinition } from '../src/lib/runner/agent-definitions';
import { buildAgentPrompt, createAgentExecutionContext, runAgentConversation } from '../src/lib/runner/agent-session-runtime';
import { parseOrchestratorPlan, parseOrchestratorVerdict } from '../src/lib/runner/orchestrator-plan';
import { createLinearOrchestratorStrategy } from '../src/lib/runner/orchestrator-strategy';
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

test('agent conversation runtime uses orchestrator plan for assignments and user answer', async () => withStateDir(async () => {
  const state = await createRun({ title: 'runtime emit', brief: '런타임 구조를 설명해줘', mode: 'mock' });
  await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '런타임 구조를 설명해줘' });

  const result = await runAgentConversation({
    state,
    messages: await readMessages(state.run.id),
    invokeAgent: async ({ definition, context }) => {
      if (definition.id === 'orchestrator' && context.orchestratorTask === 'plan') {
        return JSON.stringify({
          strategy: 'dynamic-orchestrator',
          reason: '구조 설명에는 Engineer 검토와 Reviewer 최종 답변이 필요합니다.',
          steps: [
            {
              agent: 'engineer',
              task: '런타임 구조를 기술 관점으로 설명한다.',
              reason: '구조 설명에는 기술적 정리가 필요합니다.',
              expectedOutput: 'Reviewer가 검토할 구조 설명',
            },
            {
              agent: 'reviewer',
              task: 'Engineer 결과를 사용자-facing 답변으로 정리한다.',
              reason: '최종 답변이 필요합니다.',
              expectedOutput: '사용자에게 전달할 답변',
            },
          ],
          finalResponder: 'reviewer',
        });
      }
      if (definition.id === 'orchestrator' && context.orchestratorTask === 'verify') {
        return JSON.stringify({
          status: 'complete',
          reason: '후보 답변이 사용자 목적을 충족합니다.',
          userAnswer: `검증 완료: ${context.candidateAnswer}`,
          nextSteps: [],
        });
      }
      return `${definition.id} output for ${context.userRequest}`;
    },
  });

  const messages = await readMessages(state.run.id);
  assert.equal(result.stopped, false);
  assert.equal(result.outputs.orchestrator?.includes('dynamic-orchestrator'), true);
  assert.equal(result.outputs.planner, undefined);
  assert.equal(result.verificationIterations, 1);
  assert.equal(result.orchestratorVerdicts[0]?.status, 'complete');
  assert.deepEqual(result.orchestratorPlan.steps.map((step) => step.agent), ['engineer', 'reviewer']);
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'engineer' && message.kind === 'instruction'));
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'reviewer' && message.kind === 'instruction'));
  assert.ok(messages.some((message) => message.from === 'engineer' && message.to === 'reviewer' && message.kind === 'result'));
  assert.ok(messages.some((message) => message.from === 'reviewer' && message.to === 'orchestrator' && message.kind === 'review'));
  assert.ok(!messages.some((message) => message.from === 'reviewer' && message.to === 'user' && message.kind === 'result'));
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'orchestrator' && /Orchestrator Verdict: complete/.test(message.body)));
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'user' && message.kind === 'result' && /검증 완료/.test(message.body)));
}));

test('agent conversation runtime loops when orchestrator verdict is incomplete', async () => withStateDir(async () => {
  const previousMax = process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS;
  process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS = '3';
  try {
    const state = await createRun({ title: 'runtime loop', brief: '답변을 보완해줘', mode: 'mock' });
    await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '답변을 보완해줘' });
    let verifyCount = 0;

    const result = await runAgentConversation({
      state,
      messages: await readMessages(state.run.id),
      invokeAgent: async ({ definition, context }) => {
        if (definition.id === 'orchestrator' && context.orchestratorTask === 'plan') {
          return JSON.stringify({
            strategy: 'review-first',
            reason: '초안 리뷰로 충분한지 확인합니다.',
            steps: [
              { agent: 'reviewer', task: '초안 답변을 작성한다.', reason: '사용자-facing 후보가 필요합니다.', expectedOutput: '검증 후보 답변' },
            ],
            finalResponder: 'reviewer',
          });
        }
        if (definition.id === 'orchestrator' && context.orchestratorTask === 'verify') {
          verifyCount += 1;
          if (verifyCount === 1) {
            return JSON.stringify({
              status: 'incomplete',
              reason: '구현 관점이 누락되었습니다.',
              nextSteps: [
                { agent: 'engineer', task: '구현 관점을 보완한다.', reason: '기술 설명이 부족합니다.', expectedOutput: 'Reviewer가 정리할 구현 관점' },
              ],
            });
          }
          return JSON.stringify({
            status: 'complete',
            reason: '보완된 답변이 사용자 목적을 충족합니다.',
            userAnswer: `최종 완료: ${context.candidateAnswer}`,
            nextSteps: [],
          });
        }
        if (definition.id === 'engineer') return '구현 관점 보완 결과';
        if (definition.id === 'reviewer') return context.handoffMessages.some((message) => /구현 관점 보완 결과/.test(message.body))
          ? '구현 관점이 포함된 보완 답변'
          : '초안 답변';
        return `${definition.id} output`;
      },
    });

    const messages = await readMessages(state.run.id);
    assert.equal(result.stopped, false);
    assert.equal(result.verificationIterations, 2);
    assert.deepEqual(result.orchestratorVerdicts.map((verdict) => verdict.status), ['incomplete', 'complete']);
    assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'engineer' && /구현 관점/.test(message.body)));
    assert.ok(messages.some((message) => message.from === 'engineer' && message.to === 'reviewer' && /구현 관점 보완 결과/.test(message.body)));
    assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'orchestrator' && /Orchestrator Verdict: incomplete/.test(message.body)));
    assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'user' && /최종 완료/.test(message.body)));
    assert.ok(!messages.some((message) => message.from === 'reviewer' && message.to === 'user'));
  } finally {
    if (previousMax === undefined) delete process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS;
    else process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS = previousMax;
  }
}));

test('orchestrator parsers tolerate wrapped JSON and expose fallback parse errors', async () => withStateDir(async () => {
  const state = await createRun({ title: 'parser', brief: '파서를 검증해줘', mode: 'mock' });
  const plan = parseOrchestratorPlan([
    '설명 문장이 앞에 있어도',
    JSON.stringify({
      strategy: 'wrapped-json',
      reason: 'JSON object만 추출할 수 있어야 합니다.',
      steps: [
        { agent: 'engineer', task: '파싱을 확인한다.', reason: '검증 필요', expectedOutput: '검증 결과' },
      ],
      finalResponder: 'reviewer',
    }),
    '뒤 설명이 있어도 무시합니다.',
  ].join('\n'), state);
  const verdict = parseOrchestratorVerdict([
    '```json',
    JSON.stringify({
      status: 'complete',
      reason: '후보 답변이 충분합니다.',
      userAnswer: '최종 답변',
      nextSteps: [],
    }),
    '```',
  ].join('\n'), state, '후보 답변');
  const fallbackVerdict = parseOrchestratorVerdict('JSON이 아닌 출력', state, '후보 답변');

  assert.equal(plan.strategy, 'wrapped-json');
  assert.deepEqual(plan.steps.map((step) => step.agent), ['engineer', 'reviewer']);
  assert.equal(verdict.status, 'complete');
  assert.equal(verdict.userAnswer, '최종 답변');
  assert.equal(fallbackVerdict.status, 'complete');
  assert.equal(fallbackVerdict.fallback, true);
  assert.match(fallbackVerdict.parseError ?? '', /JSON object/);
}));

test('agent conversation runtime returns partial answer with risk after max incomplete verdicts', async () => withStateDir(async () => {
  const previousMax = process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS;
  process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS = '1';
  try {
    const state = await createRun({ title: 'runtime max loop', brief: '최대 반복을 확인해줘', mode: 'mock' });
    await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '최대 반복을 확인해줘' });

    const result = await runAgentConversation({
      state,
      messages: await readMessages(state.run.id),
      invokeAgent: async ({ definition, context }) => {
        if (definition.id === 'orchestrator' && context.orchestratorTask === 'plan') {
          return JSON.stringify({
            strategy: 'max-loop',
            reason: '반복 제한을 검증합니다.',
            steps: [
              { agent: 'reviewer', task: '부분 답변을 작성한다.', reason: '후보가 필요합니다.', expectedOutput: '부분 답변' },
            ],
            finalResponder: 'reviewer',
          });
        }
        if (definition.id === 'orchestrator' && context.orchestratorTask === 'verify') {
          return JSON.stringify({
            status: 'incomplete',
            reason: '아직 증거가 부족합니다.',
            nextSteps: [
              { agent: 'engineer', task: '증거를 보강한다.', reason: '검증 증거 부족', expectedOutput: '보강 증거' },
            ],
          });
        }
        return '부분 답변';
      },
    });

    const messages = await readMessages(state.run.id);
    assert.equal(result.verificationIterations, 1);
    assert.equal(result.orchestratorVerdicts[0]?.status, 'incomplete');
    assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'user' && /남은 리스크: 아직 증거가 부족합니다/.test(message.body)));
  } finally {
    if (previousMax === undefined) delete process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS;
    else process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS = previousMax;
  }
}));

test('linear orchestrator strategy keeps canonical order while filtering disabled agents', async () => withStateDir(async () => {
  const state = await createRun({
    title: 'strategy',
    brief: '순서를 확인해줘',
    mode: 'mock',
    agents: ['engineer', 'reviewer'],
  });

  const roles = createLinearOrchestratorStrategy().selectRoles(state);

  assert.deepEqual(roles, ['engineer', 'reviewer']);
}));

test('agent conversation runtime can use injected orchestrator managers', async () => withStateDir(async () => {
  const state = await createRun({ title: 'manager injection', brief: '리뷰만 해줘', mode: 'mock', agents: ['reviewer'] });
  await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '리뷰만 해줘' });

  const emittedMessages: Awaited<ReturnType<typeof readMessages>> = [];
  const prompts: string[] = [];

  const result = await runAgentConversation({
    state,
    messages: await readMessages(state.run.id),
    managers: {
      orchestratorStrategy: {
        id: 'reviewer-only-test',
        selectRoles: () => ['reviewer'],
      },
      promptBuilder: {
        build: (definition, context) => {
          const prompt = `custom prompt for ${definition.id}: ${context.userRequest}`;
          prompts.push(prompt);
          return prompt;
        },
      },
      messageBus: {
        send: async (input) => {
          const message = {
            id: `msg-${emittedMessages.length + 1}`,
            runId: input.runId,
            from: input.from,
            to: input.to,
            kind: input.kind,
            body: input.body,
            correlationId: input.correlationId,
            requiresAck: input.requiresAck,
            createdAt: '2026-05-01T00:00:00.000Z',
            deliveredAt: '2026-05-01T00:00:00.000Z',
          };
          emittedMessages.push(message);
          return message;
        },
      },
    },
    invokeAgent: async ({ definition, prompt }) => `${definition.id} output via ${prompt}`,
  });

  assert.deepEqual(Object.keys(result.outputs), ['reviewer']);
  assert.deepEqual(prompts, ['custom prompt for reviewer: 리뷰만 해줘']);
  assert.equal(emittedMessages.length, 2);
  assert.ok(emittedMessages.some((message) => message.from === 'reviewer' && message.to === 'orchestrator' && message.kind === 'review'));
  assert.ok(emittedMessages.some((message) => message.from === 'reviewer' && message.to === 'user' && message.kind === 'result'));
}));
