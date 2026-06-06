// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getBooks, getVoiceDna, toggleSprintMode } from '../services/content-dashboard-service';
import { sendPortalInternalError } from './http';
import { clearPortalSnapshotCache } from './snapshot-cache';

function sendScopedV1Required(res: Response): void {
  res.status(410).json({
    ok: false,
    error: {
      code: 'SCOPED_V1_REQUIRED',
      message: 'Use /api/v1/admin/content with explicit userId and tenantId for Content portal mutations.',
    },
  });
}

export function registerPortalContentRoutes(app: Express): void {
  // POST /api/channels — add a reference channel
  app.post('/api/channels', requirePortalAdminToken, (_req: Request, res: Response) => {
    sendScopedV1Required(res);
  });

  // DELETE /api/channels/:id — remove a reference channel
  app.delete('/api/channels/:id', requirePortalAdminToken, (_req: Request, res: Response) => {
    sendScopedV1Required(res);
  });

  // POST /api/books — add and extract a book
  app.post('/api/books', requirePortalAdminToken, (_req: Request, res: Response) => {
    sendScopedV1Required(res);
  });

  // GET /api/content-knowledge — voice DNA (canonical service)
  app.get('/api/content-knowledge', (_req: Request, res: Response) => {
    try {
      const voiceDna = getVoiceDna();
      res.json({
        ok: true,
        knowledge: voiceDna.map((k: any) => ({
          category: k.category,
          label: k.label,
          text: k.text,
          sources: k.sources,
          updatedAt: k.updatedAt,
        })),
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // GET /api/books — book library (canonical service)
  app.get('/api/books', (_req: Request, res: Response) => {
    try {
      const books = getBooks(50);
      res.json({ ok: true, ...books });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // POST /api/override/sprint — toggle content sprint mode (canonical service)
  app.post('/api/override/sprint', requirePortalAdminToken, (_req: Request, res: Response) => {
    try {
      const result = toggleSprintMode();
      clearPortalSnapshotCache();
      res.json({ ok: true, ...result });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}
