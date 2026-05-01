export type RunStatus = 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'stale';
export type RunMode = 'mock' | 'cli';
export type AgentRole = 'orchestrator' | 'planner' | 'engineer' | 'reviewer';
export type AgentStatus = 'idle' | 'thinking' | 'waiting' | 'blocked' | 'done' | 'failed';
export type AgentAdapterKind = 'mock' | 'codex' | 'tmux-codex';
export type AgentSessionStatus = 'starting' | 'attached' | 'idle' | 'running' | 'completed' | 'blocked' | 'dead';

export type MessageKind =
  | 'instruction'
  | 'question'
  | 'answer'
  | 'progress'
  | 'result'
  | 'review'
  | 'user_intervention'
  | 'ack'
  | 'error';

export type EventType =
  | 'run.created'
  | 'run.started'
  | 'run.completed'
  | 'run.stale'
  | 'continuation.injected'
  | 'continuation.max_iterations_reached'
  | 'user.intervention_queued'
  | 'intervention.decision_made'
  | 'session.created'
  | 'session.prompt_injected'
  | 'session.output_captured'
  | 'session.completed'
  | 'session.completion_timeout'
  | 'session.restarted'
  | 'approval.requested'
  | 'approval.approved'
  | 'approval.rejected'
  | 'agent.started'
  | 'agent.status_changed'
  | 'message.sent'
  | 'message.delivered'
  | 'artifact.updated'
  | 'user.intervened'
  | 'control.paused'
  | 'control.resumed'
  | 'control.stopped'
  | 'error';

export interface Run {
  id: string;
  title: string;
  brief: string;
  status: RunStatus;
  mode: RunMode;
  clientSessionId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  staleReason?: string;
}

export interface AgentState {
  id: string;
  role: AgentRole;
  displayName: string;
  adapter: AgentAdapterKind;
  status: AgentStatus;
  currentTaskId?: string;
  lastMessageAt?: string;
}

export interface AgentMessage {
  id: string;
  runId: string;
  from: string;
  to: string;
  kind: MessageKind;
  body: string;
  correlationId?: string;
  requiresAck?: boolean;
  createdAt: string;
  deliveredAt?: string;
  ackedAt?: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface Artifact {
  id: string;
  runId: string;
  title: string;
  path: string;
  mimeType: 'text/markdown' | 'application/json';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContinuationState {
  enabled: boolean;
  iteration: number;
  maxIterations: number;
  idleTimeoutMs: number;
  lastInjectedAt?: string;
  reason?: string;
  completedAt?: string;
}

export interface AgentSessionHandle {
  role: AgentRole;
  adapter: AgentAdapterKind;
  transport: 'tmux';
  tmuxSession: string;
  tmuxWindow: string;
  tmuxPane: string;
  command: string;
  status: AgentSessionStatus;
  startedAt: string;
  updatedAt: string;
  lastInjectedAt?: string;
  lastCapturedAt?: string;
  lastCompletedAt?: string;
}

export interface RunState {
  run: Run;
  agents: AgentState[];
  latestArtifact?: Artifact;
  continuation?: ContinuationState;
  sessions?: Partial<Record<AgentRole, AgentSessionHandle>>;
}

export interface ClientSessionRunSummary {
  runId: string;
  title: string;
  status: RunStatus;
  mode: RunMode;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ClientSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  activeRunId?: string;
  recentRunIds: string[];
  runs: ClientSessionRunSummary[];
}

export interface ClientSessionSnapshot {
  session: ClientSession;
  activeRun?: ClientSessionRunSummary;
  recentRuns: ClientSessionRunSummary[];
  staleRunIds: string[];
}

export interface CreateRunInput {
  title?: string;
  brief: string;
  mode?: RunMode;
  agents?: AgentRole[];
  clientSessionId?: string;
}

export interface InterventionInput {
  to: string;
  body: string;
  priority?: 'low' | 'normal' | 'high';
}
