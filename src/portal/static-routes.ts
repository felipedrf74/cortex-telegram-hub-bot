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

export function registerPortalStaticRoutes(app: Express, portalDir = __dirname): void {
  app.get('/landing-preview', createLandingPreviewHandler(portalDir));

  const serveAdminDashboard = createAdminDashboardHandler(portalDir);
  app.get('/', serveAdminDashboard);
  app.get('/admin', serveAdminDashboard);
  app.get('/portal', serveAdminDashboard);
}
