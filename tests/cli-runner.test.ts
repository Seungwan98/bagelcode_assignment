import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { sendMessage } from '../src/lib/bus/message-bus';
import { startCliRun } from '../src/lib/runner/cli-runner';
import { createRun, readArtifact, readMessages, readState } from '../src/lib/store/file-store';

async function withCliEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  const stateDir = await mkdtemp(join(tmpdir(), 'agentboard-cli-state-'));
  const cliDir = await mkdtemp(join(tmpdir(), 'agentboard-cli-script-'));
  const script = join(cliDir, 'agent-cli.mjs');
  await writeFile(script, `
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  const role = process.env.AGENTBOARD_AGENT_ROLE || 'unknown';
  console.log('[' + role + '] ' + prompt);
});
`, 'utf8');
  process.env.AGENTBOARD_STATE_DIR = stateDir;
  process.env.AGENTBOARD_PLANNER_ADAPTER = 'codex';
  process.env.AGENTBOARD_ENGINEER_ADAPTER = 'codex';
  process.env.AGENTBOARD_REVIEWER_ADAPTER = 'codex';
  process.env.AGENTBOARD_CODEX_CMD = `${process.execPath} ${script}`;
  process.env.AGENTBOARD_CLI_ALLOWLIST = basename(process.execPath);
  process.env.AGENTBOARD_CODEX_PROMPT_MODE = 'stdin';
  process.env.AGENTBOARD_CLI_TIMEOUT_MS = '5000';
  try {
    return await fn();
  } finally {
    process.env = previous;
    await rm(stateDir, { recursive: true, force: true });
    await rm(cliDir, { recursive: true, force: true });
  }
}

async function waitForRun(runId: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const state = await readState(runId);
    if (state.run.status === 'completed' || state.run.status === 'failed') {
      assert.equal(state.run.status, 'completed');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('cli run did not finish');
}

test('CLI runner invokes configured adapters and creates final artifact', async () => withCliEnv(async () => {
  const state = await createRun({ title: 'cli', brief: 'CLI adapter를 검증해줘', mode: 'cli' });
  await sendMessage({
    runId: state.run.id,
    from: 'user',
    to: 'engineer',
    kind: 'user_intervention',
    body: 'CLI 테스트 지시를 반영해줘',
  });

  startCliRun(state.run.id);
  await waitForRun(state.run.id);

  const [completed, messages, artifact] = await Promise.all([
    readState(state.run.id),
    readMessages(state.run.id),
    readArtifact(state.run.id),
  ]);
  assert.equal(completed.run.mode, 'cli');
  assert.equal(completed.run.status, 'completed');
  assert.ok(completed.agents.every((agent) => agent.adapter === 'codex'));
  assert.ok(messages.some((message) => message.from === 'planner' && message.to === 'engineer'));
  assert.ok(messages.some((message) => message.from === 'engineer' && message.to === 'reviewer'));
  assert.ok(messages.some((message) => message.from === 'reviewer' && message.to === 'planner'));
  assert.match(artifact, /CLI 테스트 지시를 반영해줘/);
}));
