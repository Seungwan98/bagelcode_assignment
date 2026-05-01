import { readMessages, readState, updateAgentStatus, updateRunStatus, appendEvent, writeArtifact } from '@/lib/store/file-store';
import { runAgentConversation, type AgentExecutionInput } from '@/lib/runner/agent-session-runtime';
import { clearContinuationWatchdog, scheduleContinuationWatchdog } from '@/lib/runner/continuation-watchdog';
import { createId, nowIso } from '@/lib/utils/ids';

const activeRuns = new Set<string>();
const cancelledRuns = new Set<string>();
const timers = new Map<string, NodeJS.Timeout[]>();

function delayMs(ms: number): number {
  const scale = Number(process.env.AGENTBOARD_MOCK_DELAY_SCALE ?? '1');
  if (!Number.isFinite(scale) || scale < 0) return ms;
  return Math.max(0, Math.round(ms * scale));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs(ms));
    timer.unref?.();
  });
}

function registerTimer(runId: string, timer: NodeJS.Timeout): void {
  const runTimers = timers.get(runId) ?? [];
  runTimers.push(timer);
  timers.set(runId, runTimers);
}

function scheduleMockContinuationIfRunning(runId: string): void {
  void readState(runId)
    .then((state) => {
      if (state.run.status === 'running') {
        scheduleContinuationWatchdog(runId, { isRunnerActive: isMockRunActive, restart: startMockRun });
      }
    })
    .catch(() => undefined);
}

