// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OAuth Flow — URL generation and code exchange for Google + Outlook.
 *
 * Handles the OAuth2 authorization code flow:
 * 1. Generate consent URL with one-time state nonce bound to user+provider
 * 2. User authorizes in browser
 * 3. Callback receives code + state
 * 4. Exchange code for tokens
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import type { OAuthTokens, OAuthProvider } from './oauth-store';
import { createOAuthNonceSession } from './oauth-state-store';

const REDIRECT_BASE = process.env.OAUTH_REDIRECT_BASE || 'https://nexushub.me';

// ─── Google OAuth ───────────────────────────────────────────────────

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.readonly',
];

// ─── Outlook OAuth ──────────────────────────────────────────────────

const OUTLOOK_SCOPES = [
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Tasks.ReadWrite',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
];

// ─── Strava OAuth ───────────────────────────────────────────────────

const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_SCOPES = 'read,activity:read_all';

// ─── Whoop OAuth ────────────────────────────────────────────────────

const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_SCOPES = 'read:recovery read:sleep read:workout read:cycles read:profile offline';

// ─── Fitbit OAuth ───────────────────────────────────────────────────

const FITBIT_AUTH_URL = 'https://www.fitbit.com/oauth2/authorize';
const FITBIT_TOKEN_URL = 'https://api.fitbit.com/oauth2/token';
const FITBIT_SCOPES = 'activity heartrate sleep profile';

// ─── Todoist OAuth (TASK-16b) ───────────────────────────────────────

const TODOIST_AUTH_URL = 'https://todoist.com/oauth/authorize';
const TODOIST_TOKEN_URL = 'https://todoist.com/oauth/access_token';
// Todoist uses "data:read_write" for full task access. They don't use OIDC
// scope strings, just their own permission keywords.
const TODOIST_SCOPES = 'data:read_write';

// ─── Notion OAuth (TASK-16b) ────────────────────────────────────────

// Notion uses HTTP Basic auth on the token endpoint with client_id:client_secret
// — different from every other provider in this file. See exchangeNotionCode.
const NOTION_AUTH_URL = 'https://api.notion.com/v1/oauth/authorize';
const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Generate the OAuth consent URL. State contains a nonce that must be
 * consumed by the callback before tokens are stored.
 */
export function getOAuthUrl(provider: OAuthProvider, userId: number): string {
  const state = `tg:${userId}:${createOAuthNonceSession(userId, provider)}`;
  if (provider === 'google') {
    const redirectUri = `${REDIRECT_BASE}/oauth/google/callback`;
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  if (provider === 'outlook') {
    const tenantId = config.outlook.tenantId || 'common';
    const redirectUri = `${REDIRECT_BASE}/oauth/outlook/callback`;
    const params = new URLSearchParams({
      client_id: config.outlook.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: OUTLOOK_SCOPES.join(' '),
      state,
    });
    return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  if (provider === 'strava') {
    const redirectUri = `${REDIRECT_BASE}/oauth/strava/callback`;
    const params = new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID || '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: STRAVA_SCOPES,
      approval_prompt: 'force',
      state,
    });
    return `${STRAVA_AUTH_URL}?${params.toString()}`;
  }

  if (provider === 'whoop') {
    const redirectUri = `${REDIRECT_BASE}/oauth/whoop/callback`;
    const params = new URLSearchParams({
      client_id: process.env.WHOOP_CLIENT_ID || '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: WHOOP_SCOPES,
      state,
    });
    return `${WHOOP_AUTH_URL}?${params.toString()}`;
  }

  if (provider === 'fitbit') {
    const redirectUri = `${REDIRECT_BASE}/oauth/fitbit/callback`;
    const params = new URLSearchParams({
      client_id: process.env.FITBIT_CLIENT_ID || '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: FITBIT_SCOPES,
      state,
    });
    return `${FITBIT_AUTH_URL}?${params.toString()}`;
  }

  if (provider === 'todoist') {
    // Note: Todoist's authorize endpoint uses `state` differently — it's
    // returned as `state` in the callback (NOT prefixed with anything else).
    const params = new URLSearchParams({
      client_id: config.todoist.clientId,
      scope: TODOIST_SCOPES,
      state,
    });
    return `${TODOIST_AUTH_URL}?${params.toString()}`;
  }

  if (provider === 'notion') {
    const redirectUri = `${REDIRECT_BASE}/oauth/notion/callback`;
    const params = new URLSearchParams({
      client_id: config.notion.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      owner: 'user',
      state,
    });
    return `${NOTION_AUTH_URL}?${params.toString()}`;
  }

  throw new Error(`Unknown OAuth provider: ${provider}`);
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(provider: OAuthProvider, code: string, userId: number): Promise<OAuthTokens> {
  if (provider === 'google') {
    return exchangeGoogleCode(code);
  }
  if (provider === 'outlook') {
    return exchangeOutlookCode(code);
  }
  if (provider === 'strava') {
    return exchangeStravaCode(code);
  }
  if (provider === 'whoop') {
    return exchangeWhoopCode(code);
  }
  if (provider === 'fitbit') {
    return exchangeFitbitCode(code);
  }
  if (provider === 'todoist') {
    return exchangeTodoistCode(code);
  }
  if (provider === 'notion') {
    return exchangeNotionCode(code);
  }
  throw new Error(`Unknown OAuth provider: ${provider}`);
}

// ─── Private Helpers ────────────────────────────────────────────────

async function exchangeGoogleCode(code: string): Promise<OAuthTokens> {
  const redirectUri = `${REDIRECT_BASE}/oauth/google/callback`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error({ status: response.status, err }, 'Google token exchange failed');
    throw new Error(`Google token exchange failed: ${response.status}`);
  }

  const data = await response.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
    scopes: (data.scope || '').split(' ').filter(Boolean),
  };
}

