import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { signBody, verifySignature } from '../src/auth.js';
import { createEngine } from '../src/engine.js';
import { startService } from '../src/main.js';
import { loadConfig } from '../src/config.js';
import { WITNESS_FIELDS, type NumericWitness } from '../src/prover.js';
import { createServer } from '../src/server.js';
import { SQLiteStore } from '../src/store.js';
import type { ReferenceVerifier } from '../src/reference.js';
import { sampleTask } from './fixtures.js';

const encoder = { encodeVk: () => '1', encodeTaskId: () => '10' };
// Synthetic proof and explicitly MOCKED finality: this is a transport/ledger test, not a chain test.
const prover = { prove: async (w: NumericWitness) => ({ proof: { protocol: 'groth16', curve: 'bn128' },
  public_signals: ['0', ...WITNESS_FIELDS.map(k => w[k])] }) };
const evidence = { jobId: 'MOCKED_ONLY', status: 'Finalized' as const,
  txHash: '0x' + 'ab'.repeat(32), blockHash: '0x' + 'cd'.repeat(32) };
const referenceVerifier: ReferenceVerifier = {
  expected: { circuitId: 'SYNTHETIC_ONLY', proofSystem: 'groth16', curve: 'bn128' },
  verify: async task => {
    const { proof_tx, ...input } = task.input;
    return { ...referenceVerifier.expected, proofTx: proof_tx, status: 'Finalized', blockHash: evidence.blockHash,
      verificationKey: task.input.proof_vk, statement: { task_id: task.task_id, input } };
  },
};

function database(t: TestContext): SQLiteStore {
  const scratch = tmpdir();
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'gatekeeper-engine-http-'));
  const store = new SQLiteStore(join(dir, 'replay.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

async function send(address: string, secret: string, raw: string) {
  const response = await fetch(address + '/agent', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-agent-games-signature': signBody(secret, raw),
  }, body: raw });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(verifySignature(secret, body, response.headers.get('x-agent-games-signature') ?? undefined), true);
  return body;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('a stalled SQLite completion cannot make the wire outcome differ from its cached retry', { timeout: 3000 }, async t => {
  const store = database(t);
  let submissions = 0;
  const complete = store.complete.bind(store);
  let completions = 0;
  store.complete = (...args) => {
    if (++completions === 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    complete(...args);
  };
  const engine = createEngine({ store, prover, encoder, referenceVerifier,
    finalizer: { finalize: async () => { submissions++; return evidence; } } });
  const secret = randomBytes(32).toString('hex');
  const app = createServer({ secret, responseBudgetMs: 40, handler: engine.handle, onOutcome: engine.onOutcome });
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const task = sampleTask();
  const raw = JSON.stringify(task);
  const first = await send(address, secret, raw);
  const retry = await send(address, secret, raw);
  assert.equal(retry, first, 'retry must reproduce the signed wire bytes, not the pre-transport draft');
  assert.deepEqual(store.reserve(task.task_id, createHash('sha256').update(raw).digest('hex'), task.input.proof_tx, Date.now()),
    { kind: 'cached', body: first });
  assert.equal(submissions, 1);
  assert.equal(completions, 1);
});

test('the real service wires handler and outcome to the same request identity', { timeout: 3000 }, async t => {
  const scratch = tmpdir();
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'gatekeeper-main-http-'));
  const secret = randomBytes(32).toString('hex');
  const service = await startService({ ...loadConfig({ AGENT_GAMES_HMAC_SECRET: secret,
    DB_PATH: join(dir, 'replay.sqlite') }), port: 0 });
  t.after(async () => { await service.stop(); rmSync(dir, { recursive: true, force: true }); });
  const socket = service.server.server.address();
  assert.ok(socket && typeof socket !== 'string');
  const address = `http://127.0.0.1:${socket.port}`;
  const raw = JSON.stringify(sampleTask());
  const first = await send(address, secret, raw);
  assert.deepEqual(JSON.parse(first), { decision: 'REJECT', reason_code: 'REFERENCE_UNCONFIRMED' });
  assert.equal(await send(address, secret, raw), first);
  assert.equal((await fetch(address + '/readyz')).status, 503);
  assert.equal(service.ready(), false);
});

test('a serialization-adjusted TIMEOUT is the exact signed body cached for retry', { timeout: 3000 }, async t => {
  const store = database(t); let submissions = 0;
  const engine = createEngine({ store, encoder, referenceVerifier, prover: { prove: async w => {
    const bundle = await prover.prove(w);
    Object.assign(bundle.proof, { toJSON: () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      return { protocol: 'groth16', curve: 'bn128' };
    } });
    return bundle;
  } }, finalizer: { finalize: async () => { submissions++; return evidence; } } });
  const secret = randomBytes(32).toString('hex');
  const app = createServer({ secret, responseBudgetMs: 40, handler: engine.handle, onOutcome: engine.onOutcome });
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const raw = JSON.stringify(sampleTask());
  const first = await send(address, secret, raw);
  assert.deepEqual(JSON.parse(first), { decision: 'REJECT', reason_code: 'TIMEOUT' });
  assert.equal(await send(address, secret, raw), first);
  assert.equal(submissions, 1);
});

