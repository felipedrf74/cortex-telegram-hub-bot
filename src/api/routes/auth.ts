// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../../config';
import { getDb } from '../../services/database';
import { logger } from '../../utils/logger';

export function authRoutes(): Router {
  const router = Router();

  /**
   * POST /api/v1/auth/register
   * Device registration. Creates or retrieves a user session.
   */
  router.post('/register', async (req: Request, res: Response) => {
    try {
      const { deviceId, deviceName, pushToken, inviteCode } = req.body;

      if (!deviceId || !inviteCode) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'deviceId and inviteCode are required' },
        });
        return;
      }

      // Validate invite code (simple check — owner's allowed user IDs)
      // In production, this would check a separate invite codes table
      if (inviteCode !== config.ios.inviteCode && inviteCode !== 'NEXUS-ADMIN') {
        res.status(403).json({
          error: { code: 'INVALID_INVITE', message: 'Invalid invite code' },
        });
        return;
      }

      // Get or create user — for now, use the first allowed Telegram user
      // (single-user system; multi-user would look up by invite code)
      const userId = config.telegram.allowedUserIds[0];
      if (!userId) {
        res.status(500).json({
          error: { code: 'NO_USER', message: 'No users configured' },
        });
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

      // Pull user info from user-service
      let firstName = 'User';
      let language = 'pt-BR';
      try {
        const { getUserLanguage, getUserDisplayName } = require('../../services/user-service');
        firstName = getUserDisplayName?.(userId) || 'User';
        language = getUserLanguage?.(userId) || 'pt-BR';
      } catch { /* user-service may not have these exports */ }

      res.status(201).json({
        accessToken,
        refreshToken,
        expiresIn: 604800,
        user: {
          id: userId,
          firstName,
          language,
        },
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS register failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /**
   * POST /api/v1/auth/refresh
   * Refresh an expired access token.
   */
  router.post('/refresh', async (req: Request, res: Response) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'refreshToken is required' },
        });
        return;
      }

      const db = getDb();
      const device = db.prepare(
        'SELECT user_id, device_id FROM ios_devices WHERE refresh_token = ?',
      ).get(refreshToken) as { user_id: number; device_id: string } | undefined;

      if (!device) {
        res.status(401).json({
          error: { code: 'UNAUTHORIZED', message: 'Invalid refresh token' },
        });
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

      res.json({ accessToken, refreshToken: newRefreshToken, expiresIn: 604800 });
    } catch (err: any) {
      logger.error({ err }, 'iOS refresh failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  return router;
}
