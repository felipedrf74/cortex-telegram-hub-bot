// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Connections route — token-zero read of the user's OAuth provider list.
 *
 * SECURITY: This endpoint MUST NEVER expose access tokens, refresh tokens,
 * or any credential material. `oauth-store.getUserConnections()` already
 * filters to safe metadata only ({ provider, connectedAt, scopes }) — do
 * NOT bypass it by reading from the user_oauth_tokens table directly.
 *
 * Response shape:
 *   - `connections[]`  — legacy per-user OAuth list. Keep backward-compatible
 *                        with existing iOS builds.
 *   - `availability[]` — legacy per-provider availability (not configured,
 *                        coming soon, or bare `available: true`). Unchanged.
 *   - `integrations[]` — Gap 6 canonical per-provider status (one row per
 *                        connectable provider, reflecting Garmin lifecycle
 *                        states and probe-derived degradation). iOS migrates
 *                        to this field when ready; portal can adopt
 *                        immediately.
 *   - `capabilities`   — derived boolean flags (mail/calendar/tasks/health)
 *                        computed from the canonical states so UI code
 *                        doesn't need to re-implement the mapping.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { disconnectProvider, getUserConnections, type OAuthProvider } from '../../services/oauth-store';
import { getDb } from '../../services/database';
import { config } from '../../config';
import { sendSuccess, sendInternalError, sendError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';
import {
  getIntegrationSummary,
  capabilitiesForProvider,
} from '../../services/integration-status';
import { hasActiveGarminConnection } from '../../services/garmin-session-store';
import { revokeThirdPartyOAuthTokenForProvider } from '../../services/user-data-export';

type ConnectionAvailability = {
  provider: string;
  available: boolean;
  capabilities: string[];
  reasonCode?: 'NOT_CONFIGURED' | 'COMING_SOON';
  detail?: string;
};

type RevocableConnectionProvider = OAuthProvider | 'garmin';

const REVOCABLE_PROVIDERS = new Set<string>([
  'google',
  'outlook',
  'strava',
  'whoop',
  'fitbit',
  'todoist',
  'notion',
  'garmin',
]);

function normalizeRevocableProvider(value: unknown): RevocableConnectionProvider | null {
  if (typeof value !== 'string') return null;
  const provider = value.trim().toLowerCase();
  return REVOCABLE_PROVIDERS.has(provider) ? provider as RevocableConnectionProvider : null;
}

function hasLocalConnection(userId: number, provider: RevocableConnectionProvider): boolean {
  const db = getDb();
  try {
    if (provider === 'garmin') {
      const session = db.prepare('SELECT 1 FROM garmin_sessions WHERE user_id = ? LIMIT 1').get(userId);
      if (session) return true;
      const token = db.prepare('SELECT 1 FROM garmin_user_tokens WHERE user_id = ? LIMIT 1').get(userId);
      return !!token;
    }
    return !!db.prepare('SELECT 1 FROM user_oauth_tokens WHERE user_id = ? AND provider = ? LIMIT 1').get(userId, provider);
  } catch {
    return false;
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
      capabilities: capabilitiesForProvider(provider as any),
      reasonCode: 'COMING_SOON',
      detail: 'WHOOP support is coming soon in this iOS release.',
    };
  }

  const available = oauthConfigured(provider);
  if (available) {
    return {
      provider,
      available: true,
      capabilities: capabilitiesForProvider(provider as any),
    };
  }

  return {
    provider,
    available: false,
    capabilities: capabilitiesForProvider(provider as any),
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
      // Legacy shape: raw oauth-store entries + ad-hoc Garmin row.
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

      if (
        garmin?.status === 'active'
        && hasActiveGarminConnection(userId)
        && !connections.some((c) => c.provider === 'garmin')
      ) {
        const connectedAt = garmin.connected_at || new Date().toISOString();
        connections.push({
          provider: 'garmin',
          connectedAt,
          lastReauthedAt: connectedAt,
          scopes: ['activities', 'sleep', 'readiness'],
        });
      }

      // Canonical shape (Gap 6): one entry per connectable provider with a
      // closed-set state, including Garmin lifecycle states
      // (needs_reauth/mfa_pending/expired) that the legacy `connections[]`
      // array silently hides.
      const summary = getIntegrationSummary(userId);

      sendSuccess(res, {
        connections: connections.map((c) => ({
          provider: c.provider,
          connectedAt: c.connectedAt,
          scopes: c.scopes,
          capabilities: capabilitiesForProvider(c.provider as any, c.scopes),
        })),
        count: connections.length,
        availability: [
          buildAvailability('google'),
          buildAvailability('outlook'),
          buildAvailability('garmin'),
          buildAvailability('strava'),
          buildAvailability('whoop'),
        ],
        integrations: summary.providers,
        counts: summary.counts,
        capabilities: summary.capabilities,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS connections list failed');
      sendInternalError(res, 'Unable to load connections right now.');
    }
  }));

  /**
   * DELETE /api/v1/connections/:provider
   * Best-effort provider revoke + deterministic local disconnect.
   */
  router.delete('/:provider', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const provider = normalizeRevocableProvider(req.params.provider);
    if (!provider) {
      return sendError(res, 'BAD_REQUEST', 'Unsupported connection provider.', 400);
    }

    try {
      const connectedBefore = hasLocalConnection(userId, provider);
      const revocation = await revokeThirdPartyOAuthTokenForProvider(userId, provider);
      if (provider !== 'garmin') {
        disconnectProvider(userId, provider);
      }
      clearTaskSyncStateForConnection(userId, provider);
      sendSuccess(res, {
        provider,
        disconnected: true,
        connectedBefore,
        revocation,
      });
    } catch (err: any) {
      logger.error({ err, userId, provider }, 'iOS connection revoke failed');
      sendInternalError(res, 'Unable to disconnect this provider right now.');
    }
  }));

  return router;
}

/**
 * Drop the task-provider sync-state row when its OAuth connection goes away,
 * so freshness/providerStates never report a stale 'connected' for a
 * disconnected provider. Task rows, links, and the mutation ledger are
 * intentionally untouched (keep-local disconnect policy).
 */
function clearTaskSyncStateForConnection(userId: number, provider: string): void {
  const taskProvider = provider === 'outlook' ? 'ms_todo' : provider === 'todoist' ? 'todoist' : null;
  if (!taskProvider) return;
  try {
    getDb().prepare(
      'DELETE FROM task_sync_state WHERE user_id = ? AND provider = ?',
    ).run(userId, taskProvider);
  } catch (err) {
    logger.warn({ err, userId, provider }, 'Task sync-state cleanup on disconnect failed (non-fatal)');
  }
}
