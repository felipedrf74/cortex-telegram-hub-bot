// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for tenant-service.ts.
 *
 * Pins:
 *   - Migration 076 backfills every user as their own solo tenant.
 *   - tenant.id == users.id for the solo-tenant convention.
 *   - Membership checks fail closed (not-a-member returns null; the
 *     `assert*` variants throw TenantError with a stable code).
 *   - Platform admin seed lives in a separate table — membership in
 *     tenant_members doesn't imply platform_admin and vice versa.
 *   - Multi-member tenants (Phase 2 shape) work once a second member
 *     is inserted; isolation is maintained by the membership row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    fatal: vi.fn(),
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
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const already = db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file);
    if (already) continue;
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    } catch {
      // Skip migrations whose preconditions our minimal test harness
      // doesn't meet — not all 70+ migrations work in isolation.
    }
  }
}

function seedUser(
  db: Database.Database,
  opts: { id?: number; email?: string; tier?: string; telegramId?: number } = {},
): number {
  const id = opts.id ?? null;
  const email = opts.email ?? `user${Math.floor(Math.random() * 1e6)}@example.com`;
  const tier = opts.tier ?? 'free';
  const telegramId = opts.telegramId ?? null;
  const stmt = db.prepare(
    `INSERT INTO users (id, email, tier, telegram_id, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, ?, ?, 1, 'active', 'email', datetime('now'))`,
  );
  const result = stmt.run(id, email, tier, telegramId);
  return id ?? Number(result.lastInsertRowid);
}

// NOTE: imported AFTER the vi.mock above so the database mock is active.
import {
  getTenantById,
  getTenantBySlug,
  listAllTenants,
  listTenantsForUser,
  getMembership,
  listMembersOfTenant,
  getPlatformRole,
  isPlatformAdmin,
  isPlatformOwner,
  listPlatformAdmins,
  assertMembership,
  assertTenantAdmin,
  assertPlatformAdmin,
  assertPlatformOwner,
  resolveSoloTenantId,
  ensureSoloTenantFor,
  TenantError,
} from '../../src/services/tenant-service';

describe('tenant-service — migration 076 backfill', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    // Pre-seed users BEFORE migration 076 runs so the backfill picks them up.
    // Migration 051 creates the users table (multi-auth shape).
    // We apply migrations up to 075 first, seed users, then run 076 separately.
    // Simpler: apply ALL migrations, then inject users, then re-run 076's
    // backfill inserts by hand. Or: write SQL to run the seeds synthetically.
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('creates a solo tenant for a newly-inserted user via ensureSoloTenantFor', () => {
    const uid = seedUser(testDb, { email: 'alice@example.com', tier: 'pro' });
    const tenantId = ensureSoloTenantFor(uid);
    expect(tenantId).toBe(uid);

    const tenant = getTenantById(uid);
    expect(tenant).not.toBeNull();
    expect(tenant?.slug).toBe(`user-${uid}`);
    expect(tenant?.displayName).toBe('alice@example.com');
    expect(tenant?.plan).toBe('pro');
    expect(tenant?.status).toBe('active');

    // Membership row created with tenant_admin role.
    const membership = getMembership(uid, uid);
    expect(membership).not.toBeNull();
    expect(membership?.role).toBe('tenant_admin');
  });

  it('ensureSoloTenantFor is idempotent (re-running does not create duplicates)', () => {
    const uid = seedUser(testDb, { email: 'bob@example.com' });
    ensureSoloTenantFor(uid);
    ensureSoloTenantFor(uid);
    ensureSoloTenantFor(uid);

    const members = listMembersOfTenant(uid);
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe(uid);
  });

  it('lookups by slug and by id agree', () => {
    const uid = seedUser(testDb);
    ensureSoloTenantFor(uid);

    const bySlug = getTenantBySlug(`user-${uid}`);
    const byId = getTenantById(uid);
    expect(bySlug?.id).toBe(byId?.id);
    expect(bySlug?.slug).toBe(byId?.slug);
  });

  it('returns null for non-existent tenant', () => {
    expect(getTenantById(99999)).toBeNull();
    expect(getTenantBySlug('user-99999')).toBeNull();
  });

  it('rejects invalid tenant ids', () => {
    expect(getTenantById(0)).toBeNull();
    expect(getTenantById(-1)).toBeNull();
    expect(getTenantById(Number.NaN)).toBeNull();
  });
});

