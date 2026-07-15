/**
 * Usage Metering Service Tests
 *
 * Tests that:
 * - Recording usage creates/updates daily aggregate rows (UPSERT)
 * - Querying daily usage returns correct aggregates
 * - Range queries return multiple days
 * - Global daily usage aggregates across users
 * - Quota management (set, get, check)
 * - Quota enforcement correctly identifies exceeded limits
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

// ── Test helpers ────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// ═══════════════════════════════════════════════════════════════════
// MIGRATION TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Usage Metering Migration', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('creates usage_metering table', () => {
    applyMigrations(db);
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='usage_metering'"
    ).get();
    expect(table).toBeTruthy();
  });

  it('creates usage_quotas table', () => {
    applyMigrations(db);
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='usage_quotas'"
    ).get();
    expect(table).toBeTruthy();
  });

  it('creates unique index on (user_id, date)', () => {
    applyMigrations(db);
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_metering_user_date'"
    ).get();
    expect(idx).toBeTruthy();
  });

  it('enforces unique constraint on user_id+date', () => {
    applyMigrations(db);
    db.prepare(
      'INSERT INTO usage_metering (user_id, date, message_count, input_tokens, output_tokens, total_tokens, api_calls, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(123, '2026-04-01', 1, 100, 50, 150, 1, 0.001);

    expect(() => {
      db.prepare(
        'INSERT INTO usage_metering (user_id, date, message_count, input_tokens, output_tokens, total_tokens, api_calls, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(123, '2026-04-01', 1, 100, 50, 150, 1, 0.001);
    }).toThrow();
  });

  it('allows same user on different dates', () => {
    applyMigrations(db);
    db.prepare(
      'INSERT INTO usage_metering (user_id, date) VALUES (?, ?)'
    ).run(123, '2026-04-01');
    db.prepare(
      'INSERT INTO usage_metering (user_id, date) VALUES (?, ?)'
    ).run(123, '2026-04-02');

    const rows = db.prepare('SELECT * FROM usage_metering WHERE user_id = 123').all();
    expect(rows).toHaveLength(2);
  });

  it('enforces unique user_id in usage_quotas', () => {
    applyMigrations(db);
    db.prepare('INSERT INTO usage_quotas (user_id, daily_message_limit) VALUES (?, ?)').run(123, 100);

    expect(() => {
      db.prepare('INSERT INTO usage_quotas (user_id, daily_message_limit) VALUES (?, ?)').run(123, 200);
    }).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// SERVICE TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Usage Metering Service', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();

    // Mock getDb() to return our in-memory database
    vi.doMock('../../src/services/database', () => ({
      getDb: () => db,
    }));
    vi.doMock('../../src/utils/logger', () => ({
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadService() {
    return await import('../../src/services/usage-metering');
  }

  describe('recordUsage', () => {
    it('creates a new row for first call', async () => {
      const { recordUsage, getDailyUsage } = await loadService();

      recordUsage(123, 500, 200, 0.005, true);

      const usage = getDailyUsage(123);
      expect(usage.messageCount).toBe(1);
      expect(usage.inputTokens).toBe(500);
      expect(usage.outputTokens).toBe(200);
      expect(usage.totalTokens).toBe(700);
      expect(usage.apiCalls).toBe(1);
      expect(usage.costUsd).toBeCloseTo(0.005);
    });

    it('increments existing row on subsequent calls (UPSERT)', async () => {
      const { recordUsage, getDailyUsage } = await loadService();

      recordUsage(123, 500, 200, 0.005, true);
      recordUsage(123, 300, 100, 0.003, false);

      const usage = getDailyUsage(123);
      expect(usage.messageCount).toBe(1); // only first was isUserMessage
      expect(usage.inputTokens).toBe(800);
      expect(usage.outputTokens).toBe(300);
      expect(usage.totalTokens).toBe(1100);
      expect(usage.apiCalls).toBe(2);
      expect(usage.costUsd).toBeCloseTo(0.008);
    });

    it('tracks separate rows for different users', async () => {
      const { recordUsage, getDailyUsage } = await loadService();

      recordUsage(123, 500, 200, 0.005, true);
      recordUsage(456, 300, 100, 0.003, true);

      const u1 = getDailyUsage(123);
      const u2 = getDailyUsage(456);
      expect(u1.inputTokens).toBe(500);
      expect(u2.inputTokens).toBe(300);
    });

    it('uses userId 0 for system calls', async () => {
      const { recordUsage, getDailyUsage } = await loadService();

      recordUsage(0, 1000, 500, 0.01, false);

      const usage = getDailyUsage(0);
      expect(usage.apiCalls).toBe(1);
      expect(usage.messageCount).toBe(0);
    });
  });

  describe('getDailyUsage', () => {
    it('returns zeros for user with no usage', async () => {
      const { getDailyUsage } = await loadService();

      const usage = getDailyUsage(999);
      expect(usage.messageCount).toBe(0);
      expect(usage.inputTokens).toBe(0);
      expect(usage.totalTokens).toBe(0);
      expect(usage.apiCalls).toBe(0);
      expect(usage.costUsd).toBe(0);
    });

    it('returns correct data for specific date', async () => {
      const { getDailyUsage } = await loadService();

      // Insert directly for a specific past date
      db.prepare(`
        INSERT INTO usage_metering (user_id, date, message_count, input_tokens, output_tokens, total_tokens, api_calls, cost_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(123, '2026-03-15', 5, 2000, 800, 2800, 10, 0.05);

      const usage = getDailyUsage(123, '2026-03-15');
      expect(usage.messageCount).toBe(5);
      expect(usage.totalTokens).toBe(2800);
      expect(usage.date).toBe('2026-03-15');
    });
  });

  describe('getUsageRange', () => {
    it('returns usage for date range', async () => {
      const { getUsageRange } = await loadService();

      db.prepare(`INSERT INTO usage_metering (user_id, date, message_count, total_tokens, api_calls, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`).run(123, '2026-03-01', 3, 1000, 5, 0.01);
      db.prepare(`INSERT INTO usage_metering (user_id, date, message_count, total_tokens, api_calls, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`).run(123, '2026-03-02', 5, 2000, 8, 0.02);
      db.prepare(`INSERT INTO usage_metering (user_id, date, message_count, total_tokens, api_calls, cost_usd) VALUES (?, ?, ?, ?, ?, ?)`).run(123, '2026-03-03', 2, 500, 3, 0.005);

      const range = getUsageRange(123, '2026-03-01', '2026-03-03');
      expect(range).toHaveLength(3);
      expect(range[0].date).toBe('2026-03-01');
      expect(range[2].date).toBe('2026-03-03');
    });

    it('returns empty array for date range with no data', async () => {
      const { getUsageRange } = await loadService();
      const range = getUsageRange(123, '2026-01-01', '2026-01-31');
      expect(range).toHaveLength(0);
    });
  });

  describe('getGlobalDailyUsage', () => {
    it('aggregates across all users', async () => {
      const { recordUsage, getGlobalDailyUsage } = await loadService();

      recordUsage(123, 500, 200, 0.005, true);
      recordUsage(456, 300, 100, 0.003, true);

      const global = getGlobalDailyUsage();
      expect(global.messageCount).toBe(2);
      expect(global.inputTokens).toBe(800);
      expect(global.outputTokens).toBe(300);
      expect(global.apiCalls).toBe(2);
      expect(global.costUsd).toBeCloseTo(0.008);
    });

    it('returns zeros when no data exists', async () => {
      const { getGlobalDailyUsage } = await loadService();
      const global = getGlobalDailyUsage('2026-01-01');
      expect(global.messageCount).toBe(0);
      expect(global.apiCalls).toBe(0);
    });
  });

  describe('Quota Management', () => {
    it('returns null for user with no quota', async () => {
      const { getQuota } = await loadService();
      expect(getQuota(123)).toBeNull();
    });

    it('sets and retrieves a quota', async () => {
      const { setQuota, getQuota } = await loadService();

      setQuota(123, { dailyMessageLimit: 100, dailyTokenLimit: 500000, dailyCostLimitUsd: 5.0 });

      const q = getQuota(123);
      expect(q).not.toBeNull();
      expect(q!.dailyMessageLimit).toBe(100);
      expect(q!.dailyTokenLimit).toBe(500000);
      expect(q!.dailyCostLimitUsd).toBe(5.0);
    });

    it('updates an existing quota', async () => {
      const { setQuota, getQuota } = await loadService();

      setQuota(123, { dailyMessageLimit: 100 });
      setQuota(123, { dailyMessageLimit: 200 });

      const q = getQuota(123);
      expect(q!.dailyMessageLimit).toBe(200);
    });
  });

  describe('checkQuota', () => {
    it('allows usage when no quota is set', async () => {
      const { recordUsage, checkQuota } = await loadService();

      recordUsage(123, 500, 200, 0.005, true);
      const status = checkQuota(123);

      expect(status.allowed).toBe(true);
      expect(status.quota).toBeNull();
      expect(status.exceeded).toHaveLength(0);
    });

    it('allows usage under quota', async () => {
      const { recordUsage, setQuota, checkQuota } = await loadService();

      setQuota(123, { dailyMessageLimit: 100 });
      recordUsage(123, 500, 200, 0.005, true);

      const status = checkQuota(123);
      expect(status.allowed).toBe(true);
      expect(status.exceeded).toHaveLength(0);
    });

    it('denies when message limit exceeded', async () => {
      const { recordUsage, setQuota, checkQuota } = await loadService();

      setQuota(123, { dailyMessageLimit: 2 });
      recordUsage(123, 500, 200, 0.005, true);
      recordUsage(123, 500, 200, 0.005, true);

      const status = checkQuota(123);
      expect(status.allowed).toBe(false);
      expect(status.exceeded).toContain('messages');
    });

    it('denies when token limit exceeded', async () => {
      const { recordUsage, setQuota, checkQuota } = await loadService();

      setQuota(123, { dailyTokenLimit: 500 });
      recordUsage(123, 300, 250, 0.005, true);

      const status = checkQuota(123);
      expect(status.allowed).toBe(false);
      expect(status.exceeded).toContain('tokens');
    });

    it('denies when cost limit exceeded', async () => {
      const { recordUsage, setQuota, checkQuota } = await loadService();

      setQuota(123, { dailyCostLimitUsd: 0.01 });
      recordUsage(123, 500, 200, 0.008, true);
      recordUsage(123, 500, 200, 0.005, true);

      const status = checkQuota(123);
      expect(status.allowed).toBe(false);
      expect(status.exceeded).toContain('cost');
    });

    it('reports multiple exceeded limits', async () => {
      const { recordUsage, setQuota, checkQuota } = await loadService();

      setQuota(123, { dailyMessageLimit: 1, dailyCostLimitUsd: 0.001 });
      recordUsage(123, 500, 200, 0.005, true);

      const status = checkQuota(123);
      expect(status.allowed).toBe(false);
      expect(status.exceeded).toContain('messages');
      expect(status.exceeded).toContain('cost');
    });
  });
});
