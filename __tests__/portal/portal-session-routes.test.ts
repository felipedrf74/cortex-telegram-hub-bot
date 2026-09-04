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
    operatorUsername: '',
    operatorPasswordHash: '',
    operatorActor: '',
    operatorScope: 'admin',
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
  isPortalSessionAuthPath,
  registerPortalSessionRoutes,
  resolveScopeForPortalToken,
} from '../../src/portal/session-routes';
import { PASSWORD_LOCKOUT_WINDOW_MS, _resetPasswordLockoutsForTests, registerPortalSessionPasswordRoutes } from '../../src/portal/session-password-routes';
import { hashPortalPassword } from '../../src/services/portal-password';

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
    expect(routes.get('GET /api/auth/session')?.[1]).toBe(requirePortalToken);
    expect(routes.get('POST /api/auth/session/logout')).toHaveLength(2);
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

import { mintPortalSessionToken } from '../../src/services/portal-session-mint';
import { verifyPresentedSessionToken } from '../../src/portal/session-routes';

describe('portal session routes: pre-minted session tokens and session-only mode', () => {
  function mint(scope: 'read' | 'write' | 'admin', ttlMs = 3_600_000) {
    return mintPortalSessionToken({ secret: hoisted.portal.sessionSecret, actorHint: 'ops@nexushub.me', scope, ttlMs, maxAgeMs: hoisted.portal.sessionMaxAgeMs }).token;
  }

  it('adopts a valid ps_ token as the cookie session with its own scope and expiry', async () => {
    const { routes } = makeApp();
    const token = mint('write');
    const created = await run(routes.get('POST /api/auth/session')!, makeReq({ body: { token } }));
    expect(created.payload.statusCode).toBe(200);
    expect(created.payload.body).toMatchObject({ ok: true, scope: 'write', actor: 'ops@nexushub.me' });
    expect(created.payload.headers['set-cookie']).toContain(`portal_session=${encodeURIComponent(token)}`);
    expect(created.payload.headers['set-cookie']).toMatch(/Max-Age=(3599|3600)(;|$)/);
    expect(created.payload.body.csrf).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(verifyPresentedSessionToken(token, makeReq() as any)).toMatchObject({ scope: 'write', actor: 'ops@nexushub.me' });
  });

  it('rejects expired, foreign-secret and non-session tokens as presented sessions', () => {
    const req = makeReq() as any;
    expect(verifyPresentedSessionToken('admin.token.value.for.tests', req)).toBeNull();
    const expired = mintPortalSessionToken({ secret: hoisted.portal.sessionSecret, actorHint: 'ops@nexushub.me', scope: 'admin', ttlMs: 1_000, maxAgeMs: 60_000, nowMs: Date.now() - 10_000 }).token;
    expect(verifyPresentedSessionToken(expired, req)).toBeNull();
    const foreign = mintPortalSessionToken({ secret: 'another.secret.value.for.tests', actorHint: 'ops@nexushub.me', scope: 'admin', ttlMs: 60_000, maxAgeMs: 60_000 }).token;
    expect(verifyPresentedSessionToken(foreign, req)).toBeNull();
  });

  it('refuses static tokens when PORTAL_REQUIRE_SESSION_AUTH is on but still adopts ps_ tokens', async () => {
    hoisted.portal.requireSessionAuth = true;
    try {
      const { routes } = makeApp();
      const rejected = await run(routes.get('POST /api/auth/session')!, makeReq({ body: { token: 'admin.token.value.for.tests' } }));
      expect(rejected.payload.statusCode).toBe(401);
      const adopted = await run(routes.get('POST /api/auth/session')!, makeReq({ body: { token: mint('admin') } }));
      expect(adopted.payload.statusCode).toBe(200);
      expect(adopted.payload.body.scope).toBe('admin');
    } finally {
      hoisted.portal.requireSessionAuth = false;
    }
  });
});

describe('portal session auth paths bypass the generic /api guard', () => {
  // The sign-in POST carries its credential in the body; if the generic portal
  // token guard runs first it answers 401 before the handler and no cookie
  // session can ever be created (production, 2026-09-04).
  it('names exactly the sign-in and logout routes, relative to the /api mount', () => {
    expect(isPortalSessionAuthPath('/auth/session')).toBe(true);
    expect(isPortalSessionAuthPath('/auth/session/logout')).toBe(true);
    expect(isPortalSessionAuthPath('/auth/session/anything-else')).toBe(false);
    expect(isPortalSessionAuthPath('/snapshot')).toBe(false);
    expect(isPortalSessionAuthPath('/users')).toBe(false);
    expect(isPortalSessionAuthPath('/api/auth/session')).toBe(false);
  });
});

