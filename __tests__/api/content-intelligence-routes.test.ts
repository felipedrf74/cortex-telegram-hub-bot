import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Router, type Request, type Response } from 'express';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/portal/telemetry', () => ({
  getJobStatuses: vi.fn(() => [
    { name: 'reaction_radar', lastRunAt: '2026-04-24T08:00:00.000Z', lastResult: 'success' },
    { name: 'performance_agent', lastRunAt: '2026-04-24T09:00:00.000Z', lastResult: 'running' },
    { name: 'autoresearch', lastRunAt: '2026-04-23T09:00:00.000Z', lastResult: 'success' },
  ]),
}));

vi.mock('../../src/services/intelligence-bus', () => ({
  readSignals: vi.fn((source: string, types: string[], limit: number, userId: number, days: number, tenantId?: number) => {
    if (types.includes('reaction_opportunity')) {
      return [{
        id: 11,
        source_agent: source,
        signal_type: 'reaction_opportunity',
        payload: { topic: 'marathon', title: 'Marathon angle', summary: `${limit}:${userId}:${days}:${tenantId}` },
        priority: 'normal',
        consumed_by: [],
        status: 'active',
        created_at: '2026-04-24T08:00:00.000Z',
        expires_at: '2026-04-25T08:00:00.000Z',
        user_id: userId,
        confidence: 0.8,
        format_tag: null,
        pillar_tag: null,
        evidence_count: 2,
      }];
    }
    return [{
      id: 21,
      source_agent: source,
      signal_type: 'pillar_performance',
      payload: { pillar: 'training', summary: `${limit}:${userId}:${days}:${tenantId}` },
      priority: 'normal',
      consumed_by: [],
      status: 'active',
      created_at: '2026-04-24T08:00:00.000Z',
      expires_at: '2026-04-25T08:00:00.000Z',
      user_id: userId,
      confidence: 0.7,
      format_tag: null,
      pillar_tag: null,
      evidence_count: 4,
    }];
  }),
}));

vi.mock('../../src/services/content-radar-preferences', () => ({
  getContentRadarPreferences: vi.fn(() => ({ topics: ['marathon'], updatedAt: '2026-04-24T08:30:00.000Z' })),
  filterSignalsForRadarPreferences: vi.fn((signals: any[]) => signals),
  buildRadarTopicSummaries: vi.fn((topics: string[], signals: any[]) => topics.map((topic) => ({
    name: topic,
    keywordCount: signals.length,
  }))),
}));

vi.mock('../../src/services/content-dashboard-service', () => ({
  getVoiceDna: vi.fn(() => [{
    category: 'brand_voice',
    label: 'Brand Voice',
    text: 'Energetic but practical.',
    sources: ['youtube'],
    version: 1,
    updatedAt: '2026-04-24T07:00:00.000Z',
  }]),
  getKnowledgeStats: vi.fn(() => ({
    referenceChannels: 1,
    categories: [{ category: 'brand_voice', sources: 2, updatedAt: '2026-04-24T07:15:00.000Z' }],
  })),
}));

vi.mock('../../src/services/content-scheduler', () => ({
  getFilmingRecommendation: vi.fn(async () => ({
    date: '2026-04-25',
    confidence: 'high',
    reason: 'Strong training-story window.',
  })),
}));

vi.mock('../../src/services/content-learning-store', () => ({
  getPerformanceSummary: vi.fn(() => ({
    count: 2,
    avgViews: 3250,
    avgRetention: 54.5,
    totalLikes: 420,
    totalComments: 62,
    totalSubsGained: 11,
    entries: [
      {
        id: 91,
        selectedTitle: 'How I would build it solo',
        hookUsed: 'Stop losing creator ideas',
        views: 5000,
        retentionPct: 61,
        likes: 340,
        comments: 52,
        subsGained: 10,
        loggedAt: '2026-04-24T09:05:00.000Z',
      },
      {
        id: 92,
        selectedTitle: 'Creator systems teardown',
        hookUsed: 'The hidden cost of messy notes',
        views: 1500,
        retentionPct: 48,
        likes: 80,
        comments: 10,
        subsGained: 1,
        loggedAt: '2026-04-23T09:05:00.000Z',
      },
    ],
  })),
}));

vi.mock('../../src/services/content-intelligence', () => ({
  getActiveContentPillars: vi.fn(() => [{ name: 'fallback pillar', keywordCount: 1 }]),
  getContentDeskItems: vi.fn(() => [{ title: 'Race story', body: 'Use the training signal.' }]),
  localizeFilmingRecommendation: vi.fn((recommendation: any, language: string) => ({
    ...recommendation,
    reason: `${language}:${recommendation.reason}`,
  })),
}));

import { registerContentIntelligenceRoutes } from '../../src/api/routes/content-intelligence-routes';
import { getJobStatuses } from '../../src/portal/telemetry';
import { readSignals } from '../../src/services/intelligence-bus';
import {
  buildRadarTopicSummaries,
  filterSignalsForRadarPreferences,
  getContentRadarPreferences,
} from '../../src/services/content-radar-preferences';
import { getKnowledgeStats, getVoiceDna } from '../../src/services/content-dashboard-service';
import { getFilmingRecommendation } from '../../src/services/content-scheduler';
import { getContentDeskItems, localizeFilmingRecommendation } from '../../src/services/content-intelligence';
import { getPerformanceSummary } from '../../src/services/content-learning-store';

