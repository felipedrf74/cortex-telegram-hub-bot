import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  requirePortalAdminToken: vi.fn(),
  handlePortalAction: vi.fn(),
  isPortalActionRateLimited: vi.fn(),
  recordPortalAction: vi.fn(),
  clearPortalSnapshotCache: vi.fn(),
  getOwnerBootstrapTarget: vi.fn(),
  logAudit: vi.fn(),
  buildPortalAdminAuditDetails: vi.fn(),
}));

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
}));

vi.mock('../../src/portal/admin-audit', () => ({
  buildPortalAdminAuditDetails: (...args: unknown[]) => hoisted.buildPortalAdminAuditDetails(...args),
}));

vi.mock('../../src/portal/actions', () => ({
  VALID_PORTAL_ACTIONS: new Set(['clear-history', 'refresh-garmin']),
  handlePortalAction: (...args: unknown[]) => hoisted.handlePortalAction(...args),
  isPortalActionRateLimited: (...args: unknown[]) => hoisted.isPortalActionRateLimited(...args),
  recordPortalAction: (...args: unknown[]) => hoisted.recordPortalAction(...args),
}));

vi.mock('../../src/portal/snapshot-cache', () => ({
  clearPortalSnapshotCache: (...args: unknown[]) => hoisted.clearPortalSnapshotCache(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getOwnerBootstrapTarget: (...args: unknown[]) => hoisted.getOwnerBootstrapTarget(...args),
}));

vi.mock('../../src/services/audit-trail', () => ({
  logAudit: (...args: unknown[]) => hoisted.logAudit(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerPortalActionRoutes } from '../../src/portal/action-routes';

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  return {
    routes,
    app: {
      post: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(route, handlers);
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

describe('portal action routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.isPortalActionRateLimited.mockReturnValue(false);
    hoisted.handlePortalAction.mockResolvedValue({ ok: true, message: 'done' });
    hoisted.getOwnerBootstrapTarget.mockReturnValue({ tenantId: 42, telegramId: 1042 });
    hoisted.buildPortalAdminAuditDetails.mockReturnValue({
      portalCredential: 'admin',
      dedicatedAdminConfigured: true,
      portalActorHint: 'operator@nexushub.me',
    });
  });

  it('registers quick actions behind the portal admin token guard', () => {
    const { app, routes } = makeApp();

    registerPortalActionRoutes(app as any);

    expect(app.post).toHaveBeenCalledWith('/api/action/:name', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(routes.get('/api/action/:name')?.[0]).toBe(hoisted.requirePortalAdminToken);
  });

  it('rejects unknown actions before execution', async () => {
    const { app, routes } = makeApp();
    registerPortalActionRoutes(app as any);
    const handler = routes.get('/api/action/:name')?.[1]!;
    const { payload, res } = makeResponse();

    await handler({ params: { name: 'unknown' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'Unknown action: unknown' });
    expect(hoisted.handlePortalAction).not.toHaveBeenCalled();
    expect(hoisted.clearPortalSnapshotCache).not.toHaveBeenCalled();
  });

  it('rate-limits valid actions before execution', async () => {
    hoisted.isPortalActionRateLimited.mockReturnValue(true);
    const { app, routes } = makeApp();
    registerPortalActionRoutes(app as any);
    const handler = routes.get('/api/action/:name')?.[1]!;
    const { payload, res } = makeResponse();

    await handler({ params: { name: 'clear-history' } }, res);

    expect(payload.statusCode).toBe(429);
    expect(payload.body).toEqual({ ok: false, message: 'Too many requests — wait 30s' });
    expect(hoisted.handlePortalAction).not.toHaveBeenCalled();
    expect(hoisted.clearPortalSnapshotCache).not.toHaveBeenCalled();
  });

  it('executes actions, clears snapshot cache, and writes operator-attributed audit metadata', async () => {
    const { app, routes } = makeApp();
    registerPortalActionRoutes(app as any);
    const handler = routes.get('/api/action/:name')?.[1]!;
    const { payload, res } = makeResponse();

    const req = {
      params: { name: 'clear-history' },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };
    await handler(req, res);

    expect(hoisted.handlePortalAction).toHaveBeenCalledWith('clear-history');
    expect(hoisted.recordPortalAction).toHaveBeenCalledWith('clear-history');
    expect(hoisted.clearPortalSnapshotCache).toHaveBeenCalledTimes(1);
    expect(hoisted.buildPortalAdminAuditDetails).toHaveBeenCalledWith(req);
    expect(hoisted.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      actorId: 42,
      action: 'access',
      resource: 'portal.action.clear-history',
      ipAddress: '127.0.0.1',
      details: expect.objectContaining({
        portalCredential: 'admin',
        dedicatedAdminConfigured: true,
        portalActorHint: 'operator@nexushub.me',
      }),
    }));
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ ok: true, message: 'done' });
  });
});
