// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression pins for OI-NAV-201 — promoting /admin-console → /admin
 * (2026-04-24). Three invariants must hold simultaneously:
 *
 *   1. GET /admin serves admin-console.html (NOT portal.html) with
 *      the same security headers as the legacy dashboard handler.
 *   2. GET /admin-console returns a 301 redirect to /admin.
 *   3. GET /portal still serves portal.html (legacy bookmark
 *      preservation — users who explicitly want the old UI).
 *
 * Also pins the cross-console link update in user-console.html so a
 * later refactor can't regress the button target back to
 * /admin-console (which would still work via the redirect, but
 * would leak a 301 hop on every click).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminConsoleShellHandler,
  createAdminDashboardHandler,
  registerPortalStaticRoutes,
} from '../../src/portal/static-routes';

type RouteHandler = (req: unknown, res: any) => void;

let tempDirs: string[] = [];

function createTempPortalDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-admin-nav-201-'));
  tempDirs.push(dir);
  return dir;
}

function makeResponse() {
  const payload = {
    statusCode: 200,
    body: undefined as unknown,
    contentType: undefined as string | undefined,
    redirectedTo: undefined as string | undefined,
    redirectStatus: undefined as number | undefined,
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
    redirect: vi.fn((statusOrLocation: number | string, location?: string) => {
      if (typeof statusOrLocation === 'number' && typeof location === 'string') {
        payload.redirectStatus = statusOrLocation;
        payload.redirectedTo = location;
      } else if (typeof statusOrLocation === 'string') {
        payload.redirectStatus = 302;
        payload.redirectedTo = statusOrLocation;
      }
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

describe('OI-NAV-201 — /admin serves the new Admin Console shell', () => {
  it('createAdminConsoleShellHandler serves admin-console.html with security headers', () => {
    const dir = createTempPortalDir();
    fs.writeFileSync(path.join(dir, 'admin-console.html'), '<html>new admin console</html>');
    const { payload, res } = makeResponse();

    createAdminConsoleShellHandler(dir)({}, res);

    expect(payload.statusCode).toBe(200);
    expect(payload.contentType).toBe('html');
    expect(payload.body).toBe('<html>new admin console</html>');
    // Same security headers as the legacy dashboard handler.
    expect(payload.headers['Cache-Control']).toBe('no-cache, no-store, must-revalidate');
    expect(payload.headers['X-Frame-Options']).toBe('DENY');
    expect(payload.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(payload.headers['Content-Security-Policy']).toContain("default-src 'self'");
  });

  it('returns 503 with a clear message when admin-console.html is missing', () => {
    const dir = createTempPortalDir();
    const { payload, res } = makeResponse();

    createAdminConsoleShellHandler(dir)({}, res);

    expect(payload.statusCode).toBe(503);
    expect(String(payload.body)).toContain('admin-console.html is missing');
  });
});

describe('OI-NAV-201 — route registration topology', () => {
  it('registers /admin pointing at the admin console shell, NOT the legacy dashboard', () => {
    const dir = createTempPortalDir();
    fs.writeFileSync(path.join(dir, 'portal.html'), '<html>LEGACY</html>');
    fs.writeFileSync(path.join(dir, 'admin-console.html'), '<html>NEW_CONSOLE</html>');

    const routes = new Map<string, RouteHandler>();
    const app = {
      get: vi.fn((route: string, handler: RouteHandler) => {
        routes.set(route, handler);
      }),
    };

    registerPortalStaticRoutes(app as any, dir);

    expect(routes.has('/admin')).toBe(true);
    const { payload, res } = makeResponse();
    routes.get('/admin')!({}, res);

    expect(payload.body).toBe('<html>NEW_CONSOLE</html>');
    expect(payload.body).not.toContain('LEGACY');
  });

  it('/portal still serves the legacy dashboard (bookmark preservation)', () => {
    const dir = createTempPortalDir();
    fs.writeFileSync(path.join(dir, 'portal.html'), '<html>LEGACY</html>');
    fs.writeFileSync(path.join(dir, 'admin-console.html'), '<html>NEW</html>');

    const routes = new Map<string, RouteHandler>();
    const app = {
      get: vi.fn((route: string, handler: RouteHandler) => {
        routes.set(route, handler);
      }),
    };

    registerPortalStaticRoutes(app as any, dir);

    expect(routes.has('/portal')).toBe(true);
    const { payload, res } = makeResponse();
    routes.get('/portal')!({}, res);

    expect(payload.body).toBe('<html>LEGACY</html>');
  });

  it('/ (root) still serves the legacy dashboard — landing UX is a separate decision', () => {
    // OI-NAV-201 explicitly scoped the flip to /admin. Changing /
    // would affect the public landing experience + unauthenticated
    // probing, which is out of scope here.
    const dir = createTempPortalDir();
    fs.writeFileSync(path.join(dir, 'portal.html'), '<html>LEGACY</html>');
    fs.writeFileSync(path.join(dir, 'admin-console.html'), '<html>NEW</html>');

    const routes = new Map<string, RouteHandler>();
    const app = {
      get: vi.fn((route: string, handler: RouteHandler) => {
        routes.set(route, handler);
      }),
    };

    registerPortalStaticRoutes(app as any, dir);

    expect(routes.has('/')).toBe(true);
    const { payload, res } = makeResponse();
    routes.get('/')!({}, res);

    expect(payload.body).toBe('<html>LEGACY</html>');
  });

  it('does NOT register /admin-console as a static route (it lives in server.ts as a redirect)', () => {
    const dir = createTempPortalDir();
    const routes = new Map<string, RouteHandler>();
    const app = {
      get: vi.fn((route: string, handler: RouteHandler) => {
        routes.set(route, handler);
      }),
    };

    registerPortalStaticRoutes(app as any, dir);

    expect(routes.has('/admin-console')).toBe(false);
  });
});

describe('OI-NAV-201 — /admin-console 301 redirect (in server.ts)', () => {
  // server.ts inlines the redirect handler to avoid importing the
  // whole server bootstrap (which pulls in database + express + a
  // lot else). We pin the handler by structural grep instead.
  it('server.ts declares /admin-console as a 301 redirect to /admin', () => {
    const serverSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/server.ts'),
      'utf-8',
    );
    expect(serverSrc).toMatch(
      /app\.get\(['"]\/admin-console['"],[\s\S]*?res\.redirect\(301,\s*['"]\/admin['"]\)/,
    );
  });

  it('server.ts does NOT serve admin-console.html directly at /admin-console anymore', () => {
    const serverSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/server.ts'),
      'utf-8',
    );
    // The old inline serveShell('admin-console.html') binding at
    // /admin-console would bypass /admin — verify it's gone.
    expect(serverSrc).not.toMatch(
      /app\.get\(['"]\/admin-console['"],\s*serveShell\(['"]admin-console\.html['"]\)\)/,
    );
  });
});

describe('OI-NAV-201 — user-console.html switcher points to /admin, not /admin-console', () => {
  it('Admin Console switch button now targets /admin', () => {
    const userConsole = fs.readFileSync(
      path.resolve(__dirname, '../../src/portal/user-console.html'),
      'utf-8',
    );
    // Both the OLD location (with admin-console) MUST NOT appear
    // AND the new (with /admin) MUST appear.
    expect(userConsole).toMatch(
      /class="switch" onclick="location\.href='\/admin'">↗ Admin Console/,
    );
    expect(userConsole).not.toMatch(
      /class="switch" onclick="location\.href='\/admin-console'">↗ Admin Console/,
    );
  });
});
