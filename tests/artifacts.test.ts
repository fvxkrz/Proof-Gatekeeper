import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../circuits', import.meta.url));
test('artifact loader authenticates the official bytes and rejects a tampered wasm', async () => {
  const module = await import('../src/artifacts.js').catch(() => null);
  assert.ok(module, 'official artifact integrity loader is not implemented');
  const artifacts = await module.loadArtifacts(root);
  assert.equal(artifacts.verificationKey.protocol, 'groth16');
  assert.equal(artifacts.verificationKey.nPublic, 13);
  const temp = await mkdtemp(join(tmpdir(), 'gk-artifact-test-'));
  try {
    await cp(root, temp, { recursive: true });
    const bytes = await readFile(join(temp, 'gatekeeper.wasm'));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(join(temp, 'gatekeeper.wasm'), bytes);
    await assert.rejects(module.loadArtifacts(temp), /ARTIFACT_INTEGRITY/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
