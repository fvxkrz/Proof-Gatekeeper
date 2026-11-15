import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createServer } from '../src/server.js';
import type { AgentResponse, Task } from '../src/protocol.js';

const NOW = Date.parse('2026-11-15T08:00:00.000Z');
const SIGNATURE = 'x-agent-games-signature';

function mac(secret: string, raw: Buffer | string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function preflight(issuedAt = NOW) {
  return {
    type: 'agent-games.preflight.v1', agent_id: 'agt_fixture',
    issued_at: new Date(issuedAt).toISOString(), nonce: 'transport-fixture',
  };
}

function taskEnvelope(issued = NOW, deadline = NOW + 45_000): Task {
  return {
    type: 'agent-games.proof-gatekeeper.v1', task_id: 'gk_transport_fixture', mode: 'competition',
    issued_at: new Date(issued).toISOString(), deadline_at: new Date(deadline).toISOString(),
    input: {
      registered_vk: `0x${'ab'.repeat(32)}`, proof_vk: `0x${'ab'.repeat(32)}`,
      minimum: '1000', public_balance: '1460', expiry_block: 8430000, current_block: 8420000,
      recipient: `0x${'De'.repeat(20)}`, condition_recipient: `0x${'De'.repeat(20)}`,
      amount: '500', max_transfer: '1000', proof_tx: `0x${'cd'.repeat(32)}`,
    },
  };
}

function assertSigned(response: {
  rawPayload: Buffer;
  headers: Record<string, string | string[] | number | undefined>;
}, secret: string): void {
  assert.equal(response.headers[SIGNATURE], mac(secret, response.rawPayload));
  assert.match(String(response.headers['content-type']), /^application\/json(?:;|$)/i);
  assert.equal(response.rawPayload.includes(Buffer.from(secret)), false, 'response must not expose the secret');
}

test('authenticated preflight returns the exact signed v1 handshake', async t => {
  const secret = randomBytes(32).toString('hex');
  let calls = 0;
  const app = createServer({
    secret, now: () => NOW,
    handler: async () => { calls++; return { decision: 'REJECT', reason_code: 'UNUSED' }; },
  });
  t.after(() => app.close());
  const payload = `${JSON.stringify(preflight(), null, 2)}\n`;
  const response = await app.inject({
    method: 'POST', url: '/agent', payload,
    headers: { 'content-type': 'application/json; charset=utf-8', [SIGNATURE]: mac(secret, payload) },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload, '{"ok":true,"protocolVersion":"v1"}');
  assertSigned(response, secret);
  assert.equal(calls, 0);
});

test('preflight timestamps enforce local freshness and future clock-skew safeguards', async t => {
  const secret = randomBytes(32).toString('hex');
  const app = createServer({ secret, now: () => NOW, maxTaskAgeMs: 1000, clockSkewMs: 25,
    handler: async () => ({ decision: 'APPROVE', reason_code: 'UNEXPECTED' }),
  });
  t.after(() => app.close());
  for (const [issued, expectedStatus, code] of [
    [NOW - 1001, 400, 'STALE_TIMESTAMP'], [NOW + 26, 400, 'FUTURE_TIMESTAMP'],
    [NOW - 1000, 200, undefined], [NOW + 25, 200, undefined],
  ] as const) {
    const payload = JSON.stringify(preflight(issued));
    const response = await app.inject({ method: 'POST', url: '/agent', payload,
      headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) },
    });
    assert.equal(response.statusCode, expectedStatus);
    assert.deepEqual(response.json(), code ? { decision: 'REJECT', reason_code: code } : { ok: true, protocolVersion: 'v1' });
    assertSigned(response, secret);
  }
});

test('valid tasks reach the handler with exact raw bytes and retain structural evidence', async t => {
  const secret = randomBytes(32).toString('hex');
  const task = taskEnvelope();
  const raw = Buffer.from(`${JSON.stringify(task, null, 2)}\n`);
  const evidence: AgentResponse = {
    decision: 'APPROVE', reason_code: 'VERIFIED', proof: { pi_a: ['1', '2'], protocol: 'groth16' },
    public_signals: ['1', '2'], proof_tx: task.input.proof_tx,
  };
  let calls = 0;
  const app = createServer({ secret, now: () => NOW, agentPath: '/registered/agent',
    handler: async (received, bytes, signal) => {
      calls++;
      assert.deepEqual(received, task);
      assert.ok(Buffer.isBuffer(bytes));
      assert.deepEqual(bytes, raw);
      assert.equal(signal.aborted, false);
      return evidence;
    },
  });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/registered/agent', payload: raw,
    headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, raw) },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), evidence);
  assertSigned(response, secret);
  assert.equal(calls, 1);
});

