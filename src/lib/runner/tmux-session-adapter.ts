import { spawn } from 'node:child_process';
import { basename } from 'node:path';
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
  readState,
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
  sessionPrefix: string;
}

const DEFAULT_TMUX_TIMEOUT_MS = 10_000;
const DEFAULT_TMUX_CAPTURE_DELAY_MS = 1_000;
const DEFAULT_TMUX_CAPTURE_HISTORY_LINES = 400;
const DEFAULT_TMUX_SESSION_PREFIX = 'agentboard';

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
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function tmuxSessionName(runId: string, role: AgentRole, prefix = DEFAULT_TMUX_SESSION_PREFIX): string {
  return `${safeTmuxToken(prefix)}_${safeTmuxToken(runId)}_${safeTmuxToken(role)}`;
}

export function tmuxBufferName(runId: string, role: AgentRole): string {
  return `agentboard_${safeTmuxToken(runId)}_${safeTmuxToken(role)}_${Date.now().toString(36)}`;
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
    sessionPrefix: env.AGENTBOARD_TMUX_SESSION_PREFIX?.trim() || DEFAULT_TMUX_SESSION_PREFIX,
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
    await this.injectPrompt(input.runId, input.role, input.prompt, handle);
    if (this.tmuxConfig.captureDelayMs > 0) await sleep(this.tmuxConfig.captureDelayMs);
    const stdout = await this.captureOutput(input.runId, input.role, handle);
    return {
      stdout: stdout.trim(),
      stderr: '',
      exitCode: 0,
      durationMs: Date.now() - startedAt,
    };
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
    await this.runTmux(['new-session', '-d', '-s', tmuxSession, '-n', tmuxWindow]);
    await this.runTmux(['send-keys', '-t', tmuxSession, command, 'C-m']);
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
    return saved;
  }

  async injectPrompt(runId: string, role: AgentRole, prompt: string, handle?: AgentSessionHandle): Promise<void> {
    const session = handle ?? await this.ensureSession(runId, role);
    const injectedAt = nowIso();
    await updateAgentSessionStatus(runId, role, 'running', { lastInjectedAt: injectedAt });
    const buffer = tmuxBufferName(runId, role);
    await this.runTmux(['set-buffer', '-b', buffer, prompt]);
    await this.runTmux(['paste-buffer', '-b', buffer, '-t', session.tmuxPane || session.tmuxSession]);
    await this.runTmux(['send-keys', '-t', session.tmuxPane || session.tmuxSession, 'C-m']);
    await this.runTmux(['delete-buffer', '-b', buffer]).catch(() => undefined);
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
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
      },
      createdAt: injectedAt,
    });
  }

  async captureOutput(runId: string, role: AgentRole, handle?: AgentSessionHandle): Promise<string> {
    const session = handle ?? await this.ensureSession(runId, role);
    const result = await this.runTmux([
      'capture-pane',
      '-p',
      '-t',
      session.tmuxPane || session.tmuxSession,
      '-S',
      `-${this.tmuxConfig.captureHistoryLines}`,
    ]);
    const capturedAt = nowIso();
    const stdout = truncateUtf8(result.stdout, this.cliConfig.maxOutputBytes);
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

  private async hasSession(tmuxSession: string): Promise<boolean> {
    const result = await this.runTmux(['has-session', '-t', tmuxSession], { rejectOnExit: false });
    return result.exitCode === 0;
  }

  private commandLine(): string {
    return [this.cliConfig.executable, ...this.cliConfig.args].map(shellQuote).join(' ');
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
