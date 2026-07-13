import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

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

import {
  addContentReferenceLink,
  buildAuthorizedContentReferenceContext,
  getScopedChannelsForGeneration,
} from '../../src/services/content-reference-context';
import {
  assessClaimsGrounding,
  ensureContentReferenceProvenanceTables,
  getContentOutputProvenance,
  recordContentOutputProvenance,
  retrieveAuthorizedContentReferences,
  upsertContentReference,
} from '../../src/services/content-reference-provenance';

function seedSchema(): void {
  testDb.exec(`
    CREATE TABLE book_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      times_referenced INTEGER DEFAULT 0,
      extraction_status TEXT DEFAULT 'ready',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      user_id INTEGER DEFAULT 0,
      owner_scope TEXT,
      tenant_id INTEGER,
      owner_user_id INTEGER,
      visibility_scope TEXT,
      lifecycle_state TEXT,
      scope_status TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      audit_metadata_json TEXT DEFAULT '{}'
    );

    CREATE TABLE content_reference_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 0,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      scope_status TEXT NOT NULL DEFAULT 'active',
      url TEXT NOT NULL,
      title TEXT,
      source_type TEXT NOT NULL DEFAULT 'link',
      extraction_status TEXT NOT NULL DEFAULT 'pending',
      source_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_by INTEGER NOT NULL,
      updated_by INTEGER NOT NULL,
      audit_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, owner_user_id, url)
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
      lifecycle_state TEXT,
      scope_status TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      audit_metadata_json TEXT DEFAULT '{}'
    );

    CREATE TABLE content_source_output_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      output_object_type TEXT NOT NULL,
      output_id TEXT NOT NULL,
      usage_type TEXT NOT NULL DEFAULT 'inspiration',
      attribution_text TEXT,
      claim_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5,
      created_by INTEGER NOT NULL,
      audit_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, owner_user_id, source_type, source_id, output_object_type, output_id, usage_type)
    );
  `);
}

function insertBook(userId: number, title: string, overrides = ''): number {
  return Number(testDb.prepare(`
    INSERT INTO book_library (
      title, author, times_referenced, extraction_status, user_id, owner_scope,
      tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
      created_by, updated_by ${overrides ? `, ${overrides.split('=')[0].trim()}` : ''}
    )
    VALUES (?, 'Author', 3, 'ready', ?, 'user', ?, ?, 'user_private', 'active', 'active', ?, ?
      ${overrides ? `, ${overrides.split('=').slice(1).join('=').trim()}` : ''})
  `).run(title, userId, userId, userId, userId, userId).lastInsertRowid);
}

