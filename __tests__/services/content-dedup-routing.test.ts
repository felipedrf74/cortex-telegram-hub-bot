import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

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

import {
  ContentDedupUnavailableError,
  getAngleDistribution,
  isDuplicateIdea,
  isDuplicateIdeaInBatch,
} from '../../src/services/content-dedup';
import { captureDiscoveredIdea } from '../../src/services/content-workspace-capture';
import { saveContentRevision } from '../../src/services/content-workspace';
import { logger } from '../../src/utils/logger';

function seedIdea(
  userId: number,
  title: string,
  angleTag: string | null = null,
  tenantId = userId,
) {
  return captureDiscoveredIdea({
    scope: { tenantId, userId },
    title,
    sourceDate: '2026-07-17',
    score: 0.7,
    workflowEligible: true,
    angleTag,
    provider: 'test',
  }, testDb);
}

function seedFeedback(userId: number, topic: string, angleTag: string | null = null, tenantId = userId): void {
  testDb.prepare(`
    INSERT INTO content_topic_feedback (
      topic, format, angle_tag, user_id, tenant_id, owner_user_id,
      visibility_scope, lifecycle_state, scope_status,
      created_by, updated_by, audit_metadata_json, created_at
    ) VALUES (?, 'reel', ?, ?, ?, ?, 'user_private', 'active', 'active', ?, ?, '{}', datetime('now'))
  `).run(topic, angleTag, userId, tenantId, userId, userId, userId);
}

