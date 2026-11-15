# Protocol gaps and evidence boundaries

## Blocking: platform string-to-field encodings

The authoritative `/build` envelope has snake_case fields. The supplied official
WASM takes scalar inputs named:

```
registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
currentBlock, recipient, conditionRecipient, amount, maxTransfer,
decision, taskId, salt
```

These names and the following public signal order were exercised against the
actual downloaded circuit, not a replacement circuit:

```
[0] circuit binding output
[1] registeredVkHash
[2] proofVkHash
[3] minimum
[4] publicBalance
[5] expiryBlock
[6] currentBlock
[7] recipient
[8] conditionRecipient
[9] amount
[10] maxTransfer
[11] decision
[12] taskId
```

The local tests demonstrate valid numeric APPROVE, valid numeric REJECT, rejection
of a dishonest decision by the witness generator, and rejection of modified public
signals by Groth16 verification. They do not establish how the platform derives
the three digest fields from a real task.

Specifically missing from the official pages:
- Condition VK bytes to BN128 field-element mapping (a 256-bit hash may exceed the
  field modulus; silently reducing or choosing a hash is not an authoritative rule).
- Task-ID UTF-8 string to `taskId` field-element mapping.
- A complete official accepted envelope/witness/proof/public-signal test vector.
- Published comparator bit bounds and exhaustive reason-code precedence.

Ask the organizers for the Gatekeeper circuit source or witness-input schema and
accepted vectors. Do not take another contestant's assumed mappings as official.
The `Encoder` interface in `src/encoding.ts` is intentionally unconfigured. Once
the official mapping is known, implement its `encodeVk(string): string` and
`encodeTaskId(string): string` functions in a reviewed local JS module exporting
`encoder`. Both functions must return canonical nonnegative decimal field values.
Hash-pin that trusted local module with `ENCODING_MODULE_SHA256` and configure its
absolute path through `ENCODING_MODULE`. There is no URL download or model call.
Any additional imports/dependencies of an operator encoder also require review.

For **unscored practice rejection proofs only**, an explicit `PRACTICE_ENCODER`
opt-in may enable the unverified black-box candidate
`sha256-vk-modp-taskid-sha256-modp-v1`: condition VK bytes become the integer
represented by the hex bytes modulo the BN128 field prime; a free-form task ID
becomes `SHA-256(UTF-8(task_id)) mod p`. Public participant repositories report
that formula, but another implementation uses the first 31 SHA-256 bytes; neither
is organizer-confirmed. The candidate is restricted in code to mode `practice`
and policy decisions that are REJECT. It is never used for any APPROVE, any
competition-mode request, Kurier submission, `/readyz`, or a cache of approvals.
The host `.env` is now configured to opt into this for unscored practice only;
that mapping remains unverified by Agent Games. A fresh randomized synthetic
request through the deployed HTTPS endpoint returned a signed Groth16 REJECT and
the response proof independently verified locally against the official pinned
verification key. This proves hosted plumbing and local circuit validity only,
not that the practice checker re-derived the same encoding. Only a real practice
checker result can establish platform acceptance.
To disable this experiment, remove `PRACTICE_ENCODER` from the host `.env` and
restart the service. Already-completed identical task retries continue to return
their cached signed bytes (including any practice proof) to preserve HTTP
idempotency; disabling the encoder blocks new experimental proofs, not an already
consumed task's cached response.

The service separately binds the numeric amount, threshold, block heights,
recipient and circuit decision to the returned public signals. The encoder
cannot swap the requested action or recipient. It must preserve VK equality;
a mapping collision between distinct VKs is rejected.

## Blocking: historical proof reference

The official incoming example contains a `proof_tx` reference. A real signed
practice request was observed with a 34-character string; length alone does not
establish that it is a chain transaction hash. Transport accepts a nonempty string
up to 256 characters (a local operational bound), preserving its contents exactly.
A reference is never padded, truncated, trimmed, lowercased, or promoted to
finalized evidence. The SQLite replay ledger preserves opaque reference bytes;
canonical transaction hashes are compared case-insensitively by bytes. An opaque
reference blocks approval and stale cached approvals. A circuit-detectable trap
may still produce a local practice-only REJECT proof, because `proof_tx` is not a
circuit signal; the proof does not attest to that original reference. The evidence
validator still requires exact-width hashes. This fixes the observed transport
400, not proof-reference coverage or platform acceptance; an off-circuit-only
rejection may remain proof-less and incur a game penalty.

