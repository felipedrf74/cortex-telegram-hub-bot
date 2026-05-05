import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class MockDatabaseConfigProvider {}
  return {
    DatabaseConfigProvider: MockDatabaseConfigProvider,
    getConfigProvider: vi.fn(),
    requirePortalAdminToken: vi.fn(),
    logPortalAdminMutation: vi.fn(),
    sendPortalInternalError: vi.fn(),
    loggerWarn: vi.fn(),
  };
});

vi.mock('../../src/services/config-provider', () => ({
  DatabaseConfigProvider: hoisted.DatabaseConfigProvider,
  getConfigProvider: (...args: unknown[]) => hoisted.getConfigProvider(...args),
}));

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
}));

vi.mock('../../src/portal/admin-audit', () => ({
  logPortalAdminMutation: (...args: unknown[]) => hoisted.logPortalAdminMutation(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => hoisted.sendPortalInternalError(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => hoisted.loggerWarn(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { registerPortalSettingsRoutes } from '../../src/portal/settings-routes';

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
      delete: vi.fn((route: string, ...handlers: Handler[]) => {
        routes.set(`DELETE ${route}`, handlers);
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

function makeDatabaseProvider(overrides: Record<string, unknown> = {}) {
  return Object.assign(new hoisted.DatabaseConfigProvider(), {
    getAllSettings: vi.fn(() => [{ id: 'language', value: 'pt-BR' }]),
    setSetting: vi.fn(),
    clearSetting: vi.fn(),
    ...overrides,
  });
}

describe('portal settings routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers settings routes and protects mutations with the admin token guard', () => {
    const { app, routes } = makeApp();

    registerPortalSettingsRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/settings', expect.any(Function));
    expect(app.put).toHaveBeenCalledWith('/api/settings', hoisted.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(app.delete).toHaveBeenCalledWith('/api/settings', hoisted.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(routes.get('PUT /api/settings')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('DELETE /api/settings')?.[0]).toBe(hoisted.requirePortalAdminToken);
  });

  it('returns database-backed settings when the database provider is active', () => {
    const provider = makeDatabaseProvider();
    hoisted.getConfigProvider.mockReturnValue(provider);
    const { app, routes } = makeApp();
    registerPortalSettingsRoutes(app as any);
    const handler = routes.get('GET /api/settings')?.[0]!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(provider.getAllSettings).toHaveBeenCalledTimes(1);
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ settings: [{ id: 'language', value: 'pt-BR' }] });
  });

  it('returns a stable unavailable response when database settings are not active', () => {
    hoisted.getConfigProvider.mockReturnValue({ name: 'env' });
    const { app, routes } = makeApp();
    registerPortalSettingsRoutes(app as any);
    const handler = routes.get('GET /api/settings')?.[0]!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ settings: [], message: 'DatabaseConfigProvider not active' });
  });

  it('rejects malformed setting updates before mutating state', () => {
    const provider = makeDatabaseProvider();
    hoisted.getConfigProvider.mockReturnValue(provider);
    const { app, routes } = makeApp();
    registerPortalSettingsRoutes(app as any);
    const handler = routes.get('PUT /api/settings')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ body: { id: 'language' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ error: 'id and value required' });
    expect(provider.setSetting).not.toHaveBeenCalled();
    expect(hoisted.logPortalAdminMutation).not.toHaveBeenCalled();
  });

  it('updates settings and records an admin mutation audit event', () => {
    const provider = makeDatabaseProvider();
    hoisted.getConfigProvider.mockReturnValue(provider);
    const req = { body: { id: 'language', value: 'pt-BR' } };
    const { app, routes } = makeApp();
    registerPortalSettingsRoutes(app as any);
    const handler = routes.get('PUT /api/settings')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(provider.setSetting).toHaveBeenCalledWith('language', 'pt-BR');
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'settings.update', {
      id: 'language',
      value: 'pt-BR',
    });
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({
      ok: true,
      id: 'language',
      value: 'pt-BR',
      message: 'Setting updated. Active immediately.',
    });
  });

  it('keeps setting update validation errors sanitized', () => {
    const provider = makeDatabaseProvider({
      setSetting: vi.fn(() => {
        throw new Error('invalid database path /private/settings.sqlite');
      }),
    });
    hoisted.getConfigProvider.mockReturnValue(provider);
    const { app, routes } = makeApp();
    registerPortalSettingsRoutes(app as any);
    const handler = routes.get('PUT /api/settings')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ body: { id: 'language', value: 'pt-BR' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ error: 'Invalid setting update' });
    expect(JSON.stringify(payload.body)).not.toContain('/private/settings.sqlite');
    expect(hoisted.loggerWarn).toHaveBeenCalledWith(expect.objectContaining({
      err: expect.any(Error),
      settingId: 'language',
    }), 'Portal: settings update rejected');
  });

  it('deletes settings and returns the refreshed setting list', () => {
    const provider = makeDatabaseProvider();
    hoisted.getConfigProvider.mockReturnValue(provider);
    const req = { body: { id: 'language' } };
    const { app, routes } = makeApp();
    registerPortalSettingsRoutes(app as any);
    const handler = routes.get('DELETE /api/settings')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(provider.clearSetting).toHaveBeenCalledWith('language');
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'settings.delete', {
      id: 'language',
    });
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ ok: true, settings: [{ id: 'language', value: 'pt-BR' }] });
  });

  it('uses the shared portal internal-error helper for settings delete failures', () => {
    const provider = makeDatabaseProvider({
      clearSetting: vi.fn(() => {
        throw new Error('sqlite locked with sensitive path');
      }),
    });
    hoisted.getConfigProvider.mockReturnValue(provider);
    const { app, routes } = makeApp();
    registerPortalSettingsRoutes(app as any);
    const handler = routes.get('DELETE /api/settings')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ body: { id: 'language' } }, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Failed to reset setting',
      'Portal: settings delete failed',
    );
  });
});
