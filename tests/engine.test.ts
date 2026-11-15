import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { sampleTask } from './fixtures.js';
import { SQLiteStore } from '../src/store.js';
import { WITNESS_FIELDS, type NumericWitness } from '../src/prover.js';
import type { ReferenceEvidence, ReferenceVerifier } from '../src/reference.js';
import type { Task } from '../src/protocol.js';

const syntheticEncoder = { encodeVk: () => '1', encodeTaskId: () => '10' };
const syntheticProver = { prove: async (w: NumericWitness) => ({ proof: { protocol: 'groth16', curve: 'bn128' }, public_signals: ['0', ...WITNESS_FIELDS.map((k) => w[k])] }) };
const finalized = { jobId: 'local-only', status: 'Finalized' as const, txHash: '0x' + 'ab'.repeat(32), blockHash: '0x' + 'cd'.repeat(32) };
const expectedReference = { circuitId: 'SYNTHETIC_ONLY', proofSystem: 'groth16', curve: 'bn128' };
function referenceEvidence(task: Task): ReferenceEvidence {
  const { proof_tx, ...input } = task.input;
  return { ...expectedReference, proofTx: proof_tx, status: 'Finalized', blockHash: finalized.blockHash,
    verificationKey: task.input.proof_vk, statement: { task_id: task.task_id, input } };
}
const referenceVerifier: ReferenceVerifier = { expected: expectedReference, verify: async task => referenceEvidence(task) };

test('missing historical reference verification blocks approval even with an encoder and MOCKED new-proof finality', async () => {
  const { createEngine } = await import('../src/engine.js');
  const store = new SQLiteStore(':memory:');
  let proofs = 0; let submissions = 0;
  try {
    const engine = createEngine({ store, encoder: syntheticEncoder,
      prover: { prove: async w => { proofs++; return syntheticProver.prove(w); } },
      finalizer: { finalize: async () => { submissions++; return finalized; } } });
    const task = sampleTask();
    const response = await engine.handle(task, Buffer.from(JSON.stringify(task)), new AbortController().signal);
    assert.deepEqual(response, { decision: 'REJECT', reason_code: 'REFERENCE_UNCONFIRMED' });
    assert.equal(engine.ready(), false);
    assert.equal(proofs, 0);
    assert.equal(submissions, 0);
  } finally { store.close(); }
});

test('historical evidence must bind the original reference, statement, circuit, proof system, key and exact finality', async t => {
  const { createEngine } = await import('../src/engine.js');
  const bad: [string, (e: ReferenceEvidence) => unknown][] = [
    ['boolean assertion only', () => ({ ok: true })],
    ['null', () => null],
    ['array', () => []],
    ['wrong reference', e => ({ ...e, proofTx: '0x' + 'dd'.repeat(32) })],
    ['malformed reference', e => ({ ...e, proofTx: '0x22' })],
    ['inclusion is not finality', e => ({ ...e, status: 'IncludedInBlock' })],
    ['wrong-case finality', e => ({ ...e, status: 'FINALIZED' })],
    ['missing finalized block', e => ({ ...e, blockHash: undefined })],
    ['malformed finalized block', e => ({ ...e, blockHash: 1 })],
    ['wrong circuit', e => ({ ...e, circuitId: 'OTHER_CIRCUIT' })],
    ['wrong proof system', e => ({ ...e, proofSystem: 'plonk' })],
    ['wrong curve', e => ({ ...e, curve: 'bls12-381' })],
    ['wrong key', e => ({ ...e, verificationKey: '0x' + 'dd'.repeat(32) })],
    ['missing statement', e => ({ ...e, statement: undefined })],
    ['wrong task', e => ({ ...e, statement: { ...e.statement, task_id: 'other-task' } })],
  ];
  for (const key of Object.keys(referenceEvidence(sampleTask()).statement.input)) {
    bad.push([`wrong statement ${key}`, e => ({ ...e, statement: { ...e.statement,
      input: { ...e.statement.input, [key]: typeof e.statement.input[key as keyof typeof e.statement.input] === 'number' ? 7 : 'other' } } })]);
  }
  for (const [name, mutate] of bad) await t.test(name, async () => {
    const store = new SQLiteStore(':memory:');
    let proofs = 0; let submissions = 0;
    try {
      const task = sampleTask();
      const engine = createEngine({ store, encoder: syntheticEncoder,
        referenceVerifier: { expected: expectedReference, verify: async () => mutate(referenceEvidence(task)) },
        prover: { prove: async w => { proofs++; return syntheticProver.prove(w); } },
        finalizer: { finalize: async () => { submissions++; return finalized; } } });
      const raw = Buffer.from(JSON.stringify(task));
      const signal = new AbortController().signal;
      const response = await engine.handle(task, raw, signal);
      assert.deepEqual(response, { decision: 'REJECT', reason_code: 'REFERENCE_UNCONFIRMED' });
      assert.equal(proofs, 0);
      assert.equal(submissions, 0);
      engine.onOutcome(task, raw, signal, JSON.stringify(response));
      assert.equal(await engine.handle(task, raw, new AbortController().signal), JSON.stringify(response));
    } finally { store.close(); }
  });
});

