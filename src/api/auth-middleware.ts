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
