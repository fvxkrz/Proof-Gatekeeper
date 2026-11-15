import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('undocumented bindings stay disabled; only an explicitly hash-pinned local encoder can load', async () => {
  const module = await import('../src/encoding.js').catch(() => null);
  assert.ok(module, 'fail-closed encoding gate is not implemented');
  assert.equal(await module.loadPinnedEncoder({}), undefined);
  const dir = await mkdtemp(join(tmpdir(), 'gk-encoding-test-'));
  try {
    // A synthetic test encoder, NOT an official platform mapping.
    const code = 'export const encoder = {encodeVk: () => "1", encodeTaskId: () => "10"};';
    const path = join(dir, 'synthetic.mjs'); await writeFile(path, code);
    await assert.rejects(module.loadPinnedEncoder({ modulePath: path, sha256: randomBytes(32).toString('hex') }), /ENCODING_INTEGRITY/);
    const encoder = await module.loadPinnedEncoder({ modulePath: path, sha256: createHash('sha256').update(code).digest('hex') });
    assert.equal(encoder?.encodeTaskId('synthetic'), '10');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
