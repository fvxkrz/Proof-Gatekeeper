import type { TransferInput } from './protocol.js';

function isUint32Decimal(value: unknown): value is string {
  return typeof value === 'string'
    && /^(0|[1-9][0-9]{0,9})$/.test(value)
    && Number(value) <= 0xffff_ffff;
}

export type PolicyResult = {
  decision: 'APPROVE' | 'REJECT';
  reason_code: string;
};

/** Pure deterministic policy; condition keys come from the authenticated task. */
export function evaluatePolicy(input: TransferInput): PolicyResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { decision: 'REJECT', reason_code: 'INVALID_INPUT' };
  }
  if (![input.minimum, input.public_balance, input.amount, input.max_transfer].every(isUint32Decimal)) {
    return { decision: 'REJECT', reason_code: 'INVALID_INPUT' };
  }
  if (![input.current_block, input.expiry_block].every(value =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff)) {
    return { decision: 'REJECT', reason_code: 'INVALID_INPUT' };
  }
  // proof_tx is a separate opaque replay/evidence reference, not a circuit input.
  const hashes = [input.registered_vk, input.proof_vk];
  const addresses = [input.recipient, input.condition_recipient];
  if (!hashes.every(value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value))
    || !addresses.every(value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value))) {
    return { decision: 'REJECT', reason_code: 'INVALID_INPUT' };
  }
  if (input.registered_vk.toLowerCase() !== input.proof_vk.toLowerCase()) {
    return { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' };
  }
  if (BigInt(input.public_balance) < BigInt(input.minimum)) {
    return { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' };
  }
  if (input.current_block >= input.expiry_block) {
    return { decision: 'REJECT', reason_code: 'EXPIRED_CONDITION' };
  }
  if (input.recipient.toLowerCase() !== input.condition_recipient.toLowerCase()) {
    return { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' };
  }
  if (BigInt(input.amount) > BigInt(input.max_transfer)) {
    return { decision: 'REJECT', reason_code: 'AMOUNT_OVERFLOW' };
  }
  return { decision: 'APPROVE', reason_code: 'VALID_CONDITION' };
}
