import { NextResponse } from 'next/server';
import { readClientSessionSnapshot } from '@/lib/store/file-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ clientSessionId: string }> }) {
  const { clientSessionId } = await params;
  try {
    const snapshot = await readClientSessionSnapshot(decodeURIComponent(clientSessionId));
    return NextResponse.json({ ok: true, ...snapshot });
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid client session id') {
      return NextResponse.json({ ok: false, error: { code: 'INVALID_CLIENT_SESSION', message: 'clientSessionId가 올바르지 않습니다.' } }, { status: 400 });
    }
    throw error;
  }
}
