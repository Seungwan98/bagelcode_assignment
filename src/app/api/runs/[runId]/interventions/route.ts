import { NextResponse } from 'next/server';
import type { InterventionInput } from '@/lib/protocol/types';
import { sendMessage } from '@/lib/bus/message-bus';
import { startMockRun } from '@/lib/runner/mock-runner';
import { startCliRun } from '@/lib/runner/cli-runner';
import { appendEvent, readState, resetContinuationState, updateRunStatus } from '@/lib/store/file-store';
import { createId, nowIso } from '@/lib/utils/ids';

export const runtime = 'nodejs';

function isInProgress(status: string): boolean {
  return status === 'created' || status === 'running';
}

function shouldStartRunner(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped' || status === 'stale' || status === 'paused';
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const input = (await request.json()) as InterventionInput;
  if (!input.body?.trim()) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_INTERVENTION', message: '요청 내용이 필요합니다.' } }, { status: 400 });
  }
  let state;
  try {
    state = await readState(runId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ ok: false, error: { code: 'RUN_NOT_FOUND', message: 'Run을 찾을 수 없습니다.' } }, { status: 404 });
    }
    throw error;
  }

  const duringRun = isInProgress(state.run.status);
  const message = await sendMessage({
    runId,
    from: 'user',
    to: input.to || 'all',
    kind: 'user_intervention',
    body: input.body.trim(),
  });
  const interventionMode = duringRun ? 'during_run' : state.run.status === 'paused' ? 'resume_from_pause' : 'new_turn';
  await appendEvent(runId, {
    id: createId('evt'),
    runId,
    type: 'user.intervention_queued',
    actor: 'user',
    payload: {
      messageId: message.id,
      interventionMode,
      requiresOrchestratorDecision: duringRun,
      runStatus: state.run.status,
    },
    createdAt: nowIso(),
  });

  if (!shouldStartRunner(state.run.status)) {
    return NextResponse.json({
      ok: true,
      messageId: message.id,
      status: state.run.status,
      queued: true,
      interventionMode: 'during_run',
    });
  }

  await resetContinuationState(runId);
  await updateRunStatus(runId, 'running');
  if (state.run.mode === 'cli') startCliRun(runId);
  else startMockRun(runId);
  return NextResponse.json({
    ok: true,
    messageId: message.id,
    status: 'running',
    queued: state.run.status === 'paused',
    interventionMode,
  });
}
