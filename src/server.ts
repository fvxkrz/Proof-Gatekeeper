import { performance } from 'node:perf_hooks';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { signBody, verifySignature } from './auth.js';
import { parseEnvelope, type AgentResponse, type Task } from './protocol.js';

export type ServerOptions = {
  secret: string;
  agentPath?: string;
  bodyLimit?: number;
  handler: (task: Task, raw: Buffer, signal: AbortSignal) => Promise<AgentResponse | string>;
  onOutcome?: (task: Task, raw: Buffer, signal: AbortSignal, wireBody: string) => void | Promise<void>;
  now?: () => number;
  maxTaskAgeMs?: number;
  clockSkewMs?: number;
  responseBudgetMs?: number;
  ready?: () => boolean;
};

const SIGNATURE = 'x-agent-games-signature';

export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({
    logger: false, logController: new LogController({ disableRequestLogging: true }), trustProxy: false,
    bodyLimit: options.bodyLimit ?? 64 * 1024, requestTimeout: 60_000,
    clientErrorHandler: (_error, socket) => {
      if (!socket.writable) return;
      const raw = JSON.stringify({ decision: 'REJECT', reason_code: 'INVALID_REQUEST' });
      socket.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(raw)}\r\n${SIGNATURE}: ${signBody(options.secret, raw)}\r\nConnection: close\r\n\r\n${raw}`);
    },
    // Router-level errors bypass the normal hooks and must sign their own bytes.
    frameworkErrors: (_error, request, reply) => {
      const raw = request.method === 'HEAD' ? '' : JSON.stringify({ decision: 'REJECT', reason_code: 'INVALID_REQUEST' });
      (reply as FastifyReply).code(400).type('application/json').header(SIGNATURE, signBody(options.secret, raw)).send(raw);
    },
  });
  app.server.headersTimeout = 10_000;
  const states = new WeakMap<FastifyRequest, {
    receivedWall: number;
    receivedMono: number;
    deadlineMono: number;
    deadlineWall: number;
    controller: AbortController;
    timeout: Promise<AgentResponse>;
    expire: () => void;
    timer: NodeJS.Timeout;
    task?: Task;
    raw?: Buffer;
    wireBody?: string;
  }>();
  app.addHook('onRequest', async (request, reply) => {
    const receivedMono = performance.now();
    const receivedWall = (options.now ?? Date.now)();
    const budget = options.responseBudgetMs ?? 55_000;
    const controller = new AbortController();
    let resolveTimeout!: (response: AgentResponse) => void;
    const timeout = new Promise<AgentResponse>(resolve => { resolveTimeout = resolve; });
    const expire = () => {
      const rejection: AgentResponse = { decision: 'REJECT', reason_code: 'TIMEOUT' };
      resolveTimeout(rejection);
      controller.abort();
      if (!reply.sent) reply.send(rejection);
    };
    const timer = setTimeout(expire, budget);
    states.set(request, { receivedWall, receivedMono, deadlineMono: receivedMono + budget,
      deadlineWall: receivedWall + budget,
      controller, timeout, expire, timer });
  });
  app.addHook('onResponse', async request => {
    const state = states.get(request);
    clearTimeout(state?.timer);
    if (state?.task && state.raw && state.wireBody !== undefined) {
      try { await options.onOutcome?.(state.task, state.raw, state.controller.signal, state.wireBody); }
      catch { /* The wire response is final; a recording failure must not rewrite or log it. */ }
    }
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addHook('onSend', async (request, reply, payload) => {
    let raw = payload as Buffer | string;
    const state = states.get(request);
    // Timers cannot run while JS is blocked; recheck after serialization, before signing.
    if (state && reply.statusCode === 200 && (state.controller.signal.aborted
      || performance.now() >= state.deadlineMono
      || (options.now ?? Date.now)() >= state.deadlineWall)) {
      state.controller.abort();
      raw = JSON.stringify({ decision: 'REJECT', reason_code: 'TIMEOUT' });
      reply.removeHeader('content-length');
    }
    if (request.method === 'HEAD') raw = '';
    reply.type('application/json').header(SIGNATURE, signBody(options.secret, raw));
    if (state) state.wireBody = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    return raw;
  });
  app.setErrorHandler((error, _request, reply) => {
    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.code(413).send({ decision: 'REJECT', reason_code: 'BODY_TOO_LARGE' });
    }
    if ((error as { statusCode?: number }).statusCode === 415) {
      return reply.code(415).send({ decision: 'REJECT', reason_code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    return reply.code(500).send({ decision: 'REJECT', reason_code: 'INTERNAL_ERROR' });
  });
  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ decision: 'REJECT', reason_code: 'NOT_FOUND' });
  });
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_request, reply) => {
    const ready = options.ready?.() ?? true;
    return reply.code(ready ? 200 : 503).send({ ok: ready });
  });
  app.post(options.agentPath ?? '/agent', async (request, reply) => {
    const raw = request.body as Buffer;
    if (!verifySignature(options.secret, raw, request.headers[SIGNATURE])) {
      return reply.code(401).send({ decision: 'REJECT', reason_code: 'BAD_SIGNATURE' });
    }
    const contentType = request.headers['content-type'];
    if (typeof contentType !== 'string'
      || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
      || request.headers['content-encoding'] !== undefined) {
      return reply.code(415).send({ decision: 'REJECT', reason_code: 'UNSUPPORTED_MEDIA_TYPE' });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send({ decision: 'REJECT', reason_code: 'INVALID_JSON' });
    }
    let envelope;
    try {
      envelope = parseEnvelope(decoded);
    } catch {
      return reply.code(400).send({ decision: 'REJECT', reason_code: 'INVALID_ENVELOPE' });
    }
    const issued = Date.parse(envelope.issued_at);
    const current = (options.now ?? Date.now)();
    if (issued > current + (options.clockSkewMs ?? 5000)) {
      return reply.code(400).send({ decision: 'REJECT', reason_code: 'FUTURE_TIMESTAMP' });
    }
    if (current - issued > (options.maxTaskAgeMs ?? 60_000)) {
      return reply.code(400).send({ decision: 'REJECT', reason_code: 'STALE_TIMESTAMP' });
    }
    if (envelope.type === 'agent-games.preflight.v1') {
      return reply.send({ ok: true, protocolVersion: 'v1' });
    }
    if (current >= Math.min(Date.parse(envelope.deadline_at), issued + 60_000)) {
      return reply.send({ decision: 'REJECT', reason_code: 'TIMEOUT' });
    }
    const state = states.get(request)!;
    state.task = envelope;
    state.raw = raw;
    const cutoff = Math.min(Date.parse(envelope.deadline_at), issued + 60_000);
    state.deadlineWall = Math.min(state.deadlineWall, cutoff);
    state.deadlineMono = Math.min(state.deadlineMono,
      state.receivedMono + cutoff - state.receivedWall, performance.now() + cutoff - current);
    clearTimeout(state.timer);
    state.timer = setTimeout(state.expire, Math.max(0, state.deadlineMono - performance.now()));
    if (state.controller.signal.aborted || performance.now() >= state.deadlineMono) {
      state.expire();
      return reply;
    }
    try {
      const result = await Promise.race([
        options.handler(envelope, raw, state.controller.signal), state.timeout,
      ]);
      return reply.sent ? reply : reply.send(result);
    } catch {
      return reply.sent ? reply : reply.code(500).send({ decision: 'REJECT', reason_code: 'INTERNAL_ERROR' });
    }
  });
  return app;
}
