import { beforeEach, describe, expect, it, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import type { Request } from 'express';
import Database from 'better-sqlite3';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

let testDb: Database.Database;
const originalHealthEncryptionKey = process.env.HEALTH_DATA_ENCRYPTION_KEY;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
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

import { healthDataRoutes } from '../../src/api/routes/health-data';
import { config } from '../../src/config';
import { getReadiness } from '../../src/api/routes/training-read-models';
import { clearCacheByPrefix } from '../../src/services/cache-store';
import { parseAppleHealthDataJson } from '../../src/services/apple-health-encryption';


interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string | number>;
  setHeader(name: string, value: string | number): MockRes;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name: string, value: string | number) { r.headers[name] = value; return r; },
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
  };
  return r;
}

function mockReq(method: string, path: string, body: Record<string, unknown> = {}): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    body,
    query: {},
    params: {},
    headers: {},
    userId: 62,
  } as any;
}

async function dispatchWithRouter(
  router: ReturnType<typeof healthDataRoutes>,
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId = 62,
): Promise<MockRes> {
  const req = mockReq(method, path, body);
  (req as any).userId = userId;
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

async function dispatch(method: string, path: string, body: Record<string, unknown> = {}, userId = 62): Promise<MockRes> {
  return dispatchWithRouter(healthDataRoutes(), method, path, body, userId);
}

describe('Health data routes', () => {
  beforeEach(() => {
    process.env.HEALTH_DATA_ENCRYPTION_KEY = 'health-data-test-master-key';
    testDb = createMigratedTestDatabase();
    clearCacheByPrefix('readiness:');
    clearCacheByPrefix('dashboard-readiness:');
    clearTenantScopeAnomaliesForTests();
  });

  afterEach(() => {
    if (originalHealthEncryptionKey == null) {
      delete process.env.HEALTH_DATA_ENCRYPTION_KEY;
    } else {
      process.env.HEALTH_DATA_ENCRYPTION_KEY = originalHealthEncryptionKey;
    }
    testDb?.close();
  });

  it('stores expanded Apple Health composition and metabolic metrics in daily summary', async () => {
    const res = await dispatch('POST', '/sync', {
      date: '2026-04-16',
      hrvMs: 72,
      restingHeartRate: 48,
      totalSleepMinutes: 472,
      deepSleepMinutes: 88,
      remSleepMinutes: 96,
      bodyMassKg: 72.3,
      bodyFatPercentage: 14.8,
      leanBodyMassKg: 61.6,
      basalCalories: 1710,
      exerciseMinutes: 64,
      workouts: [
        {
          workoutActivityType: 'HKWorkoutActivityTypeRunning',
          start: '2026-04-16T06:30:00.000Z',
          end: '2026-04-16T07:15:00.000Z',
          durationMinutes: 45,
          source: 'Apple Watch',
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);

    const summaryRow = testDb.prepare(`
      SELECT data_json, encrypted_data_json
      FROM apple_health_data
      WHERE user_id = ? AND date = ? AND data_type = 'daily_summary'
    `).get(62, '2026-04-16') as { data_json: string; encrypted_data_json: string | null } | undefined;

    expect(summaryRow).toBeTruthy();
    expect(summaryRow!.data_json).toBe('{"encrypted":true}');
    expect(summaryRow!.encrypted_data_json).toEqual(expect.any(String));
    expect(summaryRow!.encrypted_data_json).not.toContain('72.3');
    expect(summaryRow!.encrypted_data_json).not.toContain('bodyMassKg');
    const summary = parseAppleHealthDataJson(summaryRow!, 62);
    expect(summary.bodyMassKg).toBe(72.3);
    expect(summary.bodyFatPercentage).toBe(14.8);
    expect(summary.leanBodyMassKg).toBe(61.6);
    expect(summary.basalCalories).toBe(1710);
    expect(summary.exerciseMinutes).toBe(64);
    expect(summary.workoutsCount).toBe(1);
  });

  it('invalidates dashboard home cache after syncing health data', async () => {
    testDb.prepare(`
      INSERT INTO api_cache (cache_key, value_json, expires_at)
      VALUES (?, ?, datetime('now', '+1 hour'))
    `).run('dashboard-home:62:pt-BR', JSON.stringify({ stale: true }));

    const res = await dispatch('POST', '/sync', {
      date: '2026-04-16',
      hrvMs: 72,
    });

    expect(res.statusCode).toBe(200);

    const staleRow = testDb.prepare(
      'SELECT cache_key FROM api_cache WHERE cache_key = ?',
    ).get('dashboard-home:62:pt-BR');

    expect(staleRow).toBeUndefined();
  });

  it('rejects impossible biometric values before storing health data', async () => {
    const res = await dispatch('POST', '/sync', {
      date: '2026-04-16',
      hrvMs: 500,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.message).toMatch(/hrvMs/);
  });

  it('rejects future and stale HealthKit dates', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const stale = new Date(Date.now() - 500 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const futureRes = await dispatch('POST', '/sync', { date: future, hrvMs: 72 });
    expect(futureRes.statusCode).toBe(400);
    expect(futureRes.body.error.message).toMatch(/future/);

    const staleRes = await dispatch('POST', '/sync', { date: stale, hrvMs: 72 });
    expect(staleRes.statusCode).toBe(400);
    expect(staleRes.body.error.message).toMatch(/too old/);
  });

  it('rejects inconsistent sleep stages and oversized workout sources', async () => {
    const badSleep = await dispatch('POST', '/sync', {
      date: '2026-04-16',
      totalSleepMinutes: 300,
      deepSleepMinutes: 220,
      remSleepMinutes: 180,
    });
    expect(badSleep.statusCode).toBe(400);
    expect(badSleep.body.error.message).toMatch(/sleep stage/);

    const badWorkout = await dispatch('POST', '/sync', {
      date: '2026-04-16',
      workouts: [{
        workoutActivityType: 'HKWorkoutActivityTypeRunning',
        start: '2026-04-16T06:30:00.000Z',
        end: '2026-04-16T07:15:00.000Z',
        durationMinutes: 45,
        source: 'x'.repeat(129),
      }],
    });
    expect(badWorkout.statusCode).toBe(400);
    expect(badWorkout.body.error.message).toMatch(/source/);
  });

  it('keeps readiness calculations isolated between Felipe and Jaqueline Apple Health snapshots', async () => {
    const today = new Date().toISOString().slice(0, 10);

    const felipeSync = await dispatch('POST', '/sync', {
      date: today,
      hrvMs: 88,
      restingHeartRate: 44,
      totalSleepMinutes: 510,
      deepSleepMinutes: 105,
      remSleepMinutes: 110,
      steps: 5200,
      activeCalories: 380,
      exerciseMinutes: 35,
    }, 62);
    expect(felipeSync.statusCode, JSON.stringify(felipeSync.body)).toBe(200);

    const jaquelineSync = await dispatch('POST', '/sync', {
      date: today,
      hrvMs: 24,
      restingHeartRate: 82,
      totalSleepMinutes: 210,
      deepSleepMinutes: 16,
      remSleepMinutes: 22,
      steps: 18000,
      activeCalories: 1250,
      exerciseMinutes: 120,
    }, 63);
    expect(jaquelineSync.statusCode, JSON.stringify(jaquelineSync.body)).toBe(200);

    const felipeReadiness = await getReadiness(62);
    const jaquelineReadiness = await getReadiness(63);

    expect(felipeReadiness.score).toBeGreaterThan(jaquelineReadiness.score);
    expect(felipeReadiness.factors.bodyBattery).not.toBe(jaquelineReadiness.factors.bodyBattery);

    const felipeAgain = await getReadiness(62);
    expect(felipeAgain.score).toBe(felipeReadiness.score);
    expect(felipeAgain.score).not.toBe(jaquelineReadiness.score);
  });

  it('fails closed on invalid tenant scope before syncing health data', async () => {
    const res = await dispatch('POST', '/sync', {
      date: '2026-04-16',
      hrvMs: 72,
    }, 0);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'health_data_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('returns the latest sync from the authoritative created_at schema', async () => {
    const sync = await dispatch('POST', '/sync', {
      date: '2026-04-16',
      hrvMs: 72,
    });
    expect(sync.statusCode).toBe(200);

    const latest = await dispatch('GET', '/latest');

    expect(latest.statusCode, JSON.stringify(latest.body)).toBe(200);
    expect(latest.body).toEqual({
      ok: true,
      types: [expect.objectContaining({
        data_type: 'hrv',
        latest_date: '2026-04-16',
        latest_sync: expect.any(String),
      })],
    });
  });

  it('rate-limits latest reads per authenticated user without sharing the bucket', async () => {
    const originalReadRateLimit = config.ios.readRateLimit;
    config.ios.readRateLimit = 2;

    try {
      const router = healthDataRoutes();
      const first = await dispatchWithRouter(router, 'GET', '/latest', {}, 62);
      const second = await dispatchWithRouter(router, 'GET', '/latest', {}, 62);
      const blocked = await dispatchWithRouter(router, 'GET', '/latest', {}, 62);
      const otherUser = await dispatchWithRouter(router, 'GET', '/latest', {}, 63);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['Retry-After']).toBe(60);
      expect(blocked.body).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Slow down.',
          retryAfter: 60,
        },
      });
      expect(otherUser.statusCode).toBe(200);
      expect(otherUser.body.ok).toBe(true);
    } finally {
      config.ios.readRateLimit = originalReadRateLimit;
    }
  });

  it('advances latest_sync when authoritative same-day data is resynced', async () => {
    const first = await dispatch('POST', '/sync', {
      date: '2026-04-16',
      hrvMs: 70,
    });
    expect(first.statusCode).toBe(200);

    testDb.prepare(`
      UPDATE apple_health_data
         SET created_at = '2000-01-01 00:00:00'
       WHERE user_id = 62 AND date = '2026-04-16' AND data_type = 'hrv'
    `).run();

    const second = await dispatch('POST', '/sync', {
      date: '2026-04-16',
      hrvMs: 71,
    });
    expect(second.statusCode).toBe(200);

    const latest = await dispatch('GET', '/latest');
    expect(latest.statusCode).toBe(200);
    const hrv = latest.body.types.find((row: { data_type: string }) => row.data_type === 'hrv');
    expect(hrv.latest_sync).not.toBe('2000-01-01 00:00:00');
  });

  it('keeps latest-sync compatibility with the legacy synced_at schema', async () => {
    testDb.exec(`
      DROP TABLE apple_health_data;
      CREATE TABLE apple_health_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        data_type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'ios_app',
        synced_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, date, data_type)
      );
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, synced_at)
      VALUES (62, '2026-04-15', 'steps', '{"value": 1000}', '2026-04-15 12:00:00');
    `);

    const latest = await dispatch('GET', '/latest');

    expect(latest.statusCode, JSON.stringify(latest.body)).toBe(200);
    expect(latest.body.types).toEqual([{
      data_type: 'steps',
      latest_date: '2026-04-15',
      latest_sync: '2026-04-15 12:00:00',
    }]);
  });

  it('prefers authoritative created_at when both timestamp columns exist', async () => {
    const sync = await dispatch('POST', '/sync', {
      date: '2026-04-16',
      hrvMs: 72,
    });
    expect(sync.statusCode).toBe(200);
    testDb.exec(`
      ALTER TABLE apple_health_data ADD COLUMN synced_at TEXT;
      UPDATE apple_health_data
         SET created_at = '2026-04-16 12:00:00',
             synced_at = '2099-01-01 00:00:00'
       WHERE user_id = 62 AND data_type = 'hrv';
    `);

    const latest = await dispatch('GET', '/latest');

    expect(latest.statusCode, JSON.stringify(latest.body)).toBe(200);
    expect(latest.body.types).toEqual([expect.objectContaining({
      data_type: 'hrv',
      latest_sync: '2026-04-16 12:00:00',
    })]);
  });

  it('sanitizes latest-query failures instead of leaking database internals', async () => {
    testDb.close();

    const res = await dispatch('GET', '/latest');

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('Query failed');
    expect(JSON.stringify(res.body)).not.toContain('database');
  });
});
