// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getDb } from '../services/database';
import { requireOperatorTargetUser } from './admin-target-user';
import {
  buildPortalChatDiagnostics,
  buildPortalUserChatDiagnostics,
} from './chat-diagnostics';
import { sendPortalInternalError } from './http';

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseWindowDays(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function registerPortalChatRoutes(app: Express): void {
  app.get('/api/chat/diagnostics', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const db = getDb();
      res.json(buildPortalChatDiagnostics(db, {
        windowDays: parseWindowDays(req.query.windowDays),
        limit: parseLimit(req.query.limit),
      }));
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: chat diagnostics failed');
    }
  });

  app.get('/api/users/:userId/chat-diagnostics', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveInteger(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, error: { code: 'INVALID_USER_ID', message: 'invalid userId' } });
        return;
      }

      const db = getDb();
      res.json(buildPortalUserChatDiagnostics(db, userId, {
        windowDays: parseWindowDays(req.query.windowDays),
        limit: parseLimit(req.query.limit),
      }));
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: user chat diagnostics failed');
    }
  });
}
