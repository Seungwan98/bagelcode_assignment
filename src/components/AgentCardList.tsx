import type { AgentState } from '@/lib/protocol/types';

export function AgentCardList({ agents }: { agents: AgentState[] }) {
  return (
    <div className="grid three">
      {agents.map((agent) => (
        <div className="card agent" key={agent.id}>
          <div className="row">
            <h3>{agent.displayName}</h3>
            <span className={`badge ${agent.status}`}>{agent.status}</span>
          </div>
          <span className="badge">role: {agent.role}</span>
          <p>adapter: {agent.adapter}</p>
          {agent.lastMessageAt ? <p>last: {new Date(agent.lastMessageAt).toLocaleTimeString()}</p> : null}
        </div>
      ))}
    </div>
  );
}
