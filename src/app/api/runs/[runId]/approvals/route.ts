import { NextResponse } from 'next/server';
import type { AgentRole } from '@/lib/protocol/types';
import { TmuxSessionAdapter } from '@/lib/runner/tmux-session-adapter';
import { readEvents, readState } from '@/lib/store/file-store';

export const runtime = 'nodejs';

const AGENT_ROLES = new Set<AgentRole>(['orchestrator', 'planner', 'engineer', 'reviewer']);
const ACTIONS = new Set(['approve', 'reject']);

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && AGENT_ROLES.has(value as AgentRole);
}

function isApprovalAction(value: unknown): value is 'approve' | 'reject' {
  return typeof value === 'string' && ACTIONS.has(value);
}

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const input = (await request.json().catch(() => ({}))) as { role?: unknown; action?: unknown; approvalId?: unknown };

  if (!isAgentRole(input.role) || !isApprovalAction(input.action) || typeof input.approvalId !== 'string' || !input.approvalId.trim()) {
    return NextResponse.json(
      { ok: false, error: { code: 'INVALID_APPROVAL', message: 'role, action, approvalId가 필요합니다.' } },
      { status: 400 },
    );
  }

  try {
    const [state, events] = await Promise.all([readState(runId), readEvents(runId)]);
    const requested = events.find((event) => event.type === 'approval.requested' && event.payload.approvalId === input.approvalId);
    if (!requested) {
      return NextResponse.json(
        { ok: false, error: { code: 'APPROVAL_NOT_FOUND', message: '승인 요청을 찾을 수 없습니다.' } },
        { status: 404 },
      );
    }
    if (requested.actor !== input.role && requested.payload.role !== input.role) {
      return NextResponse.json(
        { ok: false, error: { code: 'APPROVAL_ROLE_MISMATCH', message: '승인 요청 Agent와 처리 대상 Agent가 다릅니다.' } },
        { status: 409 },
      );
    }
    const alreadyResolved = events.some((event) => (
      (event.type === 'approval.approved' || event.type === 'approval.rejected')
      && event.payload.approvalId === input.approvalId
    ));
    if (alreadyResolved) {
      return NextResponse.json(
        { ok: false, error: { code: 'APPROVAL_ALREADY_RESOLVED', message: '이미 처리된 승인 요청입니다.' } },
        { status: 409 },
      );
    }
    if (!state.sessions?.[input.role] || state.sessions[input.role]?.transport !== 'tmux') {
      return NextResponse.json(
        { ok: false, error: { code: 'TMUX_SESSION_NOT_FOUND', message: '해당 Agent의 tmux 세션을 찾을 수 없습니다.' } },
        { status: 409 },
      );
    }

    await new TmuxSessionAdapter('tmux-codex').respondToApproval(runId, input.role, input.action, input.approvalId);
    return NextResponse.json({ ok: true, approvalId: input.approvalId, action: input.action });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ ok: false, error: { code: 'RUN_NOT_FOUND', message: 'Run을 찾을 수 없습니다.' } }, { status: 404 });
    }
    throw error;
  }
}
