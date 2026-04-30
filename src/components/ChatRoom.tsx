'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentMessage, AgentState, RunEvent, RunState } from '@/lib/protocol/types';

interface RunSnapshot {
  ok: true;
  state: RunState;
  events: RunEvent[];
  messages: AgentMessage[];
  artifact: string;
}

interface ProcessLogEntry {
  id: string;
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

interface ChatRoomUiState {
  selectedAgentId?: string;
  selectedLogId?: string | null;
  showArtifact?: boolean;
  showLogs?: boolean;
  to?: string;
  body?: string;
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
      selectedAgentId: typeof parsed.selectedAgentId === 'string' ? parsed.selectedAgentId : undefined,
      selectedLogId: typeof parsed.selectedLogId === 'string' || parsed.selectedLogId === null ? parsed.selectedLogId : undefined,
      showArtifact: typeof parsed.showArtifact === 'boolean' ? parsed.showArtifact : undefined,
      showLogs: typeof parsed.showLogs === 'boolean' ? parsed.showLogs : undefined,
      to: typeof parsed.to === 'string' ? parsed.to : undefined,
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

function bubbleClass(message: AgentMessage): string {
  if (message.from === 'user') return 'chat-bubble user';
  if (message.kind === 'ack') return 'chat-bubble ack';
  if (message.kind === 'error') return 'chat-bubble error';
  return 'chat-bubble agent';
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

function isTranscriptMessage(message: AgentMessage, agentMap: Map<string, AgentState>): boolean {
  return !isAgentToAgentMessage(message, agentMap) && !isOperationalAck(message, agentMap);
}

function formatTime(value?: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleTimeString();
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
    return {
      ...logBase(event),
      title: ack ? `${actorLabel(agentMap, message.from)} 지시 수신 처리` : messageHint(message, agentMap),
      detail: ack ? '내부 확인' : event.type,
      body: ack ? undefined : message.body,
      route,
      tone: route ? 'route' : message.kind === 'error' ? 'error' : 'normal',
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
  if (event.type === 'error') {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, event.actor)} error`,
      detail: errorMessage ?? event.type,
      route: false,
      tone: 'error',
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

export function ChatRoom({ initialState, runId }: { initialState: RunState; runId: string }) {
  const [runState, setRunState] = useState(initialState);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [artifact, setArtifact] = useState('');
  const [showArtifact, setShowArtifact] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState(initialState.agents[0]?.id ?? 'planner');
  const [connected, setConnected] = useState(false);
  const [to, setTo] = useState('engineer');
  const [body, setBody] = useState('');
  const [sendStatus, setSendStatus] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);
  const restoredUiStateRef = useRef(false);

  const agentMap = useMemo(() => new Map(runState.agents.map((agent) => [agent.id, agent])), [runState.agents]);
  const selectedAgent = agentMap.get(selectedAgentId) ?? runState.agents[0];
  const latestEvent = events.at(-1);
  const selectedAgentMessages = useMemo(
    () => messages
      .filter((message) => message.kind !== 'ack' && (message.from === selectedAgentId || message.to === selectedAgentId))
      .slice(-4)
      .reverse(),
    [messages, selectedAgentId],
  );
  const selectedAgentEvents = useMemo(
    () => events
      .filter((event) => {
        if (event.actor === selectedAgentId) return true;
        const message = messageFromEvent(event);
        return message?.from === selectedAgentId || message?.to === selectedAgentId;
      })
      .slice(-3)
      .reverse(),
    [events, selectedAgentId],
  );
  const selectedSentCount = useMemo(
    () => messages.filter((message) => message.from === selectedAgentId).length,
    [messages, selectedAgentId],
  );
  const selectedReceivedCount = useMemo(
    () => messages.filter((message) => message.to === selectedAgentId).length,
    [messages, selectedAgentId],
  );
  const visibleMessages = useMemo(
    () => messages.filter((message) => isTranscriptMessage(message, agentMap)),
    [messages, agentMap],
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
    () => processLogs.find((log) => log.id === selectedLogId) ?? null,
    [processLogs, selectedLogId],
  );

  useEffect(() => {
    const saved = readChatRoomUiState(runId);
    if (saved.selectedAgentId && initialState.agents.some((agent) => agent.id === saved.selectedAgentId)) {
      setSelectedAgentId(saved.selectedAgentId);
    }
    if (saved.selectedLogId !== undefined) setSelectedLogId(saved.selectedLogId);
    if (saved.showArtifact !== undefined) setShowArtifact(saved.showArtifact);
    if (saved.showLogs !== undefined) setShowLogs(saved.showLogs);
    if (saved.to && (saved.to === 'all' || initialState.agents.some((agent) => agent.id === saved.to))) {
      setTo(saved.to);
    }
    if (saved.body !== undefined) setBody(saved.body);
    restoredUiStateRef.current = true;
  }, [initialState.agents, runId]);

  useEffect(() => {
    if (!restoredUiStateRef.current) return;
    writeChatRoomUiState(runId, {
      selectedAgentId,
      selectedLogId,
      showArtifact,
      showLogs,
      to,
      body,
    });
  }, [body, runId, selectedAgentId, selectedLogId, showArtifact, showLogs, to]);

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
      if (event.type === 'artifact.updated' || event.type === 'run.completed' || event.type === 'error') void refreshSnapshot();
    };
    return () => {
      clearInterval(timer);
      source.close();
    };
  }, [runId]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, runState.run.status]);

  useEffect(() => {
    if (!runState.agents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(runState.agents[0]?.id ?? 'planner');
    }
  }, [runState.agents, selectedAgentId]);

  useEffect(() => {
    if (!selectedLogId) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedLogId(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedLogId]);

  async function sendIntervention() {
    if (!body.trim()) return;
    setSendStatus('전송 중...');
    const response = await fetch(`/api/runs/${runId}/interventions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, body, priority: 'normal' }),
    });
    const data = await response.json();
    if (!response.ok) {
      setSendStatus(data?.error?.message ?? '전송 실패');
      return;
    }
    setBody('');
    setSendStatus('전송 완료');
    await refreshSnapshot();
  }

  return (
    <main className="chat-shell">
      <section className="chat-app">
        <header className="chat-topbar">
          <div>
            <span className="kicker">AgentBoard Chat</span>
            <h1>{runState.run.title}</h1>
            <p>{runState.run.brief}</p>
          </div>
          <div className="chat-topbar-actions">
            <span className={`badge ${runState.run.status}`}>{runState.run.status}</span>
            <span className={`badge ${connected ? 'completed' : ''}`}>{connected ? 'live' : 'reconnecting'}</span>
            <button className="badge badge-button" type="button" onClick={() => setShowLogs((current) => !current)}>
              {showLogs ? 'Logs 닫기' : `Logs ${processLogs.length}`}
            </button>
            {artifact ? (
              <button className="badge badge-button" type="button" onClick={() => setShowArtifact((current) => !current)}>
                {showArtifact ? '보고서 닫기' : '보고서 보기'}
              </button>
            ) : null}
            <Link className="badge" href="/">새 대화</Link>
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

        <div className="agent-rail" aria-label="에이전트 상태">
          {runState.agents.map((agent) => (
            <button
              aria-pressed={selectedAgentId === agent.id}
              className={`agent-pill ${selectedAgentId === agent.id ? 'selected' : ''}`}
              key={agent.id}
              onClick={() => setSelectedAgentId(agent.id)}
              type="button"
            >
              <strong>{agent.displayName}</strong>
              <span>{agent.adapter} · {agent.status}</span>
            </button>
          ))}
        </div>

        {selectedAgent ? (
          <section className={`agent-detail-panel ${selectedAgent.status}`} aria-live="polite">
            <div className="agent-detail-summary">
              <span className="kicker">Selected Agent</span>
              <h2>{selectedAgent.displayName}</h2>
              <p>{agentSituation(selectedAgent)}</p>
            </div>
            <dl className="agent-detail-stats">
              <div>
                <dt>Status</dt>
                <dd>{selectedAgent.status}</dd>
              </div>
              <div>
                <dt>Adapter</dt>
                <dd>{selectedAgent.adapter}</dd>
              </div>
              <div>
                <dt>Sent</dt>
                <dd>{selectedSentCount}</dd>
              </div>
              <div>
                <dt>Received</dt>
                <dd>{selectedReceivedCount}</dd>
              </div>
              <div>
                <dt>Last message</dt>
                <dd>{formatTime(selectedAgent.lastMessageAt)}</dd>
              </div>
            </dl>
            <div className="agent-detail-feed">
              <div>
                <strong>최근 메시지</strong>
                {selectedAgentMessages.length ? (
                  <ul>
                    {selectedAgentMessages.map((message) => (
                      <li key={message.id}>
                        <span>{messageHint(message, agentMap)} · {formatTime(message.createdAt)}</span>
                        <p>{message.body}</p>
                      </li>
                    ))}
                  </ul>
                ) : <p>아직 이 에이전트의 메시지가 없습니다.</p>}
              </div>
              <div>
                <strong>최근 이벤트</strong>
                {selectedAgentEvents.length ? (
                  <ul>
                    {selectedAgentEvents.map((event) => (
                      <li key={event.id}>
                        <span>{event.type} · {formatTime(event.createdAt)}</span>
                        <p>{event.actor}</p>
                      </li>
                    ))}
                  </ul>
                ) : <p>아직 이 에이전트의 이벤트가 없습니다.</p>}
              </div>
            </div>
          </section>
        ) : null}

        <div className="chat-transcript" ref={transcriptRef}>
          <div className="chat-bubble system">
            <span className="bubble-meta">system · run.created</span>
            <p>협업 대화가 시작되었습니다. 사용자에게 직접 보이는 메시지는 이 대화창에, 에이전트 간 전달 과정은 우측 상단 Logs에 표시됩니다.</p>
          </div>

          {visibleMessages.map((message) => (
            <article className={bubbleClass(message)} key={message.id}>
              <span className="bubble-meta">{messageHint(message, agentMap)} · {new Date(message.createdAt).toLocaleTimeString()}</span>
              <p>{message.body}</p>
            </article>
          ))}

          {!visibleMessages.length && messages.length ? (
            <div className="chat-bubble system">
              <span className="bubble-meta">system · process logs</span>
              <p>에이전트 간 전달 과정은 우측 상단 Logs 버튼에서 확인할 수 있습니다.</p>
            </div>
          ) : null}

          {!messages.length ? (
            <div className="chat-bubble system typing">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
              <p>에이전트 응답을 기다리는 중입니다.</p>
            </div>
          ) : null}
        </div>

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
            <select value={to} onChange={(event) => setTo(event.target.value)} aria-label="메시지 대상">
              <option value="all">All Agents</option>
              {runState.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
            </select>
            <span>{latestEvent ? `마지막 이벤트: ${latestEvent.type}` : '이벤트 수신 대기 중'}</span>
          </div>
          <div className="chat-input-row">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="에이전트에게 지시를 입력하세요. 예: README 실행성을 우선해줘."
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void sendIntervention();
              }}
            />
            <button disabled={!body.trim()} onClick={() => void sendIntervention()}>전송</button>
          </div>
          {sendStatus ? <p className="composer-status">{sendStatus}</p> : null}
        </footer>
      </section>
    </main>
  );
}
