import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { POST as approvalRoute } from '../src/app/api/runs/[runId]/approvals/route';
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

if (command === 'load-buffer') {
  const buffer = argAfter(args, '-b');
  const filePath = args.at(-1);
  state.buffers[buffer] = readFileSync(filePath, 'utf8');
  state.loadedBuffers = { ...(state.loadedBuffers || {}), [buffer]: { filePath, bytes: Buffer.byteLength(state.buffers[buffer], 'utf8') } };
  writeState(state);
  process.exit(0);
}

if (command === 'paste-buffer') {
  const buffer = argAfter(args, '-b');
  const target = argAfter(args, '-t');
  const prompt = state.buffers[buffer] || '';
  const promptFile = prompt.match(/AgentBoard prompt file[^\\n]*\\n([^\\n]+)\\n/)?.[1]?.trim();
  const effectivePrompt = promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : prompt;
  const token = effectivePrompt.match(/token=([A-Za-z0-9_-]+)/)?.[1] || 'missing-token';
  state.panes = state.panes || {};
  state.panes[target] = { ...(state.panes[target] || {}), lastPrompt: prompt, lastToken: token, promptSubmitted: false };
  writeState(state);
  process.exit(0);
}

if (command === 'send-keys') {
  const target = argAfter(args, '-t');
  const key = args.at(-1);
  const pane = state.panes?.[target];
  if (pane) {
    const stuckPaste = process.env.FAKE_TMUX_STUCK_PASTE_ROLE === pane.role;
    const ignoreFirstSubmit = process.env.FAKE_TMUX_IGNORE_FIRST_SUBMIT_ROLE === pane.role;
    const isSubmitKey = key === 'Enter' || key === 'C-m';
    if (pane.promptSubmitted === false && isSubmitKey && !stuckPaste) {
      const submitKeyCount = pane.submitKeyCount || 0;
      pane.submitKeyCount = submitKeyCount + 1;
      if (!ignoreFirstSubmit || submitKeyCount > 0) {
        pane.promptSubmitted = true;
      }
    } else if (pane.promptSubmitted === false && isSubmitKey && stuckPaste) {
      pane.submitKeyCount = (pane.submitKeyCount || 0) + 1;
    } else if (pane.promptSubmitted === false && key === 'Enter') {
      pane.promptSubmitted = true;
    } else if (pane.permissionPending) {
      pane.approvalDecision = key;
      pane.permissionPending = false;
    }
  }
  writeState(state);
  process.exit(0);
}

if (command === 'delete-buffer') {
  writeState(state);
  process.exit(0);
}

