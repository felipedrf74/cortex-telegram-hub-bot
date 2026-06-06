// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OAuth Initiate — generates consent URLs for iOS integration onboarding.
 *
 * POST /api/v1/auth/oauth/initiate
 * Body: { provider: 'google' | 'outlook' | 'strava' | 'whoop' }
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
import { config } from '../../config';
import type { OAuthProvider } from '../../services/oauth-store';
import { createOAuthNonceSession, consumeOAuthNonceSession } from '../../services/oauth-state-store';

/** Validate and consume a nonce. Returns the userId if valid, null if not. */
export function consumeNonce(nonce: string): { userId: number; provider: string } | null {
  return consumeOAuthNonceSession(nonce);
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

    const validProviders: OAuthProvider[] = ['google', 'outlook', 'strava', 'whoop', 'todoist', 'notion'];
    if (!provider || !validProviders.includes(provider)) {
      sendError(res, 'BAD_REQUEST', `Invalid provider. Valid: ${validProviders.join(', ')}`);
      return;
    }

    if (provider === 'whoop') {
      sendError(res, 'COMING_SOON', 'WHOOP is coming soon in this iOS release.', 503);
      return;
    }

    const nonce = createOAuthNonceSession(userId, provider, crypto.randomBytes(16).toString('hex'));

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
  const REDIRECT_BASE = process.env.OAUTH_REDIRECT_BASE || 'https://api.nexushub.me';

  if (provider === 'google') {
    if (!config.google.clientId) return null;
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
    if (!config.outlook.clientId) return null;
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

  if (provider === 'strava') {
    const clientId = process.env.STRAVA_CLIENT_ID;
    if (!clientId) return null;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${REDIRECT_BASE}/oauth/strava/callback`,
      response_type: 'code',
      scope: 'read,activity:read_all',
      approval_prompt: 'force',
      state,
    });
    return `https://www.strava.com/oauth/mobile/authorize?${params.toString()}`;
  }

  if (provider === 'whoop') {
    const clientId = process.env.WHOOP_CLIENT_ID;
    if (!clientId) return null;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `${REDIRECT_BASE}/oauth/whoop/callback`,
      response_type: 'code',
      scope: 'read:recovery read:sleep read:workout read:cycles read:profile offline',
      state,
    });
    return `https://api.prod.whoop.com/oauth/oauth2/auth?${params.toString()}`;
  }

  return null;
}
