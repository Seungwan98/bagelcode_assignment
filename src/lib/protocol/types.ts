export type RunStatus = 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
export type RunMode = 'mock' | 'cli';
export type AgentRole = 'planner' | 'engineer' | 'reviewer';
export type AgentStatus = 'idle' | 'thinking' | 'waiting' | 'blocked' | 'done' | 'failed';
export type AgentAdapterKind = 'mock' | 'codex';

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
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
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

export interface RunState {
  run: Run;
  agents: AgentState[];
  latestArtifact?: Artifact;
}

export interface CreateRunInput {
  title?: string;
  brief: string;
  mode?: RunMode;
  agents?: AgentRole[];
}

export interface InterventionInput {
  to: string;
  body: string;
  priority?: 'low' | 'normal' | 'high';
}
