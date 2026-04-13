// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Connections route — token-zero read of the user's OAuth provider list.
 *
 * SECURITY: This endpoint MUST NEVER expose access tokens, refresh tokens,
 * or any credential material. `oauth-store.getUserConnections()` already
 * filters to safe metadata only ({ provider, connectedAt, scopes }) — do
 * NOT bypass it by reading from the user_oauth_tokens table directly.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { getUserConnections } from '../../services/oauth-store';
import { getDb } from '../../services/database';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';

export function connectionRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/connections
   * Returns the list of OAuth providers the authenticated user has connected.
   * Each entry includes provider name, connection timestamp, and scopes.
   * Tokens are NEVER returned.
   */
  router.get('/', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    try {
      const connections = getUserConnections(userId);
      const db = getDb();
      const garmin = db.prepare(`
        SELECT
          garmin_email,
          status,
          COALESCE(last_refresh, last_used, updated_at) AS connected_at
        FROM garmin_user_tokens
        WHERE user_id = ?
      `).get(userId) as {
        garmin_email?: string | null;
        status?: string | null;
        connected_at?: string | null;
      } | undefined;

      if (garmin?.status === 'active' && !connections.some((c) => c.provider === 'garmin')) {
        connections.push({
          provider: 'garmin',
          connectedAt: garmin.connected_at || new Date().toISOString(),
          scopes: ['activities', 'sleep', 'readiness'],
        });
      }

      sendSuccess(res, {
        connections: connections.map((c) => ({
          provider: c.provider,
          connectedAt: c.connectedAt,
          scopes: c.scopes,
        })),
        count: connections.length,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS connections list failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch connections', 500);
    }
  }));

  return router;
}
