# Proof Gatekeeper HTTP agent

TypeScript / Node.js 22, Fastify, snarkjs Groth16/BN128, SQLite replay protection,
and a Kurier REST finality adapter. The platform calls your endpoint; it never
executes this repository.

## Read this before deployment

**This build is not cleared for scored competition.** The public official build
page does not specify how `task_id` strings and 256-bit condition VK hashes map to
`taskId`, `registeredVkHash`, and `proofVkHash` field elements. A locally valid
proof does not establish that those encodings match the platform's statement.
No guessed hash/reduction is enabled. Until a reviewed official encoder is
provided, valid-looking tasks receive signed `REJECT /
PROTOCOL_ENCODING_UNCONFIRMED`, no invented proof, and `/readyz` returns 503.
The incoming `proof_tx` is preserved exactly as an opaque wire reference (nonempty,
up to 256 characters). A reference that is not an exact 32-byte `0x` transaction
hash is never padded, trimmed, lowercased, or looked up: after HMAC authentication
the service returns a signed HTTP 200 `REJECT / REFERENCE_UNCONFIRMED` before any
replay-cache access, proof generation, or external submission. Exact hash syntax
alone still does not prove that the original transaction is finalized or bound to
the submitted statement. No authoritative lookup/binding contract is published.
`src/main.ts` therefore leaves the internal `ReferenceVerifier` adapter disabled.
Supplying an encoder and new-proof finalizer alone still cannot enable readiness
or approval. Do not activate this configuration for scored rounds: deliberate
safe rejections and missing proofs can lose points.

The service and real circuit prover are implemented and locally testable. The
public endpoint `https://fvxkrz-agent.duckdns.org/agent` is deployed behind Caddy;
public `/healthz` returns 200 and one dashboard practice result was reported as a
correct REJECT. That test does not establish all trap vectors, approvals, or live
zkVerify finality. The live `/readyz` intentionally remains 503. The exact
platform-generated HMAC is stored only on the host; no credential is included in
this repository.

## Source of truth

- Protocol, Security checklist, artifact links: https://agentgames.zkverify.io/build
- Registration: https://agentgames.zkverify.io/guide
- Network and mainnet circuit key: https://agentgames.zkverify.io/api/circuit-info
- Live Kurier Swagger v1.36.0: https://api-testnet.kurier.xyz/docs/json
- Provider finality states: https://kurier.xyz/docs/testnet/job_statuses

`docs/official-*-snapshot.*` retains the pages used for this build. The downloadable
WASM and proving key are included unchanged with SHA-256 pins. The verification key
was exported from the official zkey and is pinned too. The download script rejects
changed artifacts instead of silently trusting a changed proving key.

## Layout

- `src/server.ts`: raw-body HTTP handling, signed preflight/errors, timestamps,
  bounded request budget, health and readiness.
- `src/auth.ts`, `src/protocol.ts`: strict hex HMAC and envelope validation. The
  opaque `proof_tx` wire string is bounded and preserved; only an exact-width
  canonical hash can proceed to reference handling.
- `src/proof-reference.ts`: exact 66-character/32-byte transaction-hash guard,
  shared by the engine and the historical-evidence validator.
- `src/diagnostics.ts`: bounded rejection summaries (schema paths, fixed codes,
  value types and lengths only); never logs bodies, secrets, or unknown key names.
- `src/policy.ts`: deterministic transfer checks; no model calls.
- `src/store.ts`: atomic task/reference reservations, cached byte-for-byte results,
  durable SQLite WAL, persisted in-progress records fail closed after a crash.
- `src/encoding.ts`: disabled-by-default, hash-pinned local encoder extension point.
- `src/reference.ts`: internal historical-evidence interface and pure runtime binding
  validation; no guessed lookup endpoint, remote attestation, or boolean bypass.
- `src/prover.ts`, `src/prover-child.ts`: killable subprocesses generate and verify
  real proofs using the pinned artifacts. They do not inherit API/HMAC secrets.
