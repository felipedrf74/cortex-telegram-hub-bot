// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { OAuth2Client } from 'google-auth-library';
import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { createGoogleUser, getUserByEmail, getUserByGoogleId, type User } from './user-service';

/**
 * Singleton OAuth2Client used for ID-token verification only.
 * The closed-beta-auth-hardening pass (2026-05-04) replaced the
 * deprecated `https://oauth2.googleapis.com/tokeninfo?id_token=...`
 * debug endpoint with `OAuth2Client.verifyIdToken({...})` from
 * `google-auth-library`. Reasons:
 *   - tokeninfo is documented by Google as a debug/dev tool, not for
 *     production identity verification.
 *   - tokeninfo issues a synchronous network round-trip on every
 *     login — both DoS surface and SPOF on Google's rate limit.
 *   - tokeninfo's `email_verified` claim historically returns as a
 *     string `"true"` / `"false"`; a future contract change can
 *     silently flip our validator.
 *   - `OAuth2Client.verifyIdToken` does the right thing locally:
 *     downloads + caches Google's JWKS, validates the RS256
 *     signature against the matching `kid`, validates `iss` against
 *     `accounts.google.com` / `https://accounts.google.com`,
 *     validates `aud` against the supplied audience list, validates
 *     `exp` against now. All without an extra network hop per login.
 */
const idTokenVerifier = new OAuth2Client();

export interface GoogleIdentityPayload {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  /**
   * Google's claim that the email has been verified by Google.
   * Closed-beta-auth-hardening (2026-05-04): this MUST be checked
   * before linking the Google sub to an existing email-matched user.
   * Without this gate, a user who signed up via email/password with
   * a typo'd "victim@example.com" they don't own can have their
   * account silently merged with a Google account from the real
   * `victim@example.com` — or vice versa.
   *
   * Google's `tokeninfo` endpoint returns the value as a string
   * (`"true"` / `"false"`); we normalize to boolean in
   * `validateGoogleIdentityPayload`.
   */
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

function validateGoogleIdentityPayload(payload: any): GoogleIdentityPayload {
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload?.iss)) {
    throw new Error('Invalid token issuer');
  }

  const validAuds = [config.google.clientId, config.google.iosClientId].filter(Boolean);
  // Closed-beta-auth-hardening (2026-05-04): the previous code allowed
  // ANY audience when `validAuds.length === 0` (i.e. neither
  // `GOOGLE_CLIENT_ID` nor `GOOGLE_IOS_CLIENT_ID` was configured).
  // That is a misconfiguration smell — running with Google sign-in
  // routes mounted but no client id set means there is nothing to
  // verify against. Fail closed so a deployment with the env vars
  // missing returns 401/AUTH_FAILED rather than silently accepting
  // any Google-issued id_token.
  if (validAuds.length === 0) {
    throw new Error('Google client id is not configured; refusing to verify token');
  }
  if (!validAuds.includes(payload?.aud)) {
    throw new Error('Token not issued for this application');
  }

  if (!payload?.sub || !payload?.email) {
    throw new Error('Google identity payload is missing required fields');
  }

  // Normalize email_verified — Google tokeninfo returns it as a string,
  // ID-token JWS payloads return it as a boolean. Both are accepted;
  // anything else is treated as unverified (fail closed).
  const rawVerified = payload.email_verified;
  const emailVerified =
    rawVerified === true ||
    rawVerified === 'true' ||
    rawVerified === 1 ||
    rawVerified === '1';

  return {
    iss: payload.iss,
    aud: payload.aud,
    sub: payload.sub,
    email: payload.email,
    emailVerified,
    name: payload.name,
    picture: payload.picture,
  };
}

export async function verifyGoogleIdentityToken(idToken: string): Promise<GoogleIdentityPayload> {
  const validAuds = [config.google.clientId, config.google.iosClientId].filter(Boolean) as string[];
  if (validAuds.length === 0) {
    // Same fail-closed contract as validateGoogleIdentityPayload —
    // refuse to verify if no client id is configured.
    throw new Error('Google client id is not configured; refusing to verify token');
  }

  // OAuth2Client.verifyIdToken validates the RS256 signature against
  // Google's cached JWKS, checks issuer and audience, and validates
  // the expiry — all locally, without the per-request network round
  // trip that the legacy tokeninfo path required.
  const ticket = await idTokenVerifier.verifyIdToken({
    idToken,
    audience: validAuds,
  });
  const payload = ticket.getPayload();
  if (!payload) {
    throw new Error('Google id_token verification produced no payload');
  }
  return validateGoogleIdentityPayload(payload);
}

