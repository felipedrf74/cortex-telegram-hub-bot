// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { createGoogleUser, getUserByEmail, getUserByGoogleId, type User } from './user-service';

export interface GoogleIdentityPayload {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

function validateGoogleIdentityPayload(payload: any): GoogleIdentityPayload {
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload?.iss)) {
    throw new Error('Invalid token issuer');
  }

  const validAuds = [config.google.clientId, config.google.iosClientId].filter(Boolean);
  if (validAuds.length > 0 && !validAuds.includes(payload?.aud)) {
    throw new Error('Token not issued for this application');
  }

  if (!payload?.sub || !payload?.email) {
    throw new Error('Google identity payload is missing required fields');
  }

  return {
    iss: payload.iss,
    aud: payload.aud,
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
  };
}

export async function verifyGoogleIdentityToken(idToken: string): Promise<GoogleIdentityPayload> {
  const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!verifyRes.ok) {
    throw new Error('Google token verification failed');
  }
  const payload = await verifyRes.json() as any;
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

export function resolveGoogleIdentityUser(payload: GoogleIdentityPayload): User {
  const googleUserId = payload.sub;
  const email = payload.email;
  const name = payload.name;
  const picture = payload.picture;

  let user = getUserByGoogleId(googleUserId);
  if (!user && email) {
    user = getUserByEmail(email);
    if (user) {
      const db = getDb();
      db.prepare('UPDATE users SET google_user_id = ?, avatar_url = COALESCE(avatar_url, ?), email_verified = 1 WHERE id = ?')
        .run(googleUserId, picture || null, user.id);
      logger.info({ userId: user.id, googleUserId, email }, 'Linked Google ID to existing user');
      user = getUserByGoogleId(googleUserId) ?? user;
    }
  }

  if (!user) {
    user = createGoogleUser(googleUserId, { email, name, picture });
  }

  return user;
}
