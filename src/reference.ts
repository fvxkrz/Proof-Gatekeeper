import type { Task, TransferInput } from './protocol.js';

/** Internal adapter contract only; it does not define a remote lookup or attestation protocol. */
export interface ReferenceExpectation {
  circuitId: string;
  proofSystem: string;
  curve: string;
}
export interface ReferenceEvidence extends ReferenceExpectation {
  proofTx: string;
  status: 'Finalized';
  blockHash: string;
  verificationKey: string;
  statement: { task_id: string; input: Omit<TransferInput, 'proof_tx'> };
}
export interface ReferenceVerifier {
  readonly expected: ReferenceExpectation;
  verify(task: Task, signal: AbortSignal): Promise<unknown>;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sameHash(value: unknown, expected: string): boolean {
  return typeof value === 'string' && HASH.test(value) && HASH.test(expected) && value.toLowerCase() === expected.toLowerCase();
}

function configuredExpectation(value: unknown): value is ReferenceExpectation {
  return record(value) && ['circuitId', 'proofSystem', 'curve'].every(key => {
    const id = value[key];
    return typeof id === 'string' && id.length > 0 && id.length <= 256 && id.trim() === id;
  });
}
export function configuredReferenceVerifier(value: unknown): value is ReferenceVerifier {
  return record(value) && typeof value.verify === 'function' && configuredExpectation(value.expected);
}

/** Validate normalized local evidence, never a bare adapter success flag. */
export function validateReferenceEvidence(value: unknown, task: Task, expected: ReferenceExpectation): value is ReferenceEvidence {
  if (!configuredExpectation(expected) || !record(value) || value.status !== 'Finalized' || typeof value.blockHash !== 'string' || !HASH.test(value.blockHash)
    || !sameHash(value.proofTx, task.input.proof_tx) || !sameHash(value.verificationKey, task.input.proof_vk)
    || value.circuitId !== expected.circuitId || value.proofSystem !== expected.proofSystem || value.curve !== expected.curve
    || !record(value.statement) || value.statement.task_id !== task.task_id || !record(value.statement.input)) return false;
  const input = value.statement.input;
  return Object.entries(task.input).every(([key, required]) => {
    if (key === 'proof_tx') return true; // Bound separately to the finalized transaction above.
    const actual = input[key];
    return typeof required === 'string' && required.startsWith('0x')
      ? typeof actual === 'string' && actual.toLowerCase() === required.toLowerCase()
      : actual === required;
  });
}
