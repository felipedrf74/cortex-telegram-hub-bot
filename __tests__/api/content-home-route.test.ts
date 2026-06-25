import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockRunContentDiscovery = vi.hoisted(() => vi.fn(async (userId: number) => ({
  ideas: ['Creator operating system'],
  provider: 'gemini',
  fullContent: '# Content Ideas',
  filePath: `/tmp/content-${userId}.md`,
  searchCount: 1,
  researchPackage: {
    packageId: 'crp_default_discovery',
    topic: 'daily content discovery',
    query: 'daily content discovery',
    route: 'discovery',
    sourceMode: 'real',
    freshnessClass: 'fresh',
    sourceCount: 1,
    realSourceCount: 1,
    mockSourceCount: 0,
    observedAt: '2026-05-05T09:00:00.000Z',
    expiresAt: null,
    confidence: 0.7,
    publishable: true,
    sources: [],
    sourceSummaries: [],
    claimLedger: [],
    warnings: [],
  },
})));

const mockSaveIdea = vi.hoisted(() => vi.fn());
const mockIsDuplicateIdea = vi.hoisted(() => vi.fn(async () => ({ isDuplicate: false, confidence: 0 })));
const mockGetContentRadarPreferences = vi.hoisted(() => vi.fn(() => ({ topics: [], updatedAt: null })));
const mockGetCachedSWR = vi.hoisted(() => vi.fn(() => null));
const mockSetCacheSWR = vi.hoisted(() => vi.fn());

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
}));

vi.mock('../../src/services/tenant-scope-observability', () => ({
  isValidTenantUserId: vi.fn(() => true),
  recordTenantScopeAnomaly: vi.fn(),
}));

vi.mock('../../src/services/content-discovery', () => ({
  runContentDiscovery: mockRunContentDiscovery,
}));

vi.mock('../../src/state/saved-ideas', () => ({
  saveIdea: (...args: unknown[]) => mockSaveIdea(...args),
}));

vi.mock('../../src/services/content-dedup', () => ({
  isDuplicateIdea: (...args: unknown[]) => mockIsDuplicateIdea(...args),
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
  readSignals: vi.fn(() => []),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
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

function mockReq(path = '/home', method = 'GET', userId = 12, headers: Record<string, string> = {}): Request {
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
    body: {},
    userId,
    tenantId: userId,
  } as any;
}

async function dispatch(path = '/home', method = 'GET', userId = 12, headers: Record<string, string> = {}): Promise<MockRes> {
  const { contentRoutes } = await import('../../src/api/routes/content');
  const router = contentRoutes();
  const req = mockReq(path, method, userId, headers);
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
      filePath: '/tmp/content-12.md',
      searchCount: 1,
      researchPackage: {
        packageId: 'crp_default_discovery',
        topic: 'daily content discovery',
        query: 'daily content discovery',
        route: 'discovery',
        sourceMode: 'real',
        freshnessClass: 'fresh',
        sourceCount: 1,
        realSourceCount: 1,
        mockSourceCount: 0,
        observedAt: '2026-05-05T09:00:00.000Z',
        expiresAt: null,
        confidence: 0.7,
        publishable: true,
        sources: [],
        sourceSummaries: [],
        claimLedger: [],
        warnings: [],
      },
    });
    mockIsDuplicateIdea.mockResolvedValue({ isDuplicate: false, confidence: 0 });
    mockGetContentRadarPreferences.mockReturnValue({ topics: [], updatedAt: null });
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
    expect(mockSetCacheSWR).toHaveBeenCalledWith(
      'u:12:t:12:content:home:pt-BR',
      expect.objectContaining({ hero: expect.any(Object) }),
      120,
      600,
    );
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{32}"$/);
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
      filePath: '/tmp/content-12.md',
      searchCount: 2,
      researchPackage: {
        packageId: 'crp_test_discovery',
        topic: 'daily content discovery',
        query: 'daily content discovery',
        route: 'discovery',
        sourceMode: 'real',
        freshnessClass: 'fresh',
        sourceCount: 1,
        realSourceCount: 1,
        mockSourceCount: 0,
        observedAt: '2026-05-05T09:00:00.000Z',
        expiresAt: null,
        confidence: 0.7,
        publishable: true,
        sources: [],
        sourceSummaries: [],
        claimLedger: [],
        warnings: [],
      },
    });

    const response = await dispatch('/discover', 'POST', 12);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.discovered).toBe(2);
    expect(response.body.data.research).toMatchObject({
      sourceMode: 'real',
      sourceCount: 1,
      publishable: true,
    });
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
    expect(response.body.data.research).toMatchObject({
      sourceMode: 'degraded',
      publishable: false,
    });
    expect(response.body.data.researchWarnings).toContain('research_degraded_non_publishable');
    expect(response.body.data.generation.provider).toBe('local-fallback');
    expect(response.body.data.ideas[0]).toMatchObject({
      title: expect.stringContaining('AI automation'),
      workflowBlockers: ['Sem pesquisa ao vivo'],
    });
    expect(mockSaveIdea).toHaveBeenCalled();
  });
});
