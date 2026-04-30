import { NextResponse } from 'next/server';
import { recordClientSessionRun } from '@/lib/store/file-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ActiveRunInput {
  runId?: string;
}

export async function POST(request: Request, { params }: { params: Promise<{ clientSessionId: string }> }) {
  const { clientSessionId } = await params;
  const input = (await request.json()) as ActiveRunInput;
  if (!input.runId?.trim()) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_RUN', message: 'runId가 필요합니다.' } }, { status: 400 });
  }

  try {
    const session = await recordClientSessionRun(decodeURIComponent(clientSessionId), input.runId.trim());
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ ok: false, error: { code: 'RUN_NOT_FOUND', message: 'Run을 찾을 수 없습니다.' } }, { status: 404 });
    }
    if (error instanceof Error && error.message === 'Invalid client session id') {
      return NextResponse.json({ ok: false, error: { code: 'INVALID_CLIENT_SESSION', message: 'clientSessionId가 올바르지 않습니다.' } }, { status: 400 });
    }
    throw error;
  }
}
