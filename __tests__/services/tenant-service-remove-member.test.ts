// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for `removeMember` — the Phase 2D "kick a member"
 * flow. The three business rules under test:
 *
 *   1. NOT_A_MEMBER: target must actually have a membership row.
 *   2. CANNOT_REMOVE_SELF: the actor can't remove themselves via
 *      this endpoint. Ambiguity guard — if they want to leave,
 *      another admin removes them; if they're the only admin, they
 *      archive the tenant instead.
 *   3. CANNOT_REMOVE_LAST_ADMIN: even if the target isn't the actor,
 *      if the target is the LAST tenant_admin, the removal is
 *      refused. Prevents orphaned tenants.
 *
 * Also pins: authored rows (books/notes/links) survive removal —
 * they become read-only for the ex-member but stay attributed to them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

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
    .run(uid, `user-${uid}`, email);
  db.prepare(`INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`)
    .run(uid, uid);
  return uid;
}

function addMember(db: Database.Database, tenantId: number, userId: number, role: 'tenant_admin' | 'tenant_member' | 'tenant_viewer' = 'tenant_member'): void {
  db.prepare(`INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, ?)`)
    .run(tenantId, userId, role);
}

import {
  removeMember,
  countTenantAdmins,
  getMembership,
  listMembersOfTenant,
  RemoveMemberError,
} from '../../src/services/tenant-service';
import { createBook, listBooks } from '../../src/services/tenant-resource-service';

describe('tenant-service.removeMember — rule 1: target must be a member', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('throws NOT_A_MEMBER for a user who never joined', () => {
    const owner = seedUser(testDb, 'owner@e.com');
    const stranger = seedUser(testDb, 'stranger@e.com');
    // stranger has their OWN solo tenant but is NOT a member of owner's.
    try {
      removeMember(owner, stranger, { userId: owner, role: 'tenant_admin' });
      expect.fail('expected NOT_A_MEMBER');
    } catch (e) {
      expect((e as RemoveMemberError).code).toBe('NOT_A_MEMBER');
      expect((e as RemoveMemberError).details).toMatchObject({ tenantId: owner, userId: stranger });
    }
  });

  it('throws NOT_A_MEMBER for a completely non-existent userId', () => {
    const owner = seedUser(testDb, 'owner@e.com');
    expect(() =>
      removeMember(owner, 99999, { userId: owner, role: 'tenant_admin' }),
    ).toThrow(RemoveMemberError);
  });

  it('throws NOT_A_MEMBER for invalid numeric inputs', () => {
    try {
      removeMember(0, 5, { userId: 1, role: 'tenant_admin' });
      expect.fail('expected NOT_A_MEMBER');
    } catch (e) {
      expect((e as RemoveMemberError).code).toBe('NOT_A_MEMBER');
    }
    try {
      removeMember(10, -1, { userId: 1, role: 'tenant_admin' });
      expect.fail('expected NOT_A_MEMBER');
    } catch (e) {
      expect((e as RemoveMemberError).code).toBe('NOT_A_MEMBER');
    }
  });
});

describe('tenant-service.removeMember — rule 2: cannot remove self', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('refuses self-removal with CANNOT_REMOVE_SELF', () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const bob = seedUser(testDb, 'bob@e.com');
    addMember(testDb, alice, bob, 'tenant_admin');   // two admins

    try {
      removeMember(alice, alice, { userId: alice, role: 'tenant_admin' });
      expect.fail('expected CANNOT_REMOVE_SELF');
    } catch (e) {
      expect((e as RemoveMemberError).code).toBe('CANNOT_REMOVE_SELF');
    }

    // Membership still intact after the refusal.
    expect(getMembership(alice, alice)).not.toBeNull();
  });

  it('self-removal refused even when there are other admins available', () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const bob = seedUser(testDb, 'bob@e.com');
    addMember(testDb, alice, bob, 'tenant_admin');

    // bob admin exists — alice could technically leave safely — but
    // the endpoint still refuses self-removal. She needs bob to do it.
    try {
      removeMember(alice, alice, { userId: alice, role: 'tenant_admin' });
      expect.fail('expected CANNOT_REMOVE_SELF');
    } catch (e) {
      expect((e as RemoveMemberError).code).toBe('CANNOT_REMOVE_SELF');
    }
  });
});