describe('content dedup deterministic classifier', () => {
  beforeEach(() => {
    vi.stubEnv('CONTENT_WORKSPACE_V1_MODE', 'write');
    testDb = createMigratedTestDatabase();
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    if (testDb?.open) testDb.close();
    vi.unstubAllEnvs();
  });

  it('flags a byte-identical title as duplicate with confidence 0.95', async () => {
    seedIdea(42, 'Race week recap');
    seedIdea(42, 'Fueling mistakes before long runs');
    seedIdea(42, 'Creator workflow for endurance athletes');

    const result = await isDuplicateIdea('Race week recap', undefined, 42, 42);

    expect(result).toEqual({ isDuplicate: true, similarTo: 'Race week recap', confidence: 0.95 });
  });

  it('detects an unpersisted duplicate already accepted in the same batch', () => {
    const result = isDuplicateIdeaInBatch('Race week recap!', 'opinion', [
      { title: 'Race week recap', angleTag: 'opinion' },
    ]);

    expect(result).toEqual({ isDuplicate: true, similarTo: 'Race week recap', confidence: 0.95 });
  });

  it('can forbid the same topic across weekly formats even when angles differ', () => {
    const result = isDuplicateIdeaInBatch('Race week recap', 'reaction', [
      { title: 'Race week recap', angleTag: 'opinion' },
    ], { allowDifferentAngles: false });

    expect(result).toEqual({ isDuplicate: true, similarTo: 'Race week recap', confidence: 0.95 });
  });

  it('flags a normalized exact match (case, accents, punctuation) as duplicate 0.95', async () => {
    seedIdea(42, 'Treino de força: guia completo!');
    seedIdea(42, 'Fueling mistakes before long runs');
    seedIdea(42, 'Creator workflow for endurance athletes');

    const result = await isDuplicateIdea('treino de forca — guia completo', undefined, 42, 42);

    expect(result).toEqual({ isDuplicate: true, similarTo: 'Treino de força: guia completo!', confidence: 0.95 });
  });

  it('flags a high-token-overlap paraphrase as duplicate 0.85', async () => {
    seedIdea(42, '5 erros comuns no treino de força');
    seedIdea(42, 'Fueling mistakes before long runs');
    seedIdea(42, 'Creator workflow for endurance athletes');

    const result = await isDuplicateIdea('os 5 erros comuns no treino de força', undefined, 42, 42);

    expect(result).toEqual({ isDuplicate: true, similarTo: '5 erros comuns no treino de força', confidence: 0.85 });
  });

  it('does NOT flag same topic when both angle tags exist and differ', async () => {
    seedIdea(42, '5 erros comuns no treino de força', 'opinion');
    seedIdea(42, 'Fueling mistakes before long runs');
    seedIdea(42, 'Creator workflow for endurance athletes');

    const differentAngle = await isDuplicateIdea('5 erros comuns no treino de força', 'reaction', 42, 42);
    expect(differentAngle).toEqual({ isDuplicate: false, similarTo: null, confidence: 0 });

    // Control: the same angle (and no angle at all) still dedupes.
    const sameAngle = await isDuplicateIdea('5 erros comuns no treino de força', 'opinion', 42, 42);
    expect(sameAngle.isDuplicate).toBe(true);
    const noAngle = await isDuplicateIdea('5 erros comuns no treino de força', undefined, 42, 42);
    expect(noAngle.isDuplicate).toBe(true);
  });

  it('does not flag unrelated titles', async () => {
    seedIdea(42, 'Race week recap');
    seedIdea(42, 'Fueling mistakes before long runs');
    seedIdea(42, 'Creator workflow for endurance athletes');

    const result = await isDuplicateIdea('Por que o estado é seu inimigo', 'opinion', 42, 42);

    expect(result).toEqual({ isDuplicate: false, similarTo: null, confidence: 0 });
  });

  it('skips dedup when fewer than 3 recent ideas exist', async () => {
    seedIdea(42, 'Race week recap');
    seedIdea(42, 'Fueling mistakes before long runs');

    const result = await isDuplicateIdea('Race week recap', undefined, 42, 42);

    expect(result).toEqual({ isDuplicate: false, similarTo: null, confidence: 0 });
  });

  it('counts content_topic_feedback rows toward the recent pool and matches against them', async () => {
    seedIdea(42, 'Fueling mistakes before long runs');
    seedIdea(42, 'Creator workflow for endurance athletes');
    seedFeedback(42, 'Race week recap');

    const result = await isDuplicateIdea('Race week recap', undefined, 42, 42);

    expect(result).toEqual({ isDuplicate: true, similarTo: 'Race week recap', confidence: 0.95 });
  });

  it('compares only the current canonical idea revision, never a superseded title', async () => {
    const revised = seedIdea(42, 'Superseded launch title', 'framework');
    seedIdea(42, 'Second canonical idea');
    seedIdea(42, 'Third canonical idea');
    saveContentRevision({
      scope: { tenantId: 42, userId: 42 },
      artifactId: revised.artifact.id,
      baseRevision: 1,
      content: { format: 'plain_text', text: 'Current launch title' },
      changeSummary: 'User refined the idea title',
      actorType: 'user',
      idempotencyKey: 'dedup-current-revision-001',
    }, testDb);

    await expect(isDuplicateIdea('Superseded launch title', undefined, 42, 42))
      .resolves.toEqual({ isDuplicate: false, similarTo: null, confidence: 0 });
    await expect(isDuplicateIdea('Current launch title', undefined, 42, 42))
      .resolves.toEqual({ isDuplicate: true, similarTo: 'Current launch title', confidence: 0.95 });
  });

  it('combines canonical current idea angles with candidate inventory without crossing tenants', () => {
    seedIdea(42, 'Canonical opinion idea', 'opinion');
    seedFeedback(42, 'Feedback opinion idea', 'opinion');
    seedIdea(77, 'Other tenant framework idea', 'framework');
    seedFeedback(77, 'Other tenant framework feedback', 'framework');

    const distribution = getAngleDistribution(42, 42);

    expect(distribution.find((entry) => entry.tag === 'opinion')).toMatchObject({ count: 2, pct: 100 });
    expect(distribution.find((entry) => entry.tag === 'framework')).toMatchObject({ count: 0, pct: 0 });
  });

  it('scopes recent ideas per user', async () => {
    seedIdea(42, 'Shared candidate');
    seedIdea(42, 'Fueling mistakes before long runs');
    seedIdea(42, 'Creator workflow for endurance athletes');
    seedIdea(77, 'Private tenant B launch plan');
    seedIdea(77, 'User B topic two');
    seedIdea(77, 'User B topic three');

    const asOwner = await isDuplicateIdea('Shared candidate', undefined, 42, 42);
    const asOtherUser = await isDuplicateIdea('Shared candidate', undefined, 77, 77);

    expect(asOwner.isDuplicate).toBe(true);
    expect(asOtherUser).toEqual({ isDuplicate: false, similarTo: null, confidence: 0 });
  });

  it('fails closed with a typed retryable error when the DB fetch throws', async () => {
    testDb.close();

    await expect(isDuplicateIdea('Anything at all', undefined, 42, 42))
      .rejects.toBeInstanceOf(ContentDedupUnavailableError);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        tenantId: 42,
        errorName: 'TypeError',
        errorFingerprint: expect.any(String),
      }),
      'Content dedup comparison set unavailable',
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // QA regression pin (skill-hardening 2026-05-18 follow-up, P3-3):
  // The previous QA found there was no direct lock on the tenant-scope
  // contract for `isDuplicateIdea` — only positive-path coverage. These
  // tests pin the throw paths so a future regression that loosens
  // `resolveRequiredContentDedupScope` (e.g., adds back a userId fallback)
  // surfaces immediately. Scope and canonical-read errors must both throw.
  // ─────────────────────────────────────────────────────────────────────

  it('throws when userId is provided but tenantId is missing', async () => {
    await expect(isDuplicateIdea('Shared title', 'opinion', 42, undefined as any))
      .rejects.toMatchObject({
        name: 'TenantScopeError',
      });
  });

  it('throws when userId is provided but tenantId is 0', async () => {
    await expect(isDuplicateIdea('Shared title', 'opinion', 42, 0 as any))
      .rejects.toMatchObject({
        name: 'TenantScopeError',
      });
  });

  it('throws when userId is provided but tenantId is negative', async () => {
    await expect(isDuplicateIdea('Shared title', 'opinion', 42, -1 as any))
      .rejects.toMatchObject({
        name: 'TenantScopeError',
      });
  });

  it('throws when userId is 0 (invalid) even with valid tenantId', async () => {
    // Note: the userId branch in `resolveRequiredContentDedupScope` throws a
    // plain Error (not a TenantScopeError) because it predates the helper.
    // Pinning the message so a future refactor doesn't silently weaken the
    // check.
    await expect(isDuplicateIdea('Shared title', 'opinion', 0 as any, 42 as any))
      .rejects.toThrow(/Content dedup requires authenticated user scope/);
  });
});
