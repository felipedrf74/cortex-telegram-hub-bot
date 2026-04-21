import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: vi.fn(() => 'pt-BR'),
}));

vi.mock('../../src/services/tenant-scope-observability', () => ({
  isValidTenantUserId: vi.fn(() => true),
  recordTenantScopeAnomaly: vi.fn(),
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
  getContentRadarPreferences: vi.fn(() => ({ topics: [], updatedAt: null })),
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
  buildQuotaExceededMessage: vi.fn(() => 'quota exceeded'),
  acquireCostLock: vi.fn(async () => () => { /* no-op */ }),
}));

vi.mock('../../src/services/plan-cache-invalidator', () => ({
  invalidatePlanningCaches: vi.fn(),
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
}));

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

function mockReq(path = '/home'): Request {
  return {
    method: 'GET',
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    headers: { 'x-language': 'pt-BR' },
    header(name: string) {
      return (this.headers as any)[name.toLowerCase()] ?? (this.headers as any)[name];
    },
    body: {},
    userId: 12,
  } as any;
}

async function dispatch(path = '/home'): Promise<MockRes> {
  const { contentRoutes } = await import('../../src/api/routes/content');
  const router = contentRoutes();
  const req = mockReq(path);
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
  });

  it('returns a render-ready creator home contract', async () => {
    const response = await dispatch('/home');

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.hero.state).toBe('readyToFilm');
    expect(response.body.data.hero.primaryAction.target).toBe('schedule');
    expect(response.body.data.flow.steps).toHaveLength(4);
    expect(response.body.data.pipelineHealth.metrics.length).toBeGreaterThan(0);
  });
});
