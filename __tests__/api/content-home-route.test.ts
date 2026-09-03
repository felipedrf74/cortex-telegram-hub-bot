import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockRunContentDiscovery = vi.hoisted(() => vi.fn(async (_options: {
  userId: number;
  tenantId: number;
  abortSignal?: AbortSignal;
}) => ({
  ideas: ['Creator operating system'],
  provider: 'gemini',
  fullContent: '# Content Ideas',
  filePath: null,
  storage: 'content_workspace',
  searchCount: 1,
})));

const mockCaptureDiscoveredIdea = vi.hoisted(() => vi.fn(() => ({ replayed: false })));
const mockIsDuplicateIdea = vi.hoisted(() => vi.fn(async () => ({ isDuplicate: false, confidence: 0 })));
const mockIsDuplicateIdeaInBatch = vi.hoisted(() => vi.fn(() => ({ isDuplicate: false, confidence: 0 })));
const mockGetContentRadarPreferences = vi.hoisted(() => vi.fn(() => ({ topics: [], updatedAt: null })));
const mockGetCachedSWR = vi.hoisted(() => vi.fn(() => null));
const mockSetCacheSWR = vi.hoisted(() => vi.fn());
const mockGetContentWorkspaceSummaryCounts = vi.hoisted(() => vi.fn());
const mockGetUserTimezoneById = vi.hoisted(() => vi.fn(() => 'Europe/Lisbon'));
const mockReadSignals = vi.hoisted(() => vi.fn((..._args: unknown[]): any[] => []));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: content route uses the strict by-id helper.
  getUserLanguage: vi.fn(() => 'pt-BR'),
  getUserLanguageById: vi.fn(() => 'pt-BR'),
  getUserTimezoneById: (...args: unknown[]) => mockGetUserTimezoneById(...args),
}));

vi.mock('../../src/services/content-workspace-read-models', () => ({
  getContentWorkspaceSummaryCounts: (...args: unknown[]) => mockGetContentWorkspaceSummaryCounts(...args),
}));

vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => false),
}));

vi.mock('../../src/services/tenant-scope-observability', () => ({
  isValidTenantUserId: vi.fn(() => true),
  recordTenantScopeAnomaly: vi.fn(),
}));

vi.mock('../../src/services/content-discovery', () => ({
  runContentDiscovery: mockRunContentDiscovery,
}));

vi.mock('../../src/services/content-workspace-capture', () => ({
  captureDiscoveredIdea: (...args: unknown[]) => mockCaptureDiscoveredIdea(...args),
}));

vi.mock('../../src/services/content-dedup', () => ({
  isDuplicateIdea: (...args: unknown[]) => mockIsDuplicateIdea(...args),
  isDuplicateIdeaInBatch: (...args: unknown[]) => mockIsDuplicateIdeaInBatch(...args),
}));

vi.mock('../../src/portal/telemetry', () => ({
  getJobStatuses: vi.fn(() => []),
}));

vi.mock('../../src/services/content-scheduler', () => ({
  getTopics: vi.fn(() => [
    { status: 'ready', scheduled_date: '2026-04-24' },
  ]),
  getFilmingRecommendation: vi.fn(async () => ({
    date: '2026-04-24',
    confidence: 'high',
    reason: 'Só há treino leve planeado, por isso deve ser mais fácil filmar bem.',
    reasons: [],
    readinessScore: 78,
    trainingLoad: 'light',
    calendarLoad: 'light',
  })),
  getUpcomingTopicCount: vi.fn(() => 1),
  addTopic: vi.fn(),
  updateTopic: vi.fn(),
  deleteTopic: vi.fn(),
  CONTENT_TOPIC_STATUSES: ['planned', 'drafting', 'ready', 'published', 'cancelled'],
}));

vi.mock('../../src/services/content-intelligence', () => ({
  getActiveContentPillars: vi.fn(() => []),
  getContentDeskItems: vi.fn(() => [
    {
      id: 1,
      type: 'topic_candidates_ready',
      title: 'Vibe coding para produto solo',
      body: 'Tema com força para virar roteiro.',
      createdAt: '2026-04-18T10:00:00Z',
    },
  ]),
  localizeFilmingRecommendation: vi.fn((recommendation: any) => recommendation),
}));

