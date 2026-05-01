import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendMessage } from '../src/lib/bus/message-bus';
import { startCliRun, validateCliRunnerConfig } from '../src/lib/runner/cli-runner';
import { createRun, readArtifact, readEvents, readMessages, readState } from '../src/lib/store/file-store';

const ROLES = ['orchestrator', 'planner', 'engineer', 'reviewer'] as const;

function requireOptIn(): boolean {
  if (process.env.AGENTBOARD_RUN_REAL_CLI_SMOKE === '1') return true;
  console.log('SKIP real CLI smoke: set AGENTBOARD_RUN_REAL_CLI_SMOKE=1 to run against AGENTBOARD_CODEX_CMD.');
  return false;
}

function setDefaultEnv(key: string, value: string): void {
  if (!process.env[key]) process.env[key] = value;
}

async function waitForTerminalRun(runId: string): Promise<void> {
  const timeoutMs = Number(process.env.AGENTBOARD_CLI_SMOKE_TIMEOUT_MS ?? '180000');
  const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 180000);
  while (Date.now() < deadline) {
    const state = await readState(runId);
    if (state.run.status === 'completed' || state.run.status === 'failed' || state.run.status === 'stopped' || state.run.status === 'stale') {
      if (state.run.status !== 'completed') throw new Error(`CLI smoke run ended as ${state.run.status}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`CLI smoke run timed out for ${runId}`);
}

async function main(): Promise<void> {
  if (!requireOptIn()) return;
  if (!process.env.AGENTBOARD_CODEX_CMD) {
    throw new Error('AGENTBOARD_CODEX_CMD is required for real CLI smoke.');
  }

  let tempStateDir: string | undefined;
  if (!process.env.AGENTBOARD_STATE_DIR) {
    tempStateDir = await mkdtemp(join(tmpdir(), 'agentboard-real-cli-smoke-'));
    process.env.AGENTBOARD_STATE_DIR = tempStateDir;
  }

  for (const role of ROLES) setDefaultEnv(`AGENTBOARD_${role.toUpperCase()}_ADAPTER`, 'codex');
  setDefaultEnv('AGENTBOARD_CODEX_PROMPT_MODE', 'stdin');
  setDefaultEnv('AGENTBOARD_CLI_TIMEOUT_MS', '120000');
  setDefaultEnv('AGENTBOARD_CONTINUATION_ENABLED', 'false');

  try {
    const validation = validateCliRunnerConfig([...ROLES]);
    if (!validation.ok) throw new Error(validation.message);

    const state = await createRun({
      title: 'real cli smoke',
      brief: '실제 Codex CLI adapter에서 Orchestrator 검증 루프가 동작하는지 짧게 확인해줘.',
      mode: 'cli',
      agents: [...ROLES],
    });
    await sendMessage({
      runId: state.run.id,
      from: 'user',
      to: 'all',
      kind: 'user_intervention',
      body: '실제 CLI smoke입니다. 한 문단으로 답하고 Orchestrator verdict JSON 검증까지 수행해줘.',
    });

    startCliRun(state.run.id);
    await waitForTerminalRun(state.run.id);

    const [completed, messages, events, artifact] = await Promise.all([
      readState(state.run.id),
      readMessages(state.run.id),
      readEvents(state.run.id),
      readArtifact(state.run.id),
    ]);

    const hasVerdict = messages.some((message) => message.from === 'orchestrator' && message.to === 'orchestrator' && /Orchestrator Verdict:/i.test(message.body));
    const hasUserAnswer = messages.some((message) => message.from === 'orchestrator' && message.to === 'user' && message.kind === 'result');
    if (!hasVerdict) throw new Error('CLI smoke did not record orchestrator verdict.');
    if (!hasUserAnswer) throw new Error('CLI smoke did not record orchestrator user answer.');

    console.log(JSON.stringify({
      ok: true,
      runId: completed.run.id,
      status: completed.run.status,
      events: events.length,
      messages: messages.length,
      artifactBytes: Buffer.byteLength(artifact, 'utf8'),
      stateDir: process.env.AGENTBOARD_STATE_DIR,
    }, null, 2));
  } finally {
    if (tempStateDir && process.env.AGENTBOARD_CLI_SMOKE_KEEP_STATE !== '1') {
      await rm(tempStateDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
