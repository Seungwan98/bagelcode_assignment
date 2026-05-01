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
  if (role === 'orchestrator') {
    if (prompt.includes('[Orchestrator Verification Candidate]')) {
      console.log(JSON.stringify({
        status: 'complete',
        reason: 'CLI 테스트 후보 답변이 사용자 목적을 충족합니다.',
        userAnswer: 'CLI 테스트 지시를 반영해줘 - Orchestrator 검증 완료',
        nextSteps: []
      }));
      return;
    }
    console.log(JSON.stringify({
      strategy: 'dynamic-orchestrator',
      reason: 'CLI 테스트는 Engineer와 Reviewer 품질 게이트가 필요합니다.',
      steps: [
        {
          agent: 'engineer',
          task: 'CLI 테스트 지시를 기술 관점으로 반영한다.',
          reason: 'adapter 실행 검증이 필요합니다.',
          expectedOutput: 'Reviewer가 검토할 CLI 실행 결과'
        },
        {
          agent: 'reviewer',
          task: 'Engineer 결과의 누락과 위험을 검토한다.',
          reason: '최종 답변 전 품질 점검이 필요합니다.',
          expectedOutput: 'Orchestrator가 최종 답변에 반영할 품질 검토 리포트'
        }
      ],
      finalResponder: 'reviewer'
    }));
    return;
  }
  console.log('[' + role + '] ' + prompt);
});
`, 'utf8');
  process.env.AGENTBOARD_STATE_DIR = stateDir;
  process.env.AGENTBOARD_ORCHESTRATOR_ADAPTER = 'codex';
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
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'engineer'));
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'reviewer'));
  assert.ok(!messages.some((message) => message.from === 'planner' && message.to === 'engineer'));
  assert.ok(messages.some((message) => message.from === 'engineer' && message.to === 'reviewer'));
  assert.ok(messages.some((message) => message.from === 'reviewer' && message.to === 'orchestrator'));
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'orchestrator' && /Orchestrator Verdict: complete/.test(message.body)));
  assert.ok(messages.some((message) => message.from === 'orchestrator' && message.to === 'user' && /CLI 테스트 지시를 반영해줘/.test(message.body)));
  assert.match(artifact, /CLI 테스트 지시를 반영해줘/);
  assert.match(artifact, /Orchestrator Plan/);
  assert.match(artifact, /Orchestrator Verdicts/);
}));
