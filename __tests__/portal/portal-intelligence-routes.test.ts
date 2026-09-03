import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAgentStats = vi.fn();
const mockGetActiveSignalCount = vi.fn();
const mockGetSignalLog = vi.fn();
const mockDismissSignal = vi.fn();
const mockReadRankedSignals = vi.fn();
const mockGetPipelineStats = vi.fn();
const mockGetPipelineOperationalMetrics = vi.fn();
const mockClearPortalSnapshotCache = vi.fn();

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock('../../src/services/intelligence-bus', () => ({
  getAgentStats: (...args: unknown[]) => mockGetAgentStats(...args),
  getActiveSignalCount: (...args: unknown[]) => mockGetActiveSignalCount(...args),
  getSignalLog: (...args: unknown[]) => mockGetSignalLog(...args),
  dismissSignal: (...args: unknown[]) => mockDismissSignal(...args),
  readRankedSignals: (...args: unknown[]) => mockReadRankedSignals(...args),
}));

vi.mock('../../src/agents/pipeline-agent', () => ({
  getPipelineStats: (...args: unknown[]) => mockGetPipelineStats(...args),
  getPipelineOperationalMetrics: (...args: unknown[]) => mockGetPipelineOperationalMetrics(...args),
}));

vi.mock('../../src/portal/snapshot-cache', () => ({
  clearPortalSnapshotCache: (...args: unknown[]) => mockClearPortalSnapshotCache(...args),
}));

import { registerPortalIntelligenceRoutes } from '../../src/portal/intelligence-routes';

type Handler = (req: any, res: any, next?: () => void) => unknown;

interface CapturedRoute {
  method: 'GET' | 'POST';
  path: string;
  handlers: Handler[];
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const app = {
    get(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'GET', path, handlers });
    },
    post(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'POST', path, handlers });
    },
  };
  registerPortalIntelligenceRoutes(app as any);
  return routes;
}

function invoke(route: CapturedRoute, req: any = {}) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  let index = 0;
  const next = () => {
    const handler = route.handlers[index++];
    if (handler) handler(req, res, next);
  };
  next();
  return res;
}

