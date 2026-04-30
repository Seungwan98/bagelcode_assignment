import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { CliAgentAdapter, parseCommandSpec, resolveCliCommandConfig } from '../src/lib/runner/cli-agent-adapter';

async function createEchoCli(): Promise<{ dir: string; script: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'agentboard-cli-'));
  const script = join(dir, 'echo-cli.mjs');
  await writeFile(script, `
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  console.log(JSON.stringify({ args: process.argv.slice(2), stdin, role: process.env.AGENTBOARD_AGENT_ROLE }));
});
`, 'utf8');
  return { dir, script, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('parseCommandSpec supports quoted args and rejects shell metacharacters', () => {
  assert.deepEqual(parseCommandSpec('codex exec "hello world"'), ['codex', 'exec', 'hello world']);
  assert.throws(() => parseCommandSpec('codex exec hello; rm -rf /'), /metacharacters/);
});

test('CliAgentAdapter sends prompt through stdin mode', async () => {
  const fake = await createEchoCli();
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTBOARD_CODEX_CMD: `${process.execPath} ${fake.script}`,
      AGENTBOARD_CLI_ALLOWLIST: basename(process.execPath),
      AGENTBOARD_CODEX_PROMPT_MODE: 'stdin',
    };
    const adapter = new CliAgentAdapter('codex', resolveCliCommandConfig('codex', env));
    const result = await adapter.run({ runId: 'run_cli', role: 'planner', prompt: '프롬프트 본문' });
    const parsed = JSON.parse(result.stdout) as { stdin: string; role: string };
    assert.equal(parsed.stdin, '프롬프트 본문');
    assert.equal(parsed.role, 'planner');
  } finally {
    await fake.cleanup();
  }
});

test('CliAgentAdapter appends prompt as argument when configured', async () => {
  const fake = await createEchoCli();
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTBOARD_CODEX_CMD: `${process.execPath} ${fake.script} --print`,
      AGENTBOARD_CLI_ALLOWLIST: basename(process.execPath),
      AGENTBOARD_CODEX_PROMPT_MODE: 'append-arg',
    };
    const adapter = new CliAgentAdapter('codex', resolveCliCommandConfig('codex', env));
    const result = await adapter.run({ runId: 'run_cli', role: 'engineer', prompt: 'argument prompt' });
    const parsed = JSON.parse(result.stdout) as { args: string[]; stdin: string };
    assert.deepEqual(parsed.args, ['--print', 'argument prompt']);
    assert.equal(parsed.stdin, '');
  } finally {
    await fake.cleanup();
  }
});
