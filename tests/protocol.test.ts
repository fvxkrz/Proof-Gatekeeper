import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnvelope } from '../src/protocol.js';

function taskEnvelope() {
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: 'gk_transport_fixture',
    mode: 'practice',
    issued_at: '2026-11-15T08:00:00.000Z',
    deadline_at: '2026-11-15T08:00:45.000Z',
    input: {
      registered_vk: `0x${'ab'.repeat(32)}`,
      proof_vk: `0x${'ab'.repeat(32)}`,
      minimum: '1000',
      public_balance: '1460',
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: `0x${'De'.repeat(20)}`,
      condition_recipient: `0x${'De'.repeat(20)}`,
      amount: '500',
      max_transfer: '1000',
      proof_tx: `0x${'cd'.repeat(32)}`,
    },
  };
}

test('parseEnvelope accepts the official complete task without coercion', () => {
  assert.deepEqual(parseEnvelope(taskEnvelope()), taskEnvelope());
});

test('parseEnvelope recognizes the distinct official preflight envelope', () => {
  const preflight = {
    type: 'agent-games.preflight.v1',
    agent_id: 'agt_fixture',
    issued_at: '2026-11-15T08:00:00+08:00',
    nonce: 'test-nonce',
  };
  assert.deepEqual(parseEnvelope(preflight), preflight);
});

test('parseEnvelope fails closed on unknown fields at every envelope level', () => {
  const task = taskEnvelope();
  const preflight = {
    type: 'agent-games.preflight.v1', agent_id: 'agt_fixture',
    issued_at: '2026-11-15T08:00:00Z', nonce: 'nonce',
  };
  for (const invalid of [
    { ...task, future_protocol_field: true },
    { ...task, input: { ...task.input, balance: '1000' } },
    { ...preflight, input: task.input },
    { ...task, type: 'agent-games.proof-gatekeeper.v2' },
    { ...task, mode: 'training' },
    null, [], 'task', 42,
  ]) assert.throws(() => parseEnvelope(invalid));
});

test('monetary fields require canonical uint32 decimal strings under local circuit policy', () => {
  for (const field of ['minimum', 'public_balance', 'amount', 'max_transfer'] as const) {
    for (const value of [
      '', '01', '+1', '-0', '-1', ' 1', '1 ', '1.0', '1e3', '0x10', 'NaN',
      '4294967296', '9007199254740993', '1'.repeat(1000), 1, null,
    ]) {
      const task = taskEnvelope();
      assert.throws(() => parseEnvelope({ ...task, input: { ...task.input, [field]: value } }), `${field}=${String(value).slice(0, 30)}`);
    }
    for (const value of ['0', '1', '4294967295']) {
      const task = taskEnvelope();
      assert.doesNotThrow(() => parseEnvelope({ ...task, input: { ...task.input, [field]: value } }));
    }
  }
});

test('key, transaction, and recipient fields require full fixed-width 0x hex', () => {
  for (const [field, bytes] of [
    ['registered_vk', 32], ['proof_vk', 32], ['proof_tx', 32],
    ['recipient', 20], ['condition_recipient', 20],
  ] as const) {
    for (const value of ['', '0xab...cd', '0x01', `0X${'ab'.repeat(bytes)}`, 'ab'.repeat(bytes), `0x${'gg'.repeat(bytes)}`, `0x${'ab'.repeat(bytes + 1)}`]) {
      const task = taskEnvelope();
      assert.throws(() => parseEnvelope({ ...task, input: { ...task.input, [field]: value } }), field);
    }
  }
});

test('block fields require uint32 safe integer numbers without coercion', () => {
  for (const field of ['expiry_block', 'current_block'] as const) {
    for (const value of [-1, 1.5, NaN, Infinity, 4294967296, Number.MAX_SAFE_INTEGER + 1, '10', null]) {
      const task = taskEnvelope();
      assert.throws(() => parseEnvelope({ ...task, input: { ...task.input, [field]: value } }), field);
    }
    for (const value of [0, 4294967295]) {
      const task = taskEnvelope();
      assert.doesNotThrow(() => parseEnvelope({ ...task, input: { ...task.input, [field]: value } }));
    }
  }
});

test('timestamps require a valid ISO calendar time with an explicit timezone', () => {
  for (const field of ['issued_at', 'deadline_at'] as const) {
    for (const value of ['', '2026-11-15', '2026-11-15T08:00:00', '2026-02-30T08:00:00Z', '2026-11-15T25:00:00Z', 'yesterday', 123]) {
      assert.throws(() => parseEnvelope({ ...taskEnvelope(), [field]: value }), `${field}=${value}`);
    }
  }
  const preflight = { type: 'agent-games.preflight.v1', agent_id: 'agt_fixture', nonce: 'nonce' };
  assert.throws(() => parseEnvelope({ ...preflight, issued_at: '2026-11-15T08:00:00' }));
  assert.doesNotThrow(() => parseEnvelope({ ...taskEnvelope(), issued_at: '2026-11-15T08:00:00.123+05:30', deadline_at: '2026-11-15T08:00:45.123+05:30' }));
});

test('task timestamps are ordered and the envelope window is at most sixty seconds', () => {
  const task = taskEnvelope();
  assert.throws(() => parseEnvelope({ ...task, issued_at: '2026-11-15T08:00:46.000Z' }));
  assert.throws(() => parseEnvelope({ ...task, deadline_at: '2026-11-15T08:01:00.001Z' }));
  assert.doesNotThrow(() => parseEnvelope({ ...task, deadline_at: '2026-11-15T08:01:00.000Z' }));
});
