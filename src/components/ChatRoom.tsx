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

export function ChatRoom({ initialState, runId }: { initialState: RunState; runId: string }) {
  const [runState, setRunState] = useState(initialState);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [artifact, setArtifact] = useState('');
  const [connected, setConnected] = useState(false);
  const [to, setTo] = useState('engineer');
  const [body, setBody] = useState('');
  const [sendStatus, setSendStatus] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);

  const agentMap = useMemo(() => new Map(runState.agents.map((agent) => [agent.id, agent])), [runState.agents]);
  const latestEvent = events.at(-1);

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
  }, [messages.length, artifact, runState.run.status]);

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
    setSendStatus(`전송 완료: ${data.messageId}`);
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
            <Link className="badge" href="/">새 대화</Link>
          </div>
        </header>

        <div className="agent-rail" aria-label="에이전트 상태">
          {runState.agents.map((agent) => (
            <div className="agent-pill" key={agent.id}>
              <strong>{agent.displayName}</strong>
              <span>{agent.adapter} · {agent.status}</span>
            </div>
          ))}
        </div>

        <div className="chat-transcript" ref={transcriptRef}>
          <div className="chat-bubble system">
            <span className="bubble-meta">system · run.created</span>
            <p>협업 대화가 시작되었습니다. 에이전트 메시지와 사용자 개입이 이 대화창에 순서대로 표시됩니다.</p>
          </div>

          {messages.map((message) => (
            <article className={bubbleClass(message)} key={message.id}>
              <span className="bubble-meta">{messageHint(message, agentMap)} · {new Date(message.createdAt).toLocaleTimeString()}</span>
              <p>{message.body}</p>
            </article>
          ))}

          {artifact ? (
            <article className="chat-bubble artifact">
              <span className="bubble-meta">artifact · final-report.md</span>
              <pre>{artifact}</pre>
            </article>
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
