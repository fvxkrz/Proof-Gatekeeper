import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { sampleTask } from './fixtures.js';

const SIGNATURE = 'x-agent-games-signature';
const mac = (secret: string, raw: string) => createHmac('sha256', secret).update(raw).digest('hex');

test('authenticated invalid envelopes report field shape without logging request values or unknown key names', async t => {
  const secret = randomBytes(32).toString('hex');
  const events: unknown[] = [];
  let calls = 0;
  const options = {
    secret,
    onDiagnostic: (event: unknown) => { events.push(event); },
    handler: async () => { calls++; return { decision: 'REJECT' as const, reason_code: 'UNEXPECTED' }; },
  };
  const app = createServer(options);
  t.after(() => app.close());
  const task = sampleTask();
  const payload = JSON.stringify({ ...task, input: { ...task.input, proof_vk: secret, [secret]: secret } });
  const response = await app.inject({ method: 'POST', url: '/agent', payload,
    headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'INVALID_ENVELOPE' });
  assert.equal(response.headers[SIGNATURE], mac(secret, response.payload));
  assert.equal(calls, 0);
  assert.equal(events.length, 1, 'diagnostic observer must receive the authenticated rejection');
  const event = events[0] as { event: string; reason_code: string; issues: unknown[] };
  assert.equal(event.event, 'request_rejected');
  assert.equal(event.reason_code, 'INVALID_ENVELOPE');
  assert.ok(event.issues.some(x => JSON.stringify(x) === JSON.stringify({
    field: 'input.proof_vk', code: 'invalid_format', received_type: 'string', string_length: secret.length,
  })));
  assert.ok(event.issues.some(x => JSON.stringify(x) === JSON.stringify({
    field: 'input', code: 'unrecognized_keys', received_type: 'object', unknown_field_count: 1,
  })));
  assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(JSON.stringify(events).includes(payload), false);
});

test('authenticated JSON and timestamp rejections report only fixed reason codes', async t => {
  const secret = randomBytes(32).toString('hex');
  const now = Date.parse('2026-11-15T08:00:00.000Z');
  const events: unknown[] = [];
  const options = { secret, now: () => now,
    onDiagnostic: (event: unknown) => { events.push(event); },
    handler: async () => ({ decision: 'REJECT' as const, reason_code: 'UNEXPECTED' }) };
  const app = createServer(options);
  t.after(() => app.close());
  const preflight = (issued: number) => JSON.stringify({ type: 'agent-games.preflight.v1',
    agent_id: secret, issued_at: new Date(issued).toISOString(), nonce: secret });
  for (const [payload, reason] of [
    [`{${secret}`, 'INVALID_JSON'],
    [preflight(now - 60_001), 'STALE_TIMESTAMP'],
    [preflight(now + 5001), 'FUTURE_TIMESTAMP'],
  ] as const) {
    events.length = 0;
    const response = await app.inject({ method: 'POST', url: '/agent', payload,
      headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload!) } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().reason_code, reason);
    assert.deepEqual(events, [{ event: 'request_rejected', reason_code: reason, issues: [] }]);
    assert.equal(response.headers[SIGNATURE], mac(secret, response.payload));
    assert.equal(JSON.stringify(events).includes(secret), false);
  }
});

test('unauthenticated traffic and successful preflight never emit rejection diagnostics', async t => {
  const secret = randomBytes(32).toString('hex');
  const events: unknown[] = [];
  const options = { secret, onDiagnostic: (event: unknown) => { events.push(event); },
    handler: async () => ({ decision: 'REJECT' as const, reason_code: 'UNEXPECTED' }) };
  const app = createServer(options);
  t.after(() => app.close());
  const malformed = `{${secret}`;
  const bad = await app.inject({ method: 'POST', url: '/agent', payload: malformed,
    headers: { 'content-type': 'application/json', [SIGNATURE]: '0'.repeat(64) } });
  assert.equal(bad.statusCode, 401);
  const payload = JSON.stringify({ type: 'agent-games.preflight.v1', agent_id: secret,
    issued_at: new Date().toISOString(), nonce: secret });
  const good = await app.inject({ method: 'POST', url: '/agent', payload,
    headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) } });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(events, []);
});

test('diagnostic observer exceptions cannot alter the signed rejection', async t => {
  const secret = randomBytes(32).toString('hex');
  const options = { secret, onDiagnostic: () => { throw new Error(secret); },
    handler: async () => ({ decision: 'REJECT' as const, reason_code: 'UNEXPECTED' }) };
  const app = createServer(options);
  t.after(() => app.close());
  const payload = '{}';
  const response = await app.inject({ method: 'POST', url: '/agent', payload,
    headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { decision: 'REJECT', reason_code: 'INVALID_ENVELOPE' });
  assert.equal(response.headers[SIGNATURE], mac(secret, response.payload));
  assert.equal(response.payload.includes(secret), false);
});

test('diagnostics cap issue count and never serialize invalid field values', async t => {
  const secret = randomBytes(32).toString('hex');
  const events: unknown[] = [];
  const options = { secret, onDiagnostic: (event: unknown) => { events.push(event); },
    handler: async () => ({ decision: 'REJECT' as const, reason_code: 'UNEXPECTED' }) };
  const app = createServer(options);
  t.after(() => app.close());
  const task = sampleTask();
  const payload = JSON.stringify({ ...task,
    input: Object.fromEntries(Object.keys(task.input).map(k => [k, secret])) });
  const response = await app.inject({ method: 'POST', url: '/agent', payload,
    headers: { 'content-type': 'application/json', [SIGNATURE]: mac(secret, payload) } });
  assert.equal(response.statusCode, 400);
  assert.equal((events[0] as { issues: unknown[] }).issues.length, 8);
  assert.equal(JSON.stringify(events).includes(secret), false);
});
