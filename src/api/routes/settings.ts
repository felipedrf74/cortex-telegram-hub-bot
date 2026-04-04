// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { isBotPollingActive, getLastMessageAt } from '../../portal/telemetry';

export function settingsRoutes(): Router {
  const router = Router();

  /** GET /api/v1/status */
  router.get('/status', async (_req, res: Response) => {
    try {
      const startTime = (global as any).__startTime;
      const uptimeMs = startTime ? Date.now() - startTime : 0;
      const uptimeStr = uptimeMs > 86400000
        ? `${Math.floor(uptimeMs / 86400000)}d ${Math.floor((uptimeMs % 86400000) / 3600000)}h`
        : `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`;

      res.json({
        version: process.env.npm_package_version || '4.8.11',
        uptime: uptimeStr,
        botStatus: isBotPollingActive() ? 'online' : 'offline',
      });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** GET /api/v1/connections */
  router.get('/connections', async (_req, res: Response) => {
    try {
      const connections: { name: string; status: string; lastSync: string | null }[] = [];

      // Check each integration
      try {
        const { isOutlookCalendarConfigured } = require('../../services/outlook-calendar');
        connections.push({
          name: 'Outlook Calendar',
          status: isOutlookCalendarConfigured() ? 'connected' : 'disconnected',
          lastSync: null,
        });
      } catch { connections.push({ name: 'Outlook Calendar', status: 'unavailable', lastSync: null }); }

      try {
        const { isGoogleCalendarConfigured } = require('../../services/google-calendar');
        connections.push({
          name: 'Google Calendar',
          status: isGoogleCalendarConfigured() ? 'connected' : 'disconnected',
          lastSync: null,
        });
      } catch { connections.push({ name: 'Google Calendar', status: 'unavailable', lastSync: null }); }

      try {
        const { isOutlookTodoConfigured } = require('../../services/microsoft-todo');
        connections.push({
          name: 'Microsoft To Do',
          status: isOutlookTodoConfigured() ? 'connected' : 'disconnected',
          lastSync: null,
        });
      } catch { connections.push({ name: 'Microsoft To Do', status: 'unavailable', lastSync: null }); }

      try {
        const { isGarminConfigured } = require('../../services/garmin');
        connections.push({
          name: 'Garmin Connect',
          status: isGarminConfigured() ? 'connected' : 'disconnected',
          lastSync: null,
        });
      } catch { connections.push({ name: 'Garmin Connect', status: 'unavailable', lastSync: null }); }

      res.json({ connections });
    } catch (err: any) {
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** POST /api/v1/settings/language */
  router.post('/language', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { language } = req.body;

    if (!language || !['pt-BR', 'en-US'].includes(language)) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'language must be pt-BR or en-US' },
      });
      return;
    }

    try {
      const { setUserLanguage } = require('../../services/user-service');
      setUserLanguage(userId, language);
      res.json({ language });
    } catch (err: any) {
      logger.error({ err }, 'iOS set language failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** POST /api/v1/settings/push-token */
  router.post('/push-token', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const deviceId = (req as AuthenticatedRequest).deviceId;
    const { token } = req.body;

    try {
      const db = require('../../services/database').getDb();
      db.prepare('UPDATE ios_devices SET push_token = ? WHERE user_id = ? AND device_id = ?')
        .run(token, userId, deviceId);
      res.json({ updated: true });
    } catch (err: any) {
      logger.error({ err }, 'iOS push-token update failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  return router;
}
