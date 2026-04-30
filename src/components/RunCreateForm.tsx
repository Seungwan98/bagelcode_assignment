'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function RunCreateForm() {
  const router = useRouter();
  const [title, setTitle] = useState('BagelCode multi-agent assignment');
  const [brief, setBrief] = useState('여러 AI 에이전트가 협업하는 Chat MVP 계획과 구현 결과를 만들어줘.');
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
    <form className="start-chat-card" onSubmit={(event) => { event.preventDefault(); void startRun(); }}>
      <div className="start-chat-header">
        <span className="kicker">New conversation</span>
        <h2>에이전트 팀에게 바로 요청하기</h2>
        <p>Planner, Engineer, Reviewer가 하나의 채팅방에서 순차적으로 응답합니다.</p>
      </div>

      <label className="compact-field">
        <span>대화 제목</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>

      <div className="mode-switch" role="group" aria-label="실행 모드 선택">
        <button className={mode === 'mock' ? 'selected secondary' : 'secondary'} type="button" onClick={() => setMode('mock')}>Mock</button>
        <button className={mode === 'cli' ? 'selected secondary' : 'secondary'} type="button" onClick={() => setMode('cli')}>CLI</button>
      </div>

      <label className="chat-start-composer">
        <span className="sr-only">과제 brief</span>
        <textarea
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="무엇을 만들지 에이전트 팀에게 요청하세요."
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void startRun();
          }}
        />
      </label>

      {mode === 'cli' ? <p className="hint">CLI mode는 서버 환경변수에 각 CLI command가 설정되어 있어야 합니다.</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      <div className="start-actions">
        <span>⌘/Ctrl + Enter로 시작</span>
        <button disabled={isSubmitting || !brief.trim()} type="submit">
          {isSubmitting ? '대화 생성 중...' : '대화 시작'}
        </button>
      </div>
    </form>
  );
}
