import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
const mockIsUserOverDailyCap = vi.fn().mockReturnValue({
  over: false,
  spentUsd: 0,
  capUsd: 0.2,
  plan: 'pro',
  resetAt: '2026-04-15T00:00:00.000Z',
});

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    app: { timezone: 'Europe/Lisbon' },
    financeEncryption: { enabled: false },
    anthropic: { apiKey: '' },
    gemini: { apiKey: 'test-key' },
    openai: { apiKey: '' },
  },
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
  buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
}));

vi.mock('../../src/services/invoice-filer', () => ({
  analyzeInvoiceImage: vi.fn(),
}));

import { financeRoutes } from '../../src/api/routes/finance';
import { getOrCreateUser } from '../../src/services/user-service';
import { addTransaction, calculateAndStoreTax } from '../../src/services/finance-tracker';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip incompatible migrations in unit tests */ }
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

function mockReq(userId: number, body?: any): Request {
  return { userId, body } as any;
}

async function dispatch(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  userId: number,
  body?: any,
): Promise<MockRes> {
  const router = financeRoutes();
  const req = mockReq(userId, body);
  (req as any).method = method;
  (req as any).url = url;
  (req as any).originalUrl = url;
  (req as any).baseUrl = '';
  (req as any).path = url.split('?')[0];
  (req as any).query = {};
  (req as any).params = {};
  (req as any).headers = {};

  if (url.includes('?')) {
    const [, queryString] = url.split('?');
    const params = new URLSearchParams(queryString);
    (req as any).query = Object.fromEntries(params.entries());
  }

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

describe('Finance API — tax routes', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    mockIsUserOverDailyCap.mockReset();
    mockIsUserOverDailyCap.mockReturnValue({
      over: false,
      spentUsd: 0,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
  });

  afterEach(() => testDb?.close());

  it('returns annual tax summary for the selected year', async () => {
    const user = getOrCreateUser(22001, { username: 'finance-user' });

    addTransaction(user.id, '2024-01-10', 'income', 10000);
    addTransaction(user.id, '2024-01-11', 'deduction', 1000);
    addTransaction(user.id, '2024-02-10', 'income', 9000);

    calculateAndStoreTax(user.id, '2024-01');
    calculateAndStoreTax(user.id, '2024-02');

    const res = await dispatch('GET', '/tax/annual-summary?year=2024', user.id);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.summary.year).toBe(2024);
    expect(res.body.data.summary.months.length).toBe(2);
    expect(res.body.data.summary.totalTaxDue).toBeGreaterThan(0);
    expect(res.body.data.summary.totalPending).toBe(res.body.data.summary.totalTaxDue);
  });

  it('marks a tax event as paid and returns the updated event', async () => {
    const user = getOrCreateUser(22002, { username: 'finance-paid' });

    addTransaction(user.id, '2024-03-10', 'income', 12000);
    calculateAndStoreTax(user.id, '2024-03');

    const res = await dispatch('POST', '/tax/events/2024-03/pay', user.id, {});

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.updated).toBe(true);
    expect(res.body.data.event.month).toBe('2024-03');
    expect(res.body.data.event.status).toBe('paid');
    expect(res.body.data.event.paid_at).toBeTruthy();
  });

  it('returns 404 when marking a missing tax event as paid', async () => {
    const user = getOrCreateUser(22003, { username: 'finance-missing' });

    const res = await dispatch('POST', '/tax/events/2024-12/pay', user.id, {});

    expect(res.statusCode).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 402 on parse-receipt when the daily AI quota is exhausted', async () => {
    const user = getOrCreateUser(22004, { username: 'finance-quota' });
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.2,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });

    const res = await dispatch('POST', '/parse-receipt', user.id, {
      imageBase64: 'ZmFrZQ==',
      mimeType: 'image/jpeg',
    });

    expect(res.statusCode).toBe(402);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.error.details).toEqual({
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    });
  });
});
