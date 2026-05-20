import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const targetUserGuard = ((_req: unknown, _res: unknown, next: () => void) => next()) as unknown as ReturnType<typeof vi.fn>;
  return {
    getDb: vi.fn(),
    listUsers: vi.fn(),
    setUserStatusById: vi.fn(),
    requirePortalAdminToken: vi.fn(),
    logPortalAdminMutation: vi.fn(),
    sendPortalInternalError: vi.fn(),
    setUserAiBudgetOverride: vi.fn(),
    clearUserAiBudgetOverride: vi.fn(),
    createNexusPointsCheckoutSession: vi.fn(),
    isStripeNexusPointsConfigured: vi.fn(() => true),
    listNexusPointPackages: vi.fn(),
    isNexusPointProductId: vi.fn((value: string) => value.startsWith('me.nexushub.points.')),
    targetUserGuard,
    requireOperatorTargetUser: vi.fn(() => targetUserGuard),
  };
});

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => hoisted.getDb(...args),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/user-service', () => ({
  listUsers: (...args: unknown[]) => hoisted.listUsers(...args),
  setUserStatusById: (...args: unknown[]) => hoisted.setUserStatusById(...args),
}));

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
  getPortalAuthContext: vi.fn(() => ({ actorHint: 'felipe', matchedCredential: 'admin' })),
}));

vi.mock('../../src/portal/admin-audit', () => ({
  logPortalAdminMutation: (...args: unknown[]) => hoisted.logPortalAdminMutation(...args),
}));

