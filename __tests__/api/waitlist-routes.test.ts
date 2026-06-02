import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

const hoisted = vi.hoisted(() => ({
  sendBetaWaitlistConfirmation: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    waitlist: { confirmationTtlHours: 24 },
  },
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/email-sender', () => ({
  isEmailConfigured: () => true,
  isFiscalBundleDeliveryConfigured: vi.fn(() => false),
  sendBetaInviteEmail: vi.fn(),
  sendBetaWaitlistConfirmation: (...args: unknown[]) => hoisted.sendBetaWaitlistConfirmation(...args),
  sendFiscalBundleEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendVerificationCode: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]) => hoisted.loggerInfo(...args),
    error: (...args: unknown[]) => hoisted.loggerError(...args),
    debug: vi.fn(),
    warn: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { _resetRateLimiterForTests, createWaitlistRouter } from '../../src/api/routes/waitlist';

function applyMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime(\'now\')))');
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* unrelated migration dependency not needed here */ }
    }
  }
}

async function requestWaitlist(pathname: string, init: RequestInit = {}): Promise<{
  status: number;
  body: any;
  text: string;
  headers: Headers;
}> {
  const app = express();
  app.use('/waitlist', createWaitlistRouter());
  const server = app.listen(0);
  const address = server.address() as { port: number };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, init);
    const text = await response.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, body, text, headers: response.headers };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('public waitlist routes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv('WAITLIST_SKIP_MX_CHECK', '1');
    vi.stubEnv('WAITLIST_IP_SALT', 'stable-test-salt');
    hoisted.sendBetaWaitlistConfirmation.mockResolvedValue(true);
    testDb = new Database(':memory:');
    applyMigrations(testDb);
    _resetRateLimiterForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testDb.close();
  });

  it('stores a hashed confirmation token and confirms it without logging the raw email', async () => {
    const res = await requestWaitlist('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://nexushub.me' },
      body: JSON.stringify({ email: 'Felipe@Test.Example', intent: 'founder', source: 'hero' }),
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'confirmation_required' });
    const row = testDb.prepare('SELECT * FROM waitlist WHERE email = ?').get('felipe@test.example') as any;
    expect(row.email_hash).toHaveLength(64);
    expect(row.confirmation_token_hash).toHaveLength(64);
    expect(row.email_confirmed_at).toBeNull();
    expect(row.email_delivery_status).toBe('confirmation_pending');

    const confirmationUrl = hoisted.sendBetaWaitlistConfirmation.mock.calls[0][1] as string;
    const token = new URL(confirmationUrl).searchParams.get('token')!;
    expect(token).not.toBe(row.confirmation_token_hash);

    const confirm = await requestWaitlist(`/waitlist/confirm?token=${encodeURIComponent(token)}`);
    expect(confirm.status).toBe(200);
    const confirmed = testDb.prepare('SELECT * FROM waitlist WHERE email = ?').get('felipe@test.example') as any;
    expect(confirmed.email_confirmed_at).toBeTruthy();
    expect(confirmed.confirmation_token_hash).toBeNull();
    expect(confirmed.email_delivery_status).toBe('confirmed');

    expect(JSON.stringify(hoisted.loggerInfo.mock.calls)).not.toContain('felipe@test.example');
  });

  it('rejects disposable domains before storing a row', async () => {
    const res = await requestWaitlist('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://nexushub.me' },
      body: JSON.stringify({ email: 'person@mailinator.com' }),
    });

    expect(res.status).toBe(400);
    const count = (testDb.prepare('SELECT COUNT(*) AS count FROM waitlist').get() as any).count;
    expect(count).toBe(0);
    expect(hoisted.sendBetaWaitlistConfirmation).not.toHaveBeenCalled();
  });

  it('rejects invalid email syntax before storing a row', async () => {
    const res = await requestWaitlist('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://nexushub.me' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'Please enter a valid email address.' });
    expect((testDb.prepare('SELECT COUNT(*) AS count FROM waitlist').get() as any).count).toBe(0);
  });

  it('rate limits by visitor network before storing more rows', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await requestWaitlist('/waitlist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://nexushub.me',
          'CF-Connecting-IP': '203.0.113.10',
        },
        body: JSON.stringify({ email: `person-${i}@example.com` }),
      });
      expect(res.status).toBe(200);
    }

    const limited = await requestWaitlist('/waitlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://nexushub.me',
        'CF-Connecting-IP': '203.0.113.10',
      },
      body: JSON.stringify({ email: 'person-4@example.com' }),
    });

    expect(limited.status).toBe(429);
    expect(limited.body.error).toContain('Too many signups');
  });

  it('rate limits repeated submissions for the same normalized email', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await requestWaitlist('/waitlist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://nexushub.me',
          'CF-Connecting-IP': `203.0.113.${20 + i}`,
        },
        body: JSON.stringify({ email: 'repeat@example.com' }),
      });
      expect(res.status).toBe(200);
    }

    const limited = await requestWaitlist('/waitlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://nexushub.me',
        'CF-Connecting-IP': '203.0.113.99',
      },
      body: JSON.stringify({ email: 'repeat@example.com' }),
    });

    expect(limited.status).toBe(429);
    expect(limited.body.error).toContain('Too many signups for this email');
  });

  it('returns 409 when founder slots are exhausted', async () => {
    const insert = testDb.prepare(`
      INSERT INTO waitlist (email, intent, status, founder_slot)
      VALUES (?, 'founder', 'pending', ?)
    `);
    for (let i = 1; i <= 100; i += 1) {
      insert.run(`founder-${i}@example.com`, i);
    }

    const res = await requestWaitlist('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://nexushub.me' },
      body: JSON.stringify({ email: 'late-founder@example.com', intent: 'founder' }),
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('founder_slots_exhausted');
    expect(hoisted.sendBetaWaitlistConfirmation).not.toHaveBeenCalled();
  });

  it('rejects expired confirmation tokens', async () => {
    const res = await requestWaitlist('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://nexushub.me' },
      body: JSON.stringify({ email: 'expire@example.com' }),
    });
    expect(res.status).toBe(200);
    const confirmationUrl = hoisted.sendBetaWaitlistConfirmation.mock.calls[0][1] as string;
    const token = new URL(confirmationUrl).searchParams.get('token')!;
    testDb.prepare(`
      UPDATE waitlist
         SET confirmation_expires_at = datetime('now', '-1 minute')
       WHERE email = ?
    `).run('expire@example.com');

    const confirm = await requestWaitlist(`/waitlist/confirm?token=${encodeURIComponent(token)}`);

    expect(confirm.status).toBe(410);
    expect(confirm.text).toContain('invalid or expired');
  });

  it('marks confirmation delivery failures without confirming the row', async () => {
    hoisted.sendBetaWaitlistConfirmation.mockResolvedValueOnce(false);

    const res = await requestWaitlist('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://nexushub.me' },
      body: JSON.stringify({ email: 'delivery@example.com' }),
    });

    expect(res.status).toBe(502);
    const row = testDb.prepare('SELECT email_delivery_status, last_email_error, email_confirmed_at FROM waitlist WHERE email = ?').get('delivery@example.com') as any;
    expect(row).toMatchObject({
      email_delivery_status: 'confirmation_failed',
      last_email_error: 'send_failed',
      email_confirmed_at: null,
    });
  });

  it('returns CORS preflight headers only for allowed origins', async () => {
    const allowed = await requestWaitlist('/waitlist', {
      method: 'OPTIONS',
      headers: { Origin: 'https://nexushub.me', 'Access-Control-Request-Method': 'POST' },
    });
    const denied = await requestWaitlist('/waitlist', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://nexushub.me');
    expect(denied.status).toBe(204);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});
