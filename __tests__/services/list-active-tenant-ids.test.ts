// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Unit tests for the tenant-iteration choke point added in
 * OI-ADM-302b (2026-04-24). `listActiveTenantIds()` is the single
 * function scheduled jobs should consult when fanning out
 * per-tenant work — it honors tenant.status='active' so
 * suspended / archived / trial tenants automatically stop
 * receiving cron activity without touching each job.
 *
 * Also pins the scheduler's `getOwnerTenantIds` update — it now
 * JOINS against the tenants table so suspended owners drop out
 * of per-tenant cron iteration.
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
function seedUser(db: Database.Database, email: string, tier: 'free' | 'pro' | 'owner' = 'free'): number {
  const r = db.prepare(
    `INSERT INTO users (email, tier, email_verified, status, auth_provider, created_at)
     VALUES (?, ?, 1, 'active', 'email', datetime('now'))`,
  ).run(email, tier);
  const uid = Number(r.lastInsertRowid);
  db.prepare(`INSERT OR IGNORE INTO tenants (id, slug, display_name, plan) VALUES (?, ?, ?, 'free')`)
    .run(uid, `tenant-${uid}`, `Tenant ${uid}`);
  db.prepare(`INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_admin')`)
    .run(uid, uid);
  return uid;
}

describe('listActiveTenantIds (OI-ADM-302b)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('returns every active tenant id ordered by id', async () => {
    const a = seedUser(testDb, 'a@e.com');
    const b = seedUser(testDb, 'b@e.com');
    const c = seedUser(testDb, 'c@e.com');
    const { listActiveTenantIds } = await import('../../src/services/tenant-service');
    expect(listActiveTenantIds()).toEqual([a, b, c].sort((x, y) => x - y));
  });

  it('excludes suspended tenants', async () => {
    const active = seedUser(testDb, 'active@e.com');
    const suspended = seedUser(testDb, 'suspended@e.com');
    const { listActiveTenantIds, suspendTenant } = await import('../../src/services/tenant-service');
    suspendTenant(suspended, active, 'test');
    expect(listActiveTenantIds()).toEqual([active]);
  });

  it('excludes archived tenants', async () => {
    const active = seedUser(testDb, 'active@e.com');
    const archived = seedUser(testDb, 'archived@e.com');
    testDb.prepare("UPDATE tenants SET status = 'archived' WHERE id = ?").run(archived);
    const { listActiveTenantIds } = await import('../../src/services/tenant-service');
    expect(listActiveTenantIds()).toEqual([active]);
  });

  it('excludes trial tenants (scheduled work paused during trial)', async () => {
    const active = seedUser(testDb, 'active@e.com');
    const trial = seedUser(testDb, 'trial@e.com');
    testDb.prepare("UPDATE tenants SET status = 'trial' WHERE id = ?").run(trial);
    const { listActiveTenantIds } = await import('../../src/services/tenant-service');
    expect(listActiveTenantIds()).toEqual([active]);
  });

  it('returns [] when there are no active tenants', async () => {
    const { listActiveTenantIds } = await import('../../src/services/tenant-service');
    expect(listActiveTenantIds()).toEqual([]);
  });

  it('re-includes tenants after they are reactivated', async () => {
    const a = seedUser(testDb, 'a@e.com');
    const { listActiveTenantIds, suspendTenant, activateTenant } = await import('../../src/services/tenant-service');
    suspendTenant(a, a, 'test');
    expect(listActiveTenantIds()).toEqual([]);
    activateTenant(a, a);
    expect(listActiveTenantIds()).toEqual([a]);
  });
});

describe('scheduler getOwnerTenantIds respects tenant status (OI-ADM-302b)', () => {
  // Structural pin — we read the scheduler source to verify the
  // INNER JOIN on tenants + status='active' filter is in place.
  // Running the actual scheduler requires a bot + logger + config
  // chain that's heavy for a narrow test.
  it('getOwnerTenantIds joins tenants on tenant.status=active', () => {
    const schedulerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/scheduler.ts'),
      'utf-8',
    );
    // Pin the exact guard shape so a later "refactor" can't strip it.
    expect(schedulerSrc).toMatch(
      /function getOwnerTenantIds[\s\S]*?INNER JOIN tenants t ON t\.id = u\.id[\s\S]*?t\.status = 'active'/,
    );
  });

  it('getOwnerTenantIds also keeps the existing user-tier + status filter', () => {
    // Tenant-status gating is an ADDITION. User-level filters stay:
    // we still iterate only owner-tier active users.
    const schedulerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/scheduler.ts'),
      'utf-8',
    );
    expect(schedulerSrc).toMatch(
      /function getOwnerTenantIds[\s\S]*?u\.tier = 'owner'[\s\S]*?u\.status = 'active'/,
    );
  });
});
