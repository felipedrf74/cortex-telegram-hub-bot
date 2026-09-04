import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getReleaseInfo: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/services/release-info', () => ({
  getReleaseInfo: hoisted.getReleaseInfo,
}));

vi.mock('../../src/portal/http', () => ({
  sendPortalInternalError: hoisted.sendPortalInternalError,
}));

import { registerPortalEnvironmentRoutes } from '../../src/portal/environment-routes';

type Handler = (req: any, res: any) => void;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  const app = {
    get: vi.fn((path: string, ...handlers: Handler[]) => { routes.set(`GET ${path}`, handlers); }),
  };
  return { app, routes };
}

function makeResponse() {
  const payload: { statusCode: number; body?: unknown; headers: Record<string, string> } = { statusCode: 200, headers: {} };
  const res = {
    status(code: number) { payload.statusCode = code; return res; },
    json(body: unknown) { payload.body = body; return res; },
    setHeader(name: string, value: string) { payload.headers[name.toLowerCase()] = value; },
  };
  return { res, payload };
}

describe('portal environment routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers GET /api/release as a read route', () => {
    const { app, routes } = makeApp();
    registerPortalEnvironmentRoutes(app as any, { startedAt: 1000 });

    expect(routes.get('GET /api/release')).toHaveLength(1);
  });

  it('returns the release info for the server boot time with no-store caching', () => {
    hoisted.getReleaseInfo.mockReturnValue({ version: '1.2.3', gitShortSha: 'abc12345' });
    const { app, routes } = makeApp();
    registerPortalEnvironmentRoutes(app as any, { startedAt: 1000 });
    const { res, payload } = makeResponse();

    routes.get('GET /api/release')![0]({}, res);

    expect(hoisted.getReleaseInfo).toHaveBeenCalledWith({ startedAt: 1000 });
    expect(payload.headers['cache-control']).toBe('no-store');
    expect(payload.body).toEqual({ ok: true, release: { version: '1.2.3', gitShortSha: 'abc12345' } });
  });

  it('sanitizes failures through the shared portal error helper', () => {
    hoisted.getReleaseInfo.mockImplementation(() => { throw new Error('raw fs path /srv/dist'); });
    const { app, routes } = makeApp();
    registerPortalEnvironmentRoutes(app as any, { startedAt: 1000 });
    const { res, payload } = makeResponse();

    routes.get('GET /api/release')![0]({}, res);

    expect(payload.body).toBeUndefined();
    expect(hoisted.sendPortalInternalError).toHaveBeenCalledWith(
      res,
      expect.any(Error),
      'Failed to load release information',
      'Portal: release info request failed',
    );
  });
});
