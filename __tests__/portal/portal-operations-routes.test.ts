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
const mockGetTrainingGenerationObservabilitySnapshot = vi.fn();
const mockGetTrainingCoachV2SoakSnapshot = vi.fn();
const mockRecordTrainingCoachV2RuleReview = vi.fn();
const mockGetContentWorkspaceObservabilitySnapshot = vi.fn();
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

vi.mock('../../src/services/training-generation-observability', () => ({
  getTrainingGenerationObservabilitySnapshot: (...args: unknown[]) =>
    mockGetTrainingGenerationObservabilitySnapshot(...args),
}));

vi.mock('../../src/services/training-coach-v2-soak-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/training-coach-v2-soak-metrics')>();
  return {
    ...actual,
    getTrainingCoachV2SoakSnapshot: (...args: unknown[]) => mockGetTrainingCoachV2SoakSnapshot(...args),
    recordTrainingCoachV2RuleReview: (...args: unknown[]) => mockRecordTrainingCoachV2RuleReview(...args),
  };
});

vi.mock('../../src/services/content-workspace-observability', () => ({
  getContentWorkspaceObservabilitySnapshot: (...args: unknown[]) =>
    mockGetContentWorkspaceObservabilitySnapshot(...args),
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
  recordPortalAuthAudit: vi.fn(),
  extractPortalActorHint: (req: any) => req.headers?.['x-portal-actor'],
  getPortalAuthContext: (req: any) => req.portalAuthContext,
  requirePortalAdminToken: hoistedOps.mockRequirePortalAdminToken,
}));

