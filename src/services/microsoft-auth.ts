// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Shared Microsoft Graph / MSAL authentication module.
 *
 * Provides a SINGLE PublicClientApplication and Graph Client instance shared
 * across outlook-mail, outlook-calendar, and microsoft-todo. This avoids
 * refresh-token rotation conflicts: MSAL rotates the refresh token on each
 * acquireTokenByRefreshToken call, so multiple independent instances would
 * invalidate each other's tokens.
 *
 * All needed Microsoft Graph scopes are requested in a single token call.
 *
 * Audit P1 follow-up to P0-7: previously read `config.outlook.refreshToken`
 * directly from .env (plaintext, no audit). Now goes through oauth-store
 * first (encrypted + audited via getTokens) with env-var fallback for
 * backward compat. The graphClient singleton stays cached because token
 * fetching happens per-call inside the authProvider — switching the token
 * source is transparent to the cached client.
 */
import { Client } from '@microsoft/microsoft-graph-client';
import { PublicClientApplication } from '@azure/msal-node';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getTokens, storeTokens } from './oauth-store';
import { getOwnerBootstrapUserRefs } from './user-service';
import { registerOAuthTokenMutationListener } from './oauth-token-cache-events';
import {
  classifyOAuthAuthFailure,
  clearOAuthConnectionAuthFailure,
  markOAuthConnectionAuthFailure,
} from './oauth-connection-health';

// ─── All Microsoft Graph scopes needed by the app ────────────────────
const ALL_SCOPES = [
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Tasks.ReadWrite',
  'https://graph.microsoft.com/User.Read',
];

// ConfidentialClientApplication and PublicClientApplication both have
// acquireTokenByRefreshToken(), so we type the clients as `any` to support both.
let confidentialMsalClient: any = null;
let publicMsalClient: PublicClientApplication | null = null;
let graphClient: Client | null = null;

const ACCESS_TOKEN_CACHE_TTL_MS = 55 * 60 * 1000;
const CACHE_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;

type MicrosoftClientType = 'confidential' | 'public';
type MicrosoftAccessTokenCacheKey = `user:${number}` | 'owner';

interface CachedAccessToken {
  token: string;
  refreshAt: number;
}

const accessTokenCache = new Map<MicrosoftAccessTokenCacheKey, CachedAccessToken>();
const accessTokenInFlight = new Map<MicrosoftAccessTokenCacheKey, Promise<string>>();
const clientTypeByCacheKey = new Map<MicrosoftAccessTokenCacheKey, MicrosoftClientType>();
const cacheGenerationByCacheKey = new Map<MicrosoftAccessTokenCacheKey, number>();

let tokenCacheHits = 0;
let tokenCacheMisses = 0;
let tokenCacheCoalesced = 0;
let lastCacheSummaryAt = 0;

function userAccessTokenCacheKey(userId: number): MicrosoftAccessTokenCacheKey {
  return `user:${userId}`;
}

function maybeLogTokenCacheSummary(now = Date.now()): void {
  if (now - lastCacheSummaryAt < CACHE_SUMMARY_INTERVAL_MS) return;
  lastCacheSummaryAt = now;
  const total = tokenCacheHits + tokenCacheMisses;
  if (total === 0) return;
  logger.info({
    hits: tokenCacheHits,
    misses: tokenCacheMisses,
    coalesced: tokenCacheCoalesced,
    hitRatio: Number((tokenCacheHits / total).toFixed(4)),
    entries: accessTokenCache.size,
    clientTypeMemoizedEntries: clientTypeByCacheKey.size,
  }, 'microsoft_auth_token_cache_summary');
}

function invalidateMicrosoftAccessTokenCacheKey(cacheKey: MicrosoftAccessTokenCacheKey): void {
  cacheGenerationByCacheKey.set(cacheKey, (cacheGenerationByCacheKey.get(cacheKey) ?? 0) + 1);
  accessTokenCache.delete(cacheKey);
  accessTokenInFlight.delete(cacheKey);
  clientTypeByCacheKey.delete(cacheKey);
}

export function invalidateMicrosoftAccessTokenCacheForUser(userId: number): void {
  invalidateMicrosoftAccessTokenCacheKey(userAccessTokenCacheKey(userId));

  try {
    if (getOwnerBootstrapUserRefs().includes(userId)) {
      invalidateMicrosoftAccessTokenCacheKey('owner');
    }
  } catch { /* owner refs unavailable in some tests/early boot paths */ }
}

export function invalidateMicrosoftAccessTokenCacheForOwner(): void {
  invalidateMicrosoftAccessTokenCacheKey('owner');
}

registerOAuthTokenMutationListener(({ userId, provider }) => {
  if (provider === 'outlook') {
    invalidateMicrosoftAccessTokenCacheForUser(userId);
  }
});

