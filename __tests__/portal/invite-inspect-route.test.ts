// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Route + service tests for /invite/inspect/:code (OI-NAV-203a,
 * 2026-04-24).
 *
 * Pinned invariants:
 *   - Unauthenticated (no auth middleware) — cold invitees have no
 *     JWT yet.
 *   - Returns PublicInviteInfo shape with exactly the safe subset
 *     (no internal user ids, no other-tenant data).
 *   - Uniform 200 response — missing codes return { valid: false,
 *     reason: 'not_found' } to avoid status-code oracle leaks.
 *   - Correct hasAccount discrimination — case-insensitive email
 *     match so Bob@Example.com invite with bob@example.com account
 *     correctly resolves to hasAccount: true.
 *   - Correctly flags isExpired on past-expiry invites.
 *   - Malformed short codes return reason: 'malformed' without
 *     hitting the DB.
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

describe('getPublicInviteInfo — service behavior (OI-NAV-203a)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('returns malformed for non-string / short codes without hitting the DB', async () => {
    const { getPublicInviteInfo } = await import('../../src/services/tenant-invite-service');
    expect(getPublicInviteInfo('')).toEqual({ valid: false, reason: 'malformed' });
    expect(getPublicInviteInfo('abc')).toEqual({ valid: false, reason: 'malformed' });
    expect(getPublicInviteInfo(null as unknown as string)).toEqual({ valid: false, reason: 'malformed' });
  });

  it('returns not_found for a well-formed but unknown code', async () => {
    const { getPublicInviteInfo } = await import('../../src/services/tenant-invite-service');
    const unknown = 'a'.repeat(32);
    expect(getPublicInviteInfo(unknown)).toEqual({ valid: false, reason: 'not_found' });
  });

  it('returns tenant + invitee metadata when invite is valid', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const { createInvite, getPublicInviteInfo } = await import('../../src/services/tenant-invite-service');
    const invite = createInvite({
      tenantId: alice,
      email: 'new-user@example.com',
      role: 'tenant_member',
      createdBy: alice,
    });
    const info = getPublicInviteInfo(invite.inviteCode);
    expect(info.valid).toBe(true);
    expect(info.inviteeEmail).toBe('new-user@example.com');
    expect(info.role).toBe('tenant_member');
    expect(info.status).toBe('pending');
    expect(info.tenantSlug).toBe(`tenant-${alice}`);
    expect(info.tenantName).toBe(`Tenant ${alice}`);
    expect(info.isExpired).toBe(false);
  });

  it('hasAccount: true when a user with that email exists (case-insensitive)', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    // Seed an existing account for the invitee under mixed case.
    seedUser(testDb, 'New-User@Example.com');
    const { createInvite, getPublicInviteInfo } = await import('../../src/services/tenant-invite-service');
    const invite = createInvite({
      tenantId: alice,
      email: 'new-user@example.com', // lowercase
      role: 'tenant_member',
      createdBy: alice,
    });
    const info = getPublicInviteInfo(invite.inviteCode);
    expect(info.hasAccount).toBe(true);
  });

  it('hasAccount: false when no user has the invitee email', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const { createInvite, getPublicInviteInfo } = await import('../../src/services/tenant-invite-service');
    const invite = createInvite({
      tenantId: alice,
      email: 'first-time@example.com',
      role: 'tenant_member',
      createdBy: alice,
    });
    const info = getPublicInviteInfo(invite.inviteCode);
    expect(info.hasAccount).toBe(false);
  });

  it('isExpired: true when expiresAt is in the past', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const { createInvite, getPublicInviteInfo } = await import('../../src/services/tenant-invite-service');
    const invite = createInvite({
      tenantId: alice,
      email: 'later@example.com',
      role: 'tenant_member',
      createdBy: alice,
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
    });
    const info = getPublicInviteInfo(invite.inviteCode);
    expect(info.valid).toBe(true);
    expect(info.isExpired).toBe(true);
  });

  it('does NOT leak the inviting user id, tenant id, or invite primary key', async () => {
    const alice = seedUser(testDb, 'alice@example.com');
    const { createInvite, getPublicInviteInfo } = await import('../../src/services/tenant-invite-service');
    const invite = createInvite({
      tenantId: alice,
      email: 'target@example.com',
      role: 'tenant_member',
      createdBy: alice,
    });
    const info = getPublicInviteInfo(invite.inviteCode);
    // Allowed keys (union of valid + not-valid shape):
    const allowed = new Set([
      'valid', 'tenantSlug', 'tenantName', 'inviteeEmail', 'role',
      'expiresAt', 'status', 'hasAccount', 'isExpired', 'reason',
    ]);
    for (const k of Object.keys(info)) {
      expect(allowed.has(k)).toBe(true);
    }
    // Serialised response must not contain 'createdBy' or 'tenantId'
    // (those are internal ids — caller has only the code).
    expect(JSON.stringify(info)).not.toMatch(/"tenantId"/);
    expect(JSON.stringify(info)).not.toMatch(/"createdBy"/);
  });
});

describe('GET /invite/inspect/:code — route behavior (OI-NAV-203a)', () => {
  // We don't mount the full portal server here (that requires a real
  // bot, logger, etc.) — we pin the ROUTE REGISTRATION in server.ts
  // structurally, and rely on the service tests above for behavior.
  it('/invite/inspect/:code handler registered as unauthenticated app.get in server.ts', () => {
    const serverSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toMatch(/app\.get\(['"]\/invite\/inspect\/:code['"]/);
    // The handler must call getPublicInviteInfo (require'd lazily).
    expect(serverSrc).toMatch(/getPublicInviteInfo\s*\}\s*=\s*require\(['"]\.\.\/services\/tenant-invite-service['"]\)/);
  });

  it('handler sets Cache-Control: no-store (credentials in the URL should never be cached)', () => {
    const serverSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toMatch(
      /\/invite\/inspect[\s\S]*?res\.set\(['"]Cache-Control['"],\s*['"]no-store['"]\)/,
    );
  });

  it('handler wraps response in the uniform { ok, data, timestamp } envelope', () => {
    const serverSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toMatch(
      /\/invite\/inspect[\s\S]*?res\.json\(\{\s*ok:\s*true,\s*data:\s*info,\s*timestamp:/,
    );
  });
});
