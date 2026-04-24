// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for tenant-resource-service.
 *
 * Pins:
 *   - Every list/get/update/delete is tenant-scoped at the SQL WHERE
 *     clause. No combination of args crosses tenant boundaries.
 *   - Authorship rule: tenant_admin can mutate any row; tenant_member
 *     can only mutate their own; tenant_viewer is read-only.
 *   - Validation: title required, status enum, url must parse.
 *   - Tags are normalized (trim, dedup, cap length + count).
 *   - finished_at auto-populates on status change to 'finished' and
 *     clears when status moves away.
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

import {
  listBooks, getBook, createBook, updateBook, deleteBook,
  listContentNotes, createContentNote, updateContentNote, deleteContentNote,
  listLinks, createLink, updateLink, deleteLink,
  ResourceError,
} from '../../src/services/tenant-resource-service';

describe('tenant-resource-service — books CRUD + isolation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('creates a book with defaults', () => {
    const u = seedUser(testDb, 'a@e.com');
    const b = createBook(u, { userId: u, role: 'tenant_admin' }, { title: 'Atomic Habits' });
    expect(b.title).toBe('Atomic Habits');
    expect(b.status).toBe('reading');
    expect(b.tags).toEqual([]);
    expect(b.createdBy).toBe(u);
    expect(b.tenantId).toBe(u);
    expect(b.finishedAt).toBeNull();
  });

  it('creates a book with finished status auto-sets finished_at', () => {
    const u = seedUser(testDb, 'a@e.com');
    const b = createBook(u, { userId: u, role: 'tenant_admin' }, { title: 'Done', status: 'finished' });
    expect(b.status).toBe('finished');
    expect(b.finishedAt).not.toBeNull();
  });

  it('rejects empty title and overlong title', () => {
    const u = seedUser(testDb, 'a@e.com');
    const actor = { userId: u, role: 'tenant_admin' as const };
    expect(() => createBook(u, actor, { title: '' })).toThrow(ResourceError);
    expect(() => createBook(u, actor, { title: '   ' })).toThrow(ResourceError);
    expect(() => createBook(u, actor, { title: 'x'.repeat(301) })).toThrow(ResourceError);
  });

  it('normalizes tags (trim, dedup, cap)', () => {
    const u = seedUser(testDb, 'a@e.com');
    const b = createBook(u, { userId: u, role: 'tenant_admin' }, {
      title: 'T',
      tags: ['  habits ', 'HABITS', '', 'productivity', 'productivity', 'x'.repeat(100)],
    });
    // Deduped case-insensitively; first wins; empty stripped; long truncated
    expect(b.tags).toEqual(['habits', 'productivity', 'x'.repeat(48)]);
  });

  it('listBooks only returns rows from the specified tenant', () => {
    const a = seedUser(testDb, 'a@e.com');
    const b = seedUser(testDb, 'b@e.com');
    createBook(a, { userId: a, role: 'tenant_admin' }, { title: 'A book' });
    createBook(b, { userId: b, role: 'tenant_admin' }, { title: 'B book' });

    const aBooks = listBooks(a).map(x => x.title);
    const bBooks = listBooks(b).map(x => x.title);
    expect(aBooks).toEqual(['A book']);
    expect(bBooks).toEqual(['B book']);
  });

  it('getBook returns null for wrong tenant even if id exists', () => {
    const a = seedUser(testDb, 'a@e.com');
    const b = seedUser(testDb, 'b@e.com');
    const theirBook = createBook(a, { userId: a, role: 'tenant_admin' }, { title: 'mine' });
    // From tenant B's scope, A's book is invisible.
    expect(getBook(b, theirBook.id)).toBeNull();
  });

  it('tenant_admin can edit another member\'s book', () => {
    const owner = seedUser(testDb, 'owner@e.com');
    const guest = seedUser(testDb, 'guest@e.com');
    // guest joins owner's tenant as a plain member
    testDb.prepare(`INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`).run(owner, guest);

    const guestBook = createBook(owner, { userId: guest, role: 'tenant_member' }, { title: 'Guest book' });
    // Admin (owner) can edit it
    const updated = updateBook(owner, guestBook.id, { userId: owner, role: 'tenant_admin' }, { title: 'Edited by admin' });
    expect(updated.title).toBe('Edited by admin');
  });

  it('tenant_member CANNOT edit another member\'s book', () => {
    const owner = seedUser(testDb, 'owner@e.com');
    const memberA = seedUser(testDb, 'ma@e.com');
    const memberB = seedUser(testDb, 'mb@e.com');
    testDb.prepare(`INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`).run(owner, memberA);
    testDb.prepare(`INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`).run(owner, memberB);

    const aBook = createBook(owner, { userId: memberA, role: 'tenant_member' }, { title: 'A wrote this' });
    try {
      updateBook(owner, aBook.id, { userId: memberB, role: 'tenant_member' }, { title: 'B tries to edit' });
      expect.fail('expected FORBIDDEN');
    } catch (e) {
      expect((e as ResourceError).code).toBe('FORBIDDEN');
    }
  });

  it('tenant_viewer CANNOT create books', () => {
    const u = seedUser(testDb, 'v@e.com');
    expect(() => createBook(u, { userId: u, role: 'tenant_viewer' }, { title: 'T' })).toThrow(ResourceError);
  });

  it('status transition finished → reading clears finished_at', () => {
    const u = seedUser(testDb, 'a@e.com');
    const b = createBook(u, { userId: u, role: 'tenant_admin' }, { title: 'T', status: 'finished' });
    expect(b.finishedAt).not.toBeNull();
    const updated = updateBook(u, b.id, { userId: u, role: 'tenant_admin' }, { status: 'reading' });
    expect(updated.status).toBe('reading');
    expect(updated.finishedAt).toBeNull();
  });

  it('deleteBook only deletes in-tenant rows', () => {
    const a = seedUser(testDb, 'a@e.com');
    const b = seedUser(testDb, 'b@e.com');
    const book = createBook(a, { userId: a, role: 'tenant_admin' }, { title: 'T' });

    // Cross-tenant delete attempt: the service looks up by (tenantId, id),
    // which returns null → NOT_FOUND. No deletion happens on A's side.
    try {
      deleteBook(b, book.id, { userId: b, role: 'tenant_admin' });
      expect.fail('expected NOT_FOUND');
    } catch (e) {
      expect((e as ResourceError).code).toBe('NOT_FOUND');
    }
    expect(getBook(a, book.id)).not.toBeNull();
  });
});