if (command === 'capture-pane') {
  const target = argAfter(args, '-t');
  const pane = state.panes?.[target] || {};
  const role = pane.role || state.sessions[target]?.role || 'unknown';
  const token = pane.lastToken || 'missing-token';
  if (pane.lastPrompt && pane.promptSubmitted === false) {
    const visiblePrompt = process.env.FAKE_TMUX_VISIBLE_PROMPT_ROLE === role;
    if (visiblePrompt) {
      writeState(state);
      console.log([
        '╭─────────────────────────────────────────────────────╮',
        '│ >_ OpenAI Codex (v0.128.0)                          │',
        '╰─────────────────────────────────────────────────────╯',
        '',
        '› ' + String(pane.lastPrompt).replace(/\\n/g, '\\n  '),
        '',
        '  gpt-5.5 medium fast · main · Context 100% left · 0 in · 0 out',
      ].join('\\n'));
      process.exit(0);
    }
    const pastedPromptLine = process.env.FAKE_TMUX_PREFIXED_PASTE_ROLE === role
      ? '› 너는[Pasted Content 1306 chars][Pasted Content 2406 chars]'
      : '› [Pasted Content 1316 chars][Pasted Content 4059 chars]';
    writeState(state);
    console.log([
      '╭─────────────────────────────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.128.0)                          │',
      '╰─────────────────────────────────────────────────────╯',
      '',
      pastedPromptLine,
      '',
      '  gpt-5.5 medium fast · main · Context 100% left · 0 in · 0 out',
    ].join('\\n'));
    process.exit(0);
  }
  const status = process.env.FAKE_TMUX_BLOCKED_ROLE === role ? 'blocked' : 'complete';
  const omitMarker = process.env.FAKE_TMUX_NO_MARKER_ROLE === role;
  const omitMarkerWithIdleOutput = process.env.FAKE_TMUX_IDLE_OUTPUT_NO_MARKER_ROLE === role;
  const omitDone = process.env.FAKE_TMUX_OMIT_DONE_ROLE === role;
  const needsPermission = process.env.FAKE_TMUX_PERMISSION_ROLE === role;
  const delayDone = process.env.FAKE_TMUX_DELAY_DONE_ROLE === role;
  const begin = '<<<AGENTBOARD_BEGIN token=' + token + ' role=' + role + '>>>';
  const done = '<<<AGENTBOARD_DONE token=' + token + ' role=' + role + ' status=' + status + '>>>';
  if (needsPermission && pane.promptSubmitted && !pane.approvalDecision) {
    state.panes[target] = { ...pane, permissionPending: true };
    writeState(state);
    console.log([
      'Would you like to run the following command?',
      '',
      'Reason: Swift typecheck needs access to the compiler module cache outside',
      'the workspace. Allow this verification command?',
      '',
      '$ swiftc -typecheck examples/MockMVVMViewModels.swift',
      '',
      '› 1. Yes, proceed (y)',
      '  2. Yes, and do not ask again for commands that start with swiftc -typecheck (p)',
      '  3. No, and tell Codex what to do differently (esc)',
      '',
      'Press enter to confirm or esc to cancel',
    ].join('\\n'));
    process.exit(0);
  }
  if (delayDone) {
    const captureCount = pane.delayDoneCaptureCount || 0;
    state.panes[target] = { ...pane, delayDoneCaptureCount: captureCount + 1 };
    writeState(state);
    if (captureCount < 3) {
      console.log(begin + '\\n{' + '\\n\\n› Run /review on my current changes');
      process.exit(0);
    }
  }
  if (omitMarker) {
    const captureCount = pane.noMarkerCaptureCount || 0;
    state.panes[target] = { ...pane, noMarkerCaptureCount: captureCount + 1 };
    writeState(state);
    if (captureCount < 1) {
      console.log('• Working (1s • esc to interrupt)');
      process.exit(0);
    }
  }
  writeState(state);
  function output(body) {
    if (omitMarkerWithIdleOutput) {
      console.log([
        '› [Pasted Content 900 chars]',
        '',
        body,
        '',
        '› Use /skills to list available skills',
      ].join('\\n'));
      return;
    }
    if (omitMarker) {
      console.log(body);
      return;
    }
    if (omitDone) {
      console.log(begin + '\\n' + body + '\\n\\n› Use /skills to list available skills');
      return;
    }
    console.log(begin + '\\n' + body + '\\n' + done);
  }
  if (role === 'orchestrator') {
    output(JSON.stringify({
      strategy: 'tmux-test',
      reason: 'tmux persistent session test',
      steps: [
        { agent: 'engineer', task: 'tmux engineer task', reason: 'tmux engineer reason', expectedOutput: 'engineer output' },
        { agent: 'reviewer', task: 'tmux reviewer task', reason: 'tmux reviewer reason', expectedOutput: 'reviewer output' }
      ],
      finalResponder: 'reviewer'
    }));
  } else {
    output('[' + role + '] captured tmux output');
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
  process.env.AGENTBOARD_TMUX_COMPLETION_TIMEOUT_MS = '10000';
  process.env.AGENTBOARD_TMUX_COMPLETION_POLL_MS = '5';
  process.env.AGENTBOARD_TMUX_READY_TIMEOUT_MS = '0';
  process.env.AGENTBOARD_TMUX_PASTE_READY_TIMEOUT_MS = '0';
  process.env.AGENTBOARD_TMUX_SUBMIT_DELAY_MS = '0';
  process.env.AGENTBOARD_TMUX_SUBMIT_CONFIRM_TIMEOUT_MS = '200';
  process.env.AGENTBOARD_TMUX_SUBMIT_RETRY_COUNT = '1';
  process.env.AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS = '20';
  process.env.AGENTBOARD_TMUX_SESSION_PREFIX = 'testagentboard';
  delete process.env.AGENTBOARD_TMUX_PROMPT_TRANSPORT;
  delete process.env.AGENTBOARD_ORCHESTRATOR_TMUX_PROMPT_TRANSPORT;
  delete process.env.AGENTBOARD_PLANNER_TMUX_PROMPT_TRANSPORT;
  delete process.env.AGENTBOARD_ENGINEER_TMUX_PROMPT_TRANSPORT;
  delete process.env.AGENTBOARD_REVIEWER_TMUX_PROMPT_TRANSPORT;
  delete process.env.AGENTBOARD_AUTO_APPROVE_COMMANDS;
  delete process.env.FAKE_TMUX_NO_MARKER_ROLE;
  delete process.env.FAKE_TMUX_BLOCKED_ROLE;
  delete process.env.FAKE_TMUX_OMIT_DONE_ROLE;
  delete process.env.FAKE_TMUX_PERMISSION_ROLE;
  delete process.env.FAKE_TMUX_DELAY_DONE_ROLE;
  delete process.env.FAKE_TMUX_STUCK_PASTE_ROLE;
  delete process.env.FAKE_TMUX_PREFIXED_PASTE_ROLE;
  delete process.env.FAKE_TMUX_VISIBLE_PROMPT_ROLE;
  delete process.env.FAKE_TMUX_IGNORE_FIRST_SUBMIT_ROLE;
  delete process.env.FAKE_TMUX_IDLE_OUTPUT_NO_MARKER_ROLE;
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
  const deadline = Date.now() + 25_000;
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

async function waitForApprovalRequest(runId: string): Promise<string> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const events = await readEvents(runId);
    const requested = events.find((event) => event.type === 'approval.requested');
    const approvalId = requested?.payload.approvalId;
    if (typeof approvalId === 'string') return approvalId;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('approval.requested event was not recorded');
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
  assert.equal(updated.sessions?.planner?.status, 'completed');
  assert.equal(fakeState.logs.filter((args) => args[0] === 'new-session').length, 1);
  assert.equal(fakeState.logs.filter((args) => args[0] === 'set-buffer').length, 0);
  assert.equal(fakeState.logs.filter((args) => args[0] === 'load-buffer').length, 2);
  assert.ok(events.some((event) => event.type === 'session.created' && event.actor === 'planner'));
  assert.equal(events.filter((event) => event.type === 'session.prompt_injected' && event.actor === 'planner').length, 2);
  assert.equal(events.filter((event) => event.type === 'session.output_captured' && event.actor === 'planner').length, 2);
  assert.equal(events.filter((event) => event.type === 'session.completed' && event.actor === 'planner').length, 2);
}));

