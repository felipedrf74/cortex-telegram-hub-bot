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
    const DEMO_USER_ID = 1000000001;

    let userId: number;

    if (ownerCode && inviteCode === ownerCode) {
      // Owner: full access to real data
      userId = config.telegram.allowedUserIds[0];
      if (!userId) {
        sendError(res, 'NO_USER', 'No users configured', 500);
        return;
      }
    } else if (betaCode && inviteCode === betaCode) {
      // Beta tester / Apple reviewer: sandboxed demo user
      userId = DEMO_USER_ID;
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

  // ── Sign in with Google ───────────────────────────────────────────
  router.post('/register/google', asyncHandler(async (req: Request, res: Response) => {
    const { idToken, deviceId, deviceName } = req.body;
    if (!idToken || !deviceId) {
      sendError(res, 'BAD_REQUEST', 'idToken and deviceId are required');
      return;
    }

    try {
      // Verify Google ID token via tokeninfo endpoint
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
      if (!verifyRes.ok) {
        sendError(res, 'INVALID_TOKEN', 'Google token verification failed', 401);
        return;
      }

      const payload = await verifyRes.json() as any;

      // Validate issuer
      if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) {
        sendError(res, 'INVALID_TOKEN', 'Invalid token issuer', 401);
        return;
      }

      const googleUserId = payload.sub;
      const email = payload.email;
      const name = payload.name;
      const picture = payload.picture;

      // Find or create user
      let user = getUserByGoogleId(googleUserId);
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

  return router;
}
