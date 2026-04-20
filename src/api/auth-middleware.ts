// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../utils/logger';
import { sendError } from './response-helpers';

export interface AuthenticatedRequest extends Request {
  userId: number;
  deviceId: string;
}

/**
 * JWT authentication middleware for iOS API routes.
 * Validates the Bearer token and attaches userId/deviceId to the request.
 *
 * Emits the canonical error envelope ({ ok: false, error: { code,
 * message }, timestamp }) so every 401 on the /api/v1 surface decodes
 * with the same Swift enum the rest of the contract uses. The legacy
 * bare-shape ({ error: { code, message } }) emitted previously still
 * decoded on the client via a fallback path, but the unified shape
 * lets the staging smoke tighten its 401 assertion and removes the
 * "which shape is it?" ambiguity for future contract changes.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'UNAUTHORIZED', 'Missing token', 401);
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.ios.jwtSecret) as {
      userId: number;
      deviceId: string;
    };

    // Hardening audit 2026-04-20: verify the user is still active
    // BEFORE admitting the request. Previously the middleware trusted
    // the JWT `userId` verbatim — a banned / disabled / hard-deleted
    // user with an unexpired token had full access until natural
    // expiry. One indexed SELECT on `users.status` closes that.
    // Indexed on `idx_users_status` (migrations/030_users.sql:22).
    try {
      const { getDb } = require('../services/database');
      const row = getDb()
        .prepare('SELECT status FROM users WHERE id = ?')
        .get(payload.userId) as { status?: string } | undefined;
      if (!row) {
        // Token references a user that no longer exists — probably
        // post-deletion. Reject rather than proceed with a dangling id.
        logger.warn({ userId: payload.userId }, 'iOS JWT: user row not found — rejecting');
        sendError(res, 'UNAUTHORIZED', 'User account no longer exists', 401);
        return;
      }
      if (row.status && row.status !== 'active') {
        logger.warn(
          { userId: payload.userId, status: row.status },
          'iOS JWT: user status is not active — rejecting',
        );
        sendError(res, 'UNAUTHORIZED', 'User account is not active', 401);
        return;
      }
    } catch (err) {
      // DB lookup failed. Fail CLOSED: if we can't verify the user's
      // status we don't admit the request. This is a deliberate
      // availability-for-security tradeoff — an open auth bypass on DB
      // degradation is worse than a brief 401 storm.
      logger.error({ err, userId: payload.userId }, 'iOS JWT: user-status check failed — rejecting');
      sendError(res, 'UNAUTHORIZED', 'Authentication service unavailable', 401);
      return;
    }

    (req as AuthenticatedRequest).userId = payload.userId;
    (req as AuthenticatedRequest).deviceId = payload.deviceId;

    // Update last_active_at for portal user tracking (fire-and-forget, non-blocking)
    try {
      const { getDb } = require('../services/database');
      getDb().prepare(
        "UPDATE ios_devices SET last_active_at = datetime('now') WHERE user_id = ? AND device_id = ?"
      ).run(payload.userId, payload.deviceId);
      getDb().prepare(
        "UPDATE users SET last_active_at = datetime('now') WHERE id = ?"
      ).run(payload.userId);
    } catch { /* non-critical — don't block the request */ }

    next();
  } catch (err) {
    logger.debug({ err }, 'iOS JWT verification failed');
    sendError(res, 'UNAUTHORIZED', 'Invalid or expired token', 401);
  }
}
