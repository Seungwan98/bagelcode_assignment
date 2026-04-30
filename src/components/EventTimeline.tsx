'use client';

import { useEffect, useState } from 'react';
import type { RunEvent } from '@/lib/protocol/types';

export function EventTimeline({ runId }: { runId: string }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/runs/${runId}`)
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setEvents(data.events ?? []);
      })
      .catch(() => undefined);

    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setEvents((current) => (current.some((item) => item.id === event.id) ? current : [...current, event]));
    };
    return () => {
      cancelled = true;
      source.close();
    };
  }, [runId]);

  return (
    <div className="card stack">
      <div className="row">
        <h2>Event Timeline</h2>
        <span className={`badge ${connected ? 'completed' : ''}`}>{connected ? 'SSE connected' : 'connecting'}</span>
      </div>
      <div className="timeline">
        {events.map((event) => (
          <div className="event" key={event.id}>
            <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
            <strong>{event.type}</strong>
            <span className="badge">actor: {event.actor}</span>
            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
          </div>
        ))}
        {!events.length ? <p>아직 이벤트가 없습니다.</p> : null}
      </div>
    </div>
  );
}
