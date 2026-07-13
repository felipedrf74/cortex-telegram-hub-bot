import { beforeEach, describe, expect, it, afterEach, vi } from 'vitest';
import type { Request } from 'express';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

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
import { getReadiness } from '../../src/api/routes/training-read-models';
import { clearCacheByPrefix } from '../../src/services/cache-store';
import { parseAppleHealthDataJson } from '../../src/services/apple-health-encryption';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on runtime state we don't need here.
      }
    }
  }
}

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
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

async function dispatch(method: string, path: string, body: Record<string, unknown> = {}, userId = 62): Promise<MockRes> {
  const router = healthDataRoutes();
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

describe('Health data routes', () => {
  beforeEach(() => {
    process.env.HEALTH_DATA_ENCRYPTION_KEY = 'health-data-test-master-key';
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
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