describe('operator username + password sign-in', () => {
  const PASSWORD = 'operator password for tests 42';
  const HASH = hashPortalPassword(PASSWORD, { N: 1024 });

  function makePasswordApp() {
    const routes = new Map<string, Handler[]>();
    const app = {
      get: vi.fn((p: string, ...h: Handler[]) => { routes.set(`GET ${p}`, h); }),
      post: vi.fn((p: string, ...h: Handler[]) => { routes.set(`POST ${p}`, h); }),
    };
    registerPortalSessionPasswordRoutes(app as any);
    return routes;
  }
  const passwordReq = (username: string, password: string, ip = '203.0.113.7') =>
    makeReq({ path: '/api/auth/session/password', body: { username, password }, ip, headers: { 'x-forwarded-proto': 'https' } });

  beforeEach(() => {
    _resetPasswordLockoutsForTests();
    hoisted.portal.operatorUsername = 'felipe@example.test';
    hoisted.portal.operatorPasswordHash = HASH;
    hoisted.portal.operatorActor = '';
    hoisted.portal.operatorScope = 'admin';
  });

  it('advertises password sign-in only when the credential and the session secret are configured', async () => {
    const routes = makePasswordApp();
    const configured = await run(routes.get('GET /api/auth/session/methods')!, makeReq({ method: 'GET', path: '/api/auth/session/methods' }));
    expect(configured.payload.body).toEqual({ ok: true, token: true, password: true });
    hoisted.portal.operatorUsername = '';
    hoisted.portal.operatorPasswordHash = '';
    const unconfigured = await run(routes.get('GET /api/auth/session/methods')!, makeReq({ method: 'GET', path: '/api/auth/session/methods' }));
    expect(unconfigured.payload.body).toEqual({ ok: true, token: true, password: false });
  });

  it('mints an admin cookie session for the configured operator and returns the CSRF proof', async () => {
    const routes = makePasswordApp();
    const out = await run(routes.get('POST /api/auth/session/password')!, passwordReq('Felipe@Example.test', PASSWORD));
    expect(out.payload.statusCode).toBe(200);
    expect(out.payload.body).toMatchObject({ ok: true, method: 'password', scope: 'admin', actor: 'felipe@example.test' });
    expect(out.payload.body.csrf).toBeTruthy();
    const cookie = out.payload.headers['set-cookie'];
    expect(cookie).toContain('portal_session=ps_');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('rejects a wrong username or password without setting a cookie', async () => {
    const routes = makePasswordApp();
    const wrongPassword = await run(routes.get('POST /api/auth/session/password')!, passwordReq('felipe@example.test', PASSWORD + 'x'));
    expect(wrongPassword.payload.statusCode).toBe(401);
    expect(wrongPassword.payload.headers['set-cookie']).toBeUndefined();
    const wrongUser = await run(routes.get('POST /api/auth/session/password')!, passwordReq('someone@example.test', PASSWORD));
    expect(wrongUser.payload.statusCode).toBe(401);
    expect(wrongUser.payload.body.message).toBe('Invalid username or password');
  });

  it('locks the username out after five failures, even with the right password, until the window passes', async () => {
    vi.useFakeTimers();
    try {
      const routes = makePasswordApp();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const out = await run(routes.get('POST /api/auth/session/password')!, passwordReq('felipe@example.test', 'wrong password attempt'));
        expect(out.payload.statusCode).toBe(401);
      }
      const locked = await run(routes.get('POST /api/auth/session/password')!, passwordReq('felipe@example.test', PASSWORD));
      expect(locked.payload.statusCode).toBe(429);
      expect(locked.payload.headers['retry-after']).toBeTruthy();
      // A different username on the same IP has its own counter.
      const otherUser = await run(routes.get('POST /api/auth/session/password')!, passwordReq('someone-else@example.test', PASSWORD));
      expect(otherUser.payload.statusCode).toBe(401);
      // The lockout expires with the window.
      vi.advanceTimersByTime(PASSWORD_LOCKOUT_WINDOW_MS + 1000);
      const recovered = await run(routes.get('POST /api/auth/session/password')!, passwordReq('felipe@example.test', PASSWORD));
      expect(recovered.payload.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers 503 when the credential is not configured and never leaks the hash format in errors', async () => {
    hoisted.portal.operatorUsername = '';
    hoisted.portal.operatorPasswordHash = '';
    const routes = makePasswordApp();
    const out = await run(routes.get('POST /api/auth/session/password')!, passwordReq('felipe@example.test', PASSWORD));
    expect(out.payload.statusCode).toBe(503);
    expect(JSON.stringify(out.payload.body)).not.toContain('scrypt');
  });

  it('applies the configured actor and scope to the minted session', async () => {
    hoisted.portal.operatorActor = 'ops@example.test';
    hoisted.portal.operatorScope = 'read';
    const routes = makePasswordApp();
    const out = await run(routes.get('POST /api/auth/session/password')!, passwordReq('felipe@example.test', PASSWORD));
    expect(out.payload.statusCode).toBe(200);
    expect(out.payload.body).toMatchObject({ scope: 'read', actor: 'ops@example.test' });
  });
});
