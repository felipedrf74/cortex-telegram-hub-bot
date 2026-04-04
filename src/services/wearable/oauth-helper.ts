// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Shared OAuth helper for wearable adapters (Strava, Whoop, Fitbit).
 *
 * Handles token retrieval and refresh logic so each adapter
 * doesn't duplicate the same boilerplate.
 */

import { getTokens, updateAccessToken } from '../oauth-store';
import type { OAuthProvider, OAuthTokens } from '../oauth-store';
import { logger } from '../../utils/logger';

interface TokenRefreshConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Ensure we have a valid (non-expired) access token for the given provider.
 * If expired, attempts a refresh using the stored refresh token.
 *
 * @returns The current valid access token string.
 * @throws If no tokens are stored or refresh fails.
 */
export async function ensureFreshToken(
  userId: number,
  provider: OAuthProvider,
  refreshConfig: TokenRefreshConfig,
): Promise<string> {
  const tokens = getTokens(userId, provider);
  if (!tokens) {
    throw new Error(`${provider} not connected`);
  }

  // Check if token is still valid (with 60s buffer)
  if (tokens.expiresAt) {
    const expiresAt = new Date(tokens.expiresAt).getTime();
    if (Date.now() < expiresAt - 60_000) {
      return tokens.accessToken;
    }
  } else if (tokens.accessToken) {
    // No expiry info — assume it's valid
    return tokens.accessToken;
  }

  // Token expired or missing — refresh
  return refreshAccessToken(userId, provider, tokens, refreshConfig);
}

async function refreshAccessToken(
  userId: number,
  provider: OAuthProvider,
  tokens: OAuthTokens,
  cfg: TokenRefreshConfig,
): Promise<string> {
  logger.info({ userId, provider }, 'Refreshing wearable OAuth token');

  const response = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }).toString(),
  });

  if (!response.ok) {
    const errText = await response.text();
    logger.error({ provider, status: response.status, errText }, 'Token refresh failed');
    throw new Error(`${provider} token refresh failed: ${response.status}`);
  }

  const data = await response.json() as any;
  const newAccessToken: string = data.access_token;
  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000).toISOString()
    : null;

  updateAccessToken(userId, provider, newAccessToken, expiresAt);

  return newAccessToken;
}
