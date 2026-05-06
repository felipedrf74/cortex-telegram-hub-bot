import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import { getContentRadarPreferences, setContentRadarPreferences } from '../../src/services/content-radar-preferences';
import {
  addContentReferenceLink,
  buildAuthorizedContentReferenceContext,
  getScopedBooksForGeneration,
  getScopedChannelsForGeneration,
  getScopedLinksForGeneration,
} from '../../src/services/content-reference-context';
import { getAllKnowledge, getAllPatternsByCategory, upsertPatterns } from '../../src/state/content-references';

function seedSchema(): void {
  testDb.exec(`
    CREATE TABLE book_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      times_referenced INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      user_id INTEGER DEFAULT 0,
      owner_scope TEXT,
      tenant_id INTEGER,
      owner_user_id INTEGER,
      visibility_scope TEXT,
      scope_status TEXT
    );

    CREATE TABLE content_ref_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_url TEXT NOT NULL,
      channel_name TEXT,
      status TEXT DEFAULT 'pending',
      video_count_analyzed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      user_id INTEGER DEFAULT 0,
      owner_scope TEXT,
      tenant_id INTEGER,
      owner_user_id INTEGER,
      visibility_scope TEXT,
      scope_status TEXT
    );

    CREATE TABLE content_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER,
      category TEXT NOT NULL,
      pattern_text TEXT NOT NULL,
      examples TEXT DEFAULT '[]',
      confidence REAL DEFAULT 0.8,
      source_videos TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      user_id INTEGER DEFAULT 0,
      tenant_id INTEGER,
      owner_user_id INTEGER,
      visibility_scope TEXT,
      scope_status TEXT
    );

    CREATE TABLE content_knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      synthesized_text TEXT NOT NULL,
      source_channels TEXT DEFAULT '[]',
      version INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      user_id INTEGER DEFAULT 0,
      owner_scope TEXT,
      tenant_id INTEGER,
      owner_user_id INTEGER,
      visibility_scope TEXT,
      scope_status TEXT,
      UNIQUE(user_id, category)
    );

    CREATE TABLE content_radar_preferences (
      user_id INTEGER PRIMARY KEY,
      topics_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now')),
      tenant_id INTEGER,
      owner_user_id INTEGER,
      visibility_scope TEXT,
      scope_status TEXT
    );
  `);
}

function insertBook(userId: number, title: string): void {
  testDb.prepare(`
    INSERT INTO book_library (
      title, author, times_referenced, user_id, owner_scope,
      tenant_id, owner_user_id, visibility_scope, scope_status
    )
    VALUES (?, 'Author', 3, ?, 'user', ?, ?, 'user_private', 'active')
  `).run(title, userId, userId, userId);
}

