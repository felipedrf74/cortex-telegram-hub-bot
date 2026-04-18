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

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
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
}));

import { healthDataRoutes } from '../../src/api/routes/health-data';

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
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();
  });

  afterEach(() => {
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
      SELECT data_json
      FROM apple_health_data
      WHERE user_id = ? AND date = ? AND data_type = 'daily_summary'
    `).get(62, '2026-04-16') as { data_json: string } | undefined;

    expect(summaryRow).toBeTruthy();
    const summary = JSON.parse(summaryRow!.data_json);
    expect(summary.bodyMassKg).toBe(72.3);
    expect(summary.bodyFatPercentage).toBe(14.8);
    expect(summary.leanBodyMassKg).toBe(61.6);
    expect(summary.basalCalories).toBe(1710);
    expect(summary.exerciseMinutes).toBe(64);
    expect(summary.workoutsCount).toBe(1);
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
});