test('cached approvals cannot bypass a missing or failing historical reference gate after restart', async t => {
  const { createEngine } = await import('../src/engine.js');
  for (const verifier of [undefined, { expected: expectedReference, verify: async () => ({ ok: true }) }]) await t.test(verifier ? 'invalid evidence' : 'absent verifier', async () => {
    const store = new SQLiteStore(':memory:');
    try {
      const task = sampleTask(); const raw = Buffer.from(JSON.stringify(task)); const signal = new AbortController().signal;
      const first = createEngine({ store, encoder: syntheticEncoder, referenceVerifier, prover: syntheticProver,
        finalizer: { finalize: async () => finalized } });
      const approved = await first.handle(task, raw, signal);
      assert.equal(typeof approved === 'string' ? JSON.parse(approved).decision : approved.decision, 'APPROVE');
      first.onOutcome(task, raw, signal, JSON.stringify(approved));
      const resumed = createEngine({ store, encoder: syntheticEncoder, ...(verifier ? { referenceVerifier: verifier } : {}),
        prover: { prove: async () => { throw new Error('cached task must not be proved again'); } },
        finalizer: { finalize: async () => { throw new Error('cached task must not be submitted again'); } } });
      assert.deepEqual(await resumed.handle(task, raw, new AbortController().signal),
        { decision: 'REJECT', reason_code: 'REFERENCE_UNCONFIRMED' });
    } finally { store.close(); }
  });
});

test('shutdown cancels work without changing the request identity used to record its wire outcome', { timeout: 1000 }, async () => {
  const { createEngine } = await import('../src/engine.js');
  const store = new SQLiteStore(':memory:');
  const stop = new AbortController(); const request = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const engine = createEngine({ store, encoder: syntheticEncoder, referenceVerifier, shutdownSignal: stop.signal,
      prover: { prove: async () => { markStarted(); return new Promise(() => {}); } },
      finalizer: { finalize: async () => { throw new Error('must not submit after shutdown'); } } });
    const task = sampleTask(); const raw = Buffer.from(JSON.stringify(task));
    const response = engine.handle(task, raw, request.signal);
    await started;
    assert.equal(engine.ready(), true);
    stop.abort();
    assert.equal(engine.ready(), false);
    const result = await Promise.race([response, new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('shutdown escaped its budget')), 200);
    })]);
    assert.deepEqual(result, { decision: 'REJECT', reason_code: 'TIMEOUT' });
    engine.onOutcome(task, raw, request.signal, JSON.stringify(result));
    const { createHash } = await import('node:crypto');
    assert.deepEqual(store.reserve(task.task_id, createHash('sha256').update(raw).digest('hex'), task.input.proof_tx, Date.now()),
      { kind: 'cached', body: JSON.stringify(result) });
    const later = sampleTask({ proof_tx: '0x' + '99'.repeat(32) }, 'later');
    assert.deepEqual(await engine.handle(later, Buffer.from(JSON.stringify(later)), new AbortController().signal),
      { decision: 'REJECT', reason_code: 'TIMEOUT' });
  } finally { if (watchdog) clearTimeout(watchdog); request.abort(); store.close(); }
});

