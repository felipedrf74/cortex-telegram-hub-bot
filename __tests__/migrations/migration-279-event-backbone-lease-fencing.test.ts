import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const upSql = readFileSync(resolve(__dirname, '../../migrations/279_event_backbone_lease_fencing.sql'), 'utf8');
const downSql = readFileSync(resolve(__dirname, '../../migrations/down/279_event_backbone_lease_fencing.sql'), 'utf8');

function createLegacyQueueDb(status: 'pending' | 'failed' | 'processing' = 'pending'): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE event_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      not_before TEXT NOT NULL DEFAULT (datetime('now')),
      locked_at TEXT,
      lock_owner TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      last_error TEXT
    );
    CREATE TABLE background_jobs (
      job_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      not_before TEXT NOT NULL DEFAULT (datetime('now')),
      locked_at TEXT,
      lock_owner TEXT,
      priority INTEGER NOT NULL DEFAULT 50,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT
    );
  `);
  db.prepare(`
    INSERT INTO event_outbox (event_id, status, not_before, created_at)
    VALUES ('mixed-version-event', ?, datetime('now', '-1 minute'), datetime('now', '-2 minutes'))
  `).run(status);
  db.prepare(`
    INSERT INTO background_jobs (job_id, status, not_before, created_at)
    VALUES ('mixed-version-job', ?, datetime('now', '-1 minute'), datetime('now', '-2 minutes'))
  `).run(status);
  return db;
}

/** Exact claim SQL used by the c4195818 predecessor event worker. */
function predecessorClaimEvent(db: Database.Database): unknown[] {
  return db.prepare(`
    UPDATE event_outbox
    SET status = 'processing',
        attempts = attempts + 1,
        locked_at = datetime('now'),
        lock_owner = ?
    WHERE sequence IN (
      SELECT sequence
      FROM event_outbox
      WHERE (
          status IN ('pending', 'failed')
          AND not_before <= datetime('now')
        )
        OR (
          status = 'processing'
          AND locked_at IS NOT NULL
          AND locked_at <= datetime('now', ?)
        )
      ORDER BY CASE WHEN status = 'processing' THEN 1 ELSE 0 END, created_at ASC, sequence ASC
      LIMIT ?
    )
    RETURNING *
  `).all('predecessor-event-worker', '-15 minutes', 1);
}

/** Exact claim SQL used by the c4195818 predecessor background-job worker. */
function predecessorClaimJob(db: Database.Database): unknown[] {
  return db.prepare(`
    UPDATE background_jobs
    SET status = 'processing',
        attempts = attempts + 1,
        locked_at = datetime('now'),
        lock_owner = ?,
        started_at = COALESCE(started_at, datetime('now'))
    WHERE job_id IN (
      SELECT job_id
      FROM background_jobs
      WHERE (
        (
          status IN ('pending', 'failed')
          AND not_before <= datetime('now')
        )
        OR (
          status = 'processing'
          AND locked_at IS NOT NULL
          AND locked_at <= datetime('now', ?)
        )
      )
      ORDER BY CASE WHEN status = 'processing' THEN 1 ELSE 0 END, priority ASC, created_at ASC
      LIMIT ?
    )
    RETURNING *
  `).all('predecessor-job-worker', '-15 minutes', 1);
}

function predecessorCompleteEvent(db: Database.Database): number {
  return db.prepare(`
    UPDATE event_outbox
       SET status = 'processed',
           processed_at = datetime('now'),
           locked_at = NULL,
           lock_owner = NULL,
           last_error = NULL
     WHERE event_id = 'mixed-version-event'
       AND status != 'canceled'
  `).run().changes;
}

function predecessorFailEvent(db: Database.Database): number {
  return db.prepare(`
    UPDATE event_outbox
       SET status = 'failed',
           not_before = datetime('now', '+30 seconds'),
           locked_at = NULL,
           lock_owner = NULL,
           last_error = 'predecessor failure'
     WHERE event_id = 'mixed-version-event'
       AND status != 'canceled'
  `).run().changes;
}

function predecessorCompleteJob(db: Database.Database): number {
  return db.prepare(`
    UPDATE background_jobs
       SET status = 'completed',
           completed_at = datetime('now'),
           locked_at = NULL,
           lock_owner = NULL,
           last_error = NULL
     WHERE job_id = 'mixed-version-job'
       AND status != 'canceled'
  `).run().changes;
}

function predecessorFailJob(db: Database.Database): number {
  return db.prepare(`
    UPDATE background_jobs
       SET status = 'failed',
           not_before = datetime('now', '+30 seconds'),
           locked_at = NULL,
           lock_owner = NULL,
           last_error = 'predecessor failure'
     WHERE job_id = 'mixed-version-job'
  `).run().changes;
}

describe('migration 279 event backbone lease fencing', () => {
  it('adds fencing tokens and derives a conservative expiry for existing processing rows', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE event_outbox (
        event_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        not_before TEXT,
        locked_at TEXT,
        lock_owner TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT,
        last_error TEXT
      );
      CREATE TABLE background_jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        not_before TEXT,
        locked_at TEXT,
        lock_owner TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        last_error TEXT
      );
      INSERT INTO event_outbox (event_id, status, locked_at, lock_owner, created_at) VALUES
        ('processing-event', 'processing', '2000-01-01 10:00:00', 'legacy-event-worker', '2000-01-01 09:00:00'),
        ('pending-event', 'pending', NULL, NULL, '2000-01-01 09:00:00');
      INSERT INTO background_jobs (job_id, status, locked_at, lock_owner, created_at) VALUES
        ('processing-job', 'processing', '2000-01-01 11:00:00', 'legacy-job-worker', '2000-01-01 09:00:00'),
        ('pending-job', 'pending', NULL, NULL, '2000-01-01 09:00:00');
    `);

    db.exec(upSql);

    const eventColumns = db.pragma('table_info(event_outbox)') as Array<{ name: string }>;
    const jobColumns = db.pragma('table_info(background_jobs)') as Array<{ name: string }>;
    expect(eventColumns.map(({ name }) => name)).toEqual(expect.arrayContaining(['fencing_token', 'lease_expires_at']));
    expect(jobColumns.map(({ name }) => name)).toEqual(expect.arrayContaining(['fencing_token', 'lease_expires_at']));
    expect(db.prepare(`
      SELECT event_id AS eventId, fencing_token AS fencingToken,
             lease_expires_at > datetime('now', '+14 minutes') AS hasFullGrace
        FROM event_outbox ORDER BY event_id
    `).all()).toEqual([
      { eventId: 'pending-event', fencingToken: null, hasFullGrace: null },
      { eventId: 'processing-event', fencingToken: null, hasFullGrace: 1 },
    ]);
    expect(db.prepare(`
      SELECT job_id AS jobId, fencing_token AS fencingToken,
             lease_expires_at > datetime('now', '+14 minutes') AS hasFullGrace
        FROM background_jobs ORDER BY job_id
    `).all()).toEqual([
      { jobId: 'pending-job', fencingToken: null, hasFullGrace: null },
      { jobId: 'processing-job', fencingToken: null, hasFullGrace: 1 },
    ]);

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'idx_event_outbox_lease_expiry',
      'idx_background_jobs_lease_expiry',
    ]));
    const triggers = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(triggers.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'trg_event_outbox_fenced_claim_transition',
      'trg_event_outbox_fenced_terminal_transition',
      'trg_event_outbox_terminal_tombstone',
      'trg_background_jobs_fenced_claim_transition',
      'trg_background_jobs_fenced_terminal_transition',
      'trg_background_jobs_terminal_tombstone',
    ]));

    db.prepare(`
      UPDATE event_outbox
         SET fencing_token = 'new-event-token',
             lease_expires_at = datetime('now', '+15 minutes')
       WHERE event_id = 'processing-event'
    `).run();
    expect(() => db.prepare(`
      UPDATE event_outbox
         SET status = 'processed', locked_at = NULL, lock_owner = NULL
       WHERE event_id = 'processing-event' AND status != 'canceled'
    `).run()).toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);

    db.prepare(`
      UPDATE background_jobs
         SET fencing_token = 'new-job-token',
             lease_expires_at = datetime('now', '+15 minutes')
       WHERE job_id = 'processing-job'
    `).run();
    expect(() => db.prepare(`
      UPDATE background_jobs
         SET status = 'completed', locked_at = NULL, lock_owner = NULL
       WHERE job_id = 'processing-job' AND status != 'canceled'
    `).run()).toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);

    db.exec(downSql);
    expect((db.pragma('table_info(event_outbox)') as Array<{ name: string }>).map(({ name }) => name))
      .not.toContain('fencing_token');
    expect((db.pragma('table_info(background_jobs)') as Array<{ name: string }>).map(({ name }) => name))
      .not.toContain('fencing_token');
    expect((db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'").get() as { count: number }).count)
      .toBe(0);
    db.close();
  });

  it.each(['pending', 'failed'] as const)(
    'rejects exact predecessor claims of migrated %s rows in both queues',
    (status) => {
      const db = createLegacyQueueDb(status);
      db.exec(upSql);

      expect(() => predecessorClaimEvent(db)).toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
      expect(() => predecessorClaimJob(db)).toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
      expect(db.prepare(`
        SELECT status, lock_owner AS lockOwner, fencing_token AS fencingToken,
               lease_expires_at AS leaseExpiresAt
          FROM event_outbox WHERE event_id = 'mixed-version-event'
      `).get()).toEqual({
        status,
        lockOwner: null,
        fencingToken: null,
        leaseExpiresAt: null,
      });
      expect(db.prepare(`
        SELECT status, lock_owner AS lockOwner, fencing_token AS fencingToken,
               lease_expires_at AS leaseExpiresAt
          FROM background_jobs WHERE job_id = 'mixed-version-job'
      `).get()).toEqual({
        status,
        lockOwner: null,
        fencingToken: null,
        leaseExpiresAt: null,
      });
      db.close();
    },
  );

  it('preserves the terminal-write grace for tokenless workers already processing at migration time', () => {
    const db = createLegacyQueueDb('processing');
    db.exec(upSql);

    expect(db.prepare(`
      SELECT fencing_token AS fencingToken,
             lease_expires_at > datetime('now', '+14 minutes') AS hasFullGrace
        FROM event_outbox WHERE event_id = 'mixed-version-event'
    `).get()).toEqual({ fencingToken: null, hasFullGrace: 1 });
    expect(db.prepare(`
      SELECT fencing_token AS fencingToken,
             lease_expires_at > datetime('now', '+14 minutes') AS hasFullGrace
        FROM background_jobs WHERE job_id = 'mixed-version-job'
    `).get()).toEqual({ fencingToken: null, hasFullGrace: 1 });

    // Stronger claim fencing must not strand work that was already in flight
    // when migration 279 landed: its predecessor worker may finish exactly
    // once, but any later non-processing terminal rewrite is fenced.
    expect(predecessorCompleteEvent(db)).toBe(1);
    expect(predecessorCompleteJob(db)).toBe(1);
    expect(() => predecessorFailEvent(db)).toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
    expect(() => predecessorFailJob(db)).toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
    db.close();
  });

  it('protects cancel-replayed rows from late predecessor terminal writes in both queues', () => {
    const db = createLegacyQueueDb();
    db.exec(upSql);
    db.exec(`
      UPDATE event_outbox
         SET status = 'processing',
             attempts = attempts + 1,
             locked_at = datetime('now'),
             lock_owner = 'current-event-worker',
             fencing_token = 'current-event-token',
             lease_expires_at = datetime('now', '+15 minutes')
       WHERE event_id = 'mixed-version-event';
      UPDATE background_jobs
         SET status = 'processing',
             attempts = attempts + 1,
             locked_at = datetime('now'),
             lock_owner = 'current-job-worker',
             fencing_token = 'current-job-token',
             lease_expires_at = datetime('now', '+15 minutes'),
             started_at = datetime('now')
       WHERE job_id = 'mixed-version-job';

      UPDATE event_outbox
         SET status = 'canceled',
             processed_at = datetime('now'),
             locked_at = NULL,
             lock_owner = NULL,
             fencing_token = NULL,
             lease_expires_at = NULL
       WHERE event_id = 'mixed-version-event';
      UPDATE background_jobs
         SET status = 'canceled',
             completed_at = datetime('now'),
             locked_at = NULL,
             lock_owner = NULL,
             fencing_token = NULL,
             lease_expires_at = NULL
       WHERE job_id = 'mixed-version-job';

      UPDATE event_outbox
         SET status = 'pending',
             attempts = 0,
             not_before = datetime('now'),
             processed_at = NULL,
             last_error = NULL
       WHERE event_id = 'mixed-version-event';
      UPDATE background_jobs
         SET status = 'pending',
             attempts = 0,
             not_before = datetime('now'),
             completed_at = NULL,
             last_error = NULL
       WHERE job_id = 'mixed-version-job';
    `);

    expect(() => predecessorCompleteEvent(db)).toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
    expect(() => predecessorFailEvent(db)).toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
    expect(() => predecessorCompleteJob(db)).toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
    expect(() => predecessorFailJob(db)).toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
    expect(db.prepare(`
      SELECT status FROM event_outbox WHERE event_id = 'mixed-version-event'
    `).get()).toEqual({ status: 'pending' });
    expect(db.prepare(`
      SELECT status FROM background_jobs WHERE job_id = 'mixed-version-job'
    `).get()).toEqual({ status: 'pending' });
    db.close();
  });
});