describe('Content reference provenance integrity', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    seedSchema();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('retrieves only tenant/user authorized references from the registry', () => {
    upsertContentReference({
      userId: 101,
      referenceType: 'book',
      sourceIdentifier: 'book-a',
      title: 'Tenant A creator playbook',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      confidenceScore: 0.9,
      qualityScore: 0.85,
      freshnessScore: 0.9,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
      topicTags: ['creator systems'],
      sourceSummary: 'Tenant A strategy.',
      sourceMetadata: { title: 'Tenant A creator playbook', author: 'A' },
    });
    upsertContentReference({
      userId: 202,
      referenceType: 'book',
      sourceIdentifier: 'book-b',
      title: 'Tenant B private playbook',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      confidenceScore: 0.95,
      qualityScore: 0.9,
      freshnessScore: 0.9,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
      topicTags: ['creator systems'],
      sourceSummary: 'Tenant B strategy.',
      sourceMetadata: { title: 'Tenant B private playbook', author: 'B' },
    });

    const refs = retrieveAuthorizedContentReferences({ userId: 101, query: 'creator systems' });

    expect(refs.map((ref) => ref.title)).toEqual(['Tenant A creator playbook']);
    expect(refs.map((ref) => ref.title).join('\n')).not.toContain('Tenant B');
  });

  it('uses book, channel, and healthy link references while rejecting broken links silently before prompt construction', () => {
    insertBook(101, 'Tenant A Book');
    testDb.prepare(`
      INSERT INTO content_ref_channels (
        channel_url, channel_name, status, video_count_analyzed, user_id, owner_scope,
        tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
        created_by, updated_by
      )
      VALUES ('https://youtube.com/@a', 'Tenant A Channel', 'active', 8, 101, 'user',
        101, 101, 'user_private', 'active', 'active', 101, 101)
    `).run();
    addContentReferenceLink({
      userId: 101,
      url: 'https://tenant-a.example/source',
      title: 'Tenant A healthy link',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      qualityScore: 0.8,
      freshnessScore: 0.8,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
    });
    addContentReferenceLink({
      userId: 101,
      url: 'https://tenant-a.example/broken',
      title: 'Tenant A broken link',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      qualityScore: 0.8,
      freshnessScore: 0.8,
      brokenStatus: 'broken',
      staleStatus: 'fresh',
    });

    const context = buildAuthorizedContentReferenceContext(101);
    const channels = getScopedChannelsForGeneration(101);

    expect(context.promptBlock).toContain('Tenant A Book');
    expect(context.promptBlock).toContain('Tenant A healthy link');
    expect(context.promptBlock).toContain('Tenant A Channel');
    expect(context.promptBlock).not.toContain('Tenant A broken link');
    expect(channels.map((channel) => channel.title)).toEqual(['Tenant A Channel']);
  });

  it('treats default user-added links as grounded content references', () => {
    addContentReferenceLink({
      userId: 101,
      url: 'https://tenant-a.example/default-link',
      title: 'Tenant A default link',
    });

    const context = buildAuthorizedContentReferenceContext(101);

    expect(context.promptBlock).toContain('[GROUNDED REFERENCES]');
    expect(context.promptBlock).toContain('Tenant A default link');
    expect(context.promptBlock.indexOf('Tenant A default link')).toBeLessThan(
      context.promptBlock.indexOf('[INSPIRATION ONLY — DO NOT CITE]'),
    );
  });

  it('adds healthy defaults when content reference link health columns are bootstrapped', () => {
    testDb.exec(`
      DROP TABLE content_reference_links;
      CREATE TABLE content_reference_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        tenant_id INTEGER NOT NULL,
        owner_user_id INTEGER NOT NULL,
        visibility_scope TEXT NOT NULL DEFAULT 'user_private',
        lifecycle_state TEXT NOT NULL DEFAULT 'active',
        scope_status TEXT NOT NULL DEFAULT 'active',
        url TEXT NOT NULL,
        title TEXT,
        source_type TEXT NOT NULL DEFAULT 'link',
        source_metadata_json TEXT NOT NULL DEFAULT '{}',
        created_by INTEGER NOT NULL,
        updated_by INTEGER NOT NULL,
        audit_metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    ensureContentReferenceProvenanceTables(testDb);

    const defaults = Object.fromEntries(
      (testDb.prepare('PRAGMA table_info(content_reference_links)').all() as Array<{
        name: string;
        dflt_value: string | null;
      }>).map((column) => [column.name, column.dflt_value]),
    );
    expect(defaults.extraction_status).toBe("'ready'");
    expect(defaults.trust_level).toBe("'observed'");
    expect(defaults.broken_status).toBe("'ok'");
    expect(defaults.stale_status).toBe("'fresh'");
  });

  it('backfills active legacy link defaults without reviving archived links', () => {
    testDb.exec(`
      ALTER TABLE content_reference_links ADD COLUMN trust_level TEXT DEFAULT 'unverified';
      ALTER TABLE content_reference_links ADD COLUMN broken_status TEXT DEFAULT 'unknown';
      ALTER TABLE content_reference_links ADD COLUMN stale_status TEXT DEFAULT 'unknown';

      INSERT INTO content_reference_links (
        user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
        url, title, source_type, created_by, updated_by
      )
      VALUES
        (101, 101, 101, 'user_private', 'active', 'active',
          'https://tenant-a.example/legacy-active', 'Legacy active link', 'link', 101, 101),
        (101, 101, 101, 'user_private', 'active', 'archived',
          'https://tenant-a.example/legacy-archived', 'Legacy archived link', 'link', 101, 101);

      INSERT INTO content_reference_links (
        user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
        url, title, source_type, extraction_status, trust_level, broken_status, stale_status,
        created_by, updated_by
      )
      VALUES (
        101, 101, 101, 'user_private', 'active', 'active',
        'https://tenant-a.example/explicit-broken', 'Explicit broken link', 'link',
        'ready', 'curated', 'broken', 'stale', 101, 101
      );
    `);

    testDb.exec(readFileSync(path.join(process.cwd(), 'migrations/201_content_reference_link_grounded_defaults.sql'), 'utf8'));

    const rows = testDb.prepare(`
      SELECT url, extraction_status, trust_level, broken_status, stale_status
        FROM content_reference_links
       ORDER BY url
    `).all() as Array<{
      url: string;
      extraction_status: string;
      trust_level: string;
      broken_status: string;
      stale_status: string;
    }>;

    expect(rows).toEqual([
      {
        url: 'https://tenant-a.example/explicit-broken',
        extraction_status: 'ready',
        trust_level: 'curated',
        broken_status: 'broken',
        stale_status: 'stale',
      },
      {
        url: 'https://tenant-a.example/legacy-active',
        extraction_status: 'ready',
        trust_level: 'observed',
        broken_status: 'ok',
        stale_status: 'fresh',
      },
      {
        url: 'https://tenant-a.example/legacy-archived',
        extraction_status: 'pending',
        trust_level: 'unverified',
        broken_status: 'unknown',
        stale_status: 'unknown',
      },
    ]);
  });

  it('flags unsupported claims and preserves grounded provenance for generated outputs', () => {
    const referenceId = upsertContentReference({
      userId: 101,
      referenceType: 'book',
      sourceIdentifier: 'book-a',
      title: 'Tenant A source',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      confidenceScore: 0.9,
      qualityScore: 0.85,
      freshnessScore: 0.9,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
      sourceSummary: 'Supports creator workflow claims.',
      sourceMetadata: { title: 'Tenant A source', author: 'A' },
    });
    const [reference] = retrieveAuthorizedContentReferences({ userId: 101, query: 'source' });
    expect(reference.id).toBe(referenceId);

    const grounding = assessClaimsGrounding([
      { id: 'claim-1', text: 'Creator workflows improve consistency.', supportedBy: [reference.referenceId], confidence: 0.8 },
      { id: 'claim-2', text: 'Unsupported benchmark claim.', supportedBy: [], confidence: 0.4 },
    ], [reference]);

    expect(grounding.groundingStatus).toBe('partially_grounded');
    expect(grounding.unsupportedClaims.map((claim) => claim.id)).toEqual(['claim-2']);

    recordContentOutputProvenance({
      userId: 101,
      outputObjectType: 'script',
      outputId: 'script-1',
      referencesUsed: [reference],
      claims: [
        { id: 'claim-1', text: 'Creator workflows improve consistency.', supportedBy: [reference.referenceId], confidence: 0.8 },
        { id: 'claim-2', text: 'Unsupported benchmark claim.', supportedBy: [], confidence: 0.4 },
      ],
    });

    const provenance = getContentOutputProvenance(101, 'script', 'script-1');
    expect(provenance?.groundingStatus).toBe('partially_grounded');
    expect(provenance?.reviewRequired).toBe(true);
    expect(provenance?.unsupportedClaims).toHaveLength(1);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_source_output_links').get()).toEqual({ count: 1 });
  });

  it('classifies outputs with references but no factual claims as no_claims without source review', () => {
    const referenceId = upsertContentReference({
      userId: 101,
      referenceType: 'book',
      sourceIdentifier: 'book-no-claims',
      title: 'Tenant A source for style only',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      confidenceScore: 0.9,
      qualityScore: 0.85,
      freshnessScore: 0.9,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
      sourceSummary: 'Style inspiration.',
      sourceMetadata: { title: 'Tenant A source for style only', author: 'A' },
    });
    const [reference] = retrieveAuthorizedContentReferences({ userId: 101, query: 'style' });
    expect(reference.id).toBe(referenceId);

    const grounding = assessClaimsGrounding([], [reference]);

    expect(grounding).toEqual({
      groundingStatus: 'no_claims',
      unsupportedClaims: [],
      reviewRequired: false,
    });
  });

  it('partitions review-required references into an inspiration-only prompt block that cannot be cited', () => {
    addContentReferenceLink({
      userId: 101,
      url: 'https://tenant-a.example/grounded',
      title: 'Grounded reference',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      qualityScore: 0.8,
      freshnessScore: 0.8,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
    });
    addContentReferenceLink({
      userId: 101,
      url: 'https://tenant-a.example/review',
      title: 'Needs review reference',
      extractionStatus: 'pending',
      trustLevel: 'unverified',
      qualityScore: 0.8,
      freshnessScore: 0.8,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
    });

    const context = buildAuthorizedContentReferenceContext(101);

    expect(context.promptBlock).toContain('[GROUNDED REFERENCES]');
    expect(context.promptBlock).toContain('Citations and factual source claims may use only entries in this block.');
    expect(context.promptBlock).toContain('[INSPIRATION ONLY — DO NOT CITE]');
    expect(context.promptBlock).toContain('Entries in this block may inform tone or exploration only. They must never be cited');
    expect(context.promptBlock.indexOf('Grounded reference')).toBeLessThan(context.promptBlock.indexOf('[INSPIRATION ONLY — DO NOT CITE]'));
    expect(context.promptBlock.indexOf('Needs review reference')).toBeGreaterThan(context.promptBlock.indexOf('[INSPIRATION ONLY — DO NOT CITE]'));
  });

  it('rejects hallucinated or cross-tenant reference ids in claim grounding', () => {
    const tenantARefId = upsertContentReference({
      userId: 101,
      referenceType: 'link',
      sourceIdentifier: 'https://tenant-a.example/brief',
      title: 'Tenant A brief',
      url: 'https://tenant-a.example/brief',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      confidenceScore: 0.8,
      qualityScore: 0.8,
      freshnessScore: 0.8,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
    });
    upsertContentReference({
      userId: 202,
      referenceType: 'link',
      sourceIdentifier: 'https://tenant-b.example/private',
      title: 'Tenant B private brief',
      url: 'https://tenant-b.example/private',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      confidenceScore: 0.9,
      qualityScore: 0.9,
      freshnessScore: 0.9,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
    });
    const [tenantARef] = retrieveAuthorizedContentReferences({ userId: 101 });
    expect(tenantARef.id).toBe(tenantARefId);

    const grounding = assessClaimsGrounding([
      { id: 'claim-tenant-b', text: 'Claim cites another tenant.', supportedBy: ['link:9999'] },
    ], [tenantARef]);

    expect(grounding.groundingStatus).toBe('ungrounded');
    expect(grounding.unsupportedClaims).toHaveLength(1);
  });
});
