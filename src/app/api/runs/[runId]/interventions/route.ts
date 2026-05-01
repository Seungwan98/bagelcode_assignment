import { NextResponse } from 'next/server';
import type { InterventionInput } from '@/lib/protocol/types';
import { sendMessage } from '@/lib/bus/message-bus';
import { startMockRun } from '@/lib/runner/mock-runner';
import { startCliRun } from '@/lib/runner/cli-runner';
import { readState, resetContinuationState, updateRunStatus } from '@/lib/store/file-store';

export const runtime = 'nodejs';

function isInProgress(status: string): boolean {
  return status === 'created' || status === 'running' || status === 'paused';
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

  if (isInProgress(state.run.status)) {
    return NextResponse.json({ ok: false, error: { code: 'RUN_IN_PROGRESS', message: 'Agents가 답변을 생성하는 중입니다.' } }, { status: 409 });
  }

  const message = await sendMessage({
    runId,
    from: 'user',
    to: input.to || 'all',
    kind: 'user_intervention',
    body: input.body.trim(),
  });
  await resetContinuationState(runId);
  await updateRunStatus(runId, 'running');
  if (state.run.mode === 'cli') startCliRun(runId);
  else startMockRun(runId);
  return NextResponse.json({ ok: true, messageId: message.id, status: 'running' });
}
