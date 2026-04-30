import { RunCreateForm } from '@/components/RunCreateForm';

export default function HomePage() {
  const initialMode = process.env.AGENTBOARD_MODE === 'cli' ? 'cli' : 'mock';

  return (
    <main className="landing-shell">
      <section className="landing-hero">
        <span className="kicker">BagelCode Assignment MVP</span>
        <h1>AgentBoard Chat</h1>
        <p>
          첫 메시지를 보내면 Planner, Engineer, Reviewer가 답변을 만듭니다.
          답변이 끝나면 같은 채팅방에서 다음 요청을 이어서 보낼 수 있습니다.
        </p>
      </section>
      <RunCreateForm initialMode={initialMode} />
      <section className="proof-strip" aria-label="핵심 기능">
        <div><strong>3 Agents</strong><span>Planner · Engineer · Reviewer</span></div>
        <div><strong>Live Progress</strong><span>SSE 기반 진행 상태</span></div>
        <div><strong>Repeat Chat</strong><span>답변 후 다음 요청 전송</span></div>
      </section>
    </main>
  );
}