export async function exchangeGoogleCodeForIdentity(code: string, redirectURI: string): Promise<GoogleIdentityPayload> {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error('Google web client is not configured');
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectURI,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text();
    logger.warn({ status: tokenRes.status, body: errBody }, 'Google auth code exchange failed');
    throw new Error('Google token exchange failed');
  }

  const tokens = await tokenRes.json() as { id_token?: string };
  if (!tokens.id_token) {
    throw new Error('No id_token in Google response');
  }

  return verifyGoogleIdentityToken(tokens.id_token);
}

export class GoogleAccountLinkRequiresVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAccountLinkRequiresVerificationError';
  }
}

export class GoogleEmailNotVerifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleEmailNotVerifiedError';
  }
}

export function resolveGoogleIdentityUser(
  payload: GoogleIdentityPayload,
  options: { inviteCode?: unknown } = {},
): User {
  if (!payload.emailVerified) {
    logger.warn(
      {
        event: 'auth',
        action: 'google_sign_in',
        outcome: 'rejected',
        reason: 'google_email_not_verified',
      },
      'Refused Google sign-in: email_verified is not true',
    );
    throw new GoogleEmailNotVerifiedError('Google has not verified this email.');
  }

  const googleUserId = payload.sub;
  const email = payload.email;
  const name = payload.name;
  const picture = payload.picture;

  let user = getUserByGoogleId(googleUserId);
  if (!user && email) {
    const existing = getUserByEmail(email);
    if (existing) {
      // Closed-beta-auth-hardening (2026-05-04): refuse to silently
      // merge Google sub into an existing email-matched user unless:
      //   1. Google has verified the email (`email_verified` claim).
      //   2. The existing user record is also email-verified OR has
      //      no other auth method (no password and no apple_user_id).
      //
      // Without this gate, an account-takeover vector exists:
      //   - Alice signed up via /register/email with bob@example.com
      //     (typo of her own email; she does not own that address).
      //     Her account exists with email_verified=0 and a password.
      //   - Bob signs in with Google using his real bob@example.com.
      //     Google's tokeninfo confirms email_verified=true.
      //   - Pre-fix code silently merged Bob's Google sub into
      //     Alice's account. Bob inherits Alice's tasks, calendar,
      //     training data — full takeover.
      //
      // Post-fix: this branch refuses to merge and surfaces a typed
      // error. The auth route translates it to a 409
      // ACCOUNT_LINK_REQUIRES_VERIFICATION HTTP error so iOS can
      // route the user to "Sign in with email + password to link
      // Google" UX.
      if (!existing.email_verified) {
        logger.warn(
          {
            event: 'auth',
            action: 'google_link_refused',
            outcome: 'rejected',
            reason: 'existing_email_not_verified',
            existingUserId: existing.id,
            googleUserId,
          },
          'Refused to link Google sub: existing user has not verified the email',
        );
        throw new GoogleAccountLinkRequiresVerificationError(
          'An account with this email already exists but the email has not been verified. Please sign in with the existing method first to link Google.',
        );
      }

      const db = getDb();
      db.prepare('UPDATE users SET google_user_id = ?, avatar_url = COALESCE(avatar_url, ?) WHERE id = ?')
        .run(googleUserId, picture || null, existing.id);
      logger.info(
        {
          event: 'auth',
          action: 'google_link',
          outcome: 'success',
          userId: existing.id,
          googleUserId,
        },
        'Linked Google ID to existing user (both sides email-verified)',
      );
      // AUTH-O6 (closed-beta-auth-hardening, 2026-05-04): emit
      // auth.provider_linked audit row when an existing user gets a
      // Google sub linked. The link branch is the highest-risk
      // user-creation surface (it merges identities) and was the
      // smoking gun behind v4.14.118-class issues.
      try {
        const { emitProviderLinkedAudit } = require('./user-service');
        emitProviderLinkedAudit(existing.id, 'google', { googleUserId });
      } catch (err: any) {
        logger.warn({ err, userId: existing.id }, 'Failed to emit auth.provider_linked audit');
      }
      user = getUserByGoogleId(googleUserId) ?? existing;
    }
  }

  if (!user) {
    user = createGoogleUser(googleUserId, { email, name, picture }, options.inviteCode);
  }

  return user;
}
