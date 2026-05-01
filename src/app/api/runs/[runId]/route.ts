import { NextResponse } from 'next/server';
import { deleteRun, readArtifact, readEvents, readMessages, readState } from '@/lib/store/file-store';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const [state, events, messages, artifact] = await Promise.all([
      readState(runId),
      readEvents(runId),
      readMessages(runId),
      readArtifact(runId),
    ]);
    return NextResponse.json({ ok: true, state, events, messages, artifact });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ ok: false, error: { code: 'RUN_NOT_FOUND', message: 'Run을 찾을 수 없습니다.' } }, { status: 404 });
    }
    throw error;
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    await deleteRun(runId);
    return NextResponse.json({ ok: true, runId });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ ok: false, error: { code: 'RUN_NOT_FOUND', message: 'Run을 찾을 수 없습니다.' } }, { status: 404 });
    }
    if (error instanceof Error && error.message === 'Run is in progress') {
      return NextResponse.json({ ok: false, error: { code: 'RUN_IN_PROGRESS', message: '진행 중인 대화는 먼저 취소한 뒤 삭제할 수 있습니다.' } }, { status: 409 });
    }
    throw error;
  }
}
