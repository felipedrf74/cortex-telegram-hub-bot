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
const mockListOperatorAlerts = vi.fn();
const mockGetOperatorAlertDeliverySummary = vi.fn();
const mockAcknowledgeOperatorAlert = vi.fn();
const mockResolveOperatorAlert = vi.fn();
const mockRetryOperatorAlertDelivery = vi.fn();
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

vi.mock('../../src/services/operator-alerts', () => ({
  listOperatorAlerts: (...args: unknown[]) => mockListOperatorAlerts(...args),
  getOperatorAlertDeliverySummary: (...args: unknown[]) => mockGetOperatorAlertDeliverySummary(...args),
  acknowledgeOperatorAlert: (...args: unknown[]) => mockAcknowledgeOperatorAlert(...args),
  resolveOperatorAlert: (...args: unknown[]) => mockResolveOperatorAlert(...args),
  retryOperatorAlertDelivery: (...args: unknown[]) => mockRetryOperatorAlertDelivery(...args),
}));

const hoistedOps = vi.hoisted(() => ({
  mockLogPortalAdminMutation: vi.fn(),
  mockRequirePortalAdminToken: vi.fn((_req: any, _res: any, next: () => void) => next()),
}));

vi.mock('../../src/api/secret-guards', () => ({
  extractPortalActorHint: (req: any) => req.headers?.['x-portal-actor'],
  getPortalAuthContext: (req: any) => req.portalAuthContext,
  requirePortalAdminToken: hoistedOps.mockRequirePortalAdminToken,
}));

vi.mock('../../src/portal/admin-audit', () => ({
  buildPortalAdminAuditDetails: vi.fn(),
  logPortalAdminMutation: (...args: unknown[]) => hoistedOps.mockLogPortalAdminMutation(...args),
}));

const mockLogPortalAdminMutation = hoistedOps.mockLogPortalAdminMutation;
const mockRequirePortalAdminToken = hoistedOps.mockRequirePortalAdminToken;

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => mockSendPortalInternalError(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerPortalOperationsRoutes } from '../../src/portal/operations-routes';

type Handler = (req: any, res: any) => unknown;

interface CapturedRoute {
  method: 'GET' | 'POST';
  path: string;
  handler: Handler;
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const app = {
    get(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'GET', path, handler: handlers[handlers.length - 1] });
    },
    post(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'POST', path, handler: handlers[handlers.length - 1] });
    },
  };
  registerPortalOperationsRoutes(app as any, {
    getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  });
  return routes;
}

function invoke(path: string, options: {
  method?: 'GET' | 'POST';
  req?: Record<string, unknown>;
} = {}) {
  const method = options.method ?? 'GET';
  const route = captureRoutes().find((candidate) => candidate.path === path && candidate.method === method);
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
  route.handler(options.req ?? {}, res);
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
    mockListOperatorAlerts.mockReset();
    mockGetOperatorAlertDeliverySummary.mockReset();
    mockAcknowledgeOperatorAlert.mockReset();
    mockResolveOperatorAlert.mockReset();
    mockRetryOperatorAlertDelivery.mockReset();
    mockSendPortalInternalError.mockReset();
    mockLoggerError.mockReset();
    mockLogPortalAdminMutation.mockReset();
    mockRequirePortalAdminToken.mockClear();
    mockRequirePortalAdminToken.mockImplementation((_req: any, _res: any, next: () => void) => next());
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
      'GET /api/operator-alerts',
      'POST /api/operator-alerts/:id/ack',
      'POST /api/operator-alerts/:id/resolve',
      'POST /api/operator-alerts/:id/retry-delivery',
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

  it('passes optional user and tenant scope into spend-by-provider reads', () => {
    mockGetSpendByProvider.mockReturnValue({ anthropic: 0.1, openai: 0, gemini: 0 });

    const res = invoke('/api/spend-by-provider', {
      req: { query: { userId: '42', tenantId: '42' } },
    });

    expect(res.body).toEqual({ anthropic: 0.1, openai: 0, gemini: 0 });
    expect(mockGetSpendByProvider).toHaveBeenCalledWith(undefined, { userId: 42, tenantId: 42 });
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

  it('returns durable operator alerts with query filters', () => {
    mockListOperatorAlerts.mockReturnValue([
      { id: 7, severity: 'warning', title: 'Integration degraded' },
    ]);
    mockGetOperatorAlertDeliverySummary.mockReturnValue({ pending: 1, delivered: 0, failed: 0, dead_letter: 0, not_configured: 0 });

    const res = invoke('/api/operator-alerts', {
      req: { query: { status: 'all', limit: '10' } },
    });

    expect(mockListOperatorAlerts).toHaveBeenCalledWith({ status: 'all', limit: 10 });
    expect(res.body).toEqual({
      ok: true,
      alerts: [{ id: 7, severity: 'warning', title: 'Integration degraded' }],
      delivery: { pending: 1, delivered: 0, failed: 0, dead_letter: 0, not_configured: 0 },
    });
  });

  it('acknowledges and resolves operator alerts with actor context and admin audit', () => {
    mockAcknowledgeOperatorAlert.mockReturnValueOnce(true);
    mockResolveOperatorAlert.mockReturnValueOnce(true);

    const ackReq = {
      params: { id: '7' },
      portalAuthContext: { actorHint: 'operator@nexushub.me' },
    };
    const ack = invoke('/api/operator-alerts/:id/ack', {
      method: 'POST',
      req: ackReq,
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.body).toEqual({ ok: true });
    expect(mockAcknowledgeOperatorAlert).toHaveBeenCalledWith(7, 'operator@nexushub.me');
    expect(mockLogPortalAdminMutation).toHaveBeenCalledWith(ackReq, 0, 'operator_alert.ack', { alertId: 7 });

    const resolveReq = {
      params: { id: '7' },
      headers: { 'x-portal-actor': 'fallback@nexushub.me' },
    };
    const resolved = invoke('/api/operator-alerts/:id/resolve', {
      method: 'POST',
      req: resolveReq,
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.body).toEqual({ ok: true });
    expect(mockResolveOperatorAlert).toHaveBeenCalledWith(7, 'fallback@nexushub.me');
    expect(mockLogPortalAdminMutation).toHaveBeenCalledWith(resolveReq, 0, 'operator_alert.resolve', { alertId: 7 });
  });

  it('does not write an admin audit entry when the alert mutation is a no-op', () => {
    mockAcknowledgeOperatorAlert.mockReturnValueOnce(false);

    const res = invoke('/api/operator-alerts/:id/ack', {
      method: 'POST',
      req: { params: { id: '7' } },
    });

    expect(res.statusCode).toBe(404);
    expect(mockLogPortalAdminMutation).not.toHaveBeenCalled();
  });

  it('queues operator alert delivery retries and writes an admin audit entry', () => {
    mockRetryOperatorAlertDelivery.mockReturnValueOnce(true);

    const req = { params: { id: '7' } };
    const res = invoke('/api/operator-alerts/:id/retry-delivery', {
      method: 'POST',
      req,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockRetryOperatorAlertDelivery).toHaveBeenCalledWith(7);
    expect(mockLogPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'operator_alert.retry_delivery', { alertId: 7 });
  });

  it('rejects invalid operator alert ids without calling the service', () => {
    const res = invoke('/api/operator-alerts/:id/ack', {
      method: 'POST',
      req: { params: { id: 'nope' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, message: 'Invalid alert id' });
    expect(mockAcknowledgeOperatorAlert).not.toHaveBeenCalled();
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
