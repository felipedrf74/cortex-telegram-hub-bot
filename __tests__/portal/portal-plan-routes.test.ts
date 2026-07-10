import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getDb: vi.fn(),
  requirePortalAdminToken: vi.fn(),
  logPortalAdminMutation: vi.fn(),
  sendPortalInternalError: vi.fn(),
  setPlanAllowedSkillsOverride: vi.fn(),
  setPlanDailyCostCapOverride: vi.fn(),
  setPlanMonthlyCostCapOverride: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => hoisted.getDb(...args),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
}));

vi.mock('../../src/portal/admin-audit', () => ({
  buildPortalAdminAuditDetails: vi.fn(),
  logPortalAdminMutation: (...args: unknown[]) => hoisted.logPortalAdminMutation(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => hoisted.sendPortalInternalError(...args),
}));

vi.mock('../../src/services/plan-quotas', () => ({
  setPlanAllowedSkillsOverride: (...args: unknown[]) => hoisted.setPlanAllowedSkillsOverride(...args),
  setPlanDailyCostCapOverride: (...args: unknown[]) => hoisted.setPlanDailyCostCapOverride(...args),
  setPlanMonthlyCostCapOverride: (...args: unknown[]) => hoisted.setPlanMonthlyCostCapOverride(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => hoisted.loggerWarn(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerPortalPlanRoutes } from '../../src/portal/plan-routes';

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  return {
    routes,
    app: {
      get: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`GET ${route}`, handlers);
      }),
      put: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`PUT ${route}`, handlers);
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

function makeDbRecorder(rows: unknown[] = []) {
  const runs: Array<{ sql: string; args: unknown[] }> = [];
  const all = vi.fn(() => rows);
  return {
    all,
    runs,
    db: {
      prepare: vi.fn((sql: string) => ({
        all,
        run: vi.fn((...args: unknown[]) => {
          runs.push({ sql, args });
        }),
      })),
    },
  };
}

describe('portal plan routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.setPlanAllowedSkillsOverride.mockImplementation(() => undefined);
    hoisted.setPlanDailyCostCapOverride.mockImplementation(() => undefined);
    hoisted.setPlanMonthlyCostCapOverride.mockImplementation(() => undefined);
    hoisted.getDb.mockReturnValue(makeDbRecorder().db);
  });

  it('registers plan routes and protects them with the admin token guard', () => {
    const { app, routes } = makeApp();

    registerPortalPlanRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/plans', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(app.put).toHaveBeenCalledWith('/api/plans/:planId', hoisted.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(routes.get('GET /api/plans')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('PUT /api/plans/:planId')?.[0]).toBe(hoisted.requirePortalAdminToken);
  });

  it('lists plan configuration as a render-ready portal contract', () => {
    const recorder = makeDbRecorder([
      {
        plan_id: 'free',
        display_name: 'Free',
        // A stale pre-migration row must still render the paid-only invariant.
        daily_cost_usd: 0.5,
        monthly_cost_usd: 5,
        daily_token_limit: null,
        daily_message_limit: 20,
        allowed_skills_json: '["secretary"]',
        per_skill_caps_json: '{"secretary":1}',
        metadata_json: '{"badge":"starter"}',
        active: 1,
        updated_at: '2026-04-21T00:00:00.000Z',
      },
    ]);
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('GET /api/plans')?.[1]!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({
      plans: [{
        planId: 'free',
        displayName: 'Free',
        dailyCostUsd: 0,
        monthlyCostUsd: 0,
        dailyTokenLimit: null,
        dailyMessageLimit: 20,
        allowedSkills: ['secretary'],
        perSkillCaps: { secretary: 1 },
        metadata: { badge: 'starter' },
        active: true,
        updatedAt: '2026-04-21T00:00:00.000Z',
      }],
    });
  });

  it('uses the shared internal-error helper when plan listing fails', () => {
    hoisted.getDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => {
          throw new Error('raw plan db path /private/plans.sqlite');
        }),
      })),
    });
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('GET /api/plans')?.[1]!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Failed to load plan configuration',
      'Portal: list plans failed',
    );
  });

  it('rejects invalid plan ids before mutating state', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { planId: 'enterprise' }, body: { dailyCostUsd: 1 } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'planId must be free, pro, max, or owner' });
    expect(recorder.runs).toEqual([]);
    expect(hoisted.logPortalAdminMutation).not.toHaveBeenCalled();
  });

  it('rejects invalid plan limits before mutating state', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { planId: 'pro' }, body: { dailyCostUsd: 0.04, dailyTokenLimit: -1 } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'dailyTokenLimit must be null or a non-negative number' });
    expect(recorder.runs).toEqual([]);
    expect(hoisted.setPlanDailyCostCapOverride).not.toHaveBeenCalled();
  });

  it('rejects an invalid monthly cost cap before mutating state', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { planId: 'pro' }, body: { dailyCostUsd: 0.04, monthlyCostUsd: -1 } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'monthlyCostUsd must be a non-negative number' });
    expect(recorder.runs).toEqual([]);
  });

  it('keeps the Free model-backed budget fixed at zero', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler({
      params: { planId: 'free' },
      body: { dailyCostUsd: 0.001, monthlyCostUsd: 0.03 },
    }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({
      ok: false,
      message: 'Free model-backed daily and monthly limits must remain zero',
    });
    expect(recorder.runs).toEqual([]);
    expect(hoisted.setPlanDailyCostCapOverride).not.toHaveBeenCalled();
  });

  it('updates plan config, applies runtime overrides, and records an admin audit event', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const req = {
      params: { planId: 'MAX' },
      body: {
        dailyCostUsd: '0.75',
        monthlyCostUsd: '1.80',
        dailyTokenLimit: 1000,
        dailyMessageLimit: 50,
        allowedSkills: ['secretary', 'training', 12],
      },
    };
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(recorder.runs).toEqual([{
      sql: "UPDATE plan_configs SET daily_cost_usd = ?, monthly_cost_usd = ?, daily_token_limit = ?, daily_message_limit = ?, allowed_skills_json = ?, updated_at = datetime('now') WHERE plan_id = ?",
      args: [0.75, 1.8, 1000, 50, JSON.stringify(['secretary', 'training']), 'max'],
    }]);
    expect(hoisted.setPlanDailyCostCapOverride).toHaveBeenCalledWith('max', 0.75);
    expect(hoisted.setPlanMonthlyCostCapOverride).toHaveBeenCalledWith('max', 1.8);
    expect(hoisted.setPlanAllowedSkillsOverride).toHaveBeenCalledWith('max', ['secretary', 'training']);
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'plan_config.update', {
      planId: 'max',
      dailyCostUsd: 0.75,
      monthlyCostUsd: 1.8,
      dailyTokenLimit: 1000,
      dailyMessageLimit: 50,
      allowedSkills: ['secretary', 'training'],
    });
    expect(payload.body).toEqual({ ok: true });
  });

  it('preserves legacy null-limit update behavior when optional limits are omitted', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { planId: 'pro' }, body: { dailyCostUsd: 0.2 } }, res);

    expect(recorder.runs[0]).toEqual({
      sql: "UPDATE plan_configs SET daily_cost_usd = ?, daily_token_limit = ?, daily_message_limit = ?, updated_at = datetime('now') WHERE plan_id = ?",
      args: [0.2, null, null, 'pro'],
    });
    expect(hoisted.setPlanMonthlyCostCapOverride).not.toHaveBeenCalled();
    expect(payload.body).toEqual({ ok: true });
  });

  it('does not fail the update response when runtime override application warns', () => {
    hoisted.setPlanDailyCostCapOverride.mockImplementation(() => {
      throw new Error('override registry unavailable');
    });
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { planId: 'pro' }, body: { dailyCostUsd: 0.04 } }, res);

    expect(payload.body).toEqual({ ok: true });
    expect(hoisted.loggerWarn).toHaveBeenCalledWith(expect.objectContaining({
      err: expect.any(Error),
      planId: 'pro',
    }), 'plan-quotas override apply failed');
  });

  it('uses the shared internal-error helper when plan updates fail', () => {
    hoisted.getDb.mockReturnValue({
      prepare: vi.fn(() => ({
        run: vi.fn(() => {
          throw new Error('raw plan update failure');
        }),
      })),
    });
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { planId: 'pro' }, body: { dailyCostUsd: 0.04 } }, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Failed to update plan configuration',
      'Portal: update plan failed',
    );
  });
});
