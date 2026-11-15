import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { signBody, verifySignature } from '../src/auth.js';
import { createEngine } from '../src/engine.js';
import { createServer } from '../src/server.js';
import { SQLiteStore } from '../src/store.js';
import { sampleTask } from './fixtures.js';
import { parseEnvelope } from '../src/protocol.js';
import { validateReferenceEvidence } from '../src/reference.js';
import { isCanonicalProofReference } from '../src/proof-reference.js';

// Synthetic stand-in for the observed 34-character wire shape, not captured task contents.
const shortReference = `0x${'aB'.repeat(16)}`;

test('canonical proof references require exactly 32 bytes and reject trailing line terminators', () => {
  const hash = `0x${'ab'.repeat(32)}`;
  assert.equal(isCanonicalProofReference(hash), true);
  for (const value of [hash + '\n', hash + '\r', hash + '\u2028', hash + '\u2029',
    hash.replace('0x', '0X'), hash.slice(0, -1), hash + '0']) {
    assert.equal(isCanonicalProofReference(value), false, JSON.stringify(value));
  }
});

test('a signed practice task with a short proof reference gets a safe signed HTTP 200 without lookup, proof, or submission', async t => {
  const secret = randomBytes(32).toString('hex');
  const store = new SQLiteStore(':memory:');
  let reservations = 0;
  const reserve = store.reserve.bind(store);
  store.reserve = (...args) => { reservations++; return reserve(...args); };
  let externalCalls = 0;
  const unexpected = async (): Promise<never> => { externalCalls++; throw new Error('unsupported reference must not be used'); };
  const engine = createEngine({ store,
    encoder: { encodeVk: () => { externalCalls++; return '1'; }, encodeTaskId: () => { externalCalls++; return '1'; } },
    referenceVerifier: { expected: { circuitId: 'SYNTHETIC_ONLY', proofSystem: 'groth16', curve: 'bn128' }, verify: unexpected },
    prover: { prove: unexpected }, finalizer: { finalize: unexpected } });
  const app = createServer({ secret, handler: engine.handle, onOutcome: engine.onOutcome });
  t.after(async () => { await app.close(); store.close(); });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const task = sampleTask({ proof_tx: shortReference });
  const raw = JSON.stringify(task);
  const response = await fetch(address + '/agent', { method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-agent-games-signature': signBody(secret, raw) } });
  const wire = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(wire), { decision: 'REJECT', reason_code: 'REFERENCE_UNCONFIRMED' });
  assert.equal(verifySignature(secret, wire, response.headers.get('x-agent-games-signature') ?? undefined), true);
  assert.equal(externalCalls, 0);
  assert.equal(reservations, 0, 'opaque references must not be normalized or stored as transaction hashes');
  assert.equal(task.input.proof_tx, shortReference);
});

test('wire parsing preserves opaque reference bytes without claiming transaction validity', () => {
  const base = sampleTask();
  for (const value of [shortReference, 'x'.repeat(34), 'Practice_opaque', ' proof ref ',
    'x'.repeat(256), `0X${'aB'.repeat(32)}`, `0x${'gg'.repeat(32)}`, 'opaque\u0000reference']) {
    const task = { ...base, input: { ...base.input, proof_tx: value } };
    const parsed = parseEnvelope(task);
    assert.deepEqual(parsed, task);
  }
  for (const value of ['', 'x'.repeat(257), 1, null, undefined, {}, []]) {
    assert.throws(() => parseEnvelope({ ...base, input: { ...base.input, proof_tx: value } }));
  }
});

test('opaque references cannot trigger a cached APPROVE or reach external work in either mode', async t => {
  const store = new SQLiteStore(':memory:');
  t.after(() => store.close());
  let reservations = 0;
  store.reserve = () => { reservations++; return { kind: 'cached', body: '{"decision":"APPROVE","reason_code":"LEGACY"}' }; };
  let externalCalls = 0;
  const unexpected = async (): Promise<never> => { externalCalls++; throw new Error('must not call'); };
  const engine = createEngine({ store,
    encoder: { encodeVk: () => { externalCalls++; return '1'; }, encodeTaskId: () => { externalCalls++; return '1'; } },
    referenceVerifier: { expected: { circuitId: 'SYNTHETIC_ONLY', proofSystem: 'groth16', curve: 'bn128' }, verify: unexpected },
    prover: { prove: unexpected }, finalizer: { finalize: unexpected } });
  for (const mode of ['practice', 'competition'] as const) {
    for (const value of [shortReference, 'x'.repeat(34), ' 0x' + 'ab'.repeat(32),
      `0x${'gg'.repeat(32)}`, `0X${'ab'.repeat(32)}`, 'ab'.repeat(32), shortReference.toLowerCase(),
      `0x${'ab'.repeat(32)}\n`]) {
      const task = { ...sampleTask({ proof_tx: value }), mode };
      const raw = Buffer.from(JSON.stringify(task));
      const signal = new AbortController().signal;
      const response = await engine.handle(task, raw, signal);
      assert.deepEqual(response, { decision: 'REJECT', reason_code: 'REFERENCE_UNCONFIRMED' });
      engine.onOutcome(task, raw, signal, JSON.stringify(response));
      assert.equal(task.input.proof_tx, value);
    }
  }
  assert.equal(externalCalls, 0);
  assert.equal(reservations, 0, 'guard must precede cache or reference canonicalization');
});

test('a claimed finalized evidence object cannot certify an opaque or padded reference', () => {
  const expected = { circuitId: 'SYNTHETIC_ONLY', proofSystem: 'groth16', curve: 'bn128' };
  const task = sampleTask({ proof_tx: shortReference });
  const { proof_tx: _proofTx, ...input } = task.input;
  for (const proofTx of [shortReference, '0x' + shortReference.slice(2).padStart(64, '0'),
    `0x${'ab'.repeat(32)}\n`]) {
    const evidence = { ...expected, status: 'Finalized', blockHash: `0x${'cd'.repeat(32)}`,
      proofTx, verificationKey: task.input.proof_vk, statement: { task_id: task.task_id, input } };
    assert.equal(validateReferenceEvidence(evidence, task, expected), false);
  }
});

test('reference evidence accepts exact hashes and rejects line-terminated hashes', () => {
  const expected = { circuitId: 'SYNTHETIC_ONLY', proofSystem: 'groth16', curve: 'bn128' };
  const task = sampleTask();
  const { proof_tx, ...input } = task.input;
  const valid = { ...expected, proofTx: proof_tx, status: 'Finalized', blockHash: `0x${'cd'.repeat(32)}`,
    verificationKey: task.input.proof_vk, statement: { task_id: task.task_id, input } };
  assert.equal(validateReferenceEvidence(valid, task, expected), true);
  for (const patch of [
    { proofTx: valid.proofTx + '\n' },
    { verificationKey: valid.verificationKey + '\n' },
    { blockHash: valid.blockHash + '\n' },
  ]) assert.equal(validateReferenceEvidence({ ...valid, ...patch }, task, expected), false);
});

test('an unsupported reference never bypasses request authentication', async t => {
  const secret = randomBytes(32).toString('hex');
  let calls = 0;
  const app = createServer({ secret, handler: async () => { calls++; return { decision: 'REJECT', reason_code: 'UNEXPECTED' }; } });
  t.after(() => app.close());
  const raw = JSON.stringify(sampleTask({ proof_tx: shortReference }));
  const response = await app.inject({ method: 'POST', url: '/agent', payload: raw,
    headers: { 'content-type': 'application/json', 'x-agent-games-signature': '0'.repeat(64) } });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'BAD_SIGNATURE' });
  assert.equal(verifySignature(secret, response.payload, String(response.headers['x-agent-games-signature'])), true);
  assert.equal(calls, 0);
});
