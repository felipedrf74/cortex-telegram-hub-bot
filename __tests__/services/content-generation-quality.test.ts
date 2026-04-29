import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { ScopedContentReference } from '../../src/services/content-reference-context';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import {
  buildContentGenerationPackage,
  buildContentRefinementPlan,
  evaluateContentGenerationQuality,
  normalizeContentGenerationFormat,
} from '../../src/services/content-generation-quality';
import { addContentReferenceLink } from '../../src/services/content-reference-context';
import {
  upsertContentBrandProfile,
  upsertContentVoiceProfile,
} from '../../src/services/content-memory-profile';

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

function scopedReference(overrides: Partial<ScopedContentReference> = {}): ScopedContentReference {
  return {
    id: 1,
    type: 'book',
    title: 'Creator Systems Playbook',
    url: null,
    sourceId: 'book:1',
    source: 'book_library',
    freshness: '2026-04-29T12:00:00.000Z',
    confidence: 0.86,
    trustLevel: 'curated',
    extractionStatus: 'ready',
    freshnessScore: 0.9,
    qualityScore: 0.84,
    brokenStatus: 'ok',
    staleStatus: 'fresh',
    needsReview: false,
    rejectionReasons: [],
    ...overrides,
  };
}

describe('Content generation quality pipeline', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('normalizes platform aliases into supported generation formats', () => {
    expect(normalizeContentGenerationFormat('YouTube')).toBe('youtube_long_form');
    expect(normalizeContentGenerationFormat('reel')).toBe('instagram_reel');
    expect(normalizeContentGenerationFormat('twitter thread')).toBe('x_thread');
    expect(normalizeContentGenerationFormat('podcast')).toBe('podcast_outline');
  });

  it('builds different platform contracts for YouTube scripts and LinkedIn posts', () => {
    const youtube = buildContentGenerationPackage({
      userId: 501,
      tenantId: 101,
      topic: 'Creator operating systems',
      formatId: 'youtube_long_form',
      references: [scopedReference()],
      workflowState: 'drafted',
    });
    const linkedin = buildContentGenerationPackage({
      userId: 501,
      tenantId: 101,
      topic: 'Creator operating systems',
      formatId: 'linkedin_post',
      references: [scopedReference()],
      workflowState: 'drafted',
    });

    expect(youtube.outputContract.requiredFields).toContain('script');
    expect(youtube.outputContract.structure).toContain('cold_open');
    expect(linkedin.outputContract.requiredFields).toContain('discussionPrompt');
    expect(linkedin.outputContract.structure).toContain('scroll_stop_line');
    expect(youtube.promptBlock).not.toEqual(linkedin.promptBlock);
  });

  it('applies tenant-scoped voice and brand memory to the generation contract', () => {
    upsertContentVoiceProfile({
      userId: 501,
      tenantId: 501,
      tone: 'Direct, practical, slightly contrarian.',
      source: 'voice_profile',
    });
    upsertContentBrandProfile({
      userId: 501,
      tenantId: 501,
      audience: ['founder creators'],
      contentPillars: ['creator systems'],
      preferredFormats: ['youtube_long_form'],
      source: 'brand_profile',
    });

    const generation = buildContentGenerationPackage({
      userId: 501,
      tenantId: 501,
      topic: 'Creator systems for founder creators',
      formatId: 'youtube_long_form',
      references: [scopedReference()],
      workflowState: 'drafted',
    });

    expect(generation.voiceContext.contextBlock).toContain('Direct, practical, slightly contrarian.');
    expect(generation.promptBlock).toContain('creator systems');
    expect(generation.voiceContext.appliedMemoryKeys).toEqual(expect.arrayContaining([
      'voice.tone',
      'brand.audience',
      'brand.content_pillars',
    ]));
  });

  it('keeps source-grounded references and source confidence in the generation package', () => {
    const generation = buildContentGenerationPackage({
      userId: 501,
      tenantId: 101,
      topic: 'Creator operating systems',
      formatId: 'blog',
      references: [scopedReference({ sourceId: 'book:creator-system', qualityScore: 0.9, confidence: 0.8 })],
      workflowState: 'outlined',
    });

    expect(generation.sourceGrounding).toBe('grounded');
    expect(generation.sourceConfidence).toBeGreaterThanOrEqual(0.8);
    expect(generation.promptBlock).toContain('book:creator-system');
    expect(generation.promptBlock).toContain('Do not borrow references');
  });

  it('flags unsupported claims in generated output quality review', () => {
    const generation = buildContentGenerationPackage({
      userId: 501,
      tenantId: 101,
      topic: 'Creator systems',
      formatId: 'linkedin_post',
      references: [scopedReference({ sourceId: 'book:1' })],
      workflowState: 'drafted',
    });

    const quality = evaluateContentGenerationQuality({
      package: generation,
      outputText: 'Hook\nA strong body with a claim.\nWhat would you change?',
      claims: [
        { id: 'supported', text: 'Systems help creators repeat work.', supportedBy: ['book:1'] },
        { id: 'unsupported', text: 'This increases revenue by 47%.', supportedBy: ['missing-ref'] },
      ],
    });

    expect(quality.sourceGrounding).toBe('partially_grounded');
    expect(quality.unsupportedClaims.map((claim) => claim.id)).toEqual(['unsupported']);
    expect(quality.reviewWarnings).toContain('unsupported_claims_require_review');
    expect(quality.reviewRequired).toBe(true);
  });

  it('preserves source provenance during refinements', () => {
    const plan = buildContentRefinementPlan({
      userId: 501,
      tenantId: 101,
      topic: 'Creator systems',
      currentContent: 'A draft based on the creator systems playbook.',
      refinementRequest: 'Make it shorter and more direct',
      formatId: 'youtube_long_form',
      currentReferences: [scopedReference({ sourceId: 'book:creator-system' })],
      workflowState: 'drafted',
    });

    expect(plan.intent).toBe('shorten');
    expect(plan.preservesProvenance).toBe(true);
    expect(plan.referencesUsed.map((ref) => ref.sourceId)).toEqual(['book:creator-system']);
    expect(plan.promptBlock).toContain('Preserve source provenance');
  });

  it('requires short-form output contracts to carry hook and pacing expectations', () => {
    const generation = buildContentGenerationPackage({
      userId: 501,
      tenantId: 101,
      topic: 'One creator system mistake',
      formatId: 'instagram_reel',
      references: [scopedReference()],
      workflowState: 'drafted',
    });

    expect(generation.outputContract.requiredFields).toEqual(expect.arrayContaining([
      'firstSecondHook',
      'shortScript',
      'visualBeats',
    ]));
    expect(generation.outputContract.platformNotes.join('\n')).toContain('Fast but warm');
  });

  it('adapts content across platforms with target-specific contracts', () => {
    const plan = buildContentRefinementPlan({
      userId: 501,
      tenantId: 101,
      topic: 'Creator systems',
      currentContent: 'Long-form script draft.',
      refinementRequest: 'Turn this into a thread',
      formatId: 'youtube_long_form',
      targetFormatId: 'x_thread',
      currentReferences: [scopedReference()],
      workflowState: 'drafted',
    });

    expect(plan.intent).toBe('adapt_platform');
    expect(plan.targetFormatId).toBe('x_thread');
    expect(plan.actions.join('\n')).toContain('Adapt pacing, hook, and production notes');
    expect(plan.promptBlock).toContain('Thread');
  });

  it('flags low-confidence sources for review instead of treating them as clean grounding', () => {
    const generation = buildContentGenerationPackage({
      userId: 501,
      tenantId: 101,
      topic: 'Unverified creator claim',
      formatId: 'caption',
      references: [scopedReference({
        sourceId: 'link:low',
        type: 'link',
        trustLevel: 'unverified',
        confidence: 0.42,
        qualityScore: 0.44,
        needsReview: true,
      })],
      workflowState: 'drafted',
    });

    expect(generation.sourceGrounding).toBe('partially_grounded');
    expect(generation.reviewWarnings).toEqual(expect.arrayContaining([
      'low_confidence_source_requires_review',
      'source_confidence_low',
    ]));
  });

  it('preserves tenant-safe model-routing metadata and excludes other-tenant references before provider calls', () => {
    addContentReferenceLink({
      userId: 501,
      tenantId: 101,
      url: 'https://tenant-a.example/source',
      title: 'Tenant A source',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      qualityScore: 0.8,
      freshnessScore: 0.8,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
    });
    addContentReferenceLink({
      userId: 601,
      tenantId: 202,
      url: 'https://tenant-b.example/source',
      title: 'Tenant B source',
      extractionStatus: 'ready',
      trustLevel: 'curated',
      qualityScore: 0.9,
      freshnessScore: 0.9,
      brokenStatus: 'ok',
      staleStatus: 'fresh',
    });

    const generation = buildContentGenerationPackage({
      userId: 501,
      tenantId: 101,
      topic: 'Tenant-safe creator source',
      formatId: 'youtube_long_form',
      workflowState: 'drafted',
    });

    expect(generation.modelRoutingMetadata).toMatchObject({
      taskType: 'chat',
      category: 'content_generation',
      tenantId: 101,
      userId: 501,
      providerAgnostic: true,
      preserveOperatorOverrides: true,
    });
    expect(generation.promptBlock).toContain('Tenant A source');
    expect(generation.promptBlock).not.toContain('Tenant B source');
  });
});
