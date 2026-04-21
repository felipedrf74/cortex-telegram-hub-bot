import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

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
  acquireCostLock: vi.fn(async () => () => { /* no-op */ }),
}));

vi.mock('../../src/services/invoice-filer', () => ({
  analyzeInvoiceImage: vi.fn(),
}));

import { financeRoutes } from '../../src/api/routes/finance';
import { config } from '../../src/config';
import { getOrCreateUser } from '../../src/services/user-service';
import { addTransaction, calculateAndStoreTax } from '../../src/services/finance-tracker';
import { analyzeInvoiceImage } from '../../src/services/invoice-filer';

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
    clearTenantScopeAnomaliesForTests();
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

  it('returns preferredCurrency with monthly summary for dashboard consumers', async () => {
    const user = getOrCreateUser(22011, { username: 'finance-currency' });

    addTransaction(user.id, '2024-04-02', 'income', 3200, { currency: 'EUR' });
    addTransaction(user.id, '2024-04-05', 'expense', 187, { currency: 'EUR' });
    addTransaction(user.id, '2024-04-08', 'expense', 40, { currency: 'BRL' });

    const res = await dispatch('GET', '/monthly-summary?month=2024-04', user.id);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.summary.month).toBe('2024-04');
    expect(res.body.data.preferredCurrency).toBe('EUR');
  });

  it('fails closed on invalid tenant scope before loading transactions', async () => {
    const res = await dispatch('GET', '/transactions', 0);

    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'finance_route',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
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

  it('falls back to OCR-hint parsing when no vision provider is configured', async () => {
    const user = getOrCreateUser(22005, { username: 'finance-ocr-fallback' });
    const previousAnthropic = config.anthropic.apiKey;
    const previousGemini = config.gemini.apiKey;
    const previousOpenAI = config.openai.apiKey;
    config.anthropic.apiKey = '';
    config.gemini.apiKey = '';
    config.openai.apiKey = '';

    try {
      const res = await dispatch('POST', '/parse-receipt', user.id, {
        imageBase64: 'ZmFrZQ==',
        mimeType: 'image/jpeg',
        ocrHint: [
          '40 REI DO KEBAB',
          'MARIA JOAO BORREGO UNIP. LDA',
          'Fatura simplificada FS 002/30180',
          '2026-04-10 21:07:37',
          'Total',
          'e 28.50',
        ].join('\n'),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.model).toBe('ocr_hint_fallback');
      expect(res.body.data.parsed.merchant).toBe('Rei Do Kebab');
      expect(res.body.data.parsed.date).toBe('2026-04-10');
      expect(res.body.data.parsed.amount).toBe(28.5);
      expect(res.body.data.parsed.currency).toBe('EUR');
      expect(res.body.data.parsed.category).toBe('food');
      expect(res.body.data.verificationNote).toContain('OCR');
    } finally {
      config.anthropic.apiKey = previousAnthropic;
      config.gemini.apiKey = previousGemini;
      config.openai.apiKey = previousOpenAI;
    }
  });

  it('accepts OCR-only fallback parsing when no vision provider is configured', async () => {
    const user = getOrCreateUser(22006, { username: 'finance-ocr-only' });
    const previousAnthropic = config.anthropic.apiKey;
    const previousGemini = config.gemini.apiKey;
    const previousOpenAI = config.openai.apiKey;
    config.anthropic.apiKey = '';
    config.gemini.apiKey = '';
    config.openai.apiKey = '';

    try {
      const res = await dispatch('POST', '/parse-receipt', user.id, {
        ocrHint: [
          '40 REI DO KEBAB',
          'MARIA JOAO BORREGO UNIP. LDA',
          'Fatura simplificada FS 002/30180',
          '2026-04-10 21:07:37',
          'Total',
          'e 28.50',
        ].join('\n'),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.model).toBe('ocr_hint_fallback');
      expect(res.body.data.parsed.merchant).toBe('Rei Do Kebab');
      expect(res.body.data.parsed.amount).toBe(28.5);
      expect(res.body.data.parsed.currency).toBe('EUR');
    } finally {
      config.anthropic.apiKey = previousAnthropic;
      config.gemini.apiKey = previousGemini;
      config.openai.apiKey = previousOpenAI;
    }
  });

  it('prefers the last monetary value on noisy OCR total lines', async () => {
    const user = getOrCreateUser(22007, { username: 'finance-ocr-noisy-total' });
    const previousAnthropic = config.anthropic.apiKey;
    const previousGemini = config.gemini.apiKey;
    const previousOpenAI = config.openai.apiKey;
    config.anthropic.apiKey = '';
    config.gemini.apiKey = '';
    config.openai.apiKey = '';

    try {
      const res = await dispatch('POST', '/parse-receipt', user.id, {
        ocrHint: [
          '40 REI DO KEBAB',
          'Fatura simplificada FS 002/30180',
          '13.00 25.14 3.26 28.40',
          '23.00 0.08 0.02 0.10',
          'Total 25.22 3.28 28.50',
          '2026-04-10 21:07:37',
        ].join('\n'),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.parsed.amount).toBe(28.5);
      expect(res.body.data.parsed.currency).toBe('EUR');
    } finally {
      config.anthropic.apiKey = previousAnthropic;
      config.gemini.apiKey = previousGemini;
      config.openai.apiKey = previousOpenAI;
    }
  });

  it('parses the live Portuguese OCR dump from the receipt capture flow', async () => {
    const user = getOrCreateUser(22008, { username: 'finance-live-ocr' });
    const previousAnthropic = config.anthropic.apiKey;
    const previousGemini = config.gemini.apiKey;
    const previousOpenAI = config.openai.apiKey;
    config.anthropic.apiKey = '';
    config.gemini.apiKey = '';
    config.openai.apiKey = '';

    try {
      const res = await dispatch('POST', '/parse-receipt', user.id, {
        ocrHint: [
          '40 REI DO KEBAB',
          'MARIA JOAO BORREGO UNIP. LDA',
          'Rua Agostinho da Silva Lt 10 -Arroteias',
          '2860-165 Alhos vedros',
          'Tel.',
          'N. Contrib. 517093278',
          'Registo na Cons. n.',
          'Capital Social',
          'mjborrego1967@gmail.com',
          'N.C. 517736438',
          'Fatura simplificada FS 002/30180',
          'Original',
          '2026-04-10 21:07:37',
          'Qt Artigo',
          'IV',
          'Total',
          '2 Drum Vitela',
          '1 SACO UBER',
          '2 HAMB C OVO',
          '13',
          '23',
          '13',
          'e',
          '12.80',
          'e 0.10',
          'e',
          '15.60',
          'Total',
          'e',
          '28.50',
          'Taxa',
          'Base',
          'IVA',
          'Total',
          '13.00',
          '23.00',
          'e',
          ': 25.14',
          'e 0.08',
          'e 3.26',
          'e 0.02',
          'e',
          '28.40',
          'e 0.10',
          'Total',
          'e 25.22',
          'e 3.28',
          'e',
          '28.50',
        ].join('\n'),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.parsed.merchant).toBe('Rei Do Kebab');
      expect(res.body.data.parsed.date).toBe('2026-04-10');
      expect(res.body.data.parsed.amount).toBe(28.5);
      expect(res.body.data.parsed.currency).toBe('EUR');
      expect(res.body.data.parsed.category).toBe('food');
    } finally {
      config.anthropic.apiKey = previousAnthropic;
      config.gemini.apiKey = previousGemini;
      config.openai.apiKey = previousOpenAI;
    }
  });

  it('falls back to OCR parsing when all AI receipt providers fail but OCR text is available', async () => {
    const user = getOrCreateUser(22009, { username: 'finance-ai-error-fallback' });
    vi.mocked(analyzeInvoiceImage).mockRejectedValueOnce(
      new Error('All providers failed for invoice_filing'),
    );

    const res = await dispatch('POST', '/parse-receipt', user.id, {
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W1XkAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      ocrHint: [
        '40 REI DO KEBAB',
        'MARIA JOAO BORREGO UNIP. LDA',
        '2026-04-10 21:07:37',
        'Total',
        'e',
        '28.50',
      ].join('\n'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.model).toBe('ocr_hint_fallback_after_ai_error');
    expect(res.body.data.parsed.merchant).toBe('Rei Do Kebab');
    expect(res.body.data.parsed.date).toBe('2026-04-10');
    expect(res.body.data.parsed.amount).toBe(28.5);
    expect(res.body.data.parsed.currency).toBe('EUR');
  });

  it('merges OCR fields when the AI parse is incomplete', async () => {
    const user = getOrCreateUser(22010, { username: 'finance-ai-partial-merge' });
    vi.mocked(analyzeInvoiceImage).mockResolvedValueOnce({
      provider: 'gemini-2.5-flash',
      analysis: {
        vendor: null,
        documentDate: null,
        totalAmount: null,
        confidence: 0.04,
        validationNote: null,
      },
    } as any);

    const res = await dispatch('POST', '/parse-receipt', user.id, {
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W1XkAAAAASUVORK5CYII=',
      mimeType: 'image/png',
      ocrHint: [
        '40 REI DO KEBAB',
        'MARIA JOAO BORREGO UNIP. LDA',
        'Fatura simplificada FS 002/30180',
        '2026-04-10 21:07:37',
        'Total',
        'e 28.50',
      ].join('\n'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.model).toBe('gemini-2.5-flash');
    expect(res.body.data.parsed.merchant).toBe('Rei Do Kebab');
    expect(res.body.data.parsed.date).toBe('2026-04-10');
    expect(res.body.data.parsed.amount).toBe(28.5);
    expect(res.body.data.parsed.currency).toBe('EUR');
    expect(res.body.data.parsed.confidence).toBeGreaterThan(0.4);
    expect(res.body.data.verificationNote).toContain('OCR');
  });
});
