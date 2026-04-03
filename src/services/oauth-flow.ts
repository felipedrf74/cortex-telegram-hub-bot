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
