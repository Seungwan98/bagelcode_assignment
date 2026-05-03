import { NextResponse } from 'next/server';
import { listImplementationWorkspaceFiles } from '@/lib/store/file-store';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const files = await listImplementationWorkspaceFiles(runId);
    return NextResponse.json({ ok: true, files });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ ok: true, files: [] });
    }
    throw error;
  }
}