test('TmuxSessionAdapter injects long prompts through a short file-reference instruction and cleans it up', async () => withTmuxEnv(async (fakeTmuxState) => {
  const state = await createRun({ title: 'tmux long prompt', brief: '긴 prompt 파일 참조 주입', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');
  const longPrompt = `긴 prompt 시작\n${'swift view model mock\n'.repeat(20_000)}긴 prompt 끝`;

  const result = await adapter.run({ runId: state.run.id, role: 'reviewer', prompt: longPrompt });

  const [events, fakeState] = await Promise.all([
    readEvents(state.run.id),
    readFile(fakeTmuxState, 'utf8').then((body) => JSON.parse(body) as { logs: string[][]; buffers: Record<string, string>; loadedBuffers: Record<string, { filePath: string; bytes: number }> }),
  ]);
  const loadBufferCalls = fakeState.logs.filter((args) => args[0] === 'load-buffer');
  const setBufferCalls = fakeState.logs.filter((args) => args[0] === 'set-buffer');
  const loaded = Object.values(fakeState.loadedBuffers ?? {})[0];
  const pastedInstruction = Object.values(fakeState.buffers ?? {})[0] ?? '';
  const injected = events.find((event) => event.type === 'session.prompt_injected' && event.actor === 'reviewer');
  const promptFilePath = injected?.payload.promptFilePath;

  assert.match(result.stdout, /\[reviewer\] captured tmux output/);
  assert.equal(setBufferCalls.length, 0);
  assert.equal(loadBufferCalls.length, 1);
  assert.ok(loaded.bytes < 2_000);
  assert.match(pastedInstruction, /AgentBoard prompt file/);
  assert.doesNotMatch(pastedInstruction, /swift view model mock\nswift view model mock/);
  assert.equal(await readFile(loaded.filePath, 'utf8').then(() => 'exists').catch(() => 'missing'), 'missing');
  assert.equal(typeof promptFilePath, 'string');
  assert.equal(await readFile(promptFilePath as string, 'utf8').then(() => 'exists').catch(() => 'missing'), 'missing');
  assert.equal(injected?.payload.promptTransport, 'tmux-file-reference');
  assert.equal(typeof injected?.payload.promptBytes, 'number');
  assert.equal(typeof injected?.payload.promptInstructionBytes, 'number');
}));

test('TmuxSessionAdapter can fall back to full paste-buffer transport', async () => withTmuxEnv(async (fakeTmuxState) => {
  process.env.AGENTBOARD_TMUX_PROMPT_TRANSPORT = 'paste-buffer';
  const state = await createRun({ title: 'tmux paste fallback', brief: '기존 paste fallback', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');
  const longPrompt = `긴 prompt 시작\n${'swift view model mock\n'.repeat(20_000)}긴 prompt 끝`;

  const result = await adapter.run({ runId: state.run.id, role: 'planner', prompt: longPrompt });

  const [events, fakeState] = await Promise.all([
    readEvents(state.run.id),
    readFile(fakeTmuxState, 'utf8').then((body) => JSON.parse(body) as { loadedBuffers: Record<string, { filePath: string; bytes: number }> }),
  ]);
  const loaded = Object.values(fakeState.loadedBuffers ?? {})[0];
  const injected = events.find((event) => event.type === 'session.prompt_injected' && event.actor === 'planner');

  assert.match(result.stdout, /\[planner\] captured tmux output/);
  assert.ok(loaded.bytes > 300_000);
  assert.equal(await readFile(loaded.filePath, 'utf8').then(() => 'exists').catch(() => 'missing'), 'missing');
  assert.equal(injected?.payload.promptTransport, 'tmux-load-buffer-file');
  assert.equal(injected?.payload.promptFilePath, undefined);
}));

test('TmuxSessionAdapter supports role-specific prompt transport override', async () => withTmuxEnv(async () => {
  process.env.AGENTBOARD_TMUX_PROMPT_TRANSPORT = 'file-reference';
  process.env.AGENTBOARD_ORCHESTRATOR_TMUX_PROMPT_TRANSPORT = 'paste-buffer';
  const state = await createRun({ title: 'tmux role transport', brief: 'role별 prompt transport', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  await adapter.run({ runId: state.run.id, role: 'orchestrator', prompt: '사용자 요청을 라우팅해줘' });
  await adapter.run({ runId: state.run.id, role: 'engineer', prompt: 'Swift mock 앱을 구현해줘' });

  const events = await readEvents(state.run.id);
  const orchestratorInjected = events.find((event) => event.type === 'session.prompt_injected' && event.actor === 'orchestrator');
  const engineerInjected = events.find((event) => event.type === 'session.prompt_injected' && event.actor === 'engineer');

  assert.equal(orchestratorInjected?.payload.promptTransport, 'tmux-load-buffer-file');
  assert.equal(orchestratorInjected?.payload.promptFilePath, undefined);
  assert.equal(engineerInjected?.payload.promptTransport, 'tmux-file-reference');
  assert.equal(typeof engineerInjected?.payload.promptFilePath, 'string');
}));

test('TmuxSessionAdapter strips completion markers from returned output', async () => withTmuxEnv(async () => {
  const state = await createRun({ title: 'tmux marker strip', brief: 'tmux 완료 마커 제거', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  const result = await adapter.run({ runId: state.run.id, role: 'planner', prompt: '완료 마커를 제거해줘' });

  assert.match(result.stdout, /\[planner\] captured tmux output/);
  assert.doesNotMatch(result.stdout, /AGENTBOARD_DONE/);
  assert.doesNotMatch(result.stdout, /AGENTBOARD_BEGIN/);
}));

test('TmuxSessionAdapter retries when the first pasted prompt submit is ignored', async () => withTmuxEnv(async (fakeTmuxState) => {
  process.env.FAKE_TMUX_IGNORE_FIRST_SUBMIT_ROLE = 'engineer';
  const state = await createRun({ title: 'tmux submit retry', brief: '첫 submit 재시도', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  const result = await adapter.run({ runId: state.run.id, role: 'engineer', prompt: '첫 Enter가 무시되면 재시도' });

  const [events, fakeState] = await Promise.all([
    readEvents(state.run.id),
    readFile(fakeTmuxState, 'utf8').then((body) => JSON.parse(body) as { logs: string[][] }),
  ]);
  const submitted = events.find((event) => event.type === 'session.prompt_submitted' && event.actor === 'engineer');
  const submitKeys = fakeState.logs.filter((args) => args[0] === 'send-keys' && (args.at(-1) === 'Enter' || args.at(-1) === 'C-m'));

  assert.match(result.stdout, /\[engineer\] captured tmux output/);
  assert.equal(submitted?.payload.attempts, 2);
  assert.ok(submitKeys.some((args) => args.at(-1) === 'C-m'));
}));

test('TmuxSessionAdapter fails fast when a pasted prompt is not submitted', async () => withTmuxEnv(async () => {
  process.env.FAKE_TMUX_STUCK_PASTE_ROLE = 'engineer';
  process.env.AGENTBOARD_TMUX_SUBMIT_CONFIRM_TIMEOUT_MS = '10';
  process.env.AGENTBOARD_TMUX_COMPLETION_TIMEOUT_MS = '10000';
  const state = await createRun({ title: 'tmux submit failed', brief: 'prompt submit 실패', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  await assert.rejects(
    () => adapter.run({ runId: state.run.id, role: 'engineer', prompt: '붙여넣기만 되고 실행되지 않는 prompt' }),
    /tmux prompt submit failed/,
  );

  const [updated, events] = await Promise.all([
    readState(state.run.id),
    readEvents(state.run.id),
  ]);
  const failed = events.find((event) => event.type === 'session.prompt_submit_failed' && event.actor === 'engineer');

  assert.equal(updated.sessions?.engineer?.status, 'blocked');
  assert.equal(updated.agents.find((agent) => agent.role === 'engineer')?.status, 'blocked');
  assert.equal(failed?.payload.reason, 'pasted-idle');
  assert.ok(!events.some((event) => event.type === 'session.completion_timeout' && event.actor === 'engineer'));
}));

test('TmuxSessionAdapter does not treat visible file-reference instructions as submitted output', async () => withTmuxEnv(async () => {
  process.env.FAKE_TMUX_STUCK_PASTE_ROLE = 'engineer';
  process.env.FAKE_TMUX_VISIBLE_PROMPT_ROLE = 'engineer';
  process.env.AGENTBOARD_TMUX_SUBMIT_CONFIRM_TIMEOUT_MS = '10';
  process.env.AGENTBOARD_TMUX_COMPLETION_TIMEOUT_MS = '10000';
  const state = await createRun({ title: 'tmux visible instruction submit failed', brief: '짧은 instruction 미제출 감지', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  await assert.rejects(
    () => adapter.run({ runId: state.run.id, role: 'engineer', prompt: '파일 참조 instruction이 보이기만 하고 실행되지 않음' }),
    /tmux prompt submit failed/,
  );

  const events = await readEvents(state.run.id);
  const failed = events.find((event) => event.type === 'session.prompt_submit_failed' && event.actor === 'engineer');

  assert.equal(failed?.payload.reason, 'prompt-idle');
  assert.ok(!events.some((event) => event.type === 'session.prompt_submitted' && event.actor === 'engineer'));
  assert.ok(!events.some((event) => event.type === 'session.completion_timeout' && event.actor === 'engineer'));
}));

test('TmuxSessionAdapter treats prefixed pasted prompt placeholders as not submitted', async () => withTmuxEnv(async () => {
  process.env.FAKE_TMUX_STUCK_PASTE_ROLE = 'planner';
  process.env.FAKE_TMUX_PREFIXED_PASTE_ROLE = 'planner';
  process.env.AGENTBOARD_TMUX_SUBMIT_CONFIRM_TIMEOUT_MS = '10';
  const state = await createRun({ title: 'tmux prefixed paste failed', brief: 'prefix가 붙은 pasted placeholder', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  await assert.rejects(
    () => adapter.run({ runId: state.run.id, role: 'planner', prompt: '너는 Planner Agent다' }),
    /tmux prompt submit failed/,
  );

  const events = await readEvents(state.run.id);
  const failed = events.find((event) => event.type === 'session.prompt_submit_failed' && event.actor === 'planner');

  assert.equal(failed?.payload.reason, 'pasted-idle');
  assert.ok(!events.some((event) => event.type === 'session.prompt_submitted' && event.actor === 'planner'));
}));

test('TmuxSessionAdapter completes from idle prompt when DONE marker is omitted', async () => withTmuxEnv(async () => {
  process.env.FAKE_TMUX_OMIT_DONE_ROLE = 'engineer';
  const state = await createRun({ title: 'tmux idle fallback', brief: 'tmux idle prompt fallback', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  const result = await adapter.run({ runId: state.run.id, role: 'engineer', prompt: 'DONE 없이 idle prompt로 종료' });

  const [updated, events] = await Promise.all([
    readState(state.run.id),
    readEvents(state.run.id),
  ]);
  const completed = events.find((event) => event.type === 'session.completed' && event.actor === 'engineer');

  assert.match(result.stdout, /\[engineer\] captured tmux output/);
  assert.doesNotMatch(result.stdout, /AGENTBOARD_BEGIN/);
  assert.doesNotMatch(result.stdout, /Use \/skills/);
  assert.equal(updated.sessions?.engineer?.status, 'completed');
  assert.equal(completed?.payload.completionSource, 'idle-prompt-fallback');
}));

test('TmuxSessionAdapter completes from stable idle output when all markers are omitted', async () => withTmuxEnv(async () => {
  process.env.FAKE_TMUX_IDLE_OUTPUT_NO_MARKER_ROLE = 'reviewer';
  const state = await createRun({ title: 'tmux idle output fallback', brief: 'marker 없는 idle output fallback', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  const result = await adapter.run({ runId: state.run.id, role: 'reviewer', prompt: 'marker 없이 답변 후 idle prompt' });

  const events = await readEvents(state.run.id);
  const completed = events.find((event) => event.type === 'session.completed' && event.actor === 'reviewer');

  assert.match(result.stdout, /\[reviewer\] captured tmux output/);
  assert.doesNotMatch(result.stdout, /Pasted Content/);
  assert.equal(completed?.payload.completionSource, 'idle-output-fallback');
}));

test('TmuxSessionAdapter waits for DONE instead of accepting an unstable idle fallback', async () => withTmuxEnv(async () => {
  process.env.FAKE_TMUX_DELAY_DONE_ROLE = 'orchestrator';
  process.env.AGENTBOARD_TMUX_IDLE_FALLBACK_STABLE_MS = '1000';
  const state = await createRun({ title: 'tmux delayed done', brief: '부분 JSON을 조기 완료하면 안 됨', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  const result = await adapter.run({ runId: state.run.id, role: 'orchestrator', prompt: 'JSON 출력 중 DONE이 늦게 도착' });

  const events = await readEvents(state.run.id);
  const completed = events.find((event) => event.type === 'session.completed' && event.actor === 'orchestrator');

  assert.match(result.stdout, /"strategy":"tmux-test"/);
  assert.doesNotMatch(result.stdout, /^\\{$/);
  assert.equal(completed?.payload.completionSource, 'done-marker');
}));

test('TmuxSessionAdapter records completion timeout when marker is missing', async () => withTmuxEnv(async () => {
  process.env.FAKE_TMUX_NO_MARKER_ROLE = 'planner';
  process.env.AGENTBOARD_TMUX_COMPLETION_TIMEOUT_MS = '20';
  const state = await createRun({ title: 'tmux timeout', brief: 'tmux 완료 마커 timeout', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  await assert.rejects(
    () => adapter.run({ runId: state.run.id, role: 'planner', prompt: '완료 마커 없이 응답' }),
    /tmux completion marker not found/,
  );

  const [updated, events] = await Promise.all([
    readState(state.run.id),
    readEvents(state.run.id),
  ]);
  assert.equal(updated.sessions?.planner?.status, 'blocked');
  assert.ok(events.some((event) => event.type === 'session.completion_timeout' && event.actor === 'planner'));
}));

test('TmuxSessionAdapter surfaces permission prompts and resumes after approval', async () => withTmuxEnv(async (fakeTmuxState) => {
  process.env.FAKE_TMUX_PERMISSION_ROLE = 'reviewer';
  const state = await createRun({ title: 'tmux approval', brief: 'tmux 권한 요청 표시', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  const runPromise = adapter.run({ runId: state.run.id, role: 'reviewer', prompt: 'typecheck 실행이 필요한 응답' });
  const approvalId = await waitForApprovalRequest(state.run.id);
  const approvalResponse = await approvalRoute(new Request(`http://agentboard.test/api/runs/${state.run.id}/approvals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reviewer', action: 'approve', approvalId }),
  }), {
    params: Promise.resolve({ runId: state.run.id }),
  });
  const result = await runPromise;

  const [updated, events, fakeState] = await Promise.all([
    readState(state.run.id),
    readEvents(state.run.id),
    readFile(fakeTmuxState, 'utf8').then((body) => JSON.parse(body) as { logs: string[][] }),
  ]);
  const requested = events.find((event) => event.type === 'approval.requested' && event.actor === 'reviewer');
  const approved = events.find((event) => event.type === 'approval.approved' && event.actor === 'reviewer');
  const enterCount = fakeState.logs.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter').length;

  assert.equal(approvalResponse.status, 200);
  assert.match(result.stdout, /\[reviewer\] captured tmux output/);
  assert.equal(updated.sessions?.reviewer?.status, 'completed');
  assert.ok(['thinking', 'waiting'].includes(updated.agents.find((agent) => agent.role === 'reviewer')?.status ?? ''));
  assert.equal(requested?.payload.approvalId, approvalId);
  assert.equal(requested?.payload.command, 'swiftc -typecheck examples/MockMVVMViewModels.swift');
  assert.equal(approved?.payload.approvalId, approvalId);
  assert.ok(enterCount >= 2);
}));

test('TmuxSessionAdapter can reject permission prompts through the approval API', async () => withTmuxEnv(async (fakeTmuxState) => {
  process.env.FAKE_TMUX_PERMISSION_ROLE = 'engineer';
  const state = await createRun({ title: 'tmux approval reject', brief: 'tmux 권한 요청 거절', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  const runPromise = adapter.run({ runId: state.run.id, role: 'engineer', prompt: '권한 요청 거절 흐름' });
  const approvalId = await waitForApprovalRequest(state.run.id);
  const approvalResponse = await approvalRoute(new Request(`http://agentboard.test/api/runs/${state.run.id}/approvals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'engineer', action: 'reject', approvalId }),
  }), {
    params: Promise.resolve({ runId: state.run.id }),
  });
  const result = await runPromise;

  const [events, fakeState] = await Promise.all([
    readEvents(state.run.id),
    readFile(fakeTmuxState, 'utf8').then((body) => JSON.parse(body) as { logs: string[][] }),
  ]);
  const rejected = events.find((event) => event.type === 'approval.rejected' && event.actor === 'engineer');
  const escapeCount = fakeState.logs.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Escape').length;

  assert.equal(approvalResponse.status, 200);
  assert.match(result.stdout, /\[engineer\] captured tmux output/);
  assert.equal(rejected?.payload.approvalId, approvalId);
  assert.ok(escapeCount >= 1);
}));

test('TmuxSessionAdapter auto-approves allowlisted permission prompts', async () => withTmuxEnv(async (fakeTmuxState) => {
  process.env.FAKE_TMUX_PERMISSION_ROLE = 'engineer';
  process.env.AGENTBOARD_AUTO_APPROVE_COMMANDS = 'swiftc -typecheck *';
  const state = await createRun({ title: 'tmux approval auto approve', brief: 'allowlist 자동 승인', mode: 'cli' });
  const adapter = new TmuxSessionAdapter('tmux-codex');

  const result = await adapter.run({ runId: state.run.id, role: 'engineer', prompt: 'allowlist에 있는 검증 명령 실행' });

  const [updated, events, fakeState] = await Promise.all([
    readState(state.run.id),
    readEvents(state.run.id),
    readFile(fakeTmuxState, 'utf8').then((body) => JSON.parse(body) as { logs: string[][] }),
  ]);
  const requested = events.find((event) => event.type === 'approval.requested' && event.actor === 'engineer');
  const approved = events.find((event) => event.type === 'approval.approved' && event.actor === 'engineer');
  const enterCount = fakeState.logs.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter').length;

  assert.match(result.stdout, /\[engineer\] captured tmux output/);
  assert.equal(updated.sessions?.engineer?.status, 'completed');
  assert.equal(requested?.payload.autoApprove, true);
  assert.equal(requested?.payload.matchedCommandPattern, 'swiftc -typecheck *');
  assert.equal(approved?.payload.source, 'auto');
  assert.equal(approved?.payload.matchedCommandPattern, 'swiftc -typecheck *');
  assert.ok(enterCount >= 2);
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