test('task freshness and expired deadlines reject before any handler work', async t => {
  const secret = randomBytes(32).toString('hex');
  let calls = 0;
  const app = createServer({ secret, now: () => NOW, handler: async () => {
    calls++; return { decision: 'APPROVE', reason_code: 'UNEXPECTED' };
  } });
  t.after(() => app.close());
  for (const [envelope, status, code] of [
    [taskEnvelope(NOW - 10_000, NOW), 200, 'TIMEOUT'],
    [taskEnvelope(NOW - 60_001, NOW - 1), 400, 'STALE_TIMESTAMP'],
    [taskEnvelope(NOW + 5001, NOW + 20_000), 400, 'FUTURE_TIMESTAMP'],
    [taskEnvelope(NOW, NOW + 60_001), 400, 'INVALID_ENVELOPE'],
    [taskEnvelope(NOW, NOW - 1), 400, 'INVALID_ENVELOPE'],
  ] as const) {
    const payload = JSON.stringify(envelope);
    const response = await app.inject({ method: 'POST', url: '/agent', payload,
      headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) },
    });
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: code });
    assertSigned(response, secret);
  }
  assert.equal(calls, 0);
});

test('only uncompressed application/json bodies reach the protocol parser', async t => {
  const secret = randomBytes(32).toString('hex');
  const app = createServer({ secret, now: () => NOW,
    handler: async () => ({ decision: 'APPROVE', reason_code: 'UNEXPECTED' }),
  });
  t.after(() => app.close());
  const payload = JSON.stringify(preflight());
  for (const headers of [
    { 'content-type': 'text/plain' }, { 'content-type': 'application/jsonp' },
    { 'content-type': 'application/problem+json' },
    { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    { 'content-type': 'application/json', 'content-encoding': 'identity' },
    { 'content-type': '' },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/agent', payload,
      headers: { ...headers, [SIGNATURE]: mac(secret, payload) },
    });
    assert.equal(response.statusCode, 415);
    assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'UNSUPPORTED_MEDIA_TYPE' });
    assertSigned(response, secret);
  }
});

test('oversized request bodies receive signed fail-closed parser errors', async t => {
  const secret = randomBytes(32).toString('hex');
  for (const limit of [undefined, 128]) {
    const app = createServer({ secret, now: () => NOW, ...(limit === undefined ? {} : { bodyLimit: limit }),
      handler: async () => ({ decision: 'APPROVE', reason_code: 'UNEXPECTED' }),
    });
    t.after(() => app.close());
    const payload = 'x'.repeat(limit === undefined ? 65_537 : 129);
    const response = await app.inject({ method: 'POST', url: '/agent', payload,
      headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) },
    });
    assert.equal(response.statusCode, 413);
    assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'BODY_TOO_LARGE' });
    assertSigned(response, secret);
  }
});

test('response budget aborts cancellable handlers and races uncooperative handlers fail closed', async t => {
  const secret = randomBytes(32).toString('hex');
  for (const cooperative of [true, false]) {
    let receivedSignal: AbortSignal | undefined;
    let completed = false;
    const app = createServer({ secret, now: () => NOW, responseBudgetMs: 15,
      handler: async (_task, _raw, signal) => {
        receivedSignal = signal;
        await delay(120, undefined, cooperative ? { signal } : undefined);
        completed = true;
        return { decision: 'APPROVE', reason_code: 'TOO_LATE' };
      },
    });
    t.after(() => app.close());
    const payload = JSON.stringify(taskEnvelope());
    const response = await app.inject({ method: 'POST', url: '/agent', payload,
      headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'TIMEOUT' });
    assert.equal(receivedSignal?.aborted, true);
    assert.equal(completed, false, 'transport must not wait for a handler that ignores abort');
    assertSigned(response, secret);
  }
});

test('the response budget starts before reading a delayed request body', async t => {
  const secret = randomBytes(32).toString('hex');
  let calls = 0;
  const app = createServer({ secret, now: () => NOW, responseBudgetMs: 15,
    handler: async () => { calls++; return { decision: 'APPROVE', reason_code: 'TOO_LATE' }; },
  });
  t.after(() => app.close());
  const payload = JSON.stringify(taskEnvelope());
  const slowBody = Readable.from((async function* () {
    await delay(60);
    yield Buffer.from(payload);
  })());
  const response = await app.inject({ method: 'POST', url: '/agent', payload: slowBody,
    headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) },
  });
  assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'TIMEOUT' });
  assert.equal(calls, 0);
  assertSigned(response, secret);
});

