// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Unit tests for session-revocation-service + the tenant-suspend
 * cascade wired by OI-ADM-302c (2026-04-24).
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
function seedUser(db: Database.Database, email: string): number {
  const r = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, 'free', 1, 'active', 'email', datetime('now'))`,
  ).run(email);
  const uid = Number(r.lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, 'free')`)
    .run(uid, `tenant-${uid}`, `Tenant ${uid}`);
  db.prepare(`INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`)
    .run(uid, uid);
  return uid;
}

describe('revokeSessionsForUser (OI-ADM-302c)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('inserts a session_revocations row with reason + actor + details', async () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const { revokeSessionsForUser } = await import('../../src/services/session-revocation-service');
    const row = revokeSessionsForUser(alice, {
      reason: 'tenant.suspend',
      actorUserId: alice,
      details: { tenantId: alice, note: 'testing' },
    });
    expect(row.userId).toBe(alice);
    expect(row.reason).toBe('tenant.suspend');
    expect(row.actorUserId).toBe(alice);
    expect(row.details).toEqual({ tenantId: alice, note: 'testing' });
    expect(row.revokedAtEpochSeconds).toBeGreaterThan(0);
  });

  it('rejects non-positive user ids with INVALID_USER_ID', async () => {
    const { revokeSessionsForUser, SessionRevocationError } = await import('../../src/services/session-revocation-service');
    for (const bad of [0, -1, Number.NaN]) {
      try {
        revokeSessionsForUser(bad, { reason: 'test' });
        throw new Error('should have thrown for ' + bad);
      } catch (e) {
        expect(e).toBeInstanceOf(SessionRevocationError);
        expect((e as { code: string }).code).toBe('INVALID_USER_ID');
      }
    }
  });

  it('multiple revocations accumulate (append-only ledger)', async () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const { revokeSessionsForUser, listRevocationsForUser } = await import('../../src/services/session-revocation-service');
    revokeSessionsForUser(alice, { reason: 'password.reset' });
    revokeSessionsForUser(alice, { reason: 'tenant.suspend' });
    revokeSessionsForUser(alice, { reason: 'security.incident' });
    const rows = listRevocationsForUser(alice);
    expect(rows.length).toBe(3);
    // Newest-first order.
    expect(rows[0].reason).toBe('security.incident');
    expect(rows[2].reason).toBe('password.reset');
  });
});

describe('revokeSessionsForTenant — cascades to every member (OI-ADM-302c)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('inserts one revocation per tenant_members row', async () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const bob = seedUser(testDb, 'bob@e.com');
    // Add bob as a member of alice's tenant.
    testDb.prepare(
      `INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role)
       VALUES (?, ?, 'tenant_member')`,
    ).run(alice, bob);
    const { revokeSessionsForTenant } = await import('../../src/services/session-revocation-service');
    const rows = revokeSessionsForTenant(alice, {
      reason: 'tenant.suspend',
      actorUserId: alice,
    });
    expect(rows.length).toBe(2);
    const userIds = rows.map((r) => r.userId).sort((x, y) => x - y);
    expect(userIds).toEqual([alice, bob].sort((x, y) => x - y));
  });

  it('returns [] when tenant has no members (defensive — solo-tenant convention should prevent this)', async () => {
    const { revokeSessionsForTenant } = await import('../../src/services/session-revocation-service');
    const rows = revokeSessionsForTenant(99999, { reason: 'test' });
    expect(rows).toEqual([]);
  });

  it('rejects invalid tenant ids with INVALID_TENANT_ID', async () => {
    const { revokeSessionsForTenant, SessionRevocationError } = await import('../../src/services/session-revocation-service');
    try {
      revokeSessionsForTenant(0, { reason: 'test' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SessionRevocationError);
      expect((e as { code: string }).code).toBe('INVALID_TENANT_ID');
    }
  });
});

