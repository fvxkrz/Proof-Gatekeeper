import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransferInput } from '../src/protocol.js';
import { evaluatePolicy } from '../src/policy.js';

function transfer(overrides: Partial<TransferInput> = {}): TransferInput {
  return {
    registered_vk: `0x${'ab'.repeat(32)}`,
    proof_vk: `0x${'ab'.repeat(32)}`,
    public_balance: '100',
    minimum: '100',
    current_block: 9,
    expiry_block: 10,
    recipient: `0x${'cd'.repeat(20)}`,
    condition_recipient: `0x${'cd'.repeat(20)}`,
    amount: '25',
    max_transfer: '25',
    proof_tx: `0x${'ef'.repeat(32)}`,
    ...overrides,
  };
}

const approved = { decision: 'APPROVE', reason_code: 'ALL_CHECKS_PASSED' };

function rejected(reason_code: string) {
  return { decision: 'REJECT', reason_code };
}

test('fails closed for non-object transfer input even without schema validation', () => {
  for (const value of [null, undefined, 1, '', true, [], { ...transfer(), amount: undefined }]) {
    assert.deepEqual(evaluatePolicy(value as unknown as TransferInput), rejected('INVALID_INPUT'));
  }
});

test('rejects malformed hash or address fields before policy checks', () => {
  for (const field of ['registered_vk', 'proof_vk', 'proof_tx', 'recipient', 'condition_recipient'] as const) {
    const width = field === 'recipient' || field === 'condition_recipient' ? 20 : 32;
    const invalid: unknown[] = ['', '0x1', `0x${'aa'.repeat(width - 1)}`, `0x${'aa'.repeat(width + 1)}`, `0x${'gg'.repeat(width)}`, `0X${'aa'.repeat(width)}`, 'aa'.repeat(width), `0x${'aa'.repeat(width)}\n`, null, undefined, 1, {}];
    for (const value of invalid) {
      assert.deepEqual(evaluatePolicy({ ...transfer(), [field]: value } as unknown as TransferInput), rejected('INVALID_INPUT'), `${field}=${String(value)}`);
    }
  }
});

test('rejects block values outside integer uint32 before policy checks', () => {
  const invalid: unknown[] = [4294967296, -1, 1.5, NaN, Infinity, -Infinity, '9', null, undefined, true];
  for (const field of ['current_block', 'expiry_block'] as const) {
    for (const value of invalid) {
      assert.deepEqual(evaluatePolicy({ ...transfer({ proof_vk: `0x${'12'.repeat(32)}` }), [field]: value } as unknown as TransferInput), rejected('INVALID_INPUT'), `${field}=${String(value)}`);
    }
  }
  assert.deepEqual(evaluatePolicy(transfer({ current_block: 0, expiry_block: 4294967295 })), approved);
  assert.deepEqual(evaluatePolicy(transfer({ current_block: 0, expiry_block: 0 })), rejected('PROOF_EXPIRED'));
});

test('rejects noncanonical or out-of-uint32 monetary fields before policy checks', () => {
  const invalid: unknown[] = ['4294967296', '9007199254740993', '-1', '1.5', '', ' 1', '1 ', '+1', '01', '0x01', '1e2', 1, null, undefined, true, {}, []];
  for (const field of ['minimum', 'public_balance', 'amount', 'max_transfer'] as const) {
    for (const value of invalid) {
      const input = { ...transfer({ proof_vk: `0x${'12'.repeat(32)}` }), [field]: value } as unknown as TransferInput;
      assert.deepEqual(evaluatePolicy(input), rejected('INVALID_INPUT'), `${field}=${String(value)}`);
    }
  }
  assert.deepEqual(evaluatePolicy(transfer({ minimum: '0', public_balance: '0', amount: '0', max_transfer: '0' })), approved);
  assert.deepEqual(evaluatePolicy(transfer({ minimum: '4294967295', public_balance: '4294967295', amount: '4294967295', max_transfer: '4294967295' })), approved);
});

test('rejects amounts strictly above the transfer limit using numeric comparison', () => {
  assert.deepEqual(evaluatePolicy(transfer({ amount: '26' })), rejected('AMOUNT_EXCEEDS_LIMIT'));
  assert.deepEqual(evaluatePolicy(transfer({ amount: '100', max_transfer: '9' })), rejected('AMOUNT_EXCEEDS_LIMIT'));
  assert.deepEqual(evaluatePolicy(transfer({ amount: '9', max_transfer: '100' })), approved);
});

test('compares recipient addresses by bytes, ignoring hex case', () => {
  assert.deepEqual(evaluatePolicy(transfer({ recipient: `0x${'CD'.repeat(20)}` })), approved);
});

test('rejects a different recipient before an amount failure', () => {
  assert.deepEqual(evaluatePolicy(transfer({
    recipient: `0x${'34'.repeat(20)}`, amount: '26',
  })), rejected('RECIPIENT_MISMATCH'));
});

test('rejects expiry at equality or later before recipient and amount failures', () => {
  for (const current_block of [10, 11, 4294967295]) {
    assert.deepEqual(evaluatePolicy(transfer({
      current_block, recipient: `0x${'34'.repeat(20)}`, amount: '26',
    })), rejected('PROOF_EXPIRED'));
  }
});

test('rejects insufficient balance before expiry, recipient, and amount failures', () => {
  assert.deepEqual(evaluatePolicy(transfer({
    public_balance: '99', current_block: 10,
    recipient: `0x${'34'.repeat(20)}`, amount: '26',
  })), rejected('INSUFFICIENT_BALANCE'));
});

test('compares condition verification keys by bytes, ignoring hex case', () => {
  assert.deepEqual(evaluatePolicy(transfer({ proof_vk: `0x${'AB'.repeat(32)}` })), approved);
});

test('approves a valid transfer with inclusive balance and amount limits', () => {
  assert.deepEqual(evaluatePolicy(transfer()), approved);
});

test('rejects verification-key substitution before lower-priority policy failures', () => {
  assert.deepEqual(evaluatePolicy(transfer({
    proof_vk: `0x${'12'.repeat(32)}`,
    public_balance: '99',
    current_block: 10,
    recipient: `0x${'34'.repeat(20)}`,
    amount: '26',
  })), rejected('VK_SUBSTITUTION'));
});
