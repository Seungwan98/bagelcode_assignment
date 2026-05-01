import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { sendMessage } from '../src/lib/bus/message-bus';
import { startCliRun } from '../src/lib/runner/cli-runner';
import { TmuxSessionAdapter } from '../src/lib/runner/tmux-session-adapter';
import { createRun, readEvents, readMessages, readState } from '../src/lib/store/file-store';

const FAKE_TMUX_SCRIPT = `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const statePath = process.env.FAKE_TMUX_STATE;
if (!statePath) throw new Error('FAKE_TMUX_STATE is required');

function readState() {
  if (!existsSync(statePath)) return { sessions: {}, buffers: {}, logs: [], nextPane: 1 };
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function writeState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function argAfter(args, key) {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const command = args[0];
const state = readState();
state.logs.push(args);

if (command === 'has-session') {
  const target = argAfter(args, '-t');
  writeState(state);
  process.exit(state.sessions[target] ? 0 : 1);
}

if (command === 'new-session') {
  const session = argAfter(args, '-s');
  const role = argAfter(args, '-n') || 'unknown';
  const pane = '%' + state.nextPane++;
  state.sessions[session] = { role, pane };
  state.panes = { ...(state.panes || {}), [pane]: { role, session } };
  writeState(state);
  process.exit(0);
}

if (command === 'display-message') {
  const target = argAfter(args, '-t');
  writeState(state);
  console.log(state.sessions[target]?.pane || '%missing');
  process.exit(0);
}

if (command === 'set-buffer') {
  const buffer = argAfter(args, '-b');
  state.buffers[buffer] = args.at(-1) || '';
  writeState(state);
  process.exit(0);
}

if (command === 'paste-buffer' || command === 'send-keys' || command === 'delete-buffer') {
  writeState(state);
  process.exit(0);
}

if (command === 'capture-pane') {
  const target = argAfter(args, '-t');
  const role = state.panes?.[target]?.role || state.sessions[target]?.role || 'unknown';
  writeState(state);
  if (role === 'orchestrator') {
    console.log(JSON.stringify({
      strategy: 'tmux-test',
      reason: 'tmux persistent session test',
      steps: [
        { agent: 'engineer', task: 'tmux engineer task', reason: 'tmux engineer reason', expectedOutput: 'engineer output' },
        { agent: 'reviewer', task: 'tmux reviewer task', reason: 'tmux reviewer reason', expectedOutput: 'reviewer output' }
      ],
      finalResponder: 'reviewer'
    }));
  } else {
    console.log('[' + role + '] captured tmux output');
  }
  process.exit(0);
}

if (command === 'kill-session') {
  const target = argAfter(args, '-t');
  delete state.sessions[target];
  writeState(state);
  process.exit(0);
}

writeState(state);
process.exit(0);
`;

async function withTmuxEnv<T>(fn: (statePath: string) => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  const stateDir = await mkdtemp(join(tmpdir(), 'agentboard-tmux-state-'));
  const scriptDir = await mkdtemp(join(tmpdir(), 'agentboard-fake-tmux-'));
  const fakeTmux = join(scriptDir, 'fake-tmux.mjs');
  const fakeCli = join(scriptDir, 'fake-codex.mjs');
  const fakeTmuxState = join(scriptDir, 'fake-tmux-state.json');
  await writeFile(fakeTmux, FAKE_TMUX_SCRIPT, 'utf8');
  await writeFile(fakeCli, 'process.stdin.resume();', 'utf8');
  process.env.AGENTBOARD_STATE_DIR = stateDir;
  process.env.AGENTBOARD_TMUX_CMD = `${process.execPath} ${fakeTmux}`;
  process.env.AGENTBOARD_TMUX_ALLOWLIST = basename(process.execPath);
  process.env.AGENTBOARD_TMUX_CAPTURE_DELAY_MS = '0';
  process.env.AGENTBOARD_TMUX_SESSION_PREFIX = 'testagentboard';
  process.env.FAKE_TMUX_STATE = fakeTmuxState;
  process.env.AGENTBOARD_CODEX_CMD = `${process.execPath} ${fakeCli}`;
  process.env.AGENTBOARD_CLI_ALLOWLIST = basename(process.execPath);
  process.env.AGENTBOARD_CODEX_PROMPT_MODE = 'stdin';
  process.env.AGENTBOARD_CLI_TIMEOUT_MS = '5000';
  process.env.AGENTBOARD_ORCHESTRATOR_ADAPTER = 'tmux-codex';
  process.env.AGENTBOARD_PLANNER_ADAPTER = 'tmux-codex';
  process.env.AGENTBOARD_ENGINEER_ADAPTER = 'tmux-codex';
  process.env.AGENTBOARD_REVIEWER_ADAPTER = 'tmux-codex';
  try {
    return await fn(fakeTmuxState);
  } finally {
    process.env = previous;
    await rm(stateDir, { recursive: true, force: true });
    await rm(scriptDir, { recursive: true, force: true });
  }
}