function buildAuthConfig(includeSecret: boolean): any {
  const authConfig: any = {
    clientId: config.outlook.clientId,
    authority: `https://login.microsoftonline.com/${config.outlook.tenantId || 'common'}`,
  };
  if (includeSecret && config.outlook.clientSecret) {
    authConfig.clientSecret = config.outlook.clientSecret;
  }
  return authConfig;
}

function getMsalClient(mode: 'auto' | 'confidential' | 'public' = 'auto'): any {
  if (mode === 'public') {
    if (!publicMsalClient) {
      publicMsalClient = new PublicClientApplication({ auth: buildAuthConfig(false) });
    }
    return publicMsalClient;
  }

  if (mode === 'confidential') {
    if (!config.outlook.clientSecret) {
      return getMsalClient('public');
    }
    if (!confidentialMsalClient) {
      const { ConfidentialClientApplication } = require('@azure/msal-node');
      confidentialMsalClient = new ConfidentialClientApplication({ auth: buildAuthConfig(true) });
    }
    return confidentialMsalClient;
  }

  if (config.outlook.clientSecret) {
    return getMsalClient('confidential');
  }

  return getMsalClient('public');
}

function isPublicClientRefreshTokenMismatch(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('AADSTS90023')
    || message.includes("Public clients can't send a client secret");
}

// ─── NEX-13: rotated refresh-token persistence ──────────────────────

/** The users a token cache key maps to, for persisting a rotated refresh token. */
function resolveUserIdsForCacheKey(cacheKey: MicrosoftAccessTokenCacheKey): number[] {
  return cacheKey === 'owner' ? getOwnerBootstrapUserRefs() : [Number(cacheKey.slice('user:'.length))];
}

/**
 * Re-affirm the freshly acquired token in the access-token cache. storeTokens()
 * fires the OAuth mutation listener above, which invalidates THIS module's
 * cache for the affected user (and owner). Without this a routine refresh-token
 * rotation would defeat the cache and force an immediate re-acquire.
 */
function reaffirmAccessTokenCache(cacheKey: MicrosoftAccessTokenCacheKey, token: string, clientType: MicrosoftClientType): void {
  clientTypeByCacheKey.set(cacheKey, clientType);
  accessTokenCache.set(cacheKey, { token, refreshAt: Date.now() + ACCESS_TOKEN_CACHE_TTL_MS });
}

/**
 * Persist a rotated refresh token when MSAL returns one on the result. Only
 * users whose CURRENTLY STORED Outlook refresh token is the one we just rotated
 * away from are updated — this skips the env-only owner fallback (no stored
 * row) and never clobbers a token changed concurrently by a re-connect.
 */
function persistRotatedRefreshTokenIfNeeded(
  cacheKey: MicrosoftAccessTokenCacheKey,
  previousRefreshToken: string,
  result: any,
  clientType: MicrosoftClientType,
): void {
  const candidate = result?.refreshToken;
  const rotated = typeof candidate === 'string' ? candidate.trim() : '';
  if (!rotated || rotated === previousRefreshToken) return;
  try {
    const accessToken = result.accessToken as string;
    const expiresOn = result?.expiresOn;
    const expiresAt = expiresOn instanceof Date
      ? expiresOn.toISOString()
      : typeof expiresOn === 'string' ? expiresOn : null;
    for (const userId of resolveUserIdsForCacheKey(cacheKey)) {
      const existing = getTokens(userId, 'outlook');
      if (!existing || existing.refreshToken !== previousRefreshToken) continue;
      storeTokens(userId, 'outlook', {
        accessToken,
        refreshToken: rotated,
        tokenType: existing.tokenType,
        expiresAt: expiresAt ?? existing.expiresAt,
        scopes: existing.scopes,
      });
      reaffirmAccessTokenCache(cacheKey, accessToken, clientType);
      logger.info({ userId, cacheKey }, 'microsoft_auth_refresh_token_rotated_persisted');
    }
  } catch (err) {
    logger.warn({ err, cacheKey }, 'Failed to persist rotated Outlook refresh token');
  }
}

