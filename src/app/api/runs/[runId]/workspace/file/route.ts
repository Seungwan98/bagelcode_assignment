import { NextResponse } from 'next/server';
import { readImplementationWorkspaceFile } from '@/lib/store/file-store';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const path = new URL(request.url).searchParams.get('path');
  if (!path) {
    return NextResponse.json({ ok: false, error: { code: 'MISSING_PATH', message: '파일 path가 필요합니다.' } }, { status: 400 });
  }

  try {
    const file = await readImplementationWorkspaceFile(runId, path);
    return NextResponse.json({ ok: true, file });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workspace 파일을 읽을 수 없습니다.';
    if (message === 'Invalid workspace path') {
      return NextResponse.json({ ok: false, error: { code: 'INVALID_PATH', message: 'workspace 내부 파일만 읽을 수 있습니다.' } }, { status: 400 });
    }
    if (message === 'Workspace file is too large to preview') {
      return NextResponse.json({ ok: false, error: { code: 'FILE_TOO_LARGE', message: '미리보기 가능한 크기를 초과했습니다.' } }, { status: 413 });
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || message === 'Workspace path is not a file') {
      return NextResponse.json({ ok: false, error: { code: 'FILE_NOT_FOUND', message: '파일을 찾을 수 없습니다.' } }, { status: 404 });
    }
    throw error;
  }
}
