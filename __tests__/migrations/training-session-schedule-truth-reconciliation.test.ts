import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationFile } from '../../src/services/migration-runner';

const MIGRATION = '255_training_session_schedule_truth_reconciliation.sql';
const RETIRED_MIGRATION = '136_training_session_schedule_truth.sql';

describe('Training session schedule truth reconciliation migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function createTrainingSessions(withHistoricalColumns = false) {
    db.exec(`
      CREATE TABLE training_sessions (
        id INTEGER PRIMARY KEY,
        plan_id INTEGER NOT NULL
        ${withHistoricalColumns ? `,
        scheduled_start_at TEXT,
        scheduled_end_at TEXT,
        schedule_status TEXT,
        schedule_reason_code TEXT` : ''}
      );
    `);
  }

  it('adds canonical schedule truth to a fresh schema and enforces valid statuses', () => {
    createTrainingSessions();
    applyMigrationFile(db, MIGRATION);

    const columns = db.prepare('PRAGMA table_info(training_sessions)').all()
      .map((row: any) => row.name);
    expect(columns).toEqual(expect.arrayContaining([
      'scheduled_start_at',
      'scheduled_end_at',
      'schedule_status',
      'schedule_reason_code',
    ]));
    expect(() => db.prepare(`
      INSERT INTO training_sessions (id, plan_id, schedule_status)
      VALUES (1, 10, 'invalid')
    `).run()).toThrow('invalid training_sessions.schedule_status');
    expect(db.prepare(`
      INSERT INTO training_sessions (id, plan_id, schedule_status)
      VALUES (1, 10, 'scheduled')
    `).run().changes).toBe(1);
  });

  it('records the canonical reconciliation without replaying historical columns', () => {
    createTrainingSessions(true);
    db.exec(`
      CREATE TABLE _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL UNIQUE,
        applied_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(RETIRED_MIGRATION);

    expect(() => applyMigrationFile(db, MIGRATION)).not.toThrow();
    expect(db.prepare(`
      SELECT filename FROM _migrations ORDER BY filename
    `).all()).toEqual([
      { filename: RETIRED_MIGRATION },
      { filename: MIGRATION },
    ]);
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_training_sessions_schedule_truth'
    `).get()).toEqual({ name: 'idx_training_sessions_schedule_truth' });
  });
});
