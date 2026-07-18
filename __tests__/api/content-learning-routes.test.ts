import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'express';
import Database from 'better-sqlite3';
import type { Request, Response } from 'express';

let testDb: Database.Database;

const mocks = vi.hoisted(() => ({
  generateAndStoreTopicCandidates: vi.fn(),
  generateWeeklyPackage: vi.fn(),
  updateFeedback: vi.fn(),
  recordContentPerformanceOutcome: vi.fn(),
  getPerformanceSummary: vi.fn(),
  getLearnedPatterns: vi.fn(),
  getArtifactChain: vi.fn(),
  getRecentScripts: vi.fn(),
  invalidateContentDerivedCaches: vi.fn(),
  saveGeneratedScriptToWorkspace: vi.fn(() => ({
    schemaVersion: 'content-workspace-capture-v1',
    workspaceSchemaVersion: 'content-workspace-v1',
    item: { id: 701, workflowVersion: 2 },
    artifact: { id: 702 },
    revisionId: 703,
    replayed: false,
  })),
}));

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

vi.mock('../../src/services/content-workflow', () => ({
  generateAndStoreTopicCandidates: mocks.generateAndStoreTopicCandidates,
  generateWeeklyPackage: mocks.generateWeeklyPackage,
  updateFeedback: mocks.updateFeedback,
}));

vi.mock('../../src/services/content-learning-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/content-learning-store')>();
  return {
    ...actual,
    getPerformanceSummary: mocks.getPerformanceSummary,
    getLearnedPatterns: mocks.getLearnedPatterns,
    getArtifactChain: mocks.getArtifactChain,
    getRecentScripts: mocks.getRecentScripts,
  };
});

vi.mock('../../src/services/content-performance-lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/content-performance-lineage')>();
  return {
    ...actual,
    recordContentPerformanceOutcome: mocks.recordContentPerformanceOutcome,
  };
});

vi.mock('../../src/services/cache-coherence-registry', () => ({
  ...{
    CacheCoherenceEvents: {},
    _resetDashboardCacheInvalidationStatsForTests: vi.fn(),
    getDashboardCacheInvalidationStats: vi.fn(),
    invalidateCacheForEvent: vi.fn(),
    invalidateCalendarCaches: vi.fn(),
    invalidateContentDerivedCaches: vi.fn(),
    invalidateCookingDerivedCaches: vi.fn(),
    invalidateDashboardCaches: vi.fn(),
    invalidateDashboardCoordinationCaches: vi.fn(),
    invalidateDashboardHomeCaches: vi.fn(),
    invalidateDashboardReadinessCaches: vi.fn(),
    invalidateDashboardRootCaches: vi.fn(),
    invalidateExecutiveBriefCaches: vi.fn(),
    invalidateFinanceDerivedCaches: vi.fn(),
    invalidateIntegrationDerivedCaches: vi.fn(),
    invalidateOnboardingDerivedCaches: vi.fn(),
    invalidatePlanningCaches: vi.fn(),
    invalidateTaskCaches: vi.fn(),
    invalidateTrainingDerivedCaches: vi.fn(),
  },
  invalidateContentDerivedCaches: mocks.invalidateContentDerivedCaches,
}));

vi.mock('../../src/services/content-workspace-capture', () => ({
  saveGeneratedScriptToWorkspace: mocks.saveGeneratedScriptToWorkspace,
}));

import { registerContentLearningRoutes } from '../../src/api/routes/content-learning-routes';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
  };
  return response;
}

function mockReq(
  method: string,
  path: string,
  userId: number | undefined = 41,
  body: Record<string, unknown> = {},
  query: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  return {
    userId,
    // 2026-05-18 (skill-hardening QA P1 follow-up): mirror iosAuthMiddleware
    // setting tenantId alongside userId. Routes no longer have the
    // `tenantId = userId` destructuring default.
    tenantId: userId,
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query,
    params: {},
    body,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
  } as any;
}