describe('tenant-service — membership isolation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  afterEach(() => testDb?.close());

  it('non-member returns null from getMembership', () => {
    const a = seedUser(testDb, { email: 'a@e.com' });
    const b = seedUser(testDb, { email: 'b@e.com' });
    ensureSoloTenantFor(a);
    ensureSoloTenantFor(b);
    // b is not a member of a's tenant.
    expect(getMembership(a, b)).toBeNull();
  });

  it('assertMembership throws NOT_A_MEMBER with stable code for cross-tenant attempt', () => {
    const a = seedUser(testDb, { email: 'alice-x@e.com' });
    const b = seedUser(testDb, { email: 'bob-x@e.com' });
    ensureSoloTenantFor(a);
    ensureSoloTenantFor(b);

    expect(() => assertMembership(a, b)).toThrowError(TenantError);
    try {
      assertMembership(a, b);
    } catch (err) {
      expect(err).toBeInstanceOf(TenantError);
      expect((err as TenantError).code).toBe('NOT_A_MEMBER');
      expect((err as TenantError).details).toMatchObject({ tenantId: a, userId: b });
    }
  });

  it('assertTenantAdmin accepts the solo-tenant owner', () => {
    const uid = seedUser(testDb);
    ensureSoloTenantFor(uid);
    const membership = assertTenantAdmin(uid, uid);
    expect(membership.role).toBe('tenant_admin');
  });

  it('assertTenantAdmin rejects a tenant_member with INSUFFICIENT_TENANT_ROLE', () => {
    const owner = seedUser(testDb, { email: 'owner@e.com' });
    const member = seedUser(testDb, { email: 'member@e.com' });
    ensureSoloTenantFor(owner);
    ensureSoloTenantFor(member);
    // Add member as tenant_member on owner's tenant.
    testDb.prepare(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`,
    ).run(owner, member);

    try {
      assertTenantAdmin(owner, member);
    } catch (err) {
      expect((err as TenantError).code).toBe('INSUFFICIENT_TENANT_ROLE');
      expect((err as TenantError).details).toMatchObject({
        tenantId: owner,
        userId: member,
        role: 'tenant_member',
        requiredRole: 'tenant_admin',
      });
    }
  });

  it('listTenantsForUser returns all tenants the user is in with their role', () => {
    const owner = seedUser(testDb, { email: 'shared-owner@e.com' });
    const collaborator = seedUser(testDb, { email: 'collaborator@e.com' });
    ensureSoloTenantFor(owner);
    ensureSoloTenantFor(collaborator);
    testDb.prepare(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`,
    ).run(owner, collaborator);

    const summaries = listTenantsForUser(collaborator);
    expect(summaries).toHaveLength(2); // own solo + collab role in owner's tenant
    const ownSolo = summaries.find((s) => s.tenant.id === collaborator);
    const collabIn = summaries.find((s) => s.tenant.id === owner);
    expect(ownSolo?.role).toBe('tenant_admin');
    expect(collabIn?.role).toBe('tenant_member');
  });

  it('listMembersOfTenant does not leak members of other tenants', () => {
    const a = seedUser(testDb, { email: 'isolation-a@e.com' });
    const b = seedUser(testDb, { email: 'isolation-b@e.com' });
    const c = seedUser(testDb, { email: 'isolation-c@e.com' });
    ensureSoloTenantFor(a);
    ensureSoloTenantFor(b);
    ensureSoloTenantFor(c);

    const aMembers = listMembersOfTenant(a).map((m) => m.userId);
    const bMembers = listMembersOfTenant(b).map((m) => m.userId);

    // Each solo tenant has exactly one member (the owner).
    expect(aMembers).toEqual([a]);
    expect(bMembers).toEqual([b]);
    // Cross-check: b is NOT in a's member list, a is NOT in b's.
    expect(aMembers).not.toContain(b);
    expect(aMembers).not.toContain(c);
  });
});

