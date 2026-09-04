// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../api/rate-limiter';

export function applyPortalDashboardSecurityHeaders(res: Response): void {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'",
  );
}

const UI_MODULE_NAME = /^[a-z0-9-]+\.(js|css)$/;

/**
 * Serves the admin SPA's ES modules and stylesheet from `src/portal/ui/*.{js,css}`
 * (copied to `dist/portal/ui` at build time). Allowlisted basenames only — no
 * traversal, no directory listing.
 */
export function createPortalUiModuleHandler(portalDir = __dirname) {
  return (req: Request, res: Response): void => {
    const file = String(req.params.file || '');
    if (!UI_MODULE_NAME.test(file)) {
      res.status(404).type('text').send('Not found');
      return;
    }
    const modulePath = path.join(portalDir, 'ui', file);
    if (!fs.existsSync(modulePath)) {
      res.status(404).type('text').send('Not found');
      return;
    }
    res.set('Cache-Control', 'no-cache');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8').send(fs.readFileSync(modulePath, 'utf-8'));
  };
}

export function createLandingPreviewHandler(portalDir = __dirname) {
  return (_req: Request, res: Response): void => {
    const landingPath = path.join(portalDir, 'landing.html');
    if (fs.existsSync(landingPath)) {
      // No edge caching on the preview — devs always want the latest.
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      // The marketing page still uses inline handlers; keep its own CSP now that
      // the dashboard-wide policy no longer allows inline scripts.
      res.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://api.nexushub.me https://*.nexushub-landing.pages.dev; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      res.type('html').send(fs.readFileSync(landingPath, 'utf-8'));
      return;
    }
    res.status(503).send('Landing preview not found — run `npm run build` to copy landing.html into dist/');
  };
}

export function createUserLoginHandler(portalDir = __dirname) {
  return (_req: Request, res: Response): void => {
    const htmlPath = path.join(portalDir, 'user-login.html');
    if (!fs.existsSync(htmlPath)) {
      res.status(503).send('User login page not deployed — run `npm run build`.');
      return;
    }

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; "
      + "style-src 'self'; img-src 'self' data:; "
      + "connect-src 'self' https://api.nexushub.me https://*.nexushub-landing.pages.dev; "
      + "form-action 'self'; frame-ancestors 'none'; "
      + "base-uri 'none'",
    );

    res.type('html').send(fs.readFileSync(htmlPath, 'utf-8'));
  };
}

export function createAdminDashboardHandler(portalDir = __dirname) {
  return (_req: Request, res: Response): void => {
    const htmlPath = path.join(portalDir, 'portal.html');
    if (!fs.existsSync(htmlPath)) {
      res.status(503).send('Dashboard not found — portal.html is missing');
      return;
    }

    applyPortalDashboardSecurityHeaders(res);

    // Never inject the portal token into HTML. The admin authenticates through
    // localStorage/prompted bearer credentials; injecting it would turn XSS into
    // admin escalation.
    res.type('html').send(fs.readFileSync(htmlPath, 'utf-8'));
  };
}

/**
 * Public, unauthenticated password-reset destination page.
 *
 * Shipped 2026-05-04 to close the AUTH-O2 follow-up gap: the
 * `/api/v1/auth/password-reset/request` route generates an email with a
 * link of the form `${PASSWORD_RESET_BASE_URL}/auth/password-reset?token=…`,
 * but no destination existed at that path. Locked-out email/password users
 * had no recovery path.
 *
 * Two design choices worth keeping in mind for future edits:
 *
 *   1. **Same origin as the API.** The page POSTs back to
 *      `/api/v1/auth/password-reset/confirm` on the same host, which
 *      avoids the CORS preflight + allowlist surface.
 *
 *   2. **No auth, no token in URL persistence.** The route is fully
 *      anonymous (the user is locked out by definition). The HTML
 *      strips the `?token=` query string from `history` after reading
 *      it client-side so a screenshot/shoulder-surf doesn't leak the
 *      single-use credential.
 *
 * If `app.nexushub.me` (or another user-facing web origin) ships later,
 * point `PASSWORD_RESET_BASE_URL` at it and this backend route can stay
 * in place as the always-on fallback.
 */
