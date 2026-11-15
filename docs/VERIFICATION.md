# Verification and readiness report

## Executed locally

- Strict TypeScript checking: passed (`npm run typecheck`).
- Automated tests: **137 passed, 0 failed**, including nested security cases and
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
security concerns or logic errors. The parent then reran the complete suite with
an additional portability regression: **137 tests passed**. The implementation
review does not certify the external compatibility/deployment prerequisites below.

## Not executed / still blocked

- Official platform-compatible encoding is unconfirmed: the public documentation
  does not publish the condition-VK and task-ID field encodings or an accepted
  proof vector. No guessed encoder is enabled.
- Original-transaction lookup/statement-binding has no published contract. The
  shipped entrypoint intentionally has no historical-reference adapter. Even an
  encoder plus Kurier credentials cannot activate approvals alone.
- No live Kurier testnet key or dashboard HMAC secret was available. No testnet or
  mainnet proof submission, payment, wallet signing, or dashboard action occurred.
- No public HTTPS host/domain was deployed or registered. Local signed preflight
  testing is not the platform's dashboard preflight.
- Docker is not installed here, so the container build/non-root read-only runtime
  was not executed. A pinned GitHub Actions workflow performs those gates on a
  Docker-capable runner. Node and Caddy image index digests were retrieved from
  the official registry and checked against their manifest bytes.

## Delivered behavior

This is an implemented, tested, **fail-closed local service**, not a certified
competition-ready agent. Secrets in `.env.example` are blank and `.env` is ignored.
Startup refuses a missing dashboard secret. With a valid secret but unresolved
proof prerequisites, preflight authentication works, `/readyz` stays 503, and
transfer requests cannot receive APPROVE. See `README.md` and
`docs/PROTOCOL_GAPS.md` before configuring deployment or entering a scored round.
