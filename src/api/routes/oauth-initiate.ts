// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OAuth Initiate — generates consent URLs for iOS integration onboarding.
 *
 * POST /api/v1/auth/oauth/initiate
 * Body: { provider: 'google' | 'outlook' }
 * Returns: { url: "https://accounts.google.com/..." }
 *
 * The state parameter carries "ios:{userId}:{nonce}" so the callback
 * handler can detect iOS-origin flows and redirect to the custom URL
 * scheme (me.nexushub.app://oauth/{provider}?status=success) instead
 * of rendering HTML.
 *
 * Protected by authMiddleware (JWT required).
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import { getOAuthUrl } from '../../services/oauth-flow';
import { config } from '../../config';
import type { OAuthProvider } from '../../services/oauth-store';

// In-memory nonce store for CSRF protection.
// Nonces expire after 10 minutes. Bounded to 1000 entries.
const nonceStore = new Map<string, { userId: number; provider: string; createdAt: number }>();
const NONCE_TTL = 10 * 60 * 1000; // 10 minutes
const MAX_NONCES = 1000;

function cleanExpiredNonces(): void {
  const now = Date.now();
  for (const [key, val] of nonceStore) {
    if (now - val.createdAt > NONCE_TTL) nonceStore.delete(key);
  }
}

/** Validate and consume a nonce. Returns the userId if valid, null if not. */
export function consumeNonce(nonce: string): { userId: number; provider: string } | null {
  cleanExpiredNonces();
  const entry = nonceStore.get(nonce);
  if (!entry) return null;
  nonceStore.delete(nonce); // One-time use
  return entry;
}

/** Check if a state string is an iOS-origin OAuth flow. */
export function isIOSState(state: string): boolean {
  return state.startsWith('ios:');
}

/** Parse an iOS state string: "ios:{userId}:{nonce}" */
export function parseIOSState(state: string): { userId: number; nonce: string } | null {
  const parts = state.split(':');
  if (parts.length !== 3 || parts[0] !== 'ios') return null;
  const userId = parseInt(parts[1], 10);
  const nonce = parts[2];
  if (isNaN(userId) || !nonce) return null;
  return { userId, nonce };
}

export function oauthInitiateRoutes(): Router {
  const router = Router();

  /**
   * POST /api/v1/auth/oauth/initiate
   * Generate an OAuth consent URL for the given provider.
   * The iOS app opens this URL in ASWebAuthenticationSession.
   */
  router.post('/initiate', asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { provider } = req.body;

    const validProviders: OAuthProvider[] = ['google', 'outlook', 'strava', 'todoist', 'notion'];
    if (!provider || !validProviders.includes(provider)) {
      sendError(res, 'BAD_REQUEST', `Invalid provider. Valid: ${validProviders.join(', ')}`);
      return;
    }

    // Generate CSRF nonce
    cleanExpiredNonces();
    if (nonceStore.size >= MAX_NONCES) {
      // Evict oldest 10%
      const toEvict = Math.floor(MAX_NONCES * 0.1);
      let i = 0;
      for (const key of nonceStore.keys()) {
        if (i++ >= toEvict) break;
        nonceStore.delete(key);
      }
    }

    const nonce = crypto.randomBytes(16).toString('hex');
    nonceStore.set(nonce, { userId, provider, createdAt: Date.now() });

    // Generate the consent URL with iOS-origin state
    // The existing getOAuthUrl uses state=String(userId), but we need
    // to pass "ios:{userId}:{nonce}" instead. We'll construct the URL
    // manually here to inject the iOS state.
    const iosState = `ios:${userId}:${nonce}`;
    const url = getOAuthUrlWithState(provider, iosState);

    if (!url) {
      sendError(res, 'NOT_CONFIGURED', `OAuth not configured for ${provider}`, 503);
      return;
    }

    logger.info({ userId, provider, nonce: nonce.substring(0, 8) }, 'iOS OAuth flow initiated');
    sendSuccess(res, { url, provider });
  }));

  return router;
}

/**
 * Generate OAuth URL with a custom state parameter (for iOS flows).
 * Mirrors getOAuthUrl from oauth-flow.ts but injects the iOS state.
 */
function getOAuthUrlWithState(provider: string, state: string): string | null {
  const REDIRECT_BASE = process.env.OAUTH_REDIRECT_BASE || 'https://nexushub.me';

  if (provider === 'google') {
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: `${REDIRECT_BASE}/oauth/google/callback`,
      response_type: 'code',
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/gmail.readonly',
      ].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  if (provider === 'outlook') {
    const tenantId = config.outlook.tenantId || 'common';
    const params = new URLSearchParams({
      client_id: config.outlook.clientId,
      redirect_uri: `${REDIRECT_BASE}/oauth/outlook/callback`,
      response_type: 'code',
      scope: [
        'https://graph.microsoft.com/Calendars.ReadWrite',
        'https://graph.microsoft.com/Mail.ReadWrite',
        'https://graph.microsoft.com/Mail.Send',
        'https://graph.microsoft.com/Tasks.ReadWrite',
        'https://graph.microsoft.com/User.Read',
        'offline_access',
      ].join(' '),
      state,
    });
    return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  return null;
}
