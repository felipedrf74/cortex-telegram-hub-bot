import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/portal/telemetry', () => ({
  getJobStatuses: () => [],
}));

import { contentRoutes } from '../../src/api/routes/content';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // ignore incompatible migrations in unit tests
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
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
  };
  return response;
}

function mockReq(userId: number): Request {
  return {
    userId,
    method: 'GET',
    url: '/ideas',
    originalUrl: '/ideas',
    baseUrl: '',
    path: '/ideas',
    query: {},
    params: {},
    headers: {},
    header: () => undefined,
  } as any;
}

async function dispatch(userId: number): Promise<MockRes> {
  const router = contentRoutes();
  const req = mockReq(userId);
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

describe('Content API — ideas contract', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS content_ideas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        score REAL,
        stage TEXT DEFAULT 'ideas',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns count metadata alongside the ideas list', async () => {
    testDb.prepare(`
      INSERT INTO content_ideas (user_id, title, score, stage, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(41, 'Hybrid athlete workflow', 8.4, 'ideas', '2026-04-17T09:00:00.000Z');
    testDb.prepare(`
      INSERT INTO content_ideas (user_id, title, score, stage, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(41, 'Race-week recovery notes', 7.8, 'scripted', '2026-04-17T10:00:00.000Z');

    const response = await dispatch(41);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.ideas).toHaveLength(2);
    expect(response.body.data.count).toBe(2);
  });

  it('returns a stable empty payload when the ideas query fails', async () => {
    testDb.exec('DROP TABLE content_ideas');

    const response = await dispatch(41);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data).toEqual({ ideas: [], count: 0 });
  });
});
