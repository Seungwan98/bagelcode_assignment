import { readMessages, readState, updateAgentStatus, updateRunStatus, appendEvent, writeArtifact } from '@/lib/store/file-store';
import { runAgentConversation, type AgentExecutionInput } from '@/lib/runner/agent-session-runtime';
import { inferDeliverableType } from '@/lib/runner/orchestrator-plan';
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
      const latestEngineer = [...input.context.handoffMessages].reverse().find((message) => message.from === 'engineer')?.body;
      const latestReview = [...input.context.handoffMessages].reverse().find((message) => message.from === 'reviewer')?.body;
      const answerSource = latestEngineer ?? input.context.candidateAnswer ?? '후보 결과가 비어 있습니다.';
      return JSON.stringify({
        status: 'complete',
        reason: 'Mock Orchestrator가 후보 답변이 사용자 목적을 충족한다고 판단했습니다.',
        userAnswer: [
          '요청하신 내용에 대해 Orchestrator가 Sub-agent 결과를 검증하고 최종 답변으로 정리했습니다.',
          '',
          `요청: ${input.context.userRequest}`,
          '',
          answerSource,
          latestReview ? '' : undefined,
          latestReview ? `검토 결과: ${latestReview}` : undefined,
        ].filter((line): line is string => line !== undefined).join('\n'),
        nextSteps: [],
      });
    }
    if (input.context.orchestratorTask === 'intervention') {
      const pending = input.context.pendingInterventions?.map((message) => message.body).join('\n') ?? '';
      if (/중단|취소|처음부터|다시|restart|새로/i.test(pending)) {
        return JSON.stringify({
          action: 'restart',
          reason: '진행 중 사용자 개입이 현재 작업 방향 변경을 요구한다고 판단했습니다.',
          instruction: pending,
        });
      }
      if (/확인|선택|어떻게|애매|모호/i.test(pending)) {
        return JSON.stringify({
          action: 'ask_user',
          reason: '진행 중 사용자 개입의 의도를 자동으로 판단하기 어렵습니다.',
          question: '현재 작업을 중단하고 새 방향으로 갈까요, 아니면 기존 결과에 추가 조건으로 반영할까요?',
        });
      }
      return JSON.stringify({
        action: 'continue',
        reason: '진행 중 사용자 개입을 현재 flow의 추가 조건으로 반영할 수 있습니다.',
        instruction: pending,
      });
    }
    const request = input.context.userRequest;
    const needsPlan = /계획|플랜|plan|설계|아키텍처|architecture|구조|요구사항|스펙|spec/i.test(request);
    const needsEngineering = /구현|수정|추가|개발|코드|버그|오류|에러|설정|반영|config|adapter|runtime|프롬프트|prompt/i.test(request);
    const needsReview = /검토|리뷰|확인|맞는지|위험|리스크|review|qa/i.test(request);
    const deliverableType = inferDeliverableType(request);
    if (needsPlan) {
      return JSON.stringify({
        strategy: 'dynamic-orchestrator',
        reason: '요청에 계획, 설계, 구조 판단이 포함되어 Planner, Engineer, Reviewer 품질 게이트가 필요합니다.',
        deliverableType,
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
            expectedOutput: 'Orchestrator가 검증할 구현 관점과 테스트 포인트',
          },
          {
            agent: 'reviewer',
            task: 'Planner와 Engineer 결과의 정확성, 누락, 리스크를 검토한다.',
            reason: '최종 답변 전 품질 게이트가 필요합니다.',
            expectedOutput: 'Orchestrator가 최종 답변에 반영할 품질 검토 리포트',
          },
        ],
        finalResponder: 'reviewer',
      });
    }
    if (needsEngineering) {
      const steps = [
        {
          agent: 'engineer',
          task: '사용자 요청을 구현 또는 설정 관점에서 구체화한다.',
          reason: '기술적 판단과 실행 방향이 필요합니다.',
          expectedOutput: 'Orchestrator가 검증할 구현 방향과 검증 관점',
        },
      ];
      if (needsReview) {
        steps.push({
          agent: 'reviewer',
          task: 'Engineer 결과의 누락, 위험, 사용자 요구 충족 여부를 검토한다.',
          reason: '사용자가 검토 관점을 요청했거나 품질 점검이 필요합니다.',
          expectedOutput: 'Orchestrator가 최종 답변에 반영할 품질 검토 리포트',
        });
      }
      return JSON.stringify({
        strategy: 'dynamic-orchestrator',
        reason: needsReview
          ? '요청이 기술 구현 또는 설정 변경이며 검토 관점도 필요하므로 Engineer 뒤에 Reviewer 품질 게이트를 둡니다.'
          : '요청이 기술 구현 또는 설정 변경에 해당하므로 Engineer 결과를 Orchestrator가 최종화합니다.',
        deliverableType,
        steps,
        finalResponder: needsReview ? 'reviewer' : 'engineer',
      });
    }
    if (needsReview) {
      return JSON.stringify({
        strategy: 'dynamic-orchestrator',
        reason: '사용자가 검토를 요청했으므로 Reviewer가 품질 리포트를 작성하고 Orchestrator가 최종 답변을 정리합니다.',
        deliverableType: 'answer',
        steps: [
          {
            agent: 'reviewer',
            task: '사용자 요청과 대화 맥락을 기준으로 검토 의견을 작성한다.',
            reason: '명시적인 검토 요청입니다.',
            expectedOutput: 'Orchestrator가 최종 답변에 반영할 품질 검토 리포트',
          },
        ],
        finalResponder: 'reviewer',
      });
    }
    return JSON.stringify({
      strategy: 'dynamic-orchestrator',
      reason: '단순 질문으로 분류되어 Engineer 결과를 Orchestrator가 최종 답변으로 정리합니다.',
      deliverableType: 'answer',
      steps: [
        {
          agent: 'engineer',
          task: '사용자 질문에 답할 수 있는 핵심 내용을 간결하게 정리한다.',
          reason: '계획 수립이나 별도 리뷰가 필요하지 않습니다.',
          expectedOutput: 'Orchestrator가 검증할 간결한 답변 후보',
        },
      ],
      finalResponder: 'engineer',
    });
  }
  if (input.definition.id === 'planner') {
    return [
      '사용자 요청을 분석했습니다.',
      `요청: ${input.context.userRequest}`,
      'Engineer는 이 요청을 구현 가능성, Orchestrator 최종 답변 후보, 검증 관점으로 나누어 정리해야 합니다.',
    ].join('\n');
  }
  if (input.definition.id === 'engineer') {
    const lines = [
      'Planner 전달 내용을 구현 관점으로 정리했습니다.',
      `핵심 요구: ${input.context.userRequest}`,
      '현재 AgentBoard runtime은 Orchestrator가 배정한 업무와 저장된 메시지 이력을 다음 Agent prompt context로 주입해 Agent 간 대화 증거를 유지합니다.',
    ];
    if (input.context.deliverableType === 'implementation') {
      lines.push(
        '',
        'changedFiles:',
        `- ${input.context.implementationWorkspace ?? `.agentboard/workspaces/${input.context.runId}`}/mock-implementation.md`,
        'commandsRun:',
        '- mock implementation validation',
        'testResults:',
        '- passed: mock mode implementation evidence recorded',
        'remainingRisks:',
        '- mock mode는 실제 파일을 쓰지 않고 협업 흐름 증거만 시뮬레이션합니다.',
      );
    }
    return lines.join('\n');
  }
  return [
    '판정: 승인 가능',
    '충족한 점: Orchestrator가 필요한 Agent를 배정했고, AgentBoard message bus에 handoff가 남습니다.',
    '누락/위험: 실제 외부 CLI adapter에서는 timeout, 권한 요청, JSON parse 실패가 발생할 수 있습니다.',
    '권고: Orchestrator 최종 답변에는 adapter 출력이 직접 통신 채널이 아니라 runtime이 저장한 결과라는 점을 포함하세요.',
  ].join('\n');
}

