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
import { getTokens } from './oauth-store';
import { getOwnerBootstrapUserRefs } from './user-service';

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

async function acquireAccessTokenFromRefreshToken(refreshToken: string): Promise<string> {
  const acquire = async (mode: 'auto' | 'confidential' | 'public') => {
    const result = await getMsalClient(mode).acquireTokenByRefreshToken({
      refreshToken,
      scopes: ALL_SCOPES,
    });

    if (!result?.accessToken) {
      throw new Error('Failed to acquire Microsoft Graph access token');
    }

    return result.accessToken;
  };

  try {
    return await acquire('auto');
  } catch (err) {
    if (config.outlook.clientSecret && isPublicClientRefreshTokenMismatch(err)) {
      logger.warn('Microsoft refresh token requires public-client MSAL flow; retrying without client secret');
      return acquire('public');
    }
    throw err;
  }
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
    const { getTokens } = require('./oauth-store');
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

  return acquireAccessTokenFromRefreshToken(refreshToken);
}

/** @deprecated Use getAccessTokenForUser(userId) for multi-user. */
async function getAccessToken(): Promise<string> {
  const refreshToken = getOwnerOutlookRefreshToken();
  if (!refreshToken) {
    throw new Error('Outlook refresh token not configured (neither oauth-store nor .env has it)');
  }

  return acquireAccessTokenFromRefreshToken(refreshToken);
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
 * This is safe because MSAL handles token caching internally, and the
 * per-call authProvider pattern means the Graph client itself is stateless.
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
  logger.info('Microsoft client caches reset after re-auth');
}

export const __testing = {
  acquireAccessTokenFromRefreshToken,
  isPublicClientRefreshTokenMismatch,
  setMsalClientsForTests(clients: {
    confidential?: any | null;
    public?: PublicClientApplication | null;
  }) {
    confidentialMsalClient = clients.confidential ?? null;
    publicMsalClient = clients.public ?? null;
  },
};
