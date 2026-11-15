import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('test fixtures do not require a developer-specific home directory', async () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const offenders: string[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.test.ts')) continue;
    if (/\/(home|Users)\/[a-zA-Z0-9_-]+\//.test(await readFile(join(dir, name), 'utf8'))) offenders.push(name);
  }
  assert.deepEqual(offenders, [], 'temporary fixtures must use the runtime temp directory');
});
