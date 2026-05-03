import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentRole, AgentSessionHandle } from '@/lib/protocol/types';
import type { CliAdapterKind } from '@/lib/runner/agent-config';
import {
  assertAllowedExecutable,
  parseCommandSpec,
  resolveCliCommandConfig,
  type CliAgentRunInput,
  type CliAgentRunResult,
  type CliCommandConfig,
} from '@/lib/runner/cli-agent-adapter';
import {
  appendEvent,
  runDir,
  readState,
  updateAgentStatus,
  updateAgentSessionStatus,
  upsertAgentSessionHandle,
} from '@/lib/store/file-store';
import { createId, nowIso } from '@/lib/utils/ids';

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface TmuxCommandConfig {
  executable: string;
  args: string[];
  allowlist: string[];
  timeoutMs: number;
  captureDelayMs: number;
  captureHistoryLines: number;
  completionTimeoutMs: number;
  completionPollMs: number;
  readyTimeoutMs: number;
  readyPollMs: number;
  pasteReadyTimeoutMs: number;
  submitDelayMs: number;
  submitConfirmTimeoutMs: number;
  submitRetryCount: number;
  idleFallbackStableMs: number;
  sessionPrefix: string;
  promptTransport: TmuxPromptTransportMode;
  promptTransportByRole: Partial<Record<AgentRole, TmuxPromptTransportMode>>;
  autoApproveCommands: string[];
}

const DEFAULT_TMUX_TIMEOUT_MS = 10_000;
const DEFAULT_TMUX_CAPTURE_DELAY_MS = 1_000;
const DEFAULT_TMUX_CAPTURE_HISTORY_LINES = 400;
const DEFAULT_TMUX_COMPLETION_TIMEOUT_MS = 600_000;
const DEFAULT_TMUX_COMPLETION_POLL_MS = 1_000;
const DEFAULT_TMUX_READY_TIMEOUT_MS = 20_000;
const DEFAULT_TMUX_READY_POLL_MS = 250;
const DEFAULT_TMUX_PASTE_READY_TIMEOUT_MS = 2_000;
const DEFAULT_TMUX_SUBMIT_DELAY_MS = 1_000;
const DEFAULT_TMUX_SUBMIT_CONFIRM_TIMEOUT_MS = 3_000;
const DEFAULT_TMUX_SUBMIT_RETRY_COUNT = 4;
const DEFAULT_TMUX_IDLE_FALLBACK_STABLE_MS = 30_000;
const DEFAULT_TMUX_SESSION_PREFIX = 'agentboard';
const DEFAULT_TMUX_PROMPT_TRANSPORT: TmuxPromptTransportMode = 'file-reference';

type CompletionMarkerStatus = 'complete' | 'blocked';
type TmuxPromptTransportMode = 'file-reference' | 'paste-buffer';
type PromptTransportEventValue = 'tmux-file-reference' | 'tmux-load-buffer-file';
type ApprovalSource = 'user' | 'auto';

const TMUX_PROMPT_TRANSPORT_ENV_BY_ROLE: Record<AgentRole, string> = {
  orchestrator: 'AGENTBOARD_ORCHESTRATOR_TMUX_PROMPT_TRANSPORT',
  planner: 'AGENTBOARD_PLANNER_TMUX_PROMPT_TRANSPORT',
  engineer: 'AGENTBOARD_ENGINEER_TMUX_PROMPT_TRANSPORT',
  reviewer: 'AGENTBOARD_REVIEWER_TMUX_PROMPT_TRANSPORT',
};

interface CompletionProtocol {
  token: string;
  prompt: string;
}

interface CompletionResult {
  body: string;
  markerStatus: CompletionMarkerStatus;
  rawStdout: string;
  completionSource: 'done-marker' | 'idle-prompt-fallback' | 'idle-output-fallback';
}

type ApprovalAction = 'approve' | 'reject';

interface ApprovalRequest {
  key: string;
  command: string;
  reason: string;
  prompt: string;
  choices: string[];
}

interface IdleFallbackCandidate {
  body: string;
  firstSeenAt: number;
  completion: CompletionResult;
}

interface SubmitConfirmationResult {
  confirmed: boolean;
  stdout: string;
  reason: 'marker' | 'working' | 'approval' | 'output' | 'pasted-idle' | 'prompt-idle' | 'idle';
}

interface PromptInjectionResult {
  promptPath: string;
  promptBytes: number;
  promptTransport: PromptTransportEventValue;
  promptInstructionBytes?: number;
  cleanupAfterRun: boolean;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.round(parsed);
}

function parseAllowlist(value: string | undefined, fallback: string[]): string[] {
  return (value ?? fallback.join(','))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseAutoApproveCommands(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\n]/)
    .map((entry) => compactTerminalLine(entry))
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAutoApproveCommandPattern(command: string, patterns: string[]): string | undefined {
  const normalizedCommand = compactTerminalLine(command);
  return patterns.find((pattern) => {
    const normalizedPattern = compactTerminalLine(pattern);
    if (!normalizedPattern) return false;
    if (!normalizedPattern.includes('*')) return normalizedCommand === normalizedPattern;
    const regex = new RegExp(`^${normalizedPattern.split('*').map(escapeRegExp).join('.*')}$`);
    return regex.test(normalizedCommand);
  });
}

function parsePromptTransport(value: string | undefined, name = 'AGENTBOARD_TMUX_PROMPT_TRANSPORT'): TmuxPromptTransportMode {
  const normalized = value?.trim();
  if (!normalized) return DEFAULT_TMUX_PROMPT_TRANSPORT;
  if (normalized === 'file-reference' || normalized === 'paste-buffer') return normalized;
  throw new Error(`${name} must be file-reference or paste-buffer`);
}

