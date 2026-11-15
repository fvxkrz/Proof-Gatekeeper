import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { experimentalPracticeEncoder } from '../src/encoding.js';
import { createEngine } from '../src/engine.js';
import { signBody, verifySignature } from '../src/auth.js';
import { ProcessProver } from '../src/prover.js';
import { createServer } from '../src/server.js';
import { SQLiteStore } from '../src/store.js';
import { startService } from '../src/main.js';
import { loadConfig } from '../src/config.js';
import { loadArtifacts } from '../src/artifacts.js';
import { sampleTask } from './fixtures.js';

// Local loopback proof fixture. It is not a platform-accepted encoding vector.
test('signed practice HTTP trap response contains a locally verified real Groth16 proof and byte-identical cached retry', { timeout: 15_000 }, async t => {
  const secret = randomBytes(32).toString('hex');
  const store = new SQLiteStore(':memory:');
  const artifacts = await loadArtifacts(new URL('../circuits', import.meta.url).pathname);
  const prover = new ProcessProver(artifacts);
  const originalProve = prover.prove.bind(prover);
  let generated = 0;
  prover.prove = async (witness, signal) => { generated++; return originalProve(witness, signal); };
  const engine = createEngine({ store, practiceEncoder: experimentalPracticeEncoder(), prover });
  const app = createServer({ secret, handler: engine.handle, onOutcome: engine.onOutcome,
    ready: engine.ready, responseBudgetMs: 55_000 });
  t.after(async () => { await app.close(); store.close(); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const task = sampleTask({ proof_tx: `0x${'aB'.repeat(16)}`, recipient: `0x${'34'.repeat(20)}` });
  const raw = JSON.stringify(task);
  const start = performance.now();
  const firstResponse = await fetch(address + '/agent', { method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-agent-games-signature': signBody(secret, raw) },
    signal: AbortSignal.timeout(12_000) });
  const firstWire = await firstResponse.text();
  const elapsedMs = performance.now() - start;
  assert.equal(firstResponse.status, 200);
  assert.equal(verifySignature(secret, firstWire, firstResponse.headers.get('x-agent-games-signature') ?? undefined), true);
  const result = JSON.parse(firstWire);
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason_code, 'RECIPIENT_MISMATCH');
  assert.ok(result.proof);
  assert.equal(result.proof.protocol, 'groth16');
  assert.equal(result.proof.curve, 'bn128');
  assert.equal(result.public_signals.length, 13);
  assert.equal(result.public_signals[11], '0');
  assert.equal(result.proof_tx, undefined);
  assert.ok(elapsedMs < 12_000, `proof response took ${elapsedMs} ms`);
  assert.equal(await prover.verify({ proof: result.proof, public_signals: result.public_signals }, AbortSignal.timeout(8_000)), true);
  const retry = await fetch(address + '/agent', { method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-agent-games-signature': signBody(secret, raw) },
    signal: AbortSignal.timeout(3_000) });
  const retryWire = await retry.text();
  assert.equal(retry.status, 200);
  assert.equal(retryWire, firstWire);
  assert.equal(verifySignature(secret, retryWire, retry.headers.get('x-agent-games-signature') ?? undefined), true);
  assert.equal(generated, 1, 'identical retry reuses the exact signed cached proof response');
  assert.equal(engine.ready(), false, 'experimental practice encoder cannot activate readiness');
  assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 503);
  assert.equal(firstWire.includes(secret), false);
});

test('opt-in PRACTICE_ENCODER reaches the actual service entrypoint without enabling readiness', { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'gatekeeper-practice-http-'));
  const secret = randomBytes(32).toString('hex');
  const service = await startService({ ...loadConfig({
    AGENT_GAMES_HMAC_SECRET: secret,
    PRACTICE_ENCODER: 'sha256-vk-modp-taskid-sha256-modp-v1',
    HOST: '127.0.0.1',
    DB_PATH: join(directory, 'practice.sqlite'),
    ARTIFACTS_DIR: fileURLToPath(new URL('../circuits', import.meta.url)),
    ZKVERIFY_NETWORK: 'testnet',
  }), port: 0 });
  t.after(async () => { await service.stop(); rmSync(directory, { recursive: true, force: true }); });
  const address = service.server.server.address();
  assert.ok(address && typeof address !== 'string');
  const task = sampleTask({ proof_tx: `0x${'aB'.repeat(16)}`, recipient: `0x${'34'.repeat(20)}` });
  const raw = JSON.stringify(task);
  const response = await fetch(`http://127.0.0.1:${address.port}/agent`, { method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-agent-games-signature': signBody(secret, raw) },
    signal: AbortSignal.timeout(12_000) });
  const wire = await response.text();
  assert.equal(response.status, 200);
  assert.equal(verifySignature(secret, wire, response.headers.get('x-agent-games-signature') ?? undefined), true);
  const result = JSON.parse(wire);
  assert.equal(result.decision, 'REJECT');
  assert.equal(result.reason_code, 'RECIPIENT_MISMATCH');
  assert.equal(result.proof.protocol, 'groth16');
  assert.equal(result.public_signals[11], '0');
  assert.equal(service.ready(), false);
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/readyz`)).status, 503);
});
