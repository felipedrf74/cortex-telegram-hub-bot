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
 */
import { Client } from '@microsoft/microsoft-graph-client';
import { PublicClientApplication } from '@azure/msal-node';
import { config } from '../config';

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

async function getAccessToken(): Promise<string> {
  const msal = getMsalClient();

  const result = await msal.acquireTokenByRefreshToken({
    refreshToken: config.outlook.refreshToken,
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
  return !!(config.outlook.clientId && config.outlook.refreshToken);
}