interface MockRes {
  statusCode: number;
  body: any;
  headersSent: boolean;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; response.headersSent = true; return response; },
  };
  return response;
}

function mockReq(method: string, path: string, userId: number | undefined = 41, tenantId: number | undefined = userId): Request {
  return {
    userId,
    tenantId,
    method,
    url: path,
    originalUrl: path,
    baseUrl: '',
    path,
    query: {},
    params: {},
    body: {},
    headers: { 'x-language': 'pt-BR' },
    header(name: string) {
      return (this.headers as any)[name.toLowerCase()] ?? (this.headers as any)[name];
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
  path: string,
  userId: number | undefined = 41,
  ensureValidScope = makeEnsureValidScope(),
  tenantId: number | undefined = userId,
): Promise<{ response: MockRes; ensureValidScope: ReturnType<typeof makeEnsureValidScope> }> {
  const router = Router();
  registerContentIntelligenceRoutes(router, () => 'pt-BR', ensureValidScope);
  const req = mockReq('GET', path, userId, tenantId);
  const res = mockRes();

  await new Promise<void>((resolve, reject) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
    setImmediate(resolve);
  });

  return { response: res, ensureValidScope };
}

describe('content intelligence routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds the backstage summary from scoped jobs, signals, voice, and knowledge state', async () => {
    const { response, ensureValidScope } = await dispatch('/intelligence', 77, makeEnsureValidScope(), 7700);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 77, 'content_route_intelligence_summary');
    expect(getJobStatuses).toHaveBeenCalled();
    expect(readSignals).toHaveBeenCalledWith(
      'ios-content-intelligence',
      ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
      25,
      77,
      7,
      7700,
    );
    expect(readSignals).toHaveBeenCalledWith(
      'ios-content-intelligence',
      ['hook_effectiveness', 'pillar_performance', 'learning_digest', 'content_formula'],
      25,
      77,
      14,
      7700,
    );
    expect(getContentRadarPreferences).toHaveBeenCalledWith(77, 7700);
    expect(filterSignalsForRadarPreferences).toHaveBeenCalledWith(expect.any(Array), ['marathon']);
    expect(getVoiceDna).toHaveBeenCalledWith(undefined, 77);
    expect(getKnowledgeStats).toHaveBeenCalledWith(undefined, 77);
    expect(getPerformanceSummary).toHaveBeenCalledWith(77, 30, 7700);
    expect(response.body.data.discovery.activeCount).toBe(1);
    expect(response.body.data.script.status).toBe('ready');
    expect(response.body.data.optimization.status).toBe('syncing');
    expect(response.body.data.optimization.performanceSummary).toMatchObject({
      count: 2,
      avgViews: 3250,
      avgRetention: 54.5,
      totalLikes: 420,
      totalComments: 62,
      totalSubsGained: 11,
      topEntry: {
        id: 91,
        title: 'How I would build it solo',
        views: 5000,
        retentionPct: 61,
      },
    });
  });

  it('builds the detail response with filming, desk, and preferred-topic context', async () => {
    const { response, ensureValidScope } = await dispatch('/intelligence/detail', 88, makeEnsureValidScope(), 8800);

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 88, 'content_route_intelligence_detail');
    expect(readSignals).toHaveBeenCalledWith(
      'ios-content-intelligence-detail',
      ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
      6,
      88,
      7,
      8800,
    );
    expect(getFilmingRecommendation).toHaveBeenCalledWith(88);
    expect(localizeFilmingRecommendation).toHaveBeenCalledWith(expect.any(Object), 'pt-BR');
    expect(buildRadarTopicSummaries).toHaveBeenCalledWith(['marathon'], expect.any(Array));
    expect(getContentDeskItems).toHaveBeenCalledWith(88, 3);
    expect(response.body.data.discovery.preferredTopics).toEqual(['marathon']);
    expect(response.body.data.discovery.monitoredPillars).toEqual([{ name: 'marathon', keywordCount: 1 }]);
    expect(response.body.data.schedule.filmingRecommendation.reason).toContain('pt-BR:');
    expect(response.body.data.optimization.performanceSummary.recentEntries).toHaveLength(2);
    expect(response.body.data.optimization.performanceSummary.recentEntries[0]).toMatchObject({
      id: 91,
      title: 'How I would build it solo',
      likes: 340,
      comments: 52,
      subsGained: 10,
    });
  });

  it('rejects invalid authenticated scope before reading intelligence state', async () => {
    const { response, ensureValidScope } = await dispatch('/intelligence', 0);

    expect(response.statusCode).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(ensureValidScope).toHaveBeenCalledWith(expect.anything(), 0, 'content_route_intelligence_summary');
    expect(readSignals).not.toHaveBeenCalled();
    expect(getVoiceDna).not.toHaveBeenCalled();
  });
});
