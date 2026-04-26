// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Integration Status — canonical per-user view of every connectable provider.
 *
 * Before this module, the product surfaced integration state through a mix of:
 *   - `oauth-store.isConnected(userId, provider)` → boolean presence of tokens
 *   - `oauth-store.getUserConnections(userId)` → metadata for OAuth-only providers
 *   - `garmin_user_tokens.status` → Garmin-only lifecycle column
 *   - `integration_health` → owner-level probe history (not per-user)
 *   - scattered `isConnected(userId, 'outlook')` / `isConnected(userId, 'google')`
 *     checks inside routers and view-states
 *
 * That patchwork made three failure modes invisible to users:
 *   1. Garmin tokens in `needs_reauth`/`mfa_pending`/`expired` looked like
 *      "not connected" in `/api/v1/connections` — only `active` was surfaced.
 *   2. A user with exactly one connected provider (Gmail only, Outlook only,
 *      or Garmin only) was treated as "partial" by features that silently
 *      assumed both email providers should be present.
 *   3. There was no single source of truth for iOS/portal to render a
 *      provider badge — each screen rolled its own mapping.
 *
 * This module provides a single read-only view that combines all three
 * storage tiers and returns a closed set of states per provider. Callers
 * (iOS payload builders, portal, briefing code) should use
 * `getIntegrationSummary(userId)` instead of ad-hoc `isConnected()` chains
 * whenever the result is shown to the user.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  getUserConnections,
  type OAuthProvider,
} from './oauth-store';

// ─── Canonical types ─────────────────────────────────────────────────

export type IntegrationProvider = OAuthProvider | 'garmin';

export const ALL_INTEGRATION_PROVIDERS: IntegrationProvider[] = [
  'google',
  'outlook',
  'garmin',
  'strava',
  'whoop',
  'fitbit',
  'todoist',
  'notion',
];

/**
 * Closed set of per-provider states. The product UI maps one badge per state.
 *
 *   not_configured → OAuth app credentials missing; user cannot connect at all.
 *   disconnected   → provider is connectable but user hasn't linked it.
 *   pending        → connection started but not complete (Garmin MFA waiting).
 *   connected      → tokens present, no recent failures — healthy.
 *   degraded       → tokens present but recent probes failed ≥ threshold.
 *                    Data may be stale; product should show "limited" copy.
 *   revoked        → tokens present but auth is known-bad (Garmin needs_reauth,
 *                    Garmin expired, Google/Outlook invalid_grant surfaced
 *                    through integration_health error messages). User must
 *                    re-auth before the integration recovers.
 *   coming_soon    → provider exists in the registry but is not launched
 *                    to end users (WHOOP today).
 */
export type IntegrationState =
  | 'not_configured'
  | 'disconnected'
  | 'pending'
  | 'connected'
  | 'degraded'
  | 'revoked'
  | 'coming_soon';

export type IntegrationReasonCode =
  | 'NOT_CONFIGURED'
  | 'COMING_SOON'
  | 'NEEDS_REAUTH'
  | 'MFA_PENDING'
  | 'EXPIRED'
  | 'PROBE_FAILING'
  | 'TOKEN_EXPIRED';

export interface ProviderIntegrationStatus {
  provider: IntegrationProvider;
  state: IntegrationState;
  connectedAt: string | null;
  scopes: string[];
  capabilities: string[];
  reasonCode?: IntegrationReasonCode;
  detail?: string;
  lastCheckedAt?: string | null;
}

export interface IntegrationCapabilityFlags {
  /** User can read/send email through at least one non-revoked provider. */
  mail: boolean;
  /** User has at least one non-revoked calendar source. */
  calendar: boolean;
  /** User has at least one non-revoked task provider beyond the native one. */
  externalTasks: boolean;
  /** User has at least one non-revoked wearable/health integration. */
  health: boolean;
}

export interface IntegrationSummary {
  providers: ProviderIntegrationStatus[];
  counts: {
    connected: number;
    degraded: number;
    revoked: number;
    pending: number;
    disconnected: number;
  };
  capabilities: IntegrationCapabilityFlags;
}

// ─── Provider configuration helpers ──────────────────────────────────

