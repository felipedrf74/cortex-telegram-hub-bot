import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import {
  addContentReferenceLink,
  buildAuthorizedContentReferenceContext,
  getScopedChannelsForGeneration,
} from '../../src/services/content-reference-context';
import {
  assessClaimsGrounding,
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
