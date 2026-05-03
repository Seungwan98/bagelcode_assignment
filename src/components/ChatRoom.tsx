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

interface WorkspaceFileEntry {
  path: string;
  size: number;
  updatedAt: string;
}

interface WorkspaceSnapshot {
  ok: true;
  files: WorkspaceFileEntry[];
}

interface WorkspaceFileSnapshot {
  ok: true;
  file: WorkspaceFileEntry & { content: string };
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

interface ApprovalCard {
  approvalId: string;
  eventId: string;
  role: AgentRole;
  createdAt: string;
  command: string;
  reason: string;
  choices: string[];
  status: 'pending' | 'approved' | 'rejected';
}

type AgentFeedItem =
  | { type: 'message'; id: string; createdAt: string; message: AgentMessage }
  | { type: 'approval'; id: string; createdAt: string; approval: ApprovalCard };

type LogFilter = 'all' | 'handoff' | 'approval' | 'error' | 'session';
type OutputTab = 'report' | 'messages' | 'workspace';

const CLIENT_SESSION_STORAGE_KEY = 'agentboard:clientSessionId';
const LEGACY_CLIENT_SESSION_STORAGE_KEYS = ['agentboard.clientSessionId', 'agentboard:client-session-id'];
const AGENT_PANEL_ORDER: AgentRole[] = ['orchestrator', 'planner', 'engineer', 'reviewer'];

interface ChatRoomUiState {
  selectedLogId?: string | null;
  showArtifact?: boolean;
  showLogs?: boolean;
  logFilter?: LogFilter;
  outputTab?: OutputTab;
  selectedWorkspacePath?: string;
  body?: string;
}

const LOG_FILTER_OPTIONS: Array<{ value: LogFilter; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'handoff', label: 'Agent 전달' },
  { value: 'approval', label: '권한 요청' },
  { value: 'error', label: '오류/timeout' },
  { value: 'session', label: 'tmux session' },
];

const OUTPUT_TABS: Array<{ value: OutputTab; label: string }> = [
  { value: 'report', label: 'Final Report' },
  { value: 'messages', label: 'Messages' },
  { value: 'workspace', label: 'Workspace' },
];

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
      logFilter: LOG_FILTER_OPTIONS.some((option) => option.value === parsed.logFilter) ? parsed.logFilter as LogFilter : undefined,
      outputTab: OUTPUT_TABS.some((tab) => tab.value === parsed.outputTab) ? parsed.outputTab as OutputTab : undefined,
      selectedWorkspacePath: typeof parsed.selectedWorkspacePath === 'string' ? parsed.selectedWorkspacePath : undefined,
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

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  return Boolean(value && typeof value === 'object' && 'ok' in value && (value as { ok: unknown }).ok === true && Array.isArray((value as { files?: unknown }).files));
}

function isWorkspaceFileSnapshot(value: unknown): value is WorkspaceFileSnapshot {
  return Boolean(value && typeof value === 'object' && 'ok' in value && (value as { ok: unknown }).ok === true && typeof (value as { file?: { content?: unknown } }).file?.content === 'string');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul',
  }).format(date);
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

function payloadStringArray(event: RunEvent, key: string): string[] {
  const value = event.payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function payloadAgentRole(event: RunEvent): AgentRole | undefined {
  const role = eventPayloadText(event, 'role');
  return AGENT_PANEL_ORDER.includes(role as AgentRole) ? role as AgentRole : undefined;
}

function approvalCardsForAgent(events: RunEvent[], role: AgentRole): ApprovalCard[] {
  const resolved = new Map<string, 'approved' | 'rejected'>();
  for (const event of events) {
    const approvalId = eventPayloadText(event, 'approvalId');
    if (!approvalId) continue;
    if (event.type === 'approval.approved') resolved.set(approvalId, 'approved');
    if (event.type === 'approval.rejected') resolved.set(approvalId, 'rejected');
  }
  return events
    .filter((event) => event.type === 'approval.requested' && payloadAgentRole(event) === role)
    .map((event) => {
      const approvalId = eventPayloadText(event, 'approvalId') ?? event.id;
      return {
        approvalId,
        eventId: event.id,
        role,
        createdAt: event.createdAt,
        command: eventPayloadText(event, 'command') ?? '승인이 필요한 명령',
        reason: eventPayloadText(event, 'reason') ?? 'Codex가 명령 실행 승인을 요청했습니다.',
        choices: payloadStringArray(event, 'choices'),
        status: resolved.get(approvalId) ?? 'pending',
      };
    });
}

function pendingApprovals(events: RunEvent[]): ApprovalCard[] {
  return AGENT_PANEL_ORDER.flatMap((role) => approvalCardsForAgent(events, role)).filter((approval) => approval.status === 'pending');
}

function latestApproval(cards: ApprovalCard[]): ApprovalCard | undefined {
  return [...cards].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)).at(-1);
}

