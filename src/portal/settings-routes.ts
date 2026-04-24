// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { DatabaseConfigProvider, getConfigProvider } from '../services/config-provider';
import { logger } from '../utils/logger';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';

export function registerPortalSettingsRoutes(app: express.Express): void {
  // GET /api/settings — current settings for portal display
  app.get('/api/settings', (_req: Request, res: Response) => {
    try {
      const provider = getConfigProvider();
      if (provider instanceof DatabaseConfigProvider) {
        res.json({ settings: provider.getAllSettings() });
      } else {
        res.json({ settings: [], message: 'DatabaseConfigProvider not active' });
      }
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // PUT /api/settings — update a setting
  app.put('/api/settings', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const { id, value } = req.body;
      if (!id || value === undefined) {
        res.status(400).json({ error: 'id and value required' });
        return;
      }

      const provider = getConfigProvider();
      if (!(provider instanceof DatabaseConfigProvider)) {
        res.status(503).json({ error: 'DatabaseConfigProvider not active' });
        return;
      }

      provider.setSetting(id, value);
      logPortalAdminMutation(req, 0, 'settings.update', { id, value });
      res.json({ ok: true, id, value, message: 'Setting updated. Active immediately.' });
    } catch (err) {
      logger.warn({ err, settingId: req.body?.id }, 'Portal: settings update rejected');
      res.status(400).json({ error: 'Invalid setting update' });
    }
  });

  // DELETE /api/settings — reset a setting to default
  app.delete('/api/settings', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const { id } = req.body;
      if (!id) {
        res.status(400).json({ error: 'id required' });
        return;
      }

      const provider = getConfigProvider();
      if (!(provider instanceof DatabaseConfigProvider)) {
        res.status(503).json({ error: 'DatabaseConfigProvider not active' });
        return;
      }

      provider.clearSetting(id);
      logPortalAdminMutation(req, 0, 'settings.delete', { id });
      res.json({ ok: true, settings: provider.getAllSettings() });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to reset setting', 'Portal: settings delete failed');
    }
  });
}