async function acquireAccessTokenFromRefreshToken(
  refreshToken: string,
  cacheKey: MicrosoftAccessTokenCacheKey = 'owner',
): Promise<string> {
  const now = Date.now();
  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.refreshAt > now) {
    tokenCacheHits++;
    logger.debug({ cacheKey }, 'microsoft_auth_token_cache_hit');
    maybeLogTokenCacheSummary(now);
    return cached.token;
  }

  const pending = accessTokenInFlight.get(cacheKey);
  if (pending) {
    tokenCacheCoalesced++;
    logger.debug({ cacheKey }, 'microsoft_auth_token_cache_coalesced');
    return pending;
  }

  tokenCacheMisses++;
  logger.debug({ cacheKey }, 'microsoft_auth_token_cache_miss');
  maybeLogTokenCacheSummary(now);

  const acquire = async (mode: 'auto' | 'confidential' | 'public') => {
    const result = await getMsalClient(mode).acquireTokenByRefreshToken({
      refreshToken,
      scopes: ALL_SCOPES,
    });

    if (!result?.accessToken) {
      throw new Error('Failed to acquire Microsoft Graph access token');
    }

    return result;
  };

  const acquisitionGeneration = cacheGenerationByCacheKey.get(cacheKey) ?? 0;
  const writeAcquiredToken = (token: string, clientType: MicrosoftClientType): void => {
    if ((cacheGenerationByCacheKey.get(cacheKey) ?? 0) !== acquisitionGeneration) {
      logger.debug({ cacheKey }, 'microsoft_auth_token_cache_write_skipped_after_invalidation');
      return;
    }
    clientTypeByCacheKey.set(cacheKey, clientType);
    accessTokenCache.set(cacheKey, { token, refreshAt: Date.now() + ACCESS_TOKEN_CACHE_TTL_MS });
  };

  // NEX-13: MSAL rotates the refresh token on each acquireTokenByRefreshToken
  // call. When it surfaces the rotated token on the result, persist it to the
  // encrypted oauth-store so the next process/call doesn't keep presenting the
  // stale (now-consumed) refresh token and eventually fail with invalid_grant.
  const acquisition = (async () => {
    const memoizedClientType = clientTypeByCacheKey.get(cacheKey);
    const initialMode: 'auto' | 'confidential' | 'public' = memoizedClientType ?? 'auto';

    try {
      const result = await acquire(initialMode);
      const token = result.accessToken as string;
      if (initialMode === 'public' || (!config.outlook.clientSecret && initialMode === 'auto')) {
        writeAcquiredToken(token, 'public');
        persistRotatedRefreshTokenIfNeeded(cacheKey, refreshToken, result, 'public');
      } else {
        writeAcquiredToken(token, 'confidential');
        persistRotatedRefreshTokenIfNeeded(cacheKey, refreshToken, result, 'confidential');
      }
      return token;
    } catch (err) {
      if (initialMode !== 'public' && config.outlook.clientSecret && isPublicClientRefreshTokenMismatch(err)) {
        logger.warn({ cacheKey }, 'Microsoft refresh token requires public-client MSAL flow; retrying without client secret');
        const result = await acquire('public');
        const token = result.accessToken as string;
        writeAcquiredToken(token, 'public');
        persistRotatedRefreshTokenIfNeeded(cacheKey, refreshToken, result, 'public');
        return token;
      }
      throw err;
    }
  })();

  accessTokenInFlight.set(cacheKey, acquisition);
  const clearIfCurrent = () => {
    if (accessTokenInFlight.get(cacheKey) === acquisition) {
      accessTokenInFlight.delete(cacheKey);
    }
  };
  void acquisition.then(clearIfCurrent, clearIfCurrent);
  return acquisition;
}

/**
 * Resolve the owner's Outlook refresh token. Tries oauth-store first
 * (encrypted, audited), falls back to `config.outlook.refreshToken`.
 */
