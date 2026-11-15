import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Artifacts } from './artifacts.js';

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const WITNESS_FIELDS = ['registeredVkHash', 'proofVkHash', 'minimum', 'publicBalance',
  'expiryBlock', 'currentBlock', 'recipient', 'conditionRecipient', 'amount', 'maxTransfer', 'decision', 'taskId'] as const;
export type NumericWitness = Record<typeof WITNESS_FIELDS[number] | 'salt', string>;
export interface ProofBundle { proof: Record<string, unknown>; public_signals: string[] }
export interface Prover { prove(witness: NumericWitness, signal: AbortSignal): Promise<ProofBundle> }

export function assertPublicBinding(bundle: ProofBundle, witness: NumericWitness): void {
  if (bundle.proof.protocol !== 'groth16' || bundle.proof.curve !== 'bn128' ||
      !Array.isArray(bundle.public_signals) || bundle.public_signals.length !== 13 ||
      bundle.public_signals.some((v) => !/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) >= FIELD) ||
      WITNESS_FIELDS.some((name, i) => bundle.public_signals[i + 1] !== witness[name])) {
    throw new Error('PROOF_BINDING_MISMATCH');
  }
}

export class ProcessProver implements Prover {
  constructor(private readonly artifacts: Artifacts) {}

  async prove(witness: NumericWitness, signal: AbortSignal): Promise<ProofBundle> {
    for (const value of Object.values(witness)) {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 77 || BigInt(value) >= FIELD) throw new Error('INVALID_WITNESS');
    }
    const result = await this.run({ mode: 'prove', witness }, signal) as ProofBundle;
    assertPublicBinding(result, witness);
    return result;
  }
  async verify(bundle: ProofBundle, signal: AbortSignal): Promise<boolean> {
    return (await this.run({ mode: 'verify', bundle }, signal)) === true;
  }

  // CPU-heavy snarkjs cannot block the HTTP event loop or outlive cancellation.
  private run(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const compiled = fileURLToPath(new URL('./prover-child.js', import.meta.url));
    const childPath = existsSync(compiled) ? compiled : fileURLToPath(new URL('./prover-child.ts', import.meta.url));
    const args = ['--max-old-space-size=384', ...(childPath.endsWith('.ts') ? ['--import', 'tsx'] : []), childPath];
    return new Promise((resolve, reject) => {
      // Do not inherit dashboard secrets or API keys into the proof subprocess.
      const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' },
      });
      let settled = false;
      const finish = (error: Error | null, result?: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        child.kill('SIGKILL');
        if (error) reject(error); else resolve(result);
      };
      const abort = (): void => finish(new Error('PROOF_TIMEOUT'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      child.once('error', () => finish(new Error('PROVER_UNAVAILABLE')));
      child.once('exit', () => finish(new Error('PROOF_GENERATION_FAILED')));
      child.once('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('ok' in message) || message.ok !== true || !('result' in message)) {
          finish(new Error('PROOF_GENERATION_FAILED')); return;
        }
        finish(null, message.result);
      });
      child.send({ ...request, artifacts: this.artifacts }, (error) => {
        if (error) finish(new Error('PROVER_UNAVAILABLE'));
      });
    });
  }
}
