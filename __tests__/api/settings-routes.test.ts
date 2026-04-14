import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations rely on runtime services not needed here.
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

function mockReq(userId: number, body: any): Request {
  return {
    userId,
    body,
    headers: {},
    header() { return undefined; },
  } as any;
}

async function dispatchLanguage(userId: number, language: string): Promise<MockRes> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = mockReq(userId, { language });
  (req as any).method = 'POST';
  (req as any).url = '/language';
  (req as any).originalUrl = '/language';
  (req as any).baseUrl = '';
  (req as any).path = '/language';
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

describe('Settings language route', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    testDb.prepare(`
      INSERT INTO users (id, first_name, language, status, auth_provider)
      VALUES (1, 'Beta Tester', 'pt-BR', 'active', 'invite_code')
    `).run();

    vi.resetModules();
    vi.doMock('../../src/services/database', () => ({
      getDb: () => testDb,
    }));
    vi.doMock('../../src/utils/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }));
    vi.doMock('../../src/services/user-service', () => ({
      setUserLanguage: (userId: number, language: string) => {
        testDb.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, userId);
      },
    }));
  });

  it('accepts iOS short english code and stores canonical english', async () => {
    const res = await dispatchLanguage(1, 'en');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.language).toBe('en-US');

    const row = testDb.prepare('SELECT language FROM users WHERE id = 1').get() as { language: string };
    expect(row.language).toBe('en-US');
  });

  it('accepts portuguese from portugal and preserves pt-PT', async () => {
    const res = await dispatchLanguage(1, 'pt-PT');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.language).toBe('pt-PT');

    const row = testDb.prepare('SELECT language FROM users WHERE id = 1').get() as { language: string };
    expect(row.language).toBe('pt-PT');
  });

  it('accepts generic portuguese alias and stores canonical pt-BR', async () => {
    const res = await dispatchLanguage(1, 'pt');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.language).toBe('pt-BR');

    const row = testDb.prepare('SELECT language FROM users WHERE id = 1').get() as { language: string };
    expect(row.language).toBe('pt-BR');
  });
});