vi.mock('../../src/portal/admin-target-user', () => ({
  requireOperatorTargetUser: (...args: unknown[]) => hoisted.requireOperatorTargetUser(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => hoisted.sendPortalInternalError(...args),
}));

vi.mock('../../src/services/ai-budget-overrides', () => ({
  setUserAiBudgetOverride: (...args: unknown[]) => hoisted.setUserAiBudgetOverride(...args),
  clearUserAiBudgetOverride: (...args: unknown[]) => hoisted.clearUserAiBudgetOverride(...args),
}));

vi.mock('../../src/services/stripe-nexus-points-service', () => ({
  createNexusPointsCheckoutSession: (...args: unknown[]) => hoisted.createNexusPointsCheckoutSession(...args),
  isStripeNexusPointsConfigured: () => hoisted.isStripeNexusPointsConfigured(),
}));

vi.mock('../../src/services/nexus-points', () => ({
  listNexusPointPackages: () => hoisted.listNexusPointPackages(),
  isNexusPointProductId: (value: string) => hoisted.isNexusPointProductId(value),
}));

import { registerPortalUserRoutes } from '../../src/portal/user-routes';

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

function makeDbRecorder() {
  const runs: Array<{ sql: string; args: unknown[] }> = [];
  return {
    runs,
    db: {
      prepare: vi.fn((sql: string) => ({
        run: vi.fn((...args: unknown[]) => {
          runs.push({ sql, args });
        }),
      })),
    },
  };
}

describe('portal user routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.listUsers.mockReturnValue([{ id: 4, email: 'user@example.com', tier: 'pro' }]);
    hoisted.listNexusPointPackages.mockReturnValue([
      { productId: 'me.nexushub.points.small', label: 'small', priceUsd: 5, points: 300, usdAllowance: 0.30 },
    ]);
    hoisted.createNexusPointsCheckoutSession.mockResolvedValue({
      sessionId: 'cs_portal_points',
      checkoutUrl: 'https://checkout.stripe.test/portal-points',
    });
    hoisted.isStripeNexusPointsConfigured.mockReturnValue(true);
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
  });

  it('registers user routes and protects mutations with the admin token + operator target-user guards', () => {
    const { app, routes } = makeApp();

    registerPortalUserRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/users', expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/users/:userId/suspend', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/users/:userId/activate', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function));
    expect(app.put).toHaveBeenCalledWith('/api/users/:userId/tier', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function), expect.any(Function));
    expect(app.put).toHaveBeenCalledWith('/api/users/:userId/limits', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function), expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/billing/nexus-points/packages', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/users/:userId/billing/nexus-points/stripe-checkout', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function), expect.any(Function));
    expect(routes.get('POST /api/users/:userId/suspend')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('POST /api/users/:userId/suspend')?.[1]).toBe(hoisted.targetUserGuard);
    expect(routes.get('POST /api/users/:userId/activate')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('PUT /api/users/:userId/tier')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('PUT /api/users/:userId/limits')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('POST /api/users/:userId/billing/nexus-points/stripe-checkout')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('POST /api/users/:userId/billing/nexus-points/stripe-checkout')?.[1]).toBe(hoisted.targetUserGuard);
    expect(hoisted.requireOperatorTargetUser).toHaveBeenCalledWith('userId');
  });

  it('lists Nexus Points packages for portal admins', () => {
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('GET /api/billing/nexus-points/packages')?.[1]!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(payload.body).toMatchObject({
      ok: true,
      stripeEnabled: true,
      packages: [expect.objectContaining({ productId: 'me.nexushub.points.small' })],
    });
  });

  it('creates portal Stripe Nexus Points checkout only with a required note', async () => {
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('POST /api/users/:userId/billing/nexus-points/stripe-checkout')?.[3]!;
    const { payload, res } = makeResponse();

    await handler({
      params: { userId: '42' },
      body: { packageId: 'me.nexushub.points.small', note: 'beta support top-up' },
    }, res);

    expect(payload.body).toEqual({
      ok: true,
      sessionId: 'cs_portal_points',
      checkoutUrl: 'https://checkout.stripe.test/portal-points',
    });
    expect(hoisted.createNexusPointsCheckoutSession).toHaveBeenCalledWith({
      userId: 42,
      tenantId: 42,
      packageId: 'me.nexushub.points.small',
      source: 'portal',
      note: 'beta support top-up',
      actor: 'felipe',
    });
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(
      expect.anything(),
      42,
      'billing.nexus_points.stripe_checkout',
      expect.objectContaining({ packageId: 'me.nexushub.points.small', note: 'beta support top-up' }),
    );
  });

  it('caps and sanitizes portal Stripe Nexus Points checkout notes before persistence/metadata', async () => {
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('POST /api/users/:userId/billing/nexus-points/stripe-checkout')?.[3]!;
    const { res } = makeResponse();
    const dirtyNote = `beta\u0000 ${'x'.repeat(400)}`;

    await handler({
      params: { userId: '42' },
      body: { packageId: 'me.nexushub.points.small', note: dirtyNote },
    }, res);

    const expectedNote = `beta ${'x'.repeat(400)}`.slice(0, 280);
    expect(hoisted.createNexusPointsCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      note: expectedNote,
    }));
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(
      expect.anything(),
      42,
      'billing.nexus_points.stripe_checkout',
      expect.objectContaining({ note: expectedNote }),
    );
  });

  it('rejects portal Stripe Nexus Points checkout without a note', async () => {
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('POST /api/users/:userId/billing/nexus-points/stripe-checkout')?.[3]!;
    const { payload, res } = makeResponse();

    await handler({
      params: { userId: '42' },
      body: { packageId: 'me.nexushub.points.small', note: '' },
    }, res);

    expect(payload.statusCode).toBe(400);
    expect(hoisted.createNexusPointsCheckoutSession).not.toHaveBeenCalled();
  });

  it('lists safe portal users', () => {
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('GET /api/users')?.[0]!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(hoisted.listUsers).toHaveBeenCalledTimes(1);
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ users: [{ id: 4, email: 'user@example.com', tier: 'pro' }] });
  });

  it('uses the shared internal-error helper when user listing fails', () => {
    hoisted.listUsers.mockImplementation(() => {
      throw new Error('raw users db path /private/users.sqlite');
    });
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('GET /api/users')?.[0]!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Portal request failed',
      'Portal: request failed',
    );
  });

  it('rejects invalid user ids before status mutations', () => {
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('POST /api/users/:userId/suspend')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '0' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'invalid userId' });
    expect(hoisted.setUserStatusById).not.toHaveBeenCalled();
    expect(hoisted.logPortalAdminMutation).not.toHaveBeenCalled();
  });

  it('suspends users and records an admin audit event', () => {
    const req = { params: { userId: '42' } };
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('POST /api/users/:userId/suspend')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.setUserStatusById).toHaveBeenCalledWith(42, 'suspended');
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 42, 'user.status', {
      status: 'suspended',
    });
    expect(payload.body).toEqual({ ok: true, message: 'User suspended' });
  });

  it('activates users and records an admin audit event', () => {
    const req = { params: { userId: '42' } };
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('POST /api/users/:userId/activate')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.setUserStatusById).toHaveBeenCalledWith(42, 'active');
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 42, 'user.status', {
      status: 'active',
    });
    expect(payload.body).toEqual({ ok: true, message: 'User activated' });
  });

  it('normalizes and persists valid user tiers', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const req = { params: { userId: '7' }, body: { tier: 'MAX' } };
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('PUT /api/users/:userId/tier')?.[3]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(recorder.runs).toEqual([{
      sql: 'UPDATE users SET tier = ? WHERE id = ?',
      args: ['max', 7],
    }]);
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 7, 'user.tier', { tier: 'max' });
    expect(payload.body).toEqual({ ok: true, message: 'Tier set to max' });
  });

  it('rejects invalid user tiers before database writes', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('PUT /api/users/:userId/tier')?.[3]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '7' }, body: { tier: 'enterprise' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'tier must be free, pro, max, or owner' });
    expect(recorder.runs).toEqual([]);
  });

  it('persists only valid non-negative user limits and audits the normalized payload', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const req = {
      params: { userId: '9' },
      body: {
        daily_message_limit: '20',
        daily_token_limit: -1,
        daily_cost_limit_usd: 0.25,
      },
    };
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('PUT /api/users/:userId/limits')?.[3]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(recorder.runs).toEqual([
      {
        sql: 'UPDATE users SET daily_message_limit = ? WHERE id = ?',
        args: [20, 9],
      },
      {
        sql: 'UPDATE users SET daily_cost_limit_usd = ? WHERE id = ?',
        args: [0.25, 9],
      },
    ]);
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 9, 'user.limits', {
      daily_message_limit: 20,
      daily_token_limit: undefined,
      daily_cost_limit_usd: 0.25,
    });
    expect(payload.body).toEqual({ ok: true, message: 'Limits updated' });
  });

  it('sets and clears per-user AI budget overrides independently of legacy token limits', () => {
    const recorder = makeDbRecorder();
    hoisted.getDb.mockReturnValue(recorder.db);
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('PUT /api/users/:userId/limits')?.[3]!;
    const { payload, res } = makeResponse();

    handler({
      params: { userId: '12' },
      body: {
        daily_ai_cost_limit_usd: '0.09',
        daily_ai_cost_limit_expires_at: '2026-06-20T00:00:00.000Z',
        daily_ai_cost_limit_reason: 'support adjustment',
      },
    }, res);

    expect(hoisted.setUserAiBudgetOverride).toHaveBeenCalledWith({
      userId: 12,
      dailyCostUsd: 0.09,
      expiresAt: '2026-06-20T00:00:00.000Z',
      reason: 'support adjustment',
      updatedBy: 0,
    });
    expect(payload.body).toEqual({ ok: true, message: 'Limits updated' });

    const clear = makeResponse();
    handler({ params: { userId: '12' }, body: { daily_ai_cost_limit_usd: null } }, clear.res);
    expect(hoisted.clearUserAiBudgetOverride).toHaveBeenCalledWith(12, 0);
  });

  it('uses the shared internal-error helper when tier updates fail', () => {
    hoisted.getDb.mockImplementation(() => {
      throw new Error('raw tier update failure');
    });
    const { app, routes } = makeApp();
    registerPortalUserRoutes(app as any);
    const handler = routes.get('PUT /api/users/:userId/tier')?.[3]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '7' }, body: { tier: 'pro' } }, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Failed to update user tier',
      'Portal: user tier update failed',
    );
  });
});