function isMissingRunState(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

async function recordRunFailure(runId: string, error: unknown): Promise<void> {
  if (isMissingRunState(error)) return;
  clearContinuationWatchdog(runId);
  const message = error instanceof Error ? error.message : String(error);
  await appendEvent(runId, {
    id: createId('evt'),
    runId,
    type: 'error',
    actor: 'mock-runner',
    payload: { message },
    createdAt: nowIso(),
  }).catch(() => undefined);
  await updateRunStatus(runId, 'failed').catch(() => undefined);
}

export function stopMockRun(runId: string): void {
  clearContinuationWatchdog(runId);
  cancelledRuns.add(runId);
  for (const timer of timers.get(runId) ?? []) clearTimeout(timer);
  timers.delete(runId);
  activeRuns.delete(runId);
}

export function isMockRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

export function startMockRun(runId: string): void {
  if (activeRuns.has(runId)) return;
  cancelledRuns.delete(runId);
  activeRuns.add(runId);
  scheduleContinuationWatchdog(runId, { isRunnerActive: isMockRunActive, restart: startMockRun });
  const timer = setTimeout(() => {
    void runScript(runId)
      .catch((error) => recordRunFailure(runId, error))
      .finally(() => {
        activeRuns.delete(runId);
        timers.delete(runId);
        scheduleMockContinuationIfRunning(runId);
      });
  }, delayMs(50));
  timer.unref?.();
  registerTimer(runId, timer);
}

async function shouldStop(runId: string): Promise<boolean> {
  if (cancelledRuns.has(runId)) return true;
  try {
    return (await readState(runId)).run.status === 'stopped';
  } catch {
    return true;
  }
}

function mockOutput(input: AgentExecutionInput): string {
  if (input.definition.id === 'orchestrator') {
    if (input.context.orchestratorTask === 'verify') {
      return JSON.stringify({
        status: 'complete',
        reason: 'Mock Orchestrator가 후보 답변이 사용자 목적을 충족한다고 판단했습니다.',
        userAnswer: [
          '요청하신 내용에 대해 Orchestrator가 Sub-agent 결과를 검증했고 완료로 판단했습니다.',
          '',
          `요청: ${input.context.userRequest}`,
          '',
          input.context.candidateAnswer ?? '후보 답변이 비어 있습니다.',
        ].join('\n'),
        nextSteps: [],
      });
    }
    const request = input.context.userRequest;
    const needsPlan = /계획|플랜|plan|설계|아키텍처|architecture|구조|요구사항|스펙|spec/i.test(request);
    const needsEngineering = /구현|수정|추가|개발|코드|버그|오류|에러|설정|반영|config|adapter|runtime|프롬프트|prompt/i.test(request);
    if (needsPlan) {
      return JSON.stringify({
        strategy: 'dynamic-orchestrator',
        reason: '요청에 계획, 설계, 구조 판단이 포함되어 Planner, Engineer, Reviewer 순서가 필요합니다.',
        steps: [
          {
            agent: 'planner',
            task: '사용자 요청의 의도와 산출물을 정리하고 실행 가능한 계획으로 나눈다.',
            reason: '요구사항과 방향 정리가 필요합니다.',
            expectedOutput: 'Engineer가 활용할 수 있는 계획과 제약 사항',
          },
          {
            agent: 'engineer',
            task: 'Planner 계획을 바탕으로 구체적인 구현 방향과 검증 관점을 작성한다.',
            reason: '기술적 실행 방법이 필요합니다.',
            expectedOutput: 'Reviewer가 검토할 구현 관점과 테스트 포인트',
          },
          {
            agent: 'reviewer',
            task: '앞선 결과를 검토하고 사용자에게 보여줄 최종 답변을 작성한다.',
            reason: '최종 사용자-facing 답변이 필요합니다.',
            expectedOutput: '사용자에게 전달할 최종 답변',
          },
        ],
        finalResponder: 'reviewer',
      });
    }
    if (needsEngineering) {
      return JSON.stringify({
        strategy: 'dynamic-orchestrator',
        reason: '요청이 기술 구현 또는 설정 변경에 해당하므로 Engineer와 Reviewer가 필요합니다.',
        steps: [
          {
            agent: 'engineer',
            task: '사용자 요청을 구현 또는 설정 관점에서 구체화한다.',
            reason: '기술적 판단과 실행 방향이 필요합니다.',
            expectedOutput: 'Reviewer가 검토할 구현 방향과 검증 관점',
          },
          {
            agent: 'reviewer',
            task: 'Engineer 결과를 검토하고 사용자에게 보여줄 최종 답변을 작성한다.',
            reason: '최종 답변의 정확성과 누락 여부를 확인해야 합니다.',
            expectedOutput: '사용자에게 전달할 최종 답변',
          },
        ],
        finalResponder: 'reviewer',
      });
    }
    return JSON.stringify({
      strategy: 'dynamic-orchestrator',
      reason: '단순 질문으로 분류되어 Reviewer가 바로 최종 답변을 만들 수 있습니다.',
      steps: [
        {
          agent: 'reviewer',
          task: '사용자 질문에 직접 답할 수 있도록 최종 답변을 작성한다.',
          reason: '계획 수립이나 구현 검토가 필요하지 않습니다.',
          expectedOutput: '사용자에게 보여줄 간결한 답변',
        },
      ],
      finalResponder: 'reviewer',
    });
  }
  if (input.definition.id === 'planner') {
    return [
      '사용자 요청을 분석했습니다.',
      `요청: ${input.context.userRequest}`,
      'Engineer는 이 요청을 구현 가능성, 사용자-facing 답변, 검증 관점으로 나누어 정리해야 합니다.',
    ].join('\n');
  }
  if (input.definition.id === 'engineer') {
    return [
      'Planner 전달 내용을 구현 관점으로 정리했습니다.',
      `핵심 요구: ${input.context.userRequest}`,
      '현재 AgentBoard runtime은 Orchestrator가 배정한 업무와 저장된 메시지 이력을 다음 Agent prompt context로 주입해 Agent 간 대화 증거를 유지합니다.',
    ].join('\n');
  }
  return [
    '요청하신 내용에 대해 Orchestrator가 필요한 Agent를 배정했고, 선택된 Agent들이 검토했습니다.',
    '',
    `요청: ${input.context.userRequest}`,
    '',
    '답변: AgentBoard는 Orchestrator가 요청을 분석해 필요한 Agent만 선택하고, 각 Agent에게 업무 지시를 message bus로 전달합니다. Codex stdout은 Agent 자체의 세션이 아니라 adapter 실행 결과이며, 실제 대화 이력은 AgentBoard가 관리합니다. 자세한 Agent 간 전달 과정은 Logs에서 확인할 수 있습니다.',
  ].join('\n');
}

async function runScript(runId: string): Promise<void> {
  await updateRunStatus(runId, 'running');
  await appendEvent(runId, {
    id: createId('evt'),
    runId,
    type: 'run.started',
    actor: 'system',
    payload: { mode: 'mock' },
    createdAt: nowIso(),
  });

  const state = await readState(runId);
  for (const agent of state.agents) {
    await appendEvent(runId, {
      id: createId('evt'),
      runId,
      type: 'agent.started',
      actor: agent.id,
      payload: { role: agent.role, adapter: agent.adapter },
      createdAt: nowIso(),
    });
  }

  const result = await runAgentConversation({
    state,
    messages: await readMessages(runId),
    shouldStop: () => shouldStop(runId),
    invokeAgent: async (execution) => {
      await updateAgentStatus(runId, execution.definition.id, 'thinking');
      await sleep(execution.definition.id === 'reviewer' ? 2500 : 900);
      return mockOutput(execution);
    },
  });
  if (result.stopped) return;

  const interventions = (await readMessages(runId)).filter((message) => message.kind === 'user_intervention');
  const interventionSummary = interventions.length
    ? interventions.map((message, index) => `${index + 1}. ${message.body}`).join('\n')
    : '사용자 개입 없음';

  const verdictSummary = result.orchestratorVerdicts.length
    ? result.orchestratorVerdicts.map((verdict, index) => `${index + 1}. ${verdict.status}: ${verdict.reason}`).join('\n')
    : 'Orchestrator 검증 없음';

  const finalReport = `# AgentBoard Mock Collaboration Report\n\n## Run\n\n- Run ID: ${runId}\n- Mode: mock\n- Latest User Request: ${result.context.userRequest}\n- Turn User Message ID: ${result.context.turnUserMessageId}\n- Verification Iterations: ${result.verificationIterations}\n\n## Orchestrator Plan\n\n${result.orchestratorPlan.steps.map((step, index) => `${index + 1}. ${step.agent}: ${step.task}`).join('\n')}\n\n## Orchestrator Verdicts\n\n${verdictSummary}\n\n## Agent Collaboration Evidence\n\n- Orchestrator → Agent: 선택된 Agent별 업무 지시 전달\n- Agent → Agent: 필요한 경우 다음 Agent에게 결과 handoff 전달\n- Final Responder → Orchestrator: 후보 답변 전달\n- Orchestrator → Orchestrator: 사용자 목적 충족 여부 검증\n- Orchestrator → User: 검증 완료 후 사용자-facing 답변 생성\n\n## Conversation Requests\n\n${interventionSummary}\n\n## Final Decision\n\nAgentBoard MVP는 Codex stdout을 직접 Agent 간 통신으로 보지 않고, Orchestrator plan, AgentBoard message bus, session context 주입, Orchestrator 검증 루프를 통해 Agent 팀의 대화와 답변을 구성한다.\n`;
  if (await shouldStop(runId)) return;
  await writeArtifact(runId, finalReport, 'reviewer');

  if (await shouldStop(runId)) return;
  for (const role of Object.keys(result.outputs)) {
    await updateAgentStatus(runId, role, 'done');
  }
  await updateRunStatus(runId, 'completed');
  await appendEvent(runId, {
    id: createId('evt'),
    runId,
    type: 'run.completed',
    actor: 'system',
    payload: { artifact: 'final-report.md', interventions: interventions.length },
    createdAt: nowIso(),
  });
  clearContinuationWatchdog(runId);
}
