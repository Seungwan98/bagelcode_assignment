import { readMessages, readState, updateAgentStatus, updateRunStatus, appendEvent, writeArtifact } from '@/lib/store/file-store';
import { runAgentConversation, type AgentExecutionInput } from '@/lib/runner/agent-session-runtime';
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

export function stopMockRun(runId: string): void {
  cancelledRuns.add(runId);
  for (const timer of timers.get(runId) ?? []) clearTimeout(timer);
  timers.delete(runId);
  activeRuns.delete(runId);
}

export function startMockRun(runId: string): void {
  if (activeRuns.has(runId)) return;
  cancelledRuns.delete(runId);
  activeRuns.add(runId);
  const timer = setTimeout(() => {
    void runScript(runId).finally(() => {
      activeRuns.delete(runId);
      timers.delete(runId);
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
      '현재 AgentBoard runtime은 저장된 메시지 이력을 다음 Agent prompt context로 주입해 Agent 간 대화 증거를 유지합니다.',
    ].join('\n');
  }
  return [
    '요청하신 내용에 대해 Planner, Engineer, Reviewer가 검토했습니다.',
    '',
    `요청: ${input.context.userRequest}`,
    '',
    '답변: AgentBoard는 Agent 간 전달 메시지를 message bus에 저장하고, 저장된 session context를 다음 Agent prompt에 주입하는 방식으로 협업을 증명합니다. Codex stdout은 Agent 자체의 세션이 아니라 adapter 실행 결과이며, 실제 대화 이력은 AgentBoard가 관리합니다. 자세한 Agent 간 전달 과정은 Logs에서 확인할 수 있습니다.',
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

  const finalReport = `# AgentBoard Mock Collaboration Report\n\n## Run\n\n- Run ID: ${runId}\n- Mode: mock\n- Latest User Request: ${result.context.userRequest}\n- Turn User Message ID: ${result.context.turnUserMessageId}\n\n## Agent Collaboration Evidence\n\n- Planner → Engineer: session context 기반 instruction 전달\n- Engineer → Reviewer: Planner handoff를 반영한 result 전달\n- Reviewer → Planner: 최종 검토 기록\n- Reviewer → User: 사용자-facing 답변 생성\n\n## Conversation Requests\n\n${interventionSummary}\n\n## Final Decision\n\nAgentBoard MVP는 Codex stdout을 직접 Agent 간 통신으로 보지 않고, AgentBoard message bus와 session context 주입을 통해 Agent 팀의 대화와 답변을 구성한다.\n`;
  if (await shouldStop(runId)) return;
  await writeArtifact(runId, finalReport, 'reviewer');

  if (await shouldStop(runId)) return;
  await updateAgentStatus(runId, 'planner', 'done');
  await updateAgentStatus(runId, 'engineer', 'done');
  await updateAgentStatus(runId, 'reviewer', 'done');
  await updateRunStatus(runId, 'completed');
  await appendEvent(runId, {
    id: createId('evt'),
    runId,
    type: 'run.completed',
    actor: 'system',
    payload: { artifact: 'final-report.md', interventions: interventions.length },
    createdAt: nowIso(),
  });
}
