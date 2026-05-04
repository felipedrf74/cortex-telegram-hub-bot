// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

export function applyPortalDashboardSecurityHeaders(res: Response): void {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'",
  );
}

export function createLandingPreviewHandler(portalDir = __dirname) {
  return (_req: Request, res: Response): void => {
    const landingPath = path.join(portalDir, 'landing.html');
    if (fs.existsSync(landingPath)) {
      // No edge caching on the preview — devs always want the latest.
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.type('html').send(fs.readFileSync(landingPath, 'utf-8'));
      return;
    }
    res.status(503).send('Landing preview not found — run `npm run build` to copy landing.html into dist/');
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
    // posts JSON back to the same origin. We allow inline script+style
    // because the page intentionally ships zero external assets — every
    // byte is in the file so a stressed user resetting their password
    // never sees a "could not load fonts.googleapis.com" failure.
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; "
      + "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
      + "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; "
      + "base-uri 'none'",
    );

    res.type('html').send(fs.readFileSync(htmlPath, 'utf-8'));
  };
}

export function registerPortalStaticRoutes(app: Express, portalDir = __dirname): void {
  app.get('/landing-preview', createLandingPreviewHandler(portalDir));

  const servePasswordResetPage = createPasswordResetPageHandler(portalDir);
  app.get('/auth/password-reset', servePasswordResetPage);

  const serveAdminDashboard = createAdminDashboardHandler(portalDir);
  app.get('/', serveAdminDashboard);
  app.get('/admin', serveAdminDashboard);
  app.get('/portal', serveAdminDashboard);
}
