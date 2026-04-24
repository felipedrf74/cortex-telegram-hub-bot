// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for tenant-invite-service.
 *
 * Pins:
 *   - createInvite generates a unique invite_code and a pending row.
 *   - Duplicate pending invites for (tenant, email) are rejected via
 *     the partial-unique index → DUPLICATE_PENDING.
 *   - acceptInvite requires matching email (EMAIL_MISMATCH otherwise).
 *   - acceptInvite is atomic: membership + invite status update
 *     happen in a transaction; a second accept returns ALREADY_ACCEPTED.
 *   - revokeInvite only works on pending rows.
 *   - Expired invites are lazy-marked on access.
 *   - Listings are correctly scoped (tenant-wide for admin, email
 *     for invitee) — no cross-tenant / cross-email leakage.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;


// OI-UX-106 rebase cleanup: prevent this file's vi.mock('services/database')
// from polluting later test files in the shared vitest fork (the project's
// vitest.config.ts sets `poolOptions.forks.singleFork: true`, which runs every
// test file in one process and keeps module mocks alive across files unless
// explicitly cleared). doUnmock + resetModules together mark the mock inert
// AND flush the cached version, so the next file's `import { getDb }` hits
// either its own mock or the real module.
afterAll(() => {
  vi.doUnmock('../../src/services/database');
  vi.doUnmock('../../src/utils/logger');
  vi.resetModules();
});

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       id INTEGER PRIMARY KEY,
       filename TEXT UNIQUE,
       applied_at TEXT DEFAULT (datetime('now'))
     )`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch {
      // Skip incompatible migrations in harness.
    }
  }
}

function seedUser(db: Database.Database, email: string, tier = 'free'): number {
  const r = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, 1, 'active', 'email', datetime('now'))`,
  ).run(email, tier);
  const uid = Number(r.lastInsertRowid);
  db.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, ?)`,
  ).run(uid, `user-${uid}`, email, tier);
  db.prepare(
    `INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`,
  ).run(uid, uid);
  return uid;
}

import {
  createInvite,
  getInviteById,
  getInviteByCode,
  listInvitesForTenant,
  listPendingForEmail,
  acceptInvite,
  revokeInvite,
  InviteError,
} from '../../src/services/tenant-invite-service';
import { getMembership } from '../../src/services/tenant-service';

describe('tenant-invite-service — create', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('creates a pending invite with a unique invite_code', () => {
    const admin = seedUser(testDb, 'admin@e.com');
    const inv = createInvite({
      tenantId: admin, email: 'alice@e.com', role: 'tenant_member', createdBy: admin,
    });
    expect(inv.status).toBe('pending');
    expect(inv.tenantId).toBe(admin);
    expect(inv.email).toBe('alice@e.com');
    expect(inv.role).toBe('tenant_member');
    expect(inv.inviteCode.length).toBeGreaterThanOrEqual(30);
    expect(inv.createdBy).toBe(admin);
  });

  it('rejects a second pending invite for the same (tenant, email)', () => {
    const admin = seedUser(testDb, 'admin2@e.com');
    createInvite({ tenantId: admin, email: 'bob@e.com', role: 'tenant_member', createdBy: admin });
    try {
      createInvite({ tenantId: admin, email: 'bob@e.com', role: 'tenant_admin', createdBy: admin });
      expect.fail('expected DUPLICATE_PENDING');
    } catch (e) {
      expect((e as InviteError).code).toBe('DUPLICATE_PENDING');
    }
  });

  it('allows a new invite after the first one is revoked', () => {
    const admin = seedUser(testDb, 'admin3@e.com');
    const first = createInvite({ tenantId: admin, email: 'charlie@e.com', role: 'tenant_member', createdBy: admin });
    revokeInvite(first.id, admin);
    const second = createInvite({ tenantId: admin, email: 'charlie@e.com', role: 'tenant_admin', createdBy: admin });
    expect(second.status).toBe('pending');
    expect(second.id).not.toBe(first.id);
  });

  it('normalizes email to lowercase', () => {
    const admin = seedUser(testDb, 'admin4@e.com');
    const inv = createInvite({ tenantId: admin, email: 'MIXED@E.COM', role: 'tenant_member', createdBy: admin });
    expect(inv.email).toBe('mixed@e.com');
  });

  it('rejects malformed emails', () => {
    const admin = seedUser(testDb, 'admin5@e.com');
    expect(() => createInvite({
      tenantId: admin, email: 'not-an-email', role: 'tenant_member', createdBy: admin,
    })).toThrow(InviteError);
  });
});

describe('tenant-invite-service — listings', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('listInvitesForTenant returns tenant-scoped invites only', () => {
    const aliceAdmin = seedUser(testDb, 'alice-admin@e.com');
    const bobAdmin = seedUser(testDb, 'bob-admin@e.com');
    createInvite({ tenantId: aliceAdmin, email: 'guest-a@e.com', role: 'tenant_member', createdBy: aliceAdmin });
    createInvite({ tenantId: bobAdmin, email: 'guest-b@e.com', role: 'tenant_member', createdBy: bobAdmin });

    const aInvites = listInvitesForTenant(aliceAdmin).map((i) => i.email);
    const bInvites = listInvitesForTenant(bobAdmin).map((i) => i.email);
    expect(aInvites).toEqual(['guest-a@e.com']);
    expect(bInvites).toEqual(['guest-b@e.com']);
  });

  it('listPendingForEmail matches only pending + exact email', () => {
    const admin = seedUser(testDb, 'admin@e.com');
    const pending = createInvite({ tenantId: admin, email: 'target@e.com', role: 'tenant_member', createdBy: admin });
    const other = createInvite({ tenantId: admin, email: 'other@e.com', role: 'tenant_member', createdBy: admin });
    revokeInvite(other.id, admin);

    const matches = listPendingForEmail('target@e.com');
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(pending.id);
    expect(listPendingForEmail('other@e.com')).toHaveLength(0);   // revoked
    expect(listPendingForEmail('random@e.com')).toHaveLength(0);  // never existed
  });

  it('listPendingForEmail is case-insensitive on input AND storage', () => {
    const admin = seedUser(testDb, 'admin@e.com');
    createInvite({ tenantId: admin, email: 'CaseSensitive@E.COM', role: 'tenant_member', createdBy: admin });
    const hits = listPendingForEmail('casesensitive@e.com');
    expect(hits).toHaveLength(1);
  });
});

describe('tenant-invite-service — accept', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('creates a tenant_members row + marks invite accepted atomically', () => {
    const admin = seedUser(testDb, 'alice@e.com');
    const bob = seedUser(testDb, 'bob@e.com');
    const inv = createInvite({ tenantId: admin, email: 'bob@e.com', role: 'tenant_member', createdBy: admin });

    const accepted = acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob@e.com' });
    expect(accepted.status).toBe('accepted');
    expect(accepted.acceptedBy).toBe(bob);

    // Membership row exists.
    const member = getMembership(admin, bob);
    expect(member).not.toBeNull();
    expect(member?.role).toBe('tenant_member');
  });

  it('rejects acceptance when email does not match', () => {
    const admin = seedUser(testDb, 'alice2@e.com');
    const bob = seedUser(testDb, 'bob2@e.com');
    const inv = createInvite({ tenantId: admin, email: 'someone-else@e.com', role: 'tenant_member', createdBy: admin });

    try {
      acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob2@e.com' });
      expect.fail('expected EMAIL_MISMATCH');
    } catch (e) {
      expect((e as InviteError).code).toBe('EMAIL_MISMATCH');
    }
    // Membership must NOT have been created.
    expect(getMembership(admin, bob)).toBeNull();
  });

  it('returns ALREADY_ACCEPTED on a second accept attempt', () => {
    const admin = seedUser(testDb, 'alice3@e.com');
    const bob = seedUser(testDb, 'bob3@e.com');
    const inv = createInvite({ tenantId: admin, email: 'bob3@e.com', role: 'tenant_member', createdBy: admin });
    acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob3@e.com' });
    try {
      acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob3@e.com' });
      expect.fail('expected ALREADY_ACCEPTED');
    } catch (e) {
      expect((e as InviteError).code).toBe('ALREADY_ACCEPTED');
    }
  });

  it('rejects REVOKED invites', () => {
    const admin = seedUser(testDb, 'alice4@e.com');
    const bob = seedUser(testDb, 'bob4@e.com');
    const inv = createInvite({ tenantId: admin, email: 'bob4@e.com', role: 'tenant_member', createdBy: admin });
    revokeInvite(inv.id, admin);
    try {
      acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob4@e.com' });
      expect.fail('expected REVOKED');
    } catch (e) {
      expect((e as InviteError).code).toBe('REVOKED');
    }
  });

  it('returns NOT_FOUND for a non-existent code', () => {
    const bob = seedUser(testDb, 'bob5@e.com');
    try {
      acceptInvite({ code: 'nonexistent-16-chars-long-enough', userId: bob, userEmail: 'bob5@e.com' });
      expect.fail('expected NOT_FOUND');
    } catch (e) {
      expect((e as InviteError).code).toBe('NOT_FOUND');
    }
  });

  it('lazy-marks expired invites and refuses acceptance', () => {
    const admin = seedUser(testDb, 'alice6@e.com');
    const bob = seedUser(testDb, 'bob6@e.com');
    // Expire 10 seconds ago.
    const past = new Date(Date.now() - 10_000).toISOString();
    const inv = createInvite({
      tenantId: admin, email: 'bob6@e.com', role: 'tenant_member', createdBy: admin, expiresAt: past,
    });
    try {
      acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob6@e.com' });
      expect.fail('expected EXPIRED');
    } catch (e) {
      expect((e as InviteError).code).toBe('EXPIRED');
    }
    // Row should now be status='expired'.
    const after = getInviteById(inv.id);
    expect(after?.status).toBe('expired');
  });

  it('accept grants the role specified in the invite, not the default', () => {
    const admin = seedUser(testDb, 'alice7@e.com');
    const bob = seedUser(testDb, 'bob7@e.com');
    const inv = createInvite({ tenantId: admin, email: 'bob7@e.com', role: 'tenant_viewer', createdBy: admin });
    acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob7@e.com' });
    expect(getMembership(admin, bob)?.role).toBe('tenant_viewer');
  });

  it('idempotent membership upsert: user pre-existing as member gets no duplicate row', () => {
    const admin = seedUser(testDb, 'alice8@e.com');
    const bob = seedUser(testDb, 'bob8@e.com');
    // Bob is already a member somehow.
    testDb.prepare(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`,
    ).run(admin, bob);
    const inv = createInvite({ tenantId: admin, email: 'bob8@e.com', role: 'tenant_admin', createdBy: admin });
    acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob8@e.com' });
    // Exactly one membership row (accept is INSERT OR IGNORE — does not upgrade role).
    const members = testDb
      .prepare('SELECT COUNT(*) as c FROM tenant_members WHERE tenant_id = ? AND user_id = ?')
      .get(admin, bob) as { c: number };
    expect(members.c).toBe(1);
  });
});