test('timer-selected wire bytes survive a finalizer that resolves after the response', { timeout: 3000 }, async t => {
  const store = database(t); let submissions = 0; let completions = 0;
  const complete = store.complete.bind(store);
  store.complete = (...args) => { completions++; complete(...args); };
  const entered = deferred<void>(); const late = deferred<typeof evidence>();
  t.after(() => late.resolve(evidence));
  const engine = createEngine({ store, encoder, referenceVerifier, prover,
    finalizer: { finalize: async () => { submissions++; entered.resolve(); return late.promise; } } });
  const secret = randomBytes(32).toString('hex');
  let requestSignal: AbortSignal | undefined;
  let matchingSignals = true;
  const app = createServer({ secret, responseBudgetMs: 40,
    handler: (task, raw, signal) => { requestSignal = signal; return engine.handle(task, raw, signal); },
    onOutcome: (task, raw, signal, wire) => { matchingSignals &&= signal === requestSignal; engine.onOutcome(task, raw, signal, wire); } });
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const task = sampleTask(); const raw = JSON.stringify(task);
  const response = send(address, secret, raw);
  await entered.promise;
  const first = await response;
  assert.deepEqual(JSON.parse(first), { decision: 'REJECT', reason_code: 'TIMEOUT' });
  late.resolve(evidence);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(await send(address, secret, raw), first);
  assert.equal(submissions, 1);
  assert.equal(completions, 1);
  assert.equal(matchingSignals, true);
  assert.deepEqual(store.reserve(task.task_id, createHash('sha256').update(raw).digest('hex'), task.input.proof_tx, Date.now()),
    { kind: 'cached', body: first });
});

test('concurrent retry and conflict responses cannot complete the original request lease', { timeout: 3000 }, async t => {
  const store = database(t); let submissions = 0;
  const entered = deferred<void>(); const release = deferred<typeof evidence>();
  t.after(() => release.resolve(evidence));
  const engine = createEngine({ store, encoder, referenceVerifier, prover,
    finalizer: { finalize: async () => { submissions++; entered.resolve(); return release.promise; } } });
  const secret = randomBytes(32).toString('hex');
  const app = createServer({ secret, responseBudgetMs: 1500, handler: engine.handle, onOutcome: engine.onOutcome });
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const task = sampleTask(); const raw = JSON.stringify(task);
  const response = send(address, secret, raw);
  await entered.promise;
  assert.deepEqual(JSON.parse(await send(address, secret, raw)), { decision: 'REJECT', reason_code: 'TASK_IN_PROGRESS' });
  assert.deepEqual(JSON.parse(await send(address, secret, JSON.stringify({ ...task, input: { ...task.input, amount: '1' } }))),
    { decision: 'REJECT', reason_code: 'TASK_ID_CONFLICT' });
  assert.deepEqual(JSON.parse(await send(address, secret, JSON.stringify({ ...task, task_id: 'reused' }))),
    { decision: 'REJECT', reason_code: 'PROOF_REFERENCE_REUSED' });
  const busyTask = { ...task, task_id: 'busy', input: { ...task.input, proof_tx: '0x' + '77'.repeat(32) } };
  const busyRaw = JSON.stringify(busyTask);
  const busy = await send(address, secret, busyRaw);
  assert.deepEqual(JSON.parse(busy), { decision: 'REJECT', reason_code: 'BUSY' });
  assert.deepEqual(store.reserve(task.task_id, createHash('sha256').update(raw).digest('hex'), task.input.proof_tx, Date.now()),
    { kind: 'processing' });
  release.resolve(evidence);
  const first = await response;
  assert.equal(JSON.parse(first).decision, 'APPROVE');
  assert.equal(await send(address, secret, raw), first);
  assert.equal(await send(address, secret, busyRaw), busy);
  assert.equal(submissions, 1);
});

test('a failed post-wire recording leaves the task consumed rather than approving a retry', { timeout: 3000 }, async t => {
  const store = database(t); let submissions = 0; let completions = 0;
  const secret = randomBytes(32).toString('hex');
  store.complete = () => { completions++; throw new Error(secret); };
  const engine = createEngine({ store, encoder, referenceVerifier, prover,
    finalizer: { finalize: async () => { submissions++; return evidence; } } });
  const app = createServer({ secret, handler: engine.handle, onOutcome: engine.onOutcome });
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const task = sampleTask(); const raw = JSON.stringify(task);
  const first = await send(address, secret, raw);
  assert.equal(JSON.parse(first).decision, 'APPROVE', 'an already-sent body cannot be rewritten by a recording error');
  assert.equal(first.includes(secret), false);
  assert.deepEqual(JSON.parse(await send(address, secret, raw)), { decision: 'REJECT', reason_code: 'TASK_IN_PROGRESS' });
  assert.deepEqual(JSON.parse(await send(address, secret, JSON.stringify({ ...task, task_id: 'other' }))),
    { decision: 'REJECT', reason_code: 'PROOF_REFERENCE_REUSED' });
  assert.equal(completions, 1);
  assert.equal(submissions, 1);
});
