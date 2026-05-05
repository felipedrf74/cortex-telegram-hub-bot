import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { ContentRegisteredReference } from '../../src/services/content-reference-provenance';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

import {
  buildCrossSkillContentOpportunitySignal,
  buildRadarSignalFromReference,
  convertContentRadarSignal,
  prioritizeContentRadarSignals,
  retrieveContentRadarSignals,
  scoreContentOpportunity,
  upsertContentRadarSignal,
} from '../../src/services/content-radar-engine';
import { upsertContentBrandProfile } from '../../src/services/content-memory-profile';

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

function reference(overrides: Partial<ContentRegisteredReference> = {}): ContentRegisteredReference {
  return {
    id: 1,
    referenceId: 'ref-book-1',
    tenantId: 101,
    ownerUserId: 501,
    visibilityScope: 'user_private',
    referenceType: 'book',
    sourceTable: 'content_reference_registry',
    sourcePk: '1',
    sourceIdentifier: 'book://creator-system',
    title: 'Creator System',
    url: null,
    authorSource: 'Reference Author',
    extractionStatus: 'ready',
    freshnessScore: 0.88,
    trustLevel: 'curated',
    qualityScore: 0.86,
    confidenceScore: 0.84,
    topicTags: ['creator systems'],
    relatedOutputIds: [],
    lastUsedAt: null,
    brokenStatus: 'ok',
    staleStatus: 'fresh',
    sourceSummary: 'A source-backed note about building creator systems.',
    sourceSnippets: ['Creator systems need a capture, selection, and publishing rhythm.'],
    usableForGeneration: true,
    reviewRequired: false,
    rejectionReasons: [],
    ...overrides,
  };
}

