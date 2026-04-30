import { NextResponse } from 'next/server';
import { appendEvent, updateRunStatus } from '@/lib/store/file-store';
import { stopMockRun } from '@/lib/runner/mock-runner';
import { stopCliRun } from '@/lib/runner/cli-runner';
import { createId, nowIso } from '@/lib/utils/ids';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const { action } = (await request.json()) as { action?: 'pause' | 'resume' | 'stop' };
  if (!action || !['pause', 'resume', 'stop'].includes(action)) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_ACTION', message: '지원하지 않는 control action입니다.' } }, { status: 400 });
  }
  const status = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'stopped';
  if (action === 'stop') {
    stopMockRun(runId);
    stopCliRun(runId);
  }
  await updateRunStatus(runId, status);
  await appendEvent(runId, {
    id: createId('evt'),
    runId,
    type: action === 'pause' ? 'control.paused' : action === 'resume' ? 'control.resumed' : 'control.stopped',
    actor: 'user',
    payload: { action },
    createdAt: nowIso(),
  });
  return NextResponse.json({ ok: true, status });
}