describe('Content tenant/privacy scope', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    seedSchema();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('does not let tenant A use tenant B books, links, or channels as generation references', () => {
    insertBook(101, 'Tenant A Playbook');
    insertBook(202, 'Tenant B Private Playbook');

    addContentReferenceLink({ userId: 101, url: 'https://tenant-a.example/brief', title: 'Tenant A Link' });
    addContentReferenceLink({ userId: 202, url: 'https://tenant-b.example/strategy', title: 'Tenant B Link' });

    const channelA = testDb.prepare(`
      INSERT INTO content_ref_channels (
        channel_url, channel_name, status, video_count_analyzed, user_id, owner_scope,
        tenant_id, owner_user_id, visibility_scope, scope_status
      )
      VALUES ('https://youtube.com/@a', 'Tenant A Channel', 'active', 8, 101, 'user', 101, 101, 'user_private', 'active')
    `).run().lastInsertRowid as number;
    testDb.prepare(`
      INSERT INTO content_ref_channels (
        channel_url, channel_name, status, video_count_analyzed, user_id, owner_scope,
        tenant_id, owner_user_id, visibility_scope, scope_status
      )
      VALUES ('https://youtube.com/@b', 'Tenant B Channel', 'active', 8, 202, 'user', 202, 202, 'user_private', 'active')
    `).run();
    upsertPatterns(channelA, [{
      category: 'brand_voice',
      pattern_text: 'Tenant A says useful things plainly.',
      examples: ['A example'],
      confidence: 0.9,
      source_videos: ['A video'],
    }], { userId: 101 });

    const books = getScopedBooksForGeneration(101).map((ref) => ref.title);
    const links = getScopedLinksForGeneration(101).map((ref) => ref.title);
    const channels = getScopedChannelsForGeneration(101).map((ref) => ref.title);
    const context = buildAuthorizedContentReferenceContext(101).promptBlock;

    expect(books).toContain('Tenant A Playbook — Author');
    expect(books.join('\n')).not.toContain('Tenant B');
    expect(links).toEqual(['Tenant A Link']);
    expect(channels).toEqual(['Tenant A Channel']);
    expect(context).toContain('Tenant A Playbook');
    expect(context).toContain('Tenant A Link');
    expect(context).not.toContain('Tenant B');
  });

  it('partitions Voice DNA and extracted patterns by tenant before prompt use', () => {
    testDb.prepare(`
      INSERT INTO content_knowledge (
        category, synthesized_text, source_channels, user_id, owner_scope,
        tenant_id, owner_user_id, visibility_scope, scope_status
      )
      VALUES ('brand_voice', 'Tenant A voice', '[]', 101, 'user', 101, 101, 'user_private', 'active')
    `).run();
    testDb.prepare(`
      INSERT INTO content_knowledge (
        category, synthesized_text, source_channels, user_id, owner_scope,
        tenant_id, owner_user_id, visibility_scope, scope_status
      )
      VALUES ('brand_voice', 'Tenant B private voice', '[]', 202, 'user', 202, 202, 'user_private', 'active')
    `).run();

    const channelB = Number(testDb.prepare(`
      INSERT INTO content_ref_channels (
        channel_url, channel_name, status, user_id, owner_scope,
        tenant_id, owner_user_id, visibility_scope, scope_status
      )
      VALUES ('https://youtube.com/@b', 'Tenant B Channel', 'active', 202, 'user', 202, 202, 'user_private', 'active')
    `).run().lastInsertRowid);
    upsertPatterns(channelB, [{
      category: 'brand_voice',
      pattern_text: 'Tenant B cadence',
      examples: ['B example'],
      confidence: 0.9,
      source_videos: ['B video'],
    }], { userId: 202 });

    expect(getAllKnowledge(101).map((row) => row.synthesized_text)).toEqual(['Tenant A voice']);
    expect(getAllKnowledge(101).map((row) => row.synthesized_text).join('\n')).not.toContain('Tenant B');
    expect(getAllPatternsByCategory('brand_voice', 101).map((row) => row.pattern_text)).toEqual([]);
  });

  it('keeps radar preferences tenant/user scoped', () => {
    setContentRadarPreferences(101, ['AI ops', 'Creator workflow']);
    setContentRadarPreferences(202, ['Private tenant B launch']);

    expect(getContentRadarPreferences(101).topics).toEqual(['AI ops', 'Creator workflow']);
    expect(getContentRadarPreferences(202).topics).toEqual(['Private tenant B launch']);
    expect(getContentRadarPreferences(101).topics.join('\n')).not.toContain('Tenant B');
  });

  it('quarantines ambiguous legacy content rows from scoped prompt context', () => {
    testDb.prepare(`
      INSERT INTO book_library (
        title, author, user_id, owner_scope, tenant_id, owner_user_id, visibility_scope, scope_status
      )
      VALUES ('Legacy Global Strategy', 'Unknown', 0, 'system', 0, 0, 'platform_internal', 'quarantined')
    `).run();
    insertBook(101, 'Tenant A Safe Book');

    const context = buildAuthorizedContentReferenceContext(101).promptBlock;

    expect(context).toContain('Tenant A Safe Book');
    expect(context).not.toContain('Legacy Global Strategy');
  });
});