describe('Content radar opportunity engine', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('retrieves radar signals only for the active tenant/user scope', () => {
    upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'manual',
      sourceReferenceId: 'a',
      topic: 'Tenant A creator systems',
      confidence: 0.9,
    });
    upsertContentRadarSignal({
      userId: 601,
      tenantId: 202,
      sourceType: 'manual',
      sourceReferenceId: 'b',
      topic: 'Tenant B private launch idea',
      confidence: 0.9,
    });

    const tenantA = retrieveContentRadarSignals({ userId: 501, tenantId: 101 });

    expect(tenantA.map((signal) => signal.topic)).toEqual(['Tenant A creator systems']);
    expect(tenantA.map((signal) => signal.topic).join('\n')).not.toContain('Tenant B');
  });

  it('scores useful, fresh, on-brand opportunities above stale weak signals', () => {
    const strong = scoreContentOpportunity({
      topic: 'Creator systems for founder audience',
      contentPillars: ['creator systems'],
      audience: ['founder'],
      preferredFormats: ['youtube_long_form'],
      format: 'youtube_long_form',
      sourceQuality: 0.9,
      freshness: 0.9,
      confidence: 0.9,
      novelty: 0.88,
      strategicValue: 0.9,
    });
    const weak = scoreContentOpportunity({
      topic: 'Generic productivity tips',
      contentPillars: ['creator systems'],
      audience: ['founder'],
      sourceQuality: 0.35,
      freshness: 0.2,
      confidence: 0.4,
      novelty: 0.25,
      duplicationRisk: 0.8,
    });

    expect(strong.total).toBeGreaterThan(weak.total);
    expect(strong.reasonCodes).toEqual(expect.arrayContaining(['brand_aligned', 'audience_aligned']));
    expect(weak.reasonCodes).toEqual(expect.arrayContaining([
      'low_quality_source',
      'low_confidence_signal_requires_review',
      'stale_signal_downgraded',
      'high_duplicate_risk',
    ]));
    expect(weak.reviewRequired).toBe(true);
  });

  it('downgrades stale radar signals explicitly', () => {
    const score = scoreContentOpportunity({
      topic: 'Old creator launch angle',
      sourceQuality: 0.8,
      confidence: 0.8,
      freshness: 0.15,
    });

    expect(score.freshness).toBe(0.15);
    expect(score.reasonCodes).toContain('stale_signal_downgraded');
  });

  it('detects duplicate radar signals and reduces novelty instead of repeating stale ideas', () => {
    const first = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'link',
      sourceReferenceId: 'link-a',
      topic: 'Creator operating system',
      confidence: 0.9,
      novelty: 0.9,
    });
    const duplicate = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'link',
      sourceReferenceId: 'link-b',
      topic: 'Creator operating system',
      confidence: 0.9,
      novelty: 0.9,
    });

    expect(duplicate.duplicateSignalIds).toContain(first.signalId);
    expect(duplicate.score.duplicationRisk).toBeGreaterThanOrEqual(0.85);
    expect(duplicate.score.reasonCodes).toContain('high_duplicate_risk');
  });

  it('builds channel-derived signals with reference provenance and channel reason codes', () => {
    const signal = buildRadarSignalFromReference({
      userId: 501,
      tenantId: 101,
      reference: reference({
        id: 2,
        referenceId: 'ref-channel-1',
        referenceType: 'channel',
        sourceIdentifier: 'https://youtube.com/@operator-channel',
        title: 'Operator Channel',
        sourceSummary: 'A channel pattern about founder systems videos.',
      }),
      topic: 'Founder systems video pattern',
      platform: 'youtube',
      format: 'youtube_long_form',
    });

    expect(signal.sourceType).toBe('channel');
    expect(signal.sourceReferenceTitle).toBe('Operator Channel');
    expect(signal.score.reasonCodes).toContain('reference_channel_signal');
    expect(signal.provenance).toMatchObject({ referenceId: 'ref-channel-1', referenceType: 'channel' });
  });

  it('builds book-derived signals and rejects private references owned by another user', () => {
    const signal = buildRadarSignalFromReference({
      userId: 501,
      tenantId: 101,
      reference: reference(),
      topic: 'Capture and publish rhythm from Creator System',
      platform: 'linkedin',
      format: 'linkedin_post',
    });

    expect(signal.sourceType).toBe('book');
    expect(signal.score.reasonCodes).toContain('book_reference_signal');
    expect(signal.evidence).toEqual(['Creator systems need a capture, selection, and publishing rhythm.']);
    expect(() => buildRadarSignalFromReference({
      userId: 502,
      tenantId: 101,
      reference: reference({ ownerUserId: 501, visibilityScope: 'user_private' }),
      topic: 'Unauthorized private book signal',
    })).toThrow(/private to another user/);
  });

  it('creates cross-skill Training milestone opportunities', () => {
    const signal = buildCrossSkillContentOpportunitySignal({
      userId: 501,
      tenantId: 101,
      sourceSkill: 'training',
      sourceSignalType: 'milestone',
      topic: 'First 10K run breakthrough',
      summary: 'Training logged a first 10K milestone worth turning into a story.',
      evidence: [{ planId: 'plan_10k', sessionId: 'session_7' }],
    });

    expect(signal.sourceSkill).toBe('training');
    expect(signal.score.crossSkillRelevance).toBeGreaterThanOrEqual(0.85);
    expect(signal.score.reasonCodes).toEqual(expect.arrayContaining([
      'cross_skill_opportunity',
      'cross_skill_training_milestone',
    ]));
  });

  it('lets Secretary capacity reduce prioritization and explain why production is constrained', () => {
    upsertContentBrandProfile({
      userId: 501,
      tenantId: 101,
      contentPillars: ['creator systems'],
      audience: ['founders'],
      preferredFormats: ['youtube_long_form'],
    });
    upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'manual',
      sourceReferenceId: 'capacity-test',
      topic: 'Creator systems for founders',
      format: 'youtube_long_form',
      confidence: 0.9,
      sourceQuality: 0.9,
      productionFeasibility: 0.9,
      strategicValue: 0.9,
    });

    const normal = prioritizeContentRadarSignals({ userId: 501, tenantId: 101, secretaryCapacityScore: 0.9 })[0];
    const constrained = prioritizeContentRadarSignals({ userId: 501, tenantId: 101, secretaryCapacityScore: 0.2 })[0];

    expect(constrained.score.total).toBeLessThan(normal.score.total);
    expect(constrained.score.reasonCodes).toEqual(expect.arrayContaining([
      'low_production_feasibility',
      'secretary_capacity_low',
    ]));
  });

  it('marks low-confidence signals as review-required instead of surfacing them as ready opportunities', () => {
    const signal = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'link',
      sourceReferenceId: 'low-confidence',
      topic: 'Unverified creator claim',
      confidence: 0.38,
      sourceQuality: 0.42,
    });

    expect(signal.reviewRequired).toBe(true);
    expect(signal.lifecycleState).toBe('review_required');
    expect(signal.score.reasonCodes).toEqual(expect.arrayContaining([
      'low_confidence_signal_requires_review',
      'low_quality_source',
    ]));
  });

  it('converts radar signals into tenant-scoped workflow ideas with lineage metadata', () => {
    const signal = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'book',
      sourceReferenceId: 'book-to-idea',
      sourceReferenceTitle: 'Creator System',
      topic: 'Build a creator operating system',
      summary: 'Turn the source insight into a practical content idea.',
      confidence: 0.9,
      sourceQuality: 0.9,
      evidence: ['Source-backed creator system evidence.'],
      provenance: { referenceId: 'book-to-idea', referenceType: 'book' },
    });

    const result = convertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      signalId: signal.signalId,
      target: 'idea',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('converted');
    expect(result.signal?.lifecycleState).toBe('converted_to_idea');
    expect(result.signal?.convertedToObjectType).toBe('idea');
    expect(result.object).toMatchObject({
      tenantId: 101,
      ownerUserId: 501,
      objectType: 'idea',
      title: 'Build a creator operating system',
      editorialState: 'idea',
    });
    expect(result.object?.metadata).toMatchObject({
      generatedFromRadarSignalId: signal.signalId,
      radarSourceType: 'book',
      provenance: { referenceId: 'book-to-idea', referenceType: 'book' },
    });
  });
});