function isProviderConfigured(provider: IntegrationProvider): boolean {
  switch (provider) {
    case 'google':
      return Boolean(config.google.clientId && config.google.clientSecret);
    case 'outlook':
      return Boolean(config.outlook.clientId && config.outlook.clientSecret);
    case 'garmin':
      // Garmin uses garth (username/password + MFA); no OAuth app required.
      return true;
    case 'strava':
      return Boolean(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);
    case 'whoop':
      // Always configured at the OAuth-app level today, but coming_soon blocks
      // it from being user-facing. We keep this as `true` so the state machine
      // routes through `coming_soon` explicitly rather than `not_configured`.
      return Boolean(process.env.WHOOP_CLIENT_ID && process.env.WHOOP_CLIENT_SECRET);
    case 'fitbit':
      return Boolean(process.env.FITBIT_CLIENT_ID && process.env.FITBIT_CLIENT_SECRET);
    case 'todoist':
      return Boolean(process.env.TODOIST_CLIENT_ID && process.env.TODOIST_CLIENT_SECRET);
    case 'notion':
      return Boolean(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET);
    default:
      return false;
  }
}

function isComingSoon(provider: IntegrationProvider): boolean {
  // WHOOP is the only provider gated behind a coming-soon flag today. Keep
  // this centralized so iOS and portal agree on which badge to render.
  return provider === 'whoop';
}

/**
 * Human-readable capabilities per provider. Scope-aware for Google + Outlook
 * so a user who granted calendar-only scope doesn't see "gmail" in the badge.
 */
