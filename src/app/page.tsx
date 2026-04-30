import { RunCreateForm } from '@/components/RunCreateForm';

export default function HomePage() {
  const initialMode = process.env.AGENTBOARD_MODE === 'cli' ? 'cli' : 'mock';

  return (
    <main className="landing-shell">
      <section className="landing-hero">
        <span className="kicker">BagelCode Assignment MVP</span>
        <h1>AgentBoard Chat</h1>
        <p>
          첫 메시지를 보내면 Planner, Engineer, Reviewer가 작업을 시작합니다.
          진행 중에는 전송 대신 상태 확인과 취소로 흐름을 제어합니다.
        </p>
      </section>
      <RunCreateForm initialMode={initialMode} />
      <section className="proof-strip" aria-label="핵심 기능">
        <div><strong>3 Agents</strong><span>Planner · Engineer · Reviewer</span></div>
        <div><strong>Live Progress</strong><span>SSE 기반 진행 상태</span></div>
        <div><strong>User Control</strong><span>진행 중 취소와 관찰</span></div>
      </section>
    </main>
  );
}
