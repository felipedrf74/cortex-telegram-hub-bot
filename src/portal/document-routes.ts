// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { getAllNotifications } from '../services/content-notification-store';
import { getAllReports } from '../services/report-document-store';
import { sendPortalInternalError } from './http';

export function registerPortalDocumentRoutes(app: Express): void {
  app.get('/api/notifications', (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit || '100'), 10);
      const notifications = getAllNotifications(limit);
      res.json({
        ok: true,
        count: notifications.length,
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
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
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
