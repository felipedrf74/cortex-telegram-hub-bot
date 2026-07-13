import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
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
  convertContentRadarSignal,
  prioritizeContentRadarSignals,
  retrieveContentRadarSignals,
  scoreContentOpportunity,
  upsertContentRadarSignal,
} from '../../src/services/content-radar-engine';
import { upsertContentBrandProfile } from '../../src/services/content-memory-profile';
import { recordRadarFeedback } from '../../src/state/content-radar-feedback';

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

  it('keeps related radar signals separate from duplicate signal ids', () => {
    const first = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'manual',
      sourceReferenceId: 'related-a',
      topic: 'Creator operating system',
      confidence: 0.9,
      novelty: 0.9,
    });
    const related = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'manual',
      sourceReferenceId: 'related-b',
      topic: 'Creator capture workflow',
      confidence: 0.9,
      novelty: 0.9,
    });
    const duplicate = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'manual',
      sourceReferenceId: 'related-c',
      topic: 'Creator capture workflow',
      confidence: 0.9,
      novelty: 0.9,
    });

    expect(related.relatedSignalIds).toContain(first.signalId);
    expect(related.duplicateSignalIds).not.toContain(first.signalId);
    expect(duplicate.duplicateSignalIds).toContain(related.signalId);
    expect(duplicate.relatedSignalIds).not.toContain(related.signalId);
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

  it('keeps the explicit raw retrieval path free of radar feedback adjustments', () => {
    const strong = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'manual',
      sourceReferenceId: 'feedback-strong',
      topic: 'Creator systems flagship video',
      confidence: 0.95,
      freshness: 0.95,
      novelty: 0.95,
      sourceQuality: 0.95,
      productionFeasibility: 0.95,
      strategicValue: 0.95,
    });
    const softer = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'manual',
      sourceReferenceId: 'feedback-softer',
      topic: 'Creator systems checklist post',
      confidence: 0.8,
      freshness: 0.8,
      novelty: 0.8,
      sourceQuality: 0.8,
      productionFeasibility: 0.8,
      strategicValue: 0.8,
    });

    recordRadarFeedback(501, 101, {
      signalId: strong.signalId,
      action: 'reject',
      signalTopic: strong.topic,
    });
    recordRadarFeedback(501, 101, {
      signalId: softer.signalId,
      action: 'accept',
      signalTopic: softer.topic,
    });

    const raw = retrieveContentRadarSignals({ userId: 501, tenantId: 101, limit: 2, prioritized: false });
    const prioritized = prioritizeContentRadarSignals({ userId: 501, tenantId: 101, limit: 2 });

    expect(raw[0].signalId).toBe(strong.signalId);
    expect(raw[0].score.reasonCodes).not.toContain('radar_feedback_rejected');
    expect(prioritized[0].signalId).toBe(softer.signalId);
    expect(prioritized[0].score.reasonCodes).toContain('radar_feedback_accepted');
    expect(prioritized.find((signal) => signal.signalId === strong.signalId)?.score.reasonCodes)
      .toContain('radar_feedback_rejected');
  });

  it('uses feedback-aware prioritization on the live retrieval path by default', () => {
    const strong = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'manual',
      sourceReferenceId: 'live-feedback-strong',
      topic: 'Creator systems flagship live video',
      confidence: 0.95,
      freshness: 0.95,
      novelty: 0.95,
      sourceQuality: 0.95,
      productionFeasibility: 0.95,
      strategicValue: 0.95,
    });
    const weaker = upsertContentRadarSignal({
      userId: 501,
      tenantId: 101,
      sourceType: 'manual',
      sourceReferenceId: 'live-feedback-weaker',
      topic: 'Creator systems saved checklist',
      confidence: 0.78,
      freshness: 0.78,
      novelty: 0.78,
      sourceQuality: 0.78,
      productionFeasibility: 0.78,
      strategicValue: 0.78,
    });

    recordRadarFeedback(501, 101, {
      signalId: strong.signalId,
      action: 'reject',
      signalTopic: strong.topic,
    });
    recordRadarFeedback(501, 101, {
      signalId: weaker.signalId,
      action: 'accept',
      signalTopic: weaker.topic,
    });

    const live = retrieveContentRadarSignals({ userId: 501, tenantId: 101, limit: 2 });

    expect(live[0].signalId).toBe(weaker.signalId);
    expect(live[0].score.reasonCodes).toContain('radar_feedback_accepted');
    expect(live.find((signal) => signal.signalId === strong.signalId)?.score.reasonCodes)
      .toContain('radar_feedback_rejected');
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
