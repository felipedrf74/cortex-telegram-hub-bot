// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { config } from '../../config';
import { getDb } from '../../services/database';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import { logAudit } from '../../services/audit-trail';
import {
  getUserByAppleId, getUserByGoogleId, getUserByEmail, getUserById,
  createAppleUser, createGoogleUser, createEmailUser,
} from '../../services/user-service';

// Apple JWKS cache
let appleJwksCache: { keys: any[]; fetchedAt: number } | null = null;
const APPLE_JWKS_TTL = 24 * 60 * 60 * 1000; // 24h

async function getAppleJwks(): Promise<any[]> {
  if (appleJwksCache && Date.now() - appleJwksCache.fetchedAt < APPLE_JWKS_TTL) {
    return appleJwksCache.keys;
  }
  const res = await fetch('https://appleid.apple.com/auth/keys');
  const data = await res.json() as { keys: any[] };
  appleJwksCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

/**
 * Common helper: register device + issue JWT + return auth response.
 * Used by all auth routes after the user is identified/created.
 */
function issueTokensAndRegisterDevice(
  req: Request, res: Response, userId: number,
  deviceId: string, deviceName: string | null,
  pushToken: string | null, user: { first_name?: string | null; language?: string },
): void {
  const accessToken = jwt.sign(
    { userId, deviceId },
    config.ios.jwtSecret,
    { expiresIn: '7d' as any },
  );
  const refreshToken = crypto.randomBytes(64).toString('hex');

  const db = getDb();
  db.prepare(`
    INSERT INTO ios_devices (user_id, device_id, device_name, push_token, refresh_token)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      user_id = excluded.user_id,
      device_name = excluded.device_name,
      push_token = excluded.push_token,
      refresh_token = excluded.refresh_token,
      last_active_at = datetime('now')
  `).run(userId, deviceId, deviceName, pushToken, refreshToken);

  // Check founders list: if the user's email is in the founders table,
  // grant them a permanent subscription with the assigned plan.
  // Otherwise, no subscription is created — the paywall is active.
  try {
    const userRow = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined;
    if (userRow?.email) {
      const { getFounderPlan, syncFounderSubscription } = require('../../services/founders');
      const founderPlan = getFounderPlan(userRow.email);
      if (founderPlan) {
        syncFounderSubscription(userRow.email, founderPlan);
        logger.info({ userId, email: userRow.email, plan: founderPlan }, 'Founder subscription granted on registration');
      }
    }
  } catch { /* founders table may not exist yet */ }

  logAudit({
    userId, actorId: userId, action: 'access', resource: 'auth.register',
    details: { deviceId, deviceName },
    ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
  });

  sendSuccess(res, {
    accessToken, refreshToken, expiresIn: 604800,
    user: { id: userId, firstName: user.first_name || 'User', language: user.language || 'en' },
  }, { status: 201 });
}

export function authRoutes(): Router {
  const router = Router();

  /**
   * POST /api/v1/auth/register
   * Device registration. Creates or retrieves a user session.
   */
  router.post('/register', asyncHandler(async (req: Request, res: Response) => {
    const { deviceId, deviceName, pushToken, inviteCode } = req.body;

    if (!deviceId || !inviteCode) {
      sendError(res, 'BAD_REQUEST', 'deviceId and inviteCode are required');
      return;
    }

    // ── Invite code → user mapping ──────────────────────────────────
    //
    // Two-tier system:
    //   • OWNER code (IOS_OWNER_CODE env) → maps to the real owner's
    //     Telegram user ID with full data (calendar, tasks, etc.)
    //   • BETA code (IOS_INVITE_CODE env) → maps to a sandboxed demo
    //     user ID with NO linked integrations, so Apple reviewers and
    //     beta testers never see the owner's personal data.
    //
    // The demo user ID is a synthetic constant (1000000001) that has
    // no OAuth tokens, no Telegram account, and no personal data.

    const ownerCode = config.ios.ownerCode || '';
    const betaCode = config.ios.inviteCode || '';

    let userId: number;

    if (ownerCode && inviteCode === ownerCode) {
      // Owner: resolve users.id from their Telegram ID.
      const ownerTelegramId = config.telegram.allowedUserIds[0];
      if (!ownerTelegramId) {
        sendError(res, 'NO_USER', 'No users configured', 500);
        return;
      }
      const { getUserByTelegramId: findByTgId } = require('../../services/user-service');
      const ownerUser = findByTgId(ownerTelegramId);
      userId = ownerUser?.id ?? ownerTelegramId;
    } else if (betaCode && inviteCode === betaCode) {
      // Beta/reviewer: create a unique sandbox user per device.
      // Each deviceId gets its own users.id — no shared DEMO_USER_ID.
      // This ensures strict per-tester isolation.
      const db = getDb();
      const existingDevice = db.prepare(
        'SELECT user_id FROM ios_devices WHERE device_id = ?'
      ).get(deviceId) as { user_id: number } | undefined;

      if (existingDevice) {
        userId = existingDevice.user_id;
      } else {
        // Create a new sandbox user for this device
        const result = db.prepare(
          "INSERT INTO users (first_name, auth_provider, status) VALUES (?, 'invite_code', 'active')"
        ).run(`Beta-${deviceId.slice(0, 8)}`);
        userId = result.lastInsertRowid as number;
        logger.info({ userId, deviceId: deviceId.slice(0, 8) }, 'Created sandbox user for beta tester');
      }
    } else {
      sendError(res, 'INVALID_INVITE', 'Invalid invite code', 403);
      return;
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { userId, deviceId },
      config.ios.jwtSecret,
      { expiresIn: '7d' as any },
    );
    const refreshToken = crypto.randomBytes(64).toString('hex');

    // Store device registration
    const db = getDb();
    db.prepare(`
      INSERT INTO ios_devices (user_id, device_id, device_name, push_token, refresh_token)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        device_name = excluded.device_name,
        push_token = excluded.push_token,
        refresh_token = excluded.refresh_token,
        last_active_at = datetime('now')
    `).run(userId, deviceId, deviceName || null, pushToken || null, refreshToken);

    logger.info({ userId, deviceId, deviceName }, 'iOS device registered');

    // Audit P0-10: device registration is a sensitive credential-issuance event.
    // Logged so the user can later see "this device joined my account on date X
    // from IP Y" via /api/v1/audit-trail/me.
    logAudit({
      userId,
      actorId: userId,
      action: 'access',
      resource: 'auth.register',
      details: { deviceId, deviceName: deviceName || null },
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
    });

    // Pull user info from user-service
    let firstName = 'User';
    let language = 'pt-BR';
    try {
      const { getUserLanguage, getUserDisplayName } = require('../../services/user-service');
      firstName = getUserDisplayName?.(userId) || 'User';
      language = getUserLanguage?.(userId) || 'pt-BR';
    } catch { /* user-service may not have these exports */ }

    sendSuccess(res, {
      accessToken,
      refreshToken,
      expiresIn: 604800,
      user: {
        id: userId,
        firstName,
        language,
      },
    }, { status: 201 });
  }));

  /**
   * POST /api/v1/auth/refresh
   * Refresh an expired access token. Rotates the refresh token on success.
   */
  router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      sendError(res, 'BAD_REQUEST', 'refreshToken is required');
      return;
    }

    const db = getDb();
    const device = db.prepare(
      'SELECT user_id, device_id FROM ios_devices WHERE refresh_token = ?',
    ).get(refreshToken) as { user_id: number; device_id: string } | undefined;

    if (!device) {
      sendError(res, 'UNAUTHORIZED', 'Invalid refresh token', 401);
      return;
    }

    const accessToken = jwt.sign(
      { userId: device.user_id, deviceId: device.device_id },
      config.ios.jwtSecret,
      { expiresIn: '7d' as any },
    );

    // Rotate refresh token — invalidate old one, issue new one
    const newRefreshToken = crypto.randomBytes(64).toString('hex');
    db.prepare('UPDATE ios_devices SET refresh_token = ?, last_active_at = datetime(\'now\') WHERE device_id = ?')
      .run(newRefreshToken, device.device_id);

    // Audit P0-10: refresh token rotation. Sensitive because it extends a
    // session — if a leaked refresh token is used, the resulting refresh+
    // rotation will show up here as a new audit row.
    logAudit({
      userId: device.user_id,
      actorId: device.user_id,
      action: 'access',
      resource: 'auth.refresh',
      details: { deviceId: device.device_id },
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
    });

    sendSuccess(res, { accessToken, refreshToken: newRefreshToken, expiresIn: 604800 });
  }));

  // ── Sign in with Apple ─────────────────────────────────────────────
  router.post('/register/apple', asyncHandler(async (req: Request, res: Response) => {
    const { identityToken, deviceId, deviceName, firstName, lastName } = req.body;
    if (!identityToken || !deviceId) {
      sendError(res, 'BAD_REQUEST', 'identityToken and deviceId are required');
      return;
    }

    try {
      // Decode JWT header to find the key ID (kid)
      const header = JSON.parse(Buffer.from(identityToken.split('.')[0], 'base64url').toString());
      const keys = await getAppleJwks();
      const key = keys.find((k: any) => k.kid === header.kid);
      if (!key) {
        sendError(res, 'INVALID_TOKEN', 'Apple key not found', 401);
        return;
      }

      // Convert JWK to PEM for verification
      const jwkToPem = (await import('crypto')).createPublicKey({ key, format: 'jwk' });
      const payload = jwt.verify(identityToken, jwkToPem, {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: config.apns.bundleId, // me.nexushub.app
      }) as any;

      const appleUserId = payload.sub;
      const email = payload.email;

      // Find or create user
      let user = getUserByAppleId(appleUserId);
      if (!user) {
        user = createAppleUser(appleUserId, { email, firstName, lastName });
      }

      issueTokensAndRegisterDevice(req, res, user.id, deviceId, deviceName || null, null, user);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Apple sign-in verification failed');
      sendError(res, 'AUTH_FAILED', 'Apple authentication failed', 401);
    }
  }));

  // ── Sign in with Google (PKCE) ────────────────────────────────────
  //
  // Supports two flows for backward compatibility:
  //   1. PKCE (recommended): iOS sends { code, codeVerifier, redirectURI }
  //      Backend exchanges the code for an id_token with Google server-side
  //   2. Legacy implicit: iOS sends { idToken }
  //      Backend verifies the id_token directly (deprecated, kept for compat)
  //
  router.post('/register/google', asyncHandler(async (req: Request, res: Response) => {
    const { code, codeVerifier, redirectURI, idToken, deviceId, deviceName } = req.body;
    if (!deviceId) {
      sendError(res, 'BAD_REQUEST', 'deviceId is required');
      return;
    }

    try {
      let payload: any;

      if (code && codeVerifier && redirectURI) {
        // ── PKCE flow: exchange authorization code for tokens ──────
        // iOS native apps are "public clients" — Google does NOT require
        // a client_secret for iOS client IDs. Sending the web client_secret
        // with the iOS client_id causes "invalid_client" errors.
        // Only include client_secret when using the web client ID.
        const exchangeClientId = config.google.iosClientId || config.google.clientId;
        const isIosClient = config.google.iosClientId && exchangeClientId === config.google.iosClientId;
        const tokenParams: Record<string, string> = {
          code,
          client_id: exchangeClientId,
          redirect_uri: redirectURI,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        };
        // Web clients need the secret; iOS native clients must NOT send it
        if (!isIosClient && config.google.clientSecret) {
          tokenParams.client_secret = config.google.clientSecret;
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(tokenParams).toString(),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.text();
          logger.warn({ status: tokenRes.status, body: errBody }, 'Google PKCE token exchange failed');
          sendError(res, 'INVALID_TOKEN', 'Google token exchange failed', 401);
          return;
        }

        const tokens = await tokenRes.json() as any;
        const googleIdToken = tokens.id_token;

        if (!googleIdToken) {
          sendError(res, 'INVALID_TOKEN', 'No id_token in Google response', 401);
          return;
        }

        // Verify the id_token
        const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(googleIdToken)}`);
        if (!verifyRes.ok) {
          sendError(res, 'INVALID_TOKEN', 'Google id_token verification failed', 401);
          return;
        }
        payload = await verifyRes.json() as any;

      } else if (idToken) {
        // ── Legacy implicit flow (backward compat) ────────────────
        const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
        if (!verifyRes.ok) {
          sendError(res, 'INVALID_TOKEN', 'Google token verification failed', 401);
          return;
        }
        payload = await verifyRes.json() as any;

      } else {
        sendError(res, 'BAD_REQUEST', 'Either code+codeVerifier+redirectURI (PKCE) or idToken (legacy) is required');
        return;
      }

      // Validate issuer
      if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) {
        sendError(res, 'INVALID_TOKEN', 'Invalid token issuer', 401);
        return;
      }

      // Validate audience — must be our web OR iOS client ID
      const validAuds = [config.google.clientId, config.google.iosClientId].filter(Boolean);
      if (validAuds.length > 0 && !validAuds.includes(payload.aud)) {
        sendError(res, 'INVALID_TOKEN', 'Token not issued for this application', 401);
        return;
      }

      const googleUserId = payload.sub;
      const email = payload.email;
      const name = payload.name;
      const picture = payload.picture;

      // Find or create user — check by Google ID first, then by email.
      // An existing user (created via setup script, invite code, or Apple)
      // may have the same email but no google_user_id yet. Link their
      // Google ID instead of creating a duplicate that violates UNIQUE(email).
      let user = getUserByGoogleId(googleUserId);
      if (!user && email) {
        const { getUserByEmail } = require('../../services/user-service');
        user = getUserByEmail(email);
        if (user) {
          // Link Google ID to existing account
          const db = getDb();
          db.prepare('UPDATE users SET google_user_id = ?, avatar_url = COALESCE(avatar_url, ?), email_verified = 1 WHERE id = ?')
            .run(googleUserId, picture || null, user.id);
          logger.info({ userId: user.id, googleUserId, email }, 'Linked Google ID to existing user');
        }
      }
      if (!user) {
        user = createGoogleUser(googleUserId, { email, name, picture });
      }

      issueTokensAndRegisterDevice(req, res, user.id, deviceId, deviceName || null, null, user);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Google sign-in verification failed');
      sendError(res, 'AUTH_FAILED', 'Google authentication failed', 401);
    }
  }));

  // ── Register with Email + Password ────────────────────────────────
  router.post('/register/email', asyncHandler(async (req: Request, res: Response) => {
    const { email, password, firstName, deviceId, deviceName } = req.body;
    if (!email || !password || !firstName || !deviceId) {
      sendError(res, 'BAD_REQUEST', 'email, password, firstName, and deviceId are required');
      return;
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendError(res, 'INVALID_EMAIL', 'Invalid email format', 400);
      return;
    }

    // Validate password strength
    if (password.length < 8) {
      sendError(res, 'WEAK_PASSWORD', 'Password must be at least 8 characters', 400);
      return;
    }

    // Check if email already exists
    const existing = getUserByEmail(email);
    if (existing) {
      sendError(res, 'EMAIL_EXISTS', 'An account with this email already exists', 409);
      return;
    }

    // Hash password with bcrypt (cost factor 12)
    const passwordHash = await bcrypt.hash(password, 12);
    const user = createEmailUser(email, passwordHash, { firstName });

    // Auto-send verification code after registration
    try {
      const { sendVerificationCode, isEmailConfigured } = require('../../services/email-sender');
      if (isEmailConfigured()) {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const db = getDb();
        db.prepare(`
          INSERT INTO email_verification_codes (user_id, email, code, expires_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at
        `).run(user.id, email.toLowerCase(), code, expiresAt);
        // Fire-and-forget — don't block registration on email delivery
        sendVerificationCode(email, code, firstName).catch(() => {});
      }
    } catch { /* email service not available — non-fatal */ }

    issueTokensAndRegisterDevice(req, res, user.id, deviceId, deviceName || null, null, user);
  }));

  // ── Login with Email + Password ───────────────────────────────────
  router.post('/login/email', asyncHandler(async (req: Request, res: Response) => {
    const { email, password, deviceId, deviceName } = req.body;
    if (!email || !password || !deviceId) {
      sendError(res, 'BAD_REQUEST', 'email, password, and deviceId are required');
      return;
    }

    // Vague error on all failures (never reveal if email exists)
    const user = getUserByEmail(email);
    if (!user || !user.password_hash) {
      sendError(res, 'AUTH_FAILED', 'Invalid email or password', 401);
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      sendError(res, 'AUTH_FAILED', 'Invalid email or password', 401);
      return;
    }

    if (user.status !== 'active') {
      sendError(res, 'ACCOUNT_SUSPENDED', 'Your account has been suspended', 403);
      return;
    }

    issueTokensAndRegisterDevice(req, res, user.id, deviceId, deviceName || null, null, user);
  }));

  // ── Send Verification Code ─────────────────────────────────────────
  // These verification routes need JWT auth but live in the public auth
  // router. We inline the auth check via the authMiddleware import.
  const { authMiddleware: verifyJwt } = require('../auth-middleware');

  router.post('/send-verification', verifyJwt, asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;

    const db = getDb();
    const user = getUserById(userId);
    if (!user?.email) {
      sendError(res, 'NO_EMAIL', 'No email address on this account');
      return;
    }

    if (user.email_verified) {
      sendSuccess(res, { verified: true, message: 'Email already verified' });
      return;
    }

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Store code (UPSERT — one active code per user)
    db.prepare(`
      INSERT INTO email_verification_codes (user_id, email, code, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        code = excluded.code,
        email = excluded.email,
        expires_at = excluded.expires_at,
        created_at = datetime('now')
    `).run(userId, user.email, code, expiresAt);

    // Send email
    try {
      const { sendVerificationCode, isEmailConfigured } = require('../../services/email-sender');
      if (!isEmailConfigured()) {
        logger.warn('Email not configured — verification code not sent');
        // In dev, return the code so testing works
        sendSuccess(res, { sent: false, message: 'Email service not configured', devCode: code });
        return;
      }
      const sent = await sendVerificationCode(user.email, code, user.first_name || 'User');
      sendSuccess(res, { sent, message: sent ? 'Verification code sent' : 'Failed to send email' });
    } catch (err: any) {
      logger.error({ err, userId }, 'Failed to send verification email');
      sendError(res, 'EMAIL_FAILED', 'Failed to send verification email', 500);
    }
  }));

  // ── Verify Email Code ─────────────────────────────────────────────
  router.post('/verify-email', verifyJwt, asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { code } = req.body;

    if (!userId || !code) {
      sendError(res, 'BAD_REQUEST', 'Authentication and code are required');
      return;
    }

    const db = getDb();
    const record = db.prepare(
      'SELECT * FROM email_verification_codes WHERE user_id = ? AND code = ?'
    ).get(userId, String(code)) as any;

    if (!record) {
      sendError(res, 'INVALID_CODE', 'Invalid verification code', 400);
      return;
    }

    // Check expiry
    if (new Date(record.expires_at) < new Date()) {
      sendError(res, 'CODE_EXPIRED', 'Verification code has expired. Request a new one.', 400);
      return;
    }

    // Mark email as verified
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);

    // Clean up the code
    db.prepare('DELETE FROM email_verification_codes WHERE user_id = ?').run(userId);

    logAudit({
      userId, actorId: userId, action: 'access', resource: 'auth.verify_email',
      ipAddress: (req.ip || req.socket?.remoteAddress) ?? undefined,
    });

    logger.info({ userId }, 'Email verified successfully');
    sendSuccess(res, { verified: true });
  }));

  return router;
}
