'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMessage, AgentRole, AgentState, RunEvent, RunState } from '@/lib/protocol/types';

interface RunSnapshot {
  ok: true;
  state: RunState;
  events: RunEvent[];
  messages: AgentMessage[];
  artifact: string;
}

interface ProcessLogEntry {
  id: string;
  messageId?: string;
  createdAt: string;
  eventType: RunEvent['type'];
  actor: string;
  title: string;
  detail: string;
  body?: string;
  payload: string;
  route: boolean;
  tone: 'normal' | 'route' | 'error';
}

const CLIENT_SESSION_STORAGE_KEY = 'agentboard:clientSessionId';
const LEGACY_CLIENT_SESSION_STORAGE_KEYS = ['agentboard.clientSessionId', 'agentboard:client-session-id'];
const AGENT_PANEL_ORDER: AgentRole[] = ['orchestrator', 'planner', 'engineer', 'reviewer'];

interface ChatRoomUiState {
  selectedLogId?: string | null;
  showArtifact?: boolean;
  showLogs?: boolean;
  body?: string;
}

interface ChatRoomProps {
  initialState: RunState;
  runId: string;
  onNewChat?: () => void;
  onRunUpdated?: () => void;
  variant?: 'page' | 'embedded';
}

function chatRoomUiStateKey(runId: string): string {
  return `agentboard:run-ui:${runId}`;
}

