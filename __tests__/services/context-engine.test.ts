/**
 * Tests for src/services/context-engine.ts
 *
 * Validates the daily context builder, cache invalidation, the token-budget
 * cap, and resilience when sub-system queries fail (calendar, training,
 * readiness — all should degrade gracefully).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import { afterEach } from 'vitest';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
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
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
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
import { captureDiscoveredIdea } from '../../src/services/content-workspace-capture';

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
  vi.stubEnv('CONTENT_WORKSPACE_V1_MODE', 'write');
  testDb = createMigratedTestDatabase();
  const seedUser = testDb.prepare('INSERT OR IGNORE INTO users (id, telegram_id) VALUES (?, ?)');
  for (let id = 1; id <= 1000; id += 1) seedUser.run(id, id);
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
  vi.unstubAllEnvs();
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

  it('isolates task counts and due-title context by tenant for the same user', async () => {
    const today = testDb.prepare("SELECT date('now') AS d").get() as { d: string };
    upsertTask(USER_ID, makeTask({ title: 'Tenant 901 private task', dueDate: today.d, priority: 2 }));
    upsertTask(USER_ID, makeTask({ title: 'Tenant 902 private task A', dueDate: today.d, priority: 2 }));
    upsertTask(USER_ID, makeTask({ title: 'Tenant 902 private task B', dueDate: today.d, priority: 3 }));
    testDb.prepare('UPDATE unified_tasks SET tenant_id = ? WHERE user_id = ? AND title = ?')
      .run(901, USER_ID, 'Tenant 901 private task');
    testDb.prepare("UPDATE unified_tasks SET tenant_id = 902 WHERE user_id = ? AND title LIKE 'Tenant 902 private task%'")
      .run(USER_ID);

    const tenant901 = await buildDailyContext(USER_ID, 901);
    const tenant902 = await buildDailyContext(USER_ID, 902);

    expect(tenant901).toContain('TASKS: 0 overdue, 1 due today, 1 total pending');
    expect(tenant901).toContain('Tenant 901 private task');
    expect(tenant901).not.toContain('Tenant 902 private task');
    expect(tenant902).toContain('TASKS: 0 overdue, 2 due today, 2 total pending');
    expect(tenant902).toContain('Tenant 902 private task A');
    expect(tenant902).toContain('Tenant 902 private task B');
    expect(tenant902).not.toContain('Tenant 901 private task');
  });

  it('keeps legacy unscoped tasks in the personal tenant and isolates both persisted caches', async () => {
    const today = testDb.prepare("SELECT date('now') AS d").get() as { d: string };
    upsertTask(USER_ID, makeTask({ title: 'Legacy personal task', dueDate: today.d, priority: 2 }));
    upsertTask(USER_ID, makeTask({ title: 'Tenant 901 scoped task', dueDate: today.d, priority: 3 }));
    testDb.prepare('UPDATE unified_tasks SET tenant_id = NULL WHERE user_id = ? AND title = ?')
      .run(USER_ID, 'Legacy personal task');
    testDb.prepare('UPDATE unified_tasks SET tenant_id = 901 WHERE user_id = ? AND title = ?')
      .run(USER_ID, 'Tenant 901 scoped task');

    const personal = await buildDailyContext(USER_ID, USER_ID);
    const tenant901 = await buildDailyContext(USER_ID, 901);

    expect(personal).toContain('TASKS: 0 overdue, 1 due today, 1 total pending');
    expect(personal).toContain('Legacy personal task');
    expect(personal).not.toContain('Tenant 901 scoped task');
    expect(tenant901).toContain('TASKS: 0 overdue, 1 due today, 1 total pending');
    expect(tenant901).toContain('Tenant 901 scoped task');
    expect(tenant901).not.toContain('Legacy personal task');

    const cachedPersonal = getDailyContext(USER_ID, USER_ID);
    const cachedTenant901 = getDailyContext(USER_ID, 901);
    expect(cachedPersonal).toBe(personal);
    expect(cachedPersonal).toContain('Legacy personal task');
    expect(cachedPersonal).not.toContain('Tenant 901 scoped task');
    expect(cachedTenant901).toBe(tenant901);
    expect(cachedTenant901).toContain('Tenant 901 scoped task');
    expect(cachedTenant901).not.toContain('Legacy personal task');
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

  it('counts only private active canonical Content workspace items', async () => {
    captureDiscoveredIdea({
      scope: { tenantId: USER_ID, userId: USER_ID },
      title: 'Canonical idea in progress',
      sourceDate: '2026-07-17',
      score: 0.8,
      workflowEligible: true,
    }, testDb);
    const archived = captureDiscoveredIdea({
      scope: { tenantId: USER_ID, userId: USER_ID },
      title: 'Archived canonical idea',
      sourceDate: '2026-07-17',
      score: 0.4,
      workflowEligible: false,
    }, testDb);
    testDb.prepare(`
      UPDATE content_domain_objects
         SET production_state = 'archived'
       WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
    `).run(archived.item.id, USER_ID, USER_ID);

    const summary = await buildDailyContext(USER_ID, USER_ID);

    expect(summary).toContain('CONTENT: 1 active items in workspace');
    expect(summary).not.toContain('ideas saved in pipeline');
  });

  it('isolates the canonical Content count by tenant for the same user', async () => {
    captureDiscoveredIdea({
      scope: { tenantId: 901, userId: USER_ID },
      title: 'Tenant 901 private idea',
      sourceDate: '2026-07-17',
      score: 0.8,
      workflowEligible: true,
    }, testDb);
    captureDiscoveredIdea({
      scope: { tenantId: 902, userId: USER_ID },
      title: 'Tenant 902 private idea one',
      sourceDate: '2026-07-17',
      score: 0.8,
      workflowEligible: true,
    }, testDb);
    captureDiscoveredIdea({
      scope: { tenantId: 902, userId: USER_ID },
      title: 'Tenant 902 private idea two',
      sourceDate: '2026-07-17',
      score: 0.8,
      workflowEligible: true,
    }, testDb);

    const summary = await buildDailyContext(USER_ID, 901);

    expect(summary).toContain('CONTENT: 1 active items in workspace');
    expect(summary).not.toContain('CONTENT: 2 active items');
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
    testDb.prepare('UPDATE unified_tasks SET tenant_id = 901 WHERE user_id = ? AND title = ?')
      .run(USER_ID, 'Tenant scoped');
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
