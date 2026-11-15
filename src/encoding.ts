import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Task, Decision } from './protocol.js';
import { FIELD, type NumericWitness } from './prover.js';

// /build does not specify these mappings. No guessed mapping is enabled or shipped.
export interface Encoder { encodeVk(vk: string): string; encodeTaskId(id: string): string }

/**
 * Unverified black-box candidate for UNscored practice only. Independent public
 * participant code suggests integer VK hashes reduced mod BN128 and SHA-256 of
 * UTF-8 task IDs reduced mod BN128. The official accepted mapping is unpublished;
 * never select this encoder for competition or readiness.
 */
export function experimentalPracticeEncoder(): Encoder {
  return {
    encodeVk(vk) {
      if (typeof vk !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(vk)) throw new Error('ENCODING_INVALID');
      return (BigInt(vk) % FIELD).toString();
    },
    encodeTaskId(id) {
      if (typeof id !== 'string' || id.length === 0) throw new Error('ENCODING_INVALID');
      const digest = createHash('sha256').update(id, 'utf8').digest('hex');
      return (BigInt('0x' + digest) % FIELD).toString();
    },
  };
}

export async function loadPinnedEncoder(options: { modulePath?: string; sha256?: string }): Promise<Encoder | undefined> {
  if (!options.modulePath && !options.sha256) return undefined;
  if (!options.modulePath || !isAbsolute(options.modulePath) || !options.sha256 || !/^[a-f0-9]{64}$/.test(options.sha256)) throw new Error('ENCODING_INTEGRITY');
  const bytes = await readFile(options.modulePath);
  if (createHash('sha256').update(bytes).digest('hex') !== options.sha256) throw new Error('ENCODING_INTEGRITY');
  // This is trusted operator-deployed code, never a URL, task field, or model output.
  const loaded = await import(pathToFileURL(options.modulePath).href) as { encoder?: Encoder };
  if (typeof loaded.encoder?.encodeVk !== 'function' || typeof loaded.encoder?.encodeTaskId !== 'function') throw new Error('ENCODING_INTEGRITY');
  return loaded.encoder;
}
function field(value: string): string {
  if (typeof value !== 'string' || value.length > 77 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= FIELD) throw new Error('ENCODING_INVALID');
  return value;
}
export function buildWitness(task: Task, decision: Decision, encoder: Encoder): NumericWitness {
  const i = task.input;
  const registeredVkHash = field(encoder.encodeVk(i.registered_vk.toLowerCase()));
  const proofVkHash = field(encoder.encodeVk(i.proof_vk.toLowerCase()));
  if ((i.registered_vk.toLowerCase() === i.proof_vk.toLowerCase()) !== (registeredVkHash === proofVkHash)) throw new Error('ENCODING_INVALID');
  return {
    registeredVkHash, proofVkHash, minimum: i.minimum, publicBalance: i.public_balance,
    expiryBlock: String(i.expiry_block), currentBlock: String(i.current_block),
    recipient: BigInt(i.recipient).toString(), conditionRecipient: BigInt(i.condition_recipient).toString(),
    amount: i.amount, maxTransfer: i.max_transfer, decision: decision === 'APPROVE' ? '1' : '0',
    taskId: field(encoder.encodeTaskId(task.task_id)), salt: BigInt('0x' + randomBytes(16).toString('hex')).toString(),
  };
}
