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

export function getGraphClient(): Client {
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
