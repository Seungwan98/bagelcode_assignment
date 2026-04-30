import { NextResponse } from 'next/server';
import type { AgentRole, CreateRunInput } from '@/lib/protocol/types';
import { createRun } from '@/lib/store/file-store';
import { startMockRun } from '@/lib/runner/mock-runner';

export const runtime = 'nodejs';

const ALLOWED_AGENTS: AgentRole[] = ['planner', 'engineer', 'reviewer'];

export async function POST(request: Request) {
  const input = (await request.json()) as CreateRunInput;
  if (!input.brief?.trim()) {
    return NextResponse.json({ ok: false, error: { code: 'INVALID_BRIEF', message: 'brief가 필요합니다.' } }, { status: 400 });
  }
  const agents = (input.agents ?? ALLOWED_AGENTS).filter((agent): agent is AgentRole => ALLOWED_AGENTS.includes(agent as AgentRole));
  const state = await createRun({
    title: input.title?.trim() || 'AgentBoard collaboration run',
    brief: input.brief.trim(),
    mode: input.mode ?? 'mock',
    agents: agents.length ? agents : ALLOWED_AGENTS,
  });
  if (state.run.mode === 'mock') startMockRun(state.run.id);
  return NextResponse.json({ ok: true, runId: state.run.id, status: state.run.status });
}
