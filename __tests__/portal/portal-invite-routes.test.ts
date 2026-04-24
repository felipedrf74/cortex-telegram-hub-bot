import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createInviteCode: vi.fn(),
  deleteInviteCode: vi.fn(),
  listInviteCodes: vi.fn(),
  getDb: vi.fn(),
  requirePortalAdminToken: vi.fn(),
  logPortalAdminMutation: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  createInviteCode: (...args: unknown[]) => hoisted.createInviteCode(...args),
  deleteInviteCode: (...args: unknown[]) => hoisted.deleteInviteCode(...args),
  listInviteCodes: (...args: unknown[]) => hoisted.listInviteCodes(...args),
}));

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => hoisted.getDb(...args),
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

import { registerPortalInviteRoutes } from '../../src/portal/invite-routes';

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

describe('portal invite routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.listInviteCodes.mockReturnValue([{ code: 'JOIN-1' }]);
    hoisted.createInviteCode.mockReturnValue('JOIN-2');
    hoisted.getDb.mockReturnValue({
      prepare: vi.fn(() => ({ run: vi.fn() })),
    });
  });

  it('registers invite routes and protects mutations with the admin token guard', () => {
    const { app, routes } = makeApp();

    registerPortalInviteRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/invite-codes', expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/invite-codes', hoisted.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(app.delete).toHaveBeenCalledWith('/api/invite-codes/:code', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(routes.get('POST /api/invite-codes')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('DELETE /api/invite-codes/:code')?.[0]).toBe(hoisted.requirePortalAdminToken);
  });

  it('lists invite codes without requiring admin write scope', () => {
    const { app, routes } = makeApp();
    registerPortalInviteRoutes(app as any);
    const handler = routes.get('GET /api/invite-codes')?.[0]!;
    const { payload, res } = makeResponse();

    handler({}, res);

    expect(hoisted.listInviteCodes).toHaveBeenCalledTimes(1);
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ codes: [{ code: 'JOIN-1' }] });
  });

  it('uses the shared internal-error helper when invite listing fails', () => {
    hoisted.listInviteCodes.mockImplementation(() => {
      throw new Error('sqlite leaked path /private/invites.sqlite');
    });
    const { app, routes } = makeApp();
    registerPortalInviteRoutes(app as any);
    const handler = routes.get('GET /api/invite-codes')?.[0]!;
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

  it('creates invite codes with safe defaults and records an admin audit event', () => {
    const req = { body: {} };
    const { app, routes } = makeApp();
    registerPortalInviteRoutes(app as any);
    const handler = routes.get('POST /api/invite-codes')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.createInviteCode).toHaveBeenCalledWith(0, 1, undefined);
    expect(hoisted.getDb).not.toHaveBeenCalled();
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'invite_code.create', {
      code: 'JOIN-2',
      maxUses: 1,
      expiresInDays: null,
      skillPreset: undefined,
    });
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ ok: true, code: 'JOIN-2' });
  });

  it('stores optional skill presets for newly created invite codes', () => {
    const run = vi.fn();
    const prepare = vi.fn(() => ({ run }));
    hoisted.getDb.mockReturnValue({ prepare });
    const req = {
      body: {
        maxUses: 3,
        expiresInDays: 14,
        skillPreset: { training: true, content: false },
      },
    };
    const { app, routes } = makeApp();
    registerPortalInviteRoutes(app as any);
    const handler = routes.get('POST /api/invite-codes')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.createInviteCode).toHaveBeenCalledWith(0, 3, 14);
    expect(prepare).toHaveBeenCalledWith('UPDATE invite_codes SET skill_preset = ? WHERE code = ?');
    expect(run).toHaveBeenCalledWith(JSON.stringify(req.body.skillPreset), 'JOIN-2');
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'invite_code.create', {
      code: 'JOIN-2',
      maxUses: 3,
      expiresInDays: 14,
      skillPreset: req.body.skillPreset,
    });
    expect(payload.body).toEqual({ ok: true, code: 'JOIN-2' });
  });

  it('does not fail invite creation when the legacy database lacks skill_preset', () => {
    hoisted.getDb.mockReturnValue({
      prepare: vi.fn(() => {
        throw new Error('no such column: skill_preset');
      }),
    });
    const req = { body: { skillPreset: { secretary: true } } };
    const { app, routes } = makeApp();
    registerPortalInviteRoutes(app as any);
    const handler = routes.get('POST /api/invite-codes')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'invite_code.create', expect.objectContaining({
      code: 'JOIN-2',
      skillPreset: req.body.skillPreset,
    }));
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ ok: true, code: 'JOIN-2' });
  });

  it('uses the shared internal-error helper when invite creation fails', () => {
    hoisted.createInviteCode.mockImplementation(() => {
      throw new Error('raw invite create failure');
    });
    const { app, routes } = makeApp();
    registerPortalInviteRoutes(app as any);
    const handler = routes.get('POST /api/invite-codes')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ body: {} }, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Failed to create invite code',
      'Portal: create invite code failed',
    );
  });

  it('deletes invite codes and records an admin audit event', () => {
    const req = { params: { code: 'JOIN-OLD' } };
    const { app, routes } = makeApp();
    registerPortalInviteRoutes(app as any);
    const handler = routes.get('DELETE /api/invite-codes/:code')?.[1]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.deleteInviteCode).toHaveBeenCalledWith('JOIN-OLD');
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 0, 'invite_code.delete', {
      code: 'JOIN-OLD',
    });
    expect(payload.statusCode).toBe(200);
    expect(payload.body).toEqual({ ok: true });
  });

  it('uses the shared internal-error helper when invite deletion fails', () => {
    hoisted.deleteInviteCode.mockImplementation(() => {
      throw new Error('raw invite delete failure');
    });
    const { app, routes } = makeApp();
    registerPortalInviteRoutes(app as any);
    const handler = routes.get('DELETE /api/invite-codes/:code')?.[1]!;
    const { payload, res } = makeResponse();

    handler({ params: { code: 'JOIN-OLD' } }, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Failed to delete invite code',
      'Portal: delete invite code failed',
    );
  });
});
