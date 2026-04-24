// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { listUsers, setUserStatusById } from '../services/user-service';
import { logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';

const VALID_TIERS = new Set(['free', 'pro', 'max', 'owner']);

function parsePositiveUserId(value: unknown): number | null {
  const userId = Number(value);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

function nonNegNumOrUndef(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

export function registerPortalUserRoutes(app: express.Express): void {
  app.get('/api/users', (_req: Request, res: Response) => {
    try {
      res.json({ users: listUsers() });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/users/:userId/suspend', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      setUserStatusById(userId, 'suspended');
      logPortalAdminMutation(req, userId, 'user.status', { status: 'suspended' });
      res.json({ ok: true, message: 'User suspended' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to suspend user', 'Portal: suspend user failed');
    }
  });

  app.post('/api/users/:userId/activate', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      setUserStatusById(userId, 'active');
      logPortalAdminMutation(req, userId, 'user.status', { status: 'active' });
      res.json({ ok: true, message: 'User activated' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to activate user', 'Portal: activate user failed');
    }
  });

  app.put('/api/users/:userId/tier', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      const tier = String(req.body?.tier ?? '').trim().toLowerCase();
      if (!VALID_TIERS.has(tier)) {
        res.status(400).json({ ok: false, message: 'tier must be free, pro, max, or owner' });
        return;
      }

      const db = getDb();
      db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, userId);
      logPortalAdminMutation(req, userId, 'user.tier', { tier });
      res.json({ ok: true, message: `Tier set to ${tier}` });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to update user tier', 'Portal: user tier update failed');
    }
  });

  app.put('/api/users/:userId/limits', requirePortalAdminToken, express.json(), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      const db = getDb();
      const { daily_message_limit, daily_token_limit, daily_cost_limit_usd } = req.body ?? {};
      const msgLimit = nonNegNumOrUndef(daily_message_limit);
      const tokenLimit = nonNegNumOrUndef(daily_token_limit);
      const costLimit = nonNegNumOrUndef(daily_cost_limit_usd);
      if (msgLimit !== undefined) db.prepare('UPDATE users SET daily_message_limit = ? WHERE id = ?').run(msgLimit, userId);
      if (tokenLimit !== undefined) db.prepare('UPDATE users SET daily_token_limit = ? WHERE id = ?').run(tokenLimit, userId);
      if (costLimit !== undefined) db.prepare('UPDATE users SET daily_cost_limit_usd = ? WHERE id = ?').run(costLimit, userId);

      logPortalAdminMutation(req, userId, 'user.limits', {
        daily_message_limit: msgLimit,
        daily_token_limit: tokenLimit,
        daily_cost_limit_usd: costLimit,
      });
      res.json({ ok: true, message: 'Limits updated' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to update user limits', 'Portal: user limits update failed');
    }
  });
}