function parsePromptTransportOverride(value: string | undefined, name: string): TmuxPromptTransportMode | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return parsePromptTransport(normalized, name);
}

function resolvePromptTransportByRole(env: NodeJS.ProcessEnv): Partial<Record<AgentRole, TmuxPromptTransportMode>> {
  return Object.fromEntries(
    Object.entries(TMUX_PROMPT_TRANSPORT_ENV_BY_ROLE)
      .map(([role, name]) => [role, parsePromptTransportOverride(env[name], name)])
      .filter((entry): entry is [AgentRole, TmuxPromptTransportMode] => Boolean(entry[1])),
  );
}

function safeTmuxToken(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  return normalized.replace(/^_+|_+$/g, '') || 'session';
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return value.slice(0, maxBytes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function tmuxSessionName(runId: string, role: AgentRole, prefix = DEFAULT_TMUX_SESSION_PREFIX): string {
  return `${safeTmuxToken(prefix)}_${safeTmuxToken(runId)}_${safeTmuxToken(role)}`;
}

export function tmuxBufferName(runId: string, role: AgentRole): string {
  return `agentboard_${safeTmuxToken(runId)}_${safeTmuxToken(role)}_${Date.now().toString(36)}`;
}

function tmuxPromptTempDir(runId: string): string {
  return join(runDir(runId), 'tmux-prompts');
}

function tmuxPromptTempPath(runId: string, role: AgentRole, buffer: string): string {
  return join(tmuxPromptTempDir(runId), `${safeTmuxToken(role)}-${safeTmuxToken(buffer)}.md`);
}

function tmuxPromptInstructionTempPath(runId: string, role: AgentRole, buffer: string): string {
  return join(tmuxPromptTempDir(runId), `${safeTmuxToken(role)}-${safeTmuxToken(buffer)}-instruction.txt`);
}

function markerParts(kind: 'BEGIN' | 'DONE', token: string, runId: string, role: AgentRole, status?: CompletionMarkerStatus): string {
  return `<<<AGENTBOARD_${kind} token=${token} runId=${runId} role=${role}${status ? ` status=${status}` : ''}>>>`;
}

function markerPromptExample(kind: 'BEGIN' | 'DONE', token: string, runId: string, role: AgentRole, status?: CompletionMarkerStatus): string {
  return `< < < AGENTBOARD_${kind} token=${token} runId=${runId} role=${role}${status ? ` status=${status}` : ''} > > >`;
}

function completionProtocolPrompt(runId: string, role: AgentRole, token: string): string {
  return [
    '',
    '[AgentBoard tmux transport completion protocol]',
    '이 tmux 세션은 계속 살아 있으므로 AgentBoard가 이번 turn의 완료 시점을 알 수 있게 transport marker를 출력해야 합니다.',
    '아래 marker는 사용자에게 보여줄 답변의 일부가 아니며 AgentBoard가 반환 전에 제거합니다.',
    '아래 예시는 감지를 피하려고 < < < 처럼 띄어 쓴 형태입니다. 실제 출력할 때는 모든 공백을 제거해 <<<...>>> 한 줄 marker로 출력합니다.',
    '출력 순서:',
    `1. 첫 줄: ${markerPromptExample('BEGIN', token, runId, role)}`,
    '2. 그 다음 줄부터 [Required Output] 요구사항에 맞는 실제 결과만 출력합니다.',
    `3. 정상 완료 마지막 줄: ${markerPromptExample('DONE', token, runId, role, 'complete')}`,
    `4. 진행 불가/추가 입력 필요 마지막 줄: ${markerPromptExample('DONE', token, runId, role, 'blocked')}`,
    '중요: JSON만 출력하라는 지시가 있더라도 transport marker 두 줄은 예외로 반드시 앞뒤에 추가합니다.',
  ].join('\n');
}

function withCompletionProtocol(prompt: string, runId: string, role: AgentRole): CompletionProtocol {
  const token = createId('tmuxturn');
  return {
    token,
    prompt: `${prompt}\n${completionProtocolPrompt(runId, role, token)}`,
  };
}

function promptFileReferenceInstruction(runId: string, role: AgentRole, _token: string, promptPath: string): string {
  return [
    `AgentBoard prompt file (${role}/${runId}):`,
    promptPath,
    'Read it and execute it exactly. Do not summarize this handoff.',
  ].join('\n');
}

function parseMarkerAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const part of raw.trim().split(/\s+/)) {
    const [key, ...valueParts] = part.split('=');
    const value = valueParts.join('=');
    if (key && value) attributes[key] = value;
  }
  return attributes;
}

function stripTransportMarkers(value: string): string {
  return value
    .replace(/^.*<<<AGENTBOARD_BEGIN\s+[^>]*>>>.*$/gm, '')
    .replace(/^.*<<<AGENTBOARD_DONE\s+[^>]*>>>.*$/gm, '')
    .trim();
}

