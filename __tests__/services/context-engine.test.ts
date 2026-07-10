/**
 * Tests for src/services/context-engine.ts
 *
 * Validates the daily context builder, cache invalidation, the token-budget
 * cap, and resilience when sub-system queries fail (calendar, training,
 * readiness — all should degrade gracefully).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    }
  }
  // Migration 042 added FOREIGN KEY (user_id) REFERENCES users(id) on the
  // unified_* tables. Tests insert with arbitrary user IDs (7, 11, 42, etc),
  // so we pre-seed user rows here. AUTOINCREMENT means we explicitly assign
  // both id and telegram_id (which is NOT NULL UNIQUE).
  const seedUser = db.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)');
  for (let i = 1; i <= 1000; i++) seedUser.run(i, i);
}

let testDb: Database.Database;
const mockGoogleGetEvents = vi.fn().mockResolvedValue([]);
const mockOutlookGetEvents = vi.fn().mockResolvedValue([]);
const mockIsGoogleCalendarConfigured = vi.fn(() => false);
const mockIsOutlookCalendarConfigured = vi.fn(() => false);
const mockOauthIsConnected = vi.fn(() => false);

vi.mock('../../src/services/database', () => ({ getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/google-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGoogleGetEvents(...args),
  isGoogleCalendarConfigured: (...args: unknown[]) => mockIsGoogleCalendarConfigured(...args),
}));
vi.mock('../../src/services/outlook-calendar', () => ({
  getEvents: (...args: unknown[]) => mockOutlookGetEvents(...args),
  isOutlookCalendarConfigured: (...args: unknown[]) => mockIsOutlookCalendarConfigured(...args),
}));
vi.mock('../../src/services/oauth-store', () => ({
  isConnected: (...args: unknown[]) => mockOauthIsConnected(...args),
}));
vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: vi.fn(() => null),
  getCurrentWeek: vi.fn(() => null),
  getSessionsForWeek: vi.fn(() => []),
  getActivePlanSummary: vi.fn(() => null),
}));

import {
  buildDailyContext,
  getDailyContext,
  getDailyContextWithStatus,
  invalidateContextCache,
  buildContextForAllUsers,
  _resetContextCacheForTests,
} from '../../src/services/context-engine';
import { upsertTask } from '../../src/services/task-store/unified-task-store';
import { NormalizedTask } from '../../src/services/task-store/types';

const USER_ID = 99;

function makeTask(overrides: Partial<NormalizedTask> = {}): NormalizedTask {
  return {
    provider: 'nexus',
    externalId: `ext_${Math.random().toString(36).slice(2, 10)}`,
    title: 'Test task',
    status: 'pending',
    priority: 2,
    ...overrides,
  };
}

beforeEach(() => {
  testDb = createTestDb();
  applyMigrations(testDb);
  _resetContextCacheForTests();
  mockGoogleGetEvents.mockReset();
  mockOutlookGetEvents.mockReset();
  mockIsGoogleCalendarConfigured.mockReset();
  mockIsOutlookCalendarConfigured.mockReset();
  mockOauthIsConnected.mockReset();
  mockGoogleGetEvents.mockResolvedValue([]);
  mockOutlookGetEvents.mockResolvedValue([]);
  mockIsGoogleCalendarConfigured.mockReturnValue(false);
  mockIsOutlookCalendarConfigured.mockReturnValue(false);
  mockOauthIsConnected.mockReturnValue(false);
});

afterEach(() => {
  mockGoogleGetEvents.mockReset();
  mockOutlookGetEvents.mockReset();
  mockIsGoogleCalendarConfigured.mockReset();
  mockIsOutlookCalendarConfigured.mockReset();
  mockOauthIsConnected.mockReset();
});

// ── buildDailyContext ──────────────────────────────────────────────

describe('buildDailyContext', () => {
  it('returns an empty string for a user with no data', async () => {
    const summary = await buildDailyContext(USER_ID);
    expect(summary).toBe('');
  });

  it('includes a TASKS section when the user has pending tasks', async () => {
    upsertTask(USER_ID, makeTask({ title: 'Write spec' }));
    upsertTask(USER_ID, makeTask({ title: 'Review PR' }));

    const summary = await buildDailyContext(USER_ID);
    expect(summary).toMatch(/TASKS:/);
    expect(summary).toMatch(/2 total pending/);
  });

  it('lists tasks due today by name', async () => {
    const today = testDb.prepare("SELECT date('now') AS d").get() as { d: string };
    upsertTask(USER_ID, makeTask({ title: 'Standup', dueDate: today.d, priority: 4 }));
    upsertTask(USER_ID, makeTask({ title: 'Lunch with X', dueDate: today.d, priority: 1 }));

    const summary = await buildDailyContext(USER_ID);
    expect(summary).toMatch(/Due today: .*Standup/);
    expect(summary).toMatch(/Lunch with X/);
  });

  it('reports overdue counts', async () => {
    upsertTask(USER_ID, makeTask({ title: 'Old', dueDate: '2020-01-01' }));
    const summary = await buildDailyContext(USER_ID);
    expect(summary).toMatch(/1 overdue/);
  });

  it('includes a READINESS section when a score exists for today', async () => {
    testDb.prepare(
      `INSERT INTO readiness_scores (user_id, date, score, recommendation)
       VALUES (?, date('now'), ?, ?)`,
    ).run(USER_ID, 75, 'Train hard');

    upsertTask(USER_ID, makeTask({ title: 'Anchor task' })); // Force the build to find data
    const summary = await buildDailyContext(USER_ID);
    expect(summary).toMatch(/READINESS: 75\/100 \(green\)/);
    expect(summary).toMatch(/Train hard/);
  });

  it('classifies readiness 50 as yellow', async () => {
    testDb.prepare(
      `INSERT INTO readiness_scores (user_id, date, score, recommendation)
       VALUES (?, date('now'), ?, ?)`,
    ).run(USER_ID, 50, 'Easy day');
    upsertTask(USER_ID, makeTask({ title: 'Anchor' }));

    const summary = await buildDailyContext(USER_ID);
    expect(summary).toMatch(/READINESS: 50\/100 \(yellow\)/);
  });

  it('classifies readiness 30 as red', async () => {
    testDb.prepare(
      `INSERT INTO readiness_scores (user_id, date, score, recommendation)
       VALUES (?, date('now'), ?, ?)`,
    ).run(USER_ID, 30, 'Rest');
    upsertTask(USER_ID, makeTask({ title: 'Anchor' }));

    const summary = await buildDailyContext(USER_ID);
    expect(summary).toMatch(/\(red\)/);
  });

  it('persists the summary to daily_context_cache', async () => {
    upsertTask(USER_ID, makeTask({ title: 'Persist me' }));
    await buildDailyContext(USER_ID);

    // NOTE: we do NOT filter by `date = date('now')` here. `buildDailyContext`
    // writes the cache row with `todayString()` — which uses the
    // Europe/Lisbon timezone via `date-parser.now()`. SQLite's `date('now')`
    // uses UTC. Between 00:00 and 01:00 local time (Lisbon DST) these
    // produce different dates and the filter would drop the row the
    // service just wrote. The test's intent is "a cache row exists for
    // this user after a build" — dropping the date filter preserves that
    // intent without encoding the cross-midnight flake. Each test case
    // runs on a fresh in-memory DB so there's only one row per user.
    const row = testDb.prepare(
      'SELECT context_summary FROM daily_context_cache WHERE user_id = ?',
    ).get(USER_ID) as { context_summary: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.context_summary).toMatch(/TASKS/);
  });

  it('keeps the summary under the 1500-char (~500 token) budget', async () => {
    // Create a lot of tasks and verify the summary still fits
    for (let i = 0; i < 200; i++) {
      upsertTask(USER_ID, makeTask({ title: `Task with reasonably long title #${i}`, externalId: `ext_${i}` }));
    }

    const summary = await buildDailyContext(USER_ID);
    expect(summary.length).toBeLessThanOrEqual(1500);
  });
});

// ── getDailyContext / cache ────────────────────────────────────────

describe('getDailyContext cache', () => {
  it('returns empty string when no cache entry exists', () => {
    expect(getDailyContext(USER_ID)).toBe('');
  });

  it('distinguishes an unmaterialized empty cache from a failed lookup', () => {
    expect(getDailyContextWithStatus(USER_ID)).toMatchObject({
      status: 'empty',
      context: '',
      reasonCode: 'daily_context_not_materialized',
    });

    testDb.close();
    expect(getDailyContextWithStatus(USER_ID)).toMatchObject({
      status: 'failed',
      context: '',
      reasonCode: 'daily_context_read_failed',
    });
  });

  it('projects only present operational sections and leaves absence unknown', async () => {
    upsertTask(USER_ID, makeTask({ title: 'Projected task' }));
    await buildDailyContext(USER_ID);

    const result = getDailyContextWithStatus(USER_ID);
    expect(result.status).toBe('available');
    expect(result.sourceProjections).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'tasks', status: 'available' }),
      expect.objectContaining({ source: 'calendar', status: 'unknown', reasonCode: 'daily_context_projection_absent' }),
    ]));
  });

  it('returns the cached summary after a build', async () => {
    upsertTask(USER_ID, makeTask({ title: 'Cached' }));
    await buildDailyContext(USER_ID);

    const cached = getDailyContext(USER_ID);
    expect(cached).toMatch(/TASKS/);
  });

  it('invalidateContextCache drops the cache row', async () => {
    upsertTask(USER_ID, makeTask({ title: 'Volatile' }));
    await buildDailyContext(USER_ID);
    expect(getDailyContext(USER_ID)).not.toBe('');

    invalidateContextCache(USER_ID);
    expect(getDailyContext(USER_ID)).toBe('');
  });

  it('global invalidateContextCache drops cached rows for today', async () => {
    upsertTask(USER_ID, makeTask({ title: 'Mine' }));
    upsertTask(USER_ID + 1, makeTask({ title: 'Other' }));
    await buildDailyContext(USER_ID);
    await buildDailyContext(USER_ID + 1);

    invalidateContextCache();

    expect(getDailyContext(USER_ID)).toBe('');
    expect(getDailyContext(USER_ID + 1)).toBe('');
  });

  it('cache is per-user', async () => {
    upsertTask(USER_ID, makeTask({ title: 'Mine' }));
    await buildDailyContext(USER_ID);

    expect(getDailyContext(USER_ID + 1)).toBe('');
    expect(getDailyContext(USER_ID)).not.toBe('');
  });

  it('cache is isolated by tenant for the same user', async () => {
    upsertTask(USER_ID, makeTask({ title: 'Tenant scoped' }));
    await buildDailyContext(USER_ID, 901);

    expect(getDailyContext(USER_ID, 902)).toBe('');
    expect(getDailyContext(USER_ID, 901)).toMatch(/TASKS/);

    invalidateContextCache(USER_ID, 902);
    expect(getDailyContext(USER_ID, 901)).toMatch(/TASKS/);

    invalidateContextCache(USER_ID, 901);
    expect(getDailyContext(USER_ID, 901)).toBe('');
  });
});

// ── buildContextForAllUsers ────────────────────────────────────────

describe('buildContextForAllUsers', () => {
  it('returns built/failed counts and processes every user', async () => {
    upsertTask(1, makeTask({ title: 'A' }));
    upsertTask(2, makeTask({ title: 'B' }));
    upsertTask(3, makeTask({ title: 'C' }));

    const stats = await buildContextForAllUsers([1, 2, 3]);
    expect(stats.built).toBe(3);
    expect(stats.failed).toBe(0);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('handles an empty user list', async () => {
    const stats = await buildContextForAllUsers([]);
    expect(stats.built).toBe(0);
    expect(stats.failed).toBe(0);
  });
});
