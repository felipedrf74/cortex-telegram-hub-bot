import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetErrorTrends = vi.fn();
const mockGetErrorDistribution = vi.fn();
const mockGetActiveProvider = vi.fn();
const mockGetSpendByProvider = vi.fn();
const mockGetFastpathMetrics = vi.fn();
const mockGetFastpathPatterns = vi.fn();
const mockGetQualityByAgent = vi.fn();
const mockGetTaskExecutionSummary = vi.fn();
const mockGetRecentExecutions = vi.fn();
const mockSendPortalInternalError = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('../../src/services/error-monitor', () => ({
  getErrorTrends: (...args: unknown[]) => mockGetErrorTrends(...args),
}));

vi.mock('../../src/services/error-categorizer', () => ({
  getErrorDistribution: (...args: unknown[]) => mockGetErrorDistribution(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  getSpendByProvider: (...args: unknown[]) => mockGetSpendByProvider(...args),
}));

vi.mock('../../src/services/secretary-fastpath', () => ({
  getFastpathMetrics: (...args: unknown[]) => mockGetFastpathMetrics(...args),
  getFastpathPatterns: (...args: unknown[]) => mockGetFastpathPatterns(...args),
}));

vi.mock('../../src/services/quality-scorer', () => ({
  getQualityByAgent: (...args: unknown[]) => mockGetQualityByAgent(...args),
}));

vi.mock('../../src/services/task-metrics', () => ({
  getTaskExecutionSummary: (...args: unknown[]) => mockGetTaskExecutionSummary(...args),
  getRecentExecutions: (...args: unknown[]) => mockGetRecentExecutions(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => mockSendPortalInternalError(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { registerPortalOperationsRoutes } from '../../src/portal/operations-routes';

type Handler = (req: any, res: any) => unknown;

interface CapturedRoute {
  method: 'GET';
  path: string;
  handler: Handler;
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const app = {
    get(path: string, handler: Handler) {
      routes.push({ method: 'GET', path, handler });
    },
  };
  registerPortalOperationsRoutes(app as any, {
    getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  });
  return routes;
}

function invoke(path: string) {
  const route = captureRoutes().find((candidate) => candidate.path === path);
  if (!route) throw new Error(`Route not registered: ${path}`);
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
  route.handler({}, res);
  return res;
}

describe('portal operations routes', () => {
  beforeEach(() => {
    mockGetErrorTrends.mockReset();
    mockGetErrorDistribution.mockReset();
    mockGetActiveProvider.mockReset();
    mockGetSpendByProvider.mockReset();
    mockGetFastpathMetrics.mockReset();
    mockGetFastpathPatterns.mockReset();
    mockGetQualityByAgent.mockReset();
    mockGetTaskExecutionSummary.mockReset();
    mockGetRecentExecutions.mockReset();
    mockSendPortalInternalError.mockReset();
    mockLoggerError.mockReset();
  });

  it('registers the read-only operations route family', () => {
    const routes = captureRoutes().map((route) => `${route.method} ${route.path}`);

    expect(routes).toEqual([
      'GET /api/errors',
      'GET /api/error-distribution',
      'GET /api/provider-health',
      'GET /api/spend-by-provider',
      'GET /api/secretary-metrics',
      'GET /api/quality-scores',
      'GET /api/task-metrics',
    ]);
  });

  it('returns error trends with the legacy ok wrapper', () => {
    mockGetErrorTrends.mockReturnValue({ total: 2, recent: [{ message: 'boom' }] });

    const res = invoke('/api/errors');

    expect(res.body).toEqual({ ok: true, total: 2, recent: [{ message: 'boom' }] });
  });

  it('returns provider health for the active provider and empty state without one', () => {
    mockGetActiveProvider.mockReturnValueOnce({
      getProviderHealth: () => ({ openai: { status: 'healthy' } }),
    });

    expect(invoke('/api/provider-health').body).toEqual({
      providers: { openai: { status: 'healthy' } },
    });

    mockGetActiveProvider.mockReturnValueOnce(null);
    expect(invoke('/api/provider-health').body).toEqual({ providers: {} });
  });

  it('preserves spend fallback behavior when the cost store fails', () => {
    mockGetSpendByProvider.mockImplementationOnce(() => {
      throw new Error('db unavailable');
    });

    const res = invoke('/api/spend-by-provider');

    expect(res.body).toEqual({ anthropic: 0, openai: 0, gemini: 0 });
    expect(mockSendPortalInternalError).not.toHaveBeenCalled();
  });

  it('returns secretary fastpath metrics and preserves the degraded fallback', () => {
    mockGetFastpathMetrics.mockReturnValueOnce({
      totalAttempts: 10,
      totalHits: 7,
      hitRate: 0.7,
      avgLatencyMs: 2,
      hitsByPattern: { today: 7 },
    });
    mockGetFastpathPatterns.mockReturnValueOnce(['today']);

    expect(invoke('/api/secretary-metrics').body).toEqual({
      ok: true,
      fastpath: {
        totalAttempts: 10,
        totalHits: 7,
        hitRate: 0.7,
        avgLatencyMs: 2,
        hitsByPattern: { today: 7 },
        registeredPatterns: ['today'],
      },
    });

    mockGetFastpathMetrics.mockImplementationOnce(() => {
      throw new Error('metrics unavailable');
    });

    expect(invoke('/api/secretary-metrics').body).toEqual({
      ok: false,
      message: 'Secretary metrics unavailable',
      fastpath: {
        totalAttempts: 0,
        totalHits: 0,
        hitRate: 0,
        avgLatencyMs: 0,
        hitsByPattern: {},
        registeredPatterns: [],
      },
    });
    expect(mockLoggerError).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Portal: secretary metrics failed');
  });

  it('returns quality and task metric snapshots', () => {
    mockGetQualityByAgent.mockReturnValue([{ agent: 'secretary', avgScore: 0.91 }]);
    expect(invoke('/api/quality-scores').body).toEqual({
      ok: true,
      byAgent: [{ agent: 'secretary', avgScore: 0.91 }],
    });

    mockGetTaskExecutionSummary.mockReturnValue({ totalTasks: 3 });
    mockGetRecentExecutions.mockReturnValue([{ id: 1, taskTitle: 'Review' }]);

    expect(invoke('/api/task-metrics').body).toEqual({
      ok: true,
      summary: { totalTasks: 3 },
      recent: [{ id: 1, taskTitle: 'Review' }],
    });
  });

  it('uses shared sanitized errors for route failures that should not degrade in-place', () => {
    mockGetQualityByAgent.mockImplementation(() => {
      throw new Error('raw quality database failure');
    });

    const res = invoke('/api/quality-scores');

    expect(mockSendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Portal request failed',
      'Portal: request failed',
    );
  });
});