export function createPasswordResetPageHandler(portalDir = __dirname) {
  return (_req: Request, res: Response): void => {
    const htmlPath = path.join(portalDir, 'auth', 'password-reset.html');
    if (!fs.existsSync(htmlPath)) {
      res.status(503).send('Password reset page not deployed — run `npm run build`.');
      return;
    }

    // Restrictive CSP suitable for a static, single-form HTML page that
    // posts JSON back to the same origin. The page depends on exactly two
    // same-origin assets (/portal/ui/auth-password-reset.js and .css, served
    // by the allowlisted UI asset route) and nothing external, so a stressed
    // user resetting their password never sees a "could not load
    // fonts.googleapis.com" failure; script-src and style-src stay 'self'.
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; "
      + "style-src 'self'; img-src 'self' data:; "
      + "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; "
      + "base-uri 'none'",
    );

    res.type('html').send(fs.readFileSync(htmlPath, 'utf-8'));
  };
}

export function createForgotPasswordPageHandler(portalDir = __dirname) {
  return (_req: Request, res: Response): void => {
    const htmlPath = path.join(portalDir, 'auth', 'forgot-password.html');
    if (!fs.existsSync(htmlPath)) {
      res.status(503).send('Forgot password page not deployed — run `npm run build`.');
      return;
    }

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; "
      + "style-src 'self'; img-src 'self' data:; "
      + "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; "
      + "base-uri 'none'",
    );

    res.type('html').send(fs.readFileSync(htmlPath, 'utf-8'));
  };
}

export function createPortalBrandAssetHandler(portalDir = __dirname) {
  return (_req: Request, res: Response): void => {
    const imagePath = path.join(portalDir, 'assets', 'nexus-mark.png');
    if (!fs.existsSync(imagePath)) {
      res.status(404).send('Brand asset not found');
      return;
    }

    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('png').sendFile(imagePath);
  };
}

/**
 * Per-IP ceiling for the module/stylesheet reads. The SPA loads at most a few
 * dozen files per boot, so a generous minute window only trips on scanners.
 */
// The SPA pulls every module and stylesheet with Cache-Control: no-cache on each
// boot, so this ceiling is sized independently of the admin API limit
// (PORTAL_API_RATE_LIMIT): a tightened API limit must never 429 the module
// graph and leave the shell waiting for app.js. The floor stays well above the
// module count so a misconfigured value cannot brick sign-in either.
export const PORTAL_ASSET_RATE_LIMIT_DEFAULT = 1200;
export const PORTAL_ASSET_RATE_LIMIT_FLOOR = 600;
export function resolvePortalAssetRateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.PORTAL_ASSET_RATE_LIMIT ?? '', 10);
  if (!Number.isFinite(configured) || configured <= 0) return PORTAL_ASSET_RATE_LIMIT_DEFAULT;
  return Math.max(configured, PORTAL_ASSET_RATE_LIMIT_FLOOR);
}
export function createPortalUiModuleRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: resolvePortalAssetRateLimit(),
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      res.setHeader('Retry-After', Math.max(1, Math.ceil(options.windowMs / 1000)));
      res.status(options.statusCode).type('text/plain').send('Too many portal asset requests from this IP. Slow down.');
    },
  });
}

export function registerPortalStaticRoutes(app: Express, portalDir = __dirname): void {
  app.get('/assets/nexus-mark.png', createPortalBrandAssetHandler(portalDir));
  app.get('/portal/ui/:file', createPortalUiModuleRateLimiter(), createPortalUiModuleHandler(portalDir));

  app.get('/landing-preview', createLandingPreviewHandler(portalDir));

  const serveForgotPasswordPage = createForgotPasswordPageHandler(portalDir);
  app.get('/auth/forgot-password', serveForgotPasswordPage);

  const servePasswordResetPage = createPasswordResetPageHandler(portalDir);
  app.get('/auth/password-reset', servePasswordResetPage);

  const serveUserLoginPage = createUserLoginHandler(portalDir);
  app.get('/user', serveUserLoginPage);
  app.get('/login', serveUserLoginPage);
  app.get('/app', serveUserLoginPage);

  const serveAdminDashboard = createAdminDashboardHandler(portalDir);
  app.get('/', serveAdminDashboard);
  app.get('/admin', serveAdminDashboard);
  app.get('/portal', serveAdminDashboard);
}