function readChatRoomUiState(runId: string): ChatRoomUiState {
  try {
    const raw = window.localStorage.getItem(chatRoomUiStateKey(runId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<ChatRoomUiState>;
    return {
      selectedLogId: typeof parsed.selectedLogId === 'string' || parsed.selectedLogId === null ? parsed.selectedLogId : undefined,
      showArtifact: typeof parsed.showArtifact === 'boolean' ? parsed.showArtifact : undefined,
      showLogs: typeof parsed.showLogs === 'boolean' ? parsed.showLogs : undefined,
      body: typeof parsed.body === 'string' ? parsed.body : undefined,
    };
  } catch {
    return {};
  }
}

function writeChatRoomUiState(runId: string, state: ChatRoomUiState): void {
  window.localStorage.setItem(chatRoomUiStateKey(runId), JSON.stringify(state));
}

function readClientSessionId(): string | undefined {
  const existing = [CLIENT_SESSION_STORAGE_KEY, ...LEGACY_CLIENT_SESSION_STORAGE_KEYS]
    .map((key) => window.localStorage.getItem(key)?.trim())
    .find(Boolean);
  if (existing) window.localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, existing);
  return existing;
}

function isRunSnapshot(value: unknown): value is RunSnapshot {
  return Boolean(value && typeof value === 'object' && 'ok' in value && (value as { ok: unknown }).ok === true);
}

function messageFromEvent(event: RunEvent): AgentMessage | null {
  const maybeMessage = event.payload.message;
  if (!maybeMessage || typeof maybeMessage !== 'object') return null;
  const message = maybeMessage as Partial<AgentMessage>;
  if (!message.id || !message.body || !message.from || !message.to || !message.kind || !message.createdAt) return null;
  return message as AgentMessage;
}

function upsertMessages(current: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function actorLabel(agentMap: Map<string, AgentState>, actor: string): string {
  if (actor === 'user') return 'You';
  if (actor === 'all') return 'All Agents';
  return agentMap.get(actor)?.displayName ?? actor;
}

function messageHint(message: AgentMessage, agentMap: Map<string, AgentState>): string {
  const from = actorLabel(agentMap, message.from);
  const to = actorLabel(agentMap, message.to);
  return `${from} → ${to} · ${message.kind}`;
}

function isAgentActor(agentMap: Map<string, AgentState>, actor: string): boolean {
  return agentMap.has(actor);
}

function isAgentToAgentMessage(message: AgentMessage, agentMap: Map<string, AgentState>): boolean {
  return isAgentActor(agentMap, message.from) && isAgentActor(agentMap, message.to);
}

function isOperationalAck(message: AgentMessage, agentMap: Map<string, AgentState>): boolean {
  return message.kind === 'ack' && isAgentActor(agentMap, message.from) && message.to === 'user';
}

function formatTime(value?: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleTimeString();
}

function agentPanelOrder(agent: AgentState): number {
  const index = AGENT_PANEL_ORDER.indexOf(agent.role);
  return index < 0 ? AGENT_PANEL_ORDER.length : index;
}

function isAgentPanelMessage(message: AgentMessage, agentId: string): boolean {
  if (message.kind === 'ack') return false;
  if (message.from === agentId || message.to === agentId) return true;
  if (agentId === 'orchestrator' && (message.from === 'user' || message.to === 'all' || message.to === 'user')) return true;
  return false;
}

function isAutoContinuationMessage(message: AgentMessage): boolean {
  return message.from === 'system' && message.to === 'orchestrator' && message.correlationId?.startsWith('continuation:') === true;
}

function isOrchestratorVerdictMessage(message: AgentMessage): boolean {
  return message.from === 'orchestrator' && message.to === 'orchestrator' && /Orchestrator Verdict:/i.test(message.body);
}

function isFallbackOrchestratorMessage(message: AgentMessage): boolean {
  return message.from === 'orchestrator' && /Fallback:\s*true/i.test(message.body);
}

function panelMessageClass(agentId: string, message: AgentMessage): string {
  if (message.kind === 'error') return 'agent-panel-message error';
  if (isFallbackOrchestratorMessage(message)) return 'agent-panel-message error';
  if (isOrchestratorVerdictMessage(message)) return message.body.includes('incomplete')
    ? 'agent-panel-message continuation'
    : 'agent-panel-message outgoing';
  if (isAutoContinuationMessage(message)) return 'agent-panel-message continuation';
  if (message.from === 'user') return 'agent-panel-message user';
  if (message.from === 'orchestrator' && message.to === agentId && message.kind === 'instruction') return 'agent-panel-message assignment';
  if (message.from === agentId) return 'agent-panel-message outgoing';
  if (message.to === agentId) return 'agent-panel-message incoming';
  return 'agent-panel-message context';
}

function panelMessageTitle(agentId: string, message: AgentMessage, agentMap: Map<string, AgentState>): string {
  if (isFallbackOrchestratorMessage(message) && isOrchestratorVerdictMessage(message)) return 'Orchestrator 검증 fallback';
  if (isFallbackOrchestratorMessage(message) && message.to === 'all') return 'Orchestrator 계획 fallback';
  if (isOrchestratorVerdictMessage(message)) return message.body.includes('incomplete')
    ? 'Orchestrator 검증 → 미완성, 재배정'
    : 'Orchestrator 검증 → 완료';
  if (isAutoContinuationMessage(message)) return 'Auto continuation → Orchestrator';
  if (message.from === 'user') return '사용자 → Orchestrator';
  if (message.from === 'orchestrator' && message.to === 'all') return 'Orchestrator 라우팅 결정';
  if (message.from === 'orchestrator' && message.to === agentId) return `Orchestrator → ${actorLabel(agentMap, agentId)}`;
  if (message.from === agentId) return `${actorLabel(agentMap, agentId)} → ${actorLabel(agentMap, message.to)}`;
  if (message.to === agentId) return `${actorLabel(agentMap, message.from)} → ${actorLabel(agentMap, agentId)}`;
  return messageHint(message, agentMap);
}

function eventPayloadText(event: RunEvent, key: string): string | undefined {
  const value = event.payload[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function stringifyPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function logBase(event: RunEvent): Pick<ProcessLogEntry, 'id' | 'createdAt' | 'eventType' | 'actor' | 'payload'> {
  return {
    id: event.id,
    createdAt: event.createdAt,
    eventType: event.type,
    actor: event.actor,
    payload: stringifyPayload(event.payload),
  };
}

function processLogFromEvent(event: RunEvent, agentMap: Map<string, AgentState>): ProcessLogEntry {
  const message = messageFromEvent(event);
  if (message) {
    const route = isAgentToAgentMessage(message, agentMap);
    const ack = isOperationalAck(message, agentMap);
    const verdict = isOrchestratorVerdictMessage(message);
    const fallback = isFallbackOrchestratorMessage(message);
    return {
      ...logBase(event),
      messageId: message.id,
      title: fallback && verdict
        ? 'Orchestrator 검증 fallback'
        : fallback && message.to === 'all'
          ? 'Orchestrator 계획 fallback'
          : verdict
        ? (message.body.includes('incomplete') ? 'Orchestrator 검증: 미완성' : 'Orchestrator 검증: 완료')
        : (ack ? `${actorLabel(agentMap, message.from)} 지시 수신 처리` : messageHint(message, agentMap)),
      detail: fallback ? 'parse fallback' : verdict ? 'orchestrator.verdict' : (ack ? '내부 확인' : event.type),
      body: ack ? undefined : message.body,
      route,
      tone: fallback ? 'error' : verdict && message.body.includes('incomplete') ? 'route' : route ? 'route' : message.kind === 'error' ? 'error' : 'normal',
    };
  }

  const role = eventPayloadText(event, 'role');
  const adapter = eventPayloadText(event, 'adapter');
  const status = eventPayloadText(event, 'status');
  const agentId = eventPayloadText(event, 'agentId');
  const messageId = eventPayloadText(event, 'messageId');
  const to = eventPayloadText(event, 'to');
  const errorMessage = eventPayloadText(event, 'message');
  const artifact = eventPayloadText(event, 'artifact');
  const summary = eventPayloadText(event, 'summary');
  const interventionPreview = eventPayloadText(event, 'interventionPreview');
  const durationMs = eventPayloadText(event, 'durationMs');
  const tmuxSession = eventPayloadText(event, 'tmuxSession');
  const tmuxPane = eventPayloadText(event, 'tmuxPane');

  if (event.type === 'agent.started') {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, event.actor)} started`,
      detail: adapter ? `${role ?? event.actor} · ${adapter}` : role ?? event.actor,
      route: false,
      tone: 'normal',
    };
  }
  if (event.type === 'agent.status_changed') {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, agentId ?? event.actor)} status`,
      detail: status ?? event.type,
      route: false,
      tone: status === 'failed' ? 'error' : 'normal',
    };
  }
  if (event.type === 'message.delivered') {
    return {
      ...logBase(event),
      title: `message delivered${to ? ` → ${actorLabel(agentMap, to)}` : ''}`,
      detail: messageId ?? event.type,
      route: false,
      tone: 'normal',
    };
  }
  if (event.type === 'message.sent' && event.payload.internal === true) {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, event.actor)} 지시 수신 처리`,
      detail: summary ?? '내부 이벤트',
      body: interventionPreview,
      route: false,
      tone: 'normal',
    };
  }
  if (event.type === 'message.sent' && event.payload.adapterRun === true) {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, event.actor)} adapter output`,
      detail: [adapter, durationMs ? `${durationMs}ms` : undefined].filter(Boolean).join(' · ') || event.type,
      body: summary,
      route: false,
      tone: 'normal',
    };
  }
  if (event.type === 'error') {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, event.actor)} error`,
      detail: errorMessage ?? event.type,
      route: false,
      tone: 'error',
    };
  }
  if (event.type === 'continuation.injected' || event.type === 'continuation.max_iterations_reached') {
    return {
      ...logBase(event),
      title: event.type === 'continuation.injected' ? 'auto continuation injected' : 'auto continuation stopped',
      detail: eventPayloadText(event, 'reason') ?? eventPayloadText(event, 'messageId') ?? event.type,
      route: false,
      tone: event.type === 'continuation.max_iterations_reached' ? 'error' : 'route',
    };
  }
  if (event.type === 'session.created' || event.type === 'session.prompt_injected' || event.type === 'session.output_captured' || event.type === 'session.restarted') {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, event.actor)} ${event.type.replace('session.', 'session ')}`,
      detail: [tmuxSession, tmuxPane].filter(Boolean).join(' · ') || event.type,
      route: false,
      tone: event.type === 'session.restarted' ? 'route' : 'normal',
    };
  }
  if (event.type === 'artifact.updated') {
    return {
      ...logBase(event),
      title: 'artifact updated',
      detail: artifact ?? 'final-report.md',
      route: false,
      tone: 'normal',
    };
  }

  return {
    ...logBase(event),
    title: event.type,
    detail: event.actor,
    route: false,
    tone: 'normal',
  };
}

