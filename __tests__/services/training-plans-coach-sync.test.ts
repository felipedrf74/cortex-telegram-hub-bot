import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
let tempDir: string;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

import {
  createPlan,
  createSession,
  createWeek,
  getSessionById,
  syncSessionWithCoachRecommendation,
} from '../../src/services/training-plans';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on runtime-only services. The training
        // sync test only needs the base training tables.
      }
    }
  }
}

describe('Training plan coach sync', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-sync-'));
    testDb = new Database(path.join(tempDir, 'coach-sync.db'));
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('updates the linked training session when a workout moves to another day', () => {
    const plan = createPlan({
      user_id: 12,
      name: 'Half marathon',
      sport: 'running',
      duration_weeks: 4,
      start_date: '2026-04-13',
      end_date: '2026-05-11',
    });
    const week = createWeek({
      plan_id: plan.id,
      week_number: 1,
      focus: 'base',
    });
    const session = createSession({
      week_id: week.id,
      plan_id: plan.id,
      day_of_week: 'Tuesday',
      session_type: 'run',
      title: 'Intervals',
      duration_minutes: 60,
      calendar_event_id: 'evt-1',
      calendar_source: 'outlook',
    });

    const changed = syncSessionWithCoachRecommendation({
      eventId: 'evt-1',
      source: 'outlook',
      action: 'MODIFY',
      newTitle: 'Easy run 30min',
      newStart: '2026-04-15T17:30:00Z',
    });

    const updated = getSessionById(session.id);
    expect(changed).toBe(true);
    expect(updated?.title).toBe('Easy run 30min');
    expect(updated?.day_of_week).toBe('Wednesday');
  });
});