function makeEnsureValidScope() {
  return vi.fn((
    res: Response,
    userId: number | undefined,
  ): userId is number => {
    if (typeof userId === 'number' && userId > 0) return true;
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid authenticated user scope' } });
    return false;
  });
}

async function dispatch(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  userId: number | undefined = 41,
  query: Record<string, unknown> = {},
  ensureValidScope = makeEnsureValidScope(),
): Promise<{ response: MockRes; ensureValidScope: ReturnType<typeof makeEnsureValidScope> }> {
  const router = Router();
  registerContentLearningRoutes(router, () => 'pt-BR', ensureValidScope);
  const req = mockReq(method, path, userId, body, query);
  const res = mockRes();

  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
    setImmediate(resolve);
  });
  for (let attempt = 0; attempt < 100 && res.body == null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  return { response: res, ensureValidScope };
}

function seedTopicFeedback(userId: number, topic: string, sentiment = 'pending'): number {
  const result = testDb.prepare(`
    INSERT INTO content_topic_feedback
      (topic, niche, format, sentiment, source_job, hook_idea, why_now, angle_tag, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    topic,
    'ai-tech',
    'reel',
    sentiment,
    'manual',
    'Open with tension',
    'Strong signal today',
    'timely',
    userId,
    '2026-04-23T10:00:00.000Z',
  );
  return Number(result.lastInsertRowid);
}

function seedPipeline(userId: number): number {
  const result = testDb.prepare(`
    INSERT INTO content_pipeline (topic_title, stage, user_id)
    VALUES (?, ?, ?)
  `).run('Pipeline topic', 'scripted', userId);
  return Number(result.lastInsertRowid);
}

describe('content learning routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE content_topic_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        niche TEXT,
        format TEXT,
        sentiment TEXT,
        source_job TEXT,
        hook_idea TEXT,
        why_now TEXT,
        angle_tag TEXT,
        user_id INTEGER NOT NULL,
        created_at TEXT
      );
      CREATE TABLE content_pipeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_title TEXT NOT NULL,
        stage TEXT,
        user_id INTEGER NOT NULL
      );
      CREATE TABLE content_scripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id INTEGER,
        topic_feedback_id INTEGER,
        topic TEXT NOT NULL,
        format TEXT NOT NULL,
        script_text TEXT NOT NULL,
        hook TEXT,
        title_options TEXT,
        sources_used TEXT,
        hashtags TEXT,
        caption TEXT,
        cta TEXT,
        estimated_duration TEXT,
        niche TEXT,
        generation_duration_ms INTEGER,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER,
        owner_user_id INTEGER,
        visibility_scope TEXT,
        lifecycle_state TEXT,
        scope_status TEXT,
        created_by TEXT,
        updated_by TEXT,
        audit_metadata_json TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('localizes topic generation validation without loading the workflow engine', async () => {
    const { response } = await dispatch('POST', '/topics/generate', { format: 'podcast' });

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(response.body.error.message).toBe('o formato deve ser "reel" ou "youtube"');
    expect(mocks.generateAndStoreTopicCandidates).not.toHaveBeenCalled();
  });

  it('generates topic candidates through the content workflow service', async () => {
    mocks.generateAndStoreTopicCandidates.mockResolvedValueOnce({
      format: 'youtube',
      sourceJob: 'manual',
      dayLabel: 'Sexta-feira',
      candidates: [
        {
          feedbackId: 12,
          title: 'Build in public without chaos',
          niche: 'ai-tech',
          whyNow: 'Strong founder signal',
          hookIdea: 'Start with the hidden cost',
          angleTag: 'operator',
        },
      ],
    });

    const { response } = await dispatch('POST', '/topics/generate', {
      format: 'youtube',
      sourceJob: 'manual',
    }, 77);

    expect(response.statusCode).toBe(200);
    expect(mocks.generateAndStoreTopicCandidates).toHaveBeenCalledWith(77, 'youtube', 'manual', 77);
    expect(mocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(77);
    expect(response.body.data).toEqual(expect.objectContaining({
      format: 'youtube',
      sourceJob: 'manual',
      count: 1,
      candidates: [
        expect.objectContaining({
          feedbackId: 12,
          title: 'Build in public without chaos',
        }),
      ],
    }));
  });

  it('forbids feedback updates for another user topic', async () => {
    const id = seedTopicFeedback(99, 'Other user topic');

    const { response } = await dispatch('POST', `/topics/${id}/feedback`, { sentiment: 'approved' }, 41);

    expect(response.statusCode).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(mocks.updateFeedback).not.toHaveBeenCalled();
  });

  it('updates owned topic feedback', async () => {
    const id = seedTopicFeedback(41, 'Owned topic');

    const { response } = await dispatch('POST', `/topics/${id}/feedback`, { sentiment: 'approved' }, 41);

    expect(response.statusCode).toBe(200);
    expect(mocks.updateFeedback).toHaveBeenCalledWith(id, 'approved', 41, 41);
    expect(mocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(41);
    expect(response.body.data).toEqual({
      feedbackId: id,
      sentiment: 'approved',
      title: 'Owned topic',
    });
  });

  it('records generated variant feedback through direct REST learning path', async () => {
    const { response } = await dispatch('POST', '/variant-feedback', {
      topic: 'AI scripting workflow',
      variantKind: 'hook',
      variantText: 'Most creators waste tokens before they write.',
      sentiment: 'approved',
      angle: 'cost control',
      format: 'YouTube',
    }, 77);

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      topic: 'AI scripting workflow',
      variantKind: 'hook',
      sentiment: 'approved',
      accepted: true,
    }));

    const row = testDb.prepare(`
      SELECT topic, hook, variant_kind, feedback_sentiment, accepted
      FROM content_idea_memory
      WHERE user_id = ? AND tenant_id = ?
    `).get(77, 77) as any;
    expect(row).toEqual(expect.objectContaining({
      topic: 'AI scripting workflow',
      hook: 'Most creators waste tokens before they write.',
      variant_kind: 'hook',
      feedback_sentiment: 'approved',
      accepted: 1,
    }));
  });

  it('persists approved script variant feedback as a canonical workspace artifact', async () => {
    const scriptText = Array.from({ length: 40 }, (_, index) => {
      return `[${index}:00] Paragraph ${index} keeps the generated script body intact.`;
    }).join('\n');

    const { response } = await dispatch('POST', '/variant-feedback', {
      topic: 'AI scripting workflow',
      variantKind: 'script',
      variantText: scriptText,
      sentiment: 'approved',
      format: 'YouTube',
    }, 77);

    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      topic: 'AI scripting workflow',
      variantKind: 'script',
      sentiment: 'approved',
      accepted: true,
      variantTextChars: scriptText.length,
      workspace: {
        schemaVersion: 'content-workspace-capture-v1',
        itemId: 701,
        artifactId: 702,
        revisionId: 703,
        workflowVersion: 2,
        replayed: false,
      },
    }));
    expect(mocks.saveGeneratedScriptToWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: 77, userId: 77 },
      topic: 'AI scripting workflow',
      format: 'YouTube',
      scriptText,
      captureOrigin: 'approved_variant',
    }), testDb);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM content_scripts').get())
      .toEqual({ count: 0 });

    const memoryRow = testDb.prepare(`
      SELECT topic, hook, variant_kind, feedback_sentiment, accepted
      FROM content_idea_memory
      WHERE user_id = ? AND tenant_id = ?
    `).get(77, 77) as any;
    expect(memoryRow).toEqual(expect.objectContaining({
      topic: 'AI scripting workflow',
      hook: expect.stringContaining('[0:00] Paragraph 0'),
      variant_kind: 'script',
      feedback_sentiment: 'approved',
      accepted: 1,
    }));
  });

  it('validates generated variant feedback before writing memory', async () => {
    const { response } = await dispatch('POST', '/variant-feedback', {
      topic: 'AI scripting workflow',
      variantKind: 'unknown',
      variantText: 'A weak title',
      sentiment: 'approved',
    }, 77);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(mocks.invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // QA regression pins (phase2-qa P1 #5 / Agent B section H gap):
  // The original Phase 2 suite missed three negative cases that protect
  // tenant isolation on /variant-feedback. Pin them so a future regression
  // that loosens regex or scope is caught by tests.
  // ─────────────────────────────────────────────────────────────────────

  it('rejects malformed sourcePackageId at the regex stage with 400 (no SQL probe)', async () => {
    const { response } = await dispatch('POST', '/variant-feedback', {
      topic: 'AI scripting workflow',
      variantKind: 'hook',
      variantText: 'A neutral hook.',
      sentiment: 'approved',
      sourcePackageId: "sp_abc'; DROP TABLE users--",
    }, 77);

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION');
    expect(mocks.invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('rejects a sourcePackageId not owned by the caller with 404 (no existence disclosure)', async () => {
    // A well-formed sourcePackageId that does not exist in this tenant's
    // scope must 404, not 200. The same response covers both "doesn't
    // exist at all" and "owned by another tenant" — that ambiguity is
    // intentional to prevent existence disclosure across tenants.
    const otherTenantPackageId = 'sp_0000000000000000_aaaaaaaaaaaaaaaa';

    const { response } = await dispatch('POST', '/variant-feedback', {
      topic: 'AI scripting workflow',
      variantKind: 'hook',
      variantText: 'Neutral content.',
      sentiment: 'approved',
      sourcePackageId: otherTenantPackageId,
    }, 77);

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(mocks.invalidateContentDerivedCaches).not.toHaveBeenCalled();
  });

  it('rejects body-supplied userId/tenantId attempting to override authenticated scope', async () => {
    // Caller authenticates as 77; tries to pass body identity 999.
    // Backend must ignore body identity entirely and either honor auth (77)
    // or reject. Either way, no row should be written for user_id=999.
    const { response } = await dispatch('POST', '/variant-feedback', {
      topic: 'Identity override test',
      variantKind: 'hook',
      variantText: 'Should not write as user 999',
      sentiment: 'approved',
      userId: 999,
      tenantId: 999,
    }, 77);

    expect(response.statusCode).toBe(200);
    const stolenRow = testDb.prepare(`
      SELECT COUNT(*) as n FROM content_idea_memory
      WHERE user_id = 999 OR tenant_id = 999
    `).get() as { n: number };
    expect(stolenRow.n).toBe(0);
  });

  it('returns pending topics scoped to the authenticated user', async () => {
    seedTopicFeedback(41, 'My pending topic');
    seedTopicFeedback(99, 'Other pending topic');

    const { response } = await dispatch('GET', '/topics/pending', {}, 41);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.count).toBe(1);
    expect(response.body.data.topics).toEqual([
      expect.objectContaining({
        title: 'My pending topic',
        format: 'reel',
      }),
    ]);
  });

  it('requires canonical revision identifiers, metrics, and idempotency when logging performance feedback', async () => {
    const { response } = await dispatch('POST', '/performance', { views: 1200 });

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('CONTENT_PERFORMANCE_VALIDATION_FAILED');
    expect(mocks.recordContentPerformanceOutcome).not.toHaveBeenCalled();
  });

  it('logs revision-linked performance feedback with authenticated user ownership', async () => {
    mocks.recordContentPerformanceOutcome.mockReturnValueOnce({
      value: {
        id: 55,
        workspaceItemId: 8,
        artifactId: 12,
        revisionId: 13,
        association: 'canonical_revision',
        linkOrigin: 'canonical_api',
        pipelineId: null,
      },
      replayed: false,
      created: true,
    });

    const { response } = await dispatch('POST', '/performance', {
      itemId: 8,
      artifactId: 12,
      revisionId: 13,
      idempotencyKey: 'performance-api-001',
      views: 1200,
      retentionPct: 43.5,
      likes: 100,
    }, 77);

    expect(response.statusCode).toBe(201);
    expect(mocks.recordContentPerformanceOutcome).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: 77, userId: 77 },
      itemId: 8,
      artifactId: 12,
      revisionId: 13,
      views: 1200,
      retentionPct: 43.5,
      likes: 100,
    }));
    expect(mocks.invalidateContentDerivedCaches).toHaveBeenCalledWith(77);
    expect(response.body.data).toEqual(expect.objectContaining({
      schemaVersion: 'content-performance-lineage-v1',
      outcome: expect.objectContaining({ id: 55, revisionId: 13, pipelineId: null }),
      mutation: { replayed: false, created: true },
      evidenceStatus: 'user_reported',
      publicationExecution: 'not_performed',
    }));
  });

  it('rejects legacy pipeline aliases instead of guessing a workspace revision', async () => {
    const { response } = await dispatch('POST', '/performance', {
      pipelineId: 8,
      views: 1200,
      retentionPct: 43.5,
    }, 77);

    expect(response.statusCode).toBe(409);
    expect(response.body.error.code).toBe('CONTENT_LEGACY_PIPELINE_ALIAS_READ_ONLY');
    expect(mocks.recordContentPerformanceOutcome).not.toHaveBeenCalled();
  });

  it('makes foreign and missing artifact-chain identifiers indistinguishable', async () => {
    const pipelineId = seedPipeline(99);
    mocks.getArtifactChain.mockReturnValueOnce({ availability: 'not_found' });

    const { response } = await dispatch('GET', `/artifact-chain/${pipelineId}`, {}, 41);

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(mocks.getArtifactChain).toHaveBeenCalledWith(pipelineId, 41, 41);
  });

  it('returns artifact-chain for an owned pipeline', async () => {
    const pipelineId = seedPipeline(41);
    mocks.getArtifactChain.mockReturnValueOnce({
      availability: 'available',
      idea: null,
      topicFeedback: null,
      pipeline: { id: pipelineId },
      script: null,
      performance: [],
      patterns: [],
    });

    const { response } = await dispatch('GET', `/artifact-chain/${pipelineId}`, {}, 41);

    expect(response.statusCode).toBe(200);
    expect(mocks.getArtifactChain).toHaveBeenCalledWith(pipelineId, 41, 41);
    expect(response.body.data.pipeline).toEqual({ id: pipelineId });
  });

  it('returns recent scripts using bounded query defaults', async () => {
    mocks.getRecentScripts.mockReturnValueOnce([
      {
        id: 9,
        topic: 'Operator systems',
        format: 'reel',
        hook: 'Stop building random tools',
        titleOptions: ['A'],
        estimatedDuration: '00:45',
        niche: 'ai-tech',
        createdAt: '2026-04-23T10:00:00.000Z',
        scriptText: 'x'.repeat(320),
      },
    ]);

    const { response } = await dispatch('GET', '/scripts/recent', {}, 77);

    expect(response.statusCode).toBe(200);
    expect(mocks.getRecentScripts).toHaveBeenCalledWith(77, 30, 10, 77);
    expect(response.body.data).toEqual({
      count: 1,
      scripts: [
        expect.objectContaining({
          id: 9,
          topic: 'Operator systems',
          preview: 'x'.repeat(300),
        }),
      ],
    });
  });

  it('refuses learning routes without a valid authenticated user scope', async () => {
    const { response, ensureValidScope } = await dispatch('GET', '/scripts/recent', {}, 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(mocks.getRecentScripts).not.toHaveBeenCalled();
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 0, 'content_route_learning');
  });
});
