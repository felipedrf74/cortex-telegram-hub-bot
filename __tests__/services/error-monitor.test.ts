/**
 * Error Monitor Tests
 *
 * Tests error capture, persistence, Telegram alerting, rate limiting,
 * process handlers, and trend queries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

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
    .filter(f => f.endsWith('.sql') && !f.includes(' 2'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// Mock dependencies
let testDb: Database.Database;
vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
}));

import {
  setDbProvider,
  setAlertCallback,
  captureError,
  getErrorTrends,
} from '../../src/services/error-monitor';
import { pushEvent } from '../../src/portal/telemetry';

describe('Error Monitor', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    setDbProvider(() => testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  describe('captureError()', () => {
    it('persists error to database', () => {
      captureError({
        level: 'error',
        source: 'bot',
        message: 'Test error message',
        stack: 'Error: test\n  at test.ts:1',
      });

      const row = testDb.prepare('SELECT * FROM error_log').get() as any;
      expect(row).toBeDefined();
      expect(row.level).toBe('error');
      expect(row.source).toBe('bot');
      expect(row.message).toBe('Test error message');
      expect(row.stack).toContain('Error: test');
    });

    it('persists context as JSON', () => {
      captureError({
        level: 'warning',
        source: 'api',
        message: 'Rate limited',
        context: { endpoint: '/api/chat', userId: 123 },
      });

      const row = testDb.prepare('SELECT * FROM error_log').get() as any;
      expect(row.context).toBeDefined();
      const ctx = JSON.parse(row.context);
      expect(ctx.endpoint).toBe('/api/chat');
      expect(ctx.userId).toBe(123);
    });

    it('pushes event to telemetry ring buffer', () => {
      captureError({
        level: 'error',
        source: 'job',
        message: 'Job failed',
      });

      expect(pushEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        summary: expect.stringContaining('[job]'),
      }));
    });

    it('truncates long messages', () => {
      const longMsg = 'x'.repeat(3000);
      captureError({
        level: 'error',
        source: 'bot',
        message: longMsg,
      });

      const row = testDb.prepare('SELECT * FROM error_log').get() as any;
      expect(row.message.length).toBe(2000);
    });

    it('sends alert for error level', async () => {
      const alertFn = vi.fn().mockResolvedValue(undefined);
      setAlertCallback(alertFn);

      captureError({
        level: 'error',
        source: 'bot',
        message: 'Critical failure',
      });

      // Give async alert a tick to fire
      await new Promise(r => setTimeout(r, 10));
      expect(alertFn).toHaveBeenCalled();
      const msg = alertFn.mock.calls[0][0];
      expect(msg).toContain('ERROR');
      expect(msg).toContain('Critical failure');
    });

    it('does not alert for warnings by default', async () => {
      const alertFn = vi.fn().mockResolvedValue(undefined);
      setAlertCallback(alertFn);

      captureError({
        level: 'warning',
        source: 'api',
        message: 'Slow response',
      });

      await new Promise(r => setTimeout(r, 10));
      expect(alertFn).not.toHaveBeenCalled();
    });

    it('rate-limits duplicate alerts within 60s', async () => {
      const alertFn = vi.fn().mockResolvedValue(undefined);
      setAlertCallback(alertFn);

      captureError({ level: 'error', source: 'bot', message: 'Same error' });
      captureError({ level: 'error', source: 'bot', message: 'Same error' });
      captureError({ level: 'error', source: 'bot', message: 'Same error' });

      await new Promise(r => setTimeout(r, 10));
      // Should only alert once due to rate limiting
      expect(alertFn).toHaveBeenCalledTimes(1);
    });

    it('alerts for different errors separately', async () => {
      const alertFn = vi.fn().mockResolvedValue(undefined);
      setAlertCallback(alertFn);

      captureError({ level: 'error', source: 'bot', message: 'Error A' });
      captureError({ level: 'error', source: 'bot', message: 'Error B' });

      await new Promise(r => setTimeout(r, 10));
      expect(alertFn).toHaveBeenCalledTimes(2);
    });

    it('sets alerted=1 when alert callback is registered', () => {
      setAlertCallback(vi.fn().mockResolvedValue(undefined));

      captureError({ level: 'error', source: 'bot', message: 'Will alert' });

      const row = testDb.prepare('SELECT * FROM error_log').get() as any;
      expect(row.alerted).toBe(1);
    });
  });

  describe('getErrorTrends()', () => {
    it('returns zeros when no errors', () => {
      const trends = getErrorTrends();
      expect(trends.today).toBe(0);
      expect(trends.last7d).toBe(0);
      expect(trends.last30d).toBe(0);
      expect(trends.bySource).toEqual([]);
      expect(trends.byLevel).toEqual([]);
      expect(trends.recent).toEqual([]);
    });

    it('counts errors correctly', () => {
      captureError({ level: 'error', source: 'bot', message: 'err1' }, false);
      captureError({ level: 'warning', source: 'api', message: 'warn1' }, false);
      captureError({ level: 'fatal', source: 'process', message: 'fatal1' }, false);

      const trends = getErrorTrends();
      expect(trends.today).toBe(3);
      expect(trends.last7d).toBe(3);
      expect(trends.last30d).toBe(3);
    });

    it('groups by source', () => {
      captureError({ level: 'error', source: 'bot', message: 'e1' }, false);
      captureError({ level: 'error', source: 'bot', message: 'e2' }, false);
      captureError({ level: 'error', source: 'api', message: 'e3' }, false);

      const trends = getErrorTrends();
      const botSource = trends.bySource.find(s => s.source === 'bot');
      const apiSource = trends.bySource.find(s => s.source === 'api');
      expect(botSource?.count).toBe(2);
      expect(apiSource?.count).toBe(1);
    });

    it('groups by level', () => {
      captureError({ level: 'error', source: 'bot', message: 'e1' }, false);
      captureError({ level: 'error', source: 'bot', message: 'e2' }, false);
      captureError({ level: 'fatal', source: 'process', message: 'f1' }, false);

      const trends = getErrorTrends();
      const errors = trends.byLevel.find(l => l.level === 'error');
      const fatals = trends.byLevel.find(l => l.level === 'fatal');
      expect(errors?.count).toBe(2);
      expect(fatals?.count).toBe(1);
    });

    it('returns recent errors newest-first', () => {
      captureError({ level: 'error', source: 'bot', message: 'first' }, false);
      captureError({ level: 'error', source: 'bot', message: 'second' }, false);

      const trends = getErrorTrends();
      expect(trends.recent.length).toBe(2);
      // Most recent first
      expect(trends.recent[0].message).toBe('second');
      expect(trends.recent[1].message).toBe('first');
    });

    it('limits recent to 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        captureError({ level: 'error', source: 'bot', message: `err-${i}` }, false);
      }

      const trends = getErrorTrends();
      expect(trends.recent.length).toBe(20);
    });
  });

  describe('migration 021_error_log.sql', () => {
    it('creates error_log table with correct columns', () => {
      const info = testDb.prepare("PRAGMA table_info('error_log')").all() as any[];
      const colNames = info.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('ts');
      expect(colNames).toContain('level');
      expect(colNames).toContain('source');
      expect(colNames).toContain('message');
      expect(colNames).toContain('stack');
      expect(colNames).toContain('context');
      expect(colNames).toContain('alerted');
    });

    it('has indexes on ts, source, and level', () => {
      const indexes = testDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='error_log'").all() as any[];
      const names = indexes.map(i => i.name);
      expect(names).toContain('idx_error_log_ts');
      expect(names).toContain('idx_error_log_source');
      expect(names).toContain('idx_error_log_level');
    });
  });
});