function agentSituation(agent: AgentState): string {
  if (agent.status === 'thinking') return '현재 응답을 생성하거나 CLI 작업을 수행하는 중입니다.';
  if (agent.status === 'waiting') return '다른 에이전트나 사용자 입력을 기다리는 중입니다.';
  if (agent.status === 'blocked') return '진행을 막는 조건이 있어 후속 지시가 필요합니다.';
  if (agent.status === 'done') return '맡은 역할의 작업을 완료했습니다.';
  if (agent.status === 'failed') return '실행 중 오류가 발생했습니다. 최근 이벤트와 메시지를 확인하세요.';
  return '아직 작업을 시작하지 않았거나 다음 차례를 기다리는 중입니다.';
}

function isRunInProgress(status: RunState['run']['status']): boolean {
  return status === 'created' || status === 'running' || status === 'paused';
}

function runProgressLabel(runState: RunState, latestEvent?: RunEvent): string {
  const activeAgent = runState.agents.find((agent) => agent.status === 'thinking' || agent.status === 'waiting');
  if (activeAgent) return `${activeAgent.displayName} 작업 중`;
  if (latestEvent?.actor && runState.agents.some((agent) => agent.id === latestEvent.actor)) {
    return `${actorLabel(new Map(runState.agents.map((agent) => [agent.id, agent])), latestEvent.actor)} 최근 작업`;
  }
  if (runState.run.status === 'created') return '에이전트 작업 준비 중';
  if (runState.run.status === 'paused') return '작업 일시정지 상태';
  return '에이전트 작업 진행 중';
}

