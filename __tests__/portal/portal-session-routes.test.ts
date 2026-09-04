import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  portal: {
    token: '',
    readToken: 'read.token.value.for.tests',
    writeToken: 'write.token.value.for.tests',
    adminToken: 'admin.token.value.for.tests',
    sessionSecret: 'session.secret.value.for.tests.abcdef',
    sessionMaxAgeMs: 28_800_000,
    requireSessionAuth: false,
    allowLegacyFallback: false,
    adminRequireActor: false,
    adminActorAllowlist: [] as string[],
    adminActorSignatureSecret: '',
    adminActorSignatureToleranceMs: 300_000,
    betaHardened: false,
    bind: '127.0.0.1',
  },
}));

vi.mock('../../src/config', () => ({ config: { portal: hoisted.portal, app: { timezone: 'UTC' } } }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/api/rate-limiter', () => ({ extractClientIp: () => '203.0.113.7',
  _resetRateLimiterForTests: vi.fn(),
  getRateLimitStats: vi.fn(),
  rateLimitMiddleware: vi.fn(),
}));
vi.mock('../../src/portal/http', () => ({ sendPortalInternalError: vi.fn() }));

import { requirePortalAdminToken, requirePortalToken } from '../../src/api/secret-guards';
import {
  buildSessionCookie,
  registerPortalSessionRoutes,
  resolveScopeForPortalToken,
} from '../../src/portal/session-routes';

