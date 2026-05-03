'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatRoom } from '@/components/ChatRoom';
import type { AgentRole, ClientSessionRunSummary, ClientSessionSnapshot, RunMode, RunState } from '@/lib/protocol/types';

type SelectableRunMode = Extract<RunMode, 'mock' | 'cli'>;
type ClientSessionResponse = { ok: true } & ClientSessionSnapshot;
type RunSnapshotResponse = { ok: true; state: RunState };

interface ChatWorkspaceProps {
  initialMode?: SelectableRunMode;
}

const CLIENT_SESSION_STORAGE_KEY = 'agentboard:clientSessionId';
const LEGACY_CLIENT_SESSION_STORAGE_KEYS = ['agentboard.clientSessionId', 'agentboard:client-session-id'];
const DEFAULT_AGENTS: AgentRole[] = ['orchestrator', 'planner', 'engineer', 'reviewer'];
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

function isRunSnapshotResponse(value: unknown): value is RunSnapshotResponse {
  return Boolean(value && typeof value === 'object' && (value as Partial<RunSnapshotResponse>).ok === true && (value as Partial<RunSnapshotResponse>).state);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul',
  }).format(date);
}

function titleFromBrief(brief: string): string {
  const compact = brief.trim().replace(/\s+/g, ' ');
  if (!compact) return '새 AgentBoard 대화';
  return compact.length > 42 ? `${compact.slice(0, 42)}…` : compact;
}

function runDescription(run: ClientSessionRunSummary): string {
  if (run.status === 'running' || run.status === 'created' || run.status === 'paused') return '답변 생성 중';
  if (run.status === 'stale') return '중단된 실행 기록';
  if (run.status === 'failed') return '오류가 발생한 대화';
  if (run.status === 'stopped') return '사용자가 취소한 대화';
  return '완료된 대화';
}