async function waitForCompletedRun(runId: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const state = await readState(runId);
    if (state.run.status === 'completed' || state.run.status === 'failed') {
      assert.equal(state.run.status, 'completed');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('tmux cli run did not finish');
}

test('TmuxSessionAdapter creates and reuses a persistent role session', async () => withTmuxEnv(async (fakeTmuxState) => {
  const state = await createRun({ title: 'tmux direct', brief: 'tmux 직접 주입', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  await adapter.run({ runId: state.run.id, role: 'planner', prompt: '첫 번째 prompt' });
  await adapter.run({ runId: state.run.id, role: 'planner', prompt: '두 번째 prompt' });

  const [updated, events] = await Promise.all([
    readState(state.run.id),
    readEvents(state.run.id),
  ]);
  const fakeState = JSON.parse(await readFile(fakeTmuxState, 'utf8')) as { logs: string[][] };

  assert.equal(updated.sessions?.planner?.adapter, 'tmux-codex');
  assert.equal(updated.sessions?.planner?.transport, 'tmux');
  assert.equal(updated.sessions?.planner?.status, 'idle');
  assert.equal(fakeState.logs.filter((args) => args[0] === 'new-session').length, 1);
  assert.ok(events.some((event) => event.type === 'session.created' && event.actor === 'planner'));
  assert.equal(events.filter((event) => event.type === 'session.prompt_injected' && event.actor === 'planner').length, 2);
  assert.equal(events.filter((event) => event.type === 'session.output_captured' && event.actor === 'planner').length, 2);
}));

test('CLI runner invokes tmux-codex adapters through persistent sessions', async () => withTmuxEnv(async () => {
  const state = await createRun({ title: 'tmux runner', brief: 'tmux runner를 검증해줘', mode: 'cli' });
  await sendMessage({
    runId: state.run.id,
    from: 'user',
    to: 'all',
    kind: 'user_intervention',
    body: 'tmux 세션으로 처리해줘',
  });

  startCliRun(state.run.id);
  await waitForCompletedRun(state.run.id);

  const [completed, messages, events] = await Promise.all([
    readState(state.run.id),
    readMessages(state.run.id),
    readEvents(state.run.id),
  ]);

  assert.equal(completed.run.status, 'completed');
  assert.equal(completed.agents.find((agent) => agent.role === 'orchestrator')?.adapter, 'tmux-codex');
  assert.equal(completed.sessions?.orchestrator?.transport, 'tmux');
  assert.equal(completed.sessions?.engineer?.transport, 'tmux');
  assert.equal(completed.sessions?.reviewer?.transport, 'tmux');
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'engineer'));
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'orchestrator' && /Orchestrator Verdict: complete/.test(message.body)));
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'user' && /reviewer/.test(message.body)));
  assert.ok(events.some((event) => event.type === 'session.prompt_injected' && event.actor === 'orchestrator'));
  assert.ok(events.some((event) => event.type === 'session.output_captured' && event.actor === 'reviewer'));
}));