test('the envelope cutoff shortens the monotonic response budget', async t => {
  const secret = randomBytes(32).toString('hex');
  let signal: AbortSignal | undefined;
  let completed = false;
  const app = createServer({ secret, now: () => NOW, responseBudgetMs: 500,
    handler: async (_task, _raw, received) => {
      signal = received;
      await delay(120);
      completed = true;
      return { decision: 'APPROVE', reason_code: 'TOO_LATE' };
    },
  });
  t.after(() => app.close());
  const payload = JSON.stringify(taskEnvelope(NOW - 59_980, NOW + 20));
  const response = await app.inject({ method: 'POST', url: '/agent', payload,
    headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) },
  });
  assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'TIMEOUT' });
  assert.equal(signal?.aborted, true);
  assert.equal(completed, false);
  assertSigned(response, secret);
});

test('late approvals fail closed even after event-loop stalls, serialization, or a forward clock jump', async t => {
  const secret = randomBytes(32).toString('hex');
  for (const phase of ['handler', 'serialization', 'wall-clock']) {
    let wall = NOW;
    let signal: AbortSignal | undefined;
    const stall = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); };
    const app = createServer({ secret, now: () => wall, responseBudgetMs: 15,
      handler: async (_task, _raw, received) => {
        signal = received;
        if (phase === 'handler') stall();
        if (phase === 'wall-clock') wall = NOW + 45_001;
        return { decision: 'APPROVE', reason_code: 'TOO_LATE',
          ...(phase === 'serialization' ? { proof: { toJSON: () => { stall(); return { protocol: 'groth16' }; } } } : {}),
        };
      },
    });
    t.after(() => app.close());
    const payload = JSON.stringify(taskEnvelope());
    const response = await app.inject({ method: 'POST', url: '/agent', payload,
      headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) },
    });
    assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'TIMEOUT' }, phase);
    assert.equal(signal?.aborted, true);
    assertSigned(response, secret);
  }
});

test('operational endpoints and not-found responses are signed with live readiness', async t => {
  const secret = randomBytes(32).toString('hex');
  let ready = true;
  const app = createServer({ secret, now: () => NOW, ready: () => ready,
    handler: async () => ({ decision: 'REJECT', reason_code: 'UNUSED' }),
  });
  const defaultApp = createServer({ secret, now: () => NOW,
    handler: async () => ({ decision: 'REJECT', reason_code: 'UNUSED' }),
  });
  t.after(() => app.close());
  t.after(() => defaultApp.close());
  for (const [url, status, expected] of [
    ['/healthz', 200, { ok: true }], ['/readyz', 200, { ok: true }],
    [`/missing/${secret}`, 404, { decision: 'REJECT', reason_code: 'NOT_FOUND' }],
  ] as const) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.json(), expected);
    assertSigned(response, secret);
  }
  ready = false;
  const unavailable = await app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { ok: false });
  assertSigned(unavailable, secret);
  const defaultReady = await defaultApp.inject({ method: 'GET', url: '/readyz' });
  assert.equal(defaultReady.statusCode, 200);
  assert.deepEqual(defaultReady.json(), { ok: true });
  assertSigned(defaultReady, secret);
});

test('transport defaults disable request logging and proxy trust and bound HTTP timeouts', async t => {
  const secret = randomBytes(32).toString('hex');
  const app = createServer({ secret, handler: async () => ({ decision: 'REJECT', reason_code: 'UNUSED' }) });
  t.after(() => app.close());
  app.get('/proxy-test', async request => ({ ip: request.ip }));
  await app.ready();
  assert.equal(app.server.requestTimeout, 60_000);
  assert.equal(app.server.headersTimeout, 10_000);
  assert.equal(app.log.child({}), app.log, 'logger:false installs the no-op logger');
  const response = await app.inject({ method: 'GET', url: '/proxy-test', remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': '203.0.113.10' },
  });
  assert.deepEqual(response.json(), { ip: '127.0.0.1' });
  assertSigned(response, secret);
});

