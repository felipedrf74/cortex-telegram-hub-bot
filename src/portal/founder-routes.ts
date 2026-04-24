// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { addFounder, listFounders, removeFounder } from '../services/founders';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';
import { isLikelyEmail } from './validation';

type FounderPlan = 'pro' | 'max';

function parseFounderPlan(value: unknown): FounderPlan | null {
  return value === 'pro' || value === 'max' ? value : null;
}

export function registerPortalFounderRoutes(app: express.Express): void {
  app.get('/api/founders', requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      res.json({ founders: listFounders() });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to load founders', 'Portal: list founders failed');
    }
  });

  app.post('/api/founders', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const { email, plan, note } = req.body ?? {};
      if (typeof email !== 'string' || !isLikelyEmail(email)) {
        res.status(400).json({ ok: false, message: 'valid email required' });
        return;
      }

      const founderPlan = parseFounderPlan(plan);
      if (!founderPlan) {
        res.status(400).json({ ok: false, message: 'plan must be pro or max' });
        return;
      }

      const normalizedEmail = email.trim().toLowerCase();
      addFounder(normalizedEmail, founderPlan, note);
      logPortalAdminMutation(req, 0, 'founder.add', {
        email: normalizedEmail,
        plan: founderPlan,
        note: note ?? null,
      });
      res.json({ ok: true, founders: listFounders() });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to save founder', 'Portal: add founder failed');
    }
  });

  app.delete('/api/founders/:email', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const emailParam = decodeURIComponent(String(req.params.email)).trim().toLowerCase();
      if (!isLikelyEmail(emailParam)) {
        res.status(400).json({ ok: false, message: 'valid email required' });
        return;
      }

      const removed = removeFounder(emailParam);
      logPortalAdminMutation(req, 0, 'founder.remove', { email: emailParam, removed });
      res.json({ ok: removed });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to remove founder', 'Portal: remove founder failed');
    }
  });
}
