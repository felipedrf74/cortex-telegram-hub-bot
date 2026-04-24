import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminDashboardHandler,
  createLandingPreviewHandler,
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

    expect(Array.from(routes.keys())).toEqual([
      '/landing-preview',
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
