'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ClientSessionRunSummary, ClientSessionSnapshot } from '@/lib/protocol/types';

type SelectableRunMode = 'mock' | 'cli';

type ClientSessionResponse = { ok: true } & ClientSessionSnapshot;

interface RunCreateFormProps {
  initialMode?: SelectableRunMode;
}

const CLIENT_SESSION_STORAGE_KEY = 'agentboard:clientSessionId';
const LEGACY_CLIENT_SESSION_STORAGE_KEYS = ['agentboard.clientSessionId', 'agentboard:client-session-id'];
const MODE_OPTIONS: Array<{ value: SelectableRunMode; label: string; description: string }> = [
  { value: 'mock', label: 'Mock', description: '외부 CLI 없이 즉시 실행' },
  { value: 'cli', label: 'CLI', description: 'Codex CLI로 실제 실행' },
];

function createClientSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `client_${globalThis.crypto.randomUUID()}`;
  return `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function ensureClientSessionId(): string {
  if (typeof window === 'undefined') return '';
  const existing = [CLIENT_SESSION_STORAGE_KEY, ...LEGACY_CLIENT_SESSION_STORAGE_KEYS]
    .map((key) => window.localStorage.getItem(key)?.trim())
    .find(Boolean);
  if (existing) {
    window.localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, existing);
    return existing;
  }
  const next = createClientSessionId();
  window.localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, next);
  return next;
}

function isClientSessionResponse(value: unknown): value is ClientSessionResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<ClientSessionResponse>;
  return response.ok === true && Array.isArray(response.recentRuns) && response.session !== undefined && Array.isArray(response.staleRunIds);
}

function formatSessionTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function resumeDescription(run: ClientSessionRunSummary): string {
  if (run.status === 'stale') return '이전 실행이 중단된 것으로 표시되었습니다. 기록은 안전하게 다시 열 수 있습니다.';
  if (run.status === 'running' || run.status === 'created' || run.status === 'paused') return '진행 중이거나 최근 활성화된 대화를 이어서 볼 수 있습니다.';
  return '최근 완료된 대화 기록을 다시 열 수 있습니다.';
}

function titleFromBrief(brief: string): string {
  const compact = brief.trim().replace(/\s+/g, ' ');
  if (!compact) return 'AgentBoard collaboration run';
  return compact.length > 42 ? `${compact.slice(0, 42)}…` : compact;
}

export function RunCreateForm({ initialMode = 'mock' }: RunCreateFormProps) {
  const router = useRouter();
  const [brief, setBrief] = useState('여러 AI 에이전트가 협업하는 Chat MVP 계획과 구현 결과를 만들어줘.');
  const [mode, setMode] = useState<SelectableRunMode>(initialMode);
  const [clientSessionId, setClientSessionId] = useState('');
  const [sessionSnapshot, setSessionSnapshot] = useState<ClientSessionResponse | null>(null);
  const [isSessionLoading, setSessionLoading] = useState(false);
  const [isSubmitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const resumeRun = useMemo(
    () => sessionSnapshot?.activeRun ?? sessionSnapshot?.recentRuns[0],
    [sessionSnapshot],
  );

  useEffect(() => {
    const sessionId = ensureClientSessionId();
    if (!sessionId) return undefined;
    const controller = new AbortController();
    setClientSessionId(sessionId);
    setSessionLoading(true);

    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as unknown;
        setSessionSnapshot(response.ok && isClientSessionResponse(data) ? data : null);
      })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') setSessionSnapshot(null);
      })
      .finally(() => setSessionLoading(false));

    return () => controller.abort();
  }, []);

  async function startRun() {
    const sessionId = clientSessionId || ensureClientSessionId();
    if (sessionId && !clientSessionId) setClientSessionId(sessionId);
    setSubmitting(true);
    setError('');
    try {
      const trimmedBrief = brief.trim();
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: titleFromBrief(trimmedBrief),
          brief: trimmedBrief,
          mode,
          agents: ['planner', 'engineer', 'reviewer'],
          clientSessionId: sessionId || undefined,
        }),
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
    <form className="start-chat-card chatbot-start-card" onSubmit={(event) => { event.preventDefault(); void startRun(); }}>
      <div className="start-chat-header">
        <span className="kicker">Start with chat</span>
        <h2>무엇을 만들지 바로 입력하세요</h2>
        <p>첫 메시지를 보내면 Planner, Engineer, Reviewer가 순서대로 작업하고 진행 상황은 채팅방에서 관찰합니다.</p>
      </div>

      {isSessionLoading ? <p className="hint">최근 대화 기록을 확인하는 중입니다...</p> : null}
      {resumeRun ? (
        <section className={`resume-run-card ${resumeRun.status}`} aria-label="최근 대화 이어가기">
          <div>
            <span className="kicker">Resume conversation</span>
            <h3>{resumeRun.title}</h3>
            <p>{resumeDescription(resumeRun)}</p>
            <small>{resumeRun.mode} · {resumeRun.status} · {formatSessionTimestamp(resumeRun.updatedAt)}</small>
          </div>
          <button type="button" onClick={() => router.push(`/runs/${resumeRun.runId}`)}>
            이어가기
          </button>
        </section>
      ) : null}

      <section className="starter-chat-window" aria-label="첫 요청 입력">
        <div className="chat-bubble system starter-bubble">
          <span className="bubble-meta">AgentBoard · ready</span>
          <p>요청을 보내면 에이전트 팀이 작업을 시작합니다. 진행 중에는 추가 전송 대신 상태 확인과 취소만 가능합니다.</p>
        </div>
        <label className="chat-start-composer">
          <span className="sr-only">첫 요청</span>
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            placeholder="에이전트 팀에게 맡길 작업을 입력하세요."
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void startRun();
            }}
          />
        </label>
      </section>

      <fieldset className="mode-switch compact-mode-switch" aria-label="실행 모드 선택">
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

      {mode === 'cli' ? <p className="hint">CLI mode는 AGENTBOARD_CODEX_CMD=&quot;codex exec&quot; 설정이 필요하며 세 역할 모두 Codex로 실행됩니다.</p> : null}
      {clientSessionId ? <p className="hint">이 브라우저의 session id로 최근 run을 로컬에 연결합니다.</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      <div className="start-actions">
        <span>⌘/Ctrl + Enter로 시작</span>
        <button disabled={isSubmitting || !brief.trim()} type="submit">
          {isSubmitting ? '작업 시작 중...' : '에이전트 작업 시작'}
        </button>
      </div>
    </form>
  );
}
