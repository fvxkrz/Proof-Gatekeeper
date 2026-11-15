import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadArtifacts } from '../src/artifacts.js';


export const numericWitness = {
  minimum: '1000', publicBalance: '1460', expiryBlock: '100', currentBlock: '99',
  recipient: '123', conditionRecipient: '123', amount: '500', maxTransfer: '1000',
  registeredVkHash: '1', proofVkHash: '1', decision: '1', taskId: '10', salt: '20',
};

test('real official Groth16 circuit generates and independently verifies a numeric witness', async () => {
  const module = await import('../src/prover.js').catch(() => null);
  assert.ok(module, 'local killable snarkjs prover is not implemented');
  const artifacts = await loadArtifacts(fileURLToPath(new URL('../circuits', import.meta.url)));
  const prover = new module.ProcessProver(artifacts);
  const bundle = await prover.prove(numericWitness, AbortSignal.timeout(20_000));
  assert.equal(bundle.proof.protocol, 'groth16');
  assert.equal(bundle.proof.curve, 'bn128');
  assert.deepEqual(bundle.public_signals.slice(1), ['1','1','1000','1460','100','99','123','123','500','1000','1','10']);
  assert.equal(await prover.verify(bundle, AbortSignal.timeout(10_000)), true);
  const tampered = { ...bundle, public_signals: [...bundle.public_signals] };
  tampered.public_signals[9] = '501';
  assert.equal(await prover.verify(tampered, AbortSignal.timeout(10_000)), false);
});

test('the circuit proves a threshold rejection but refuses a false rejection of a valid request', async () => {
  const { ProcessProver } = await import('../src/prover.js');
  const artifacts = await loadArtifacts(fileURLToPath(new URL('../circuits', import.meta.url)));
  const prover = new ProcessProver(artifacts);
  const rejected = await prover.prove({ ...numericWitness, publicBalance: '999', decision: '0' }, AbortSignal.timeout(20_000));
  assert.equal(rejected.public_signals[11], '0');
  assert.equal(await prover.verify(rejected, AbortSignal.timeout(10_000)), true);
  await assert.rejects(prover.prove({ ...numericWitness, decision: '0' }, AbortSignal.timeout(20_000)), /PROOF_GENERATION_FAILED/);
});

test('the proof subprocess is cancellable and cannot outlive its time budget', async () => {
  const { ProcessProver } = await import('../src/prover.js');
  const artifacts = await loadArtifacts(fileURLToPath(new URL('../circuits', import.meta.url)));
  const prover = new ProcessProver(artifacts);
  await assert.rejects(prover.prove(numericWitness, AbortSignal.timeout(1)), /PROOF_TIMEOUT|TimeoutError/);
});
