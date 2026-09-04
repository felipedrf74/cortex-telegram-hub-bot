// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Environment / release identity for the operator portal.
 *
 *   GET /api/release — what is running: version, git identity, deploy and
 *                      boot time, migration state, admin exposure mode, and
 *                      which optional ops integrations are configured.
 *
 * Read-scoped (method-based portal auth). The payload carries booleans and
 * identifiers only — never secret values or env contents.
 */

import type { Express, Request, Response } from 'express';
import { getReleaseInfo } from '../services/release-info';
import { sendPortalInternalError } from './http';

interface PortalEnvironmentRouteOptions {
  startedAt: number;
}

export function registerPortalEnvironmentRoutes(app: Express, options: PortalEnvironmentRouteOptions): void {
  app.get('/api/release', (_req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, release: getReleaseInfo({ startedAt: options.startedAt }) });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load release information', 'Portal: release info request failed');
    }
  });
}
