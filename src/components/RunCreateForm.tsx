'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function RunCreateForm() {
  const router = useRouter();
  const [title, setTitle] = useState('BagelCode multi-agent assignment');
  const [brief, setBrief] = useState('여러 AI 에이전트가 협업하는 Web Dashboard MVP 계획과 구현 결과를 만들어줘.');
  const [mode, setMode] = useState<'mock' | 'cli'>('mock');
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function startRun() {
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, brief, mode, agents: ['planner', 'engineer', 'reviewer'] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'Run 생성 실패');
      router.push(`/runs/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card stack">
      <h2>Mock collaboration 시작</h2>
      <label className="stack">
        <span>Run 제목</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="stack">
        <span>과제 brief</span>
        <textarea value={brief} onChange={(event) => setBrief(event.target.value)} />
      </label>
      <label className="stack">
        <span>실행 모드</span>
        <select value={mode} onChange={(event) => setMode(event.target.value as 'mock' | 'cli')}>
          <option value="mock">mock — key 없이 로컬 데모</option>
          <option value="cli">cli — 로컬 Codex/Claude/Gemini 명령 실행</option>
        </select>
      </label>
      {mode === 'cli' ? <p>CLI mode는 서버 환경변수에 AGENTBOARD_CODEX_CMD, AGENTBOARD_CLAUDE_CMD, AGENTBOARD_GEMINI_CMD가 필요합니다.</p> : null}
      {error ? <p style={{ color: 'var(--danger)' }}>{error}</p> : null}
      <button disabled={isSubmitting || !brief.trim()} onClick={startRun}>
        {isSubmitting ? 'Run 생성 중...' : 'Start mock collaboration'}
      </button>
    </div>
  );
}
