import { createHash } from 'node:crypto';
import type { Task, AgentResponse } from './protocol.js';
import { evaluatePolicy } from './policy.js';
import { buildWitness, type Encoder } from './encoding.js';
import { assertPublicBinding, type Prover } from './prover.js';
import type { Finalizer } from './zkverify.js';
import type { SQLiteStore } from './store.js';
import { configuredReferenceVerifier, validateReferenceEvidence, type ReferenceVerifier } from './reference.js';

interface Options { store: SQLiteStore; prover: Prover; encoder?: Encoder; finalizer?: Finalizer; referenceVerifier?: ReferenceVerifier; shutdownSignal?: AbortSignal; maxInFlight?: number; proofTimeoutMs?: number }
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
        if (!options.encoder) return reject(policy.decision === 'REJECT' ? policy.reason_code : 'PROTOCOL_ENCODING_UNCONFIRMED');
        if (!referenceVerifier) return reject('REFERENCE_UNCONFIRMED');
        deadlineSignal.throwIfAborted();
        if (!await referenceConfirmed(task, deadlineSignal)) return reject('REFERENCE_UNCONFIRMED');
        const witness = buildWitness(task, policy.decision, options.encoder);
        const proofSignal = AbortSignal.any([deadlineSignal, AbortSignal.timeout(options.proofTimeoutMs ?? 15_000)]);
        const bundle = await bounded(() => options.prover.prove(witness, proofSignal), proofSignal);
        proofSignal.throwIfAborted();
        assertPublicBinding(bundle, witness);
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
