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
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/api/secret-guards', () => ({
  recordPortalAuthAudit: vi.fn(),
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
}));

vi.mock('../../src/portal/admin-audit', () => ({
  buildPortalAdminAuditDetails: vi.fn(),
  insertPortalAdminMutationAuditStrict: vi.fn(),
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

function makeDbRecorder(rows: unknown[] = [], currentPlan: Record<string, number> | undefined = {
  local_operations_hourly: 20,
  local_operations_daily: 100,
  longform_scripts_daily: 6,
  ordinary_context_tokens: 8192,
  content_context_tokens: 12288,
  script_segment_output_tokens: 5120,
  local_cloud_fallback_run_usd: 0.15,
  local_cloud_fallback_daily_usd: 0.40,
}) {
  const runs: Array<{ sql: string; args: unknown[] }> = [];
  const all = vi.fn(() => rows);
  const get = vi.fn(() => currentPlan);
  return {
    all,
    get,
    runs,
    db: {
      prepare: vi.fn((sql: string) => ({
        all,
        get,
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
        local_operations_hourly: 0,
        local_operations_daily: 0,
        longform_scripts_daily: 0,
        active_content_jobs: 0,
        ordinary_context_tokens: 0,
        content_context_tokens: 0,
        script_segment_output_tokens: 0,
        local_queue_weight: 0,
        local_cloud_fallback_run_usd: 0,
        local_cloud_fallback_daily_usd: 0,
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
        localOperationsHourly: 0,
        localOperationsDaily: 0,
        longformScriptsDaily: 0,
        activeContentJobs: 0,
        ordinaryContextTokens: 0,
        contentContextTokens: 0,
        scriptSegmentOutputTokens: 0,
        localQueueWeight: 0,
        localCloudFallbackRunUsd: 0,
        localCloudFallbackDailyUsd: 0,
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

  it('rejects out-of-envelope local-model plan limits before mutating state', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler({
      params: { planId: 'max' },
      body: { dailyCostUsd: 0.06, contentContextTokens: 32_768 },
    }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({
      ok: false,
      message: 'contentContextTokens must be an integer from 0 to 16384',
    });
    expect(recorder.runs).toEqual([]);
  });

  it('rejects invalid local-to-cloud fallback ceilings before mutating state', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler({
      params: { planId: 'pro' },
      body: { dailyCostUsd: 0.04, localCloudFallbackDailyUsd: -0.01 },
    }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({
      ok: false,
      message: 'localCloudFallbackDailyUsd must be from 0 to 1000',
    });
    expect(recorder.runs).toEqual([]);
  });

  it('rejects incoherent local limits, including partial updates against durable values', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const first = makeResponse();

    handler({
      params: { planId: 'pro' },
      body: { dailyCostUsd: 0.04, localOperationsHourly: 101 },
    }, first.res);

    expect(first.payload.statusCode).toBe(400);
    expect(first.payload.body).toEqual({
      ok: false,
      message: 'localOperationsHourly cannot exceed localOperationsDaily',
    });
    expect(recorder.runs).toEqual([]);

    const second = makeResponse();
    handler({
      params: { planId: 'pro' },
      body: { dailyCostUsd: 0.04, localCloudFallbackRunUsd: 0.41 },
    }, second.res);
    expect(second.payload.statusCode).toBe(400);
    expect(second.payload.body).toEqual({
      ok: false,
      message: 'localCloudFallbackRunUsd cannot exceed localCloudFallbackDailyUsd',
    });
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
        localOperationsHourly: 40,
        localOperationsDaily: 200,
        longformScriptsDaily: 20,
        activeContentJobs: 2,
        ordinaryContextTokens: 12_288,
        contentContextTokens: 16_384,
        scriptSegmentOutputTokens: 6_144,
        localQueueWeight: 2,
        localCloudFallbackRunUsd: 0.25,
        localCloudFallbackDailyUsd: 0.60,
      },
    };
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(recorder.runs).toEqual([{
      sql: "UPDATE plan_configs SET daily_cost_usd = ?, monthly_cost_usd = ?, daily_token_limit = ?, daily_message_limit = ?, allowed_skills_json = ?, local_operations_hourly = ?, local_operations_daily = ?, longform_scripts_daily = ?, active_content_jobs = ?, ordinary_context_tokens = ?, content_context_tokens = ?, script_segment_output_tokens = ?, local_queue_weight = ?, local_cloud_fallback_run_usd = ?, local_cloud_fallback_daily_usd = ?, updated_at = datetime('now') WHERE plan_id = ?",
      args: [
        0.75, 1.8, 1000, 50, JSON.stringify(['secretary', 'training']),
        40, 200, 20, 2, 12_288, 16_384, 6_144, 2, 0.25, 0.60, 'max',
      ],
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
      localOperationsHourly: 40,
      localOperationsDaily: 200,
      longformScriptsDaily: 20,
      activeContentJobs: 2,
      ordinaryContextTokens: 12_288,
      contentContextTokens: 16_384,
      scriptSegmentOutputTokens: 6_144,
      localQueueWeight: 2,
      localCloudFallbackRunUsd: 0.25,
      localCloudFallbackDailyUsd: 0.60,
    });
    expect(payload.body).toEqual({ ok: true });
  });

  it('preserves existing token and message limits when optional fields are omitted', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalPlanRoutes(app as any);
    const handler = routes.get('PUT /api/plans/:planId')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { planId: 'pro' }, body: { dailyCostUsd: 0.2 } }, res);

    expect(recorder.runs[0]).toEqual({
      sql: "UPDATE plan_configs SET daily_cost_usd = ?, updated_at = datetime('now') WHERE plan_id = ?",
      args: [0.2, 'pro'],
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
