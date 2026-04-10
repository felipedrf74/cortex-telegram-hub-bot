// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../../config';
import { getDb } from '../../services/database';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import { logAudit } from '../../services/audit-trail';

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

  return router;
}
