import { readMessages, readState, updateAgentStatus, updateRunStatus, appendEvent, writeArtifact } from '@/lib/store/file-store';
import { sendMessage } from '@/lib/bus/message-bus';
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

function latestUserRequest(messages: Awaited<ReturnType<typeof readMessages>>): string {
  return messages.filter((message) => message.kind === 'user_intervention').at(-1)?.body ?? '사용자 요청 없음';
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
  const request = latestUserRequest(await readMessages(runId));
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

  if (await shouldStop(runId)) return;
  await updateAgentStatus(runId, 'planner', 'thinking');
  await sleep(500);
  if (await shouldStop(runId)) return;
  await sendMessage({
    runId,
    from: 'planner',
    to: 'engineer',
    kind: 'instruction',
    body: `사용자 요청을 분석해 실행 가능한 답변 방향을 정리해줘. 요청: ${request}`,
    requiresAck: true,
  });

  if (await shouldStop(runId)) return;
  await updateAgentStatus(runId, 'engineer', 'thinking');
  await sleep(900);
  if (await shouldStop(runId)) return;
  await sendMessage({
    runId,
    from: 'engineer',
    to: 'planner',
    kind: 'progress',
    body: `요청을 구현 관점으로 정리했습니다. 핵심 요구: ${request}`,
  });

  await sleep(900);
  if (await shouldStop(runId)) return;
  await sendMessage({
    runId,
    from: 'engineer',
    to: 'reviewer',
    kind: 'result',
    body: 'Planner 분석을 바탕으로 답변 초안을 만들었습니다. 요청에 대한 실행 가능한 접근과 검증 관점을 포함합니다.',
  });

  if (await shouldStop(runId)) return;
  await updateAgentStatus(runId, 'reviewer', 'thinking');
  await sleep(2500);
  if (await shouldStop(runId)) return;
  const interventions = (await readMessages(runId)).filter((message) => message.kind === 'user_intervention');
  const interventionSummary = interventions.length
    ? interventions.map((message, index) => `${index + 1}. ${message.body}`).join('\n')
    : '사용자 개입 없음';

  await sendMessage({
    runId,
    from: 'reviewer',
    to: 'planner',
    kind: 'review',
    body: '요청에 대한 최종 답변을 준비했습니다.',
  });

  await sendMessage({
    runId,
    from: 'reviewer',
    to: 'user',
    kind: 'result',
    body: `요청하신 내용에 대해 Planner, Engineer, Reviewer가 검토했습니다.\n\n요청: ${request}\n\n답변: 현재 MVP 기준으로는 에이전트 팀이 요청을 분석하고, 구현 방향을 정리한 뒤, 검토 결과를 하나의 답변으로 제공합니다. 자세한 에이전트 간 전달 과정은 Logs에서 확인할 수 있습니다.`,
  });

  const finalReport = `# AgentBoard Mock Collaboration Report\n\n## Run\n\n- Run ID: ${runId}\n- Mode: mock\n\n## Agent Collaboration Evidence\n\n- Planner → Engineer: MVP 구현 지시\n- Engineer → Planner: 구현 범위 progress\n- Engineer → Reviewer: result 전달\n- Reviewer → Planner: 최종 검토\n\n## Conversation Requests\n\n${interventionSummary}\n\n## Final Decision\n\nAgentBoard MVP는 사용자의 채팅 요청에 대해 Agent 팀의 분석, 구현 관점, 검토 결과를 답변으로 제공한다.\n`;
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
