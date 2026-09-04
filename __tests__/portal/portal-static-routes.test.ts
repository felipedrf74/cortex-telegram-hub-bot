import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminDashboardHandler,
  createForgotPasswordPageHandler,
  createLandingPreviewHandler,
  createUserLoginHandler,
  registerPortalStaticRoutes,
} from '../../src/portal/static-routes';

type RouteHandler = (req: unknown, res: any) => void;

let tempDirs: string[] = [];

function createTempPortalDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-portal-static-'));
  tempDirs.push(dir);
  return dir;
}

function makeResponse() {
  const payload = {
    statusCode: 200,
    body: undefined as unknown,
    contentType: undefined as string | undefined,
    headers: {} as Record<string, string>,
  };
  const res: any = {
    set: vi.fn((key: string, value: string) => {
      payload.headers[key] = value;
      return res;
    }),
    type: vi.fn((value: string) => {
      payload.contentType = value;
      return res;
    }),
    status: vi.fn((code: number) => {
      payload.statusCode = code;
      return res;
    }),
    send: vi.fn((body: unknown) => {
      payload.body = body;
      return res;
    }),
  };
  return { payload, res };
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe('portal static routes', () => {
  it('registers landing and dashboard aliases through one bounded route owner', () => {
    const routes = new Map<string, RouteHandler>();
    const app = {
      get: vi.fn((route: string, handler: RouteHandler) => {
        routes.set(route, handler);
      }),
    };

    registerPortalStaticRoutes(app as any, createTempPortalDir());

    // The order matters because Express resolves the FIRST matching
    // GET handler — `/auth/password-reset` MUST be registered before
    // any catch-all dashboard route would intercept it. Today the
    // dashboard routes are exact-match (`/`, `/admin`, `/portal`)
    // so order is documentation, not load-bearing — but we pin it
    // here so a future "everything not matched goes to dashboard"
    // refactor doesn't accidentally swallow the password-reset path.
    //
    // The `/auth/password-reset` mount was added 2026-05-04 as the
    // AUTH-O2 follow-up: closes the gap where the email link from
    // /api/v1/auth/password-reset/request had no destination.
    //
    // The immutable brand asset is intentionally first because it is
    // an exact static file route and should not inherit dashboard
    // no-store headers.
    expect(Array.from(routes.keys())).toEqual([
      '/assets/nexus-mark.png',
      '/portal/ui/:file',
      '/landing-preview',
      '/auth/forgot-password',
      '/auth/password-reset',
      '/user',
      '/login',
      '/app',
      '/',
      '/admin',
      '/portal',
    ]);
  });

  it('serves portal.html with dashboard security headers and without token injection', () => {
    const dir = createTempPortalDir();
    fs.writeFileSync(path.join(dir, 'portal.html'), '<html>portal</html>');
    const { payload, res } = makeResponse();

    createAdminDashboardHandler(dir)({}, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.contentType).toBe('html');
    expect(payload.body).toBe('<html>portal</html>');
    expect(payload.headers['Cache-Control']).toBe('no-cache, no-store, must-revalidate');
    expect(payload.headers['X-Frame-Options']).toBe('DENY');
    expect(payload.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(payload.headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(JSON.stringify(payload)).not.toContain('PORTAL_TOKEN');
  });

  it('serves landing preview without edge caching when landing.html exists', () => {
    const dir = createTempPortalDir();
    fs.writeFileSync(path.join(dir, 'landing.html'), '<html>landing</html>');
    const { payload, res } = makeResponse();

    createLandingPreviewHandler(dir)({}, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.contentType).toBe('html');
    expect(payload.body).toBe('<html>landing</html>');
    expect(payload.headers['Cache-Control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('serves the user login page with strict static-page headers', () => {
    const dir = createTempPortalDir();
    fs.writeFileSync(path.join(dir, 'user-login.html'), '<html>user login</html>');
    const { payload, res } = makeResponse();

    createUserLoginHandler(dir)({}, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.contentType).toBe('html');
    expect(payload.body).toBe('<html>user login</html>');
    expect(payload.headers['Cache-Control']).toBe('no-cache, no-store, must-revalidate');
    expect(payload.headers['Content-Security-Policy']).toContain("connect-src 'self'");
    expect(payload.headers['Content-Security-Policy']).toContain('https://api.nexushub.me');
    expect(payload.headers['Content-Security-Policy']).toContain('https://*.nexushub-landing.pages.dev');
    expect(payload.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(JSON.stringify(payload)).not.toContain('PORTAL_TOKEN');
  });

  it('serves the forgot-password request page and posts to the request API', () => {
    const dir = createTempPortalDir();
    fs.mkdirSync(path.join(dir, 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'auth', 'forgot-password.html'),
      '<html><form><input type="email"></form><script>fetch("/api/v1/auth/password-reset/request")</script></html>',
    );
    const { payload, res } = makeResponse();

    createForgotPasswordPageHandler(dir)({}, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.contentType).toBe('html');
    expect(payload.body).toContain('/api/v1/auth/password-reset/request');
    expect(payload.headers['Cache-Control']).toBe('no-cache, no-store, must-revalidate');
    expect(payload.headers['Content-Security-Policy']).toContain("form-action 'self'");
    expect(payload.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });

  it('points the user login forgot-password entry at the request page', () => {
    const htmlPath = path.resolve(__dirname, '../../src/portal/user-login.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    expect(html).toContain('href="/auth/forgot-password"');
    expect(html).not.toContain('href="/auth/password-reset">Forgot password?');
  });

  it('keeps portal Stripe Nexus Points note fields bounded and alert rendering escaped', () => {
    const htmlPath = path.resolve(__dirname, '../../src/portal/portal.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    expect(html).toContain('id="slideout-points-note"');
    expect(html).toContain('maxlength="280"');
    expect(html).toContain("esc(a.title)");
    expect(html).toContain("esc(a.userImpact || a.detail || '—')");
    expect(html).toContain("esc(a.source)");
    expect(html).toContain("esc(a.lastDeliveryError)");
  });

  it('renders owner-only daily/monthly AI budgets, overrides, automation share, and deferrals', () => {
    const htmlPath = path.resolve(__dirname, '../../src/portal/portal.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    expect(html).toContain('AI Plan Budgets');
    expect(html).toContain('Effective plan: ');
    expect(html).toContain('>Tier <span class="sort-arrow">');
    expect(html).toContain("apiFetch('/api/users/' + user.id + '/ai-budget')");
    expect(html).toContain('id="slideout-ai-daily"');
    expect(html).toContain('id="slideout-ai-monthly"');
    expect(html).toContain('Automation · daily');
    expect(html).toContain('Recent skip reasons');
    expect(html).toContain('monthly_ai_cost_limit_usd: monthly');
    expect(html).toContain("const fixedZero = id === 'free'");
    expect(html).toContain('Free AI budget is fixed at zero');
  });

  it('user login page includes live Apple and Google browser sign-in flows', () => {
    const htmlPath = path.resolve(__dirname, '../../src/portal/user-login.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    expect(html).toContain('/api/v1/auth/register/google/start');
    expect(html).toContain('/api/v1/auth/register/google/finish');
    expect(html).toContain('/api/v1/auth/register/apple/start');
    expect(html).toContain('/api/v1/auth/register/apple/finish');
    expect(html).toContain('appleAuthCode');
    expect(html).not.toContain('Apple web sign-in is not configured for this browser page yet');
  });

  it('returns stable missing-file errors for build-output problems', () => {
    const dir = createTempPortalDir();
    const { payload: dashboardPayload, res: dashboardRes } = makeResponse();
    const { payload: landingPayload, res: landingRes } = makeResponse();

    createAdminDashboardHandler(dir)({}, dashboardRes);
    createLandingPreviewHandler(dir)({}, landingRes);

    expect(dashboardPayload.statusCode).toBe(503);
    expect(dashboardPayload.body).toBe('Dashboard not found — portal.html is missing');
    expect(landingPayload.statusCode).toBe(503);
    expect(String(landingPayload.body)).toContain('Landing preview not found');
  });
});