describe('isTokenRevoked (hot path) (OI-ADM-302c)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('returns false when user has no revocations', async () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const { isTokenRevoked } = await import('../../src/services/session-revocation-service');
    // iat of 1 hour ago in unix seconds.
    const iat = Math.floor(Date.now() / 1000) - 3600;
    expect(isTokenRevoked(alice, iat)).toBe(false);
  });

  it('returns true when iat is earlier than the user\'s latest revocation', async () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const { revokeSessionsForUser, isTokenRevoked } = await import('../../src/services/session-revocation-service');
    // Plant a revocation NOW.
    revokeSessionsForUser(alice, { reason: 'tenant.suspend' });
    // A JWT issued 1 hour BEFORE now has iat = now - 3600 → older than revocation → revoked.
    const iat = Math.floor(Date.now() / 1000) - 3600;
    expect(isTokenRevoked(alice, iat)).toBe(true);
  });

  it('returns false when iat is AFTER the latest revocation (new token minted post-revoke)', async () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const { revokeSessionsForUser, isTokenRevoked } = await import('../../src/services/session-revocation-service');
    revokeSessionsForUser(alice, { reason: 'tenant.suspend' });
    // Simulate a JWT minted 1 minute in the FUTURE (newer than revocation).
    const iat = Math.floor(Date.now() / 1000) + 60;
    expect(isTokenRevoked(alice, iat)).toBe(false);
  });

  it('returns true for missing / non-numeric iat (fail closed)', async () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const { isTokenRevoked } = await import('../../src/services/session-revocation-service');
    expect(isTokenRevoked(alice, undefined)).toBe(true);
    expect(isTokenRevoked(alice, 'not-a-number')).toBe(true);
    expect(isTokenRevoked(alice, Number.NaN)).toBe(true);
    expect(isTokenRevoked(alice, null)).toBe(true);
  });

  it('only the LATEST revocation matters (append-only reads the max id)', async () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const { revokeSessionsForUser, isTokenRevoked } = await import('../../src/services/session-revocation-service');
    // First revocation at t1.
    revokeSessionsForUser(alice, { reason: 'password.reset' });
    // Simulate issuing a JWT AFTER t1 → would be valid against only-the-first.
    const iat = Math.floor(Date.now() / 1000) + 1;
    // But a SECOND revocation comes in AFTER that iat.
    // (Force a future revoked_at so the test is deterministic regardless of SQLite clock resolution.)
    testDb.prepare(
      `INSERT INTO session_revocations (user_id, revoked_at, reason)
       VALUES (?, datetime('now', '+1 hour'), 'tenant.suspend')`,
    ).run(alice);
    expect(isTokenRevoked(alice, iat)).toBe(true);
  });
});

describe('suspendTenant cascade writes session_revocations (OI-ADM-302c integration)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('suspendTenant inserts session_revocations rows for every member', async () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const bob = seedUser(testDb, 'bob@e.com');
    testDb.prepare(
      `INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role)
       VALUES (?, ?, 'tenant_member')`,
    ).run(alice, bob);
    const { suspendTenant } = await import('../../src/services/tenant-service');
    suspendTenant(alice, alice, 'non-payment');
    const rows = testDb.prepare(
      "SELECT user_id, reason FROM session_revocations WHERE reason = 'tenant.suspend' ORDER BY user_id",
    ).all() as Array<{ user_id: number; reason: string }>;
    expect(rows.map((r) => r.user_id).sort((x, y) => x - y)).toEqual([alice, bob].sort((x, y) => x - y));
  });

  it('cascade failure does NOT block the status transition (fail-safe)', async () => {
    // Drop the session_revocations table to simulate a broken cascade.
    const alice = seedUser(testDb, 'alice@e.com');
    testDb.exec('DROP TABLE session_revocations');
    const { suspendTenant, getTenantById } = await import('../../src/services/tenant-service');
    // The suspend should still succeed (transition completes, warning logged).
    expect(() => suspendTenant(alice, alice, 'test')).not.toThrow();
    expect(getTenantById(alice)?.status).toBe('suspended');
  });

  it('activateTenant does NOT issue new revocations (cascade is one-way for security)', async () => {
    // Reactivating a tenant should NOT issue FRESH revocations — the
    // existing ones stay as audit, and new JWTs minted post-activate
    // are valid because their iat is after the latest revocation.
    const alice = seedUser(testDb, 'alice@e.com');
    const { suspendTenant, activateTenant } = await import('../../src/services/tenant-service');
    suspendTenant(alice, alice, 'test');
    const countAfterSuspend = (testDb.prepare('SELECT COUNT(*) AS n FROM session_revocations').get() as { n: number }).n;
    activateTenant(alice, alice);
    const countAfterActivate = (testDb.prepare('SELECT COUNT(*) AS n FROM session_revocations').get() as { n: number }).n;
    expect(countAfterActivate).toBe(countAfterSuspend);
  });
});
