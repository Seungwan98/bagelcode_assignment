import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendJsonl, readJsonl } from '../src/lib/utils/jsonl';

test('appendJsonl and readJsonl preserve record order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentboard-jsonl-'));
  const file = join(dir, 'events.jsonl');
  try {
    await appendJsonl(file, { id: 'evt_1', type: 'run.created' });
    await appendJsonl(file, { id: 'evt_2', type: 'run.started' });
    const records = await readJsonl<{ id: string; type: string }>(file);
    assert.deepEqual(records, [
      { id: 'evt_1', type: 'run.created' },
      { id: 'evt_2', type: 'run.started' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
