// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Google Auth Bridge — single source of truth for resolving the owner's
 * Google OAuth refresh token across calendar, drive, and gmail services.
 *
 * Audit P1 follow-up to P0-7: the OAuth encryption work in P0-7 only
 * encrypted rows in `user_oauth_tokens`, but the live google-* services
 * were reading `config.google.refreshToken` directly from .env, bypassing
 * the encrypted store entirely. This bridge fixes that asymmetry: the
 * service-side helpers all go through `getOwnerGoogleRefreshToken()` which
 * tries oauth-store first (encrypted, audited via getTokens) and falls
 * back to the env var only if nothing's stored.
 *
 * Caller-facing API of google-calendar / google-drive / google-gmail does
 * NOT change — they still expose `getEvents()` etc with no userId. The
 * bridge resolves the owner identity through user-service bootstrap helpers
 * so owner-bound legacy token rows can be read without leaking raw Telegram
 * config access into every integration module.
 *
 * Cache invalidation: each google-* service caches its high-level client
 * (calendar / drive / gmail). The OAuth callback handler in oauth-flow
 * MUST call `resetGoogleClients()` after a successful `/connect google`
 * so the next API call picks up the freshly-stored token instead of the
 * stale one held by the singleton.
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getTokens } from './oauth-store';
import { getOwnerBootstrapUserRefs } from './user-service';

// ─── Token resolution ───────────────────────────────────────────────

/**
 * Resolve the owner's Google refresh token. Tries oauth-store first
 * (encrypted, audited via getTokens()), falls back to the legacy
 * `config.google.refreshToken` env var.
 *
 * Returns null if neither source has a token.
 */
export function getOwnerGoogleRefreshToken(): string | null {
  const ownerRefs = getOwnerBootstrapUserRefs();
  if (ownerRefs.length > 0) {
    try {
      for (const ownerRef of ownerRefs) {
        const tokens = getTokens(ownerRef, 'google');
        if (tokens?.refreshToken) {
          return tokens.refreshToken;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'getOwnerGoogleRefreshToken: oauth-store read failed, falling back to env');
    }
  }
  return config.google.refreshToken || null;
}

/**
 * Build a fresh OAuth2 client with the current best refresh token.
 * Throws if Google credentials are not configured.
 *
 * @deprecated Use buildGoogleOAuth2ClientForUser(userId) for multi-user.
 * This function is kept for the Telegram bot codepath which doesn't have
 * per-request userId context.
 */
export function buildGoogleOAuth2Client(): OAuth2Client {
  const refreshToken = getOwnerGoogleRefreshToken();
  if (!config.google.clientId || !config.google.clientSecret || !refreshToken) {
    throw new Error('Google credentials not configured');
  }
  const client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// ─── Per-user token resolution (multi-user) ─────────────────────────

/**
 * Get a Google refresh token for a specific user from the encrypted
 * oauth-store. Returns null if the user hasn't connected Google.
 */
export function getGoogleRefreshTokenForUser(userId: number): string | null {
  try {
    const tokens = getTokens(userId, 'google');
    return tokens?.refreshToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Build an OAuth2 client for a specific user. Used by iOS API routes
 * where each request carries a per-user JWT.
 */
export function buildGoogleOAuth2ClientForUser(userId: number): OAuth2Client {
  const refreshToken = getGoogleRefreshTokenForUser(userId);
  if (!config.google.clientId || !config.google.clientSecret || !refreshToken) {
    throw new Error(`Google not connected for user ${userId}`);
  }
  const client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/**
 * Returns true if we have everything needed to make Google API calls.
 * Used by `/connections` and the portal status check.
 */
export function isGoogleConfigured(userId?: number): boolean {
  if (!config.google.clientId || !config.google.clientSecret) {
    return false;
  }
  if (userId !== undefined) {
    return !!getGoogleRefreshTokenForUser(userId);
  }
  return !!getOwnerGoogleRefreshToken();
}

// ─── Cache invalidation hub ─────────────────────────────────────────

/**
 * Reset callbacks registered by each google-* service. Called by the
 * OAuth callback handler in oauth-flow.ts after a successful re-auth so
 * the next getCalendar/getDrive/getGmail call rebuilds with the fresh
 * token instead of returning the stale singleton.
 */
const _resetCallbacks: Array<() => void> = [];

export function registerGoogleClientReset(fn: () => void): void {
  _resetCallbacks.push(fn);
}

export function resetGoogleClients(): void {
  for (const fn of _resetCallbacks) {
    try {
      fn();
    } catch (err) {
      logger.warn({ err }, 'resetGoogleClients: callback failed');
    }
  }
  logger.info({ count: _resetCallbacks.length }, 'Google client caches reset after re-auth');
}
