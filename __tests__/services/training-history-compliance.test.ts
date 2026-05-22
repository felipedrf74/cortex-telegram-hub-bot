import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        /* skip dependency-only migrations in the narrow in-memory harness */
      }
    }
  }
}

import { computeTrailingCompliance } from '../../src/services/training-history';

const ASOF = new Date('2026-05-22T12:00:00.000Z');

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

function seedPlan(userId = 42): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (1, ?, 'Compliance Test', 'running', 4, '2026-05-04', '2026-06-01', 'active')
  `).run(userId);
  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number, focus)
    VALUES (11, 1, 3, 'build')
  `).run();
}

function seedSession(input: {
  id: number;
  day: string;
  status: string;
  completion?: boolean;
  duration?: number;
}): void {
  testDb.prepare(`
    INSERT INTO training_sessions
      (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
    VALUES (?, 11, 1, ?, 'running', 'Run', ?, ?)
  `).run(input.id, input.day, input.duration ?? 45, input.status);

  if (input.completion) {
    testDb.prepare(`
      INSERT INTO training_completions
        (session_id, plan_id, completed_at, duration_minutes)
      VALUES (?, 1, ?, ?)
    `).run(input.id, `${plannedDate(input.day)}T13:00:00.000Z`, input.duration ?? 45);
  }
}

function plannedDate(day: string): string {
  const offset: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };
  const date = new Date('2026-05-18T12:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + (offset[day] ?? 0));
  return date.toISOString().slice(0, 10);
}

describe('computeTrailingCompliance', () => {
  it('returns the cold-start fallback when there are zero planned sessions', () => {
    expect(computeTrailingCompliance(42, 14, { asOf: ASOF })).toBe(0.82);
  });

  it('computes 3 completed sessions out of 4 planned sessions as 0.75', () => {
    seedPlan();
    seedSession({ id: 1, day: 'Monday', status: 'completed' });
    seedSession({ id: 2, day: 'Tuesday', status: 'pending', completion: true });
    seedSession({ id: 3, day: 'Wednesday', status: 'completed' });
    seedSession({ id: 4, day: 'Thursday', status: 'pending' });

    expect(computeTrailingCompliance(42, 14, { asOf: ASOF })).toBe(0.75);
  });

  it('returns 0.0 when no planned sessions were completed', () => {
    seedPlan();
    seedSession({ id: 1, day: 'Monday', status: 'pending' });
    seedSession({ id: 2, day: 'Tuesday', status: 'skipped' });
    seedSession({ id: 3, day: 'Wednesday', status: 'pending' });
    seedSession({ id: 4, day: 'Thursday', status: 'pending' });

    expect(computeTrailingCompliance(42, 14, { asOf: ASOF })).toBe(0);
  });

  it('returns 1.0 when all planned sessions were completed', () => {
    seedPlan();
    seedSession({ id: 1, day: 'Monday', status: 'completed' });
    seedSession({ id: 2, day: 'Tuesday', status: 'completed' });
    seedSession({ id: 3, day: 'Wednesday', status: 'pending', completion: true });
    seedSession({ id: 4, day: 'Thursday', status: 'completed' });

    expect(computeTrailingCompliance(42, 14, { asOf: ASOF })).toBe(1);
  });

  it('ignores inactive/rest-like sessions and other users', () => {
    seedPlan();
    seedSession({ id: 1, day: 'Monday', status: 'completed' });
    seedSession({ id: 2, day: 'Tuesday', status: 'dropped' });

    testDb.prepare(`
      INSERT INTO fitness_training_plans
        (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (2, 99, 'Other User', 'running', 4, '2026-05-04', '2026-06-01', 'active')
    `).run();
    testDb.prepare(`INSERT INTO training_weeks (id, plan_id, week_number) VALUES (22, 2, 3)`).run();
    testDb.prepare(`
      INSERT INTO training_sessions
        (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (99, 22, 2, 'Monday', 'running', 'Other', 45, 'pending')
    `).run();

    expect(computeTrailingCompliance(42, 14, { asOf: ASOF })).toBe(1);
  });
});
