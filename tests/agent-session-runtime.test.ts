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
import { createRun, readEvents, readMessages, readState } from '../src/lib/store/file-store';

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

test('reviewer prompt is constrained to quality review instead of final response', async () => withStateDir(async () => {
  const state = await createRun({ title: 'reviewer prompt', brief: '검토해줘', mode: 'mock' });
  await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: 'Engineer 결과를 검토해줘' });

  const context = createAgentExecutionContext(state, await readMessages(state.run.id));
  const prompt = buildAgentPrompt(getAgentDefinition('reviewer'), context);

  assert.match(prompt, /품질 검토 리포트만 작성/);
  assert.match(prompt, /사용자에게 직접 전달할 최종 답변을 작성하지 않는다/);
  assert.match(prompt, /Orchestrator가 최종 답변에 반영할 권고/);
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
              task: 'Engineer 결과의 누락과 위험을 검토한다.',
              reason: '최종 답변 전 품질 점검이 필요합니다.',
              expectedOutput: '품질 검토 리포트',
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
    assert.ok(messages.some((message) => message.from === 'engineer' && message.to === 'orchestrator' && message.kind === 'result' && /구현 관점 보완 결과/.test(message.body)));
    assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'orchestrator' && /Orchestrator Verdict: incomplete/.test(message.body)));
    assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'user' && /최종 완료/.test(message.body)));
    assert.ok(!messages.some((message) => message.from === 'reviewer' && message.to === 'user'));
  } finally {
    if (previousMax === undefined) delete process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS;
    else process.env.AGENTBOARD_ORCHESTRATOR_MAX_VERIFICATION_ITERATIONS = previousMax;
  }
}));

test('agent conversation runtime lets orchestrator continue with a running user intervention', async () => withStateDir(async () => {
  const state = await createRun({ title: 'runtime intervention', brief: '기본 답변을 만들어줘', mode: 'mock' });
  await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '기본 답변을 만들어줘' });

  const result = await runAgentConversation({
    state,
    messages: await readMessages(state.run.id),
    invokeAgent: async ({ definition, context }) => {
      if (definition.id === 'orchestrator' && context.orchestratorTask === 'plan') {
        return JSON.stringify({
          strategy: 'engineer-reviewer',
          reason: 'Engineer와 Reviewer가 필요합니다.',
          steps: [
            { agent: 'engineer', task: '초안을 만든다.', reason: '기술 초안 필요', expectedOutput: '초안' },
            { agent: 'reviewer', task: '초안의 누락과 위험을 검토한다.', reason: '최종 답변 전 품질 점검 필요', expectedOutput: '품질 검토 리포트' },
          ],
          finalResponder: 'reviewer',
        });
      }
      if (definition.id === 'engineer') {
        await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '모바일 조건도 추가해줘' });
        return 'engineer output';
      }
      if (definition.id === 'orchestrator' && context.orchestratorTask === 'intervention') {
        assert.equal(context.pendingInterventions?.at(-1)?.body, '모바일 조건도 추가해줘');
        return JSON.stringify({
          action: 'continue',
          reason: '추가 조건으로 반영하면 충분합니다.',
          instruction: '모바일 조건을 최종 답변에 포함한다.',
        });
      }
      if (definition.id === 'orchestrator' && context.orchestratorTask === 'verify') {
        return JSON.stringify({
          status: 'complete',
          reason: '개입이 반영되었습니다.',
          userAnswer: context.candidateAnswer,
          nextSteps: [],
        });
      }
      if (definition.id === 'reviewer') {
        return context.handoffMessages.some((message) => /모바일 조건을 최종 답변에 포함/.test(message.body))
          ? '모바일 조건을 반영한 최종 답변'
          : '개입 누락 답변';
      }
      return `${definition.id} output`;
    },
  });

  const [messages, events] = await Promise.all([readMessages(state.run.id), readEvents(state.run.id)]);
  assert.equal(result.stopped, false);
  assert.equal(result.userAnswer, '모바일 조건을 반영한 최종 답변');
  assert.ok(events.some((event) => event.type === 'intervention.decision_made' && event.payload.action === 'continue'));
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'reviewer' && /Orchestrator Intervention Decision: continue/.test(message.body)));
}));

test('agent conversation runtime pauses and asks user when intervention intent is ambiguous', async () => withStateDir(async () => {
  const state = await createRun({ title: 'runtime ask user', brief: '답변을 만들어줘', mode: 'mock' });
  await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '답변을 만들어줘' });

  const result = await runAgentConversation({
    state,
    messages: await readMessages(state.run.id),
    invokeAgent: async ({ definition, context }) => {
      if (definition.id === 'orchestrator' && context.orchestratorTask === 'plan') {
        return JSON.stringify({
          strategy: 'reviewer-only',
          reason: 'Engineer 후보를 Orchestrator가 최종화하면 충분합니다.',
          steps: [
            { agent: 'engineer', task: '답변 후보를 작성한다.', reason: '간단한 답변 후보가 필요합니다.', expectedOutput: '답변 후보' },
          ],
          finalResponder: 'engineer',
        });
      }
      if (definition.id === 'engineer') {
        await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '다른 방향도 봐줘' });
        return '기존 방향 답변';
      }
      if (definition.id === 'orchestrator' && context.orchestratorTask === 'intervention') {
        return JSON.stringify({
          action: 'ask_user',
          reason: '다른 방향의 의미가 모호합니다.',
          question: '현재 작업을 중단할까요, 아니면 대안 비교를 추가할까요?',
        });
      }
      return JSON.stringify({ status: 'complete', reason: 'unused', userAnswer: 'unused', nextSteps: [] });
    },
  });

  const [pausedState, messages, events] = await Promise.all([
    readState(state.run.id),
    readMessages(state.run.id),
    readEvents(state.run.id),
  ]);
  assert.equal(result.stopped, true);
  assert.equal(pausedState.run.status, 'paused');
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'user' && message.kind === 'question'));
  assert.ok(events.some((event) => event.type === 'intervention.decision_made' && event.payload.action === 'ask_user'));
}));

