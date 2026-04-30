import { NextResponse } from 'next/server';
import { readArtifact } from '@/lib/store/file-store';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const artifact = await readArtifact(runId);
  return NextResponse.json({ ok: true, artifact });
}