function isIncompleteJsonFragment(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return false;
  if (trimmed.startsWith('[')) {
    const next = trimmed.slice(1).trimStart()[0] ?? '';
    if (!/[[{"\]\d\-tfn]/.test(next)) return false;
  }
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}

function extractCompletionResult(rawStdout: string, token: string): CompletionResult | undefined {
  const markerPattern = /<<<AGENTBOARD_(BEGIN|DONE)\s+([^>]*)>>>/g;
  const markers = [...rawStdout.matchAll(markerPattern)]
    .map((match) => ({
      kind: match[1] as 'BEGIN' | 'DONE',
      attributes: parseMarkerAttributes(match[2] ?? ''),
      index: match.index ?? 0,
      text: match[0],
    }))
    .filter((marker) => marker.attributes.token === token);
  const doneMarker = markers.filter((marker) => marker.kind === 'DONE').at(-1);
  if (!doneMarker) return undefined;

  const beginMarker = markers
    .filter((marker) => marker.kind === 'BEGIN' && marker.index < doneMarker.index)
    .at(-1);
  const status = doneMarker.attributes.status === 'blocked' ? 'blocked' : 'complete';
  const start = beginMarker ? beginMarker.index + beginMarker.text.length : 0;
  const end = doneMarker.index;
  const body = stripTransportMarkers(rawStdout.slice(start, end));
  return { body, markerStatus: status, rawStdout, completionSource: 'done-marker' };
}

function extractIdlePromptCompletionResult(rawStdout: string, token: string): CompletionResult | undefined {
  const markerPattern = /<<<AGENTBOARD_BEGIN\s+([^>]*)>>>/g;
  const beginMarkers = [...rawStdout.matchAll(markerPattern)]
    .map((match) => ({
      attributes: parseMarkerAttributes(match[1] ?? ''),
      index: match.index ?? 0,
      text: match[0],
    }))
    .filter((marker) => marker.attributes.token === token);
  const beginMarker = beginMarkers.at(-1);
  if (!beginMarker) return undefined;

  const start = beginMarker.index + beginMarker.text.length;
  const afterBegin = rawStdout.slice(start);
  if (/<<<AGENTBOARD_DONE\s+/.test(afterBegin)) return undefined;
  const idlePromptIndex = afterBegin.lastIndexOf('\n› ');
  if (idlePromptIndex < 0) return undefined;
  const afterIdlePrompt = afterBegin.slice(idlePromptIndex);
  if (/\bWorking\b/.test(afterIdlePrompt)) return undefined;

  const body = stripTransportMarkers(afterBegin.slice(0, idlePromptIndex));
  if (!body.trim()) return undefined;
  if (isIncompleteJsonFragment(body)) return undefined;
  return {
    body,
    markerStatus: 'complete',
    rawStdout,
    completionSource: 'idle-prompt-fallback',
  };
}

function stripCodexStatusLines(value: string): string {
  return value
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^›\s*.*\[Pasted Content\b/.test(trimmed)) return false;
      if (/^gpt-[\w.-]+\s+.*\bContext\b.*\bin\b.*\bout\b/i.test(trimmed)) return false;
      if (/^Context\s+\d+%/i.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function isPastedPromptInputLine(line: string): boolean {
  return /^\s*›\s*.*\[Pasted Content\b/.test(line);
}

function hasGeneratedOutputAfterPastedPrompt(rawStdout: string): boolean {
  const lines = normalizeTerminalText(rawStdout).split('\n');
  const pastedPromptIndex = lines.findLastIndex(isPastedPromptInputLine);
  if (pastedPromptIndex < 0) return false;
  const body = stripCodexStatusLines(lines.slice(pastedPromptIndex + 1).join('\n'));
  return Boolean(body.trim());
}

function hasExactTransportMarker(rawStdout: string, token: string): boolean {
  const markerPattern = /<<<AGENTBOARD_(BEGIN|DONE)\s+([^>]*)>>>/g;
  return [...rawStdout.matchAll(markerPattern)]
    .some((match) => parseMarkerAttributes(match[2] ?? '').token === token);
}

function extractIdleOutputCompletionResult(rawStdout: string, token: string): CompletionResult | undefined {
  if (rawStdout.includes(`AGENTBOARD_BEGIN token=${token}`) || rawStdout.includes(`AGENTBOARD_DONE token=${token}`)) return undefined;
  const normalized = normalizeTerminalText(rawStdout);
  if (/\bWorking\b/.test(normalized)) return undefined;

  const lines = normalized.split('\n');
  const pastedPromptIndex = lines.findLastIndex(isPastedPromptInputLine);
  if (pastedPromptIndex < 0) return undefined;

  const idlePromptIndex = lines.findLastIndex((line, index) => index > pastedPromptIndex && /^\s*›\s/.test(line));
  if (idlePromptIndex < 0) return undefined;

  const body = stripCodexStatusLines(lines.slice(pastedPromptIndex + 1, idlePromptIndex).join('\n'));
  if (!body.trim()) return undefined;
  if (isIncompleteJsonFragment(body)) return undefined;
  return {
    body,
    markerStatus: 'complete',
    rawStdout,
    completionSource: 'idle-output-fallback',
  };
}

function isPastedPromptStillIdle(rawStdout: string): boolean {
  const tail = normalizeTerminalText(rawStdout).split('\n').slice(-80).join('\n');
  return /\[Pasted Content\b/.test(tail)
    && /(^|\n)\s*›\s*.*\[Pasted Content\b/.test(tail)
    && !/\bWorking\b/.test(tail)
    && !/<<<AGENTBOARD_(BEGIN|DONE)\s+/.test(tail);
}

function isPromptInstructionStillIdle(rawStdout: string, token: string): boolean {
  const tail = normalizeTerminalText(rawStdout).split('\n').slice(-120).join('\n');
  return (
    tail.includes('AgentBoard prompt file')
    || tail.includes('Read this prompt file and execute every instruction in it')
  )
    && /(^|\n)\s*›\s*(AgentBoard prompt file|AgentBoard turn)\b/.test(tail)
    && !/\bWorking\b/.test(tail)
    && !hasExactTransportMarker(tail, token);
}

function submitConfirmationFromOutput(rawStdout: string, token: string): SubmitConfirmationResult {
  if (extractCompletionResult(rawStdout, token)
    || extractIdlePromptCompletionResult(rawStdout, token)
    || extractIdleOutputCompletionResult(rawStdout, token)
    || hasExactTransportMarker(rawStdout, token)) {
    return { confirmed: true, stdout: rawStdout, reason: 'marker' };
  }
  if (isPastedPromptStillIdle(rawStdout)) {
    return { confirmed: false, stdout: rawStdout, reason: 'pasted-idle' };
  }
  if (isPromptInstructionStillIdle(rawStdout, token)) {
    return { confirmed: false, stdout: rawStdout, reason: 'prompt-idle' };
  }
  if (/\bWorking\b/.test(rawStdout)) {
    return { confirmed: true, stdout: rawStdout, reason: 'working' };
  }
  if (extractApprovalRequest(rawStdout)) {
    return { confirmed: true, stdout: rawStdout, reason: 'approval' };
  }
  if (hasGeneratedOutputAfterPastedPrompt(rawStdout)) {
    return { confirmed: true, stdout: rawStdout, reason: 'output' };
  }
  return { confirmed: false, stdout: rawStdout, reason: 'idle' };
}

function normalizeTerminalText(value: string): string {
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n');
}

function compactTerminalLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractApprovalRequest(rawStdout: string): ApprovalRequest | undefined {
  const normalized = normalizeTerminalText(rawStdout);
  const marker = 'Would you like to run the following command?';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;

  const approvalText = normalized.slice(markerIndex);
  if (!/Press enter to confirm|esc to cancel/i.test(approvalText)) return undefined;

  const lines = approvalText.split('\n');
  const commandIndex = lines.findIndex((line) => line.trim().startsWith('$ '));
  const command = commandIndex >= 0 ? compactTerminalLine(lines[commandIndex]?.trim().slice(2) ?? '') : 'unknown command';
  const reasonIndex = lines.findIndex((line) => line.trim().startsWith('Reason:'));
  const reasonLines = reasonIndex >= 0
    ? lines
      .slice(reasonIndex, commandIndex >= 0 ? commandIndex : undefined)
      .map((line, index) => index === 0 ? line.replace(/^\s*Reason:\s*/, '') : line)
    : [];
  const choices = lines
    .map((line) => line.replace(/^\s*›\s*/, '').trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .map(compactTerminalLine);
  const prompt = approvalText.split('Press enter to confirm')[0]?.trim() || approvalText.trim();
  const key = `${command}|${compactTerminalLine(reasonLines.join(' '))}|${choices.join('|')}`;

  return {
    key,
    command,
    reason: compactTerminalLine(reasonLines.join(' ')) || 'Codex가 명령 실행 승인을 요청했습니다.',
    prompt,
    choices,
  };
}

export function resolveTmuxCommandConfig(env: NodeJS.ProcessEnv = process.env): TmuxCommandConfig {
  const spec = env.AGENTBOARD_TMUX_CMD?.trim() || 'tmux';
  const [executable, ...args] = parseCommandSpec(spec);
  const allowlist = parseAllowlist(env.AGENTBOARD_TMUX_ALLOWLIST, ['tmux']);
  assertAllowedExecutable(executable, allowlist);
  return {
    executable,
    args,
    allowlist,
    timeoutMs: parsePositiveInteger(env.AGENTBOARD_TMUX_TIMEOUT_MS, DEFAULT_TMUX_TIMEOUT_MS, 'AGENTBOARD_TMUX_TIMEOUT_MS'),
    captureDelayMs: parsePositiveInteger(env.AGENTBOARD_TMUX_CAPTURE_DELAY_MS, DEFAULT_TMUX_CAPTURE_DELAY_MS, 'AGENTBOARD_TMUX_CAPTURE_DELAY_MS'),
    captureHistoryLines: parsePositiveInteger(env.AGENTBOARD_TMUX_CAPTURE_HISTORY_LINES, DEFAULT_TMUX_CAPTURE_HISTORY_LINES, 'AGENTBOARD_TMUX_CAPTURE_HISTORY_LINES'),
    completionTimeoutMs: parsePositiveInteger(env.AGENTBOARD_TMUX_COMPLETION_TIMEOUT_MS, DEFAULT_TMUX_COMPLETION_TIMEOUT_MS, 'AGENTBOARD_TMUX_COMPLETION_TIMEOUT_MS'),
    completionPollMs: parsePositiveInteger(env.AGENTBOARD_TMUX_COMPLETION_POLL_MS, DEFAULT_TMUX_COMPLETION_POLL_MS, 'AGENTBOARD_TMUX_COMPLETION_POLL_MS'),
    readyTimeoutMs: parsePositiveInteger(env.AGENTBOARD_TMUX_READY_TIMEOUT_MS, DEFAULT_TMUX_READY_TIMEOUT_MS, 'AGENTBOARD_TMUX_READY_TIMEOUT_MS'),
    readyPollMs: parsePositiveInteger(env.AGENTBOARD_TMUX_READY_POLL_MS, DEFAULT_TMUX_READY_POLL_MS, 'AGENTBOARD_TMUX_READY_POLL_MS'),
    pasteReadyTimeoutMs: parsePositiveInteger(env.AGENTBOARD_TMUX_PASTE_READY_TIMEOUT_MS, DEFAULT_TMUX_PASTE_READY_TIMEOUT_MS, 'AGENTBOARD_TMUX_PASTE_READY_TIMEOUT_MS'),
    submitDelayMs: parsePositiveInteger(env.AGENTBOARD_TMUX_SUBMIT_DELAY_MS, DEFAULT_TMUX_SUBMIT_DELAY_MS, 'AGENTBOARD_TMUX_SUBMIT_DELAY_MS'),
    submitConfirmTimeoutMs: parsePositiveInteger(env.AGENTBOARD_TMUX_SUBMIT_CONFIRM_TIMEOUT_MS, DEFAULT_TMUX_SUBMIT_CONFIRM_TIMEOUT_MS, 'AGENTBOARD_TMUX_SUBMIT_CONFIRM_TIMEOUT_MS'),
    submitRetryCount: parsePositiveInteger(env.AGENTBOARD_TMUX_SUBMIT_RETRY_COUNT, DEFAULT_TMUX_SUBMIT_RETRY_COUNT, 'AGENTBOARD_TMUX_SUBMIT_RETRY_COUNT'),
    idleFallbackStableMs: parsePositiveInteger(env.AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS, DEFAULT_TMUX_IDLE_FALLBACK_STABLE_MS, 'AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS'),
    sessionPrefix: env.AGENTBOARD_TMUX_SESSION_PREFIX?.trim() || DEFAULT_TMUX_SESSION_PREFIX,
    promptTransport: parsePromptTransport(env.AGENTBOARD_TMUX_PROMPT_TRANSPORT),
    promptTransportByRole: resolvePromptTransportByRole(env),
    autoApproveCommands: parseAutoApproveCommands(env.AGENTBOARD_AUTO_APPROVE_COMMANDS),
  };
}

export class TmuxSessionAdapter {
  constructor(
    readonly kind: CliAdapterKind,
    readonly cliConfig: CliCommandConfig = resolveCliCommandConfig(kind),
    readonly tmuxConfig: TmuxCommandConfig = resolveTmuxCommandConfig(),
  ) {
    if (kind !== 'tmux-codex') throw new Error('TmuxSessionAdapter only supports tmux-codex');
    assertAllowedExecutable(cliConfig.executable, cliConfig.allowlist);
    assertAllowedExecutable(tmuxConfig.executable, tmuxConfig.allowlist);
  }

  async run(input: CliAgentRunInput): Promise<CliAgentRunResult> {
    const startedAt = Date.now();
    const handle = await this.ensureSession(input.runId, input.role);
    const protocol = withCompletionProtocol(input.prompt, input.runId, input.role);
    let injection: PromptInjectionResult | undefined;
    try {
      injection = await this.injectPrompt(input.runId, input.role, protocol.prompt, handle, protocol.token);
      const completion = await this.waitForCompletion(input, handle, protocol.token, startedAt);
      return {
        stdout: completion.body.trim(),
        stderr: '',
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (injection) await this.cleanupPromptInjection(input.runId, input.role, injection);
    }
  }

  async ensureSession(runId: string, role: AgentRole): Promise<AgentSessionHandle> {
    const state = await readState(runId);
    const existing = state.sessions?.[role];
    if (existing && existing.transport === 'tmux' && await this.hasSession(existing.tmuxSession)) {
      return upsertAgentSessionHandle(runId, role, { ...existing, status: 'attached' });
    }

    if (existing) {
      await appendEvent(runId, {
        id: createId('evt'),
        runId,
        type: 'session.restarted',
        actor: role,
        payload: { role, adapter: this.kind, tmuxSession: existing.tmuxSession },
        createdAt: nowIso(),
      });
    }

    const tmuxSession = tmuxSessionName(runId, role, this.tmuxConfig.sessionPrefix);
    const tmuxWindow = role;
    const command = this.commandLine();
    await this.runTmux(['new-session', '-d', '-s', tmuxSession, '-n', tmuxWindow, command]);
    const paneResult = await this.runTmux(['display-message', '-p', '-t', tmuxSession, '#{pane_id}']).catch(() => undefined);
    const startedAt = nowIso();
    const handle: AgentSessionHandle = {
      role,
      adapter: this.kind,
      transport: 'tmux',
      tmuxSession,
      tmuxWindow,
      tmuxPane: paneResult?.stdout.trim() || tmuxSession,
      command,
      status: 'attached',
      startedAt,
      updatedAt: startedAt,
    };
    const saved = await upsertAgentSessionHandle(runId, role, handle);
    await appendEvent(runId, {
      id: createId('evt'),
      runId,
      type: 'session.created',
      actor: role,
      payload: { role, adapter: this.kind, transport: 'tmux', tmuxSession, tmuxPane: saved.tmuxPane },
      createdAt: startedAt,
    });
    await this.waitForSessionReady(saved);
    return saved;
  }

  async injectPrompt(runId: string, role: AgentRole, prompt: string, handle?: AgentSessionHandle, completionToken?: string): Promise<PromptInjectionResult> {
    const session = handle ?? await this.ensureSession(runId, role);
    const injectedAt = nowIso();
    await updateAgentSessionStatus(runId, role, 'running', { lastInjectedAt: injectedAt });
    const buffer = tmuxBufferName(runId, role);
    const promptPath = tmuxPromptTempPath(runId, role, buffer);
    const instructionPath = tmuxPromptInstructionTempPath(runId, role, buffer);
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    const rolePromptTransport = this.tmuxConfig.promptTransportByRole[role] ?? this.tmuxConfig.promptTransport;
    const useFileReference = rolePromptTransport === 'file-reference' && Boolean(completionToken);
    const promptTransport: PromptTransportEventValue = useFileReference ? 'tmux-file-reference' : 'tmux-load-buffer-file';
    const promptInstruction = useFileReference
      ? promptFileReferenceInstruction(runId, role, completionToken as string, promptPath)
      : prompt;
    const promptInstructionBytes = Buffer.byteLength(promptInstruction, 'utf8');
    const bufferPath = useFileReference ? instructionPath : promptPath;
    const injection: PromptInjectionResult = {
      promptPath,
      promptBytes,
      promptTransport,
      promptInstructionBytes: useFileReference ? promptInstructionBytes : undefined,
      cleanupAfterRun: useFileReference,
    };

    await mkdir(tmuxPromptTempDir(runId), { recursive: true });
    await writeFile(promptPath, prompt, 'utf8');
    if (useFileReference) await writeFile(instructionPath, promptInstruction, 'utf8');
    try {
      await this.runTmux(['load-buffer', '-b', buffer, bufferPath]);
      await this.runTmux(['paste-buffer', '-b', buffer, '-t', session.tmuxPane || session.tmuxSession]);
      await this.waitForPromptPasteReady(session, promptInstruction);
    } catch (error) {
      await this.cleanupPromptInjection(runId, role, injection);
      throw error;
    } finally {
      await this.runTmux(['delete-buffer', '-b', buffer]).catch(() => undefined);
      await rm(instructionPath, { force: true }).catch(() => undefined);
      if (!useFileReference) await rm(promptPath, { force: true }).catch(() => undefined);
    }

    try {
      await appendEvent(runId, {
        id: createId('evt'),
        runId,
        type: 'session.prompt_injected',
        actor: role,
        payload: {
          role,
          adapter: this.kind,
          tmuxSession: session.tmuxSession,
          tmuxPane: session.tmuxPane,
          promptBytes,
          promptInstructionBytes,
          promptTransport,
          promptFilePath: useFileReference ? promptPath : undefined,
        },
        createdAt: injectedAt,
      });
      if (this.tmuxConfig.submitDelayMs > 0) await sleep(this.tmuxConfig.submitDelayMs);
      if (completionToken) {
        await this.submitPromptAndConfirm(runId, role, session, completionToken);
      } else {
        await this.runTmux(['send-keys', '-t', session.tmuxPane || session.tmuxSession, 'Enter']);
      }
      return injection;
    } catch (error) {
      await this.cleanupPromptInjection(runId, role, injection);
      throw error;
    }
  }

  async captureOutput(runId: string, role: AgentRole, handle?: AgentSessionHandle): Promise<string> {
    const session = handle ?? await this.ensureSession(runId, role);
    const stdout = await this.capturePane(session);
    const capturedAt = nowIso();
    await updateAgentSessionStatus(runId, role, 'idle', { lastCapturedAt: capturedAt });
    await appendEvent(runId, {
      id: createId('evt'),
      runId,
      type: 'session.output_captured',
      actor: role,
      payload: {
        role,
        adapter: this.kind,
        tmuxSession: session.tmuxSession,
        tmuxPane: session.tmuxPane,
        stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
      },
      createdAt: capturedAt,
    });
    return stdout;
  }

  async stopRunSessions(runId: string): Promise<void> {
    const state = await readState(runId).catch(() => undefined);
    if (!state?.sessions) return;
    for (const [role, handle] of Object.entries(state.sessions)) {
      if (!handle || handle.transport !== 'tmux') continue;
      await this.runTmux(['kill-session', '-t', handle.tmuxSession]).catch(() => undefined);
      await updateAgentSessionStatus(runId, role as AgentRole, 'dead').catch(() => undefined);
    }
  }

  async respondToApproval(
    runId: string,
    role: AgentRole,
    action: ApprovalAction,
    approvalId: string,
    options: { source?: ApprovalSource; matchedCommandPattern?: string } = {},
  ): Promise<void> {
    const state = await readState(runId);
    const handle = state.sessions?.[role];
    if (!handle || handle.transport !== 'tmux') throw new Error(`No tmux session found for ${role}`);
    const key = action === 'approve' ? 'Enter' : 'Escape';
    await updateAgentSessionStatus(runId, role, 'running').catch(() => undefined);
    await updateAgentStatus(runId, role, 'thinking').catch(() => undefined);
    await this.runTmux(['send-keys', '-t', handle.tmuxPane || handle.tmuxSession, key]);
    await appendEvent(runId, {
      id: createId('evt'),
      runId,
      type: action === 'approve' ? 'approval.approved' : 'approval.rejected',
      actor: role,
      payload: {
        approvalId,
        role,
        adapter: this.kind,
        tmuxSession: handle.tmuxSession,
        tmuxPane: handle.tmuxPane,
        action,
        injectedKey: key,
        source: options.source ?? 'user',
        matchedCommandPattern: options.matchedCommandPattern,
      },
      createdAt: nowIso(),
    });
  }

  private async hasSession(tmuxSession: string): Promise<boolean> {
    const result = await this.runTmux(['has-session', '-t', tmuxSession], { rejectOnExit: false });
    return result.exitCode === 0;
  }

  private commandLine(): string {
    return [this.cliConfig.executable, ...this.cliConfig.args].map(shellQuote).join(' ');
  }

  private async waitForSessionReady(session: AgentSessionHandle): Promise<void> {
    if (this.tmuxConfig.readyTimeoutMs <= 0) return;
    const deadline = Date.now() + this.tmuxConfig.readyTimeoutMs;
    const pollMs = Math.max(50, this.tmuxConfig.readyPollMs);
    while (Date.now() <= deadline) {
      const stdout = await this.capturePane(session).catch(() => '');
      if (
        stdout.includes('OpenAI Codex')
        || stdout.includes('model:')
        || stdout.includes('Tip: Run codex app')
        || /(^|\n)\s*›\s/.test(stdout)
      ) {
        return;
      }
      await sleep(pollMs);
    }
  }

  private async waitForPromptPasteReady(session: AgentSessionHandle, prompt: string): Promise<void> {
    if (this.tmuxConfig.pasteReadyTimeoutMs <= 0) return;
    const deadline = Date.now() + this.tmuxConfig.pasteReadyTimeoutMs;
    const pollMs = Math.max(50, Math.min(this.tmuxConfig.readyPollMs, 250));
    const token = prompt.match(/token=([A-Za-z0-9_-]+)/)?.[1];

    while (Date.now() <= deadline) {
      const stdout = await this.capturePane(session).catch(() => '');
      const tail = stdout.split('\n').slice(-30).join('\n');
      if (
        tail.includes('[Pasted Content')
        || tail.includes('AgentBoard prompt file')
        || Boolean(token && tail.includes(token))
      ) return;
      await sleep(pollMs);
    }
  }

  private async cleanupPromptInjection(runId: string, role: AgentRole, injection: PromptInjectionResult): Promise<void> {
    if (!injection.cleanupAfterRun) return;
    try {
      await rm(injection.promptPath, { force: true });
    } catch (error) {
      await appendEvent(runId, {
        id: createId('evt'),
        runId,
        type: 'error',
        actor: role,
        payload: {
          message: 'tmux prompt file cleanup failed',
          role,
          adapter: this.kind,
          promptFilePath: injection.promptPath,
          error: error instanceof Error ? error.message : String(error),
        },
        createdAt: nowIso(),
      }).catch(() => undefined);
    }
  }

  private async submitPromptAndConfirm(
    runId: string,
    role: AgentRole,
    session: AgentSessionHandle,
    token: string,
  ): Promise<void> {
    const maxAttempts = Math.max(1, this.tmuxConfig.submitRetryCount + 1);
    let latest: SubmitConfirmationResult = { confirmed: false, stdout: '', reason: 'idle' };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const key = attempt === 1 ? 'Enter' : 'C-m';
      await this.runTmux(['send-keys', '-t', session.tmuxPane || session.tmuxSession, key]);
      latest = await this.waitForPromptSubmitConfirmation(session, token);
      if (latest.confirmed) {
        const submittedAt = nowIso();
        await updateAgentSessionStatus(runId, role, 'running', { lastCapturedAt: submittedAt }).catch(() => undefined);
        await appendEvent(runId, {
          id: createId('evt'),
          runId,
          type: 'session.prompt_submitted',
          actor: role,
          payload: {
            role,
            adapter: this.kind,
            tmuxSession: session.tmuxSession,
            tmuxPane: session.tmuxPane,
            completionToken: token,
            attempts: attempt,
            submitKey: key,
            confirmReason: latest.reason,
            stdoutBytes: Buffer.byteLength(latest.stdout, 'utf8'),
          },
          createdAt: submittedAt,
        });
        return;
      }
    }

    const failedAt = nowIso();
    await updateAgentSessionStatus(runId, role, 'blocked', { lastCapturedAt: failedAt }).catch(() => undefined);
    await updateAgentStatus(runId, role, 'blocked').catch(() => undefined);
    await appendEvent(runId, {
      id: createId('evt'),
      runId,
      type: 'session.prompt_submit_failed',
      actor: role,
      payload: {
        role,
        adapter: this.kind,
        tmuxSession: session.tmuxSession,
        tmuxPane: session.tmuxPane,
        completionToken: token,
        attempts: maxAttempts,
        reason: latest.reason,
        confirmTimeoutMs: this.tmuxConfig.submitConfirmTimeoutMs,
        stdoutBytes: Buffer.byteLength(latest.stdout, 'utf8'),
      },
      createdAt: failedAt,
    });
    throw new Error(`tmux prompt submit failed for ${role}: Codex did not start processing prompt input`);
  }

  private async waitForPromptSubmitConfirmation(session: AgentSessionHandle, token: string): Promise<SubmitConfirmationResult> {
    const timeoutMs = this.tmuxConfig.submitConfirmTimeoutMs;
    if (timeoutMs <= 0) {
      const stdout = await this.capturePane(session).catch(() => '');
      return { confirmed: true, stdout, reason: 'output' };
    }

    const deadline = Date.now() + timeoutMs;
    const pollMs = Math.max(50, Math.min(this.tmuxConfig.completionPollMs, 500));
    let latest: SubmitConfirmationResult = { confirmed: false, stdout: '', reason: 'idle' };
    while (Date.now() <= deadline) {
      const stdout = await this.capturePane(session).catch(() => '');
      latest = submitConfirmationFromOutput(stdout, token);
      if (latest.confirmed) return latest;
      await sleep(pollMs);
    }
    return latest;
  }

  private async capturePane(session: AgentSessionHandle): Promise<string> {
    const result = await this.runTmux([
      'capture-pane',
      '-p',
      '-t',
      session.tmuxPane || session.tmuxSession,
      '-S',
      `-${this.tmuxConfig.captureHistoryLines}`,
    ]);
    return truncateUtf8(result.stdout, this.cliConfig.maxOutputBytes);
  }

  private async waitForCompletion(
    input: CliAgentRunInput,
    handle: AgentSessionHandle,
    token: string,
    startedAt: number,
  ): Promise<CompletionResult> {
    const deadline = Date.now() + this.tmuxConfig.completionTimeoutMs;
    const pollMs = Math.max(50, this.tmuxConfig.completionPollMs);
    if (this.tmuxConfig.captureDelayMs > 0) await sleep(this.tmuxConfig.captureDelayMs);

    let latestStdout = '';
    const reportedApprovals = new Set<string>();
    let idleFallbackCandidate: IdleFallbackCandidate | undefined;
    while (Date.now() <= deadline) {
      if (input.signal?.aborted) throw new Error('tmux adapter aborted before completion marker was observed');
      latestStdout = await this.capturePane(handle);
      const markerCompletion = extractCompletionResult(latestStdout, token);
      const idleCompletion = markerCompletion
        ? undefined
        : extractIdlePromptCompletionResult(latestStdout, token) ?? extractIdleOutputCompletionResult(latestStdout, token);
      let completion = markerCompletion;
      if (!completion && idleCompletion) {
        const now = Date.now();
        if (!idleFallbackCandidate || idleFallbackCandidate.body !== idleCompletion.body) {
          idleFallbackCandidate = {
            body: idleCompletion.body,
            firstSeenAt: now,
            completion: idleCompletion,
          };
        } else {
          idleFallbackCandidate.completion = idleCompletion;
        }
        if (now - idleFallbackCandidate.firstSeenAt >= this.tmuxConfig.idleFallbackStableMs) {
          completion = idleFallbackCandidate.completion;
        }
      } else if (!idleCompletion) {
        idleFallbackCandidate = undefined;
      }
      if (completion) {
        const completedAt = nowIso();
        await updateAgentSessionStatus(input.runId, input.role, completion.markerStatus === 'blocked' ? 'blocked' : 'completed', {
          lastCapturedAt: completedAt,
          lastCompletedAt: completedAt,
        });
        await appendEvent(input.runId, {
          id: createId('evt'),
          runId: input.runId,
          type: 'session.output_captured',
          actor: input.role,
          payload: {
            role: input.role,
            adapter: this.kind,
            tmuxSession: handle.tmuxSession,
            tmuxPane: handle.tmuxPane,
            stdoutBytes: Buffer.byteLength(completion.body, 'utf8'),
            completionToken: token,
            completionSource: completion.completionSource,
          },
          createdAt: completedAt,
        });
        await appendEvent(input.runId, {
          id: createId('evt'),
          runId: input.runId,
          type: 'session.completed',
          actor: input.role,
          payload: {
            role: input.role,
            adapter: this.kind,
            tmuxSession: handle.tmuxSession,
            tmuxPane: handle.tmuxPane,
            markerStatus: completion.markerStatus,
            completionSource: completion.completionSource,
            durationMs: Date.now() - startedAt,
            stdoutBytes: Buffer.byteLength(completion.body, 'utf8'),
          },
          createdAt: completedAt,
        });
        return {
          ...completion,
          body: truncateUtf8(completion.body, this.cliConfig.maxOutputBytes),
        };
      }
      const approval = extractApprovalRequest(latestStdout);
      if (approval && !reportedApprovals.has(approval.key)) {
        reportedApprovals.add(approval.key);
        const approvalId = createId('approval');
        const requestedAt = nowIso();
        const autoApprovePattern = findAutoApproveCommandPattern(approval.command, this.tmuxConfig.autoApproveCommands);
        await updateAgentSessionStatus(input.runId, input.role, 'blocked', { lastCapturedAt: requestedAt }).catch(() => undefined);
        await updateAgentStatus(input.runId, input.role, 'waiting').catch(() => undefined);
        await appendEvent(input.runId, {
          id: createId('evt'),
          runId: input.runId,
          type: 'approval.requested',
          actor: input.role,
          payload: {
            approvalId,
            role: input.role,
            adapter: this.kind,
            tmuxSession: handle.tmuxSession,
            tmuxPane: handle.tmuxPane,
            command: approval.command,
            reason: approval.reason,
            choices: approval.choices,
            prompt: approval.prompt,
            detectedAt: requestedAt,
            autoApprove: Boolean(autoApprovePattern),
            matchedCommandPattern: autoApprovePattern,
          },
          createdAt: requestedAt,
        });
        if (autoApprovePattern) {
          await this.respondToApproval(input.runId, input.role, 'approve', approvalId, {
            source: 'auto',
            matchedCommandPattern: autoApprovePattern,
          });
        }
      }
      await sleep(pollMs);
    }

    const timedOutAt = nowIso();
    await updateAgentSessionStatus(input.runId, input.role, 'blocked', { lastCapturedAt: timedOutAt }).catch(() => undefined);
    await appendEvent(input.runId, {
      id: createId('evt'),
      runId: input.runId,
      type: 'session.completion_timeout',
      actor: input.role,
      payload: {
        role: input.role,
        adapter: this.kind,
        tmuxSession: handle.tmuxSession,
        tmuxPane: handle.tmuxPane,
        completionToken: token,
        timeoutMs: this.tmuxConfig.completionTimeoutMs,
        stdoutBytes: Buffer.byteLength(latestStdout, 'utf8'),
      },
      createdAt: timedOutAt,
    });
    throw new Error(`tmux completion marker not found within ${this.tmuxConfig.completionTimeoutMs}ms`);
  }

  private runTmux(args: string[], options: { rejectOnExit?: boolean } = {}): Promise<ProcessResult> {
    const startedAt = Date.now();
    const rejectOnExit = options.rejectOnExit ?? true;
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(this.tmuxConfig.executable, [...this.tmuxConfig.args, ...args], {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
      }, this.tmuxConfig.timeoutMs);
      timeout.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const result = { stdout, stderr, exitCode, signal, durationMs: Date.now() - startedAt };
        if (rejectOnExit && exitCode !== 0) {
          reject(new Error(`tmux command failed (${basename(this.tmuxConfig.executable)} ${args.join(' ')}): ${stderr || stdout || exitCode}`));
          return;
        }
        resolve(result);
      });
    });
  }
}