async function runScript(runId: string): Promise<void> {
  const initialMessages = await readMessages(runId);
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
    messages: initialMessages,
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

  const finalReport = `# AgentBoard Mock Collaboration Report\n\n## Run\n\n- Run ID: ${runId}\n- Mode: mock\n- Latest User Request: ${result.context.userRequest}\n- Turn User Message ID: ${result.context.turnUserMessageId}\n- Verification Iterations: ${result.verificationIterations}\n\n## Orchestrator Plan\n\n${result.orchestratorPlan.steps.map((step, index) => `${index + 1}. ${step.agent}: ${step.task}`).join('\n')}\n\n## Orchestrator Verdicts\n\n${verdictSummary}\n\n## Agent Collaboration Evidence\n\n- Orchestrator → Agent: 선택된 Agent별 업무 지시 전달\n- Agent → Agent: 필요한 경우 다음 Agent에게 결과 handoff 전달\n- Verification Candidate Provider → Orchestrator: 후보 결과 또는 품질 검토 리포트 전달\n- Orchestrator → Orchestrator: 사용자 목적 충족 여부 검증\n- Orchestrator → User: 검증 완료 후 사용자-facing 답변 생성\n\n## Conversation Requests\n\n${interventionSummary}\n\n## Final Decision\n\nAgentBoard MVP는 Codex stdout을 직접 Agent 간 통신으로 보지 않고, Orchestrator plan, AgentBoard message bus, session context 주입, Orchestrator 검증 루프를 통해 Agent 팀의 대화와 답변을 구성한다.\n`;
  if (await shouldStop(runId)) return;
  await writeArtifact(runId, finalReport, 'orchestrator');

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
