import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePortalAdminToken: vi.fn(),
  requireOperatorTargetUser: vi.fn(),
  getDecisionSummary: vi.fn(),
  listDecisionItems: vi.fn(),
  getDecisionItem: vi.fn(),
  performDecisionAction: vi.fn(),
  logPortalAdminMutation: vi.fn(),
}));

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: mocks.requirePortalAdminToken,
}));

vi.mock('../../src/portal/admin-target-user', () => ({
  requireOperatorTargetUser: (...args: unknown[]) => mocks.requireOperatorTargetUser(...args),
}));

vi.mock('../../src/portal/admin-audit', () => ({
  logPortalAdminMutation: (...args: unknown[]) => mocks.logPortalAdminMutation(...args),
}));

vi.mock('../../src/services/decision-center', () => ({
  DecisionActionError: class DecisionActionError extends Error {
    code: string;
    status: number;
    details?: Record<string, unknown>;
    constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.status = status;
      this.details = details;
    }
  },
  getDecisionSummary: (...args: unknown[]) => mocks.getDecisionSummary(...args),
  listDecisionItems: (...args: unknown[]) => mocks.listDecisionItems(...args),
  getDecisionItem: (...args: unknown[]) => mocks.getDecisionItem(...args),
  performDecisionAction: (...args: unknown[]) => mocks.performDecisionAction(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerPortalDecisionCenterRoutes } from '../../src/portal/decision-center-routes';

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  return {
    routes,
    app: {
      get: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`GET ${route}`, handlers);
      }),
      post: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`POST ${route}`, handlers);
      }),
    },
  };
}

function makeResponse() {
  const payload = {
    statusCode: 200,
    body: undefined as unknown,
  };
  const res: any = {
    status: vi.fn((code: number) => {
      payload.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      payload.body = body;
      return res;
    }),
  };
  return { payload, res };
}

function sampleDecision(overrides: Record<string, unknown> = {}) {
  return {
    decisionId: 'nc_1',
    userId: 7,
    tenantId: 7,
    sourceSkill: 'finance',
    type: 'decision_required',
    status: 'unread',
    urgency: 'today',
    priorityScore: 90,
    title: 'Pay $4,200 to Therapy Center',
    summary: 'Sensitive body',
    safePreviewTitle: 'Finance decision',
    safePreviewBody: 'Open Nexus to review this decision.',
    recommendedActionLabel: 'Mark paid',
    whySummary: 'A timely choice is needed.',
    whyDetails: [{ label: 'Privacy', value: 'Safe preview only.' }],
    deadlineAt: null,
    expiresAt: null,
    privacyClassification: 'financial',
    visibilityScope: 'user_private',
    createdAt: '2026-05-10T10:00:00.000Z',
    updatedAt: '2026-05-10T10:00:00.000Z',
    actions: [{ id: 'mark_paid', label: 'Mark paid', style: 'primary', destructive: false }],
    ...overrides,
  };
}

describe('portal Decision Center routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOperatorTargetUser.mockReturnValue(vi.fn());
    mocks.getDecisionSummary.mockReturnValue({
      openCount: 1,
      urgentCount: 0,
      todayCount: 1,
      topDecisionTitle: 'Finance decision',
      topDecisionSourceSkill: 'finance',
      topDecisionUrgency: 'today',
      ctaLabel: '1 Decision',
      badgeCount: 1,
      previewItems: [sampleDecision()],
    });
    mocks.listDecisionItems.mockReturnValue([sampleDecision()]);
    mocks.getDecisionItem.mockReturnValue(sampleDecision());
    mocks.performDecisionAction.mockResolvedValue({
      actionId: 'mark_paid',
      status: 'succeeded',
      idempotent: false,
      item: sampleDecision({ status: 'actioned' }),
      verification: { readBackOk: true, expectedEffect: {}, actualEffect: {}, message: 'ok' },
    });
  });

  it('registers per-user routes behind portal admin and operator target guards', () => {
    const { app, routes } = makeApp();
    registerPortalDecisionCenterRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/users/:userId/decision-center/summary', mocks.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(routes.get('GET /api/users/:userId/decision-center/summary')?.[0]).toBe(mocks.requirePortalAdminToken);
    expect(mocks.requireOperatorTargetUser).toHaveBeenCalledWith('userId');
  });

  it('returns safe preview copy instead of raw private decision text', () => {
    const { app, routes } = makeApp();
    registerPortalDecisionCenterRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/decision-center/decisions')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '7' }, query: {} }, res);

    expect(payload.statusCode).toBe(200);
    expect((payload.body as any).items[0].title).toBe('Finance decision');
    expect(JSON.stringify(payload.body)).not.toContain('Therapy Center');
    expect(JSON.stringify(payload.body)).not.toContain('$4,200');
  });

  it('fails closed for cross-tenant portal reads until explicit tenant membership exists', () => {
    const { app, routes } = makeApp();
    registerPortalDecisionCenterRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/decision-center/summary')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '7' }, query: { tenantId: '99' } }, res);

    expect(payload.statusCode).toBe(403);
    expect((payload.body as any).error.code).toBe('FORBIDDEN_TENANT_SCOPE');
    expect(mocks.getDecisionSummary).not.toHaveBeenCalled();
  });

  it('routes portal actions through the canonical Decision Center executor and audits the mutation', async () => {
    const { app, routes } = makeApp();
    registerPortalDecisionCenterRoutes(app as any);
    const handler = routes.get('POST /api/users/:userId/decision-center/decisions/:decisionId/actions')?.[2]!;
    const { payload, res } = makeResponse();

    handler({
      params: { userId: '7', decisionId: 'nc_1' },
      body: { actionId: 'mark_paid', idempotencyKey: 'portal-tap-1', payload: { month: '2026-05' } },
      query: {},
    }, res);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.performDecisionAction).toHaveBeenCalledWith('nc_1', 'mark_paid', 7, 7, {
      idempotencyKey: 'portal-tap-1',
      payload: { month: '2026-05' },
    });
    expect(mocks.logPortalAdminMutation).toHaveBeenCalledWith(expect.any(Object), 7, 'portal.decision_center.action', expect.objectContaining({
      decisionId: 'nc_1',
      actionId: 'mark_paid',
    }));
    expect(payload.statusCode).toBe(200);
    expect((payload.body as any).item.status).toBe('actioned');
  });
});
