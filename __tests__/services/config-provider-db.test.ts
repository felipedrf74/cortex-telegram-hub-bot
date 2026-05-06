/**
 * DatabaseConfigProvider Tests
 *
 * Tests SQLite-backed config with:
 * - Override chain: env var → DB (kv_store) → hardcoded default
 * - get/set/clear settings
 * - Config mutation (patchLiveConfig)
 * - Persistence and startup loading
 * - Multi-tenant ConfigProvider interface
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// ─── Mock database ──────────────────────────────────────────────────

let testDb: Database.Database;

// No database mock needed — we inject testDb via constructor

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon', logLevel: 'info', databasePath: ':memory:', rateLimitMessagesPerDay: 0, rateLimitTokensPerDay: 0, rateLimitCostPerDay: 0, language: 'pt-BR' },
    todo: { digestTime: '06:00', digestEnabled: true },
    backup: { time: '03:00', retentionDays: 30 },
    anthropic: { model: 'claude-sonnet-4-6', classifierModel: 'claude-haiku-4-5-20251001' },
  },
}));

import { DatabaseConfigProvider } from '../../src/services/config-provider';
import { config } from '../../src/config';

const mockConfig = config as any;

// ═══════════════════════════════════════════════════════════════════

describe('DatabaseConfigProvider', () => {
  let provider: DatabaseConfigProvider;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    provider = new DatabaseConfigProvider(() => testDb);

    // Save env vars we'll modify
    for (const key of ['TIMEZONE', 'LOG_LEVEL', 'TODO_DIGEST_TIME', 'TODO_DIGEST_ENABLED', 'BACKUP_TIME', 'BACKUP_RETENTION_DAYS']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    // Reset mock config
    mockConfig.app.timezone = 'Europe/Lisbon';
    mockConfig.app.logLevel = 'info';
    mockConfig.todo.digestTime = '06:00';
    mockConfig.todo.digestEnabled = true;
    mockConfig.backup.time = '03:00';
    mockConfig.backup.retentionDays = 30;
  });

  afterEach(() => {
    testDb?.close();
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  // ── getSetting ────────────────────────────────────────────────

  describe('getSetting', () => {
    it('returns hardcoded default when no override exists', () => {
      expect(provider.getSetting('timezone')).toBe('Europe/Lisbon');
    });

    it('returns DB override when set', () => {
      testDb.prepare("INSERT INTO kv_store (key, value) VALUES ('config:default:timezone', '\"UTC\"')").run();
      expect(provider.getSetting('timezone')).toBe('UTC');
    });

    it('returns env var when env var is set (overrides DB)', () => {
      process.env.TIMEZONE = 'America/New_York';
      testDb.prepare("INSERT INTO kv_store (key, value) VALUES ('config:default:timezone', '\"UTC\"')").run();
      expect(provider.getSetting('timezone')).toBe('America/New_York');
    });

    it('returns undefined for unknown setting', () => {
      expect(provider.getSetting('nonexistent')).toBeUndefined();
    });
  });

  // ── setSetting ────────────────────────────────────────────────

  describe('setSetting', () => {
    it('persists value to kv_store', () => {
      provider.setSetting('timezone', 'UTC');
      const row = testDb.prepare("SELECT value FROM kv_store WHERE key = 'config:default:timezone'").get() as any;
      expect(JSON.parse(row.value)).toBe('UTC');
    });

    it('patches live config object immediately', () => {
      provider.setSetting('timezone', 'America/Sao_Paulo');
      expect(mockConfig.app.timezone).toBe('America/Sao_Paulo');
    });

    it('throws on unknown setting id', () => {
      expect(() => provider.setSetting('fake_setting', 'x')).toThrow('Unknown setting');
    });

    it('works for number type', () => {
      provider.setSetting('backup_retention_days', 7);
      expect(mockConfig.backup.retentionDays).toBe(7);
    });

    it('works for boolean type', () => {
      provider.setSetting('briefing_enabled', false);
      expect(mockConfig.todo.digestEnabled).toBe(false);
    });
  });

  // ── clearSetting ──────────────────────────────────────────────

  describe('clearSetting', () => {
    it('removes DB override', () => {
      provider.setSetting('timezone', 'UTC');
      provider.clearSetting('timezone');
      const row = testDb.prepare("SELECT 1 FROM kv_store WHERE key = 'config:default:timezone'").get();
      expect(row).toBeUndefined();
    });

    it('reverts live config to default', () => {
      provider.setSetting('timezone', 'UTC');
      provider.clearSetting('timezone');
      expect(mockConfig.app.timezone).toBe('Europe/Lisbon');
    });

    it('reverts to env var if env var is set', () => {
      process.env.TIMEZONE = 'America/New_York';
      provider.setSetting('timezone', 'UTC');
      provider.clearSetting('timezone');
      expect(mockConfig.app.timezone).toBe('America/New_York');
    });
  });

  // ── getAllSettings ─────────────────────────────────────────────

  describe('getAllSettings', () => {
    it('returns all defined settings', () => {
      const settings = provider.getAllSettings();
      expect(settings.length).toBeGreaterThan(0);
      expect(settings.map(s => s.id)).toContain('timezone');
    });

    it('marks env-locked settings with locked:true', () => {
      process.env.TIMEZONE = 'UTC';
      const tz = provider.getAllSettings().find(s => s.id === 'timezone')!;
      expect(tz.locked).toBe(true);
      expect(tz.source).toBe('env');
    });

    it('includes options for dropdown settings', () => {
      const tz = provider.getAllSettings().find(s => s.id === 'timezone')!;
      expect(tz.options).toBeDefined();
      expect(tz.options!.length).toBeGreaterThan(0);
    });

    it('shows source:database for DB overrides', () => {
      provider.setSetting('timezone', 'UTC');
      const tz = provider.getAllSettings().find(s => s.id === 'timezone')!;
      expect(tz.source).toBe('database');
    });

    it('shows source:default for unmodified settings', () => {
      const tz = provider.getAllSettings().find(s => s.id === 'timezone')!;
      expect(tz.source).toBe('default');
    });
  });

  // ── loadPersistedSettings ─────────────────────────────────────

  describe('loadPersistedSettings', () => {
    it('loads overrides from kv_store', () => {
      testDb.prepare("INSERT INTO kv_store (key, value) VALUES ('config:default:timezone', '\"America/Sao_Paulo\"')").run();
      provider.loadPersistedSettings();
      expect(mockConfig.app.timezone).toBe('America/Sao_Paulo');
    });

    it('skips env-locked settings', () => {
      process.env.TIMEZONE = 'Europe/London';
      testDb.prepare("INSERT INTO kv_store (key, value) VALUES ('config:default:timezone', '\"UTC\"')").run();
      provider.loadPersistedSettings();
      expect(mockConfig.app.timezone).not.toBe('UTC');
    });

    it('handles empty kv_store gracefully', () => {
      expect(() => provider.loadPersistedSettings()).not.toThrow();
    });

    it('creates kv_store table if missing', () => {
      testDb.exec('DROP TABLE IF EXISTS kv_store');
      expect(() => provider.loadPersistedSettings()).not.toThrow();
    });
  });

  // ── Override chain priority ───────────────────────────────────

  describe('override chain priority', () => {
    it('env var > DB override > default', () => {
      expect(provider.getSetting('timezone')).toBe('Europe/Lisbon');
      provider.setSetting('timezone', 'UTC');
      expect(provider.getSetting('timezone')).toBe('UTC');
      process.env.TIMEZONE = 'America/New_York';
      expect(provider.getSetting('timezone')).toBe('America/New_York');
    });

    it('clearing DB override falls back to default', () => {
      provider.setSetting('timezone', 'UTC');
      provider.clearSetting('timezone');
      expect(provider.getSetting('timezone')).toBe('Europe/Lisbon');
    });
  });

  // ── ConfigProvider interface ──────────────────────────────────

  describe('ConfigProvider interface', () => {
    it('has name "database"', () => {
      expect(provider.name).toBe('database');
    });

    it('setOverrides/getOverrides work', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } as any });
      expect(provider.getOverrides('t1')).toEqual({ app: { timezone: 'UTC' } });
    });

    it('clearOverrides removes tenant', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } as any });
      expect(provider.clearOverrides('t1')).toBe(true);
      expect(provider.getOverrides('t1')).toBeNull();
    });

    it('tenantIds lists tenants', () => {
      provider.setOverrides('t1', { app: { timezone: 'UTC' } as any });
      provider.setOverrides('t2', { app: { timezone: 'EST' } as any });
      expect(provider.tenantIds()).toEqual(expect.arrayContaining(['t1', 't2']));
    });
  });
});