test('MOCKED new-proof finality must contain exact Finalized status and well-typed job, transaction and block evidence', async t => {
  const { createEngine } = await import('../src/engine.js');
  const invalid: [string, unknown][] = [
    ['empty job ID', { ...finalized, jobId: '' }],
    ['numeric job ID', { ...finalized, jobId: 1 }],
    ['malformed job ID', { ...finalized, jobId: '../not-a-job' }],
    ['null', null],
    ['missing transaction', { ...finalized, txHash: undefined }],
    ['coerced transaction', { ...finalized, txHash: { toString: () => finalized.txHash } }],
    ['missing block', { ...finalized, blockHash: undefined }],
    ['coerced block', { ...finalized, blockHash: { toString: () => finalized.blockHash } }],
    ...['Valid', 'Submitted', 'IncludedInBlock', 'FINALIZED', 'Failed'].map(status => [status, { ...finalized, status }] as [string, unknown]),
  ];
  for (const [name, evidence] of invalid) await t.test(name, async () => {
    const store = new SQLiteStore(':memory:'); let submissions = 0;
    try {
      const engine = createEngine({ store, encoder: syntheticEncoder, referenceVerifier, prover: syntheticProver,
        finalizer: { finalize: async () => { submissions++; return evidence as typeof finalized; } } });
      const task = sampleTask(); const raw = Buffer.from(JSON.stringify(task)); const signal = new AbortController().signal;
      const response = await engine.handle(task, raw, signal);
      assert.deepEqual(response, { decision: 'REJECT', reason_code: 'FINALITY_UNCONFIRMED' });
      engine.onOutcome(task, raw, signal, JSON.stringify(response));
      assert.equal(await engine.handle(task, raw, new AbortController().signal), JSON.stringify(response));
      assert.equal(submissions, 1);
    } finally { store.close(); }
  });
});