async function exchangeOutlookCode(code: string): Promise<OAuthTokens> {
  const tenantId = config.outlook.tenantId || 'common';
  const redirectUri = `${REDIRECT_BASE}/oauth/outlook/callback`;
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.outlook.clientId,
      client_secret: config.outlook.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: OUTLOOK_SCOPES.join(' '),
    }).toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error({ status: response.status, err }, 'Outlook token exchange failed');
    throw new Error(`Outlook token exchange failed: ${response.status}`);
  }

  const data = await response.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
    scopes: (data.scope || '').split(' ').filter(Boolean),
  };
}

// ─── Strava ─────────────────────────────────────────────────────────

async function exchangeStravaCode(code: string): Promise<OAuthTokens> {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.STRAVA_CLIENT_ID || '',
      client_secret: process.env.STRAVA_CLIENT_SECRET || '',
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error({ status: response.status, err }, 'Strava token exchange failed');
    throw new Error(`Strava token exchange failed: ${response.status}`);
  }

  const data = await response.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt: data.expires_at
      ? new Date(data.expires_at * 1000).toISOString()
      : null,
    scopes: (data.scope || STRAVA_SCOPES).split(',').filter(Boolean),
  };
}

// ─── Whoop ──────────────────────────────────────────────────────────

async function exchangeWhoopCode(code: string): Promise<OAuthTokens> {
  const redirectUri = `${REDIRECT_BASE}/oauth/whoop/callback`;
  const response = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.WHOOP_CLIENT_ID || '',
      client_secret: process.env.WHOOP_CLIENT_SECRET || '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error({ status: response.status, err }, 'Whoop token exchange failed');
    throw new Error(`Whoop token exchange failed: ${response.status}`);
  }

  const data = await response.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
    scopes: (data.scope || '').split(' ').filter(Boolean),
  };
}

// ─── Fitbit ─────────────────────────────────────────────────────────

async function exchangeFitbitCode(code: string): Promise<OAuthTokens> {
  const redirectUri = `${REDIRECT_BASE}/oauth/fitbit/callback`;
  const response = await fetch(FITBIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${process.env.FITBIT_CLIENT_ID || ''}:${process.env.FITBIT_CLIENT_SECRET || ''}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error({ status: response.status, err }, 'Fitbit token exchange failed');
    throw new Error(`Fitbit token exchange failed: ${response.status}`);
  }

  const data = await response.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt: data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null,
    scopes: (data.scope || '').split(' ').filter(Boolean),
  };
}

// ─── Todoist ────────────────────────────────────────────────────────

/**
 * Exchange a Todoist authorization code for an access token.
 *
 * Todoist's tokens NEVER expire (they're long-lived bearer tokens) and the
 * API doesn't return a refresh_token — so we store the access_token in both
 * fields and set expiresAt to null. This matches the OAuthTokens shape
 * without inventing a fake refresh flow.
 */
async function exchangeTodoistCode(code: string): Promise<OAuthTokens> {
  const response = await fetch(TODOIST_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.todoist.clientId,
      client_secret: config.todoist.clientSecret,
      code,
    }).toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error({ status: response.status, err }, 'Todoist token exchange failed');
    throw new Error(`Todoist token exchange failed: ${response.status}`);
  }

  const data = await response.json() as any;
  if (!data.access_token) {
    logger.error({ data }, 'Todoist response missing access_token');
    throw new Error('Todoist token exchange returned no access_token');
  }
  return {
    accessToken: data.access_token,
    // Todoist tokens are long-lived; no refresh flow exists.
    refreshToken: data.access_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt: null,
    scopes: (data.scope || TODOIST_SCOPES).split(',').filter(Boolean),
  };
}

// ─── Notion ─────────────────────────────────────────────────────────

/**
 * Exchange a Notion authorization code for an access token.
 *
 * Notion's token endpoint requires HTTP Basic auth with `client_id:client_secret`
 * — they ignore credentials in the body. The response includes a workspace_id
 * and bot_id which we keep in the scopes field as JSON-ish breadcrumbs in
 * case we need them later (workspace name, bot identity, etc).
 */
async function exchangeNotionCode(code: string): Promise<OAuthTokens> {
  const redirectUri = `${REDIRECT_BASE}/oauth/notion/callback`;
  const basic = Buffer.from(`${config.notion.clientId}:${config.notion.clientSecret}`).toString('base64');

  const response = await fetch(NOTION_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    logger.error({ status: response.status, err }, 'Notion token exchange failed');
    throw new Error(`Notion token exchange failed: ${response.status}`);
  }

  const data = await response.json() as any;
  if (!data.access_token) {
    logger.error({ data }, 'Notion response missing access_token');
    throw new Error('Notion token exchange returned no access_token');
  }
  // Notion tokens are non-expiring bearer tokens, same as Todoist.
  return {
    accessToken: data.access_token,
    refreshToken: data.access_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt: null,
    // Stash workspace metadata in scopes — useful for the database mapping
    // flow which needs to know which workspace the user authorized.
    scopes: [
      `workspace:${data.workspace_id || 'unknown'}`,
      `bot:${data.bot_id || 'unknown'}`,
    ],
  };
}