describe('tenant-service.removeMember — rule 3: cannot remove the last admin', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('refuses removing an admin when they\'re the last one', () => {
    const alice = seedUser(testDb, 'alice@e.com');     // solo admin of tenant alice
    const bob = seedUser(testDb, 'bob@e.com');

    // Bob joins as a tenant_member of alice's tenant (not admin).
    addMember(testDb, alice, bob, 'tenant_member');

    // Now alice is the ONLY admin. A second admin (say, a platform
    // support role) trying to remove her would be refused.
    const supportAdmin = seedUser(testDb, 'support@e.com');
    addMember(testDb, alice, supportAdmin, 'tenant_admin');

    // Support admin removes self — wait, no, that's rule 2. Let me
    // instead have support try to remove ALICE. Two admins exist
    // now, so removal should SUCCEED.
    const removed = removeMember(alice, alice, { userId: supportAdmin, role: 'tenant_admin' });
    expect(removed.userId).toBe(alice);
    expect(countTenantAdmins(alice)).toBe(1);

    // Now support is the last admin. Bob (member) can't kick them
    // (that'd fail the workspace guard anyway). But say support
    // delegates to a script that tries to remove them — should refuse.
    try {
      removeMember(alice, supportAdmin, { userId: bob, role: 'tenant_admin' });
      expect.fail('expected CANNOT_REMOVE_LAST_ADMIN');
    } catch (e) {
      expect((e as RemoveMemberError).code).toBe('CANNOT_REMOVE_LAST_ADMIN');
      expect((e as RemoveMemberError).details).toMatchObject({
        tenantId: alice,
        userId: supportAdmin,
        adminCount: 1,
      });
    }
  });

  it('allows removing an admin when another admin remains', () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const bob = seedUser(testDb, 'bob@e.com');
    addMember(testDb, alice, bob, 'tenant_admin');

    const removed = removeMember(alice, bob, { userId: alice, role: 'tenant_admin' });
    expect(removed.userId).toBe(bob);
    expect(removed.role).toBe('tenant_admin');
    expect(getMembership(alice, bob)).toBeNull();
    expect(countTenantAdmins(alice)).toBe(1);
  });

  it('allows removing a tenant_member even if there\'s only one admin', () => {
    // The last-admin rule only applies to admin targets.
    const alice = seedUser(testDb, 'alice@e.com');
    const bob = seedUser(testDb, 'bob@e.com');
    addMember(testDb, alice, bob, 'tenant_member');

    expect(countTenantAdmins(alice)).toBe(1); // just alice
    const removed = removeMember(alice, bob, { userId: alice, role: 'tenant_admin' });
    expect(removed.userId).toBe(bob);
    expect(getMembership(alice, bob)).toBeNull();
  });
});

describe('tenant-service.removeMember — authorship preservation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('removed member\'s authored rows survive — created_by stays intact', () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const bob = seedUser(testDb, 'bob@e.com');
    addMember(testDb, alice, bob, 'tenant_member');

    // Bob writes a book in alice's tenant.
    const book = createBook(alice, { userId: bob, role: 'tenant_member' }, {
      title: 'Bob wrote this',
    });
    expect(book.createdBy).toBe(bob);

    // Alice removes bob.
    removeMember(alice, bob, { userId: alice, role: 'tenant_admin' });

    // The book still exists, still attributed to bob.
    const books = listBooks(alice);
    expect(books).toHaveLength(1);
    expect(books[0].title).toBe('Bob wrote this');
    expect(books[0].createdBy).toBe(bob);
  });

  it('listMembersOfTenant no longer includes the removed member', () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const bob = seedUser(testDb, 'bob@e.com');
    addMember(testDb, alice, bob, 'tenant_member');

    expect(listMembersOfTenant(alice).map(m => m.userId)).toEqual(
      expect.arrayContaining([alice, bob]),
    );

    removeMember(alice, bob, { userId: alice, role: 'tenant_admin' });

    const after = listMembersOfTenant(alice).map(m => m.userId);
    expect(after).toEqual([alice]);
    expect(after).not.toContain(bob);
  });
});

describe('tenant-service.countTenantAdmins', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('returns 0 for a non-existent tenant', () => {
    expect(countTenantAdmins(99999)).toBe(0);
  });

  it('counts only admins, not members or viewers', () => {
    const alice = seedUser(testDb, 'alice@e.com');
    const bob = seedUser(testDb, 'bob@e.com');
    const carol = seedUser(testDb, 'carol@e.com');
    const dave = seedUser(testDb, 'dave@e.com');

    addMember(testDb, alice, bob, 'tenant_member');
    addMember(testDb, alice, carol, 'tenant_viewer');
    addMember(testDb, alice, dave, 'tenant_admin');

    expect(countTenantAdmins(alice)).toBe(2); // alice + dave
  });
});
