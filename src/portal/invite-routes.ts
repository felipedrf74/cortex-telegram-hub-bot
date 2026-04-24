// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { createInviteCode, deleteInviteCode, listInviteCodes } from '../services/user-service';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';

export function registerPortalInviteRoutes(app: express.Express): void {
  app.get('/api/invite-codes', (_req: Request, res: Response) => {
    try {
      res.json({ codes: listInviteCodes() });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/invite-codes', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const code = createInviteCode(0, req.body.maxUses ?? 1, req.body.expiresInDays);

      if (req.body.skillPreset) {
        try {
          const db = getDb();
          db.prepare('UPDATE invite_codes SET skill_preset = ? WHERE code = ?')
            .run(JSON.stringify(req.body.skillPreset), code);
        } catch {
          // Older SQLite deployments may not have skill_preset yet.
        }
      }

      logPortalAdminMutation(req, 0, 'invite_code.create', {
        code,
        maxUses: req.body.maxUses ?? 1,
        expiresInDays: req.body.expiresInDays ?? null,
        skillPreset: req.body.skillPreset ?? undefined,
      });
      res.json({ ok: true, code });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to create invite code', 'Portal: create invite code failed');
    }
  });

  app.delete('/api/invite-codes/:code', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const code = String(req.params.code ?? '');
      deleteInviteCode(code);
      logPortalAdminMutation(req, 0, 'invite_code.delete', { code });
      res.json({ ok: true });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to delete invite code', 'Portal: delete invite code failed');
    }
  });
}