type Handler = (req: any, res: any, next?: () => void) => void;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  const app = {
    get: vi.fn((p: string, ...h: Handler[]) => { routes.set(`GET ${p}`, h); }),
    post: vi.fn((p: string, ...h: Handler[]) => { routes.set(`POST ${p}`, h); }),
  };
  registerPortalSessionRoutes(app as any);
  return { app, routes };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  const headers: Record<string, string> = Object.fromEntries(
    Object.entries((overrides.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    method: 'POST',
    secure: false,
    ip: '203.0.113.7',
    query: {},
    params: {},
    body: {},
    path: '/api/auth/session',
    ...overrides,
    headers,
    header: (name: string) => headers[name.toLowerCase()],
    get: (name: string) => headers[name.toLowerCase()],
  };
}

function makeRes() {
  const payload: { statusCode: number; body?: any; headers: Record<string, string> } = { statusCode: 200, headers: {} };
  const res: any = {
    status: (c: number) => { payload.statusCode = c; return res; },
    json: (b: unknown) => { payload.body = b; return res; },
    setHeader: (k: string, v: string) => { payload.headers[k.toLowerCase()] = v; },
    set: (k: string, v: string) => { payload.headers[k.toLowerCase()] = v; },
  };
  return { res, payload };
}

/** Runs the handler chain, including express-rate-limit middleware, like Express would. */
async function run(handlers: Handler[], req: any) {
  const { res, payload } = makeRes();
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return { payload, res };
}

function cookieValue(setCookie: string): string {
  return decodeURIComponent(setCookie.split(';')[0].split('=')[1]);
}

beforeEach(() => {
  hoisted.portal.sessionSecret = 'session.secret.value.for.tests.abcdef';
  hoisted.portal.token = '';
  hoisted.portal.allowLegacyFallback = false;
});

describe('resolveScopeForPortalToken', () => {
  const s = {
    sessionSecret: 'x', sessionMaxAgeMs: 1000, legacyToken: 'legacy.token.value.for.tests',
    readToken: 'read-1234567890', writeToken: 'write-1234567890', adminToken: 'admin-1234567890', allowLegacyFallback: false,
  };
  it('maps dedicated tokens to their scope and refuses unknown or legacy tokens when scoped tokens exist', () => {
    expect(resolveScopeForPortalToken('admin-1234567890', s)).toBe('admin');
    expect(resolveScopeForPortalToken('write-1234567890', s)).toBe('write');
    expect(resolveScopeForPortalToken('read-1234567890', s)).toBe('read');
    expect(resolveScopeForPortalToken('legacy.token.value.for.tests', s)).toBeNull();
    expect(resolveScopeForPortalToken('nope', s)).toBeNull();
    expect(resolveScopeForPortalToken('', s)).toBeNull();
  });
  it('treats the legacy token as admin only without scoped tokens or with explicit fallback', () => {
    expect(resolveScopeForPortalToken('legacy.token.value.for.tests', { ...s, allowLegacyFallback: true })).toBe('admin');
    expect(resolveScopeForPortalToken('legacy.token.value.for.tests', { ...s, readToken: '', writeToken: '', adminToken: '' })).toBe('admin');
  });
});

describe('buildSessionCookie', () => {
  it('sets HttpOnly, SameSite=Strict, Path=/ and Secure only for https', () => {
    expect(buildSessionCookie('ps_abc.def', 3600, true)).toBe('portal_session=ps_abc.def; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure');
    expect(buildSessionCookie('', 0, false)).toBe('portal_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  });
});

describe('portal session routes', () => {
  it('registers the session family with a rate limiter on sign-in and the read guard on GET', () => {
    const { routes } = makeApp();
    expect(routes.get('POST /api/auth/session')).toHaveLength(2);
    expect(routes.get('GET /api/auth/session')?.[0]).toBe(requirePortalToken);
    expect(routes.get('POST /api/auth/session/logout')).toHaveLength(1);
  });

  it('answers 503 without a session secret and 401 for an unknown token', async () => {
    const { routes } = makeApp();
    hoisted.portal.sessionSecret = '';
    expect((await run(routes.get('POST /api/auth/session')!, makeReq({ body: { token: 'admin.token.value.for.tests' } }))).payload.statusCode).toBe(503);
    hoisted.portal.sessionSecret = 'session.secret.value.for.tests.abcdef';
    const bad = await run(routes.get('POST /api/auth/session')!, makeReq({ body: { token: 'wrong' } }));
    expect(bad.payload.statusCode).toBe(401);
    expect(bad.payload.headers['set-cookie']).toBeUndefined();
  });

  it('mints a cookie session whose scope matches the token and whose csrf proof unlocks mutations', async () => {
    const { routes } = makeApp();
    const created = await run(routes.get('POST /api/auth/session')!, makeReq({
      body: { token: 'admin.token.value.for.tests', actor: 'ops@nexushub.me' },
      headers: { 'x-forwarded-proto': 'https' },
    }));
    expect(created.payload.statusCode).toBe(200);
    expect(created.payload.body).toMatchObject({ ok: true, scope: 'admin', actor: 'ops@nexushub.me' });
    expect(created.payload.body.csrf).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const setCookie = created.payload.headers['set-cookie'];
    expect(setCookie).toContain('portal_session=ps_');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toMatch(/Max-Age=28800/);

    const cookie = `portal_session=${encodeURIComponent(cookieValue(setCookie))}`;

    // Cookie + csrf header → admin guard passes.
    const withCsrf = makeReq({ method: 'POST', path: '/api/users/1/status', headers: { cookie, 'x-portal-csrf': created.payload.body.csrf } });
    const ok = makeRes();
    let passed = false;
    requirePortalAdminToken(withCsrf as any, ok.res, () => { passed = true; });
    expect(passed).toBe(true);

    // Cookie without csrf header → 403.
    const withoutCsrf = makeReq({ method: 'POST', path: '/api/users/1/status', headers: { cookie } });
    const blocked = makeRes();
    let passedWithout = false;
    requirePortalAdminToken(withoutCsrf as any, blocked.res, () => { passedWithout = true; });
    expect(passedWithout).toBe(false);
    expect(blocked.payload.statusCode).toBe(403);

    // GET with the cookie reads the session back, including a matching csrf.
    const getReq = makeReq({ method: 'GET', path: '/api/auth/session', headers: { cookie } });
    const read = await run(routes.get('GET /api/auth/session')!, getReq);
    expect(read.payload.statusCode).toBe(200);
    expect(read.payload.body).toMatchObject({ ok: true, scope: 'admin', actor: 'ops@nexushub.me', csrf: created.payload.body.csrf });
    expect(read.payload.body.expiresAt).toBe(created.payload.body.expiresAt);
  });

  it('scopes read tokens to read-only sessions and omits Secure on plain http', async () => {
    const { routes } = makeApp();
    const created = await run(routes.get('POST /api/auth/session')!, makeReq({ body: { token: 'read.token.value.for.tests' } }));
    expect(created.payload.body.scope).toBe('read');
    expect(created.payload.body.actor).toBe('portal-operator');
    expect(created.payload.headers['set-cookie']).not.toContain('Secure');
    const cookie = `portal_session=${encodeURIComponent(cookieValue(created.payload.headers['set-cookie']))}`;
    const adminReq = makeReq({ method: 'POST', path: '/api/users/1/status', headers: { cookie, 'x-portal-csrf': created.payload.body.csrf } });
    const denied = makeRes();
    let passed = false;
    requirePortalAdminToken(adminReq as any, denied.res, () => { passed = true; });
    expect(passed).toBe(false);
    expect(denied.payload.statusCode).toBe(401);
  });

  it('reports no cookie session for bearer-authenticated requests and clears the cookie on logout', async () => {
    const { routes } = makeApp();
    const bearer = makeReq({ method: 'GET', path: '/api/auth/session', headers: { authorization: 'Bearer admin.token.value.for.tests' } });
    const read = await run(routes.get('GET /api/auth/session')!, bearer);
    expect(read.payload.statusCode).toBe(404);

    const out = await run(routes.get('POST /api/auth/session/logout')!, makeReq({ headers: { 'x-forwarded-proto': 'https' } }));
    expect(out.payload.body).toEqual({ ok: true });
    expect(out.payload.headers['set-cookie']).toBe('portal_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
  });
});
