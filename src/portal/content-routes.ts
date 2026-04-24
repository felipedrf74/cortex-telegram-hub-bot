// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { getBooks, getVoiceDna, toggleSprintMode } from '../services/content-dashboard-service';
import { addAndAnalyzeChannel, synthesizeKnowledge as reSynthesizeKnowledge } from '../services/channel-learner';
import { removeChannel as removeRefChannel } from '../state/content-references';
import { sendPortalInternalError } from './http';
import { clearPortalSnapshotCache } from './snapshot-cache';

export function registerPortalContentRoutes(app: Express): void {
  // POST /api/channels — add a reference channel
  app.post('/api/channels', requirePortalAdminToken, async (req: Request, res: Response) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.includes('youtube.com')) {
      res.status(400).json({ ok: false, message: 'Invalid YouTube URL' });
      return;
    }

    try {
      const result = await addAndAnalyzeChannel(url, 'portal');
      clearPortalSnapshotCache();
      res.json({
        ok: result.analysis.success,
        channel: {
          id: result.channel.id,
          name: result.channel.channel_name,
          url: result.channel.channel_url,
          status: result.channel.status,
        },
        analysis: {
          summary: result.analysis.summary,
          patternsFound: result.analysis.patternsFound,
          videosAnalyzed: result.analysis.videosAnalyzed,
          error: result.analysis.error,
        },
      });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // DELETE /api/channels/:id — remove a reference channel
  app.delete('/api/channels/:id', requirePortalAdminToken, async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ ok: false, message: 'Invalid channel ID' });
      return;
    }

    try {
      removeRefChannel(id);
      await reSynthesizeKnowledge();
      clearPortalSnapshotCache();
      res.json({ ok: true, message: 'Channel removed and knowledge re-synthesized' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // POST /api/books — add and extract a book
  app.post('/api/books', requirePortalAdminToken, async (req: Request, res: Response) => {
    try {
      const { title, author } = req.body || {};
      if (!title || !author) {
        res.status(400).json({ ok: false, message: 'title and author are required' });
        return;
      }
      const { handleAddBookFromPortal } = await import('../commands/books');
      const result = await handleAddBookFromPortal(title, author);
      clearPortalSnapshotCache();
      res.json(result);
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
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

