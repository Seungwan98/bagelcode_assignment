'use client';

import { useState } from 'react';
import type { AgentState } from '@/lib/protocol/types';

export function InterventionComposer({ runId, agents }: { runId: string; agents: AgentState[] }) {
  const [to, setTo] = useState('engineer');
  const [body, setBody] = useState('구현 범위를 ASAP MVP로 줄이고 README 실행성을 우선해줘.');
  const [status, setStatus] = useState('');

  async function send() {
    setStatus('전송 중...');
    const response = await fetch(`/api/runs/${runId}/interventions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, body, priority: 'normal' }),
    });
    const data = await response.json();
    setStatus(response.ok ? `전송 완료: ${data.messageId}` : data?.error?.message ?? '전송 실패');
  }

  return (
    <div className="card stack">
      <h2>User Intervention</h2>
      <div className="grid two">
        <label className="stack">
          <span>대상</span>
          <select value={to} onChange={(event) => setTo(event.target.value)}>
            <option value="all">all</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
          </select>
        </label>
        <label className="stack">
          <span>지시</span>
          <input value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
      </div>
      <button disabled={!body.trim()} onClick={send}>Send intervention</button>
      {status ? <p>{status}</p> : null}
    </div>
  );
}
