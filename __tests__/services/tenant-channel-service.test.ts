// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Service-layer tests for tenant-channel-service (OI-DATA-002,
 * branch feature/nexus-hub-portal-uiux-admin-user-console, 2026-04-22).
 *
 * These pin the invariants that /workspace/channels and the Home
 * payload's `content.channel.primary` dependency depend on:
 *
 *   - Cross-tenant isolation: queries always filter by tenant_id.
 *   - Authorship rule: author OR tenant_admin can mutate; member
 *     cannot touch other members' rows; viewer is read-only.
 *   - URL protocol whitelist: only http / https accepted (no
 *     javascript: / data: / file: / vbscript:).
 *   - Enum validation: kind + status must be in the allowed sets.
 *   - listChannels default excludes archived (non-destructive
 *     soft-delete semantics).
 *   - countActiveChannels matches the list result.
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
function addMember(db: Database.Database, tenantId: number, userId: number, role: string): void {
  db.prepare('INSERT OR IGNORE INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, ?)')
    .run(tenantId, userId, role);
}

import {
  createChannel,
  getChannel,
  listChannels,
  updateChannel,
  deleteChannel,
  countActiveChannels,
  ChannelError,
} from '../../src/services/tenant-channel-service';

describe('tenant-channel-service — create', () => {
  let admin: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    admin = seedUser(testDb, 'alice@e.com');
  });
  afterEach(() => testDb?.close());

  it('creates an active channel with default kind=generic', () => {
    const ch = createChannel(admin, { userId: admin, role: 'tenant_admin' }, { title: 'My Feed' });
    expect(ch.title).toBe('My Feed');
    expect(ch.kind).toBe('generic');
    expect(ch.status).toBe('active');
    expect(ch.createdBy).toBe(admin);
    expect(ch.tenantId).toBe(admin);
  });

  it('trims title + rejects empty title', () => {
    expect(() => createChannel(admin, { userId: admin, role: 'tenant_admin' }, { title: '   ' }))
      .toThrow(ChannelError);
  });

  it('caps title at 200 chars', () => {
    const long = 'x'.repeat(201);
    expect(() => createChannel(admin, { userId: admin, role: 'tenant_admin' }, { title: long }))
      .toThrow(/title too long/);
  });

  it('rejects invalid kind enum', () => {
    expect(() => createChannel(admin, { userId: admin, role: 'tenant_admin' }, {
      title: 'x', kind: 'not-a-kind' as any,
    })).toThrow(/invalid kind/);
  });

  it('rejects invalid status enum', () => {
    expect(() => createChannel(admin, { userId: admin, role: 'tenant_admin' }, {
      title: 'x', status: 'frozen' as any,
    })).toThrow(/invalid status/);
  });

  it('SECURITY: rejects javascript: URL (protocol whitelist)', () => {
    expect(() => createChannel(admin, { userId: admin, role: 'tenant_admin' }, {
      title: 'evil', url: 'javascript:alert(1)',
    })).toThrow(/must start with http/);
  });

  it('SECURITY: rejects data: URL', () => {
    expect(() => createChannel(admin, { userId: admin, role: 'tenant_admin' }, {
      title: 'evil', url: 'data:text/html,<script>alert(1)</script>',
    })).toThrow(/must start with http/);
  });

  it('SECURITY: rejects file: URL', () => {
    expect(() => createChannel(admin, { userId: admin, role: 'tenant_admin' }, {
      title: 'evil', url: 'file:///etc/passwd',
    })).toThrow(/must start with http/);
  });

  it('accepts https and http URLs', () => {
    const a = createChannel(admin, { userId: admin, role: 'tenant_admin' }, { title: 'A', url: 'https://example.com/feed' });
    const b = createChannel(admin, { userId: admin, role: 'tenant_admin' }, { title: 'B', url: 'http://example.com/feed' });
    expect(a.url).toBe('https://example.com/feed');
    expect(b.url).toBe('http://example.com/feed');
  });

  it('tenant_viewer cannot create', () => {
    const viewer = seedUser(testDb, 'viewer@e.com');
    addMember(testDb, admin, viewer, 'tenant_viewer');
    expect(() => createChannel(admin, { userId: viewer, role: 'tenant_viewer' }, { title: 'x' }))
      .toThrow(/read-only/);
  });

  it('normalizes + caps + dedupes tags (max 20, 48 chars each)', () => {
    const ch = createChannel(admin, { userId: admin, role: 'tenant_admin' }, {
      title: 'x',
      tags: ['a', 'A', 'b', '', '  ', 'a', ...Array(25).fill('dup'), 'x'.repeat(100)],
    });
    expect(ch.tags.length).toBeGreaterThan(0);
    expect(ch.tags.length).toBeLessThanOrEqual(20);
    // Dedup (case-insensitive key) — 'a' and 'A' collide to one.
    expect(ch.tags.filter((t) => t.toLowerCase() === 'a')).toHaveLength(1);
    // Long tag got truncated to 48.
    const longTag = ch.tags.find((t) => t.startsWith('xx'));
    expect(longTag?.length).toBeLessThanOrEqual(48);
  });
});

