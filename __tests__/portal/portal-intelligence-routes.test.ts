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
      { id: 1, signal_type: 'hook_effectiveness' },
      { id: 2, signal_type: 'voice_pattern' },
    ]);
    mockGetActiveSignalCount.mockReturnValue(7);
    const route = captureRoutes().find((candidate) => candidate.method === 'GET' && candidate.path === '/api/signals');

    const res = invoke(route!, {
      query: { limit: '500', type: 'voice_pattern' },
    });

    expect(mockGetSignalLog).toHaveBeenCalledWith(200);
    expect(res.body).toEqual({
      ok: true,
      signals: [{ id: 2, signal_type: 'voice_pattern' }],
      activeCount: 7,
    });
  });

  it('dismisses valid signals and clears the portal snapshot cache', () => {
    const route = captureRoutes().find((candidate) => candidate.method === 'POST' && candidate.path === '/api/signals/:id/dismiss');

    const res = invoke(route!, {
      params: { id: '42' },
    });

    expect(mockDismissSignal).toHaveBeenCalledWith(42);
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
});
