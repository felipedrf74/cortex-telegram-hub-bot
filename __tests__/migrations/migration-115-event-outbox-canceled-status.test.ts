import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration115 = resolve(__dirname, '../../migrations/115_event_outbox_canceled_status.sql');

function createOld114EventOutbox(db: Database.Database): void {
  db.exec(`
    CREATE TABLE event_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER,
      source_skill TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL DEFAULT 1,
      event_version INTEGER NOT NULL DEFAULT 1,
      schema_version TEXT NOT NULL DEFAULT 'event-v1',
      payload_json TEXT NOT NULL DEFAULT '{}',
      privacy_classification TEXT NOT NULL DEFAULT 'internal',
      idempotency_key TEXT NOT NULL,
      correlation_id TEXT,
      causation_id TEXT,
      request_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0,
      not_before TEXT NOT NULL DEFAULT (datetime('now')),
      locked_at TEXT,
      lock_owner TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      last_error TEXT
    );
    CREATE UNIQUE INDEX idx_event_outbox_idempotency
      ON event_outbox(tenant_id, COALESCE(user_id, 0), idempotency_key);
  `);
}

function insertEvent(db: Database.Database, eventId: string, status = 'pending'): void {
  db.prepare(`
    INSERT INTO event_outbox (
      event_id,
      tenant_id,
      user_id,
      source_skill,
      event_type,
      entity_type,
      entity_id,
      idempotency_key,
      status
    ) VALUES (?, 7, 7, 'training', 'training.session.updated', 'training_session', ?, ?, ?)
  `).run(eventId, eventId, eventId, status);
}

describe('migration 115 event_outbox canceled status', () => {
  it('rebuilds an already-migrated 114 table so canceled event rows are valid', () => {
    const db = new Database(':memory:');
    try {
      createOld114EventOutbox(db);
      insertEvent(db, 'before-115');

      expect(() => insertEvent(db, 'canceled-before-115', 'canceled')).toThrow(/CHECK constraint failed/);

      db.exec(readFileSync(migration115, 'utf8'));
      db.prepare("UPDATE event_outbox SET status = 'canceled' WHERE event_id = ?").run('before-115');
      insertEvent(db, 'canceled-after-115', 'canceled');

      const rows = db.prepare('SELECT event_id, status FROM event_outbox ORDER BY sequence').all() as Array<{ event_id: string; status: string }>;
      expect(rows).toEqual([
        { event_id: 'before-115', status: 'canceled' },
        { event_id: 'canceled-after-115', status: 'canceled' },
      ]);

      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_outbox'").all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining([
        'idx_event_outbox_idempotency',
        'idx_event_outbox_status_due',
        'idx_event_outbox_scope_created',
      ]));
    } finally {
      db.close();
    }
  });
});
