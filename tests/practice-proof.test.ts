import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { experimentalPracticeEncoder } from '../src/encoding.js';
import { createEngine } from '../src/engine.js';
import { FIELD, WITNESS_FIELDS, type NumericWitness } from '../src/prover.js';
import { SQLiteStore } from '../src/store.js';
import { sampleTask } from './fixtures.js';

function syntheticProver(counter: { calls: number }) {
  return { prove: async (witness: NumericWitness) => {
    counter.calls++;
    return { proof: { protocol: 'groth16', curve: 'bn128', fixture: true },
      public_signals: ['0', ...WITNESS_FIELDS.map(name => witness[name])] };
  } };
}

test('experimental practice field encoding is explicit and deterministic', () => {
  const encoder = experimentalPracticeEncoder();
  const vk = `0x${'ab'.repeat(32)}`;
  const expectedTask = BigInt('0x' + createHash('sha256').update('practice_vector_1', 'utf8').digest('hex')) % FIELD;
  assert.equal(encoder.encodeVk(vk), (BigInt(vk) % FIELD).toString());
  assert.equal(encoder.encodeTaskId('practice_vector_1'), expectedTask.toString());
  assert.equal(encoder.encodeTaskId('practice_vector_1'), expectedTask.toString());
  assert.throws(() => encoder.encodeVk('0x' + 'zz'.repeat(32)), /ENCODING_INVALID/);
  assert.throws(() => encoder.encodeTaskId(''), /ENCODING_INVALID/);
});

test('practice circuit-rejectable trap receives locally bound REJECT proof; reference gate remains approval-only', async t => {
  const store = new SQLiteStore(':memory:');
  t.after(() => store.close());
  const proofs = { calls: 0 }, lookups = { calls: 0 };
  const encoder = experimentalPracticeEncoder();
  const engine = createEngine({ store, practiceEncoder: encoder, prover: syntheticProver(proofs),
    referenceVerifier: { expected: { circuitId: 'TEST_ONLY', proofSystem: 'groth16', curve: 'bn128' },
      verify: async () => { lookups.calls++; throw new Error('trap REJECT does not need approval evidence'); } } });
  const task = sampleTask({ proof_tx: `0x${'aB'.repeat(16)}`, recipient: `0x${'34'.repeat(20)}` });
  const raw = Buffer.from(JSON.stringify(task));
  const response = await engine.handle(task, raw, new AbortController().signal);
  assert.equal(typeof response, 'object');
  if (typeof response === 'string') throw new Error('expected response object');
  assert.deepEqual({ decision: response.decision, reason_code: response.reason_code },
    { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' });
  assert.ok(response.proof);
  assert.equal(response.public_signals?.length, 13);
  assert.equal(response.public_signals?.[11], '0');
  assert.equal(response.proof_tx, undefined);
  assert.equal(proofs.calls, 1);
  assert.equal(lookups.calls, 0);
  assert.equal(engine.ready(), false);
});

test('candidate practice encoder is never used for competition tasks', async t => {
  const store = new SQLiteStore(':memory:');
  t.after(() => store.close());
  const proofs = { calls: 0 };
  const engine = createEngine({ store, practiceEncoder: experimentalPracticeEncoder(), prover: syntheticProver(proofs) });
  const task = { ...sampleTask({ proof_tx: `0x${'aB'.repeat(16)}`, recipient: `0x${'34'.repeat(20)}` }), mode: 'competition' as const };
  const response = await engine.handle(task, Buffer.from(JSON.stringify(task)), new AbortController().signal);
  assert.equal(typeof response, 'object');
  if (typeof response === 'string') throw new Error('expected response object');
  assert.deepEqual(response, { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' });
  assert.equal(proofs.calls, 0);
  assert.equal(engine.ready(), false);
});

test('valid-looking task stays proofless without original-reference verification and authoritative encoding', async t => {
  const store = new SQLiteStore(':memory:');
  t.after(() => store.close());
  const proofs = { calls: 0 };
  const engine = createEngine({ store, practiceEncoder: experimentalPracticeEncoder(), prover: syntheticProver(proofs) });
  const task = sampleTask({ proof_tx: `0x${'aB'.repeat(16)}` });
  const response = await engine.handle(task, Buffer.from(JSON.stringify(task)), new AbortController().signal);
  assert.deepEqual(response, { decision: 'REJECT', reason_code: 'REFERENCE_UNCONFIRMED' });
  assert.equal(proofs.calls, 0, 'do not fabricate a false circuit REJECT proof');
  assert.equal(engine.ready(), false);
});

test('disabling the practice encoder does not rewrite an already cached signed proof response', async t => {
  const store = new SQLiteStore(':memory:');
  t.after(() => store.close());
  const task = sampleTask({ proof_tx: `0x${'aB'.repeat(16)}`, recipient: `0x${'34'.repeat(20)}` });
  const raw = Buffer.from(JSON.stringify(task));
  const engine = createEngine({ store, practiceEncoder: experimentalPracticeEncoder(),
    prover: syntheticProver({ calls: 0 }) });
  const signal = new AbortController().signal;
  const first = await engine.handle(task, raw, signal);
  assert.equal(typeof first, 'object');
  if (typeof first === 'string') throw new Error('expected proof response');
  const wire = JSON.stringify(first);
  engine.onOutcome(task, raw, signal, wire);
  const replay = createEngine({ store, prover: { prove: async () => { throw new Error('cached task must not be reproved'); } } });
  assert.equal(await replay.handle(task, raw, new AbortController().signal), wire);
  assert.equal(replay.ready(), false);
});
