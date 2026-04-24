// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Unit + integration tests for fireWelcomeEmailIfFirstTimePaid
 * (OI-WELCOME-201, 2026-04-24).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;
let mockedSendResult: { delivered: boolean; backend: string } | null = null;
let mockedSendError: Error | null = null;
let sendTransactionalCalls: any[] = [];

afterAll(() => {
  vi.doUnmock('../../src/services/database');
  vi.doUnmock('../../src/utils/logger');
  vi.doUnmock('../../src/services/mailer');
  vi.resetModules();
});

vi.mock('../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));
// Mock the mailer so tests are hermetic — no network, no fetch.
vi.mock('../../src/services/mailer', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/mailer')>('../../src/services/mailer');
  return {
    ...actual,
    sendTransactionalEmail: vi.fn(async (input: any) => {
      sendTransactionalCalls.push(input);
      if (mockedSendError) throw mockedSendError;
      return mockedSendResult || { backend: 'console', delivered: true };
    }),
  };
});

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch { /* skip */ }
  }
}
function seedUser(db: Database.Database, opts: { email?: string | null; tier?: string; firstName?: string | null } = {}): number {
  const r = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, first_name, created_at)
     VALUES (?, ?, 1, 'active', 'email', ?, datetime('now'))`,
  ).run(opts.email ?? null, opts.tier ?? 'free', opts.firstName ?? null);
  return Number(r.lastInsertRowid);
}

describe('fireWelcomeEmailIfFirstTimePaid (OI-WELCOME-201)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    sendTransactionalCalls = [];
    mockedSendResult = null;
    mockedSendError = null;
  });
  afterEach(() => testDb?.close());

  it('sends welcome email when user is on pro tier + has email + no prior send', async () => {
    const alice = seedUser(testDb, { email: 'alice@e.com', tier: 'pro', firstName: 'Alice' });
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    const result = await fireWelcomeEmailIfFirstTimePaid(alice);
    expect(result.sent).toBe(true);
    expect(sendTransactionalCalls.length).toBe(1);
    const call = sendTransactionalCalls[0];
    expect(call.template).toBe('welcome.paid_upgrade');
    expect(call.to).toBe('alice@e.com');
    expect(call.subject).toBe('Welcome to Nexus Hub');
    expect(call.context).toMatchObject({ firstName: 'Alice', tier: 'pro' });
  });

  it('also fires for max tier', async () => {
    const bob = seedUser(testDb, { email: 'bob@e.com', tier: 'max' });
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    const result = await fireWelcomeEmailIfFirstTimePaid(bob);
    expect(result.sent).toBe(true);
    expect(sendTransactionalCalls[0].context.tier).toBe('max');
  });

  it('skips free tier (reason: not_paid_tier)', async () => {
    const carla = seedUser(testDb, { email: 'carla@e.com', tier: 'free' });
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    const result = await fireWelcomeEmailIfFirstTimePaid(carla);
    expect(result).toEqual({ sent: false, reason: 'not_paid_tier' });
    expect(sendTransactionalCalls.length).toBe(0);
  });

  it('skips owner tier (platform owners are not customers)', async () => {
    const dave = seedUser(testDb, { email: 'dave@e.com', tier: 'owner' });
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    const result = await fireWelcomeEmailIfFirstTimePaid(dave);
    expect(result).toEqual({ sent: false, reason: 'not_paid_tier' });
  });

  it('skips when user has no email on file', async () => {
    const eva = seedUser(testDb, { email: null, tier: 'pro' });
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    const result = await fireWelcomeEmailIfFirstTimePaid(eva);
    expect(result).toEqual({ sent: false, reason: 'no_email' });
    expect(sendTransactionalCalls.length).toBe(0);
  });

  it('returns user_not_found for unknown userId', async () => {
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    const result = await fireWelcomeEmailIfFirstTimePaid(99999);
    expect(result).toEqual({ sent: false, reason: 'user_not_found' });
  });

  it('returns user_not_found for invalid userId (0, negative, NaN)', async () => {
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    for (const bad of [0, -1, Number.NaN]) {
      const result = await fireWelcomeEmailIfFirstTimePaid(bad);
      expect(result.sent).toBe(false);
      expect(result.reason).toBe('user_not_found');
    }
  });

  it('writes an audit_trail row on successful send', async () => {
    const frank = seedUser(testDb, { email: 'frank@e.com', tier: 'pro', firstName: 'Frank' });
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    await fireWelcomeEmailIfFirstTimePaid(frank);
    const row = testDb.prepare(
      "SELECT * FROM audit_trail WHERE action = 'welcome_email.sent' AND user_id = ?",
    ).get(frank) as any;
    expect(row).toBeTruthy();
    const details = JSON.parse(row.details);
    expect(details.to).toBe('frank@e.com');
    expect(details.template).toBe('welcome.paid_upgrade');
  });

  it('is idempotent — second call with the same user returns already_sent (no second send)', async () => {
    const grace = seedUser(testDb, { email: 'grace@e.com', tier: 'pro' });
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    const first = await fireWelcomeEmailIfFirstTimePaid(grace);
    const second = await fireWelcomeEmailIfFirstTimePaid(grace);
    expect(first.sent).toBe(true);
    expect(second).toEqual({ sent: false, reason: 'already_sent' });
    expect(sendTransactionalCalls.length).toBe(1); // only ONE send
  });

  it('does NOT write audit row when mailer fails — retry on next call works', async () => {
    const { MailerError } = await import('../../src/services/mailer');
    mockedSendError = new MailerError('SEND_FAILED', 'Resend API returned 500');
    const henry = seedUser(testDb, { email: 'henry@e.com', tier: 'pro' });
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    const first = await fireWelcomeEmailIfFirstTimePaid(henry);
    expect(first.sent).toBe(false);
    expect(first.reason).toBe('send_failed');
    expect(first.error).toBe('SEND_FAILED');
    // No audit row written.
    const row = testDb.prepare(
      "SELECT * FROM audit_trail WHERE action = 'welcome_email.sent' AND user_id = ?",
    ).get(henry) as any;
    expect(row).toBeUndefined();
    // Next call retries (mailer now succeeds).
    mockedSendError = null;
    const second = await fireWelcomeEmailIfFirstTimePaid(henry);
    expect(second.sent).toBe(true);
  });

  it('context includes consoleUrl for the CTA button', async () => {
    const iris = seedUser(testDb, { email: 'iris@e.com', tier: 'pro' });
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    await fireWelcomeEmailIfFirstTimePaid(iris);
    expect(sendTransactionalCalls[0].context.consoleUrl).toMatch(/\/console$/);
  });

  it('firstName falls back to "there" when user has no first_name', async () => {
    const juno = seedUser(testDb, { email: 'juno@e.com', tier: 'pro', firstName: null });
    const { fireWelcomeEmailIfFirstTimePaid } = await import('../../src/services/welcome-email-service');
    await fireWelcomeEmailIfFirstTimePaid(juno);
    expect(sendTransactionalCalls[0].context.firstName).toBe('there');
  });
});

describe('fireWelcomeEmailInBackground — fire-and-forget safety', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    sendTransactionalCalls = [];
    mockedSendResult = null;
    mockedSendError = null;
  });
  afterEach(() => testDb?.close());

  it('synchronous call returns void (no await)', async () => {
    const kyle = seedUser(testDb, { email: 'kyle@e.com', tier: 'pro' });
    const { fireWelcomeEmailInBackground } = await import('../../src/services/welcome-email-service');
    const result = fireWelcomeEmailInBackground(kyle);
    expect(result).toBeUndefined();
  });

  it('errors in the mailer do NOT reject the caller', async () => {
    const { MailerError } = await import('../../src/services/mailer');
    mockedSendError = new MailerError('SEND_FAILED', 'test');
    const liam = seedUser(testDb, { email: 'liam@e.com', tier: 'pro' });
    const { fireWelcomeEmailInBackground } = await import('../../src/services/welcome-email-service');
    // If this throws, the test fails. It should NOT throw.
    fireWelcomeEmailInBackground(liam);
    // Let the microtask queue drain.
    await new Promise((r) => setImmediate(r));
    // No audit row — send failed, but the caller wasn't affected.
    const row = testDb.prepare(
      "SELECT * FROM audit_trail WHERE action = 'welcome_email.sent' AND user_id = ?",
    ).get(liam) as any;
    expect(row).toBeUndefined();
  });
});
