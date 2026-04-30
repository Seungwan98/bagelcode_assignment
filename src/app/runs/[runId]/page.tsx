import Link from 'next/link';
import { AgentCardList } from '@/components/AgentCardList';
import { ArtifactPanel } from '@/components/ArtifactPanel';
import { EventTimeline } from '@/components/EventTimeline';
import { InterventionComposer } from '@/components/InterventionComposer';
import { readState } from '@/lib/store/file-store';

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const state = await readState(runId);
  return (
    <main className="shell stack">
      <div className="row">
        <div>
          <span className="kicker">Run Dashboard</span>
          <h1>{state.run.title}</h1>
          <p>{state.run.brief}</p>
        </div>
        <div className="stack" style={{ alignItems: 'flex-end' }}>
          <span className={`badge ${state.run.status}`}>{state.run.status}</span>
          <Link className="badge" href="/">새 run 만들기</Link>
        </div>
      </div>
      <AgentCardList agents={state.agents} />
      <InterventionComposer runId={runId} agents={state.agents} />
      <div className="grid two">
        <EventTimeline runId={runId} />
        <ArtifactPanel runId={runId} />
      </div>
    </main>
  );
}
