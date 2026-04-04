// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OAuth Flow — URL generation and code exchange for Google + Outlook.
 *
 * Handles the OAuth2 authorization code flow:
 * 1. Generate consent URL with state=userId
 * 2. User authorizes in browser
 * 3. Callback receives code + state
 * 4. Exchange code for tokens
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import type { OAuthTokens, OAuthProvider } from './oauth-store';

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

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Generate the OAuth consent URL. State contains userId for callback routing.
 */
export function getOAuthUrl(provider: OAuthProvider, userId: number): string {
  if (provider === 'google') {
    const redirectUri = `${REDIRECT_BASE}/oauth/google/callback`;
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: String(userId),
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
      state: String(userId),
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
      state: String(userId),
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
      state: String(userId),
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
      state: String(userId),
    });
    return `${FITBIT_AUTH_URL}?${params.toString()}`;
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
