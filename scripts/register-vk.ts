import { loadArtifacts } from '../src/artifacts.js';
import { KurierClient } from '../src/zkverify.js';

try {
  // Explicit opt-in because this sends a real VK registration request. Never signs a wallet transaction.
  if (!process.argv.includes('--confirm-testnet') || !process.env.KURIER_API_KEY ||
      (process.env.ZKVERIFY_NETWORK && process.env.ZKVERIFY_NETWORK !== 'testnet')) throw new Error('NOT_CONFIRMED');
  const artifacts = await loadArtifacts(process.env.ARTIFACTS_DIR || './circuits');
  const client = new KurierClient({ network: 'testnet', apiKey: process.env.KURIER_API_KEY,
    vkHash: '0x' + '00'.repeat(32) });
  const vkHash = await client.registerVk(artifacts.verificationKey, AbortSignal.timeout(30_000));
  // Public hash only; the API key is never printed, including on failure.
  process.stdout.write(JSON.stringify({ network: 'testnet', vkHash, note: 'VK registration acknowledged; confirm by finalizing a test proof before activation.' }) + '\n');
} catch {
  process.stderr.write('vk_registration_unavailable\n'); process.exitCode = 1;
}
