// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getPortalAuthContext } from '../api/secret-guards';
import { getDb } from '../services/database';
import { logAudit } from '../services/audit-trail';
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

function auditPortalChatRead(req: Request, resource: string, userId: number, tenantId: number, details: Record<string, unknown>): void {
  const auth = getPortalAuthContext(req);
  logAudit({
    userId,
    tenantId,
    actorId: 0,
    action: 'access',
    resource,
    details: {
      ...details,
      actorHint: auth?.actorHint ?? null,
      matchedCredential: auth?.matchedCredential ?? null,
      usingLegacyFallback: auth?.usingLegacyFallback ?? null,
      privacyMode: 'metadata_only',
    },
    ipAddress: req.ip || req.socket?.remoteAddress || undefined,
  });
}

export function registerPortalChatRoutes(app: Express): void {
  app.get('/api/chat/diagnostics', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const db = getDb();
      auditPortalChatRead(req, 'portal.chat.diagnostics', 0, 0, {
        windowDays: parseWindowDays(req.query.windowDays) ?? null,
        limit: parseLimit(req.query.limit) ?? null,
      });
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
      const tenantId = parsePositiveInteger(req.query.tenantId) ?? userId;
      if (tenantId !== userId) {
        res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'invalid tenant scope' } });
        return;
      }

      const db = getDb();
      auditPortalChatRead(req, 'portal.chat.user_diagnostics', userId, tenantId, {
        windowDays: parseWindowDays(req.query.windowDays) ?? null,
        limit: parseLimit(req.query.limit) ?? null,
      });
      res.json(buildPortalUserChatDiagnostics(db, userId, {
        windowDays: parseWindowDays(req.query.windowDays),
        limit: parseLimit(req.query.limit),
        tenantId,
      }));
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: user chat diagnostics failed');
    }
  });
}
