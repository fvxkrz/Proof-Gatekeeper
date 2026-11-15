import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

// Pinned to the bytes downloaded from the official /build artifacts, not a request's VK.
export const OFFICIAL_ARTIFACTS = Object.freeze({
  'gatekeeper.wasm': 'be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f',
  'gatekeeper_final.zkey': 'adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d',
  'verification_key.json': '6ce4899b3bc74d6a5c10ede61daf8820716982e1ef7e6778a5a8872ddaf28221',
});
export const MAINNET_VK_HASH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
export interface Artifacts {
  wasm: string;
  zkey: string;
  verificationKeyPath: string;
  verificationKey: Record<string, unknown> & { protocol: 'groth16'; curve: 'bn128'; nPublic: number };
}
export async function loadArtifacts(directory: string): Promise<Artifacts> {
  const dir = resolve(directory);
  for (const [name, expected] of Object.entries(OFFICIAL_ARTIFACTS)) {
    const data = await readFile(join(dir, name));
    if (createHash('sha256').update(data).digest('hex') !== expected) {
      throw new Error('ARTIFACT_INTEGRITY');
    }
  }
  const key = JSON.parse(await readFile(join(dir, 'verification_key.json'), 'utf8')) as Artifacts['verificationKey'];
  if (key.protocol !== 'groth16' || key.curve !== 'bn128' || key.nPublic !== 13 || !Array.isArray(key.IC) || key.IC.length !== 14) {
    throw new Error('ARTIFACT_INTEGRITY');
  }
  return Object.freeze({ wasm: join(dir, 'gatekeeper.wasm'), zkey: join(dir, 'gatekeeper_final.zkey'),
    verificationKeyPath: join(dir, 'verification_key.json'), verificationKey: key });
}
