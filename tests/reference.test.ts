import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngine } from '../src/engine.js';
import { validateReferenceEvidence, type ReferenceExpectation, type ReferenceVerifier } from '../src/reference.js';
import { SQLiteStore } from '../src/store.js';
import { sampleTask } from './fixtures.js';

// This normalized local shape is not an invented remote API or chain attestation.
test('missing expected circuit identity cannot validate evidence or activate the reference gate', async t => {
  for (const invalid of [undefined, null, {}, { circuitId: '', proofSystem: '', curve: '' },
    { circuitId: '   ', proofSystem: 'groth16', curve: 'bn128' },
    { circuitId: 'SYNTHETIC_ONLY', proofSystem: 1, curve: 'bn128' },
    { circuitId: 'x'.repeat(257), proofSystem: 'groth16', curve: 'bn128' }]) await t.test(JSON.stringify(invalid) ?? 'undefined', () => {
    const task = sampleTask();
    const { proof_tx, ...input } = task.input;
    const evidence = { ...invalid, proofTx: proof_tx, status: 'Finalized', blockHash: '0x' + 'ab'.repeat(32),
      verificationKey: task.input.proof_vk, statement: { task_id: task.task_id, input } };
    assert.equal(validateReferenceEvidence(evidence, task, invalid as ReferenceExpectation), false);
    const store = new SQLiteStore(':memory:');
    try {
      const engine = createEngine({ store, encoder: { encodeVk: () => '1', encodeTaskId: () => '1' },
        referenceVerifier: { expected: invalid, verify: async () => evidence } as ReferenceVerifier,
        prover: { prove: async () => { throw new Error('must not prove'); } },
        finalizer: { finalize: async () => { throw new Error('must not submit'); } } });
      assert.equal(engine.ready(), false);
    } finally { store.close(); }
  });
});
