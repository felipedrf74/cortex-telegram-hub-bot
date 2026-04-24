// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Validation / hardening test added on branch
 * `hardening/nexus-hub-owner-workspace-validation` (2026-04-22).
 *
 * Pins validation fix #4: `acceptInvite` must correctly detect
 * expiry regardless of what string format the caller stored
 * in `tenant_invites.expires_at`:
 *
 *   - ISO-8601 with 'T' separator + 'Z' suffix (what
 *     `new Date(...).toISOString()` produces — the common path).
 *   - SQLite-native format 'YYYY-MM-DD HH:MM:SS' (what
 *     `datetime('now', '+N days')` produces if a caller built
 *     the value via SQL instead of JS).
 *
 * An earlier iteration of the fix used raw string comparison
 * (`SELECT datetime('now') >= ?`) — that broke on ISO-8601 inputs
 * because 'T' (0x54) > ' ' (0x20) lexicographically, so the
 * expired check never fired for .toISOString() values.
 *
 * The final fix wraps both sides: `datetime('now') >= datetime(?)`.
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

import { createInvite, acceptInvite, InviteError, getInviteById } from '../../src/services/tenant-invite-service';

describe('tenant-invite-service — expiry format compatibility (validation fix 4)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('ISO-8601 input with T + Z suffix: past → EXPIRED', () => {
    const admin = seedUser(testDb, 'admin-iso@e.com');
    const bob = seedUser(testDb, 'bob-iso@e.com');
    const past = new Date(Date.now() - 60_000).toISOString(); // "YYYY-MM-DDTHH:MM:SS.000Z"
    const inv = createInvite({
      tenantId: admin, email: 'bob-iso@e.com', role: 'tenant_member', createdBy: admin, expiresAt: past,
    });
    try {
      acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob-iso@e.com' });
      expect.fail('expected EXPIRED');
    } catch (e) {
      expect((e as InviteError).code).toBe('EXPIRED');
    }
    expect(getInviteById(inv.id)?.status).toBe('expired');
  });

  it('SQLite-native input: past → EXPIRED', () => {
    const admin = seedUser(testDb, 'admin-sqlite@e.com');
    const bob = seedUser(testDb, 'bob-sqlite@e.com');
    // SQLite-native 'YYYY-MM-DD HH:MM:SS' — 60s ago.
    const past = testDb.prepare("SELECT datetime('now', '-60 seconds') AS t").get() as { t: string };
    const inv = createInvite({
      tenantId: admin, email: 'bob-sqlite@e.com', role: 'tenant_member', createdBy: admin, expiresAt: past.t,
    });
    try {
      acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob-sqlite@e.com' });
      expect.fail('expected EXPIRED');
    } catch (e) {
      expect((e as InviteError).code).toBe('EXPIRED');
    }
    expect(getInviteById(inv.id)?.status).toBe('expired');
  });

  it('ISO-8601 future: does NOT expire', () => {
    const admin = seedUser(testDb, 'admin-fut@e.com');
    const bob = seedUser(testDb, 'bob-fut@e.com');
    const future = new Date(Date.now() + 60_000).toISOString();
    const inv = createInvite({
      tenantId: admin, email: 'bob-fut@e.com', role: 'tenant_member', createdBy: admin, expiresAt: future,
    });
    // Should succeed — invite is still valid.
    const accepted = acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob-fut@e.com' });
    expect(accepted.status).toBe('accepted');
  });

  it('SQLite-native future: does NOT expire', () => {
    const admin = seedUser(testDb, 'admin-sqlfut@e.com');
    const bob = seedUser(testDb, 'bob-sqlfut@e.com');
    const future = testDb.prepare("SELECT datetime('now', '+60 seconds') AS t").get() as { t: string };
    const inv = createInvite({
      tenantId: admin, email: 'bob-sqlfut@e.com', role: 'tenant_member', createdBy: admin, expiresAt: future.t,
    });
    const accepted = acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob-sqlfut@e.com' });
    expect(accepted.status).toBe('accepted');
  });

  it('null expires_at: never expires', () => {
    const admin = seedUser(testDb, 'admin-null@e.com');
    const bob = seedUser(testDb, 'bob-null@e.com');
    const inv = createInvite({
      tenantId: admin, email: 'bob-null@e.com', role: 'tenant_member', createdBy: admin,
      // expiresAt omitted → null
    });
    const accepted = acceptInvite({ code: inv.inviteCode, userId: bob, userEmail: 'bob-null@e.com' });
    expect(accepted.status).toBe('accepted');
  });
});