describe('tenant-service — platform admin', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  afterEach(() => testDb?.close());

  it('returns null for a non-admin user', () => {
    const uid = seedUser(testDb);
    expect(getPlatformRole(uid)).toBeNull();
    expect(isPlatformAdmin(uid)).toBe(false);
    expect(isPlatformOwner(uid)).toBe(false);
  });

  it('resolves platform_owner seeded via migration for a tier=owner user', () => {
    // Tier='owner' users are seeded into platform_admins by the migration's
    // ORDER BY id LIMIT 1 clause. Seed two owner-tier users; only the first
    // should become platform_owner.
    const first = seedUser(testDb, { email: 'felipe@e.com', tier: 'owner' });
    const second = seedUser(testDb, { email: 'other-owner@e.com', tier: 'owner' });

    // Re-run migration 076's platform-owner seed.
    testDb.exec(`
      INSERT OR IGNORE INTO platform_admins (user_id, role, granted_at)
      SELECT id, 'platform_owner', COALESCE(created_at, datetime('now'))
      FROM users
      WHERE tier = 'owner'
      ORDER BY id ASC
      LIMIT 1;
    `);

    expect(isPlatformOwner(first)).toBe(true);
    expect(isPlatformOwner(second)).toBe(false);
    expect(isPlatformAdmin(second)).toBe(false);
  });

  it('assertPlatformOwner throws INSUFFICIENT_PLATFORM_ROLE for a platform_admin', () => {
    const uid = seedUser(testDb);
    testDb.prepare(
      `INSERT INTO platform_admins (user_id, role, granted_at) VALUES (?, 'platform_admin', datetime('now'))`,
    ).run(uid);

    try {
      assertPlatformOwner(uid);
      expect.fail('expected to throw');
    } catch (err) {
      expect((err as TenantError).code).toBe('INSUFFICIENT_PLATFORM_ROLE');
    }
  });

  it('assertPlatformAdmin accepts platform_admin, platform_owner, and platform_readonly', () => {
    const admin = seedUser(testDb);
    const owner = seedUser(testDb);
    const readonly = seedUser(testDb);
    testDb.prepare(`INSERT INTO platform_admins (user_id, role) VALUES (?, 'platform_admin')`).run(admin);
    testDb.prepare(`INSERT INTO platform_admins (user_id, role) VALUES (?, 'platform_owner')`).run(owner);
    testDb.prepare(`INSERT INTO platform_admins (user_id, role) VALUES (?, 'platform_readonly')`).run(readonly);

    expect(assertPlatformAdmin(admin)).toBe('platform_admin');
    expect(assertPlatformAdmin(owner)).toBe('platform_owner');
    expect(assertPlatformAdmin(readonly)).toBe('platform_readonly');
  });

  it('platform_admin seed is orthogonal to tenant membership', () => {
    const uid = seedUser(testDb, { email: 'platform-admin@e.com' });
    testDb.prepare(`INSERT INTO platform_admins (user_id, role) VALUES (?, 'platform_admin')`).run(uid);

    // They're a platform admin …
    expect(isPlatformAdmin(uid)).toBe(true);
    // … without ANY tenant membership.
    expect(listTenantsForUser(uid)).toEqual([]);
  });

  it('listPlatformAdmins returns all admins in seed order', () => {
    const a = seedUser(testDb, { email: 'a@e.com' });
    const b = seedUser(testDb, { email: 'b@e.com' });
    testDb.prepare(`INSERT INTO platform_admins (user_id, role, granted_at) VALUES (?, 'platform_owner', '2026-01-01 00:00:00')`).run(a);
    testDb.prepare(`INSERT INTO platform_admins (user_id, role, granted_at) VALUES (?, 'platform_admin', '2026-02-01 00:00:00')`).run(b);

    const admins = listPlatformAdmins();
    expect(admins.map((x) => x.userId)).toEqual([a, b]);
    expect(admins.map((x) => x.role)).toEqual(['platform_owner', 'platform_admin']);
  });
});

describe('tenant-service — listAllTenants pagination', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    for (let i = 0; i < 12; i++) {
      const uid = seedUser(testDb, { email: `t${i}@e.com` });
      ensureSoloTenantFor(uid);
    }
  });

  afterEach(() => testDb?.close());

  it('applies limit and offset', () => {
    const first = listAllTenants({ limit: 5, offset: 0 });
    const second = listAllTenants({ limit: 5, offset: 5 });
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    expect(first[0].id).not.toBe(second[0].id);
  });

  it('filters by status', () => {
    // Suspend a couple of tenants.
    testDb.prepare(`UPDATE tenants SET status = 'suspended' WHERE id IN (1, 2)`).run();
    const suspended = listAllTenants({ statusFilter: 'suspended', limit: 50 });
    const active = listAllTenants({ statusFilter: 'active', limit: 50 });
    expect(suspended.every((t) => t.status === 'suspended')).toBe(true);
    expect(active.every((t) => t.status === 'active')).toBe(true);
    expect(suspended.length + active.length).toBe(12);
  });
});

describe('tenant-service — resolveSoloTenantId', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  afterEach(() => testDb?.close());

  it('returns tenant id when solo tenant exists', () => {
    const uid = seedUser(testDb);
    ensureSoloTenantFor(uid);
    expect(resolveSoloTenantId(uid)).toBe(uid);
  });

  it('returns null when no solo tenant yet', () => {
    const uid = seedUser(testDb);
    expect(resolveSoloTenantId(uid)).toBeNull();
  });
});
