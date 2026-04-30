import { NextResponse } from 'next/server';
import { readArtifact, readEvents, readMessages, readState } from '@/lib/store/file-store';

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
