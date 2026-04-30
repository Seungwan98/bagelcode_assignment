import { RunCreateForm } from '@/components/RunCreateForm';

export default function HomePage() {
  const initialMode = process.env.AGENTBOARD_MODE === 'cli' ? 'cli' : 'mock';

  return (
    <main className="landing-shell">
      <section className="landing-hero">
        <span className="kicker">BagelCode Assignment MVP</span>
        <h1>AgentBoard Chat</h1>
        <p>
          여러 AI 에이전트가 만드는 결과를 대화방처럼 관찰하고,
          사용자는 채팅 입력창에서 바로 개입할 수 있습니다.
        </p>
      </section>
      <RunCreateForm initialMode={initialMode} />
      <section className="proof-strip" aria-label="핵심 기능">
        <div><strong>3 Agents</strong><span>Planner · Engineer · Reviewer</span></div>
        <div><strong>Live Chat</strong><span>SSE 기반 실시간 메시지</span></div>
        <div><strong>User Control</strong><span>대화 중 intervention 전송</span></div>
      </section>
    </main>
  );
}