test('a dependency ignoring cancellation cannot exhaust a task slot indefinitely', { timeout: 1000 }, async () => {
  const { createEngine } = await import('../src/engine.js');
  const store = new SQLiteStore(':memory:');
  try {
    let proofs = 0;
    const engine = createEngine({ store, encoder: syntheticEncoder, referenceVerifier, proofTimeoutMs: 10,
      prover: { prove: async () => { proofs++; return new Promise(() => {}); } } });
    const task = sampleTask();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([engine.handle(task, Buffer.from(JSON.stringify(task)), AbortSignal.timeout(100)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dependency escaped its budget')), 200); })]);
      assert.equal(typeof response === 'string' ? JSON.parse(response).decision : response.decision, 'REJECT');
      assert.equal(proofs, 1, 'the test must actually enter the non-cooperative dependency');
      const next = sampleTask({ proof_tx: '0x' + '66'.repeat(32) }, 'next');
      const second = await engine.handle(next, Buffer.from(JSON.stringify(next)), AbortSignal.timeout(100));
      assert.notEqual(typeof second === 'string' ? JSON.parse(second).reason_code : second.reason_code, 'BUSY');
      assert.equal(proofs, 2);
    } finally { if (timer) clearTimeout(timer); }
  } finally { store.close(); }
});

test('public-signal binding mismatches reject without submitting an APPROVE proof', async t => {
  const { createEngine } = await import('../src/engine.js');
  for (const field of ['recipient', 'amount', 'decision', 'taskId'] as const) await t.test(field, async () => {
    const store = new SQLiteStore(':memory:'); let submissions = 0;
    try {
      const engine = createEngine({ store, encoder: syntheticEncoder, referenceVerifier,
        prover: { prove: async w => {
          const bundle = await syntheticProver.prove(w);
          bundle.public_signals[WITNESS_FIELDS.indexOf(field) + 1] = '999';
          return bundle;
        } }, finalizer: { finalize: async () => { submissions++; return finalized; } } });
      const task = sampleTask(); const raw = Buffer.from(JSON.stringify(task)); const signal = new AbortController().signal;
      const result = await engine.handle(task, raw, signal);
      assert.deepEqual(result, { decision: 'REJECT', reason_code: 'VERIFICATION_UNCONFIRMED' });
      engine.onOutcome(task, raw, signal, JSON.stringify(result));
      assert.equal(await engine.handle(task, raw, new AbortController().signal), JSON.stringify(result));
      assert.equal(submissions, 0);
    } finally { store.close(); }
  });
});

test('a finalizer exception is a proof-less safe rejection and is never resubmitted on retry', async () => {
  const { createEngine } = await import('../src/engine.js');
  const store = new SQLiteStore(':memory:'); let submissions = 0;
  const secret = randomBytes(32).toString('hex');
  try {
    const engine = createEngine({ store, encoder: syntheticEncoder, referenceVerifier, prover: syntheticProver,
      finalizer: { finalize: async () => { submissions++; throw new Error(`MOCKED/provider/${secret}`); } } });
    const task = sampleTask(); const raw = Buffer.from(JSON.stringify(task)); const signal = new AbortController().signal;
    const result = await engine.handle(task, raw, signal);
    assert.deepEqual(result, { decision: 'REJECT', reason_code: 'VERIFICATION_UNCONFIRMED' });
    engine.onOutcome(task, raw, signal, JSON.stringify(result));
    assert.equal(await engine.handle(task, raw, new AbortController().signal), JSON.stringify(result));
    assert.equal(submissions, 1);
  } finally { store.close(); }
});

test('a failed reservation rejects before any historical lookup, proof or submission', async () => {
  const { createEngine } = await import('../src/engine.js');
  const store = new SQLiteStore(':memory:'); const secret = randomBytes(32).toString('hex');
  let calls = 0;
  store.reserve = () => { throw new Error(secret); };
  try {
    const engine = createEngine({ store, encoder: syntheticEncoder,
      referenceVerifier: { expected: expectedReference, verify: async () => { calls++; throw new Error('must not look up'); } },
      prover: { prove: async () => { calls++; throw new Error('must not prove'); } },
      finalizer: { finalize: async () => { calls++; throw new Error('must not submit'); } } });
    const task = sampleTask();
    assert.deepEqual(await engine.handle(task, Buffer.from(JSON.stringify(task)), new AbortController().signal),
      { decision: 'REJECT', reason_code: 'STORE_UNAVAILABLE' });
    assert.equal(calls, 0);
  } finally { store.close(); }
});

test('a historical verifier exception cannot fall through to new-proof finality', async () => {
  const { createEngine } = await import('../src/engine.js');
  const store = new SQLiteStore(':memory:'); let calls = 0;
  const secret = randomBytes(32).toString('hex');
  try {
    const engine = createEngine({ store, encoder: syntheticEncoder,
      referenceVerifier: { expected: expectedReference, verify: async () => { throw new Error(secret); } },
      prover: { prove: async () => { calls++; throw new Error('must not prove'); } },
      finalizer: { finalize: async () => { calls++; throw new Error('must not submit'); } } });
    const task = sampleTask();
    assert.deepEqual(await engine.handle(task, Buffer.from(JSON.stringify(task)), new AbortController().signal),
      { decision: 'REJECT', reason_code: 'REFERENCE_UNCONFIRMED' });
    assert.equal(calls, 0);
  } finally { store.close(); }
});

test('missing official field encodings prevent approval and never fabricate a proof', async () => {
  const module = await import('../src/engine.js').catch(() => null);
  assert.ok(module, 'fail-closed task orchestration is not implemented');
  const store = new SQLiteStore(':memory:');
  try {
    const engine = module.createEngine({ store, prover: { prove: async () => { throw new Error('must not be invoked'); } } });
    const task = sampleTask();
    const response = await engine.handle(task, Buffer.from(JSON.stringify(task)), AbortSignal.timeout(1000));
    assert.notEqual(typeof response, 'string');
    if (typeof response === 'string') throw new Error('expected response draft');
    assert.equal(response.decision, 'REJECT');
    assert.equal(response.reason_code, 'REFERENCE_UNCONFIRMED');
    assert.equal(response.proof, undefined);
    assert.equal(engine.ready(), false);
  } finally { store.close(); }
});