describe('tenant-resource-service — content notes', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('creates, lists, filters by kind', () => {
    const u = seedUser(testDb, 'a@e.com');
    const actor = { userId: u, role: 'tenant_admin' as const };
    createContentNote(u, actor, { title: 'an idea', kind: 'idea' });
    createContentNote(u, actor, { title: 'a draft', kind: 'draft' });
    createContentNote(u, actor, { title: 'a plain note' });

    expect(listContentNotes(u)).toHaveLength(3);
    expect(listContentNotes(u, { kind: 'idea' }).map(n => n.title)).toEqual(['an idea']);
    expect(listContentNotes(u, { kind: 'note' }).map(n => n.title)).toEqual(['a plain note']);
  });

  it('rejects invalid kind', () => {
    const u = seedUser(testDb, 'a@e.com');
    expect(() =>
      createContentNote(u, { userId: u, role: 'tenant_admin' }, { title: 'T', kind: 'bogus' as never }),
    ).toThrow(ResourceError);
  });

  it('truncates body beyond 50k chars on update', () => {
    const u = seedUser(testDb, 'a@e.com');
    const actor = { userId: u, role: 'tenant_admin' as const };
    const n = createContentNote(u, actor, { title: 'T', body: 'small' });
    const huge = 'x'.repeat(100_000);
    const updated = updateContentNote(u, n.id, actor, { body: huge });
    expect(updated.body.length).toBe(50_000);
  });

  it('tenant isolation — list scoped by tenant', () => {
    const a = seedUser(testDb, 'a@e.com');
    const b = seedUser(testDb, 'b@e.com');
    createContentNote(a, { userId: a, role: 'tenant_admin' }, { title: 'A note' });
    createContentNote(b, { userId: b, role: 'tenant_admin' }, { title: 'B note' });
    expect(listContentNotes(a).map(n => n.title)).toEqual(['A note']);
    expect(listContentNotes(b).map(n => n.title)).toEqual(['B note']);
  });

  it('deleteContentNote FORBIDDEN for non-author non-admin', () => {
    const owner = seedUser(testDb, 'o@e.com');
    const memberA = seedUser(testDb, 'a@e.com');
    const memberB = seedUser(testDb, 'b@e.com');
    testDb.prepare(`INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`).run(owner, memberA);
    testDb.prepare(`INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, 'tenant_member')`).run(owner, memberB);

    const aNote = createContentNote(owner, { userId: memberA, role: 'tenant_member' }, { title: 'A note' });
    try {
      deleteContentNote(owner, aNote.id, { userId: memberB, role: 'tenant_member' });
      expect.fail('expected FORBIDDEN');
    } catch (e) {
      expect((e as ResourceError).code).toBe('FORBIDDEN');
    }
  });
});

describe('tenant-resource-service — links', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });
  afterEach(() => testDb?.close());

  it('creates link with valid url', () => {
    const u = seedUser(testDb, 'a@e.com');
    const l = createLink(u, { userId: u, role: 'tenant_admin' }, {
      url: 'https://example.com/article', title: 'Title', tags: ['web', 'ref'],
    });
    expect(l.url).toBe('https://example.com/article');
    expect(l.isFavorite).toBe(false);
    expect(l.tags).toEqual(['web', 'ref']);
  });

  it('rejects invalid url', () => {
    const u = seedUser(testDb, 'a@e.com');
    expect(() => createLink(u, { userId: u, role: 'tenant_admin' }, { url: 'not-a-url' })).toThrow(ResourceError);
    expect(() => createLink(u, { userId: u, role: 'tenant_admin' }, { url: '' })).toThrow(ResourceError);
  });

  it('favorites-only filter returns only flagged', () => {
    const u = seedUser(testDb, 'a@e.com');
    const actor = { userId: u, role: 'tenant_admin' as const };
    createLink(u, actor, { url: 'https://a.com' });
    createLink(u, actor, { url: 'https://b.com', isFavorite: true });
    expect(listLinks(u, { favoritesOnly: true })).toHaveLength(1);
    expect(listLinks(u, { favoritesOnly: false })).toHaveLength(2);
  });

  it('updateLink toggles favorite', () => {
    const u = seedUser(testDb, 'a@e.com');
    const actor = { userId: u, role: 'tenant_admin' as const };
    const l = createLink(u, actor, { url: 'https://c.com' });
    expect(l.isFavorite).toBe(false);
    const updated = updateLink(u, l.id, actor, { isFavorite: true });
    expect(updated.isFavorite).toBe(true);
  });

  it('tenant isolation — delete refuses cross-tenant', () => {
    const a = seedUser(testDb, 'a@e.com');
    const b = seedUser(testDb, 'b@e.com');
    const l = createLink(a, { userId: a, role: 'tenant_admin' }, { url: 'https://a.com' });
    try {
      deleteLink(b, l.id, { userId: b, role: 'tenant_admin' });
      expect.fail('expected NOT_FOUND');
    } catch (e) {
      expect((e as ResourceError).code).toBe('NOT_FOUND');
    }
  });
});
