// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { isBotPollingActive, getLastMessageAt } from '../../portal/telemetry';
import { sendSuccess, sendError } from '../response-helpers';

export function settingsRoutes(): Router {
  const router = Router();

  /** GET /api/v1/settings/status */
  router.get('/status', async (_req, res: Response) => {
    try {
      const startTime = (global as any).__startTime;
      const uptimeMs = startTime ? Date.now() - startTime : 0;
      const uptimeStr = uptimeMs > 86400000
        ? `${Math.floor(uptimeMs / 86400000)}d ${Math.floor((uptimeMs % 86400000) / 3600000)}h`
        : `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`;

      sendSuccess(res, {
        version: (() => { try { return require('../../../package.json').version; } catch { return '0.0.0'; } })(),
        uptime: uptimeStr,
        botStatus: isBotPollingActive() ? 'online' : 'offline',
        lastMessageAt: getLastMessageAt(),
      });
    } catch (err: any) {
      sendError(res, 'INTERNAL', err?.message || 'Status fetch failed', 500);
    }
  });

  /**
   * GET /api/v1/settings/connections
   * Legacy global integration check (which providers are configured at server level).
   * The newer /api/v1/connections endpoint returns per-user OAuth connections.
   */
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

      sendSuccess(res, { connections });
    } catch (err: any) {
      sendError(res, 'INTERNAL', err?.message || 'Connections fetch failed', 500);
    }
  });

  /** POST /api/v1/settings/language */
  router.post('/language', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { language } = req.body;

    if (!language || !['pt-BR', 'en-US'].includes(language)) {
      sendError(res, 'BAD_REQUEST', 'language must be pt-BR or en-US');
      return;
    }

    try {
      const { setUserLanguage } = require('../../services/user-service');
      setUserLanguage(userId, language);
      sendSuccess(res, { language });
    } catch (err: any) {
      logger.error({ err }, 'iOS set language failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to set language', 500);
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
      sendSuccess(res, { updated: true });
    } catch (err: any) {
      logger.error({ err }, 'iOS push-token update failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to update push token', 500);
    }
  });

  /** POST /api/v1/settings/export — GDPR data export */
  router.post('/export', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const db = require('../../services/database').getDb();

      // Collect all user data
      const userData: Record<string, any> = {};

      // Messages
      try {
        userData.messages = db.prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 10000').all(userId);
      } catch { userData.messages = []; }

      // Profiles
      try {
        const onboarding = require('../../services/onboarding');
        const allQ = onboarding.getAllQuestionnaires?.() || [];
        userData.profiles = allQ.map((q: any) => onboarding.getProfile(userId, q.id)).filter(Boolean);
      } catch { userData.profiles = []; }

      // Devices
      try {
        userData.devices = db.prepare('SELECT device_id, device_name, created_at, last_active_at FROM ios_devices WHERE user_id = ?').all(userId);
      } catch { userData.devices = []; }

      userData.exportedAt = new Date().toISOString();
      userData.userId = userId;

      sendSuccess(res, userData);
    } catch (err: any) {
      logger.error({ err }, 'iOS data export failed');
      sendError(res, 'INTERNAL', err?.message || 'Data export failed', 500);
    }
  });

  /** DELETE /api/v1/settings/account — GDPR account deletion */
  router.delete('/account', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const db = require('../../services/database').getDb();

      // Delete all user data
      const tables = ['ios_devices', 'messages', 'onboarding_sessions', 'reminders', 'notes'];
      for (const table of tables) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
        } catch { /* table may not exist */ }
      }

      logger.info({ userId, platform: 'ios' }, 'Account deleted (GDPR Article 17)');
      sendSuccess(res, { deleted: true, message: 'All data has been permanently deleted.' });
    } catch (err: any) {
      logger.error({ err }, 'iOS account deletion failed');
      sendError(res, 'INTERNAL', err?.message || 'Account deletion failed', 500);
    }
  });

  return router;
}
