import type { Task } from '../src/protocol.js';

// Synthetic envelopes following the documented shape, not captured platform tasks.
export function sampleTask(patch: Partial<Task['input']> = {}, id = 'gk_local_test_1'): Task {
  const now = Date.now();
  return {
    type: 'agent-games.proof-gatekeeper.v1', task_id: id, mode: 'practice',
    issued_at: new Date(now).toISOString(), deadline_at: new Date(now + 55_000).toISOString(),
    input: { registered_vk: '0x' + '11'.repeat(32), proof_vk: '0x' + '11'.repeat(32),
      minimum: '1000', public_balance: '1460', expiry_block: 100, current_block: 99,
      recipient: '0x' + '00'.repeat(19) + '7b', condition_recipient: '0x' + '00'.repeat(19) + '7b',
      amount: '500', max_transfer: '1000', proof_tx: '0x' + '22'.repeat(32), ...patch },
  };
}