The public task contract does not include the original proof/public-signal object,
proof-system identifier, finalized block location, or documented historical-evidence
lookup endpoint. One-use replay tracking and finalizing a newly generated proof do
**not** validate the original reference. An authoritative original-proof lookup and
statement-binding contract is required before activation; no remote route or
attestation format is guessed.

`src/reference.ts` defines an **internal, local adapter interface**, not an
extension of the platform or Kurier wire protocol. `createEngine` requires a
`ReferenceVerifier` with trusted expected `circuitId`, `proofSystem`, and `curve`
identifiers plus `verify(task, signal): Promise<unknown>`. The adapter must
independently resolve and verify the original proof using the future authoritative
contract. It must not simply mirror request fields or return a success boolean.

The normalized evidence is runtime-validated before any new proof work:
- `proofTx` is the full incoming `proof_tx`, compared as hash bytes.
- `status` is exactly `Finalized` with a full `blockHash`.
- `circuitId`, `proofSystem`, and `curve` equal the trusted adapter expectations;
  absent, empty, or malformed expectations cannot activate readiness.
- `verificationKey` matches the task's original `proof_vk`; policy independently
  requires it to match `registered_vk` before an APPROVE.
- `statement.task_id` matches the current task ID; `statement.input` contains
  every original transfer-input field except `proof_tx` (bound separately).
  Numeric/string values must match exactly; hex keys/addresses compare by bytes.

Missing adapters, `{ok:true}`, malformed/mismatched evidence, exceptions, and
unconfirmed finality fail closed. Historical lookup is abort-bounded even if the
adapter ignores cancellation. Cached APPROVEs revalidate the reference, so an old
ledger entry cannot bypass a missing or failing adapter; retries never resubmit
the new task proof. This structural validation does not itself authenticate a
remote provider: reviewing the adapter's source, provenance, network selection,
and independent verification is an activation prerequisite.

The shipped `src/main.ts` deliberately supplies **no** reference adapter, even
when an encoder and Kurier credentials are configured. Readiness remains false
and approval is unavailable. There is no unchecked environment bypass or remote
module loader. The replay/test adapters explicitly use **MOCKED_ONLY** evidence;
they establish local plumbing, not real historical verification or chain finality.

## Transport-owned durable outcomes

SQLite reserves a processing lease before external work. Engine return values
are drafts, not completed outcomes. The server serializes, applies its final
deadline check, signs the exact outgoing bytes, then records that immutable body
through `onResponse` → `engine.onOutcome(task, raw, requestSignal, wireBody)`.
The original request signal, not a task-ID lookup or a shutdown-combined signal,
owns the lease. Timer wins and serialization-adjusted TIMEOUTs are persisted even
when work resolves later; concurrent retries cannot finalize someone else's lease.

Completion runs after the final wire choice, so a synchronous DB stall cannot
cause an APPROVE draft to be cached behind a TIMEOUT wire response. Failed
recording or a crash after sending leaves processing reservations consumed;
delivery and SQLite completion are not claimed to be one atomic transaction.
Cached raw bytes are returned unchanged within the validity/activation gates.

## Operational rejections are not always circuit-provable

The official circuit forces its scalar decision. A valid transfer with a local
store failure, unavailable network finality, or expired HTTP deadline cannot be
turned into a valid proof of the opposite scalar decision. Such responses are
signed safe REJECTs without proof, not fabricated Groth16 objects or an APPROVE
proof mislabeled REJECT. This can incur a game penalty; it cannot be honestly
fixed by changing a response string.

## Network testing

The included Kurier tests use clearly identified mocks of the live documented
REST shapes. The local replay harness is not a live zkVerify transaction. A real
Kurier testnet API key and a VK confirmed on that testnet are needed for live
finalization; neither is included or requested in chat. The only published circuit
key from `/api/circuit-info` is explicitly on mainnet. No mainnet-to-testnet
registration equivalence is assumed.
