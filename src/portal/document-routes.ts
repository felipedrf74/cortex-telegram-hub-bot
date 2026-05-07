// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { getAllNotifications } from '../services/content-notification-store';
import { getAllReports } from '../services/report-document-store';
import {
  getAllNotificationCenterItemsForPortal,
  getNotificationProfileSummariesForPortal,
  type PortalNotificationScope,
} from '../services/notification-orchestrator';
import { requirePortalAdminToken } from '../api/secret-guards';
import { sendPortalInternalError } from './http';

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseLimit(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type PortalScopeResolution =
  | { ok: true; scope: PortalNotificationScope }
  | { ok: false; status: number; code: string; message: string };

function resolvePortalNotificationScope(req: Request): PortalScopeResolution {
  const rawUserId = req.headers?.['x-nexus-user-id'] ?? req.query.userId;
  const rawTenantId = req.headers?.['x-nexus-tenant-id'] ?? req.query.tenantId;
  const userId = parsePositiveInteger(rawUserId);
  const tenantId = parsePositiveInteger(rawTenantId);

  if (rawUserId === undefined || rawTenantId === undefined) {
    return { ok: false, status: 400, code: 'INVALID_TENANT_SCOPE', message: 'notification tenant scope required' };
  }

  if ((rawUserId !== undefined && !userId) || (rawTenantId !== undefined && !tenantId)) {
    return { ok: false, status: 400, code: 'INVALID_TENANT_SCOPE', message: 'invalid tenant scope' };
  }
  if (!userId || !tenantId) {
    return { ok: false, status: 400, code: 'INVALID_TENANT_SCOPE', message: 'notification tenant scope required' };
  }
  if (userId && tenantId && tenantId !== userId) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'invalid tenant scope' };
  }
  return { ok: true, scope: { userId, tenantId } };
}

export function registerPortalDocumentRoutes(app: Express): void {
  app.get('/api/notifications', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const scopeResult = resolvePortalNotificationScope(req);
      if (!scopeResult.ok) {
        res.status(scopeResult.status).json({
          ok: false,
          error: { code: scopeResult.code, message: scopeResult.message },
        });
        return;
      }
      const { scope } = scopeResult;
      const limit = parseLimit(req.query.limit, 100);
      const notifications = getAllNotifications(limit, scope);
      const decisionCenterItems = getAllNotificationCenterItemsForPortal(limit, scope);
      res.json({
        ok: true,
        count: notifications.length + decisionCenterItems.length,
        notifications: notifications.map((n: any) => ({
          id: n.id,
          userId: n.userId,
          type: n.type,
          title: n.title,
          body: n.body,
          status: n.status,
          pushSent: n.pushSent,
          createdAt: n.createdAt,
        })),
        decisionCenterItems: decisionCenterItems.map((item) => ({
          itemId: item.itemId,
          userId: item.userId,
          tenantId: item.tenantId,
          sourceSkill: item.sourceSkill,
          type: item.type,
          priority: item.priority,
          status: item.status,
          title: item.title,
          body: item.safeBody,
          deeplink: item.deeplink,
          actions: item.actions.map((action) => ({ id: action.id, label: action.label })),
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
        })),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/notification-preferences', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const scopeResult = resolvePortalNotificationScope(req);
      if (!scopeResult.ok) {
        res.status(scopeResult.status).json({
          ok: false,
          error: { code: scopeResult.code, message: scopeResult.message },
        });
        return;
      }
      const limit = parseLimit(req.query.limit, 100);
      const profiles = getNotificationProfileSummariesForPortal(limit, scopeResult.scope);
      res.json({
        ok: true,
        count: profiles.length,
        profiles,
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: notification preferences request failed');
    }
  });

  app.get('/api/reports', (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const reports = getAllReports(limit);
      res.json({
        ok: true,
        count: reports.length,
        reports: reports.map((r: any) => ({
          id: r.id,
          userId: r.userId,
          type: r.type,
          title: r.title,
          summary: r.summary,
          status: r.status,
          sourceJob: r.sourceJob,
          createdAt: r.createdAt,
        })),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}