vi.mock('../../src/portal/admin-audit', () => ({
  buildPortalAdminAuditDetails: vi.fn(),
  insertPortalAdminMutationAuditStrict: vi.fn(),
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

type Handler = (req: any, res: any, next?: (err?: unknown) => void) => unknown;

interface CapturedRoute {
  method: 'GET' | 'POST';
  path: string;
  handler: Handler;
  handlers: Handler[];
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const app = {
    get(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'GET', path, handler: handlers[handlers.length - 1], handlers });
    },
    post(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'POST', path, handler: handlers[handlers.length - 1], handlers });
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
    mockGetTrainingGenerationObservabilitySnapshot.mockReset();
    mockGetTrainingCoachV2SoakSnapshot.mockReset();
    mockRecordTrainingCoachV2RuleReview.mockReset();
    mockGetContentWorkspaceObservabilitySnapshot.mockReset();
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
      'GET /api/secretary-metrics',
      'GET /api/quality-scores',
      'GET /api/training-coach-v2-soak',
      'POST /api/training-coach-v2-soak/reviews',
      'GET /api/content-workspace-metrics',
      'GET /api/operator-alerts',
      'POST /api/operator-alerts/:id/ack',
      'POST /api/operator-alerts/:id/resolve',
      'POST /api/operator-alerts/:id/retry-delivery',
    ]);
  });

  it('rate limits both Coach V2 soak routes before admin authorization', async () => {
    const previousLimit = process.env.PORTAL_API_RATE_LIMIT;
    process.env.PORTAL_API_RATE_LIMIT = '2';
    try {
      const routes = captureRoutes();
      const soakRoutes = routes.filter((route) => route.path.startsWith('/api/training-coach-v2-soak'));
      expect(soakRoutes).toHaveLength(2);
      for (const route of soakRoutes) {
        expect(route.handlers).toHaveLength(3);
        expect(route.handlers[1]).toBe(mockRequirePortalAdminToken);
      }

      const limiter = soakRoutes[0]!.handlers[0]!;
      const buildResponse = () => ({
        statusCode: 200,
        body: undefined as unknown,
        headers: {} as Record<string, string | number>,
        setHeader(name: string, value: string | number) {
          this.headers[name] = value;
          return this;
        },
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(body: unknown) {
          this.body = body;
          return this;
        },
      });
      const request = {
        headers: {},
        ip: '198.51.100.42',
        socket: { remoteAddress: '198.51.100.42' },
      };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const next = vi.fn();
        await limiter(request, buildResponse(), next);
        expect(next).toHaveBeenCalledOnce();
      }
      const blocked = buildResponse();
      const blockedNext = vi.fn();
      await limiter(request, blocked, blockedNext);
      expect(blockedNext).not.toHaveBeenCalled();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.body).toMatchObject({ error: { code: 'RATE_LIMITED', retryAfter: 60 } });
      expect(blocked.headers['Retry-After']).toBe(60);
      expect(mockRequirePortalAdminToken).not.toHaveBeenCalled();
    } finally {
      if (previousLimit === undefined) delete process.env.PORTAL_API_RATE_LIMIT;
      else process.env.PORTAL_API_RATE_LIMIT = previousLimit;
    }
  });

  it('returns aggregate Coach V2 soak gates and records scoped reviewed firings', () => {
    const snapshot = {
      schemaVersion: 'training-coach-v2-soak.1',
      generatedAt: '2026-08-31T12:00:00.000Z',
      window: { from: '2026-08-17T12:00:00.000Z', to: '2026-08-31T12:00:00.000Z' },
      rules: [{ ruleId: 'deload_applied', reviewedFirings: 100, incorrectReviewedFirings: 4, falsePositiveRate: 0.04, verdict: 'GO' }],
      churn: { adaptedPlanWeeks: 100, churnedPlanWeeks: 20, churnRate: 0.2, verdict: 'GO' },
      verdict: 'GO',
    };
    mockGetTrainingCoachV2SoakSnapshot.mockReturnValue(snapshot);
    expect(invoke('/api/training-coach-v2-soak', {
      req: { query: { from: '2026-08-17T12:00:00.000Z', to: '2026-08-31T12:00:00.000Z' } },
    }).body).toEqual({ ok: true, coachV2Soak: snapshot });

    mockRecordTrainingCoachV2RuleReview.mockReturnValue({ replayed: false });
    const req = {
      body: {
        tenantId: 44,
        userId: 44,
        proposalId: 'tcv2_reviewed',
        ruleId: 'deload_applied',
        outcome: 'incorrect',
        idempotencyKey: 'review-1',
      },
    };
    const response = invoke('/api/training-coach-v2-soak/reviews', { method: 'POST', req });
    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual({ ok: true, replayed: false });
    expect(mockRecordTrainingCoachV2RuleReview).toHaveBeenCalledWith(req.body);
    expect(mockLogPortalAdminMutation).toHaveBeenCalledWith(
      req,
      44,
      'training_coach_v2.rule_review',
      expect.objectContaining({ ruleId: 'deload_applied', outcome: 'incorrect' }),
    );
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

  it('returns quality score snapshots', () => {
    mockGetQualityByAgent.mockReturnValue([{ agent: 'secretary', avgScore: 0.91 }]);
    expect(invoke('/api/quality-scores').body).toEqual({
      ok: true,
      byAgent: [{ agent: 'secretary', avgScore: 0.91 }],
    });
  });

  it('returns only aggregate content-workspace metrics through the admin-protected route', () => {
    const snapshot = {
      reliability: {
        workspace_operation_success_total: 12,
        workspace_operation_failure_total: 1,
        generation_success_total: 4,
        generation_failure_total: 1,
        schedule_confirm_success_total: 2,
        schedule_confirm_failure_total: 0,
      },
      operations: {
        schedule_confirm: {
          attempts: 2,
          successes: 2,
          failures: 0,
          duration_ms: { count: 2, sum: 40, min: 15, max: 25 },
        },
      },
      reasons: { CONTENT_SCHEDULE_STALE: 1 },
      product: {
        idea_captured_total: 3,
        internal_scheduled_state_or_confirmed_work_block: 2,
      },
      publicationTracking: {
        status: 'unavailable',
        publicationEvidence: false,
        reasonCode: 'EXTERNAL_PUBLICATION_RECEIPTS_UNAVAILABLE',
        internalWorkflowStateMetric: 'internal_workflow_published_state',
      },
      quality: {
        generated_total: 5,
        blocked_total: 1,
        warnings_total: 2,
      },
      storage: {
        mode: 'durable',
        durableStore: 'sqlite_aggregate',
        durableAvailable: true,
        includesHistoricalTotals: true,
        pendingWrite: false,
        bestEffortWrites: true,
        userOperationFailurePropagation: false,
      },
    };
    mockGetContentWorkspaceObservabilitySnapshot.mockReturnValue(snapshot);

    const res = invoke('/api/content-workspace-metrics');

    expect(res.body).toEqual({ ok: true, contentWorkspace: snapshot });
    expect(mockGetContentWorkspaceObservabilitySnapshot).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/prompt|rawContent|sourceUrl|userId|tenantId|providerResponse/i);
  });

  it('sanitizes content-workspace metric failures', () => {
    const error = new Error('raw durable metric database failure');
    mockGetContentWorkspaceObservabilitySnapshot.mockImplementation(() => {
      throw error;
    });

    const res = invoke('/api/content-workspace-metrics');

    expect(mockSendPortalInternalError).toHaveBeenCalledWith(
      res,
      error,
      'Content workspace metrics unavailable',
      'Portal: content workspace metrics failed',
    );
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
