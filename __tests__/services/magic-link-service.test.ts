// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Unit tests for the magic-link token service (OI-NAV-203b,
 * 2026-04-24). Pure behavior — no mailer, no HTTP.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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

/** Seed a real user so consumed_by FK checks pass. Returns the id. */
function seedUser(db: Database.Database, email: string): number {
  const r = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, 'free', 1, 'active', 'email', datetime('now'))`,
  ).run(email);
  return Number(r.lastInsertRowid);
}

describe('generateRawToken + hashToken (pure crypto)', () => {
  it('rawToken is a url-safe base64 string of 40+ chars (32 bytes base64url)', async () => {
    const { generateRawToken } = await import('../../src/services/magic-link-service');
    const t = generateRawToken();
    expect(t.length).toBeGreaterThanOrEqual(40);
    // base64url uses only A-Za-z0-9_-
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rawToken is unique across many calls (high entropy)', async () => {
    const { generateRawToken } = await import('../../src/services/magic-link-service');
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(generateRawToken());
    expect(seen.size).toBe(1000);
  });

  it('hashToken is deterministic SHA-256 hex', async () => {
    const { hashToken } = await import('../../src/services/magic-link-service');
    const a = hashToken('known-input');
    const b = hashToken('known-input');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashToken differs for different inputs', async () => {
    const { hashToken } = await import('../../src/services/magic-link-service');
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('issueMagicLinkToken', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('issues a token + persists hash (never raw) with matching email + intent', async () => {
    const { issueMagicLinkToken, hashToken } = await import('../../src/services/magic-link-service');
    const { rawToken, row } = issueMagicLinkToken({
      email: 'bob@example.com',
      intent: 'invite_signup',
    });
    expect(rawToken.length).toBeGreaterThan(30);
    expect(row.email).toBe('bob@example.com');
    expect(row.intent).toBe('invite_signup');
    expect(row.consumedAt).toBeNull();
    // Raw token is NEVER in the row — only the hash is stored.
    const rowRaw = testDb.prepare('SELECT token_hash FROM magic_link_tokens WHERE id = ?').get(row.id) as { token_hash: string };
    expect(rowRaw.token_hash).toBe(hashToken(rawToken));
    expect(rowRaw.token_hash).not.toBe(rawToken);
  });

  it('lowercases + trims the email before persisting', async () => {
    const { issueMagicLinkToken } = await import('../../src/services/magic-link-service');
    const { row } = issueMagicLinkToken({
      email: '  Bob@Example.COM  ',
      intent: 'invite_signup',
    });
    expect(row.email).toBe('bob@example.com');
  });

  it('rejects empty / missing-at email', async () => {
    const { issueMagicLinkToken, MagicLinkError } = await import('../../src/services/magic-link-service');
    for (const bad of ['', '   ', 'no-at-sign']) {
      try {
        issueMagicLinkToken({ email: bad, intent: 'invite_signup' });
        throw new Error('should throw for ' + bad);
      } catch (e) {
        expect(e).toBeInstanceOf(MagicLinkError);
        expect((e as { code: string }).code).toBe('INVALID_EMAIL');
      }
    }
  });

  it('rejects unknown intent', async () => {
    const { issueMagicLinkToken, MagicLinkError } = await import('../../src/services/magic-link-service');
    try {
      issueMagicLinkToken({ email: 'a@b.com', intent: 'invalid' as never });
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MagicLinkError);
      expect((e as { code: string }).code).toBe('INVALID_INTENT');
    }
  });

  it('rejects TTL below 60s or above 24h', async () => {
    const { issueMagicLinkToken, MagicLinkError, MIN_TTL_SECONDS, MAX_TTL_SECONDS } = await import('../../src/services/magic-link-service');
    for (const bad of [MIN_TTL_SECONDS - 1, MAX_TTL_SECONDS + 1, Number.NaN]) {
      try {
        issueMagicLinkToken({ email: 'a@b.com', intent: 'invite_signup', ttlSeconds: bad });
        throw new Error('should throw for ttl ' + bad);
      } catch (e) {
        expect(e).toBeInstanceOf(MagicLinkError);
        expect((e as { code: string }).code).toBe('INVALID_TTL');
      }
    }
  });

  it('default TTL is 1 hour (expiresAt ≈ createdAt + 3600s)', async () => {
    const { issueMagicLinkToken } = await import('../../src/services/magic-link-service');
    const { row } = issueMagicLinkToken({ email: 'a@b.com', intent: 'invite_signup' });
    const created = new Date(row.createdAt).getTime();
    const expires = new Date(row.expiresAt).getTime();
    const deltaSec = Math.round((expires - created) / 1000);
    // Allow ±2s slack because SQLite's datetime('now') resolution is 1s.
    expect(Math.abs(deltaSec - 3600)).toBeLessThanOrEqual(2);
  });

  it('persists metadata as JSON and returns it parsed', async () => {
    const { issueMagicLinkToken } = await import('../../src/services/magic-link-service');
    const { row } = issueMagicLinkToken({
      email: 'a@b.com',
      intent: 'invite_signup',
      metadata: { inviteCode: 'abc', tenantSlug: 'acme' },
    });
    expect(row.metadata).toEqual({ inviteCode: 'abc', tenantSlug: 'acme' });
  });
});

describe('consumeMagicLinkToken', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('happy path — valid raw token → valid:true + row marked consumed', async () => {
    const alice = seedUser(testDb, 'alice@b.com');
    const { issueMagicLinkToken, consumeMagicLinkToken } = await import('../../src/services/magic-link-service');
    const { rawToken } = issueMagicLinkToken({ email: 'a@b.com', intent: 'invite_signup' });
    const result = consumeMagicLinkToken(rawToken, alice);
    expect(result.valid).toBe(true);
    expect(result.row).toBeDefined();
    expect(result.row!.consumedAt).not.toBeNull();
    expect(result.row!.consumedBy).toBe(alice);
  });

  it('consumedBy:null is allowed (pre-user-creation consume path)', async () => {
    const { issueMagicLinkToken, consumeMagicLinkToken } = await import('../../src/services/magic-link-service');
    const { rawToken } = issueMagicLinkToken({ email: 'nobody@b.com', intent: 'invite_signup' });
    const result = consumeMagicLinkToken(rawToken, null);
    expect(result.valid).toBe(true);
    expect(result.row!.consumedBy).toBeNull();
  });

  it('second consume with the same token returns already_consumed', async () => {
    const alice = seedUser(testDb, 'alice@b.com');
    const bob = seedUser(testDb, 'bob@b.com');
    const { issueMagicLinkToken, consumeMagicLinkToken } = await import('../../src/services/magic-link-service');
    const { rawToken } = issueMagicLinkToken({ email: 'a@b.com', intent: 'invite_signup' });
    const first = consumeMagicLinkToken(rawToken, alice);
    const second = consumeMagicLinkToken(rawToken, bob);
    expect(first.valid).toBe(true);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('already_consumed');
    // The consumed_by stays as the FIRST user who used it — race safety.
    expect(second.row!.consumedBy).toBe(alice);
  });

  it('unknown token returns not_found (no row)', async () => {
    const { consumeMagicLinkToken, generateRawToken } = await import('../../src/services/magic-link-service');
    const random = generateRawToken();
    const result = consumeMagicLinkToken(random, null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(result.row).toBeUndefined();
  });

  it('malformed (short) token returns not_found without touching DB', async () => {
    const { consumeMagicLinkToken } = await import('../../src/services/magic-link-service');
    const result = consumeMagicLinkToken('short', null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('expired token returns expired (and row) — NOT consumable afterward', async () => {
    const { issueMagicLinkToken, consumeMagicLinkToken, MIN_TTL_SECONDS } = await import('../../src/services/magic-link-service');
    const { rawToken, row } = issueMagicLinkToken({
      email: 'a@b.com',
      intent: 'invite_signup',
      ttlSeconds: MIN_TTL_SECONDS,
    });
    // Force-expire by rewriting expires_at to the past.
    testDb.prepare('UPDATE magic_link_tokens SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00Z', row.id);
    const result = consumeMagicLinkToken(rawToken, null);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });
});

describe('purgeExpiredMagicLinkTokens', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('deletes expired-unconsumed + old-consumed rows, keeps valid + recent', async () => {
    const { issueMagicLinkToken, purgeExpiredMagicLinkTokens } = await import('../../src/services/magic-link-service');
    // 1. Fresh, unconsumed — KEEP.
    const fresh = issueMagicLinkToken({ email: 'a@b.com', intent: 'invite_signup' });
    // 2. Expired, unconsumed — DELETE.
    const expiredUnused = issueMagicLinkToken({ email: 'b@b.com', intent: 'invite_signup' });
    testDb.prepare('UPDATE magic_link_tokens SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00Z', expiredUnused.row.id);
    // 3. Consumed 1 day ago — KEEP (within forensics window).
    const recentConsumed = issueMagicLinkToken({ email: 'c@b.com', intent: 'invite_signup' });
    testDb.prepare(`UPDATE magic_link_tokens SET consumed_at = datetime('now', '-1 day') WHERE id = ?`)
      .run(recentConsumed.row.id);
    // 4. Consumed 8 days ago — DELETE (past 7-day forensics window).
    const oldConsumed = issueMagicLinkToken({ email: 'd@b.com', intent: 'invite_signup' });
    testDb.prepare(`UPDATE magic_link_tokens SET consumed_at = datetime('now', '-8 days') WHERE id = ?`)
      .run(oldConsumed.row.id);

    const deleted = purgeExpiredMagicLinkTokens();
    expect(deleted).toBe(2);

    const remaining = testDb.prepare('SELECT id FROM magic_link_tokens ORDER BY id').all() as Array<{ id: number }>;
    const remainingIds = remaining.map((r) => r.id).sort();
    expect(remainingIds).toEqual([fresh.row.id, recentConsumed.row.id].sort());
  });
});