describe('tenant-invite-service — revoke', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('marks status=revoked on a pending invite', () => {
    const admin = seedUser(testDb, 'alice@e.com');
    const inv = createInvite({ tenantId: admin, email: 'bob@e.com', role: 'tenant_member', createdBy: admin });
    const revoked = revokeInvite(inv.id, admin);
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedBy).toBe(admin);
  });

  it('refuses to revoke an already-accepted invite', () => {
    const admin = seedUser(testDb, 'alice2@e.com');
    const bob = seedUser(testDb, 'bob2@e.com');
    const inv = createInvite({ tenantId: admin, email: 'bob2@e.com', role: 'tenant_member', createdBy: admin });
    acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob2@e.com' });
    try {
      revokeInvite(inv.id, admin);
      expect.fail('expected ALREADY_ACCEPTED');
    } catch (e) {
      expect((e as InviteError).code).toBe('ALREADY_ACCEPTED');
    }
  });

  it('is idempotent on a second revoke', () => {
    const admin = seedUser(testDb, 'alice3@e.com');
    const inv = createInvite({ tenantId: admin, email: 'bob3@e.com', role: 'tenant_member', createdBy: admin });
    revokeInvite(inv.id, admin);
    const second = revokeInvite(inv.id, admin);
    expect(second.status).toBe('revoked');
  });

  it('NOT_FOUND on unknown invite id', () => {
    const admin = seedUser(testDb, 'alice4@e.com');
    try {
      revokeInvite(99999, admin);
      expect.fail('expected NOT_FOUND');
    } catch (e) {
      expect((e as InviteError).code).toBe('NOT_FOUND');
    }
  });
});
