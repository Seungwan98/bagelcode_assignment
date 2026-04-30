import { RunCreateForm } from '@/components/RunCreateForm';

export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero">
        <span className="kicker">BagelCode Assignment MVP</span>
        <h1>AgentBoard</h1>
        <p>
          여러 AI 에이전트가 메시지를 주고받는 과정을 Web Dashboard에서 관찰하고,
          사용자가 실행 중 직접 지시를 추가할 수 있는 로컬 실행형 MVP입니다.
        </p>
      </section>
      <div className="grid two">
        <RunCreateForm />
        <div className="card stack">
          <h2>증명할 것</h2>
          <p>1. Planner, Engineer, Reviewer가 structured message를 주고받습니다.</p>
          <p>2. EventSource 기반 timeline이 실시간으로 갱신됩니다.</p>
          <p>3. 사용자의 intervention이 저장되고 agent ack와 final artifact에 반영됩니다.</p>
          <p>4. Mock mode는 Firebase/AI CLI key 없이 실행됩니다.</p>
        </div>
      </div>
    </main>
  );
}
