import { readMessages, readState, updateAgentStatus, updateRunStatus, appendEvent, writeArtifact } from '@/lib/store/file-store';
import { sendMessage } from '@/lib/bus/message-bus';
import { createId, nowIso } from '@/lib/utils/ids';

const activeRuns = new Set<string>();
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
  for (const timer of timers.get(runId) ?? []) clearTimeout(timer);
  timers.delete(runId);
  activeRuns.delete(runId);
}

export function startMockRun(runId: string): void {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  const timer = setTimeout(() => {
    void runScript(runId).finally(() => activeRuns.delete(runId));
  }, delayMs(50));
  timer.unref?.();
  registerTimer(runId, timer);
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

  await updateAgentStatus(runId, 'planner', 'thinking');
  await sleep(500);
  await sendMessage({
    runId,
    from: 'planner',
    to: 'engineer',
    kind: 'instruction',
    body: 'AgentBoard MVP의 실행 가능한 수직 슬라이스를 설계하고 구현 포인트를 정리해줘.',
    requiresAck: true,
  });

  await updateAgentStatus(runId, 'engineer', 'thinking');
  await sleep(900);
  await sendMessage({
    runId,
    from: 'engineer',
    to: 'planner',
    kind: 'progress',
    body: 'Next.js Dashboard, SSE timeline, JSONL message bus, user intervention API를 MVP 범위로 잡았습니다.',
  });

  await sleep(900);
  await sendMessage({
    runId,
    from: 'engineer',
    to: 'reviewer',
    kind: 'result',
    body: 'Mock runner가 planner, engineer, reviewer 메시지를 생성하고 최종 artifact를 갱신할 수 있습니다.',
  });

  await updateAgentStatus(runId, 'reviewer', 'thinking');
  await sleep(2500);
  const interventions = (await readMessages(runId)).filter((message) => message.kind === 'user_intervention');
  const interventionSummary = interventions.length
    ? interventions.map((message, index) => `${index + 1}. ${message.body}`).join('\n')
    : '사용자 개입 없음';

  await sendMessage({
    runId,
    from: 'reviewer',
    to: 'planner',
    kind: 'review',
    body: interventions.length
      ? '사용자 개입이 감지되어 최종 artifact에 반영했습니다.'
      : '기본 mock 협업 흐름이 완료되었습니다.',
  });

  const finalReport = `# AgentBoard Mock Collaboration Report\n\n## Run\n\n- Run ID: ${runId}\n- Mode: mock\n\n## Agent Collaboration Evidence\n\n- Planner → Engineer: MVP 구현 지시\n- Engineer → Planner: 구현 범위 progress\n- Engineer → Reviewer: result 전달\n- Reviewer → Planner: 최종 검토\n\n## User Intervention\n\n${interventionSummary}\n\n## Final Decision\n\nAgentBoard MVP는 Web Dashboard, SSE timeline, JSONL message bus, mock runner, user intervention composer, artifact panel을 우선 구현한다.\n`;
  await writeArtifact(runId, finalReport, 'reviewer');

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

export async function acknowledgeIntervention(runId: string, to: string, body: string): Promise<void> {
  const target = to === 'all' ? 'planner' : to;
  await updateAgentStatus(runId, target, 'thinking');
  await sleep(200);
  await sendMessage({
    runId,
    from: target,
    to: 'user',
    kind: 'ack',
    body: `사용자 지시를 확인했습니다: ${body}`,
  });
}