- `src/zkverify.ts`: fixed official network hosts, proof submission and polling.
- `src/engine.ts`: fail-closed handling of opaque references before replay/cache
  access, historical-reference gate, proof binding, replay protection,
  new-proof finality-before-approval, and transport-owned outcome recording.
- `scripts/replay.ts`: local replay harness; synthetic tasks, real circuit proofs,
  explicitly simulated Kurier and historical-reference evidence. It does not claim
  on-chain finality or an independently resolved historical transaction.
- `deploy/`: Docker image, Caddy automatic public HTTPS, existing-host Caddy
  override, and a hardened systemd unit example for a shared VPS.

## Install and exercise locally

Requires Node.js 22.16+ and npm. A C++ toolchain may be needed if a prebuilt
`better-sqlite3` binary is unavailable. Exact dependencies and the lockfile are
included. `underscore` is overridden to its patched 1.13.8 transitive version.

```sh
npm ci
npm run artifacts:verify
npm run typecheck
npm test
npm run build
npm run replay
```

The tests generate actual Groth16 proofs, verify them with the exported official
VK, reject altered public signals, and demonstrate that the circuit will not
prove a false REJECT of an otherwise valid transfer. Numeric witness self-tests
are **not** official accepted platform vectors. Kurier unit tests use explicit
mock HTTP responses, not a fabricated live chain result.

To refresh the same pinned artifacts:

```sh
npm run artifacts:download
```

If an official artifact changes, stop and review the new circuit and protocol;
do not merely replace its integrity hash.

## Environment and startup

Copy `.env.example` to `.env`, restrict its permissions, and fill it locally.
Never commit `.env`, paste a key into a chat, or put secrets in shell arguments.

- `AGENT_GAMES_HMAC_SECRET`: the exact plaintext from dashboard **Rotate Secret**.
  It is mandatory at startup. The example leaves it blank, never a working default.
- `KURIER_API_KEY`: testnet key from https://testnet.kurier.xyz. Mainnet keys are
  different. There is no wallet seed/private key in this implementation.
- `ZKVERIFY_NETWORK`: defaults to `testnet`.
- `KURIER_VK_HASH`: registered VK on the selected network. The published hash is
  registered on **mainnet**; that is not evidence of registration on testnet.
- `ENCODING_MODULE` and `ENCODING_MODULE_SHA256`: leave blank until the missing
  official mapping is established. See `docs/PROTOCOL_GAPS.md`.
- `AGENT_PATH`: `/agent` by default. Register this full path, not just the domain.
- `DB_PATH`: persistent local filesystem database; never use ephemeral storage
  or several independent databases behind a load balancer.
- `RESPONSE_BUDGET_MS`: defaults to 55,000, cannot exceed 55,000.
- `PROOF_TIMEOUT_MS`: defaults to 15,000. A hard abort kills the proof subprocess.
- `MAX_IN_FLIGHT`: defaults to 1. Excess work is rejected, not queued past deadline.

```sh
node --env-file=.env dist/src/main.js
```

Liveness is `GET /healthz`. Readiness is `GET /readyz`. Successful preflight proves
HMAC plumbing only; it does not certify an encoder, proof binding, or finality.
Readiness also requires a reviewed historical-reference adapter; the shipped
entrypoint intentionally has none, and no environment flag bypasses that gate.

## Testnet VK registration

Registration is an explicit command, never an automatic HTTP-request side effect.
After setting `KURIER_API_KEY` locally:

```sh
node --env-file=.env --import tsx scripts/register-vk.ts --confirm-testnet
```

It posts the exported real VK to the documented testnet registration endpoint,
and prints only its public hash. A duplicate-registration HTTP 400 is not silently
reinterpreted as success: the Swagger does not guarantee a duplicate error code
or `meta.vkHash`. The API exposes no separate registration-finality endpoint.
Confirm the network hash by finalizing a real test proof before activation.

An explicit numeric testnet proof smoke command is available:

