// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-DATA-007 (2026-04-24) — consolidated integration status view.
 *
 * Joins two existing tables that separately knew "who's connected"
 * and "is the platform-level probe green":
 *
 *   user_oauth_tokens  — per-user connections (created_at,
 *                        updated_at, expires_at, scopes, provider)
 *                        owned by oauth-store
 *
 *   integration_health — platform-wide probe results (latest per
 *                        provider: status, ts, error_message)
 *                        owned by integration-health
 *
 * The result is what the /workspace/integrations endpoint surfaces
 * and what the Integrations page of the User Console renders.
 * Every provider the product supports (see ALL_PROVIDERS below)
 * gets a row — connected and unconnected alike — so the page
 * doubles as a list of "what you CAN connect" + "what you HAVE
 * connected".
 *
 * Non-goals here:
 *   - Triggering a sync / refresh (read-only view)
 *   - Per-tenant rollups (cross-tenant aggregates live on the Admin
 *     Console side, tracked as OI-ADM-305)
 *   - Token refresh (oauth-store.updateAccessToken owns that)
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { getLatestHealthByProvider, type ProbeStatus } from './integration-health';

/**
 * The complete set of providers the User Console's Integrations
 * page surfaces. Must stay in sync with OAuthProvider in oauth-store
 * PLUS any non-OAuth providers we want to expose (currently just
 * garmin — it auths directly, not via OAuth2, but the integration-
 * health probe + iOS UI treat it uniformly with the rest).
 *
 * Order is the display order on the UI — OAuth providers grouped
 * first (most common), garmin at the end (rarer, direct-auth).
 */
export const ALL_PROVIDERS = [
  'google',
  'outlook',
  'notion',
  'todoist',
  'strava',
  'whoop',
  'fitbit',
  'garmin',
] as const;

export type IntegrationProvider = typeof ALL_PROVIDERS[number];

/**
 * One row per provider in the UI. Both halves (OAuth row + health
 * probe) are nullable because:
 *   - a provider might be probed by health but not yet connected by
 *     the user (health.status = 'skipped' | 'ok' + connected=false)
 *   - a user might be connected to a provider the health probe
 *     doesn't yet cover (connected=true + healthStatus='unknown')
 *
 * `expiresAt` is the OAuth token expiry — ISO-8601 UTC. null when
 * disconnected OR when the provider issues non-expiring refresh
 * tokens (most do). `healthCheckedAt` is the ts of the latest
 * probe; null if never probed.
 */
export interface IntegrationStatus {
  provider: IntegrationProvider;
  connected: boolean;
  connectedAt: string | null;
  expiresAt: string | null;
  scopes: string[];
  healthStatus: ProbeStatus | 'unknown';
  healthCheckedAt: string | null;
  healthError: string | null;
}

interface OAuthRow {
  provider: string;
  created_at: string;
  expires_at: string | null;
  scopes: string | null;
}

/**
 * Read this user's rows from user_oauth_tokens. Returns a map keyed
 * on provider so we can do O(1) lookups when merging with the
 * provider allowlist. Wrapped in try/catch — a DB error here falls
 * back to "nothing connected"; the UI still renders a meaningful
 * "connect these" list.
 */
function readOAuthRowsByProvider(userId: number): Map<string, OAuthRow> {
  const out = new Map<string, OAuthRow>();
  if (!Number.isFinite(userId) || userId <= 0) return out;
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT provider, created_at, expires_at, scopes
       FROM user_oauth_tokens
       WHERE user_id = ?`,
    ).all(userId) as OAuthRow[];
    for (const r of rows) {
      out.set(r.provider, r);
    }
  } catch (err) {
    logger.warn(
      { err, userId },
      'integrations-view: user_oauth_tokens read failed — treating as disconnected',
    );
  }
  return out;
}

/**
 * Parse a scopes JSON blob defensively. oauth-store writes a
 * `JSON.stringify(scopes)` array but the DB column is TEXT, so a
 * malformed row shouldn't crash the view. Matches oauth-store's
 * own `JSON.parse(r.scopes || '[]')` behavior.
 */
function parseScopes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The entry point used by the /workspace/integrations route and (in
 * the future) the Admin Console's per-tenant rollup. Always returns
 * ALL_PROVIDERS.length rows — disconnected providers included, so
 * the UI can render them as "connect" call-to-actions.
 *
 * Deterministic order (ALL_PROVIDERS) so the UI doesn't re-shuffle
 * the grid between requests.
 */
export function listUserIntegrations(userId: number): IntegrationStatus[] {
  const oauthByProvider = readOAuthRowsByProvider(userId);
  // getLatestHealthByProvider is already try/catch'd internally
  // (returns {} on DB error), so we don't need our own guard here.
  const healthByProvider = getLatestHealthByProvider();

  return ALL_PROVIDERS.map((provider) => {
    const oauth = oauthByProvider.get(provider);
    const health = healthByProvider[provider];
    return {
      provider,
      connected: Boolean(oauth),
      connectedAt: oauth?.created_at ?? null,
      expiresAt: oauth?.expires_at ?? null,
      scopes: parseScopes(oauth?.scopes ?? null),
      healthStatus: (health?.status ?? 'unknown') as ProbeStatus | 'unknown',
      healthCheckedAt: health?.ts ?? null,
      healthError: health?.errorMessage ?? null,
    };
  });
}
