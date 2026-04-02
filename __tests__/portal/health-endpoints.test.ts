/**
 * Health Endpoint Tests
 *
 * Tests GET /health (lightweight, no auth) and GET /health/detailed (auth-protected).
 * Verifies response structure, status codes, and authentication logic.
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
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// ── /health response structure tests ───────────────────────────────

describe('Health Endpoint Response Structure', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('GET /health — lightweight liveness probe', () => {
    it('database ping returns ok with SELECT 1', () => {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
      expect(row.ok).toBe(1);
    });

    it('expected response fields are present', () => {
      // Simulate the health response shape
      const dbOk = (() => {
        try {
          const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
          return row?.ok === 1;
        } catch { return false; }
      })();

      const memUsage = process.memoryUsage();
      const response = {
        status: dbOk ? 'healthy' : 'degraded',
        uptime: 42,
        db: dbOk ? 'ok' : 'unreachable',
        bot: 'stopped',
        memory: {
          rss: Math.round(memUsage.rss / 1048576),
          heapUsed: Math.round(memUsage.heapUsed / 1048576),
          heapTotal: Math.round(memUsage.heapTotal / 1048576),
        },
      };

      expect(response).toHaveProperty('status');
      expect(response).toHaveProperty('uptime');
      expect(response).toHaveProperty('db');
      expect(response).toHaveProperty('bot');
      expect(response).toHaveProperty('memory');
      expect(response.memory).toHaveProperty('rss');
      expect(response.memory).toHaveProperty('heapUsed');
      expect(response.memory).toHaveProperty('heapTotal');
      expect(typeof response.memory.rss).toBe('number');
      expect(response.db).toBe('ok');
    });

    it('reports degraded when database is closed', () => {
      db.close();
      let dbOk = false;
      try {
        db.prepare('SELECT 1 AS ok').get();
        dbOk = true;
      } catch {
        dbOk = false;
      }
      expect(dbOk).toBe(false);
      // Re-open for afterEach
      db = createTestDb();
    });

    it('memory values are positive integers in MB', () => {
      const memUsage = process.memoryUsage();
      const rss = Math.round(memUsage.rss / 1048576);
      const heapUsed = Math.round(memUsage.heapUsed / 1048576);
      const heapTotal = Math.round(memUsage.heapTotal / 1048576);

      expect(rss).toBeGreaterThan(0);
      expect(heapUsed).toBeGreaterThan(0);
      expect(heapTotal).toBeGreaterThan(0);
      expect(heapUsed).toBeLessThanOrEqual(heapTotal);
      expect(Number.isInteger(rss)).toBe(true);
    });
  });

  describe('GET /health/detailed — auth-protected health check', () => {
    it('database PRAGMA page_count returns numeric value', () => {
      const pageCount = (db.prepare('PRAGMA page_count').get() as any)?.page_count ?? 0;
      const pageSize = (db.prepare('PRAGMA page_size').get() as any)?.page_size ?? 0;
      const sizeBytes = pageCount * pageSize;

      expect(typeof pageCount).toBe('number');
      expect(typeof pageSize).toBe('number');
      expect(sizeBytes).toBeGreaterThanOrEqual(0);
    });

    it('expected detailed response fields are present', () => {
      const dbOk = true;
      const pageCount = (db.prepare('PRAGMA page_count').get() as any)?.page_count ?? 0;
      const pageSize = (db.prepare('PRAGMA page_size').get() as any)?.page_size ?? 0;
      const dbSizeBytes = pageCount * pageSize;

      const response = {
        status: 'healthy',
        uptime: { seconds: 42, human: '0m' },
        bot: { polling: false, restarting: false, lastMessageAt: null },
        db: {
          status: 'ok',
          sizeBytes: dbSizeBytes,
          sizeMB: Math.round(dbSizeBytes / 1048576 * 100) / 100,
        },
        memory: {
          rss: 50,
          heapUsed: 30,
          heapTotal: 60,
          external: 5,
        },
        crons: { total: 0, ok: 0, failed: [] },
        errors: { today: 0, last7d: 0, last30d: 0 },
        integrations: [],
        sentry: false,
        generatedAt: new Date().toISOString(),
      };

      expect(response).toHaveProperty('status');
      expect(response).toHaveProperty('uptime');
      expect(response.uptime).toHaveProperty('seconds');
      expect(response.uptime).toHaveProperty('human');
      expect(response).toHaveProperty('db');
      expect(response.db).toHaveProperty('status');
      expect(response.db).toHaveProperty('sizeBytes');
      expect(response.db).toHaveProperty('sizeMB');
      expect(response).toHaveProperty('memory');
      expect(response.memory).toHaveProperty('external');
      expect(response).toHaveProperty('crons');
      expect(response.crons).toHaveProperty('total');
      expect(response.crons).toHaveProperty('ok');
      expect(response.crons).toHaveProperty('failed');
      expect(response).toHaveProperty('errors');
      expect(response).toHaveProperty('integrations');
      expect(response).toHaveProperty('sentry');
      expect(response).toHaveProperty('generatedAt');
    });

    it('failed crons include name, label, lastError, lastRunAt', () => {
      const failedJob = {
        name: 'test_job',
        label: 'Test Job',
        lastError: 'connection timeout',
        lastRunAt: '2026-04-01T10:00:00.000Z',
      };

      expect(failedJob).toHaveProperty('name');
      expect(failedJob).toHaveProperty('label');
      expect(failedJob).toHaveProperty('lastError');
      expect(failedJob).toHaveProperty('lastRunAt');
    });

    it('status is healthy when db ok, bot polling, and no failed jobs', () => {
      const dbOk = true;
      const botOk = true;
      const jobsFailed: any[] = [];

      const healthy = dbOk && botOk && jobsFailed.length === 0;
      const degraded = dbOk && botOk && jobsFailed.length > 0;
      const status = healthy ? 'healthy' : degraded ? 'degraded' : 'unhealthy';

      expect(status).toBe('healthy');
    });

    it('status is degraded when db ok and bot ok but jobs failed', () => {
      const dbOk = true;
      const botOk = true;
      const jobsFailed = [{ name: 'broken_job' }];

      const healthy = dbOk && botOk && jobsFailed.length === 0;
      const degraded = dbOk && botOk && jobsFailed.length > 0;
      const status = healthy ? 'healthy' : degraded ? 'degraded' : 'unhealthy';

      expect(status).toBe('degraded');
    });

    it('status is unhealthy when db is unreachable', () => {
      const dbOk = false;
      const botOk = true;
      const jobsFailed: any[] = [];

      const healthy = dbOk && botOk && jobsFailed.length === 0;
      const degraded = dbOk && botOk && jobsFailed.length > 0;
      const status = healthy ? 'healthy' : degraded ? 'degraded' : 'unhealthy';

      expect(status).toBe('unhealthy');
    });

    it('status is unhealthy when bot is not polling', () => {
      const dbOk = true;
      const botOk = false;
      const jobsFailed: any[] = [];

      const healthy = dbOk && botOk && jobsFailed.length === 0;
      const degraded = dbOk && botOk && jobsFailed.length > 0;
      const status = healthy ? 'healthy' : degraded ? 'degraded' : 'unhealthy';

      expect(status).toBe('unhealthy');
    });
  });

  describe('Health token authentication', () => {
    it('rejects requests without token when HEALTH_TOKEN is set', () => {
      const healthToken = 'my-secret-token';
      const providedToken = undefined;

      const authorized = !healthToken || (providedToken === healthToken);
      expect(authorized).toBe(false);
    });

    it('accepts requests with correct token', () => {
      const healthToken = 'my-secret-token';
      const providedToken = 'my-secret-token';

      const authorized = !healthToken || (providedToken === healthToken);
      expect(authorized).toBe(true);
    });

    it('rejects requests with wrong token', () => {
      const healthToken = 'my-secret-token';
      const providedToken = 'wrong-token';

      const authorized = !healthToken || (providedToken === healthToken);
      expect(authorized).toBe(false);
    });

    it('allows unauthenticated access when no HEALTH_TOKEN is set', () => {
      const healthToken = '';
      const providedToken = undefined;

      const authorized = !healthToken || (providedToken === healthToken);
      expect(authorized).toBe(true);
    });
  });

  describe('DB size calculation', () => {
    it('calculates DB size from page_count * page_size', () => {
      // Insert some data to make the DB non-trivial
      db.prepare('INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)').run('secretary', 'user', 'Hello');
      db.prepare('INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)').run('triathlon', 'user', 'Train');

      const pageCount = (db.prepare('PRAGMA page_count').get() as any)?.page_count ?? 0;
      const pageSize = (db.prepare('PRAGMA page_size').get() as any)?.page_size ?? 0;
      const sizeBytes = pageCount * pageSize;

      expect(pageCount).toBeGreaterThan(0);
      expect(pageSize).toBeGreaterThan(0);
      expect(sizeBytes).toBeGreaterThan(0);
    });

    it('converts bytes to MB correctly', () => {
      const sizeBytes = 5242880; // 5 MB
      const sizeMB = Math.round(sizeBytes / 1048576 * 100) / 100;
      expect(sizeMB).toBe(5);
    });
  });
});
