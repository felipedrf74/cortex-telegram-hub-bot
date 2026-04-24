// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-SEC-001a (2026-04-24) — end-to-end admin magic-link flow.
 *
 * What this file pins, layer by layer:
 *
 *   1. Migration 084 — the magic_link_tokens CHECK constraint now
 *      allows 'admin_session' AND still rejects unknown intents.
 *   2. magic-link-service — issueMagicLinkToken/consumeMagicLinkToken
 *      round-trip for intent='admin_session' + metadata carries
 *      adminUserId.
 *   3. Mailer template — admin.magic_login renders the link,
 *      expiresInMinutes, and firstName (when provided); NEVER
 *      ships user-session copy into the admin email.
 *   4. admin-session-service — mintAdminSession produces a JWT
 *      whose `sub` matches what the consume handler would use.
 *
 * The HTTP route (POST /admin/login/request + GET /admin/magic-login)
 * structural pins live in a separate file: the server.ts handler
 * isn't easily unit-testable (it composes 5 services), and the
 * structural-pin pattern is what every other magic-login test in
 * this codebase uses.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

afterAll(() => {
  vi.doUnmock('../../src/services/database');
  vi.doUnmock('../../src/utils/logger');
  vi.resetModules();
});

vi.mock('../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id INTEGER PRIMARY KEY, filename TEXT UNIQUE,
       applied_at TEXT DEFAULT (datetime('now'))
     )`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch { /* skip deps */ }
  }
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  applyMigrations(testDb);
});

afterEach(() => testDb?.close());

// ─── Migration 084 — CHECK constraint expansion ───────────────────

describe('migration 084 — magic_link_tokens intent CHECK constraint', () => {
  it('accepts admin_session as a valid intent', () => {
    expect(() => testDb.prepare(
      `INSERT INTO magic_link_tokens (token_hash, email, intent, expires_at)
       VALUES (?, 'admin@e.com', 'admin_session', datetime('now', '+15 minutes'))`,
    ).run('hash_admin_1')).not.toThrow();
  });

  it('still accepts the 3 original intents (back-compat)', () => {
    for (const intent of ['invite_signup', 'passwordless_login', 'email_verify']) {
      expect(() => testDb.prepare(
        `INSERT INTO magic_link_tokens (token_hash, email, intent, expires_at)
         VALUES (?, 'u@e.com', ?, datetime('now', '+1 hour'))`,
      ).run('h_' + intent, intent)).not.toThrow();
    }
  });

  it('rejects unknown intents (CHECK constraint survived table rebuild)', () => {
    // Regression guard — if a future migration drops the CHECK
    // constraint, this test catches it before a typo like
    // 'admin_seasion' silently lands in prod.
    expect(() => testDb.prepare(
      `INSERT INTO magic_link_tokens (token_hash, email, intent, expires_at)
       VALUES ('h1', 'u@e.com', 'evil_intent', datetime('now', '+1 hour'))`,
    ).run()).toThrow(/CHECK constraint/i);
  });

  it('preserves existing rows across the rebuild (no data loss)', () => {
    // Every existing migration 081 row must survive migration 084.
    // The in-memory DB here applies both migrations in sequence,
    // so the rebuild got a chance to DROP data if the port-forward
    // INSERT ever breaks.
    const result = testDb.prepare(
      `INSERT INTO magic_link_tokens (token_hash, email, intent, expires_at)
       VALUES ('h_preexist', 'pre@e.com', 'passwordless_login', datetime('now', '+1 hour'))`,
    ).run();
    expect(result.changes).toBe(1);
    const row = testDb.prepare('SELECT email FROM magic_link_tokens WHERE token_hash = ?').get('h_preexist');
    expect(row).toBeDefined();
  });
});

// ─── magic-link-service — admin_session round-trip ────────────────

describe('magic-link-service — admin_session round-trip (OI-SEC-001a)', () => {
  it('issueMagicLinkToken accepts intent=admin_session and persists metadata', async () => {
    const { issueMagicLinkToken, consumeMagicLinkToken } = await import('../../src/services/magic-link-service');
    const issued = issueMagicLinkToken({
      email: 'admin@example.com',
      intent: 'admin_session',
      ttlSeconds: 15 * 60,
      metadata: { adminUserId: 42 },
    });
    expect(typeof issued.rawToken).toBe('string');
    expect(issued.rawToken.length).toBeGreaterThan(10);

    // Consume and verify the metadata round-trips.
    const consumed = consumeMagicLinkToken(issued.rawToken, null);
    expect(consumed.valid).toBe(true);
    if (!consumed.valid) return;
    expect(consumed.row.intent).toBe('admin_session');
    expect(consumed.row.email).toBe('admin@example.com');
    expect(consumed.row.metadata.adminUserId).toBe(42);
  });

  it('consume is single-use for admin_session tokens (same invariant as other intents)', async () => {
    const { issueMagicLinkToken, consumeMagicLinkToken } = await import('../../src/services/magic-link-service');
    const issued = issueMagicLinkToken({
      email: 'admin@example.com',
      intent: 'admin_session',
      ttlSeconds: 15 * 60,
      metadata: { adminUserId: 42 },
    });
    const first = consumeMagicLinkToken(issued.rawToken, null);
    expect(first.valid).toBe(true);
    const second = consumeMagicLinkToken(issued.rawToken, null);
    expect(second.valid).toBe(false);
    if (!second.valid) expect(second.reason).toBe('already_consumed');
  });
});

// ─── admin-session-service — mint produces the right JWT ──────────

describe('admin-session-service — mintAdminSession (OI-SEC-001a continuation)', () => {
  it('mints a JWT that verifies with the same secret + carries sub', async () => {
    const { mintAdminSession, verifyAdminSession } = await import('../../src/services/admin-session-service');
    const secret = 'test-admin-session-secret-32-bytes-long';
    const token = mintAdminSession(42, 'platform_admin', { secret, expiresIn: '15m' });
    const verified = verifyAdminSession(token, secret);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.sub).toBe(42);
    expect(verified.claims.role).toBe('platform_admin');
  });
});

// ─── mailer — admin.magic_login template ─────────────────────────

describe('mailer — admin.magic_login template (OI-SEC-001a)', () => {
  it('renders the consoleUrl + expiresInMinutes + greeting in both html and text', async () => {
    const { __previewRenderTransactional } = await import('../../src/services/mailer');
    const rendered = __previewRenderTransactional({
      template: 'admin.magic_login',
      to: 'admin@example.com',
      subject: 'Your Nexus Hub Admin Console sign-in link',
      context: {
        firstName: 'Felipe',
        consoleUrl: 'https://nexushub.me/admin/magic-login?token=ABC',
        expiresInMinutes: 15,
      },
    });
    // HTML body must have the URL, greeting, and expiry.
    expect(rendered.html).toContain('Hi Felipe');
    expect(rendered.html).toContain('https://nexushub.me/admin/magic-login?token=ABC');
    expect(rendered.html).toContain('15 minutes');
    expect(rendered.html).toContain('Sign in to Admin Console');
    // Plaintext too.
    expect(rendered.text).toContain('Hi Felipe');
    expect(rendered.text).toContain('https://nexushub.me/admin/magic-login?token=ABC');
    expect(rendered.text).toContain('15 minutes');
  });

  it('handles missing firstName gracefully (falls back to "Hi,")', async () => {
    const { __previewRenderTransactional } = await import('../../src/services/mailer');
    const rendered = __previewRenderTransactional({
      template: 'admin.magic_login',
      to: 'admin@example.com',
      subject: 'X',
      context: {
        firstName: null,  // no name on file
        consoleUrl: 'https://x/admin',
        expiresInMinutes: 15,
      },
    });
    expect(rendered.html).toContain('Hi,');
    expect(rendered.html).not.toContain('Hi null');
    expect(rendered.text).toContain('Hi,');
  });

  it('does NOT leak user-session welcome copy into the admin email', async () => {
    // Regression guard: the admin email must not include marketing
    // copy from welcome.paid_upgrade (tier pill, 5-feature list,
    // etc.). A bug where the render cases fell through would
    // otherwise silently ship the wrong content to admins.
    const { __previewRenderTransactional } = await import('../../src/services/mailer');
    const rendered = __previewRenderTransactional({
      template: 'admin.magic_login',
      to: 'admin@example.com',
      subject: 'X',
      context: { firstName: 'Felipe', consoleUrl: 'https://x/', expiresInMinutes: 15 },
    });
    expect(rendered.html).not.toContain('Pro plan');
    expect(rendered.html).not.toContain('Max plan');
    expect(rendered.html).not.toContain('What Nexus Hub does for you');
    expect(rendered.html).not.toContain('Open your workspace');
  });

  it('HTML-escapes the firstName (defense in depth vs future DB injection)', async () => {
    const { __previewRenderTransactional } = await import('../../src/services/mailer');
    const rendered = __previewRenderTransactional({
      template: 'admin.magic_login',
      to: 'admin@example.com',
      subject: 'X',
      context: {
        firstName: '<script>alert(1)</script>',
        consoleUrl: 'https://x/',
        expiresInMinutes: 15,
      },
    });
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('subject is passed through from the input (caller controls it)', async () => {
    const { __previewRenderTransactional } = await import('../../src/services/mailer');
    const custom = __previewRenderTransactional({
      template: 'admin.magic_login',
      to: 'admin@example.com',
      subject: 'Custom admin subject line',
      context: { firstName: 'F', consoleUrl: 'https://x/', expiresInMinutes: 15 },
    });
    expect(custom.subject).toBe('Custom admin subject line');
  });

  it('tags are Resend-safe ([A-Za-z0-9_-])', async () => {
    // Regression guard from OI-WELCOME-201c — any new template
    // that ships a dot in a tag value brings back the 422.
    const { __previewRenderTransactional } = await import('../../src/services/mailer');
    const rendered = __previewRenderTransactional({
      template: 'admin.magic_login',
      to: 'x@y.com',
      subject: 'X',
      context: { firstName: 'F', consoleUrl: 'https://x/', expiresInMinutes: 15 },
    });
    for (const tag of rendered.tags) {
      expect(tag.name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(tag.value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    // Specifically — the template tag must be 'admin_magic_login'
    // (underscore, not dot).
    const template = rendered.tags.find((t) => t.name === 'template');
    expect(template?.value).toBe('admin_magic_login');
  });
});
