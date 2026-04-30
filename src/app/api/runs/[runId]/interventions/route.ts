import { NextResponse } from 'next/server';
import type { InterventionInput } from '@/lib/protocol/types';
import { sendMessage } from '@/lib/bus/message-bus';
import { acknowledgeIntervention } from '@/lib/runner/mock-runner';

export const runtime = 'nodejs';

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const input = (await request.json()) as InterventionInput;
  if (!input.body?.trim()) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_INTERVENTION', message: '지시 내용이 필요합니다.' } }, { status: 400 });
  }
  const message = await sendMessage({
    runId,
    from: 'user',
    to: input.to || 'all',
    kind: 'user_intervention',
    body: input.body.trim(),
  });
  void acknowledgeIntervention(runId, input.to || 'all', input.body.trim());
  return NextResponse.json({ ok: true, messageId: message.id });
}