function sortedAgentFeedItems(messages: AgentMessage[], approvals: ApprovalCard[], agentId: string, limit: number): AgentFeedItem[] {
  return [
    ...messages
      .filter((message) => isAgentPanelMessage(message, agentId))
      .map((message): AgentFeedItem => ({ type: 'message', id: message.id, createdAt: message.createdAt, message })),
    ...approvals.map((approval): AgentFeedItem => ({
      type: 'approval',
      id: approval.approvalId,
      createdAt: approval.createdAt,
      approval,
    })),
  ]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-limit);
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
  if (event.type === 'user.intervention_queued') {
    return {
      ...logBase(event),
      title: '사용자 개입 접수',
      detail: eventPayloadText(event, 'interventionMode') ?? eventPayloadText(event, 'messageId') ?? event.type,
      route: false,
      tone: 'route',
    };
  }
  if (event.type === 'intervention.decision_made') {
    const action = eventPayloadText(event, 'action');
    return {
      ...logBase(event),
      title: `Orchestrator 개입 판단${action ? ` · ${action}` : ''}`,
      detail: [eventPayloadText(event, 'target'), eventPayloadText(event, 'interventionCount')].filter(Boolean).join(' · ') || event.type,
      body: eventPayloadText(event, 'reason') ?? eventPayloadText(event, 'instruction') ?? eventPayloadText(event, 'question'),
      route: true,
      tone: action === 'ask_user' ? 'error' : 'route',
    };
  }
  if (event.type === 'approval.requested' || event.type === 'approval.approved' || event.type === 'approval.rejected') {
    const command = eventPayloadText(event, 'command');
    const approvalId = eventPayloadText(event, 'approvalId');
    const action = eventPayloadText(event, 'action');
    return {
      ...logBase(event),
      title: event.type === 'approval.requested'
        ? `${actorLabel(agentMap, event.actor)} 권한 요청`
        : `${actorLabel(agentMap, event.actor)} 권한 ${event.type === 'approval.approved' ? '승인' : '거절'}`,
      detail: [action, command, approvalId].filter(Boolean).join(' · ') || event.type,
      body: eventPayloadText(event, 'reason') ?? eventPayloadText(event, 'prompt'),
      route: false,
      tone: event.type === 'approval.rejected' ? 'error' : 'route',
    };
  }
  if (event.type === 'session.completed') {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, event.actor)} 완료 통보`,
      detail: [
        eventPayloadText(event, 'markerStatus') ?? 'complete',
        durationMs ? `${durationMs}ms` : undefined,
        tmuxSession,
        tmuxPane,
      ].filter(Boolean).join(' · ') || event.type,
      route: false,
      tone: eventPayloadText(event, 'markerStatus') === 'blocked' ? 'error' : 'normal',
    };
  }
  if (event.type === 'session.completion_timeout') {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, event.actor)} 완료 감지 timeout`,
      detail: [eventPayloadText(event, 'timeoutMs') ? `${eventPayloadText(event, 'timeoutMs')}ms` : undefined, tmuxSession, tmuxPane]
        .filter(Boolean)
        .join(' · ') || event.type,
      route: false,
      tone: 'error',
    };
  }
  if (event.type === 'session.prompt_submit_failed') {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, event.actor)} prompt submit 실패`,
      detail: [
        eventPayloadText(event, 'reason'),
        eventPayloadText(event, 'attempts') ? `${eventPayloadText(event, 'attempts')}회 시도` : undefined,
        tmuxSession,
        tmuxPane,
      ].filter(Boolean).join(' · ') || event.type,
      route: false,
      tone: 'error',
    };
  }
  if (event.type === 'session.prompt_submitted') {
    return {
      ...logBase(event),
      title: `${actorLabel(agentMap, event.actor)} prompt submit 확인`,
      detail: [
        eventPayloadText(event, 'confirmReason'),
        eventPayloadText(event, 'attempts') ? `${eventPayloadText(event, 'attempts')}회 시도` : undefined,
        tmuxSession,
        tmuxPane,
      ].filter(Boolean).join(' · ') || event.type,
      route: false,
      tone: 'normal',
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
      title: '실행 요약 갱신',
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

function logMatchesFilter(log: ProcessLogEntry, filter: LogFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'handoff') return log.route || (log.eventType === 'message.sent' && /→/.test(log.title));
  if (filter === 'approval') return log.eventType.startsWith('approval.');
  if (filter === 'error') return log.tone === 'error' || log.eventType === 'session.completion_timeout' || log.eventType === 'session.prompt_submit_failed';
  if (filter === 'session') return log.eventType.startsWith('session.');
  return true;
}

function isImplementationRequest(events: RunEvent[], messages: AgentMessage[], runState: RunState): boolean {
  const combined = [
    runState.run.brief,
    ...messages.map((message) => message.body),
    ...events.map((event) => stringifyPayload(event.payload)),
  ].join('\n');
  return /Deliverable Type:\s*implementation/i.test(combined)
    || /\bdeliverableType["']?\s*:\s*["']implementation/i.test(combined)
    || /(앱|웹|기능|코드).*(개발|구현|수정|추가)|implement|build|fix|code/i.test(runState.run.brief);
}

function currentBottleneckLabel(runState: RunState, latestEvent: RunEvent | undefined, pendingApprovalsCount: number, agentMap: Map<string, AgentState>): { label: string; tone: 'normal' | 'warning' | 'error' } {
  if (pendingApprovalsCount > 0) return { label: `Codex 권한 승인 대기 · ${pendingApprovalsCount}건`, tone: 'warning' };
  if (latestEvent?.type === 'session.prompt_submit_failed') return { label: `${actorLabel(agentMap, latestEvent.actor)} prompt submit 실패`, tone: 'error' };
  if (latestEvent?.type === 'session.completion_timeout') return { label: `${actorLabel(agentMap, latestEvent.actor)} 완료 감지 timeout`, tone: 'error' };
  if (latestEvent?.type === 'approval.requested') return { label: `${actorLabel(agentMap, latestEvent.actor)} 권한 승인 대기`, tone: 'warning' };
  if (latestEvent?.type === 'session.prompt_injected') return { label: `${actorLabel(agentMap, latestEvent.actor)} tmux prompt 주입 · 완료 marker 대기`, tone: 'warning' };
  if (latestEvent?.type === 'session.prompt_submitted') return { label: `${actorLabel(agentMap, latestEvent.actor)} tmux 실행 시작 확인`, tone: 'normal' };
  if (latestEvent?.type === 'session.output_captured') return { label: `${actorLabel(agentMap, latestEvent.actor)} tmux output 수집 중`, tone: 'normal' };
  if (latestEvent?.type === 'intervention.decision_made') return { label: 'Orchestrator 개입 판단 반영 중', tone: 'normal' };
  if (latestEvent?.type === 'continuation.injected') return { label: 'idle 감지 후 auto-loop prompt 주입', tone: 'warning' };

  const blockedAgent = runState.agents.find((agent) => agent.status === 'failed' || agent.status === 'blocked');
  if (blockedAgent) return { label: `${blockedAgent.displayName} ${blockedAgent.status}`, tone: 'error' };

  const activeAgent = runState.agents.find((agent) => agent.status === 'thinking' || agent.status === 'waiting');
  if (activeAgent) {
    const session = runState.sessions?.[activeAgent.role];
    if (session?.transport === 'tmux') return { label: `${activeAgent.displayName} tmux 응답 대기 · ${session.status}`, tone: activeAgent.status === 'waiting' ? 'warning' : 'normal' };
    return { label: `${activeAgent.displayName} 작업 중`, tone: 'normal' };
  }

  if (runState.run.status === 'created') return { label: 'Runner 시작 대기', tone: 'warning' };
  if (runState.run.status === 'completed') return { label: '완료됨', tone: 'normal' };
  if (runState.run.status === 'stale') return { label: 'stale · 서버/runner 중단 가능', tone: 'error' };
  return { label: runState.run.status, tone: 'normal' };
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
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const [outputTab, setOutputTab] = useState<OutputTab>('report');
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState('');
  const [workspaceFileContent, setWorkspaceFileContent] = useState('');
  const [workspaceStatus, setWorkspaceStatus] = useState('');
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [expandedAgentRole, setExpandedAgentRole] = useState<AgentRole | null>(null);
  const [connected, setConnected] = useState(false);
  const [body, setBody] = useState('');
  const [controlStatus, setControlStatus] = useState('');
  const [approvalActionStatus, setApprovalActionStatus] = useState<Record<string, string>>({});
  const restoredUiStateRef = useRef(false);
  const expandedFeedEndRef = useRef<HTMLDivElement | null>(null);
  const pendingApprovalFocusRef = useRef<string | null>(null);

  const agentMap = useMemo(() => new Map(runState.agents.map((agent) => [agent.id, agent])), [runState.agents]);
  const latestEvent = events.at(-1);
  const orderedAgents = useMemo(
    () => [...runState.agents].sort((left, right) => agentPanelOrder(left) - agentPanelOrder(right)),
    [runState.agents],
  );
  const expandedAgent = useMemo(
    () => orderedAgents.find((agent) => agent.role === expandedAgentRole) ?? null,
    [expandedAgentRole, orderedAgents],
  );
  const agentRouteCount = useMemo(
    () => messages.filter((message) => isAgentToAgentMessage(message, agentMap)).length,
    [messages, agentMap],
  );
  const processLogs = useMemo(
    () => events.map((event) => processLogFromEvent(event, agentMap)).reverse(),
    [events, agentMap],
  );
  const filteredProcessLogs = useMemo(
    () => processLogs.filter((log) => logMatchesFilter(log, logFilter)),
    [logFilter, processLogs],
  );
  const selectedLog = useMemo(
    () => processLogs.find((log) => log.id === selectedLogId || log.messageId === selectedLogId) ?? null,
    [processLogs, selectedLogId],
  );
  const pendingApprovalCards = useMemo(() => pendingApprovals(events), [events]);
  const latestPendingApproval = useMemo(() => latestApproval(pendingApprovalCards), [pendingApprovalCards]);
  const runInProgress = isRunInProgress(runState.run.status);
  const progressLabel = pendingApprovalCards.length ? '사용자 승인 대기' : runProgressLabel(runState, latestEvent);
  const bottleneck = useMemo(
    () => currentBottleneckLabel(runState, latestEvent, pendingApprovalCards.length, agentMap),
    [agentMap, latestEvent, pendingApprovalCards.length, runState],
  );
  const implementationRun = useMemo(() => isImplementationRequest(events, messages, runState), [events, messages, runState]);
  const continuation = runState.continuation;

  useEffect(() => {
    const saved = readChatRoomUiState(runId);
    if (saved.selectedLogId !== undefined) setSelectedLogId(saved.selectedLogId);
    if (saved.showArtifact !== undefined) setShowArtifact(saved.showArtifact);
    if (saved.showLogs !== undefined) setShowLogs(saved.showLogs);
    if (saved.logFilter !== undefined) setLogFilter(saved.logFilter);
    if (saved.outputTab !== undefined) setOutputTab(saved.outputTab);
    if (saved.selectedWorkspacePath !== undefined) setSelectedWorkspacePath(saved.selectedWorkspacePath);
    if (saved.body !== undefined) setBody(saved.body);
    restoredUiStateRef.current = true;
  }, [runId]);

  useEffect(() => {
    if (!restoredUiStateRef.current) return;
    writeChatRoomUiState(runId, {
      selectedLogId,
      showArtifact,
      showLogs,
      logFilter,
      outputTab,
      selectedWorkspacePath,
      body,
    });
  }, [body, logFilter, outputTab, runId, selectedLogId, selectedWorkspacePath, showArtifact, showLogs]);

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

  async function refreshWorkspace() {
    setWorkspaceStatus('workspace 파일 목록을 불러오는 중...');
    const response = await fetch(`/api/runs/${runId}/workspace`, { cache: 'no-store' });
    const data = (await response.json()) as unknown;
    if (!response.ok || !isWorkspaceSnapshot(data)) {
      setWorkspaceStatus('workspace 파일 목록을 불러오지 못했습니다.');
      return;
    }
    setWorkspaceFiles(data.files);
    setSelectedWorkspacePath((current) => (
      current && data.files.some((file) => file.path === current)
        ? current
        : data.files[0]?.path ?? ''
    ));
    setWorkspaceStatus(data.files.length ? '' : 'workspace 산출물이 아직 없습니다.');
  }

  useEffect(() => {
    void refreshSnapshot().catch(() => undefined);
    const timer = setInterval(() => void refreshSnapshot().catch(() => undefined), 1500);
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (eventMessage) => {
      const event = JSON.parse(eventMessage.data) as RunEvent;
      setEvents((current) => (current.some((item) => item.id === event.id) ? current : [...current, event]));
      const message = messageFromEvent(event);
      if (message) setMessages((current) => upsertMessages(current, [message]));
      if (event.type === 'artifact.updated' || event.type === 'run.completed' || event.type === 'run.stale' || event.type === 'error') {
        void refreshSnapshot().then(() => onRunUpdated?.()).catch(() => undefined);
      }
    };
    return () => {
      clearInterval(timer);
      source.close();
    };
  }, [onRunUpdated, runId]);

  useEffect(() => {
    if (!showArtifact || outputTab !== 'workspace') return;
    void refreshWorkspace().catch(() => setWorkspaceStatus('workspace 파일 목록을 불러오지 못했습니다.'));
  }, [events.length, outputTab, runId, showArtifact]);

  useEffect(() => {
    if (!showArtifact || outputTab !== 'workspace' || !selectedWorkspacePath) {
      setWorkspaceFileContent('');
      return;
    }
    let cancelled = false;
    setWorkspaceStatus('workspace 파일을 불러오는 중...');
    void fetch(`/api/runs/${runId}/workspace/file?path=${encodeURIComponent(selectedWorkspacePath)}`, { cache: 'no-store' })
      .then(async (response) => {
        const data = (await response.json()) as unknown;
        if (cancelled) return;
        if (!response.ok || !isWorkspaceFileSnapshot(data)) {
          setWorkspaceFileContent('');
          setWorkspaceStatus('선택한 workspace 파일을 읽지 못했습니다.');
          return;
        }
        setWorkspaceFileContent(data.file.content);
        setWorkspaceStatus('');
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceFileContent('');
          setWorkspaceStatus('선택한 workspace 파일을 읽지 못했습니다.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [outputTab, runId, selectedWorkspacePath, showArtifact]);

  useEffect(() => {
    if (!selectedLogId && !expandedAgentRole) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (selectedLogId) setSelectedLogId(null);
      else setExpandedAgentRole(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [expandedAgentRole, selectedLogId]);

  useEffect(() => {
    if (!expandedAgentRole) return;
    const pendingForExpandedAgent = pendingApprovalCards.some((approval) => approval.role === expandedAgentRole);
    if (!pendingForExpandedAgent && !pendingApprovalFocusRef.current) return;
    const targetId = pendingApprovalFocusRef.current;
    pendingApprovalFocusRef.current = null;
    window.requestAnimationFrame(() => {
      const target = targetId ? document.getElementById(`approval-${targetId}`) : null;
      (target ?? expandedFeedEndRef.current)?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
  }, [events.length, expandedAgentRole, pendingApprovalCards]);

  function openPendingApproval(approval = latestPendingApproval) {
    if (!approval) return;
    pendingApprovalFocusRef.current = approval.approvalId;
    if (expandedAgentRole === approval.role) {
      window.requestAnimationFrame(() => {
        (document.getElementById(`approval-${approval.approvalId}`) ?? expandedFeedEndRef.current)
          ?.scrollIntoView({ block: 'end', behavior: 'smooth' });
      });
    }
    setSelectedLogId(null);
    setExpandedAgentRole(approval.role);
  }

  function openOutputs(tab: OutputTab = outputTab) {
    setOutputTab(tab);
    setShowArtifact(true);
  }

  async function sendChatMessage() {
    if (!body.trim()) return;
    setControlStatus(runInProgress ? 'Orchestrator에게 개입 요청을 전달하는 중...' : 'Agents에게 요청을 전달하는 중...');
    const response = await fetch(`/api/runs/${runId}/interventions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'all', body, priority: runInProgress ? 'high' : 'normal' }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setControlStatus(data?.error?.message ?? '요청 전송 실패');
      return;
    }
    setBody('');
    setControlStatus(runInProgress
      ? '개입 요청을 Orchestrator에게 전달했습니다. 현재 단계가 끝나면 반영 여부를 판단합니다.'
      : 'Agents가 답변을 생성하고 있습니다.');
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

  async function submitApproval(approval: ApprovalCard, action: 'approve' | 'reject') {
    setApprovalActionStatus((current) => ({ ...current, [approval.approvalId]: action === 'approve' ? '승인 처리 중...' : '거절 처리 중...' }));
    const response = await fetch(`/api/runs/${runId}/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: approval.role, action, approvalId: approval.approvalId }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setControlStatus(data?.error?.message ?? '권한 요청 처리 실패');
      setApprovalActionStatus((current) => ({ ...current, [approval.approvalId]: '' }));
      return;
    }
    setControlStatus(action === 'approve' ? '권한 요청을 승인했습니다.' : '권한 요청을 거절했습니다.');
    setApprovalActionStatus((current) => ({ ...current, [approval.approvalId]: '' }));
    await refreshSnapshot();
    onRunUpdated?.();
  }

  function renderAgentPanel(agent: AgentState, options: { expanded?: boolean } = {}) {
    const latestAssignment = messages
      .filter((message) => message.from === 'orchestrator' && message.to === agent.id && message.kind === 'instruction')
      .at(-1);
    const sentCount = messages.filter((message) => message.from === agent.id).length;
    const receivedCount = messages.filter((message) => message.to === agent.id).length;
    const isWorking = agent.status === 'thinking' || agent.status === 'waiting';
    const session = runState.sessions?.[agent.role];
    const agentApprovalCards = approvalCardsForAgent(events, agent.role);
    const pendingAgentApprovalCount = agentApprovalCards.filter((approval) => approval.status === 'pending').length;
    const feedItems = sortedAgentFeedItems(messages, agentApprovalCards, agent.id, options.expanded ? 48 : 20);

    return (
      <article
        className={`agent-panel ${agent.role} ${agent.status} ${latestAssignment ? 'has-assignment' : ''} ${options.expanded ? 'expanded' : ''}`}
        key={options.expanded ? `expanded-${agent.id}` : agent.id}
      >
        <header className="agent-panel-header">
          <div>
            <span className="kicker">{agent.role}</span>
            <h2>{agent.displayName}</h2>
          </div>
          <div className="agent-panel-header-actions">
            {pendingAgentApprovalCount ? (
              <span className="agent-approval-pill">승인 대기 {pendingAgentApprovalCount}</span>
            ) : null}
            <span className={`agent-status-pill ${agent.status}`}>{agent.status}</span>
            {!options.expanded ? (
              <button
                className="agent-expand-trigger"
                onClick={() => setExpandedAgentRole(agent.role)}
                type="button"
              >
                크게 보기
              </button>
            ) : null}
          </div>
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
            <dd title={session ? `${session.tmuxSession}:${session.tmuxPane}` : undefined}>
              {session ? `${session.transport} · ${session.status}` : 'none'}
            </dd>
          </div>
          <div>
            <dt>Pane</dt>
            <dd>{session ? session.tmuxPane : '-'}</dd>
          </div>
          <div>
            <dt>Session Last</dt>
            <dd>{formatTime(session?.lastCompletedAt ?? session?.lastInjectedAt ?? session?.updatedAt)}</dd>
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
          {feedItems.length ? (
            feedItems.map((item) => {
              if (item.type === 'message') {
                const { message } = item;
                return (
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
                );
              }

              const { approval } = item;
              const pending = approval.status === 'pending';
              const actionStatus = approvalActionStatus[approval.approvalId];
              return (
                <article
                  className={`agent-panel-approval ${approval.status}`}
                  id={`approval-${approval.approvalId}`}
                  key={approval.approvalId}
                >
                  <button
                    className="agent-panel-approval-main"
                    onClick={() => setSelectedLogId(approval.eventId)}
                    type="button"
                  >
                    <span>{formatTime(approval.createdAt)} · 권한 요청</span>
                    <strong>{pending ? '사용자 승인이 필요합니다' : approval.status === 'approved' ? '승인됨' : '거절됨'}</strong>
                    <code>{approval.command}</code>
                    <p>{approval.reason}</p>
                  </button>
                  {pending ? (
                    <div className="agent-panel-approval-actions">
                      <button
                        disabled={Boolean(actionStatus)}
                        onClick={(event) => {
                          event.stopPropagation();
                          void submitApproval(approval, 'approve');
                        }}
                        type="button"
                      >
                        승인
                      </button>
                      <button
                        className="danger"
                        disabled={Boolean(actionStatus)}
                        onClick={(event) => {
                          event.stopPropagation();
                          void submitApproval(approval, 'reject');
                        }}
                        type="button"
                      >
                        거절
                      </button>
                      {actionStatus ? <span>{actionStatus}</span> : null}
                    </div>
                  ) : null}
                </article>
              );
            })
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
          {options.expanded ? <div className="agent-panel-feed-end" ref={expandedFeedEndRef} /> : null}
        </div>
      </article>
    );
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
            <span className={`badge bottleneck-badge ${bottleneck.tone}`}>{bottleneck.label}</span>
            {pendingApprovalCards.length ? (
              <button
                className="badge badge-button progress-badge active approval-jump"
                onClick={() => openPendingApproval()}
                type="button"
              >
                승인 요청 {pendingApprovalCards.length}
              </button>
            ) : null}
            {continuation?.enabled && continuation.iteration > 0 ? (
              <span className="badge continuation-badge">auto-loop {continuation.iteration}/{continuation.maxIterations}</span>
            ) : null}
            <span className={`badge ${connected ? 'completed' : ''}`}>{connected ? 'live' : 'reconnecting'}</span>
            <button className="badge badge-button" type="button" onClick={() => setShowLogs((current) => !current)}>
              {showLogs ? 'Logs 닫기' : `Logs ${processLogs.length}`}
            </button>
            <button className="badge badge-button" type="button" onClick={() => openOutputs('report')}>
              산출물
            </button>
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
              <div className="logs-drawer-actions">
                {artifact ? (
                  <button className="secondary" type="button" onClick={() => showArtifact ? setShowArtifact(false) : openOutputs('report')}>
                    {showArtifact ? '실행 요약 닫기' : '실행 요약 보기'}
                  </button>
                ) : null}
                <button className="secondary" type="button" onClick={() => setShowLogs(false)}>닫기</button>
              </div>
            </div>
            <div className="log-filter-row" aria-label="로그 필터">
              {LOG_FILTER_OPTIONS.map((option) => (
                <button
                  className={logFilter === option.value ? 'selected' : ''}
                  key={option.value}
                  onClick={() => setLogFilter(option.value)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            {filteredProcessLogs.length ? (
              <ol className="process-log-list">
                {filteredProcessLogs.map((log) => (
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
              <p className="empty-log">선택한 필터에 해당하는 로그가 없습니다.</p>
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
          {orderedAgents.map((agent) => renderAgentPanel(agent))}
        </section>

        {expandedAgent ? (
          <div className="agent-expand-backdrop" onClick={() => setExpandedAgentRole(null)} role="presentation">
            <section
              aria-labelledby="agent-expand-title"
              aria-modal="true"
              className="agent-expand-modal"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
            >
              <header className="agent-expand-header">
                <div>
                  <span className="kicker">Expanded Agent</span>
                  <h2 id="agent-expand-title">{expandedAgent.displayName}</h2>
                  <p>{expandedAgent.role} · {expandedAgent.status} · {agentSituation(expandedAgent)}</p>
                </div>
                <button className="secondary" onClick={() => setExpandedAgentRole(null)} type="button">닫기</button>
              </header>
              <div className="agent-expand-body">
                {renderAgentPanel(expandedAgent, { expanded: true })}
              </div>
            </section>
          </div>
        ) : null}

        <footer className="chat-composer-bar">
          {showArtifact ? (
            <section className="artifact-drawer output-drawer" aria-label="산출물">
              <div className="artifact-drawer-header">
                <span>산출물 · run {runId}</span>
                <button className="secondary" type="button" onClick={() => setShowArtifact(false)}>닫기</button>
              </div>
              <div className="output-tabs" role="tablist" aria-label="산출물 탭">
                {OUTPUT_TABS.map((tab) => (
                  <button
                    aria-selected={outputTab === tab.value}
                    className={outputTab === tab.value ? 'selected' : ''}
                    key={tab.value}
                    onClick={() => setOutputTab(tab.value)}
                    role="tab"
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {outputTab === 'report' ? (
                artifact ? <pre>{artifact}</pre> : <div className="output-empty">아직 final-report.md가 생성되지 않았습니다.</div>
              ) : null}
              {outputTab === 'messages' ? (
                messages.length ? (
                  <ol className="output-message-list">
                    {messages.map((message) => (
                      <li key={message.id}>
                        <button onClick={() => setSelectedLogId(message.id)} type="button">
                          <span>{formatTime(message.createdAt)} · {message.kind}</span>
                          <strong>{actorLabel(agentMap, message.from)} → {actorLabel(agentMap, message.to)}</strong>
                          <p>{message.body}</p>
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : <div className="output-empty">아직 messages.jsonl에 표시할 메시지가 없습니다.</div>
              ) : null}
              {outputTab === 'workspace' ? (
                <div className="workspace-viewer">
                  {implementationRun && !workspaceFiles.length ? (
                    <div className="workspace-warning">implementation 요청으로 보이지만 workspace 산출물이 아직 없습니다.</div>
                  ) : null}
                  {workspaceStatus ? <p className="workspace-status">{workspaceStatus}</p> : null}
                  {workspaceFiles.length ? (
                    <div className="workspace-layout">
                      <ol className="workspace-file-list">
                        {workspaceFiles.map((file) => (
                          <li key={file.path}>
                            <button
                              className={selectedWorkspacePath === file.path ? 'selected' : ''}
                              onClick={() => setSelectedWorkspacePath(file.path)}
                              type="button"
                            >
                              <strong>{file.path}</strong>
                              <span>{formatBytes(file.size)} · {formatTime(file.updatedAt)}</span>
                            </button>
                          </li>
                        ))}
                      </ol>
                      <section className="workspace-file-preview">
                        <header>
                          <span>{selectedWorkspacePath || '파일 선택'}</span>
                          {selectedWorkspacePath ? <small>path copy: {selectedWorkspacePath}</small> : null}
                        </header>
                        <pre>{workspaceFileContent || '파일을 선택하면 내용이 여기에 표시됩니다.'}</pre>
                      </section>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
          <div className="composer-target-row">
            <span className={`run-progress-indicator ${runInProgress ? 'active' : ''}`}>
              {runInProgress ? progressLabel : latestEvent ? `마지막 이벤트: ${latestEvent.type}` : 'Orchestrator에게 다음 요청을 보낼 수 있습니다.'}
            </span>
            <span>{runInProgress ? '진행 중에도 개입 요청을 보낼 수 있습니다.' : 'Enter는 줄바꿈, ⌘/Ctrl + Enter는 전송'}</span>
          </div>
          <div className="chat-input-row active-run-controls">
            <textarea
              aria-label="Agents에게 보낼 메시지"
              onChange={(event) => setBody(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void sendChatMessage();
                }
              }}
              placeholder={runInProgress ? '진행 중에도 Orchestrator에게 추가 지시를 보낼 수 있습니다.' : 'Orchestrator에게 요청하세요. 예: Planner에게 요구사항을 먼저 정리하게 해줘.'}
              value={body}
            />
            {runInProgress ? (
              <div className="composer-action-group">
                <button disabled={!body.trim()} onClick={() => void sendChatMessage()} type="button">개입 보내기</button>
                <button className="danger" onClick={() => void stopRun()} type="button">현재 작업 취소</button>
              </div>
            ) : (
              <div className="composer-action-group">
                <button disabled={!body.trim()} onClick={() => void sendChatMessage()} type="button">전송</button>
              </div>
            )}
          </div>
          {controlStatus ? <p className="composer-status">{controlStatus}</p> : null}
        </footer>
      </section>
    </main>
  );
}
