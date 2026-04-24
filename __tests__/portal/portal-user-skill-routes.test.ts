import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  requirePortalAdminToken: vi.fn(),
  getSkillCatalog: vi.fn(),
  getUserSkillState: vi.fn(),
  resetUserSkillOverrides: vi.fn(),
  setSkillAccess: vi.fn(),
  logPortalAdminMutation: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: hoisted.requirePortalAdminToken,
}));

vi.mock('../../src/services/user-skill-access', () => ({
  getSkillCatalog: (...args: unknown[]) => hoisted.getSkillCatalog(...args),
  getUserSkillState: (...args: unknown[]) => hoisted.getUserSkillState(...args),
  resetUserSkillOverrides: (...args: unknown[]) => hoisted.resetUserSkillOverrides(...args),
  setSkillAccess: (...args: unknown[]) => hoisted.setSkillAccess(...args),
}));

vi.mock('../../src/portal/admin-audit', () => ({
  logPortalAdminMutation: (...args: unknown[]) => hoisted.logPortalAdminMutation(...args),
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: (...args: unknown[]) => hoisted.sendPortalInternalError(...args),
}));

import { registerPortalUserSkillRoutes } from '../../src/portal/user-skill-routes';

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

describe('portal user skill routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getSkillCatalog.mockReturnValue([
      {
        skill: 'secretary',
        label: 'Secretary',
        description: 'Secretary',
        requiresOAuth: true,
        subSkills: [{ id: 'email', label: 'Email', description: 'Email' }],
      },
      {
        skill: 'finance',
        label: 'Finance',
        description: 'Finance',
        requiresOAuth: false,
        subSkills: [],
      },
    ]);
    hoisted.getUserSkillState.mockReturnValue([{ skill: 'finance', enabled: true }]);
  });

  it('registers skill routes and protects mutations with the admin token guard', () => {
    const { app, routes } = makeApp();

    registerPortalUserSkillRoutes(app as any);

    expect(app.get).toHaveBeenCalledWith('/api/users/:userId/skills', expect.any(Function));
    expect(app.put).toHaveBeenCalledWith('/api/users/:userId/skills', hoisted.requirePortalAdminToken, expect.any(Function), expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/api/users/:userId/skills/reset', hoisted.requirePortalAdminToken, expect.any(Function));
    expect(routes.get('PUT /api/users/:userId/skills')?.[0]).toBe(hoisted.requirePortalAdminToken);
    expect(routes.get('POST /api/users/:userId/skills/reset')?.[0]).toBe(hoisted.requirePortalAdminToken);
  });

  it('loads a user skill state by canonical user id', () => {
    const { app, routes } = makeApp();
    registerPortalUserSkillRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/skills')?.[0]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '42' } }, res);

    expect(hoisted.getUserSkillState).toHaveBeenCalledWith(42);
    expect(payload.body).toEqual({ skills: [{ skill: 'finance', enabled: true }] });
  });

  it('rejects invalid user ids before loading skill state', () => {
    const { app, routes } = makeApp();
    registerPortalUserSkillRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/skills')?.[0]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: 'bad' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'invalid userId' });
    expect(hoisted.getUserSkillState).not.toHaveBeenCalled();
  });

  it('rejects malformed mutation payloads before writing overrides', () => {
    const { app, routes } = makeApp();
    registerPortalUserSkillRoutes(app as any);
    const handler = routes.get('PUT /api/users/:userId/skills')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '42' }, body: { skill: 'unknown', enabled: true } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'valid skill/subSkill required' });
    expect(hoisted.setSkillAccess).not.toHaveBeenCalled();
    expect(hoisted.logPortalAdminMutation).not.toHaveBeenCalled();
  });

  it('rejects non-boolean enabled values before writing overrides', () => {
    const { app, routes } = makeApp();
    registerPortalUserSkillRoutes(app as any);
    const handler = routes.get('PUT /api/users/:userId/skills')?.[2]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '42' }, body: { skill: 'finance', enabled: 'false' } }, res);

    expect(payload.statusCode).toBe(400);
    expect(payload.body).toEqual({ ok: false, message: 'enabled must be boolean' });
    expect(hoisted.setSkillAccess).not.toHaveBeenCalled();
  });

  it('updates skill access and records an admin audit event', () => {
    const req = {
      params: { userId: '42' },
      body: {
        skill: 'secretary',
        subSkill: 'email',
        enabled: false,
        reason: 'billing downgrade',
      },
    };
    const { app, routes } = makeApp();
    registerPortalUserSkillRoutes(app as any);
    const handler = routes.get('PUT /api/users/:userId/skills')?.[2]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.setSkillAccess).toHaveBeenCalledWith(42, 'secretary', false, {
      subSkill: 'email',
      reason: 'billing downgrade',
    });
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 42, 'user.skills.update', {
      skill: 'secretary',
      subSkill: 'email',
      enabled: false,
      reason: 'billing downgrade',
    });
    expect(payload.body).toEqual({ ok: true, skills: [{ skill: 'finance', enabled: true }] });
  });

  it('resets skill overrides and records an admin audit event', () => {
    const req = { params: { userId: '42' } };
    const { app, routes } = makeApp();
    registerPortalUserSkillRoutes(app as any);
    const handler = routes.get('POST /api/users/:userId/skills/reset')?.[1]!;
    const { payload, res } = makeResponse();

    handler(req, res);

    expect(hoisted.resetUserSkillOverrides).toHaveBeenCalledWith(42);
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(req, 42, 'user.skills.reset');
    expect(payload.body).toEqual({ ok: true });
  });

  it('uses the shared internal-error helper for skill route failures', () => {
    hoisted.getUserSkillState.mockImplementationOnce(() => {
      throw new Error('raw skill db path /private/skills.sqlite');
    });
    const { app, routes } = makeApp();
    registerPortalUserSkillRoutes(app as any);
    const handler = routes.get('GET /api/users/:userId/skills')?.[0]!;
    const { payload, res } = makeResponse();

    handler({ params: { userId: '42' } }, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Portal request failed',
      'Portal: request failed',
    );
  });
});
