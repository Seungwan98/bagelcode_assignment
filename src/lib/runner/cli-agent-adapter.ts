import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { AgentRole } from '@/lib/protocol/types';
import type { CliAdapterKind } from '@/lib/runner/agent-config';

export type CliPromptMode = 'stdin' | 'append-arg';

export interface CliCommandConfig {
  executable: string;
  args: string[];
  promptMode: CliPromptMode;
  timeoutMs: number;
  maxOutputBytes: number;
  allowlist: string[];
}

export interface CliAgentRunInput {
  runId: string;
  role: AgentRole;
  prompt: string;
  signal?: AbortSignal;
}

export interface CliAgentRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export class CliAgentError extends Error {
  constructor(
    message: string,
    readonly details: { stdout?: string; stderr?: string; exitCode?: number | null; signal?: NodeJS.Signals | null } = {},
  ) {
    super(message);
    this.name = 'CliAgentError';
  }
}

const COMMAND_ENV_KEYS: Record<CliAdapterKind, string> = {
  codex: 'AGENTBOARD_CODEX_CMD',
  claude: 'AGENTBOARD_CLAUDE_CMD',
  gemini: 'AGENTBOARD_GEMINI_CMD',
};

const PROMPT_MODE_ENV_KEYS: Record<CliAdapterKind, string> = {
  codex: 'AGENTBOARD_CODEX_PROMPT_MODE',
  claude: 'AGENTBOARD_CLAUDE_PROMPT_MODE',
  gemini: 'AGENTBOARD_GEMINI_PROMPT_MODE',
};

const DEFAULT_ALLOWLIST = ['codex', 'claude', 'gemini'];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256_000;

export function parseCommandSpec(spec: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;

  for (const char of spec.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (!quote && /[|&;<>()\n\r]/.test(char)) {
      throw new Error('CLI command contains unsupported shell metacharacters');
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  if (quote) throw new Error('CLI command contains an unterminated quote');
  if (current) tokens.push(current);
  if (!tokens.length) throw new Error('CLI command is empty');
  return tokens;
}

function parsePromptMode(value: string | undefined): CliPromptMode {
  const normalized = (value ?? 'stdin').trim().toLowerCase();
  if (normalized === 'stdin' || normalized === 'append-arg') return normalized;
  throw new Error('CLI prompt mode must be stdin or append-arg');
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return Math.round(parsed);
}

function parseAllowlist(env: NodeJS.ProcessEnv): string[] {
  return (env.AGENTBOARD_CLI_ALLOWLIST ?? DEFAULT_ALLOWLIST.join(','))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function assertAllowedExecutable(executable: string, allowlist: string[]): void {
  const executableName = basename(executable);
  if (!allowlist.includes(executable) && !allowlist.includes(executableName)) {
    throw new Error(`CLI executable is not allowlisted: ${executableName}`);
  }
}

export function resolveCliCommandConfig(adapter: CliAdapterKind, env: NodeJS.ProcessEnv = process.env): CliCommandConfig {
  const commandEnvKey = COMMAND_ENV_KEYS[adapter];
  const spec = env[commandEnvKey]?.trim();
  if (!spec) {
    throw new Error(`${commandEnvKey} is required when using ${adapter} adapter`);
  }
  const [executable, ...args] = parseCommandSpec(spec);
  const allowlist = parseAllowlist(env);
  assertAllowedExecutable(executable, allowlist);

  return {
    executable,
    args,
    allowlist,
    promptMode: parsePromptMode(env[PROMPT_MODE_ENV_KEYS[adapter]] ?? env.AGENTBOARD_CLI_PROMPT_MODE),
    timeoutMs: parsePositiveInteger(env.AGENTBOARD_CLI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'AGENTBOARD_CLI_TIMEOUT_MS'),
    maxOutputBytes: parsePositiveInteger(env.AGENTBOARD_CLI_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES, 'AGENTBOARD_CLI_MAX_OUTPUT_BYTES'),
  };
}

function appendLimited(current: string, chunk: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) return { text: next, truncated: false };
  return { text: next.slice(0, maxBytes), truncated: true };
}

export class CliAgentAdapter {
  constructor(
    readonly kind: CliAdapterKind,
    readonly config: CliCommandConfig = resolveCliCommandConfig(kind),
  ) {
    assertAllowedExecutable(config.executable, config.allowlist);
  }

  run(input: CliAgentRunInput): Promise<CliAgentRunResult> {
    const startedAt = Date.now();
    const args = this.config.promptMode === 'append-arg'
      ? [...this.config.args, input.prompt]
      : [...this.config.args];

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let outputLimitExceeded = false;

      const child = spawn(this.config.executable, args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTBOARD_RUN_ID: input.runId,
          AGENTBOARD_AGENT_ROLE: input.role,
          AGENTBOARD_AGENT_ADAPTER: this.kind,
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, this.config.timeoutMs);
      timeout.unref?.();

      const abort = () => child.kill('SIGTERM');
      input.signal?.addEventListener('abort', abort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        const next = appendLimited(stdout, chunk, this.config.maxOutputBytes);
        stdout = next.text;
        if (next.truncated) {
          outputLimitExceeded = true;
          child.kill('SIGTERM');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const next = appendLimited(stderr, chunk, this.config.maxOutputBytes);
        stderr = next.text;
        if (next.truncated) {
          outputLimitExceeded = true;
          child.kill('SIGTERM');
        }
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', abort);
        reject(new CliAgentError(error.message, { stdout, stderr }));
      });
      child.on('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', abort);
        const durationMs = Date.now() - startedAt;
        if (input.signal?.aborted) {
          reject(new CliAgentError(`${this.kind} adapter was aborted`, { stdout, stderr, exitCode, signal }));
          return;
        }
        if (timedOut) {
          reject(new CliAgentError(`${this.kind} adapter timed out after ${this.config.timeoutMs}ms`, { stdout, stderr, exitCode, signal }));
          return;
        }
        if (outputLimitExceeded) {
          reject(new CliAgentError(`${this.kind} adapter exceeded output limit`, { stdout, stderr, exitCode, signal }));
          return;
        }
        if (exitCode !== 0) {
          reject(new CliAgentError(`${this.kind} adapter exited with code ${exitCode}`, { stdout, stderr, exitCode, signal }));
          return;
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: exitCode ?? 0, durationMs });
      });

      if (this.config.promptMode === 'stdin') child.stdin.end(input.prompt);
      else child.stdin.end();
    });
  }
}
