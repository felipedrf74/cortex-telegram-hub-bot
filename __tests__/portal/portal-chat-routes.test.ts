import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const targetUserGuard = ((_req: unknown, _res: unknown, next: () => void) => next()) as unknown as ReturnType<typeof vi.fn>;
  return {
    getDb: vi.fn(),
    requirePortalAdminToken: vi.fn(),
    buildPortalChatDiagnostics: vi.fn(),
    buildPortalUserChatDiagnostics: vi.fn(),
    sendPortalInternalError: vi.fn(),
    targetUserGuard,
    requireOperatorTargetUser: vi.fn(() => targetUserGuard),
  };
});

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => hoisted.getDb(...args),
}));

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
}));

vi.mock('../../src/portal/admin-target-user', () => ({
  requireOperatorTargetUser: (...args: unknown[]) => hoisted.requireOperatorTargetUser(...args),
}));

vi.mock('../../src/portal/chat-diagnostics', () => ({
  buildPortalChatDiagnostics: (...args: unknown[]) => hoisted.buildPortalChatDiagnostics(...args),
  buildPortalUserChatDiagnostics: (...args: unknown[]) => hoisted.buildPortalUserChatDiagnostics(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => hoisted.sendPortalInternalError(...args),
}));

import { registerPortalChatRoutes } from '../../src/portal/chat-routes';

type Handler = (req: any, res: any) => unknown;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  return {
    routes,
    app: {
      get: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`GET ${route}`, handlers);
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

describe('portal chat routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getDb.mockReturnValue({ prepare: vi.fn() });
    hoisted.buildPortalChatDiagnostics.mockReturnValue({ ok: true, privacyMode: 'metadata_only' });
    hoisted.buildPortalUserChatDiagnostics.mockReturnValue({ ok: true, privacyMode: 'metadata_only', userId: 42 });
  });

  it('registers chat diagnostics behind admin token and user-target guards', () => {
    const { app, routes } = makeApp();

    registerPortalChatRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/chat/diagnostics', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/users/:userId/chat-diagnostics', hoisted.requirePortalAdminToken, hoisted.targetUserGuard, expect.any(Function));
    expect(routes.get('GET /api/chat/diagnostics')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('GET /api/users/:userId/chat-diagnostics')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('GET /api/users/:userId/chat-diagnostics')?.[1]).toBe(hoisted.targetUserGuard);
    expect(hoisted.requireOperatorTargetUser).toHaveBeenCalledWith('userId');
  });

  it('returns aggregate metadata-only diagnostics with bounded query options', () => {
    const db = { prepare: vi.fn() };
    hoisted.getDb.mockReturnValue(db);
    const { app, routes } = makeApp();
    registerPortalChatRoutes(app as any);
    const handler = routes.get('GET /api/chat/diagnostics')?.[1]!;
    const { payload, res } = makeResponse();

    handler({ query: { windowDays: '14', limit: '25' } }, res);

    expect(hoisted.buildPortalChatDiagnostics).toHaveBeenCalledWith(db, {
      windowDays: 14,
      limit: 25,
    });
    expect(payload.body).toEqual({ ok: true, privacyMode: 'metadata_only' });
  });

  it('returns user metadata-only diagnostics through the scoped user route', () => {
    const db = { prepare: vi.fn() };
    hoisted.getDb.mockReturnValue(db);
    const { app, routes } = makeApp();
    registerPortalChatRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/chat-diagnostics')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '42' }, query: { windowDays: '7', limit: '10' } }, res);

    expect(hoisted.buildPortalUserChatDiagnostics).toHaveBeenCalledWith(db, 42, {
      windowDays: 7,
      limit: 10,
    });
    expect(payload.body).toEqual({ ok: true, privacyMode: 'metadata_only', userId: 42 });
  });

  it('rejects invalid user ids before diagnostics lookup', () => {
    const { app, routes } = makeApp();
    registerPortalChatRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/chat-diagnostics')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: 'bad' }, query: {} }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({
      ok: false,
      error: { code: 'INVALID_USER_ID', message: 'invalid userId' },
    });
    expect(hoisted.buildPortalUserChatDiagnostics).not.toHaveBeenCalled();
  });

  it('uses the shared internal-error helper on diagnostics failures', () => {
    hoisted.buildPortalChatDiagnostics.mockImplementation(() => {
      throw new Error('raw private message should not be returned');
    });
    const { app, routes } = makeApp();
    registerPortalChatRoutes(app as any);
    const handler = routes.get('GET /api/chat/diagnostics')?.[1]!;
    const { payload, res } = makeResponse();

    handler({ query: {} }, res);

    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Portal request failed',
      'Portal: chat diagnostics failed',
    );
  });
});
