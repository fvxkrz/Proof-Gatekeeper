import { randomBytes } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type ReserveResult =
  | { kind: 'fresh'; lease: string }
  | { kind: 'cached'; body: string }
  | { kind: 'conflict' }
  | { kind: 'reused' }
  | { kind: 'processing' };

/**
 * File-backed replay ledger (:memory: is for isolated tests only).
 * Proof references never expire; crashed processing reservations are not reclaimed.
 */
export class SQLiteStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600));
    }
    this.db = new Database(path, { timeout: 1000 });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS reservations (
      task_id TEXT PRIMARY KEY NOT NULL,
      body_hash TEXT NOT NULL,
      proof_ref TEXT NOT NULL UNIQUE,
      lease TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
      body TEXT
    ) STRICT`);
  }

  reserve(taskId: string, bodyHash: string, proofRef: string, nowMs: number): ReserveResult {
    const canonicalProofRef = proofRef.toLowerCase();
    return this.db.transaction((): ReserveResult => {
      const existing = this.db.prepare<[string], { body_hash: string; status: string; body: string | null }>(
        'SELECT body_hash, status, body FROM reservations WHERE task_id = ?',
      ).get(taskId);
      if (existing) {
        if (existing.body_hash !== bodyHash) return { kind: 'conflict' };
        if (existing.status === 'completed' && existing.body !== null) return { kind: 'cached', body: existing.body };
        return { kind: 'processing' };
      }
      if (this.db.prepare('SELECT 1 FROM reservations WHERE proof_ref = ?').get(canonicalProofRef)) {
        return { kind: 'reused' };
      }
      const lease = randomBytes(32).toString('hex');
      this.db.prepare(`INSERT INTO reservations
        (task_id, body_hash, proof_ref, lease, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(taskId, bodyHash, canonicalProofRef, lease, nowMs);
      return { kind: 'fresh', lease };
    }).immediate();
  }

  complete(taskId: string, bodyHash: string, lease: string, body: string): void {
    const result = this.db.prepare(`UPDATE reservations SET status = 'completed', body = ?
      WHERE task_id = ? AND body_hash = ? AND lease = ? AND status = 'processing'`)
      .run(body, taskId, bodyHash, lease);
    if (result.changes !== 1) throw new Error('Invalid or stale reservation lease');
  }

  close(): void {
    this.db.close();
  }
}