function getOwnerOutlookRefreshToken(): string | null {
  const ownerRefs = getOwnerBootstrapUserRefs();
  if (ownerRefs.length > 0) {
    try {
      for (const ownerRef of ownerRefs) {
        const tokens = getTokens(ownerRef, 'outlook');
        if (tokens?.refreshToken) {
          return tokens.refreshToken;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'getOwnerOutlookRefreshToken: oauth-store read failed, falling back to env');
    }
  }
  return config.outlook.refreshToken || null;
}

// ─── Per-user token resolution (multi-user) ─────────────────────────

/**
 * Get an Outlook refresh token for a specific user.
 * Used by iOS API routes where each request carries a per-user JWT.
 */
export function getOutlookRefreshTokenForUser(userId: number): string | null {
  try {
    const tokens = getTokens(userId, 'outlook');
    return tokens?.refreshToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Get a Microsoft Graph access token for a specific user.
 * Refreshes via MSAL using the user's stored refresh token.
 */
export async function getAccessTokenForUser(userId: number): Promise<string> {
  const refreshToken = getOutlookRefreshTokenForUser(userId);
  if (!refreshToken) {
    throw new Error(`Outlook not connected for user ${userId}`);
  }

  try {
    const token = await acquireAccessTokenFromRefreshToken(
      refreshToken,
      userAccessTokenCacheKey(userId),
    );
    clearOAuthConnectionAuthFailure(userId, 'outlook');
    return token;
  } catch (err) {
    const reason = classifyOAuthAuthFailure(err);
    // Do not let a stale in-flight request overwrite a successful reconnect.
    // The rejection is current only while the stored refresh token is still
    // the exact token MSAL rejected for this user.
    if (reason && getOutlookRefreshTokenForUser(userId) === refreshToken) {
      markOAuthConnectionAuthFailure(userId, 'outlook', reason);
    }
    throw err;
  }
}

/** @deprecated Use getAccessTokenForUser(userId) for multi-user. */
async function getAccessToken(): Promise<string> {
  const refreshToken = getOwnerOutlookRefreshToken();
  if (!refreshToken) {
    throw new Error('Outlook refresh token not configured (neither oauth-store nor .env has it)');
  }

  return acquireAccessTokenFromRefreshToken(refreshToken, 'owner');
}

// ─── Per-request user resolution ────────────────────────────────────
// Reads userId from AsyncLocalStorage context (set by router middleware).
// NO global mutable variable — each request's context is isolated.
// Legacy setRequestUserId kept as no-op for backward compat with router.

/** @deprecated No-op. userId is now read from AsyncLocalStorage context. */
export function setRequestUserId(_userId: number | null): void {
  // Intentionally empty — context is set via runWithContext in router.ts
}

/**
 * Get a Microsoft Graph client. Reads userId from the current
 * AsyncLocalStorage context. If a userId is present (iOS API request),
 * returns a per-user client. If absent (Telegram bot, cron job),
 * returns the owner singleton.
 */
export function getGraphClient(): Client {
  // Read userId from AsyncLocalStorage (race-safe, per-request)
  let contextUserId: number | null = null;
  try {
    const { getCurrentContext } = require('../utils/request-context');
    contextUserId = getCurrentContext()?.userId ?? null;
  } catch { /* outside request context */ }

  if (contextUserId !== null) {
    return getGraphClientForUser(contextUserId);
  }

  // Owner singleton fallback (Telegram bot codepath)
  if (graphClient) return graphClient;

  graphClient = Client.init({
    authProvider: async (done) => {
      try {
        const token = await getAccessToken();
        done(null, token);
      } catch (err) {
        done(err as Error, null);
      }
    },
  });

  return graphClient;
}

/**
 * Build a Graph client for a specific user. NOT cached — each call gets
 * a fresh client that resolves the user's refresh token on demand.
 * Access tokens are cached in this module per user, and the per-call
 * authProvider pattern means the Graph client itself is stateless.
 */
export function getGraphClientForUser(userId: number): Client {
  return Client.init({
    authProvider: async (done) => {
      try {
        const token = await getAccessTokenForUser(userId);
        done(null, token);
      } catch (err) {
        done(err as Error, null);
      }
    },
  });
}

export function isMicrosoftConfigured(): boolean {
  return !!(config.outlook.clientId && getOwnerOutlookRefreshToken());
}

/**
 * Reset the cached MSAL + Graph clients. Called by the OAuth callback
 * handler in src/portal/server.ts after a successful /connect outlook so
 * the next API call rebuilds with the freshly-stored token. Outlook tokens
 * are fetched per-call so this is mostly defensive — but the underlying
 * MSAL client may cache state internally too.
 */
export function resetMicrosoftClients(): void {
  confidentialMsalClient = null;
  publicMsalClient = null;
  graphClient = null;
  accessTokenCache.clear();
  accessTokenInFlight.clear();
  clientTypeByCacheKey.clear();
  cacheGenerationByCacheKey.clear();
  tokenCacheHits = 0;
  tokenCacheMisses = 0;
  tokenCacheCoalesced = 0;
  lastCacheSummaryAt = 0;
  logger.info('Microsoft client caches reset after re-auth');
}

export const __testing = {
  ACCESS_TOKEN_CACHE_TTL_MS,
  acquireAccessTokenFromRefreshToken,
  getAccessTokenForOwner: getAccessToken,
  isPublicClientRefreshTokenMismatch,
  invalidateMicrosoftAccessTokenCacheForUser,
  invalidateMicrosoftAccessTokenCacheForOwner,
  setMsalClientsForTests(clients: {
    confidential?: any | null;
    public?: PublicClientApplication | null;
  }) {
    confidentialMsalClient = clients.confidential ?? null;
    publicMsalClient = clients.public ?? null;
  },
  resetTokenCacheForTests() {
    accessTokenCache.clear();
    accessTokenInFlight.clear();
    clientTypeByCacheKey.clear();
    cacheGenerationByCacheKey.clear();
    tokenCacheHits = 0;
    tokenCacheMisses = 0;
    tokenCacheCoalesced = 0;
    lastCacheSummaryAt = 0;
  },
  getTokenCacheStatsForTests() {
    return {
      hits: tokenCacheHits,
      misses: tokenCacheMisses,
      coalesced: tokenCacheCoalesced,
      entries: accessTokenCache.size,
      clientTypeMemoizedEntries: clientTypeByCacheKey.size,
      generations: cacheGenerationByCacheKey.size,
    };
  },
};
