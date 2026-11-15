import { groth16 } from 'snarkjs';
import type { Artifacts } from './artifacts.js';
import { assertPublicBinding, type NumericWitness, type ProofBundle } from './prover.js';

process.once('message', async (request: { mode: 'prove' | 'verify'; witness?: NumericWitness;
  bundle?: ProofBundle; artifacts: Artifacts }) => {
  try {
    let result: ProofBundle | boolean;
    if (request.mode === 'prove' && request.witness) {
      const generated = await groth16.fullProve(request.witness, request.artifacts.wasm,
        request.artifacts.zkey, undefined, undefined, { singleThread: true });
      const bundle = { proof: generated.proof, public_signals: generated.publicSignals };
      assertPublicBinding(bundle, request.witness);
      if (!await groth16.verify(request.artifacts.verificationKey, bundle.public_signals, bundle.proof,
        undefined, { singleThread: true })) throw new Error('INVALID_PROOF');
      result = bundle;
    } else if (request.mode === 'verify' && request.bundle) {
      result = await groth16.verify(request.artifacts.verificationKey, request.bundle.public_signals,
        request.bundle.proof, undefined, { singleThread: true });
    } else throw new Error('INVALID_OPERATION');
    process.send?.({ ok: true, result }, () => process.exit(0));
  } catch {
    // Never forward a witness, assertion trace, or provider error into application logs.
    process.send?.({ ok: false }, () => process.exit(1));
  }
});
