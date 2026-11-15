# Verification and readiness report

## Executed locally

- Strict TypeScript checking: passed (`npm run typecheck`).
- Automated tests: **150 passed, 0 failed**, including nested security cases and
  a portable-temporary-directory regression for clean CI users.
- Compiled ESM build: passed (`npm run build`).
- Replay harness: **6 actual Groth16 proofs generated and verified** with the
  official downloaded circuit artifacts and exported verification key. Preflight,
  exact response signatures, cached retries and reference reuse were exercised.
  Task digest encodings are synthetic; historical evidence and Kurier responses
  are explicitly **MOCKED_ONLY**. No live finality is claimed.
- Official wasm/zkey/exported-VK integrity: passed (`npm run artifacts:verify`).
- Production dependency audit: zero reported vulnerabilities (`npm audit --omit=dev`).
- Fresh production-only installation (`npm ci --omit=dev`) in an isolated copy:
  passed; no tsx or other development dependencies were present. The compiled
  prover generated and verified a real proof, and the compiled service passed a
  signed preflight with readiness correctly blocked.
- Caddy configuration validation: passed. A loopback HTTPS test used a locally
  generated certificate and normal certificate validation, not disabled TLS
  validation. Authenticated preflight, signature-before-JSON rejection, signed
  parse errors, readiness 503 and safe default REJECT were verified.
- `git diff --check`: passed.

## Practice-reference fix

- A signed dashboard practice task produced an authenticated `proof_tx` string
  of length 34, which the previous exact-hash schema rejected with HTTP 400.
- The wire schema now accepts a bounded opaque string without changing it. The
  engine returns signed HTTP 200 `REJECT / REFERENCE_UNCONFIRMED` for anything
  other than a canonical exact-width hash, before replay/cache access, lookups,
  proof generation, or external submission. It does not pad, normalize, or claim
  the opaque value is a transaction hash.
- The proof-reference guard requires both exact 66-character width and hex syntax.
  Authenticated tests cover short, malformed, padded, and line-terminated values,
  exact references, cache-bypass attempts, both request modes, and evidence validation.
- A compiled-runtime local smoke test confirmed signed 200 safety rejections for
  a synthetic 34-character reference and a synthetic 67-character line-terminated
  hash. These are unit/integration fixtures, not captured task contents or chain
  verification evidence.
- The new final implementation diff received an independent security review with
  no concrete security concerns or logic errors. The review does not certify the
  unresolved platform/chain contracts below.

## Review-driven regressions

Independent review found a timeout/cache inconsistency and an insufficient gate
for original proof references. A separate fix context added failing regressions
before changing implementation. Tests now cover:

- Exact signed wire bytes, not a pre-transport draft, are cached after deadline
  rewriting, synchronous completion stalls and late dependency completion.
- Concurrent retries cannot own another request's completion lease.
- A recording failure leaves a reference consumed; it never resubmits blindly.
- Missing historical evidence prevents readiness and approval, including cached
  approvals created before the new gate existed.
- Historical reference, statement, circuit identity, system, curve, verification
  key and exact finalized evidence all require runtime validation.
- Shutdown, proof cancellation, malformed finality, public-signal mismatches,
  store failures and uncooperative dependencies fail closed.

The final independent implementation re-review **passed**, with no reported
security concerns or logic errors. The complete suite then passed: **150 tests**.
The implementation review does not certify the external compatibility/chain
prerequisites below.

## Not executed / still blocked

- Official platform-compatible encoding is unconfirmed: the public documentation
  does not publish the condition-VK and task-ID field encodings or an accepted
  proof vector. No guessed encoder is enabled.
- Original-transaction lookup/statement-binding has no published contract. The
  shipped entrypoint intentionally has no historical-reference adapter. Even an
  encoder plus Kurier credentials cannot activate approvals alone.
- No live Kurier testnet key or testnet-registered decision VK is configured.
  No testnet or mainnet proof submission, payment, or wallet signing occurred.
- The host Caddy/systemd service is deployed at the registered public HTTPS
  endpoint. Public `/healthz` returned 200; the Agent Games dashboard delivered
  at least one practice task whose screenshot reported a correct REJECT. A single
  practice outcome does not validate all trap types, every proof path, or scored
  round readiness. `/readyz` intentionally remains 503.
- Dashboard HMAC values and other production credentials are stored only in the
  host `.env` (permissions 0600), excluded from Git and not included here.
- Docker is not installed here, so the container build/non-root read-only runtime
  was not executed locally. The pinned GitHub Actions workflow includes those
  gates; verify its result for the exact source commit after the repository update
  is pushed. Node and Caddy image index digests were retrieved from the official
  registry and checked against their manifest bytes.

## Delivered behavior

This is an implemented, tested, deployed **fail-closed service**, not a certified
competition-ready agent. Secrets in `.env.example` are blank and `.env` is ignored.
Startup refuses a missing dashboard secret. With a valid secret but unresolved
proof prerequisites, signed preflight/authentication works, `/readyz` stays 503,
and transfer requests cannot receive APPROVE. See `README.md` and
`docs/PROTOCOL_GAPS.md` before configuring deployment or entering a scored round.
