import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { createEngine } from '../src/engine.js';
import { SQLiteStore } from '../src/store.js';
import { loadArtifacts, MAINNET_VK_HASH } from '../src/artifacts.js';
import { ProcessProver } from '../src/prover.js';
import { KurierClient } from '../src/zkverify.js';
import { signBody, verifySignature } from '../src/auth.js';
import { sampleTask } from '../tests/fixtures.js';
import type { AgentResponse } from '../src/protocol.js';
import type { ReferenceVerifier } from '../src/reference.js';

// Entirely local: real circuit proofs, synthetic envelopes, explicitly MOCKED chain responses.
const secret = randomBytes(32).toString('hex');
const store = new SQLiteStore(':memory:');
const artifacts = await loadArtifacts(fileURLToPath(new URL('../circuits', import.meta.url)));
const prover = new ProcessProver(artifacts);
let submissions = 0;
const jobs = new Map<string, number>();
const fakeFetch: typeof fetch = async (url, init) => {
  if (init?.method === 'POST') {
    submissions++; const jobId = randomUUID(); jobs.set(jobId, 0);
    return Response.json({ jobId, status: 'pending' }, { status: 202 });
  }
  const jobId = String(url).split('/').at(-1)!;
  const count = (jobs.get(jobId) ?? 0) + 1; jobs.set(jobId, count);
  return Response.json({ jobId, status: count === 1 ? 'IncludedInBlock' : 'Finalized', proofType: 'groth16',
    txHash: '0x' + 'ab'.repeat(32), blockHash: '0x' + 'cd'.repeat(32), errorDetails: null });
};
const finalizer = new KurierClient({ network: 'testnet', apiKey: randomBytes(24).toString('hex'), vkHash: MAINNET_VK_HASH, pollIntervalMs: 1, fetchImpl: fakeFetch });
const encoder = {
  encodeVk: (vk: string) => vk === '0x' + '11'.repeat(32) ? '1' : '2',
  encodeTaskId: (id: string) => id.split('_').at(-1)!,
};
// MOCKED normalized historical evidence. No historical transaction was looked up.
const referenceVerifier: ReferenceVerifier = {
  expected: { circuitId: 'SYNTHETIC_ONLY', proofSystem: 'groth16', curve: 'bn128' },
  verify: async task => {
    const { proof_tx, ...input } = task.input;
    return { ...referenceVerifier.expected, proofTx: proof_tx, status: 'Finalized', blockHash: '0x' + 'ef'.repeat(32),
      verificationKey: task.input.proof_vk, statement: { task_id: task.task_id, input } };
  },
};
const engine = createEngine({ store, prover, encoder, finalizer, referenceVerifier });
const server = createServer({ secret, handler: engine.handle, onOutcome: engine.onOutcome, ready: engine.ready });
try {
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const send = async (raw: string) => {
    const response = await fetch(address + '/agent', { method: 'POST', headers: { 'content-type': 'application/json',
      'x-agent-games-signature': signBody(secret, raw) }, body: raw });
    const text = await response.text();
    assert.equal(verifySignature(secret, text, response.headers.get('x-agent-games-signature') ?? undefined), true);
    return { status: response.status, text, body: JSON.parse(text) as AgentResponse };
  };
  const preflight = await send(JSON.stringify({ type: 'agent-games.preflight.v1', agent_id: 'agt_local_replay', issued_at: new Date().toISOString(), nonce: randomUUID() }));
  assert.deepEqual(preflight.body, { ok: true, protocolVersion: 'v1' });
  const patches = [{}, { public_balance: '999' }, { proof_vk: '0x' + '33'.repeat(32) }, { current_block: 100 },
    { condition_recipient: '0x' + '00'.repeat(19) + '7c' }, { amount: '1001' }];
  let verified = 0; let firstRaw = ''; let firstResponse = '';
  for (const [index, patch] of patches.entries()) {
    const id = index + 1;
    const task = sampleTask({ ...patch, proof_tx: '0x' + BigInt(id).toString(16).padStart(64, '0') }, `gk_local_replay_${id}`);
    const raw = JSON.stringify(task); const result = await send(raw);
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, index === 0 ? 'APPROVE' : 'REJECT');
    assert.ok(result.body.proof && result.body.public_signals);
    assert.equal(await prover.verify({ proof: result.body.proof, public_signals: result.body.public_signals }, AbortSignal.timeout(10_000)), true);
    verified++;
    if (index === 0) { firstRaw = raw; firstResponse = result.text; }
  }
  const before = submissions;
  assert.equal((await send(firstRaw)).text, firstResponse); assert.equal(submissions, before);
  const reused = sampleTask({ proof_tx: '0x' + '1'.padStart(64, '0') }, 'gk_local_replay_7');
  assert.equal((await send(JSON.stringify(reused))).body.reason_code, 'PROOF_REFERENCE_REUSED');
  process.stdout.write(JSON.stringify({ event: 'local_replay_passed', signedPreflight: true, realProofsVerified: verified,
    cachedRetryWithoutResubmission: true, reusedReferenceRejected: true, network: 'MOCKED_ONLY', platformEncoding: 'SYNTHETIC_ONLY',
    historicalReference: 'MOCKED_ONLY', liveChainFinalityVerified: false }) + '\n');
} catch {
  process.stderr.write('local_replay_failed\n'); process.exitCode = 1;
} finally { await server.close(); store.close(); }
