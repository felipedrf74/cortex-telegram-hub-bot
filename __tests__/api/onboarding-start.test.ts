import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    }
  }
}

import { onboardingRoutes } from '../../src/api/routes/onboarding';
import { getActiveSession } from '../../src/services/onboarding';

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

function expectOk(res: MockRes): void {
  if (res.statusCode !== 200) {
    throw new Error(`Expected 200 but got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  }
}

async function dispatch(
  method: 'GET' | 'POST',
  url: string,
  userId: number,
  body?: any,
): Promise<MockRes> {
  const router = onboardingRoutes();
  const segments = url.split('?')[0].split('/').filter(Boolean);
  const req = {
    userId,
    body: body ?? {},
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: url.split('?')[0],
    query: {},
    params: {} as Record<string, string>,
    headers: {},
  } as unknown as Request;

  if (segments[0] && !['pending', 'profile'].includes(segments[0])) {
    (req as any).params.questionnaireId = segments[0];
  }

  const res = mockRes();
  await new Promise<void>((resolve) => {
    (router as any).handle(req, res as unknown as Response, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Onboarding questionnaire start flow', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('POST /:questionnaireId/start starts a fresh questionnaire for a new user', async () => {
    const res = await dispatch('POST', '/fitness/start', 1401);

    expectOk(res);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.id).toBe('fitness');
    expect(res.body.data.currentStep).toBe(0);
    expect(res.body.data.steps.length).toBeGreaterThan(0);

    const session = getActiveSession(1401, 'fitness');
    expect(session).not.toBeNull();
    expect(session?.current_step).toBe(0);
  });

  it('GET /:questionnaireId implicitly starts the session so the first answer works for fresh users', async () => {
    const questionnaire = await dispatch('GET', '/fitness', 1402);
    expectOk(questionnaire);
    expect(questionnaire.body.ok).toBe(true);
    expect(questionnaire.body.data.currentStep).toBe(0);

    const answer = await dispatch('POST', '/fitness/answer', 1402, {
      stepIndex: 0,
      answer: 'Intermediate (1-3 years)',
    });

    expectOk(answer);
    expect(answer.body.ok).toBe(true);
    expect(answer.body.data.isComplete).toBe(false);
    expect(answer.body.data.nextStep.field).toBe('weekly_frequency');

    const session = getActiveSession(1402, 'fitness');
    expect(session).not.toBeNull();
    expect(session?.current_step).toBe(1);
    expect(session?.answers.experience_level).toBe('Intermediate (1-3 years)');
  });
});