export function ChatWorkspace({ initialMode = 'mock' }: ChatWorkspaceProps) {
  const [clientSessionId, setClientSessionId] = useState('');
  const [sessionSnapshot, setSessionSnapshot] = useState<ClientSessionResponse | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null | undefined>(undefined);
  const [selectedRunState, setSelectedRunState] = useState<RunState | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<SelectableRunMode>(initialMode);
  const [isSessionLoading, setSessionLoading] = useState(true);
  const [isRunLoading, setRunLoading] = useState(false);
  const [isCreating, setCreating] = useState(false);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const hasAutoSelectedRef = useRef(false);

  const recentRuns = sessionSnapshot?.recentRuns ?? [];
  const activeRunId = sessionSnapshot?.activeRun?.runId;

  const loadSessionSnapshot = useCallback(async (sessionId = clientSessionId): Promise<ClientSessionResponse | null> => {
    if (!sessionId) return null;
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
    const data = (await response.json()) as unknown;
    if (!response.ok || !isClientSessionResponse(data)) return null;
    setSessionSnapshot(data);
    return data;
  }, [clientSessionId]);

  const loadRun = useCallback(async (runId: string): Promise<void> => {
    setRunLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
      const data = (await response.json()) as unknown;
      if (!response.ok || !isRunSnapshotResponse(data)) throw new Error('대화 내용을 불러오지 못했습니다.');
      setSelectedRunState(data.state);
    } catch (err) {
      setSelectedRunState(null);
      setError(err instanceof Error ? err.message : '대화 내용을 불러오지 못했습니다.');
    } finally {
      setRunLoading(false);
    }
  }, []);

  useEffect(() => {
    const sessionId = ensureClientSessionId();
    setClientSessionId(sessionId);
    setSessionLoading(true);
    loadSessionSnapshot(sessionId)
      .catch(() => setSessionSnapshot(null))
      .finally(() => setSessionLoading(false));
  }, [loadSessionSnapshot]);

  useEffect(() => {
    if (!sessionSnapshot || hasAutoSelectedRef.current || selectedRunId !== undefined) return;
    const firstRun = sessionSnapshot.activeRun ?? sessionSnapshot.recentRuns[0];
    setSelectedRunId(firstRun?.runId ?? null);
    hasAutoSelectedRef.current = true;
  }, [selectedRunId, sessionSnapshot]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunState(null);
      return;
    }
    void loadRun(selectedRunId);
  }, [loadRun, selectedRunId]);

  useEffect(() => {
    if (!clientSessionId) return undefined;
    const timer = setInterval(() => {
      void loadSessionSnapshot().catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [clientSessionId, loadSessionSnapshot]);

  async function startNewRun(): Promise<void> {
    const trimmed = draft.trim();
    if (!trimmed || isCreating) return;
    const sessionId = clientSessionId || ensureClientSessionId();
    if (!clientSessionId) setClientSessionId(sessionId);
    setCreating(true);
    setError('');
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: titleFromBrief(trimmed),
          brief: trimmed,
          mode,
          agents: DEFAULT_AGENTS,
          clientSessionId: sessionId || undefined,
        }),
      });
      const data = (await response.json()) as { runId?: string; error?: { message?: string } };
      if (!response.ok || !data.runId) throw new Error(data.error?.message ?? '새 대화를 만들지 못했습니다.');
      setDraft('');
      setSelectedRunId(data.runId);
      await Promise.all([
        loadRun(data.runId),
        loadSessionSnapshot(sessionId),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '새 대화를 만들지 못했습니다.');
    } finally {
      setCreating(false);
    }
  }

  function startBlankChat(): void {
    setSelectedRunId(null);
    setSelectedRunState(null);
    setError('');
  }

  async function deleteConversation(run: ClientSessionRunSummary): Promise<void> {
    if (run.status === 'created' || run.status === 'running' || run.status === 'paused') {
      setError('진행 중인 대화는 먼저 취소한 뒤 삭제할 수 있습니다.');
      return;
    }
    if (!window.confirm(`"${run.title}" 대화를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    const wasSelectedRun = selectedRunId === run.runId;
    const previousRunState = selectedRunState;
    setDeletingRunId(run.runId);
    setError('');
    if (wasSelectedRun) {
      setSelectedRunId(null);
      setSelectedRunState(null);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.runId)}`, { method: 'DELETE' });
      const data = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!response.ok) throw new Error(data?.error?.message ?? '대화를 삭제하지 못했습니다.');
      await loadSessionSnapshot();
    } catch (err) {
      if (wasSelectedRun) {
        setSelectedRunId(run.runId);
        setSelectedRunState(previousRunState);
      }
      setError(err instanceof Error ? err.message : '대화를 삭제하지 못했습니다.');
    } finally {
      setDeletingRunId(null);
    }
  }

  const sidebarTitle = useMemo(() => {
    if (isSessionLoading) return '세션을 불러오는 중';
    if (!recentRuns.length) return '아직 대화가 없습니다';
    return `${recentRuns.length}개 대화`;
  }, [isSessionLoading, recentRuns.length]);

  return (
    <main className="workspace-shell">
      <aside className="session-sidebar" aria-label="대화 세션 목록">
        <div className="session-sidebar-header">
          <div>
            <span className="kicker">AgentBoard</span>
            <h1>Chats</h1>
          </div>
          <button onClick={startBlankChat} type="button">새 대화</button>
        </div>

        <fieldset className="mode-switch workspace-mode-switch" aria-label="실행 모드 선택">
          <legend className="sr-only">실행 모드 선택</legend>
          {MODE_OPTIONS.map((option) => (
            <label className={mode === option.value ? 'selected' : ''} key={option.value} htmlFor={`workspace-mode-${option.value}`}>
              <input
                checked={mode === option.value}
                id={`workspace-mode-${option.value}`}
                name="workspace-mode"
                onChange={() => setMode(option.value)}
                type="radio"
                value={option.value}
              />
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </label>
          ))}
        </fieldset>

        <div className="session-list-header">
          <span>{sidebarTitle}</span>
          <button className="secondary" onClick={() => void loadSessionSnapshot().catch(() => undefined)} type="button">새로고침</button>
        </div>

        <ol className="session-list">
          {recentRuns.map((run) => (
            <li key={run.runId}>
              <div className={`session-list-item ${selectedRunId === run.runId ? 'selected' : ''}`}>
                <button
                  className="session-select-button"
                  onClick={() => {
                    setSelectedRunId(run.runId);
                    setError('');
                  }}
                  type="button"
                >
                  <span className={`session-status-dot ${run.status}`} />
                  <strong>{run.title}</strong>
                  <small>{runDescription(run)} · {run.mode}</small>
                  <em>{formatTimestamp(run.updatedAt)}</em>
                  {activeRunId === run.runId ? <b>active</b> : null}
                </button>
                <button
                  aria-label={`${run.title} 삭제`}
                  className="session-delete-button"
                  disabled={deletingRunId === run.runId}
                  onClick={() => void deleteConversation(run)}
                  type="button"
                >
                  {deletingRunId === run.runId ? '삭제 중' : '삭제'}
                </button>
              </div>
            </li>
          ))}
        </ol>

        {clientSessionId ? <p className="session-id-hint">session: {clientSessionId.slice(0, 18)}…</p> : null}
      </aside>

      <section className="workspace-main" aria-label="선택된 대화">
        {selectedRunId && selectedRunState ? (
          <ChatRoom
            initialState={selectedRunState}
            key={selectedRunId}
            onNewChat={startBlankChat}
            onRunUpdated={() => void loadSessionSnapshot().catch(() => undefined)}
            runId={selectedRunId}
            variant="embedded"
          />
        ) : (
          <section className="empty-chat-panel">
            <div className="empty-chat-copy">
              <span className="kicker">New conversation</span>
              <h2>무엇을 도와드릴까요?</h2>
              <p>주제를 먼저 정하는 화면 없이, 바로 메시지를 보내면 Orchestrator가 필요한 Agent를 배정하고 같은 세션 목록에 대화를 저장합니다.</p>
            </div>
            <div className="empty-chat-card">
              <div className="chat-bubble system starter-bubble">
                <span className="bubble-meta">AgentBoard · ready</span>
                <p>첫 메시지를 보내면 새 대화가 생성됩니다. 이후 왼쪽 세션 목록에서 언제든 다시 열 수 있습니다.</p>
              </div>
              <textarea
                disabled={isCreating}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void startNewRun();
                  }
                }}
                placeholder="Agent들에게 요청하세요. 예: AgentBoard UI를 더 ChatGPT처럼 만들어줘."
                value={draft}
              />
              <div className="empty-chat-actions">
                <span>{mode === 'cli' ? 'CLI mode는 AGENTBOARD_CODEX_CMD 설정이 필요합니다.' : 'Mock mode는 외부 CLI 없이 실행됩니다.'}</span>
                <button disabled={!draft.trim() || isCreating} onClick={() => void startNewRun()} type="button">
                  {isCreating ? '대화 생성 중...' : '전송'}
                </button>
              </div>
            </div>
            {isRunLoading ? <p className="composer-status">대화 내용을 불러오는 중...</p> : null}
          </section>
        )}

        {isRunLoading && selectedRunId && !selectedRunState ? <p className="workspace-loading">대화 내용을 불러오는 중...</p> : null}
        {error ? <p className="workspace-error">{error}</p> : null}
      </section>
    </main>
  );
}