test('agent conversation runtime replans when orchestrator restarts after intervention', async () => withStateDir(async () => {
  const state = await createRun({ title: 'runtime restart', brief: '간단히 답해줘', mode: 'mock' });
  await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '간단히 답해줘' });
  let planCount = 0;

  const result = await runAgentConversation({
    state,
    messages: await readMessages(state.run.id),
    invokeAgent: async ({ definition, context }) => {
      if (definition.id === 'orchestrator' && context.orchestratorTask === 'plan') {
        planCount += 1;
        if (planCount === 1) {
          return JSON.stringify({
            strategy: 'engineer-only',
            reason: '처음에는 단순 답변으로 판단했습니다.',
            steps: [
              { agent: 'engineer', task: '짧은 답변 후보를 작성한다.', reason: '단순 요청', expectedOutput: '짧은 답변 후보' },
            ],
            finalResponder: 'engineer',
          });
        }
        assert.equal(context.userRequest, '구현 관점으로 다시 계획한다.');
        return JSON.stringify({
          strategy: 'restart-with-engineer',
          reason: '개입으로 구현 관점이 필요해졌습니다.',
          steps: [
            { agent: 'engineer', task: '구현 관점을 정리한다.', reason: '기술 검토 필요', expectedOutput: '구현 관점' },
            { agent: 'reviewer', task: '구현 관점의 누락과 위험을 검토한다.', reason: '최종 답변 전 품질 점검 필요', expectedOutput: '품질 검토 리포트' },
          ],
          finalResponder: 'reviewer',
        });
      }
      if (definition.id === 'engineer' && planCount === 1) {
        await sendMessage({ runId: state.run.id, from: 'user', to: 'all', kind: 'user_intervention', body: '처음부터 구현 관점으로 다시 해줘' });
        return '짧은 답변';
      }
      if (definition.id === 'orchestrator' && context.orchestratorTask === 'intervention') {
        return JSON.stringify({
          action: 'restart',
          reason: '현재 방향과 충돌합니다.',
          instruction: '구현 관점으로 다시 계획한다.',
        });
      }
      if (definition.id === 'engineer') return '구현 관점';
      if (definition.id === 'reviewer') return '구현 관점 품질 검토 리포트';
      if (definition.id === 'orchestrator' && context.orchestratorTask === 'verify') {
        return JSON.stringify({
          status: 'complete',
          reason: '재시작된 답변이 목적을 충족합니다.',
          userAnswer: context.candidateAnswer,
          nextSteps: [],
        });
      }
      return `${definition.id} output`;
    },
  });

  const events = await readEvents(state.run.id);
  assert.equal(result.stopped, false);
  assert.equal(planCount, 2);
  assert.deepEqual(result.orchestratorPlan.steps.map((step) => step.agent), ['engineer', 'reviewer']);
  assert.equal(result.userAnswer, '구현 관점 품질 검토 리포트');
  assert.ok(events.some((event) => event.type === 'intervention.decision_made' && event.payload.action === 'restart'));
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
  const engineerOnlyPlan = parseOrchestratorPlan(JSON.stringify({
    strategy: 'engineer-only',
    reason: '기술 답변은 Engineer 결과를 Orchestrator가 최종화합니다.',
    steps: [
      { agent: 'engineer', task: '핵심 답변을 작성한다.', reason: '기술 관점이 필요합니다.', expectedOutput: '답변 후보' },
    ],
  }), state);
  const hardWrappedPlan = parseOrchestratorPlan([
    '{',
    '  "strategy": "dynamic-orchestrator",',
    '  "reason": "현재 사용자 요청은 단순한 인사이며 요구사항 정리나 기술 구현이 필요',
    '  하지 않으므로 최종 응답만 만들면 됩니다.",',
    '  "steps": [',
    '    {',
    '      "agent": "engineer",',
    '      "task": "사용자의 간단한 인사에 자연스럽고 짧게 응답할 후보를 작성한다.",',
    '      "reason": "요청이 단순하여 Planner나 Engineer의 분석 및 구현 작업이 필요하지',
    '      않다.",',
    '      "expectedOutput": "Orchestrator가 검증할 간단한 인사 응답 후보"',
    '    }',
    '  ],',
    '  "finalResponder": "engineer"',
    '}',
  ].join('\n'), state);

  assert.equal(plan.strategy, 'wrapped-json');
  assert.deepEqual(plan.steps.map((step) => step.agent), ['engineer', 'reviewer']);
  assert.deepEqual(engineerOnlyPlan.steps.map((step) => step.agent), ['engineer']);
  assert.equal(engineerOnlyPlan.finalResponder, 'engineer');
  assert.equal(hardWrappedPlan.strategy, 'dynamic-orchestrator');
  assert.deepEqual(hardWrappedPlan.steps.map((step) => step.agent), ['engineer']);
  assert.match(hardWrappedPlan.reason, /기술 구현이 필요 하지 않으므로/);
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
