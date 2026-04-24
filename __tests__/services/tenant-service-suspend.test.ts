// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Unit tests for setTenantStatus / suspendTenant / activateTenant
 * (OI-ADM-302, 2026-04-24).
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

describe('setTenantStatus — behavior (OI-ADM-302)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('transitions a tenant from active to suspended', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const { setTenantStatus, getTenantById } = await import('../../src/services/tenant-service');
    const before = getTenantById(alice);
    expect(before?.status).toBe('active');
    const after = setTenantStatus(alice, 'suspended', alice);
    expect(after.status).toBe('suspended');
    const reread = getTenantById(alice);
    expect(reread?.status).toBe('suspended');
  });

  it('transitions from suspended back to active (round-trip)', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const { setTenantStatus } = await import('../../src/services/tenant-service');
    setTenantStatus(alice, 'suspended', alice);
    const after = setTenantStatus(alice, 'active', alice);
    expect(after.status).toBe('active');
  });

  it('is idempotent when the status is already at the requested value', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const { setTenantStatus } = await import('../../src/services/tenant-service');
    const a1 = setTenantStatus(alice, 'active', alice);
    const a2 = setTenantStatus(alice, 'active', alice);
    expect(a1.status).toBe('active');
    expect(a2.status).toBe('active');
  });

  it('throws TENANT_NOT_FOUND for a non-existent tenant id', async () => {
    const { setTenantStatus, SetTenantStatusError } = await import('../../src/services/tenant-service');
    try {
      setTenantStatus(99999, 'suspended', 1);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SetTenantStatusError);
      expect((e as { code: string }).code).toBe('TENANT_NOT_FOUND');
    }
  });

  it('throws INVALID_STATUS for unknown status values', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const { setTenantStatus, SetTenantStatusError } = await import('../../src/services/tenant-service');
    try {
      setTenantStatus(alice, 'bogus' as never, alice);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SetTenantStatusError);
      expect((e as { code: string }).code).toBe('INVALID_STATUS');
    }
  });

  it('throws INVALID_TENANT_ID for non-positive ids', async () => {
    const { setTenantStatus, SetTenantStatusError } = await import('../../src/services/tenant-service');
    for (const bad of [0, -1, Number.NaN]) {
      try {
        setTenantStatus(bad, 'suspended', 1);
        throw new Error('should have thrown for ' + bad);
      } catch (e) {
        expect(e).toBeInstanceOf(SetTenantStatusError);
        expect((e as { code: string }).code).toBe('INVALID_TENANT_ID');
      }
    }
  });
});

describe('suspendTenant / activateTenant convenience (OI-ADM-302)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('suspendTenant moves status to suspended', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const { suspendTenant } = await import('../../src/services/tenant-service');
    const after = suspendTenant(alice, alice, 'non-payment');
    expect(after.status).toBe('suspended');
  });

  it('activateTenant moves a suspended tenant back to active', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const { suspendTenant, activateTenant } = await import('../../src/services/tenant-service');
    suspendTenant(alice, alice, 'test');
    const after = activateTenant(alice, alice);
    expect(after.status).toBe('active');
  });
});

describe('acceptInvite refuses non-active tenants (OI-ADM-302 cascade)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('refuses to accept an invite when the target tenant is suspended', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const bob = seedUser(testDb, 'bob@example.com');
    const { createInvite, acceptInvite, InviteError } = await import('../../src/services/tenant-invite-service');
    const { suspendTenant } = await import('../../src/services/tenant-service');
    const invite = createInvite({
      tenantId: alice,
      email: 'bob@example.com',
      role: 'tenant_member',
      createdBy: alice,
    });
    suspendTenant(alice, alice, 'test');
    try {
      acceptInvite({ code: invite.inviteCode, userId: bob, userEmail: 'bob@example.com' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InviteError);
      expect((e as { code: string }).code).toBe('TENANT_NOT_ACTIVE');
      expect((e as { details?: Record<string, unknown> }).details).toMatchObject({
        tenantId: alice,
        tenantStatus: 'suspended',
      });
    }
  });

  it('accepts normally into an active tenant (regression guard)', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const bob = seedUser(testDb, 'bob@example.com');
    const { createInvite, acceptInvite } = await import('../../src/services/tenant-invite-service');
    const invite = createInvite({
      tenantId: alice,
      email: 'bob@example.com',
      role: 'tenant_member',
      createdBy: alice,
    });
    const result = acceptInvite({ code: invite.inviteCode, userId: bob, userEmail: 'bob@example.com' });
    expect(result.status).toBe('accepted');
  });
});
