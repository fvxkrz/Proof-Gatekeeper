import { loadArtifacts } from '../src/artifacts.js';
import { ProcessProver } from '../src/prover.js';
import { KurierClient } from '../src/zkverify.js';

try {
  if (!process.argv.includes('--confirm-testnet') || !process.env.KURIER_API_KEY || !process.env.KURIER_VK_HASH ||
    (process.env.ZKVERIFY_NETWORK && process.env.ZKVERIFY_NETWORK !== 'testnet')) throw new Error('NOT_CONFIRMED');
  const signal = AbortSignal.timeout(55_000);
  const artifacts = await loadArtifacts(process.env.ARTIFACTS_DIR || './circuits');
  const prover = new ProcessProver(artifacts);
  // Numeric algebraic self-test only, never represented as an accepted platform task.
  const witness = { minimum: '1000', publicBalance: '1460', expiryBlock: '100', currentBlock: '99',
    recipient: '123', conditionRecipient: '123', amount: '500', maxTransfer: '1000',
    registeredVkHash: '1', proofVkHash: '1', decision: '1', taskId: '10', salt: '20' };
  const proof = await prover.prove(witness, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
  const client = new KurierClient({ network: 'testnet', apiKey: process.env.KURIER_API_KEY, vkHash: process.env.KURIER_VK_HASH });
  const evidence = await client.finalize(proof, signal);
  process.stdout.write(JSON.stringify({ event: 'testnet_proof_finalized', network: 'testnet',
    platformEncodingCompatibilityConfirmed: false, ...evidence }) + '\n');
} catch {
  process.stderr.write('testnet_smoke_unavailable\n'); process.exitCode = 1;
}