```sh
node --env-file=.env --import tsx scripts/testnet-smoke.ts --confirm-testnet
```

It requires a real testnet `KURIER_API_KEY` and `KURIER_VK_HASH` in the local
environment. It has **not** been live-executed here: no real API key was available.
Even a successful run would establish new-proof finality only, not platform
encoding compatibility or verification of the original incoming `proof_tx`.

For proof submission the adapter sends `proofType: groth16`, `vkRegistered: true`,
`proofOptions: {library: snarkjs, curve: bn128}` and the real proof/public signals.
It handles both documented HTTP 200 and 202, polls `job-status`, and recognizes
only exact `Finalized` with a job ID plus transaction and block hashes as confirmed.
`Valid`, `Submitted`, and `IncludedInBlock` are not sufficient. Unknown states,
network errors, malformed responses, 402/payment demands, and timeouts fail closed.
No automatic payment, on-chain transaction signing, or POST retry is performed.

## HTTPS hosting and registration

The app deliberately listens on loopback by default; Caddy is the public HTTPS
boundary. For a VPS with Docker Compose, set a DNS A/AAAA record and configure
`AGENT_DOMAIN` in your local `.env`. Ports 80/443 must be reachable.

```sh
docker compose --env-file .env -f deploy/compose.yaml up --build -d
```

Only Caddy publishes ports. The app is non-root, has a read-only filesystem,
dropped capabilities, bounded memory/processes, and a persistent SQLite volume.
The official Node and Caddy images are pinned to explicit SHA-256 index digests;
review and verify new digests before updating those pins.
The Docker/Caddy deployment requires a real host/domain and must be exercised
there; local Node tests are not a public TLS deployment test.

### Shared VPS with an existing host Caddy (systemd)

For a VPS where Docker is unavailable and Caddy already owns ports 80/443, the
live deployment can run the compiled Node service under `deploy/proof-gatekeeper.service.example`.
That unit is an example: adjust its `User`, `Group`, and absolute project paths,
then validate it with `systemd-analyze verify` before installing it. Keep the
agent bound to loopback. Set `PORT` in the local `.env` to an unused loopback port
and make the matching Caddy upstream agree (for the reference Tencent VPS setup,
the service uses port 3001 because 3000 is occupied). Keep `.env` mode 0600 and
out of Git, persist `data/`, then enable the unit. Do not stop or reconfigure an
unrelated host service to free a port.

The deployed endpoint's public `/healthz` has been verified as HTTP 200, and one
dashboard practice result reported a correct REJECT. `/readyz` remains 503 until
the official condition/task encodings and an authoritative historical-reference
verification adapter exist; preflight and one practice response do not clear
those gates.

### Existing host Caddy (e.g. the Tencent VPS already running Caddy)

Do not start the bundled `caddy` container if the host Caddy already owns ports
80/443. Use the override to bind the app only to loopback, and start only `app`:

```sh
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose-host-caddy.yaml up --build -d app
```

Then merge `deploy/Caddyfile.host.example` into the existing host Caddyfile,
replace `agent.example.com` with the registered public hostname, validate the
full Caddy config, and reload Caddy. Keep `.env` local and mode 0600. DNS must
resolve publicly and ports 80/443 must reach the existing Caddy before it can
obtain the HTTPS certificate. This host-Caddy recipe does not clear the protocol
or historical-reference gates listed above.

Registration flow from the official guide:

1. Sign in at https://agentgames.zkverify.io/register with X or a wallet. Create
   your public profile; follow the platform's eligibility/rules.
2. Under dashboard **Manage Agents**, register the complete HTTPS handler URL,
   e.g. `https://your-domain/agent`, and select Proof Gatekeeper.
3. Use **Rotate Secret**, store its one-time plaintext locally as the environment
   secret, restart the service, and run dashboard preflight.
4. Preflight requests are authenticated before parsing and return exactly
   `{"ok":true,"protocolVersion":"v1"}`, signed over those actual response bytes.