test('all error paths redact exception details and sign the actual wire bytes', async t => {
  const secret = randomBytes(32).toString('hex');
  const app = createServer({ secret, now: () => NOW,
    handler: async () => { throw new Error(`internal failure: ${secret}`); },
    ready: () => { throw new Error(`readiness failure: ${secret}`); },
  });
  t.after(() => app.close());
  const payload = JSON.stringify(taskEnvelope());
  const failure = await app.inject({ method: 'POST', url: '/agent', payload,
    headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) },
  });
  assert.equal(failure.statusCode, 500);
  assert.deepEqual(failure.json(), { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' });
  assertSigned(failure, secret);
  const unready = await app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(unready.statusCode, 500);
  assert.deepEqual(unready.json(), { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' });
  assertSigned(unready, secret);
  for (const method of ['HEAD', 'GET'] as const) {
    const response = await app.inject({ method, url: method === 'HEAD' ? '/healthz' : '/bad/%ZZ' });
    assertSigned(response, secret);
    if (method === 'GET') {
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'INVALID_REQUEST' });
    }
  }
});

test('HTTP parser failures outside Fastify routes still return signed safe JSON', async t => {
  const secret = randomBytes(32).toString('hex');
  const app = createServer({ secret, handler: async () => ({ decision: 'REJECT', reason_code: 'UNUSED' }) });
  t.after(() => app.close());
  const address = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));
  const wire = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: '127.0.0.1', port: Number(address.port) });
    socket.setTimeout(1000, () => socket.destroy(new Error('local HTTP test timed out')));
    socket.once('connect', () => socket.write('INVALID REQUEST\r\n\r\n'));
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks)));
    socket.once('error', reject);
  });
  const boundary = wire.indexOf('\r\n\r\n');
  assert.ok(boundary > 0);
  const header = wire.subarray(0, boundary).toString('utf8');
  const rawPayload = wire.subarray(boundary + 4);
  const headers = Object.fromEntries(header.split('\r\n').slice(1).map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  assert.match(header, /^HTTP\/1\.1 400 /);
  assert.deepEqual(JSON.parse(rawPayload.toString('utf8')), { decision: 'REJECT', reason_code: 'INVALID_REQUEST' });
  assertSigned({ rawPayload, headers }, secret);
});

test('handler exceptions cannot masquerade as transport parser errors', async t => {
  const secret = randomBytes(32).toString('hex');
  for (const statusCode of [413, 415, 400]) {
    const app = createServer({ secret, now: () => NOW, handler: async () => {
      throw Object.assign(new Error(`handler detail ${secret}`), { statusCode });
    } });
    t.after(() => app.close());
    const payload = JSON.stringify(taskEnvelope());
    const response = await app.inject({ method: 'POST', url: '/agent', payload,
      headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) },
    });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'INTERNAL_ERROR' });
    assertSigned(response, secret);
  }
});

test('authentication precedes JSON parsing and parse failures are safe signed rejections', async t => {
  const secret = randomBytes(32).toString('hex');
  let calls = 0;
  const app = createServer({ secret, now: () => NOW, handler: async () => {
    calls++;
    return { decision: 'APPROVE', reason_code: 'UNEXPECTED' };
  } });
  t.after(() => app.close());
  const malformed = '{"type": secret parse error';
  const valid = JSON.stringify(preflight());
  const cases = [
    { payload: malformed, signature: undefined, status: 401, code: 'BAD_SIGNATURE' },
    { payload: malformed, signature: 'z'.repeat(64), status: 401, code: 'BAD_SIGNATURE' },
    { payload: malformed, signature: mac(secret, malformed), status: 400, code: 'INVALID_JSON' },
    { payload: '', signature: mac(secret, ''), status: 400, code: 'INVALID_JSON' },
    { payload: '{}', signature: mac(secret, '{}'), status: 400, code: 'INVALID_ENVELOPE' },
    { payload: ` ${valid}`, signature: mac(secret, valid), status: 401, code: 'BAD_SIGNATURE' },
    { payload: valid, signature: [mac(secret, valid), mac(secret, valid)], status: 401, code: 'BAD_SIGNATURE' },
    { payload: valid, signature: `sha256=${mac(secret, valid)}`, status: 401, code: 'BAD_SIGNATURE' },
  ];
  for (const { payload, signature, status, code } of cases) {
    const response = await app.inject({ method: 'POST', url: '/agent', payload,
      headers: { 'content-type': 'application/json', ...(signature === undefined ? {} : { [SIGNATURE]: signature }) },
    });
    assert.equal(response.statusCode, status, code);
    assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: code });
    assertSigned(response, secret);
    assert.equal(response.payload.includes('secret parse error'), false);
  }
  assert.equal(calls, 0);
});