describe('tenant-channel-service — list + count', () => {
  let admin: number;
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    admin = seedUser(testDb, 'alice@e.com');
    createChannel(admin, { userId: admin, role: 'tenant_admin' }, { title: 'A', kind: 'youtube' });
    createChannel(admin, { userId: admin, role: 'tenant_admin' }, { title: 'B', kind: 'podcast', status: 'muted' });
    createChannel(admin, { userId: admin, role: 'tenant_admin' }, { title: 'C', kind: 'rss', status: 'archived' });
  });
  afterEach(() => testDb?.close());

  it('default list excludes archived', () => {
    const rows = listChannels(admin);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status !== 'archived')).toBe(true);
  });

  it("status='all' includes archived", () => {
    const rows = listChannels(admin, { status: 'all' });
    expect(rows).toHaveLength(3);
  });

  it('filters by specific status', () => {
    const rows = listChannels(admin, { status: 'muted' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('B');
  });

  it('filters by kind', () => {
    const rows = listChannels(admin, { kind: 'youtube' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('A');
  });

  it('rejects invalid status / kind filter', () => {
    expect(() => listChannels(admin, { status: 'bogus' as any })).toThrow(/invalid status/);
    expect(() => listChannels(admin, { kind: 'bogus' as any })).toThrow(/invalid kind/);
  });

  it('countActiveChannels returns only active', () => {
    expect(countActiveChannels(admin)).toBe(1);
    // After muting the active one, count drops to 0.
    const active = listChannels(admin, { status: 'active' })[0];
    updateChannel(admin, active.id, { userId: admin, role: 'tenant_admin' }, { status: 'muted' });
    expect(countActiveChannels(admin)).toBe(0);
  });
});

describe('tenant-channel-service — isolation (no cross-tenant leaks)', () => {
  let aliceTenant: number;
  let bobTenant: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    aliceTenant = seedUser(testDb, 'alice@e.com');
    bobTenant = seedUser(testDb, 'bob@e.com');
    createChannel(aliceTenant, { userId: aliceTenant, role: 'tenant_admin' }, { title: 'alice-chan' });
    createChannel(bobTenant, { userId: bobTenant, role: 'tenant_admin' }, { title: 'bob-chan' });
  });
  afterEach(() => testDb?.close());

  it('listChannels is tenant-scoped', () => {
    const aliceRows = listChannels(aliceTenant);
    const bobRows = listChannels(bobTenant);
    expect(aliceRows.map((r) => r.title)).toEqual(['alice-chan']);
    expect(bobRows.map((r) => r.title)).toEqual(['bob-chan']);
  });

  it('getChannel returns null when id exists but wrong tenant (no existence leak)', () => {
    const aliceCh = listChannels(aliceTenant)[0];
    // Bob tries to fetch Alice's channel id — gets null.
    expect(getChannel(bobTenant, aliceCh.id)).toBeNull();
  });

  it('deleteChannel on cross-tenant id → NOT_FOUND (not FORBIDDEN — no existence leak)', () => {
    const aliceCh = listChannels(aliceTenant)[0];
    expect(() => deleteChannel(bobTenant, aliceCh.id, { userId: bobTenant, role: 'tenant_admin' }))
      .toThrow(ChannelError);
    try {
      deleteChannel(bobTenant, aliceCh.id, { userId: bobTenant, role: 'tenant_admin' });
    } catch (e) {
      expect((e as ChannelError).code).toBe('NOT_FOUND');
    }
    // Alice's channel still exists.
    expect(getChannel(aliceTenant, aliceCh.id)).not.toBeNull();
  });
});

describe('tenant-channel-service — authorship (mutation gate)', () => {
  let tenant: number;
  let admin: number;
  let member: number;
  let otherMember: number;
  let viewer: number;
  let ch_byAdmin: number;
  let ch_byMember: number;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    admin = seedUser(testDb, 'admin@e.com');
    tenant = admin;
    member = seedUser(testDb, 'member@e.com');
    otherMember = seedUser(testDb, 'other@e.com');
    viewer = seedUser(testDb, 'viewer@e.com');
    addMember(testDb, tenant, member, 'tenant_member');
    addMember(testDb, tenant, otherMember, 'tenant_member');
    addMember(testDb, tenant, viewer, 'tenant_viewer');
    ch_byAdmin = createChannel(tenant, { userId: admin, role: 'tenant_admin' }, { title: 'admin-made' }).id;
    ch_byMember = createChannel(tenant, { userId: member, role: 'tenant_member' }, { title: 'member-made' }).id;
  });
  afterEach(() => testDb?.close());

  it('tenant_admin can update any channel', () => {
    const r = updateChannel(tenant, ch_byMember, { userId: admin, role: 'tenant_admin' }, { title: 'admin-edited' });
    expect(r.title).toBe('admin-edited');
  });

  it('tenant_member can update their OWN channel', () => {
    const r = updateChannel(tenant, ch_byMember, { userId: member, role: 'tenant_member' }, { status: 'muted' });
    expect(r.status).toBe('muted');
  });

  it('tenant_member CANNOT update another member\'s channel', () => {
    expect(() => updateChannel(tenant, ch_byMember, { userId: otherMember, role: 'tenant_member' }, { title: 'hacked' }))
      .toThrow(/author or a tenant_admin/);
  });

  it('tenant_member CANNOT delete another member\'s channel', () => {
    expect(() => deleteChannel(tenant, ch_byMember, { userId: otherMember, role: 'tenant_member' }))
      .toThrow(/author or a tenant_admin/);
  });

  it('tenant_viewer cannot mutate anything', () => {
    expect(() => updateChannel(tenant, ch_byAdmin, { userId: viewer, role: 'tenant_viewer' }, { status: 'muted' }))
      .toThrow(/read-only/);
    expect(() => deleteChannel(tenant, ch_byAdmin, { userId: viewer, role: 'tenant_viewer' }))
      .toThrow(/read-only/);
  });

  it('SECURITY: URL whitelist re-checked on update (not just create)', () => {
    expect(() => updateChannel(tenant, ch_byAdmin, { userId: admin, role: 'tenant_admin' }, {
      url: 'javascript:alert(1)',
    })).toThrow(/must start with http/);
  });
});
