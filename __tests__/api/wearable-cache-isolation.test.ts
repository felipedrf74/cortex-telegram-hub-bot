import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
const mockGetDailySummary = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/wearable', () => ({
  getDailySummary: (...args: unknown[]) => mockGetDailySummary(...args),
  getReadiness: vi.fn(),
  getSleep: vi.fn(),
  getUserProviders: vi.fn(),
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

import { wearableRoutes } from '../../src/api/routes/wearable';
import {
  getCached,
  initCacheStore,
  requireUserCacheKey,
} from '../../src/services/cache-store';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some unrelated migrations require tables not present in this harness.
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
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; return res; },
  };
  return res;
}

async function dispatch(userId: number, pathValue: string): Promise<MockRes> {
  const parsed = new URL(pathValue, 'http://test.local');
  const router = wearableRoutes();
  const req = {
    userId,
    method: 'GET',
    url: parsed.pathname + parsed.search,
    originalUrl: parsed.pathname + parsed.search,
    baseUrl: '',
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
    params: {},
    headers: {},
  } as any as Request;
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

describe('Wearable cache tenant isolation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
    initCacheStore();
    mockGetDailySummary.mockReset();
    mockGetDailySummary.mockImplementation(async (userId: number, date: string) => ({
      provider: 'test-provider',
      ownerLabel: `tenant-${userId}`,
      date,
    }));
  });

  afterEach(() => {
    testDb?.close();
  });

  it('keys cached health summaries by tenant so account switching cannot reuse stale data', async () => {
    const pathValue = '/summary?date=2026-04-22';

    const forA = await dispatch(401, pathValue);
    const forB = await dispatch(402, pathValue);
    const forAAgain = await dispatch(401, pathValue);

    expect(forA.body.data.summary.ownerLabel).toBe('tenant-401');
    expect(forB.body.data.summary.ownerLabel).toBe('tenant-402');
    expect(JSON.stringify(forB.body)).not.toContain('tenant-401');
    expect(forAAgain.body.data.summary.ownerLabel).toBe('tenant-401');
    expect(forAAgain.body.cached).toBe(true);
    expect(mockGetDailySummary).toHaveBeenCalledTimes(2);
    expect(getCached(requireUserCacheKey(401, 'wearable:summary:2026-04-22'))).toMatchObject({
      summary: { ownerLabel: 'tenant-401' },
    });
    expect(getCached(requireUserCacheKey(402, 'wearable:summary:2026-04-22'))).toMatchObject({
      summary: { ownerLabel: 'tenant-402' },
    });
  });

  it('refuses to build app-facing cache keys without a valid tenant user id', () => {
    expect(() => requireUserCacheKey(0, 'wearable:summary:2026-04-22')).toThrow(
      'Invalid tenant user id',
    );
    expect(() => requireUserCacheKey(Number.NaN, 'wearable:summary:2026-04-22')).toThrow(
      'Invalid tenant user id',
    );
  });
});
