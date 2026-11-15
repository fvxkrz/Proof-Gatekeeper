import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { SQLiteStore } from '../src/store.js';
import type { ReserveResult } from '../src/store.js';

const proof = `0x${'ab'.repeat(32)}`;
const otherProof = `0x${'cd'.repeat(32)}`;

function fixture(t: TestContext) {
  const scratch = tmpdir();
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'gatekeeper-store-test-'));
  const path = join(directory, 'replay.sqlite');
  const stores: SQLiteStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    path,
    open(filename = path) {
      const store = new SQLiteStore(filename);
      stores.push(store);
      return store;
    },
  };
}

function freshLease(result: ReserveResult): string {
  assert.equal(result.kind, 'fresh');
  if (result.kind !== 'fresh') throw new Error('expected fresh reservation');
  return result.lease;
}

test('retains a processing proof reservation after an abrupt worker crash without close', { timeout: 10000 }, async t => {
  const db = fixture(t);
  db.open().close();
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { tsImport } = await import('tsx/esm/api');
      const { SQLiteStore } = await tsImport(workerData.moduleUrl, workerData.moduleUrl);
      const store = new SQLiteStore(workerData.path);
      parentPort.postMessage(store.reserve('crashed-task', 'hash', workerData.proof, 1));
      process.exit(17); // Intentionally no close/checkpoint/complete.
    })().catch(error => { throw error; });
  `;
  const worker = new Worker(workerCode, {
    eval: true,
    workerData: { path: db.path, proof, moduleUrl: new URL('../src/store.ts', import.meta.url).href },
  });
  t.after(() => worker.terminate());
  const reservation = await new Promise<ReserveResult>((resolve, reject) => {
    let result: ReserveResult | undefined;
    worker.once('message', (message: ReserveResult) => { result = message; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 17 || !result) reject(new Error(`unexpected crash result ${code}`));
      else resolve(result);
    });
  });
  freshLease(reservation);
  const recovered = db.open();
  assert.deepEqual(recovered.reserve('crashed-task', 'hash', proof, 9999999999999), { kind: 'processing' });
  assert.deepEqual(recovered.reserve('different-task', 'hash', proof, 9999999999999), { kind: 'reused' });
});

test('refuses a symlink database instead of writing through to another file', t => {
  const db = fixture(t);
  db.open().close();
  const link = join(db.directory, 'linked.sqlite');
  symlinkSync(db.path, link);
  assert.throws(() => db.open(link), { code: 'ELOOP' });
});

test('uses WAL/full-sync and fails closed under bounded SQLite write contention', t => {
  const db = fixture(t);
  const store = db.open();
  // These are connection-local safety settings, not just SQLite defaults on a probe.
  const connection = (store as unknown as { db: Database.Database }).db;
  assert.equal(connection.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(connection.pragma('synchronous', { simple: true }), 2);
  assert.equal(connection.pragma('busy_timeout', { simple: true }), 1000);
  freshLease(store.reserve('old-task', 'old-hash', otherProof, 0));
  const locker = new Database(db.path);
  try {
    assert.equal(locker.pragma('journal_mode', { simple: true }), 'wal');
    locker.exec('BEGIN IMMEDIATE');
    const start = performance.now();
    assert.throws(() => store.reserve('task-1', 'hash-1', proof, 1), { code: 'SQLITE_BUSY' });
    assert.ok(performance.now() - start < 3000, 'busy timeout must be bounded');
    assert.throws(() => store.complete('old-task', 'old-hash', 'wrong-lease', '{}'), { code: 'SQLITE_BUSY' });
  } finally {
    if (locker.inTransaction) locker.exec('ROLLBACK');
    locker.close();
  }
  const lease = freshLease(store.reserve('task-1', 'hash-1', proof, 2));
  store.complete('task-1', 'hash-1', lease, '{}');
  store.close();
  const reopened = db.open();
  assert.deepEqual(reopened.reserve('task-1', 'hash-1', proof, 3), { kind: 'cached', body: '{}' });
  const probe = new Database(db.path);
  try {
    assert.equal(probe.pragma('journal_mode', { simple: true }), 'wal');
  } finally {
    probe.close();
  }
});

test('creates nested private directories and a mode-0600 database', t => {
  const db = fixture(t);
  const path = join(db.directory, 'private', 'nested', 'replay.sqlite');
  const store = db.open(path);
  freshLease(store.reserve('task-1', 'hash-1', proof, 1));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(`${path}-wal`).mode & 0o777, 0o600);
  assert.equal(statSync(`${path}-shm`).mode & 0o777, 0o600);
  assert.equal(statSync(join(db.directory, 'private')).mode & 0o777, 0o700);
  assert.equal(statSync(join(db.directory, 'private', 'nested')).mode & 0o777, 0o700);
});

test('canonicalizes proof references to lowercase across connections and restarts', t => {
  const db = fixture(t);
  const first = db.open();
  freshLease(first.reserve('task-1', 'hash-1', proof.toUpperCase(), 1));
  assert.deepEqual(db.open().reserve('task-2', 'hash-2', proof, 2), { kind: 'reused' });
  first.close();
  assert.deepEqual(db.open().reserve('task-3', 'hash-3', proof.toUpperCase(), 3), { kind: 'reused' });
  const probe = new Database(db.path);
  try {
    assert.deepEqual(probe.prepare('SELECT proof_ref FROM reservations').all(), [{ proof_ref: proof }]);
  } finally {
    probe.close();
  }
});

test('atomically consumes a proof once across two file-backed connections, including rejected tasks', { timeout: 20000 }, async t => {
  const db = fixture(t);
  db.open().close();
  const barrier = new SharedArrayBuffer(4);
  let ready = 0;
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { tsImport } = await import('tsx/esm/api');
      const { SQLiteStore } = await tsImport(workerData.moduleUrl, workerData.moduleUrl);
      const store = new SQLiteStore(workerData.path);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      const result = store.reserve(workerData.task, 'hash', workerData.proof, 1);
      store.close();
      parentPort.postMessage({ result });
    })().catch(error => { throw error; });
  `;
  const contenders = await Promise.all(['task-a', 'task-b'].map(task => new Promise<{ task: string; result: ReserveResult }>((resolve, reject) => {
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { path: db.path, barrier, proof, task, moduleUrl: new URL('../src/store.ts', import.meta.url).href },
    });
    t.after(() => worker.terminate());
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
    worker.on('message', (message: { ready?: boolean; result?: ReserveResult }) => {
      if (message.ready && ++ready === 2) {
        Atomics.store(new Int32Array(barrier), 0, 1);
        Atomics.notify(new Int32Array(barrier), 0);
      }
      if (message.result) resolve({ task, result: message.result });
    });
  })));
  assert.deepEqual(contenders.map(item => item.result.kind).sort(), ['fresh', 'reused']);
  const winner = contenders.find(item => item.result.kind === 'fresh');
  assert.ok(winner);
  const loser = contenders.find(item => item.result.kind === 'reused');
  assert.ok(loser);
  const store = db.open();
  assert.deepEqual(store.reserve('third-task', 'hash', proof, 2), { kind: 'reused' });
  freshLease(store.reserve(loser.task, 'different-hash', otherProof, 2));
  store.complete(winner.task, 'hash', freshLease(winner.result), '{"decision":"REJECT"}');
  assert.deepEqual(store.reserve('fourth-task', 'hash', proof, 3), { kind: 'reused' });
  store.close();
  assert.deepEqual(db.open().reserve('fifth-task', 'hash', proof, 9999999999999), { kind: 'reused' });
});