vi.mock('../../src/services/content-radar-preferences', () => ({
  getContentRadarPreferences: (...args: unknown[]) => mockGetContentRadarPreferences(...args),
  setContentRadarPreferences: vi.fn(),
  filterSignalsForRadarPreferences: vi.fn((signals: any[]) => signals),
  buildRadarTopicSummaries: vi.fn(() => []),
}));

vi.mock('../../src/services/content-dashboard-service', () => ({
  getVoiceDna: vi.fn(() => [
    { category: 'brand_voice', updatedAt: '2026-04-18T10:00:00Z' },
  ]),
  getKnowledgeStats: vi.fn(() => ({ categories: [], referenceChannels: 0 })),
}));

vi.mock('../../src/services/intelligence-bus', () => ({
  readSignals: (...args: unknown[]) => mockReadSignals(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  AiBudgetError: class AiBudgetError extends Error {
    decision: any;
    constructor(decision: any) { super(decision.code); this.name = 'AiBudgetError'; this.decision = decision; }
  },
  buildQuotaExceededPayload: vi.fn(() => ({})),
  isUserOverDailyCap: vi.fn(() => ({
    over: false,
    spentUsd: 0,
    capUsd: 0.2,
    plan: 'pro',
    resetAt: '2026-04-15T00:00:00.000Z',
  })),
  enforceCostGuardrails: vi.fn(() => ({
    block: false,
    status: 200,
    reason: 'ok',
    global: { totalUsd: 0, limitUsd: 100, exceeded: false },
    quota: {
      over: false,
      spentUsd: 0,
      capUsd: 0.2,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
    },
  })),
  buildQuotaExceededMessage: vi.fn(() => 'quota exceeded'),
  acquireCostLock: vi.fn(async () => () => { /* no-op */ }),
  getDailyQuotaStatus: vi.fn(() => ({
    over: false,
    usageFraction: 0,
    spentUsd: 0,
    capUsd: 0.2,
    plan: 'pro',
    resetAt: '2026-04-15T00:00:00.000Z',
  })),
  withAiBudgetReservation: vi.fn(async (_request: unknown, providerCall: () => Promise<unknown>) => providerCall()),
}));

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
  invalidatePlanningCaches: vi.fn(),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCacheStoreStats: vi.fn(() => ({})),
  _resetCacheStoreStatsForTests: vi.fn(),
  initCacheStore: vi.fn(),
  userCacheKey: vi.fn((userId: number | undefined, base: string) => `u:${userId}:${base}`),
  requireUserCacheKey: vi.fn((userId: number, base: string) => `u:${userId}:${base}`),
  getCached: vi.fn(() => null),
  setCache: vi.fn(),
  getCachedSWR: (...args: unknown[]) => mockGetCachedSWR(...args),
  setCacheSWR: (...args: unknown[]) => mockSetCacheSWR(...args),
  clearCache: vi.fn(),
  clearCacheByPrefix: vi.fn(),
  clearExpired: vi.fn(),
}));

vi.mock('../../src/services/swr-refresh-observability', () => ({
  recordSWRRefreshSuccess: vi.fn(),
  recordSWRRefreshFailure: vi.fn(),
  getSWRRefreshFailureSnapshot: vi.fn(() => ({})),
  _resetSWRRefreshFailuresForTests: vi.fn(),
}));

vi.mock('../../src/services/secretary-fastpath', () => ({
  normalizeLangHeader: vi.fn(() => 'pt-BR'),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (...args: any[]) => {
        if (sql.includes('WHERE stage = ?')) {
          const stage = args[0];
          if (stage === 'scripted') return [{ title: 'AI creator stack' }];
          return [];
        }
        if (sql.includes('FROM content_ideas') && sql.includes('WHERE user_id = ?')) {
          return [{ title: 'AI creator stack' }];
        }
        return [];
      },
      get: vi.fn(() => null),
      run: vi.fn(),
    }),
  }),
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

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  setHeader(name: string, value: string): MockRes;
  json(body: any): MockRes;
  end(): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { response.statusCode = code; return response; },
    setHeader(name: string, value: string) { response.headers[name.toLowerCase()] = value; return response; },
    json(body: any) { response.body = body; return response; },
    end() { return response; },
  };
  return response;
}

