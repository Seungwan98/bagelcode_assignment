'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type SelectableRunMode = 'mock' | 'cli';

interface RunCreateFormProps {
  initialMode?: SelectableRunMode;
}

const MODE_OPTIONS: Array<{ value: SelectableRunMode; label: string; description: string }> = [
  { value: 'mock', label: 'Mock', description: '외부 CLI 없이 즉시 실행' },
  { value: 'cli', label: 'CLI', description: 'Codex CLI로 실제 실행' },
];

export function RunCreateForm({ initialMode = 'mock' }: RunCreateFormProps) {
  const router = useRouter();
  const [title, setTitle] = useState('BagelCode multi-agent assignment');
  const [brief, setBrief] = useState('여러 AI 에이전트가 협업하는 Chat MVP 계획과 구현 결과를 만들어줘.');
  const [mode, setMode] = useState<SelectableRunMode>(initialMode);
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

      <fieldset className="mode-switch" aria-label="실행 모드 선택">
        <legend className="sr-only">실행 모드 선택</legend>
        {MODE_OPTIONS.map((option) => (
          <label className={mode === option.value ? 'selected' : ''} key={option.value} htmlFor={`run-mode-${option.value}`}>
            <input
              checked={mode === option.value}
              id={`run-mode-${option.value}`}
              name="run-mode"
              onChange={() => setMode(option.value)}
              type="radio"
              value={option.value}
            />
            <strong>{option.label}</strong>
            <span>{option.description}</span>
          </label>
        ))}
      </fieldset>

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

      {mode === 'cli' ? <p className="hint">CLI mode는 AGENTBOARD_CODEX_CMD=&quot;codex exec&quot; 설정이 필요하며 세 역할 모두 Codex로 실행됩니다.</p> : null}
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