export function capabilitiesForProvider(
  provider: IntegrationProvider,
  scopes: string[] = [],
): string[] {
  const normalizedScopes = scopes.map((scope) => scope.toLowerCase());
  const hasScope = (matcher: (scope: string) => boolean) =>
    normalizedScopes.some(matcher);

  switch (provider) {
    case 'google': {
      const capabilities = [
        hasScope((scope) => scope.includes('calendar')) && 'calendar',
        hasScope((scope) => scope.includes('gmail')) && 'gmail',
        hasScope((scope) => scope.includes('drive')) && 'drive',
      ].filter(Boolean) as string[];
      // Fall back to the conservative default when scopes are missing
      // (happens for the owner-bootstrap path where scopes aren't persisted).
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
      // Kept in sync with the legacy `capabilitiesForProvider` list so iOS
      // clients that expected exactly these three labels don't have to
      // handle a new string before Gap 6 ships.
      return ['training', 'sleep', 'readiness'];
    case 'strava':
      return ['runs', 'rides', 'load'];
    case 'whoop':
      return ['recovery', 'strain', 'sleep'];
    case 'fitbit':
      return ['steps', 'sleep', 'heart_rate'];
    case 'todoist':
      return ['tasks'];
    case 'notion':
      return ['tasks', 'notes'];
    default:
      return [];
  }
}

// ─── Garmin state mapping ────────────────────────────────────────────

type GarminStatusRow = {
  status?: string | null;
  connected_at?: string | null;
  updated_at?: string | null;
};

function loadGarminRow(userId: number): GarminStatusRow | undefined {
  try {
    const db = getDb();
    return db
      .prepare(
        `SELECT
           status,
           COALESCE(last_refresh, last_used, updated_at) AS connected_at,
           updated_at
         FROM garmin_user_tokens
         WHERE user_id = ?`,
      )
      .get(userId) as GarminStatusRow | undefined;
  } catch (err) {
    // Migration 054 may not be applied on very old environments — treat as
    // "no Garmin row" rather than throwing, so the summary still returns
    // useful data for the other providers.
    logger.debug({ err, userId }, 'integration-status: garmin row unavailable');
    return undefined;
  }
}

/**
 * Maps the Garmin-specific `status` column to the canonical state machine.
 * Keep the mapping here so the rest of the app can speak the canonical
 * vocabulary without knowing Garmin's internal strings.
 */
function mapGarminStatus(row: GarminStatusRow | undefined): {
  state: IntegrationState;
  reasonCode?: IntegrationReasonCode;
  detail?: string;
} {
  if (!row) return { state: 'disconnected' };
  const status = String(row.status || '').toLowerCase();
  switch (status) {
    case 'active':
      return { state: 'connected' };
    case 'mfa_pending':
      return {
        state: 'pending',
        reasonCode: 'MFA_PENDING',
        detail: 'Finish the Garmin sign-in by entering the code sent to your email.',
      };
    case 'needs_reauth':
      return {
        state: 'revoked',
        reasonCode: 'NEEDS_REAUTH',
        detail: 'Garmin sign-in expired. Reconnect to resume sync.',
      };
    case 'expired':
      return {
        state: 'revoked',
        reasonCode: 'EXPIRED',
        detail: 'Garmin session expired. Reconnect to resume sync.',
      };
    default:
      // Unknown status: defensive fallback to "connected" if we stored *any*
      // row at all, because historically the row presence meant "connected".
      return { state: 'connected' };
  }
}

// ─── Probe-history gating ────────────────────────────────────────────

/**
 * How many consecutive probe failures before we downgrade a connected provider
 * to `degraded`. Mirrors `FAILURE_ALERT_THRESHOLD` inside integration-health.
 * Kept in sync intentionally — the badge should match the alert.
 */
const DEGRADE_THRESHOLD = 3;

type ProbeRow = {
  provider: string;
  status: 'ok' | 'fail' | 'skipped';
  ts: string;
  errorMessage: string | null;
};

function loadRecentProbes(
  provider: string,
  limit = DEGRADE_THRESHOLD + 1,
  since?: string | null,
): ProbeRow[] {
  try {
    const db = getDb();
    if (since) {
      // After a fresh OAuth reauth, probe failures that predate the new
      // tokens are stale signal — they were observations of the OLD refresh
      // token. Filter them out at the SQL layer so the rolling-window count
      // can never accidentally pin a just-reconnected provider to degraded
      // until 3+ new probes happen to land successfully.
      return db
        .prepare(
          `SELECT provider, status, ts, error_message AS errorMessage
           FROM integration_health
           WHERE provider = ?
             AND status != 'skipped'
             AND ts >= ?
           ORDER BY id DESC
           LIMIT ?`,
        )
        .all(provider, since, limit) as ProbeRow[];
    }
    return db
      .prepare(
        `SELECT provider, status, ts, error_message AS errorMessage
         FROM integration_health
         WHERE provider = ?
           AND status != 'skipped'
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(provider, limit) as ProbeRow[];
  } catch (err) {
    // Table may not exist on extremely old environments. Not fatal — we just
    // skip the probe gating and return the underlying state.
    logger.debug({ err, provider }, 'integration-status: probe history unavailable');
    return [];
  }
}

/**
 * Returns the degradation signal derived from the shared `integration_health`
 * table. This is owner-level (the probes run against the Felipe-tier creds),
 * but it's the best signal we have for "the external provider is struggling"
 * and a connected user's data would be stale during the same window.
 */
function probeDerivedState(
  provider: string,
  since?: string | null,
): {
  degraded: boolean;
  lastCheckedAt: string | null;
  lastErrorMessage: string | null;
} {
  // Only the probed providers have a meaningful signal here. Other providers
  // (todoist, notion, strava, whoop, fitbit) never degrade off probe history
  // — their state is token-presence only.
  if (provider !== 'google' && provider !== 'outlook' && provider !== 'garmin') {
    return { degraded: false, lastCheckedAt: null, lastErrorMessage: null };
  }
  const rows = loadRecentProbes(provider, DEGRADE_THRESHOLD + 1, since);
  if (rows.length === 0) {
    return { degraded: false, lastCheckedAt: null, lastErrorMessage: null };
  }
  const [latest] = rows;
  let consecutiveFailures = 0;
  for (const row of rows) {
    if (row.status !== 'fail') break;
    consecutiveFailures += 1;
  }
  return {
    degraded: consecutiveFailures >= DEGRADE_THRESHOLD,
    lastCheckedAt: latest.ts,
    lastErrorMessage: latest.status === 'fail' ? latest.errorMessage : null,
  };
}

// ─── OAuth-provider state mapping ────────────────────────────────────

type OAuthConnectionInfo = {
  provider: string;
  connectedAt: string;
  /**
   * Latest token-write timestamp (mirrors `user_oauth_tokens.updated_at`).
   * Used as a "since" cutoff for probe-derived degradation gating: failures
   * recorded before the user's most recent reauth are stale signal and must
   * not keep them stuck in `degraded` after they've already recovered the
   * connection.
   */
  lastReauthedAt: string;
  scopes: string[];
};

function isOAuthProvider(provider: IntegrationProvider): provider is OAuthProvider {
  return provider !== 'garmin';
}

function buildOAuthStatus(
  provider: IntegrationProvider,
  connection: OAuthConnectionInfo | undefined,
): ProviderIntegrationStatus {
  // 1. `coming_soon` takes precedence so WHOOP never lands on "disconnected"
  //    copy even if the env has WHOOP_CLIENT_ID set.
  if (isComingSoon(provider)) {
    return {
      provider,
      state: 'coming_soon',
      connectedAt: null,
      scopes: [],
      capabilities: capabilitiesForProvider(provider),
      reasonCode: 'COMING_SOON',
      detail: `${provider.toUpperCase()} support is coming soon.`,
    };
  }
  // 2. `not_configured` blocks the connect path entirely.
  if (!isProviderConfigured(provider)) {
    return {
      provider,
      state: 'not_configured',
      connectedAt: null,
      scopes: [],
      capabilities: capabilitiesForProvider(provider),
      reasonCode: 'NOT_CONFIGURED',
      detail: `OAuth is not configured for ${provider} in this environment.`,
    };
  }
  // 3. No token row → disconnected.
  if (!connection) {
    return {
      provider,
      state: 'disconnected',
      connectedAt: null,
      scopes: [],
      capabilities: capabilitiesForProvider(provider),
    };
  }
  // 4. Token row exists: lean on probe history to decide healthy vs degraded.
  //    Anchor probe gating at the user's most recent reauth so a fresh
  //    OAuth exchange immediately clears stale `invalid_grant` failures.
  const probe = probeDerivedState(provider, connection.lastReauthedAt);
  if (probe.degraded) {
    return {
      provider,
      state: 'degraded',
      connectedAt: connection.connectedAt,
      scopes: connection.scopes,
      capabilities: capabilitiesForProvider(provider, connection.scopes),
      reasonCode: 'PROBE_FAILING',
      detail: probe.lastErrorMessage || `${provider} sync has failed repeatedly — showing last-known data.`,
      lastCheckedAt: probe.lastCheckedAt,
    };
  }
  return {
    provider,
    state: 'connected',
    connectedAt: connection.connectedAt,
    scopes: connection.scopes,
    capabilities: capabilitiesForProvider(provider, connection.scopes),
    lastCheckedAt: probe.lastCheckedAt,
  };
}

function buildGarminStatus(userId: number): ProviderIntegrationStatus {
  // Garmin's tokens live in their own schema and have a richer `status`
  // column than OAuth providers. Map the string to the canonical state
  // machine first, then overlay probe-derived degradation on top.
  const row = loadGarminRow(userId);
  const mapped = mapGarminStatus(row);

  const baseCapabilities = capabilitiesForProvider('garmin');

  if (mapped.state === 'disconnected') {
    return {
      provider: 'garmin',
      state: 'disconnected',
      connectedAt: null,
      scopes: [],
      capabilities: baseCapabilities,
    };
  }

  if (mapped.state === 'pending' || mapped.state === 'revoked') {
    return {
      provider: 'garmin',
      state: mapped.state,
      connectedAt: row?.connected_at ?? null,
      scopes: ['activities', 'sleep', 'readiness'],
      capabilities: baseCapabilities,
      reasonCode: mapped.reasonCode,
      detail: mapped.detail,
    };
  }

  // connected — check probe history for a degraded overlay. Anchor at the
  // Garmin row's `connected_at` so a fresh re-auth clears stale failures
  // the same way OAuth providers do.
  const probe = probeDerivedState('garmin', row?.connected_at);
  if (probe.degraded) {
    return {
      provider: 'garmin',
      state: 'degraded',
      connectedAt: row?.connected_at ?? null,
      scopes: ['activities', 'sleep', 'readiness'],
      capabilities: baseCapabilities,
      reasonCode: 'PROBE_FAILING',
      detail: probe.lastErrorMessage || 'Garmin sync has failed repeatedly — showing last-known data.',
      lastCheckedAt: probe.lastCheckedAt,
    };
  }

  return {
    provider: 'garmin',
    state: 'connected',
    connectedAt: row?.connected_at ?? null,
    scopes: ['activities', 'sleep', 'readiness'],
    capabilities: baseCapabilities,
    lastCheckedAt: probe.lastCheckedAt,
  };
}

// ─── Summary computation ─────────────────────────────────────────────

function isUsableState(state: IntegrationState): boolean {
  // `degraded` is still usable — the product shows last-known data. Anything
  // else that's not connected/degraded is not a truth source right now.
  return state === 'connected' || state === 'degraded';
}

function hasCapability(
  status: ProviderIntegrationStatus,
  capability: string,
): boolean {
  if (!isUsableState(status.state)) return false;
  return status.capabilities.includes(capability);
}

function computeCapabilityFlags(
  providers: ProviderIntegrationStatus[],
): IntegrationCapabilityFlags {
  let mail = false;
  let calendar = false;
  let externalTasks = false;
  let health = false;

  for (const provider of providers) {
    if (!isUsableState(provider.state)) continue;
    // Mail: Gmail (via google scope) OR Outlook email scope
    if (provider.provider === 'google' && hasCapability(provider, 'gmail')) mail = true;
    if (provider.provider === 'outlook' && hasCapability(provider, 'email')) mail = true;
    // Calendar: either Google or Outlook with calendar scope
    if (provider.provider === 'google' && hasCapability(provider, 'calendar')) calendar = true;
    if (provider.provider === 'outlook' && hasCapability(provider, 'calendar')) calendar = true;
    // External tasks: Outlook tasks scope OR Todoist/Notion providers
    if (provider.provider === 'outlook' && hasCapability(provider, 'tasks')) externalTasks = true;
    if (provider.provider === 'todoist' || provider.provider === 'notion') externalTasks = true;
    // Health: any wearable/health provider
    if (provider.provider === 'garmin') health = true;
    if (provider.provider === 'strava' || provider.provider === 'whoop' || provider.provider === 'fitbit') {
      health = true;
    }
  }

  return { mail, calendar, externalTasks, health };
}

function countStates(providers: ProviderIntegrationStatus[]): IntegrationSummary['counts'] {
  const counts = {
    connected: 0,
    degraded: 0,
    revoked: 0,
    pending: 0,
    disconnected: 0,
  };
  for (const provider of providers) {
    switch (provider.state) {
      case 'connected':
        counts.connected += 1;
        break;
      case 'degraded':
        counts.degraded += 1;
        break;
      case 'revoked':
        counts.revoked += 1;
        break;
      case 'pending':
        counts.pending += 1;
        break;
      case 'disconnected':
        counts.disconnected += 1;
        break;
      default:
        // not_configured / coming_soon don't roll up into any count — they
        // describe provider availability, not user activity.
        break;
    }
  }
  return counts;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Read the canonical integration state for a single provider.
 *
 * Use this from feature code that needs to decide whether to fetch data
 * from the provider. Prefer `getIntegrationSummary()` for UI rendering
 * since that returns all providers in one shot.
 */
export function getProviderStatus(
  userId: number,
  provider: IntegrationProvider,
): ProviderIntegrationStatus {
  if (provider === 'garmin') return buildGarminStatus(userId);

  const connections = safeGetUserConnections(userId);
  const connection = connections.find((c) => c.provider === provider);
  return buildOAuthStatus(provider, connection);
}

/**
 * Read the canonical integration state for every provider in one pass.
 *
 * This is the preferred entry point for iOS and portal — it guarantees every
 * connectable provider appears exactly once in the response, with the same
 * shape regardless of storage tier (OAuth vs Garmin vs probe-derived).
 */
export function getIntegrationSummary(userId: number): IntegrationSummary {
  const connections = safeGetUserConnections(userId);
  const connectionByProvider = new Map<string, OAuthConnectionInfo>();
  for (const connection of connections) {
    connectionByProvider.set(connection.provider, connection);
  }

  const providers: ProviderIntegrationStatus[] = [];
  for (const provider of ALL_INTEGRATION_PROVIDERS) {
    if (provider === 'garmin') {
      providers.push(buildGarminStatus(userId));
      continue;
    }
    if (!isOAuthProvider(provider)) continue;
    providers.push(buildOAuthStatus(provider, connectionByProvider.get(provider)));
  }

  return {
    providers,
    counts: countStates(providers),
    capabilities: computeCapabilityFlags(providers),
  };
}

/**
 * Convenience: true iff the user has any usable mail provider. Prefer this
 * over `isConnected(userId, 'outlook') || isConnected(userId, 'google')` —
 * this respects revoked/pending states and the Gmail-scope check.
 */
export function hasUsableMailProvider(userId: number): boolean {
  return getIntegrationSummary(userId).capabilities.mail;
}

/** Convenience: true iff the user has any usable calendar provider. */
export function hasUsableCalendarProvider(userId: number): boolean {
  return getIntegrationSummary(userId).capabilities.calendar;
}

/** Convenience: true iff the user has any usable health/wearable provider. */
export function hasUsableHealthProvider(userId: number): boolean {
  return getIntegrationSummary(userId).capabilities.health;
}

/**
 * True iff Garmin is *connected* (not just "has a token row"). Used to avoid
 * flagging `isGarminStale` for users who never connected Garmin in the first
 * place — the old behavior (checking `status === 'needs_reauth'`) returned
 * false for those users but also returned false for revoked users, conflating
 * two very different states. This helper says "is Garmin *meant* to be a
 * data source for this user right now?".
 */
export function isGarminActivelyIntegrated(userId: number): boolean {
  const status = getProviderStatus(userId, 'garmin');
  return status.state === 'connected' || status.state === 'degraded';
}

// ─── Internal helpers ────────────────────────────────────────────────

function safeGetUserConnections(userId: number): OAuthConnectionInfo[] {
  try {
    return getUserConnections(userId) as OAuthConnectionInfo[];
  } catch (err) {
    // oauth-store should never throw, but if it does we prefer to downgrade
    // every OAuth provider to "disconnected" rather than crashing the route.
    // This mirrors the existing defensive posture in task-router.ts.
    logger.warn({ err, userId }, 'integration-status: getUserConnections threw');
    return [];
  }
}