function mockReq(
  path = '/home',
  method = 'GET',
  userId = 12,
  headers: Record<string, string> = {},
  body: unknown = {},
): Request {
  return {
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    headers: { 'x-language': 'pt-BR', ...headers },
    header(name: string) {
      return (this.headers as any)[name.toLowerCase()] ?? (this.headers as any)[name];
    },
    body,
    userId,
    tenantId: userId,
  } as any;
}

async function dispatch(
  path = '/home',
  method = 'GET',
  userId = 12,
  headers: Record<string, string> = {},
  body: unknown = {},
): Promise<MockRes> {
  const { contentRoutes } = await import('../../src/api/routes/content');
  const router = contentRoutes();
  const req = mockReq(path, method, userId, headers, body);
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Content API — home route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunContentDiscovery.mockResolvedValue({
      ideas: ['Creator operating system'],
      provider: 'gemini',
      fullContent: '# Content Ideas',
      filePath: null,
      storage: 'content_workspace',
      searchCount: 1,
    });
    mockIsDuplicateIdea.mockResolvedValue({ isDuplicate: false, confidence: 0 });
    mockGetContentRadarPreferences.mockReturnValue({ topics: [], updatedAt: null });
    mockGetContentWorkspaceSummaryCounts.mockReturnValue({
      scheduledThisWeek: 0,
      scheduleAttentionThisWeek: 0,
      scheduleAuthorityStatus: 'current',
      scheduleSemantics: 'private_work_session',
    });
    mockGetUserTimezoneById.mockReturnValue('Europe/Lisbon');
    mockReadSignals.mockReset();
    mockReadSignals.mockReturnValue([]);
    mockGetCachedSWR.mockReturnValue(null);
    mockSetCacheSWR.mockClear();
  });

  it('returns a render-ready creator home contract', async () => {
    const response = await dispatch('/home');

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.hero.state).toBe('readyToFilm');
    expect(response.body.data.hero.primaryAction.target).toBe('schedule');
    expect(response.body.data.flow.steps).toHaveLength(4);
    expect(response.body.data.pipelineHealth.metrics.length).toBeGreaterThan(0);
    expect(response.body.data.pipelineHealth.publicationTracking).toEqual({
      availability: 'unavailable',
      reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
      publicationExecution: 'not_supported',
    });
    expect(response.body.data.pipelineHealth.metrics).toContainEqual(expect.objectContaining({
      id: 'published',
      value: 'Não monitorizada',
    }));
    expect(mockGetContentWorkspaceSummaryCounts).toHaveBeenCalledWith(
      { tenantId: 12, userId: 12 },
      expect.any(Object),
      expect.any(Date),
      'Europe/Lisbon',
    );
    expect(mockSetCacheSWR).toHaveBeenCalledWith(
      'content:home:active-content-agents.v3:u:12:t:12:pt-BR:tz:Europe/Lisbon:publication-truth.v3',
      expect.objectContaining({
        hero: expect.any(Object),
        workSchedule: expect.objectContaining({
          authority: 'secretary',
          authorityStatus: 'current',
          planStatus: 'proposed',
        }),
      }),
      120,
      600,
    );
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{32}"$/);
  });

  it('hides historical Reaction Radar signals while that producer is paused', async () => {
    mockReadSignals.mockImplementation((_source: string, types: string[]) => (
      types.includes('reaction_opportunity')
        ? [{ source_agent: 'reaction-radar', signal_type: 'reaction_opportunity', payload: { title: 'Paused reaction signal' } }]
        : []
    ));

    const response = await dispatch('/home');

    expect(response.statusCode).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('Paused reaction signal');
  });

  it('uses the current user timezone in the content home cache identity', async () => {
    await dispatch('/home');
    mockGetUserTimezoneById.mockReturnValue('America/Los_Angeles');
    await dispatch('/home');

    expect(mockGetCachedSWR).toHaveBeenNthCalledWith(1, 'content:home:active-content-agents.v3:u:12:t:12:pt-BR:tz:Europe/Lisbon:publication-truth.v3');
    expect(mockGetCachedSWR).toHaveBeenNthCalledWith(2, 'content:home:active-content-agents.v3:u:12:t:12:pt-BR:tz:America/Los_Angeles:publication-truth.v3');
    expect(mockGetContentWorkspaceSummaryCounts).toHaveBeenNthCalledWith(
      2,
      { tenantId: 12, userId: 12 },
      expect.any(Object),
      expect.any(Date),
      'America/Los_Angeles',
    );
  });

  it.each([
    ['partially_unavailable', 'partial', 'CONTENT_SCHEDULE_AUTHORITY_PARTIAL'],
    ['unavailable', 'unavailable', 'CONTENT_SCHEDULE_AUTHORITY_UNAVAILABLE'],
  ] as const)('labels %s schedule authority with an explicit %s plan', async (authorityStatus, planStatus, reasonCode) => {
    mockGetContentWorkspaceSummaryCounts.mockReturnValue({
      scheduledThisWeek: authorityStatus === 'partially_unavailable' ? 1 : 0,
      scheduleAttentionThisWeek: 1,
      scheduleAuthorityStatus: authorityStatus,
      scheduleSemantics: 'private_work_session',
    });

    const response = await dispatch('/home');

    expect(response.body.data.workSchedule).toMatchObject({
      authority: 'secretary',
      authorityStatus,
      planStatus,
    });
    expect(response.body.data.meta.isPartial).toBe(true);
    expect(response.body.data.meta.reasonCodes).toContain(reasonCode);
  });

  it('filters historical paused-agent optimization signals from Content Home', async () => {
    const signal = (sourceAgent: string, summary: string) => ({
      id: sourceAgent === 'performance-agent' ? 1 : 2,
      source_agent: sourceAgent,
      signal_type: 'creator_learning_digest',
      payload: { summary },
      priority: 'normal',
      consumed_by: [],
      status: 'active',
      created_at: '2026-08-29T12:00:00.000Z',
      expires_at: '2026-09-05T12:00:00.000Z',
      user_id: 12,
      tenant_id: 12,
      confidence: 0.8,
      format_tag: null,
      pillar_tag: null,
      evidence_count: 1,
    });
    mockReadSignals.mockImplementation((_source, signalTypes) => (
      Array.isArray(signalTypes) && signalTypes.includes('creator_learning_digest')
        ? [
          signal('performance-agent', 'Stale paused performance claim.'),
          signal('autoresearch', 'Active scoped learning.'),
        ]
        : []
    ));

    const response = await dispatch('/home');
    const learningStep = response.body.data.flow.steps.find((entry: any) => entry.id === 'learn');
    expect(learningStep).toMatchObject({ status: 'complete', summary: '1 sinais' });
    expect(JSON.stringify(response.body)).not.toContain('Stale paused performance claim');
  });

  it('returns cached content home with stable ETag and honors If-None-Match', async () => {
    const cachedHome = {
      hero: { state: 'readyToFilm' },
      meta: { source: 'server' },
    };
    mockGetCachedSWR.mockReturnValue({ value: cachedHome, fresh: true });

    const response = await dispatch('/home');
    expect(response.statusCode).toBe(200);
    expect(response.body.data).toEqual(cachedHome);
    expect(response.headers['cache-control']).toBe('private, max-age=120');

    const cachedAgain = await dispatch('/home', 'GET', 12, { 'if-none-match': response.headers.etag });
    expect(cachedAgain.statusCode).toBe(304);
    expect(cachedAgain.body).toBeNull();
  });

  it('rejects manual content discovery when the authenticated user scope is invalid', async () => {
    const { isValidTenantUserId } = await import('../../src/services/tenant-scope-observability');
    const { runContentDiscovery } = await import('../../src/services/content-discovery');
    vi.mocked(isValidTenantUserId).mockReturnValueOnce(false);

    const response = await dispatch('/discover', 'POST', 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(runContentDiscovery).not.toHaveBeenCalled();
  });

  it('returns iOS-decodable idea objects when discovery service returns titles', async () => {
    mockRunContentDiscovery.mockResolvedValueOnce({
      ideas: ['AI automation sprint', 'Training creator stack'],
      provider: 'gemini',
      fullContent: '# Content Ideas',
      filePath: null,
      storage: 'content_workspace',
      searchCount: 2,
    });

    const response = await dispatch('/discover', 'POST', 12);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.discovered).toBe(2);
    expect(response.body.data.ideas).toEqual([
      expect.objectContaining({
        id: expect.stringContaining('discovery-'),
        title: 'AI automation sprint',
        lifecycleState: 'discovered',
        approvalState: 'pending_review',
      }),
      expect.objectContaining({
        title: 'Training creator stack',
      }),
    ]);
    expect(mockRunContentDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      tenantId: 12,
      abortSignal: expect.any(Object),
    }));
  });

  it('rejects malformed fallback topics before live discovery starts', async () => {
    const response = await dispatch('/discover', 'POST', 12, {}, {
      topic: 'x'.repeat(161),
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe('CONTENT_VALIDATION_FAILED');
    expect(response.body.error.details).toEqual({ field: 'topic' });
    expect(mockRunContentDiscovery).not.toHaveBeenCalled();
  });

  it('withholds service-controlled lifecycle and provenance fields from discovery responses', async () => {
    mockRunContentDiscovery.mockResolvedValueOnce({
      ideas: [{
        id: 'provider-controlled',
        title: 'Bounded discovery idea',
        score: 1,
        lifecycleState: 'published',
        approvalState: 'approved',
        provenanceSources: [{ url: 'https://provider.invalid' }],
      }] as unknown as string[],
      provider: 'gemini',
      fullContent: '# Content Ideas',
      filePath: null,
      storage: 'content_workspace',
      searchCount: 1,
    });

    const response = await dispatch('/discover', 'POST', 12);

    expect(response.statusCode).toBe(200);
    expect(response.body.data.ideas).toEqual([
      expect.objectContaining({
        title: 'Bounded discovery idea',
        lifecycleState: 'discovered',
        approvalState: 'pending_review',
        provenanceSources: [],
      }),
    ]);
    expect(response.body.data.ideas[0].id).not.toBe('provider-controlled');
  });

  it('falls back to saved radar topics when live discovery fails', async () => {
    mockRunContentDiscovery.mockRejectedValueOnce(new Error('provider unavailable'));
    mockGetContentRadarPreferences.mockReturnValueOnce({
      topics: ['AI automation', 'marathon training'],
      updatedAt: '2026-05-05T09:00:00.000Z',
    });

    const response = await dispatch('/discover', 'POST', 12);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.degraded).toBe(true);
    expect(response.body.data.generation.provider).toBe('local-fallback');
    expect(response.body.data.generation.providerSemantics).toBe('deterministic_local');
    expect(response.body.data.persistence).toEqual({
      status: 'complete',
      confirmedCount: 4,
      createdCount: 4,
      replayedCount: 0,
      duplicateCount: 0,
    });
    expect(response.body.data.ideas[0]).toMatchObject({
      title: expect.stringContaining('AI automation'),
      workflowBlockers: ['Sem pesquisa ao vivo'],
    });
    expect(response.body.data.ideas.map((idea: { title: string }) => idea.title).join('\n'))
      .not.toMatch(/o que mudou|esta semana|what changed|this week/i);
    expect(mockCaptureDiscoveredIdea).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: 12, userId: 12 },
      provider: 'local-fallback',
    }));
  });

  it('returns typed dedup unavailability without attempting a local write fallback', async () => {
    mockRunContentDiscovery.mockRejectedValueOnce(Object.assign(new Error('dedup unavailable'), {
      code: 'CONTENT_DEDUP_UNAVAILABLE',
      status: 503,
      retryable: true,
    }));

    const response = await dispatch('/discover', 'POST', 12);

    expect(response.statusCode).toBe(503);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_DEDUP_UNAVAILABLE',
      details: { retryable: true },
    });
    expect(mockCaptureDiscoveredIdea).not.toHaveBeenCalled();
  });

  it('returns confirmed partial-write truth when discovery persistence is unavailable', async () => {
    mockRunContentDiscovery.mockRejectedValueOnce(Object.assign(new Error('workspace unavailable'), {
      code: 'CONTENT_DISCOVERY_PERSISTENCE_UNAVAILABLE',
      status: 503,
      details: { confirmedBeforeFailure: 2, retryable: true },
    }));

    const response = await dispatch('/discover', 'POST', 12);

    expect(response.statusCode).toBe(503);
    expect(response.body.error).toMatchObject({
      code: 'CONTENT_DISCOVERY_PERSISTENCE_UNAVAILABLE',
      details: { confirmedBeforeFailure: 2, retryable: true },
    });
    expect(mockCaptureDiscoveredIdea).not.toHaveBeenCalled();
  });
});
