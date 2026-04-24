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
import { config } from '../../config';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

type ConnectionAvailability = {
  provider: string;
  available: boolean;
  capabilities: string[];
  reasonCode?: 'NOT_CONFIGURED' | 'COMING_SOON';
  detail?: string;
};

function capabilitiesForProvider(provider: string, scopes: string[] = []): string[] {
  const normalizedScopes = scopes.map((scope) => scope.toLowerCase());
  const hasScope = (matcher: (scope: string) => boolean) => normalizedScopes.some(matcher);

  switch (provider) {
    case 'google': {
      const capabilities = [
        hasScope((scope) => scope.includes('calendar')) && 'calendar',
        hasScope((scope) => scope.includes('gmail')) && 'gmail',
      ].filter(Boolean) as string[];
      return capabilities.length > 0 ? capabilities : ['calendar', 'gmail'];
    }
    case 'outlook': {
      const capabilities = [
        hasScope((scope) => scope.includes('calendar')) && 'calendar',
        hasScope((scope) => scope.includes('mail.')) && 'email',
        hasScope((scope) => scope.includes('tasks.')) && 'tasks',
      ].filter(Boolean) as string[];
      return capabilities.length > 0 ? capabilities : ['calendar', 'email', 'tasks'];
    }
    case 'garmin':
      return ['training', 'sleep', 'readiness'];
    case 'strava':
      return ['runs', 'rides', 'load'];
    case 'whoop':
      return ['recovery', 'strain', 'sleep'];
    default:
      return [];
  }
}

function oauthConfigured(provider: string): boolean {
  switch (provider) {
    case 'google':
      return Boolean(config.google.clientId && config.google.clientSecret);
    case 'outlook':
      return Boolean(config.outlook.clientId && config.outlook.clientSecret);
    case 'garmin':
      return true;
    case 'strava':
      return Boolean(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);
    case 'whoop':
      return Boolean(process.env.WHOOP_CLIENT_ID && process.env.WHOOP_CLIENT_SECRET);
    default:
      return false;
  }
}

function buildAvailability(provider: string): ConnectionAvailability {
  if (provider === 'whoop') {
    return {
      provider,
      available: false,
      capabilities: capabilitiesForProvider(provider),
      reasonCode: 'COMING_SOON',
      detail: 'WHOOP support is coming soon in this iOS release.',
    };
  }

  const available = oauthConfigured(provider);
  if (available) {
    return {
      provider,
      available: true,
      capabilities: capabilitiesForProvider(provider),
    };
  }

  return {
    provider,
    available: false,
    capabilities: capabilitiesForProvider(provider),
    reasonCode: 'NOT_CONFIGURED',
    detail: `OAuth is not configured for ${provider} in this environment.`,
  };
}

export function connectionRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'connections_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

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
          capabilities: capabilitiesForProvider(c.provider, c.scopes),
        })),
        count: connections.length,
        availability: [
          buildAvailability('google'),
          buildAvailability('outlook'),
          buildAvailability('garmin'),
          buildAvailability('strava'),
          buildAvailability('whoop'),
        ],
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS connections list failed');
      sendInternalError(res, 'Unable to load connections right now.');
    }
  }));

  return router;
}
