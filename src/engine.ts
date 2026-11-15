import { createHash } from 'node:crypto';
import type { Task, AgentResponse } from './protocol.js';
import { evaluatePolicy } from './policy.js';
import { buildWitness, type Encoder } from './encoding.js';
import { assertPublicBinding, type Prover } from './prover.js';
import type { Finalizer } from './zkverify.js';
import type { SQLiteStore } from './store.js';
import { configuredReferenceVerifier, validateReferenceEvidence, type ReferenceVerifier } from './reference.js';
import { isCanonicalProofReference } from './proof-reference.js';

interface Options { store: SQLiteStore; prover: Prover; encoder?: Encoder; practiceEncoder?: Encoder; finalizer?: Finalizer; referenceVerifier?: ReferenceVerifier; shutdownSignal?: AbortSignal; maxInFlight?: number; proofTimeoutMs?: number }
export interface Engine {
  handle(task: Task, raw: Buffer, signal: AbortSignal): Promise<AgentResponse | string>;
  onOutcome(task: Task, raw: Buffer, signal: AbortSignal, wireBody: string): void;
  ready(): boolean;
}
const reject = (reason_code: string): AgentResponse => ({ decision: 'REJECT', reason_code });
function bounded<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, rejectPromise) => {
    const abort = (): void => rejectPromise(new Error('TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); return; }
    Promise.resolve().then(action).then(resolve, rejectPromise).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}
export function createEngine(options: Options): Engine {
  let active = 0;
  const referenceVerifier = configuredReferenceVerifier(options.referenceVerifier) ? options.referenceVerifier : undefined;
  const referenceConfirmed = async (task: Task, signal: AbortSignal): Promise<boolean> => {
    if (!referenceVerifier) return false;
    try {
      const evidence = await bounded(() => referenceVerifier.verify(task, signal), signal);
      signal.throwIfAborted();
      return validateReferenceEvidence(evidence, task, referenceVerifier.expected);
    } catch {
      signal.throwIfAborted();
      return false;
    }
  };
  // A concurrent retry must never obtain the first request's completion lease.
  const leases = new WeakMap<AbortSignal, { taskId: string; bodyHash: string; lease: string }>();
  return {
    ready: () => Boolean(options.encoder && options.finalizer && referenceVerifier && !options.shutdownSignal?.aborted),
    onOutcome: (task, raw, signal, wireBody) => {
      const owned = leases.get(signal);
      if (!owned || owned.taskId !== task.task_id || owned.bodyHash !== createHash('sha256').update(raw).digest('hex')) return;
      leases.delete(signal);
      // Only the transport's finalized, signed bytes are durable outcomes. A failed
      // recording keeps the reservation processing; never rewrite an already sent reply.
      try { options.store.complete(owned.taskId, owned.bodyHash, owned.lease, wireBody); } catch { /* fail closed */ }
    },
    handle: async (task, raw, signal) => {
      const expire = Math.min(Date.parse(task.deadline_at), Date.parse(task.issued_at) + 60_000);
      if (signal.aborted || options.shutdownSignal?.aborted || !Number.isFinite(expire) || Date.now() >= expire) return reject('TIMEOUT');
      const bodyHash = createHash('sha256').update(raw).digest('hex');
      let reservation;
      try { reservation = options.store.reserve(task.task_id, bodyHash, task.input.proof_tx, Date.now()); }
      catch { return reject('STORE_UNAVAILABLE'); }
      const deadlineSignal = AbortSignal.any([signal, ...(options.shutdownSignal ? [options.shutdownSignal] : []),
        AbortSignal.timeout(Math.max(1, expire - Date.now()))]);
      switch (reservation.kind) {
        case 'cached': {
          try {
            if ((JSON.parse(reservation.body) as AgentResponse).decision === 'APPROVE') {
              // Never replay a legacy cached approval for an opaque/malformed
              // reference; it is not evidence of a finalized transaction.
              if (!isCanonicalProofReference(task.input.proof_tx)) return reject('REFERENCE_UNCONFIRMED');
              if (!options.encoder) return reject('PROTOCOL_ENCODING_UNCONFIRMED');
              // Revalidate historical evidence even for old ledger entries written
              // before this activation gate existed. Never resubmit the task proof.
              if (!await referenceConfirmed(task, deadlineSignal)) return reject('REFERENCE_UNCONFIRMED');
              if (!options.finalizer) return reject('FINALITY_UNCONFIRMED');
              if (Date.now() >= expire) return reject('TIMEOUT');
            }
            return reservation.body;
          } catch { return reject(deadlineSignal.aborted ? 'TIMEOUT' : 'STORE_UNAVAILABLE'); }
        }
        case 'conflict': return reject('TASK_ID_CONFLICT');
        case 'reused': return reject('PROOF_REFERENCE_REUSED');
        case 'processing': return reject('TASK_IN_PROGRESS');
      }
      leases.set(signal, { taskId: task.task_id, bodyHash, lease: reservation.lease });
      if (active >= (options.maxInFlight ?? 1)) return reject('BUSY');
      active++;
      try {
        const policy = evaluatePolicy(task.input);
        // An otherwise valid task needs a real original-reference binding before
        // any approval path. Trap rejections can still be proven in practice;
        // do not let an opaque reference turn into an approval proof.
        if (policy.decision === 'APPROVE' && !isCanonicalProofReference(task.input.proof_tx)) {
          return reject('REFERENCE_UNCONFIRMED');
        }
        // The candidate encoder is an explicitly opted-in, unscored practice
        // experiment. It can only prove circuit REJECT traps, never approvals
        // or scored responses, and never contributes to readiness.
        const usePracticeEncoder = task.mode === 'practice' && policy.decision === 'REJECT'
          && options.practiceEncoder !== undefined;
        const encoder = usePracticeEncoder ? options.practiceEncoder : options.encoder;
        // The circuit can prove a rejection that follows its public numeric
        // conditions; historical proof evidence is mandatory before any approval.
        // The incoming proof_tx is only an opaque replay key and is not a circuit input.
        if (policy.decision === 'APPROVE') {
          if (!referenceVerifier) return reject('REFERENCE_UNCONFIRMED');
          if (!await referenceConfirmed(task, deadlineSignal)) return reject('REFERENCE_UNCONFIRMED');
        }
        if (!encoder) return reject(policy.decision === 'REJECT' ? policy.reason_code : 'PROTOCOL_ENCODING_UNCONFIRMED');
        deadlineSignal.throwIfAborted();
        const witness = buildWitness(task, policy.decision, encoder);
        const proofSignal = AbortSignal.any([deadlineSignal, AbortSignal.timeout(options.proofTimeoutMs ?? 15_000)]);
        const bundle = await bounded(() => options.prover.prove(witness, proofSignal), proofSignal);
        proofSignal.throwIfAborted();
        assertPublicBinding(bundle, witness);
        // Practice rejection proofs need local Groth16 validity only; never
        // submit them to Kurier. Scored-mode finality is unchanged below.
        if (usePracticeEncoder) return { ...policy, ...bundle };
        if (!options.finalizer) return policy.decision === 'REJECT' ? { ...policy, ...bundle } : reject('FINALITY_UNCONFIRMED');
        const finalizer = options.finalizer;
        const evidence = await bounded(() => finalizer.finalize(bundle, deadlineSignal), deadlineSignal);
        deadlineSignal.throwIfAborted();
        if (Date.now() >= expire || !evidence || Array.isArray(evidence) || evidence.status !== 'Finalized'
          || typeof evidence.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(evidence.jobId)
          || typeof evidence.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(evidence.txHash)
          || typeof evidence.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(evidence.blockHash)) return reject('FINALITY_UNCONFIRMED');
        return { ...policy, ...bundle, proof_tx: evidence.txHash };
      } catch {
        // A rejection outside the circuit cannot carry a proof whose public decision is APPROVE.
        return reject(deadlineSignal.aborted ? 'TIMEOUT' : 'VERIFICATION_UNCONFIRMED');
      } finally { active--; }
    },
  };
}
