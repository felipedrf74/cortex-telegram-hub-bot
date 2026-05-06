import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  addFounder: vi.fn(),
  listFounders: vi.fn(),
  removeFounder: vi.fn(),
  requirePortalAdminToken: vi.fn(),
  logPortalAdminMutation: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/services/founders', () => ({
  addFounder: (...args: unknown[]) => hoisted.addFounder(...args),
  listFounders: (...args: unknown[]) => hoisted.listFounders(...args),
  removeFounder: (...args: unknown[]) => hoisted.removeFounder(...args),
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

import { registerPortalFounderRoutes } from '../../src/portal/founder-routes';

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

describe('portal founder routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.listFounders.mockReturnValue([{ email: 'founder@example.com', plan: 'max' }]);
    hoisted.removeFounder.mockReturnValue(true);
  });

  it('registers founder routes and protects them with the admin token guard', () => {
    const { app, routes } = makeApp();

    registerPortalFounderRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/founders', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/founders', hoisted.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(app.delete).toHaveBeenCalledWith('/api/founders/:email', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(routes.get('GET /api/founders')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('POST /api/founders')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('DELETE /api/founders/:email')?.[0]).toBe(hoisted.requirePortalAdminToken);
  });

  it('lists founders with the existing portal response shape', () => {
    const { app, routes } = makeApp();
    registerPortalFounderRoutes(app as any);
    const handler = routes.get('GET /api/founders')?.[1]!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(hoisted.listFounders).toHaveBeenCalledTimes(1);
    expect(payload.body).toEqual({ founders: [{ email: 'founder@example.com', plan: 'max' }] });
  });

  it('rejects invalid founder email before adding a founder row', () => {
    const { app, routes } = makeApp();
    registerPortalFounderRoutes(app as any);
    const handler = routes.get('POST /api/founders')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ body: { email: 'not-an-email', plan: 'max' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'valid email required' });
    expect(hoisted.addFounder).not.toHaveBeenCalled();
    expect(hoisted.logPortalAdminMutation).not.toHaveBeenCalled();
  });

  it('rejects invalid founder plans before adding a founder row', () => {
    const { app, routes } = makeApp();
    registerPortalFounderRoutes(app as any);
    const handler = routes.get('POST /api/founders')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ body: { email: 'founder@example.com', plan: 'owner' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'plan must be pro or max' });
    expect(hoisted.addFounder).not.toHaveBeenCalled();
  });

  it('adds normalized founders and records an admin audit event', () => {
    const req = {
      body: {
        email: ' Founder@Example.com ',
        plan: 'max',
        note: 'early supporter',
      },
    };
    const { app, routes } = makeApp();
    registerPortalFounderRoutes(app as any);
    const handler = routes.get('POST /api/founders')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.addFounder).toHaveBeenCalledWith('founder@example.com', 'max', 'early supporter');
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'founder.add', {
      email: 'founder@example.com',
      plan: 'max',
      note: 'early supporter',
    });
    expect(payload.body).toEqual({ ok: true, founders: [{ email: 'founder@example.com', plan: 'max' }] });
  });

  it('removes decoded founders and records an admin audit event', () => {
    const req = { params: { email: encodeURIComponent('Founder@Example.com') } };
    const { app, routes } = makeApp();
    registerPortalFounderRoutes(app as any);
    const handler = routes.get('DELETE /api/founders/:email')?.[1]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.removeFounder).toHaveBeenCalledWith('founder@example.com');
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'founder.remove', {
      email: 'founder@example.com',
      removed: true,
    });
    expect(payload.body).toEqual({ ok: true });
  });

  it('rejects invalid founder delete params before mutating state', () => {
    const { app, routes } = makeApp();
    registerPortalFounderRoutes(app as any);
    const handler = routes.get('DELETE /api/founders/:email')?.[1]!;
    const { payload, res } = makeResponse();

    handler({ params: { email: 'bad-email' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'valid email required' });
    expect(hoisted.removeFounder).not.toHaveBeenCalled();
  });

  it('uses the shared internal-error helper when founder listing fails', () => {
    hoisted.listFounders.mockImplementation(() => {
      throw new Error('raw founders table failure');
    });
    const { app, routes } = makeApp();
    registerPortalFounderRoutes(app as any);
    const handler = routes.get('GET /api/founders')?.[1]!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Failed to load founders',
      'Portal: list founders failed',
    );
  });

  it('uses the shared internal-error helper when founder add fails', () => {
    hoisted.addFounder.mockImplementation(() => {
      throw new Error('raw founder add failure');
    });
    const { app, routes } = makeApp();
    registerPortalFounderRoutes(app as any);
    const handler = routes.get('POST /api/founders')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ body: { email: 'founder@example.com', plan: 'pro' } }, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Failed to save founder',
      'Portal: add founder failed',
    );
  });

  it('uses the shared internal-error helper when founder removal fails', () => {
    hoisted.removeFounder.mockImplementation(() => {
      throw new Error('raw founder delete failure');
    });
    const { app, routes } = makeApp();
    registerPortalFounderRoutes(app as any);
    const handler = routes.get('DELETE /api/founders/:email')?.[1]!;
    const { payload, res } = makeResponse();

    handler({ params: { email: 'founder@example.com' } }, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Failed to remove founder',
      'Portal: remove founder failed',
    );
  });
});
