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

// ─── All Microsoft Graph scopes needed by the app ────────────────────
const ALL_SCOPES = [
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Tasks.ReadWrite',
  'https://graph.microsoft.com/User.Read',
];

let msalClient: PublicClientApplication | null = null;
let graphClient: Client | null = null;

function getMsalClient(): PublicClientApplication {
  if (msalClient) return msalClient;

  msalClient = new PublicClientApplication({
    auth: {
      clientId: config.outlook.clientId,
      authority: `https://login.microsoftonline.com/${config.outlook.tenantId}`,
    },
  });

  return msalClient;
}

/**
 * Resolve the owner's Outlook refresh token. Tries oauth-store first
 * (encrypted, audited), falls back to `config.outlook.refreshToken`.
 */
function getOwnerOutlookRefreshToken(): string | null {
  const ownerId = config.telegram.allowedUserIds[0];
  if (ownerId) {
    try {
      const { getTokens } = require('./oauth-store');
      const tokens = getTokens(ownerId, 'outlook');
      if (tokens?.refreshToken) {
        return tokens.refreshToken;
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
  const msal = getMsalClient();
  const refreshToken = getOutlookRefreshTokenForUser(userId);
  if (!refreshToken) {
    throw new Error(`Outlook not connected for user ${userId}`);
  }

  const result = await msal.acquireTokenByRefreshToken({
    refreshToken,
    scopes: ALL_SCOPES,
  });

  if (!result?.accessToken) {
    throw new Error(`Failed to acquire Graph token for user ${userId}`);
  }

  return result.accessToken;
}

/** @deprecated Use getAccessTokenForUser(userId) for multi-user. */
async function getAccessToken(): Promise<string> {
  const msal = getMsalClient();
  const refreshToken = getOwnerOutlookRefreshToken();
  if (!refreshToken) {
    throw new Error('Outlook refresh token not configured (neither oauth-store nor .env has it)');
  }

  const result = await msal.acquireTokenByRefreshToken({
    refreshToken,
    scopes: ALL_SCOPES,
  });

  if (!result?.accessToken) {
    throw new Error('Failed to acquire Microsoft Graph access token');
  }

  return result.accessToken;
}

// ─── Per-request user override ──────────────────────────────────────
// iOS API routes set this before calling microsoft-todo functions so
// getGraphClient() returns a per-user client instead of the owner
// singleton. Reset after each request via middleware.
let _requestUserId: number | null = null;

/** Set the per-request user override. Call with null to clear. */
export function setRequestUserId(userId: number | null): void {
  _requestUserId = userId;
}

/**
 * Get a Microsoft Graph client. If a per-request userId is set (via
 * setRequestUserId), returns a per-user client. Otherwise returns the
 * owner singleton for backward compatibility with the Telegram bot.
 */
export function getGraphClient(): Client {
  // Per-user override takes precedence
  if (_requestUserId !== null) {
    return getGraphClientForUser(_requestUserId);
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
  msalClient = null;
  graphClient = null;
  logger.info('Microsoft client caches reset after re-auth');
}
