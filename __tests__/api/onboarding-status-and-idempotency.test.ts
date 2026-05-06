/**
 * Beta gap 3 (2026-04-24): route-level tests for the onboarding API.
 *
 * Complements __tests__/services/onboarding-idempotency.test.ts — that
 * covers the service layer behavior; this one covers the HTTP surface
 * the iOS client actually talks to, including the new GET /status
 * read-only endpoint and the STEP_MISMATCH / 409 translation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
} from '../../src/services/tenant-scope-observability';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
const mockInvalidateOnboardingDerivedCaches = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/onboarding-cache-invalidator', () => ({
  invalidateOnboardingDerivedCaches: (...args: unknown[]) => mockInvalidateOnboardingDerivedCaches(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
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
import { getActiveSession, startOrResume } from '../../src/services/onboarding';

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

async function dispatch(
  method: 'GET' | 'POST',
  url: string,
  userId: number,
  body?: any,
): Promise<MockRes> {
  const router = onboardingRoutes();
  const [pathPart] = url.split('?');
  const segments = pathPart.split('/').filter(Boolean);

  const req = {
    userId,
    body: body ?? {},
    method,
    url,
    originalUrl: url,
    baseUrl: '',
    path: pathPart,
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

describe('GET /onboarding/:questionnaireId/status', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();
    mockInvalidateOnboardingDerivedCaches.mockReset();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns not_started for a fresh user WITHOUT creating a session', async () => {
    const res = await dispatch('GET', '/fitness/status', 2001);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.state).toBe('not_started');
    expect(res.body.data.currentStep).toBe(0);
    expect(res.body.data.totalSteps).toBeGreaterThan(0);
    // Critical: the read-only check must NOT implicitly start a session.
    // That was the whole point of splitting it from GET /:questionnaireId.
    expect(getActiveSession(2001, 'fitness')).toBeNull();
  });

  it('returns in_progress with the current step when a session exists', async () => {
    startOrResume(2002, 'fitness');
    // Advance one step so currentStep !== 0 and we can tell the two states apart.
    await dispatch('POST', '/fitness/answer', 2002, {
      stepIndex: 0,
      answer: 'Beginner (< 1 year)',
    });

    const res = await dispatch('GET', '/fitness/status', 2002);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.state).toBe('in_progress');
    expect(res.body.data.currentStep).toBe(1);
    expect(res.body.data.answeredKeys).toEqual(['experience_level']);
  });

  it('returns completed once a profile exists', async () => {
    testDb.prepare(`
      INSERT INTO user_profiles (user_id, profile_type, data) VALUES (?, 'fitness', ?)
    `).run(2003, JSON.stringify({ experience_level: 'Beginner (< 1 year)' }));

    const res = await dispatch('GET', '/fitness/status', 2003);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.state).toBe('completed');
    expect(res.body.data.currentStep).toBe(res.body.data.totalSteps);
  });

  it('returns unknown for a questionnaire this server does not define', async () => {
    const res = await dispatch('GET', '/definitely-not-a-real-questionnaire/status', 2004);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.state).toBe('unknown');
  });
});

describe('POST /onboarding/:questionnaireId/answer stepIndex concurrency', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();
    mockInvalidateOnboardingDerivedCaches.mockReset();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('suppresses a duplicate POST carrying the already-consumed stepIndex', async () => {
    startOrResume(3001, 'fitness');
    const first = await dispatch('POST', '/fitness/answer', 3001, {
      stepIndex: 0,
      answer: 'Beginner (< 1 year)',
    });
    expect(first.statusCode).toBe(200);
    expect(first.body.data.currentStep).toBe(1);
    // A proper answer triggers the cache invalidator exactly once.
    expect(mockInvalidateOnboardingDerivedCaches).toHaveBeenCalledTimes(1);

    // Network blip: iOS retries the same POST.
    const replay = await dispatch('POST', '/fitness/answer', 3001, {
      stepIndex: 0,
      answer: 'Advanced (3+ years)',
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.body.data.idempotentReplay).toBe(true);
    expect(replay.body.data.currentStep).toBe(1); // not double-advanced
    expect(getActiveSession(3001, 'fitness')?.answers.experience_level)
      .toBe('Beginner (< 1 year)'); // retry did NOT overwrite

    // Critically: the replay did NOT trigger a second cache invalidation.
    // Downstream coaches/dashboards see one consistent answer, not two
    // churny rebuilds triggered by a retry with no data change.
    expect(mockInvalidateOnboardingDerivedCaches).toHaveBeenCalledTimes(1);
  });

  it('rejects a stepIndex ahead of the server with 409 STEP_MISMATCH and the real server step', async () => {
    startOrResume(3002, 'fitness');
    const res = await dispatch('POST', '/fitness/answer', 3002, {
      stepIndex: 3, // client claims it's on step 3, server is on 0
      answer: 'irrelevant',
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('STEP_MISMATCH');
    expect(res.body.error.details).toMatchObject({
      currentStep: 0,
      clientStep: 3,
    });
    // Server cursor is untouched.
    expect(getActiveSession(3002, 'fitness')?.current_step).toBe(0);
  });
});
