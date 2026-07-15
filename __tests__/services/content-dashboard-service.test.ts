/**
 * Content Dashboard Service — Canonical Read Model Tests
 *
 * Covers:
 *   1. Books: getBooks() returns correct shape with aggregates
 *   2. Voice DNA: getVoiceDna() uses canonical service, applies labels
 *   3. Pipeline recent: getPipelineRecent() returns structured items
 *   4. Knowledge stats: getKnowledgeStats() aggregates correctly
 *   5. Sprint mode: toggleSprintMode() uses intelligence bus, not raw SQL
 *   6. No raw SQL in portal endpoints (structural check)
 *   7. Contract consistency: portal and dashboard use same service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  getBooks,
  getVoiceDna,
  getPipelineRecent,
  getKnowledgeStats,
  isSprintModeActive,
  toggleSprintMode,
} from '../../src/services/content-dashboard-service';
import { setDbProvider } from '../../src/services/intelligence-bus';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    anthropic: { apiKey: 'test' },
    app: { timezone: 'Europe/Lisbon' },
  },
}));


// ═══════════════════════════════════════════════════════════════════
// 1. Books
// ═══════════════════════════════════════════════════════════════════

describe('content-dashboard-service: books', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('returns empty overview with zero books', () => {
    const result = getBooks();
    expect(result.total).toBe(0);
    expect(result.extracted).toBe(0);
    expect(result.pending).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it('returns books with correct shape', () => {
    testDb.prepare(`
      INSERT INTO book_library (title, author, core_thesis, extraction_status, times_referenced, user_id, owner_scope)
      VALUES ('The Road to Serfdom', 'F.A. Hayek', 'Central planning leads to tyranny', 'extracted', 5, 0, 'system')
    `).run();

    const result = getBooks();
    expect(result.total).toBe(1);
    expect(result.extracted).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('The Road to Serfdom');
    expect(result.rows[0].author).toBe('F.A. Hayek');
    expect(result.rows[0].status).toBe('extracted');
    expect(result.rows[0].timesReferenced).toBe(5);
  });

  it('aggregates extracted and pending counts', () => {
    testDb.prepare(`INSERT INTO book_library (title, author, extraction_status, user_id, owner_scope) VALUES ('A', 'X', 'extracted', 0, 'system')`).run();
    testDb.prepare(`INSERT INTO book_library (title, author, extraction_status, user_id, owner_scope) VALUES ('B', 'Y', 'extracted', 0, 'system')`).run();
    testDb.prepare(`INSERT INTO book_library (title, author, extraction_status, user_id, owner_scope) VALUES ('C', 'Z', 'pending', 0, 'system')`).run();

    const result = getBooks();
    expect(result.total).toBe(3);
    expect(result.extracted).toBe(2);
    expect(result.pending).toBe(1);
  });

  it('prefers a user-owned book over the same system seed book', () => {
    testDb.prepare(`
      INSERT INTO book_library (title, author, extraction_status, user_id, owner_scope)
      VALUES ('The Law', 'Bastiat', 'extracted', 0, 'system')
    `).run();
    testDb.prepare(`
      INSERT INTO book_library (title, author, extraction_status, user_id, owner_scope)
      VALUES ('The Law', 'Bastiat', 'pending', 42, 'user')
    `).run();

    const result = getBooks(50, undefined, 42);

    expect(result.total).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe('pending');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Voice DNA
// ═══════════════════════════════════════════════════════════════════

describe('content-dashboard-service: voice DNA', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('returns voice DNA with human-readable labels', () => {
    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, version, user_id, owner_scope)
      VALUES ('hook_style', 'Bold questions as openers', '["@channelA"]', 1, 0, 'system')
    `).run();

    const voiceDna = getVoiceDna();
    expect(voiceDna).toHaveLength(1);
    expect(voiceDna[0].category).toBe('hook_style');
    expect(voiceDna[0].label).toBe('Hook Styles');
    expect(voiceDna[0].text).toContain('Bold questions');
    expect(voiceDna[0].sources).toEqual(['@channelA']);
  });

  it('handles unknown categories gracefully', () => {
    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, version, user_id, owner_scope)
      VALUES ('custom_cat', 'Custom data', '[]', 1, 0, 'system')
    `).run();

    const voiceDna = getVoiceDna();
    expect(voiceDna[0].label).toBe('custom_cat'); // Falls back to raw category name
  });

  it('prefers user voice DNA over a system row with the same category', () => {
    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, version, user_id, owner_scope)
      VALUES ('brand_voice', 'System voice', '["system"]', 1, 0, 'system')
    `).run();
    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, version, user_id, owner_scope)
      VALUES ('brand_voice', 'User voice', '["@user"]', 2, 42, 'user')
    `).run();

    const voiceDna = getVoiceDna(undefined, 42);

    expect(voiceDna).toHaveLength(1);
    expect(voiceDna[0].text).toBe('User voice');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Pipeline Recent
// ═══════════════════════════════════════════════════════════════════

describe('content-dashboard-service: pipeline recent', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('returns recent pipeline items with correct shape', () => {
    testDb.prepare(`
      INSERT INTO content_pipeline (topic_title, niche, stage, stage_history)
      VALUES ('AI Fitness', 'tech', 'scripted', '[]')
    `).run();

    const recent = getPipelineRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0].topicTitle).toBe('AI Fitness');
    expect(recent[0].niche).toBe('tech');
    expect(recent[0].stage).toBe('scripted');
    expect(recent[0]).toHaveProperty('createdAt');
    expect(recent[0]).toHaveProperty('updatedAt');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      testDb.prepare(`
        INSERT INTO content_pipeline (topic_title, stage, stage_history)
        VALUES ('Topic ' || ?, 'approved', '[]')
      `).run(i);
    }

    expect(getPipelineRecent(3)).toHaveLength(3);
    expect(getPipelineRecent(10)).toHaveLength(10);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Knowledge Stats
// ═══════════════════════════════════════════════════════════════════

describe('content-dashboard-service: knowledge stats', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('returns category stats and channel count', () => {
    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, user_id, owner_scope)
      VALUES ('hook_style', 'text', '["a","b"]', 0, 'system')
    `).run();
    testDb.prepare(`
      INSERT INTO content_ref_channels (channel_url, status, user_id, owner_scope)
      VALUES ('https://youtube.com/@test', 'active', 0, 'system')
    `).run();

    const stats = getKnowledgeStats();
    expect(stats.categories).toHaveLength(1);
    expect(stats.categories[0].category).toBe('hook_style');
    expect(stats.categories[0].sources).toBe(2);
    expect(stats.referenceChannels).toBe(1);
  });

  it('dedupes reference channels when a user overrides a system seed', () => {
    testDb.prepare(`
      INSERT INTO content_ref_channels (channel_url, status, user_id, owner_scope)
      VALUES ('https://youtube.com/@shared', 'active', 0, 'system')
    `).run();
    testDb.prepare(`
      INSERT INTO content_ref_channels (channel_url, status, user_id, owner_scope)
      VALUES ('https://youtube.com/@shared', 'active', 42, 'user')
    `).run();

    const stats = getKnowledgeStats(undefined, 42);

    expect(stats.referenceChannels).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Sprint Mode (uses intelligence bus, not raw SQL)
// ═══════════════════════════════════════════════════════════════════

describe('content-dashboard-service: sprint mode', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb);
  });
  afterEach(() => testDb?.close());

  it('isSprintModeActive returns false when no signal', () => {
    expect(isSprintModeActive()).toBe(false);
  });

  it('toggleSprintMode enables then disables', () => {
    // Enable
    const on = toggleSprintMode();
    expect(on.sprint).toBe(true);

    // Should be active now
    expect(isSprintModeActive()).toBe(true);

    // Disable
    const off = toggleSprintMode();
    expect(off.sprint).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. No Raw SQL in Portal Endpoints (structural)
// ═══════════════════════════════════════════════════════════════════

describe('content-dashboard-service: no raw SQL duplication', () => {
  const portalContentRoutesPath = path.resolve(__dirname, '../../src/portal/content-routes.ts');

  it('portal GET /api/books uses getBooks from service', () => {
    const source = fs.readFileSync(
      portalContentRoutesPath,
      'utf8',
    );
    // Should use canonical service
    expect(source).toContain("from '../services/content-dashboard-service'");
    expect(source).toContain('getBooks');
  });

  it('portal GET /api/content-knowledge uses getVoiceDna from service', () => {
    const source = fs.readFileSync(
      portalContentRoutesPath,
      'utf8',
    );
    expect(source).toContain('getVoiceDna');
  });

  it('portal POST /api/override/sprint uses toggleSprintMode from service', () => {
    const source = fs.readFileSync(
      portalContentRoutesPath,
      'utf8',
    );
    expect(source).toContain('toggleSprintMode');
    // Should NOT have raw SQL for sprint mode
    const lines = source.split('\n');
    const sprintSection = lines.slice(
      lines.findIndex(l => l.includes("'/api/override/sprint'")),
      lines.findIndex(l => l.includes("'/api/override/sprint'")) + 15,
    ).join('\n');
    expect(sprintSection).not.toContain("signal_type = 'content_sprint_mode'");
  });

  it('legacy portal content mutations are disabled in favor of scoped v1 routes', () => {
    const source = fs.readFileSync(
      portalContentRoutesPath,
      'utf8',
    );
    expect(source).toContain('SCOPED_V1_REQUIRED');
    expect(source).toContain('/api/v1/admin/content');
    expect(source).not.toContain('addAndAnalyzeChannel(url');
    expect(source).not.toContain('handleAddBookFromPortal(title');
  });

  it('content-dashboard.ts uses getBooks from service', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/content-dashboard.ts'),
      'utf8',
    );
    expect(source).toContain('content-dashboard-service');
    expect(source).toContain('getBooks');
  });

  it('content-dashboard.ts uses getVoiceDna from service', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/content-dashboard.ts'),
      'utf8',
    );
    expect(source).toContain('getVoiceDna');
  });

  it('content-dashboard.ts uses getPipelineRecent from service', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/content-dashboard.ts'),
      'utf8',
    );
    expect(source).toContain('getPipelineRecent');
  });

  it('content-dashboard.ts uses getKnowledgeStats from service', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/api/routes/content-dashboard.ts'),
      'utf8',
    );
    expect(source).toContain('getKnowledgeStats');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Contract Consistency
// ═══════════════════════════════════════════════════════════════════

describe('content-dashboard-service: contract consistency', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => testDb?.close());

  it('getBooks returns BookSummary shape matching portal contract', () => {
    testDb.prepare(`
      INSERT INTO book_library (title, author, extraction_status, user_id, owner_scope)
      VALUES ('Test Book', 'Author', 'extracted', 0, 'system')
    `).run();

    const result = getBooks();
    const book = result.rows[0];

    // These are the fields the portal HTML renders
    expect(book).toHaveProperty('id');
    expect(book).toHaveProperty('title');
    expect(book).toHaveProperty('author');
    expect(book).toHaveProperty('status');
    expect(book).toHaveProperty('thesis');
    expect(book).toHaveProperty('frameworks');
    expect(book).toHaveProperty('timesReferenced');
    expect(book).toHaveProperty('createdAt');
  });

  it('getVoiceDna returns VoiceDnaEntry shape matching portal contract', () => {
    testDb.prepare(`
      INSERT INTO content_knowledge (category, synthesized_text, source_channels, version, user_id, owner_scope)
      VALUES ('hook_style', 'text', '[]', 1, 0, 'system')
    `).run();

    const dna = getVoiceDna();
    const entry = dna[0];

    expect(entry).toHaveProperty('category');
    expect(entry).toHaveProperty('label');
    expect(entry).toHaveProperty('text');
    expect(entry).toHaveProperty('sources');
    expect(entry).toHaveProperty('version');
    expect(entry).toHaveProperty('updatedAt');
  });

  it('getPipelineRecent returns PipelineRecentItem shape', () => {
    testDb.prepare(`
      INSERT INTO content_pipeline (topic_title, niche, stage, stage_history)
      VALUES ('Test', 'tech', 'scripted', '[]')
    `).run();

    const recent = getPipelineRecent();
    const item = recent[0];

    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('topicTitle');
    expect(item).toHaveProperty('niche');
    expect(item).toHaveProperty('stage');
    expect(item).toHaveProperty('createdAt');
    expect(item).toHaveProperty('updatedAt');
    expect(item).toHaveProperty('publishedUrl');
    expect(item).toHaveProperty('publishedAt');
  });
});