5. Resolve the official encoding and historical-reference gaps, implement and
   review the reference adapter, confirm testnet finalization, and run
   unscored platform practice traps. Do not enter scored rounds on synthetic-only
   compatibility evidence.
6. Only after explicit operator review switch to `ZKVERIFY_NETWORK=mainnet`,
   `ALLOW_MAINNET=true`, a mainnet API key, and the published mainnet gatekeeper VK
   hash. Mainnet is never selected implicitly.

## Deterministic safety model

HMAC-SHA256 is computed over the exact Buffer received, with constant-time digest
comparison, **before JSON.parse**. The guide specifies 64 hexadecimal characters,
not a `sha256=` prefix. Duplicate/malformed signature headers are rejected.
Every application response is serialized once, signed over those bytes, and sent
unchanged. TCP failures and proxy-level failures cannot carry an application HMAC.

Independent checks include VK equality, threshold, strict block expiry
(`current_block < expiry_block`), recipient binding, and transfer limit. Address
and hash comparisons are byte-equivalent, case-insensitive hex; money is BigInt,
not floating-point. The condition VK in a task is not assumed to be the separate
gatekeeper decision circuit's registered VK.

Timestamps are checked before proof work. As conservative local operational
limits, tasks must be at most 60 seconds old, at most 5 seconds in the future,
and have a signed window no longer than 60 seconds. These skew/age bounds are
configurable local safeguards, not invented platform protocol constants.
Monetary/block fields are restricted to an unsigned 32-bit safe subset because
bounds of the downloaded circuit's comparators are not published. Unknown fields
or unsupported values are rejected, never truncated or reduced silently.

SQLite atomically reserves both task ID and incoming `proof_tx` before external
work. A task-ID/body mismatch is rejected. Identical authenticated retries get the
stored response without another proof submission; another task cannot consume
the same reference. References remain consumed even after an uncertain outcome.
The engine returns a draft; only the HTTP transport's finalized, signed wire body
is recorded through `onOutcome`, after the response is sent. Deadline rewrites
and timer-selected TIMEOUTs are recorded, not the earlier APPROVE draft. Each
request owns its lease by its unique AbortSignal; a concurrent retry or late
handler cannot complete or overwrite the original outcome. A blocked SQLite
completion cannot change the already-final wire choice. Failed recording (or a
crash between delivery and recording) leaves the reservation processing and
retries fail closed instead of repeating external work.
Do not delete the database to clear a timeout: that would discard replay safety.
Single-host multiple processes must share the same real filesystem DB; multi-host
rollout requires replacing SQLite with an equivalent transactional shared store.

A proof is locally verified and all 12 exposed input signals are matched to the
expected witness. APPROVE additionally requires runtime-validated historical
evidence for the original `proof_tx`, the expected circuit/proof system/curve/key,
the task's complete transfer statement and exact `Finalized` state, followed by
finalization of the newly generated proof while time remains. A bare `{ok:true}`
does not satisfy the reference gate. Cached APPROVEs revalidate original-reference
evidence too, including entries created before this gate existed; no new proof
is submitted on retry. The adapter must independently obtain this evidence, not
echo task fields. There is no shipped adapter or claimed historical lookup API.
See `docs/PROTOCOL_GAPS.md` for the internal contract and activation boundary.

Transport/auth/schema errors, unavailable encoding, failed finality, and timeouts
are signed REJECTs without a fabricated proof. This is deliberate: the supplied
circuit enforces its decision. If its scalar checks say APPROVE but an external
safety check fails, no valid proof of the opposite circuit decision exists. Sending
an APPROVE proof labelled REJECT would be dishonest. The game may penalize a
proof-less safe rejection; safety takes precedence.

No LLM is invoked. No request body, raw provider error, secret-bearing URL,
API/HMAC key, salt, or witness is logged. Provider API keys appear in the official
Kurier URL paths; this adapter follows no redirects and does not log URLs.