describe('portal intelligence routes', () => {
  beforeEach(() => {
    mockGetAgentStats.mockReset();
    mockGetActiveSignalCount.mockReset();
    mockGetSignalLog.mockReset();
    mockDismissSignal.mockReset();
    mockReadRankedSignals.mockReset();
    mockGetPipelineStats.mockReset();
    mockGetPipelineOperationalMetrics.mockReset();
    mockClearPortalSnapshotCache.mockReset();
  });

  it('registers the bounded intelligence and pipeline route family', () => {
    const routes = captureRoutes().map((route) => `${route.method} ${route.path}`);

    expect(routes).toEqual([
      'GET /api/agents',
      'GET /api/signals',
      'POST /api/signals/:id/dismiss',
      'GET /api/pipeline',
      'GET /api/pipeline/metrics',
      'GET /api/signals/ranked',
    ]);
  });

  it('caps signal fetches and filters by signal type', () => {
    mockGetSignalLog.mockReturnValue([
      { id: 1, signal_type: 'hook_effectiveness', source_agent: 'performance-agent' },
      { id: 2, signal_type: 'voice_pattern', source_agent: 'voice-evolution' },
    ]);
    mockGetActiveSignalCount.mockReturnValue(7);
    const route = captureRoutes().find((candidate) => candidate.method === 'GET' && candidate.path === '/api/signals');

    const res = invoke(route!, {
      query: { limit: '500', type: 'voice_pattern', tenantId: '12', userId: '12' },
    });

    expect(mockGetSignalLog).toHaveBeenCalledWith(200, 12, 12, {
      excludeSourceAgents: ['performance_agent', 'reaction_radar', 'seo_agent'],
    });
    expect(mockGetActiveSignalCount).toHaveBeenCalledWith(12, 12, {
      excludeSourceAgents: ['performance_agent', 'reaction_radar', 'seo_agent'],
      excludeIneligibleContentLearningDigests: true,
    });
    expect(res.body).toEqual({
      ok: true,
      signals: [{ id: 2, signal_type: 'voice_pattern', source_agent: 'voice-evolution' }],
      activeCount: 7,
    });
  });

  it('projects paused agents truthfully and removes their historical signals', () => {
    mockGetAgentStats.mockReturnValue([
      { agent: 'seo-agent', last_run: '2026-08-01', last_status: 'success', signals_produced: 8, total_runs: 4 },
      { agent: 'reaction-radar', last_run: '2026-08-30', last_status: 'success', signals_produced: 2, total_runs: 1 },
    ]);
    mockGetSignalLog.mockReturnValue([
      { id: 1, signal_type: 'keyword_opportunity', source_agent: 'seo-agent' },
      { id: 2, signal_type: 'reaction_opportunity', source_agent: 'reaction-radar' },
    ]);
    mockGetActiveSignalCount.mockReturnValue(1);
    const routes = captureRoutes();

    const agents = invoke(routes.find((route) => route.method === 'GET' && route.path === '/api/agents')!, { query: {} });
    const signals = invoke(routes.find((route) => route.method === 'GET' && route.path === '/api/signals')!, {
      query: { tenantId: '12', userId: '12' },
    });

    expect(agents.body).toEqual({
      ok: true,
      agents: [
        expect.objectContaining({
          agent: 'seo-agent',
          lifecycle: 'paused',
          last_run: null,
          last_status: 'paused',
          signals_produced: 0,
          total_runs: 0,
        }),
        expect.objectContaining({
          agent: 'reaction-radar',
          lifecycle: 'paused',
          last_run: null,
          last_status: 'paused',
          signals_produced: 0,
          total_runs: 0,
        }),
      ],
    });
    expect(signals.body.signals).toEqual([]);
  });

  it('dismisses valid signals and clears the portal snapshot cache', () => {
    mockDismissSignal.mockReturnValue(1);
    const route = captureRoutes().find((candidate) => candidate.method === 'POST' && candidate.path === '/api/signals/:id/dismiss');

    const res = invoke(route!, {
      params: { id: '42' },
      query: { tenantId: '12', userId: '12' },
    });

    expect(mockDismissSignal).toHaveBeenCalledWith(42, 12, 12);
    expect(mockClearPortalSnapshotCache).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ ok: true, message: 'Signal dismissed' });
  });

  it('rejects invalid signal ids before mutating state', () => {
    const route = captureRoutes().find((candidate) => candidate.method === 'POST' && candidate.path === '/api/signals/:id/dismiss');

    const res = invoke(route!, {
      params: { id: 'nope' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, message: 'Invalid ID' });
    expect(mockDismissSignal).not.toHaveBeenCalled();
    expect(mockClearPortalSnapshotCache).not.toHaveBeenCalled();
  });

  it('requires tenant scope for signal reads', () => {
    const route = captureRoutes().find((candidate) => candidate.method === 'GET' && candidate.path === '/api/signals');

    const res = invoke(route!, { query: {} });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'TENANT_SCOPE_REQUIRED' } });
    expect(mockGetSignalLog).not.toHaveBeenCalled();
  });

  it('passes tenant scope and paused-source exclusions into ranked signal reads', () => {
    mockReadRankedSignals.mockReturnValue([
      {
        id: 1,
        source_agent: 'performance_agent',
        signal_type: 'hook_effectiveness',
        payload: { hook: 'stale' },
        priority: 'urgent',
      },
      {
        id: 2,
        source_agent: 'voice-evolution',
        signal_type: 'voice_pattern',
        payload: { observation: 'active' },
        priority: 'normal',
      },
    ]);
    const route = captureRoutes().find((candidate) => candidate.method === 'GET' && candidate.path === '/api/signals/ranked');

    const res = invoke(route!, { query: { tenantId: '77', userId: '78', limit: '5' } });

    expect(res.statusCode).toBe(200);
    expect(mockReadRankedSignals).toHaveBeenCalledWith('portal-inspector', expect.any(Array), expect.objectContaining({
      limit: 5,
      userId: 78,
      tenantId: 77,
      excludeSourceAgents: ['performance_agent', 'reaction_radar', 'seo_agent'],
    }));
    expect(res.body).toMatchObject({
      ok: true,
      count: 1,
      signals: [expect.objectContaining({ id: 2, source: 'voice-evolution' })],
    });
  });
});