export function ChatRoom({ initialState, runId, onNewChat, onRunUpdated, variant = 'page' }: ChatRoomProps) {
  const [runState, setRunState] = useState(initialState);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [artifact, setArtifact] = useState('');
  const [showArtifact, setShowArtifact] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [body, setBody] = useState('');
  const [controlStatus, setControlStatus] = useState('');
  const restoredUiStateRef = useRef(false);

  const agentMap = useMemo(() => new Map(runState.agents.map((agent) => [agent.id, agent])), [runState.agents]);
  const latestEvent = events.at(-1);
  const orderedAgents = useMemo(
    () => [...runState.agents].sort((left, right) => agentPanelOrder(left) - agentPanelOrder(right)),
    [runState.agents],
  );
  const agentRouteCount = useMemo(
    () => messages.filter((message) => isAgentToAgentMessage(message, agentMap)).length,
    [messages, agentMap],
  );
  const processLogs = useMemo(
    () => events.map((event) => processLogFromEvent(event, agentMap)).reverse(),
    [events, agentMap],
  );
  const selectedLog = useMemo(
    () => processLogs.find((log) => log.id === selectedLogId || log.messageId === selectedLogId) ?? null,
    [processLogs, selectedLogId],
  );
  const runInProgress = isRunInProgress(runState.run.status);
  const progressLabel = runProgressLabel(runState, latestEvent);
  const continuation = runState.continuation;

  useEffect(() => {
    const saved = readChatRoomUiState(runId);
    if (saved.selectedLogId !== undefined) setSelectedLogId(saved.selectedLogId);
    if (saved.showArtifact !== undefined) setShowArtifact(saved.showArtifact);
    if (saved.showLogs !== undefined) setShowLogs(saved.showLogs);
    if (saved.body !== undefined) setBody(saved.body);
    restoredUiStateRef.current = true;
  }, [runId]);

  useEffect(() => {
    if (!restoredUiStateRef.current) return;
    writeChatRoomUiState(runId, {
      selectedLogId,
      showArtifact,
      showLogs,
      body,
    });
  }, [body, runId, selectedLogId, showArtifact, showLogs]);

  useEffect(() => {
    const clientSessionId = readClientSessionId();
    if (!clientSessionId) return;
    void fetch(`/api/sessions/${encodeURIComponent(clientSessionId)}/active-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
    }).catch(() => undefined);
  }, [runId]);

  async function refreshSnapshot() {
    const response = await fetch(`/api/runs/${runId}`, { cache: 'no-store' });
    const data = (await response.json()) as unknown;
    if (!response.ok || !isRunSnapshot(data)) return;
    setRunState(data.state);
    setEvents(data.events);
    setMessages((current) => upsertMessages(current, data.messages));
    setArtifact(data.artifact ?? '');
  }

  useEffect(() => {
    void refreshSnapshot();
    const timer = setInterval(() => void refreshSnapshot(), 1500);
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (eventMessage) => {
      const event = JSON.parse(eventMessage.data) as RunEvent;
      setEvents((current) => (current.some((item) => item.id === event.id) ? current : [...current, event]));
      const message = messageFromEvent(event);
      if (message) setMessages((current) => upsertMessages(current, [message]));
      if (event.type === 'artifact.updated' || event.type === 'run.completed' || event.type === 'run.stale' || event.type === 'error') {
        void refreshSnapshot().then(() => onRunUpdated?.());
      }
    };
    return () => {
      clearInterval(timer);
      source.close();
    };
  }, [onRunUpdated, runId]);

  useEffect(() => {
    if (!selectedLogId) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedLogId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedLogId]);

  async function sendChatMessage() {
    if (!body.trim() || runInProgress) return;
    setControlStatus('Agents에게 요청을 전달하는 중...');
    const response = await fetch(`/api/runs/${runId}/interventions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'all', body, priority: 'normal' }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setControlStatus(data?.error?.message ?? '요청 전송 실패');
      return;
    }
    setBody('');
    setControlStatus('Agents가 답변을 생성하고 있습니다.');
    await refreshSnapshot();
    onRunUpdated?.();
  }

  async function stopRun() {
    if (!runInProgress) return;
    setControlStatus('취소 요청 중...');
    const response = await fetch(`/api/runs/${runId}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setControlStatus(data?.error?.message ?? '취소 실패');
      return;
    }
    setControlStatus('작업을 취소했습니다.');
    await refreshSnapshot();
    onRunUpdated?.();
  }


  return (
    <main className={`chat-shell ${variant === 'embedded' ? 'embedded' : ''}`}>
      <section className="chat-app">
        <header className="chat-topbar">
          <div>
            <span className="kicker">AgentBoard Chat</span>
            <h1>{runState.run.title}</h1>
            <p>{runState.run.brief}</p>
          </div>
          <div className="chat-topbar-actions">
            <span className={`badge ${runState.run.status}`}>{runState.run.status}</span>
            {runInProgress ? <span className="badge progress-badge active">{progressLabel}</span> : null}
            {continuation?.enabled && continuation.iteration > 0 ? (
              <span className="badge continuation-badge">auto-loop {continuation.iteration}/{continuation.maxIterations}</span>
            ) : null}
            <span className={`badge ${connected ? 'completed' : ''}`}>{connected ? 'live' : 'reconnecting'}</span>
            <button className="badge badge-button" type="button" onClick={() => setShowLogs((current) => !current)}>
              {showLogs ? 'Logs 닫기' : `Logs ${processLogs.length}`}
            </button>
            {artifact ? (
              <button className="badge badge-button" type="button" onClick={() => setShowArtifact((current) => !current)}>
                {showArtifact ? '보고서 닫기' : '보고서 보기'}
              </button>
            ) : null}
            {onNewChat ? (
              <button className="badge badge-button" onClick={onNewChat} type="button">새 대화</button>
            ) : (
              <Link className="badge" href="/">새 대화</Link>
            )}
          </div>
        </header>

        {showLogs ? (
          <aside className="logs-drawer" aria-label="에이전트 전달 로그">
            <div className="logs-drawer-header">
              <div>
                <span className="kicker">Process Logs</span>
                <h2>Agent handoff logs</h2>
                <p>에이전트 간 전달 {agentRouteCount}건 · 전체 이벤트 {processLogs.length}건</p>
              </div>
              <button className="secondary" type="button" onClick={() => setShowLogs(false)}>닫기</button>
            </div>
            {processLogs.length ? (
              <ol className="process-log-list">
                {processLogs.map((log) => (
                  <li className={`process-log-item ${log.tone}`} key={log.id}>
                    <button
                      className="process-log-trigger"
                      onClick={() => setSelectedLogId(log.id)}
                      type="button"
                    >
                      <span>{formatTime(log.createdAt)}</span>
                      <strong>{log.title}</strong>
                      <em>{log.detail}</em>
                      {log.body ? <p>{log.body}</p> : null}
                      <small>전체 보기</small>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-log">아직 기록된 로그가 없습니다.</p>
            )}
          </aside>
        ) : null}

        {selectedLog ? (
          <div className="log-modal-backdrop" onClick={() => setSelectedLogId(null)} role="presentation">
            <section
              aria-labelledby="log-modal-title"
              aria-modal="true"
              className={`log-modal ${selectedLog.tone}`}
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <header className="log-modal-header">
                <div>
                  <span className="kicker">Log Detail</span>
                  <h2 id="log-modal-title">{selectedLog.title}</h2>
                  <p>{formatTime(selectedLog.createdAt)} · {selectedLog.eventType}</p>
                </div>
                <button className="secondary" onClick={() => setSelectedLogId(null)} type="button">닫기</button>
              </header>

              <dl className="log-modal-meta">
                <div>
                  <dt>Actor</dt>
                  <dd>{actorLabel(agentMap, selectedLog.actor)}</dd>
                </div>
                <div>
                  <dt>Detail</dt>
                  <dd>{selectedLog.detail}</dd>
                </div>
                <div>
                  <dt>Route</dt>
                  <dd>{selectedLog.route ? 'agent → agent' : 'system/user-facing'}</dd>
                </div>
                <div>
                  <dt>Log ID</dt>
                  <dd>{selectedLog.id}</dd>
                </div>
              </dl>

              {selectedLog.body ? (
                <section className="log-modal-section">
                  <h3>Message body</h3>
                  <pre>{selectedLog.body}</pre>
                </section>
              ) : null}

              <section className="log-modal-section">
                <h3>Raw payload</h3>
                <pre>{selectedLog.payload || '{}'}</pre>
              </section>
            </section>
          </div>
        ) : null}

        <section className="agent-board-grid" aria-label="에이전트별 협업 상황판">
          {orderedAgents.map((agent) => {
            const panelMessages = messages.filter((message) => isAgentPanelMessage(message, agent.id)).slice(-16);
            const latestAssignment = messages
              .filter((message) => message.from === 'orchestrator' && message.to === agent.id && message.kind === 'instruction')
              .at(-1);
            const sentCount = messages.filter((message) => message.from === agent.id).length;
            const receivedCount = messages.filter((message) => message.to === agent.id).length;
            const isWorking = agent.status === 'thinking' || agent.status === 'waiting';
            const session = runState.sessions?.[agent.role];

            return (
              <article className={`agent-panel ${agent.role} ${agent.status}`} key={agent.id}>
                <header className="agent-panel-header">
                  <div>
                    <span className="kicker">{agent.role}</span>
                    <h2>{agent.displayName}</h2>
                  </div>
                  <span className={`agent-status-pill ${agent.status}`}>{agent.status}</span>
                </header>

                <p className="agent-panel-situation">{agentSituation(agent)}</p>

                <dl className="agent-panel-meta">
                  <div>
                    <dt>Adapter</dt>
                    <dd>{agent.adapter}</dd>
                  </div>
                  <div>
                    <dt>Sent</dt>
                    <dd>{sentCount}</dd>
                  </div>
                  <div>
                    <dt>Received</dt>
                    <dd>{receivedCount}</dd>
                  </div>
                  <div>
                    <dt>Last</dt>
                    <dd>{formatTime(agent.lastMessageAt)}</dd>
                  </div>
                  <div>
                    <dt>Session</dt>
                    <dd>{session ? `${session.transport} · ${session.status}` : 'none'}</dd>
                  </div>
                </dl>

                {latestAssignment ? (
                  <button
                    className="assignment-card"
                    onClick={() => setSelectedLogId(latestAssignment.id)}
                    type="button"
                  >
                    <span>Orchestrator assigned</span>
                    <strong>{actorLabel(agentMap, latestAssignment.to)}에게 전달된 작업</strong>
                    <p>{latestAssignment.body}</p>
                  </button>
                ) : null}

                <div className="agent-panel-feed" aria-label={`${agent.displayName} 메시지`}>
                  {panelMessages.length ? (
                    panelMessages.map((message) => (
                      <button
                        className={panelMessageClass(agent.id, message)}
                        key={message.id}
                        onClick={() => setSelectedLogId(message.id)}
                        type="button"
                      >
                        <span>{formatTime(message.createdAt)} · {message.kind}</span>
                        <strong>{panelMessageTitle(agent.id, message, agentMap)}</strong>
                        <p>{message.body}</p>
                      </button>
                    ))
                  ) : (
                    <div className="agent-panel-empty">
                      <strong>아직 메시지가 없습니다.</strong>
                      <p>{agent.role === 'orchestrator' ? '사용자 요청을 받으면 라우팅 결정과 배정 메시지가 여기에 표시됩니다.' : 'Orchestrator가 이 Agent에게 작업을 배정하면 여기에 표시됩니다.'}</p>
                    </div>
                  )}

                  {isWorking ? (
                    <div className="agent-panel-working">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <p>{agent.displayName} 작업 중</p>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>

        <footer className="chat-composer-bar">
          {showArtifact && artifact ? (
            <section className="artifact-drawer" aria-label="최종 보고서">
              <div className="artifact-drawer-header">
                <span>final-report.md</span>
                <button className="secondary" type="button" onClick={() => setShowArtifact(false)}>닫기</button>
              </div>
              <pre>{artifact}</pre>
            </section>
          ) : null}
          <div className="composer-target-row">
            <span className={`run-progress-indicator ${runInProgress ? 'active' : ''}`}>
              {runInProgress ? progressLabel : latestEvent ? `마지막 이벤트: ${latestEvent.type}` : 'Orchestrator에게 다음 요청을 보낼 수 있습니다.'}
            </span>
            <span>{runInProgress ? '답변 생성 중에는 전송이 잠깁니다.' : 'Enter는 줄바꿈, ⌘/Ctrl + Enter는 전송'}</span>
          </div>
          <div className="chat-input-row active-run-controls">
            <textarea
              aria-label="Agents에게 보낼 메시지"
              disabled={runInProgress}
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void sendChatMessage();
                }
              }}
              placeholder={runInProgress ? `${progressLabel}입니다. 각 Agent 패널과 Logs를 확인하거나 취소할 수 있습니다.` : 'Orchestrator에게 요청하세요. 예: Planner에게 요구사항을 먼저 정리하게 해줘.'}
              value={runInProgress ? '' : body}
            />
            {runInProgress ? (
              <button className="danger" onClick={() => void stopRun()} type="button">취소</button>
            ) : (
              <button disabled={!body.trim()} onClick={() => void sendChatMessage()} type="button">전송</button>
            )}
          </div>
          {controlStatus ? <p className="composer-status">{controlStatus}</p> : null}
        </footer>
      </section>
    </main>
  );
}