test('only the owned processing lease can complete, never a stale or changed request', t => {
  const store = fixture(t).open();
  const lease = freshLease(store.reserve('task-1', 'hash-1', proof, 1));
  for (const [task, hash, token] of [
    ['task-1', 'hash-1', 'wrong-lease'],
    ['task-1', 'wrong-hash', lease],
    ['unknown-task', 'hash-1', lease],
  ] as const) {
    assert.throws(() => store.complete(task, hash, token, '{"wrong":true}'), /lease|reservation/i);
    assert.deepEqual(store.reserve('task-1', 'hash-1', proof, 2), { kind: 'processing' });
  }
  const body = '{"decision":"APPROVE"}';
  store.complete('task-1', 'hash-1', lease, body);
  assert.throws(() => store.complete('task-1', 'hash-1', lease, '{"overwrite":true}'), /lease|reservation/i);
  assert.deepEqual(store.reserve('task-1', 'hash-1', proof, 3), { kind: 'cached', body });
  assert.deepEqual(store.reserve('task-1', 'wrong-hash', proof, 4), { kind: 'conflict' });
});

test('caches completed raw response bytes across a restart without repeated side effects', t => {
  const db = fixture(t);
  const store = db.open();
  const body = '{ "decision" : "REJECT", "reason_code": "PROOF_EXPIRED", "note": "\u2603" }\n';
  let externalEffects = 0;
  const run = (connection: SQLiteStore): string => {
    const result = connection.reserve('task-1', 'hash-1', proof, 1);
    if (result.kind === 'cached') return result.body;
    const lease = freshLease(result);
    externalEffects += 1;
    connection.complete('task-1', 'hash-1', lease, body);
    return body;
  };
  assert.equal(run(store), body);
  assert.equal(run(store), body);
  store.close();
  assert.equal(run(db.open()), body);
  assert.equal(externalEffects, 1);
});

test('returns conflict for a changed task body without overwriting or consuming another proof', t => {
  const store = fixture(t).open();
  freshLease(store.reserve('task-1', 'hash-1', proof, 1));
  assert.deepEqual(store.reserve('task-1', 'changed', otherProof, 2), { kind: 'conflict' });
  assert.deepEqual(store.reserve('task-1', 'hash-1', proof, 3), { kind: 'processing' });
  freshLease(store.reserve('task-2', 'hash-2', otherProof, 4));
});

test('keeps the identical task processing across retries and reopening', t => {
  const db = fixture(t);
  const store = db.open();
  freshLease(store.reserve('task-1', 'hash-1', proof, 1));
  assert.deepEqual(store.reserve('task-1', 'hash-1', proof, 2), { kind: 'processing' });
  store.close();
  const reopened = db.open();
  assert.deepEqual(reopened.reserve('task-1', 'hash-1', proof, 9999999999999), { kind: 'processing' });
});

test('creates file-backed fresh reservations with distinct opaque leases', t => {
  const db = fixture(t);
  const store = db.open();
  const first = freshLease(store.reserve('task-1', 'hash-1', proof, 1));
  const second = freshLease(store.reserve('task-2', 'hash-2', otherProof, 2));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
  assert.ok(statSync(db.path).isFile());
});
