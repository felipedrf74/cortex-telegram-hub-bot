// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';

export function contentRoutes(): Router {
  const router = Router();

  /** GET /api/v1/content/pipeline */
  router.get('/pipeline', async (_req, res: Response) => {
    try {
      const db = require('../../services/database').getDb();

      // Try to load from content_ideas table
      const ideas = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'ideas' ORDER BY score DESC",
      ).all() as any[];

      const scripted = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'scripted' ORDER BY created_at DESC",
      ).all() as any[];

      const filmed = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'filmed' ORDER BY created_at DESC",
      ).all() as any[];

      const editing = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'editing' ORDER BY created_at DESC",
      ).all() as any[];

      const published = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'published' ORDER BY created_at DESC LIMIT 10",
      ).all() as any[];

      const formatIdea = (row: any) => ({
        id: row.id?.toString(), title: row.title,
        score: row.score || null, createdAt: row.created_at || null,
      });

      res.json({
        stages: {
          ideas: ideas.map(formatIdea),
          scripted: scripted.map(formatIdea),
          filmed: filmed.map(formatIdea),
          editing: editing.map(formatIdea),
          published: published.map(formatIdea),
        },
        stats: {
          totalIdeas: ideas.length + scripted.length + filmed.length + editing.length,
          publishedThisMonth: published.filter((p: any) => {
            const d = new Date(p.created_at);
            const now = new Date();
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
          }).length,
        },
      });
    } catch (err: any) {
      // Table may not exist
      logger.debug({ err }, 'Content pipeline query failed (table may not exist)');
      res.json({
        stages: { ideas: [], scripted: [], filmed: [], editing: [], published: [] },
        stats: { totalIdeas: 0, publishedThisMonth: 0 },
      });
    }
  });

  /** GET /api/v1/content/ideas — list all content ideas */
  router.get('/ideas', async (_req, res: Response) => {
    try {
      const db = require('../../services/database').getDb();
      const ideas = db.prepare(
        'SELECT id, title, score, created_at, stage FROM content_ideas ORDER BY score DESC, created_at DESC',
      ).all() as any[];

      res.json({
        ideas: ideas.map((row: any) => ({
          id: row.id?.toString(), title: row.title,
          score: row.score || null, createdAt: row.created_at || null,
          stage: row.stage || 'ideas',
        })),
      });
    } catch (err: any) {
      logger.debug({ err }, 'Content ideas query failed');
      res.json({ ideas: [] });
    }
  });

  /** POST /api/v1/content/discover — trigger content discovery */
  router.post('/discover', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    try {
      const { runContentDiscovery } = require('../../services/content-discovery');
      const result = await runContentDiscovery(userId);
      res.json({
        discovered: result?.count || 0,
        ideas: result?.ideas || [],
        message: `Discovered ${result?.count || 0} new content ideas.`,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/discover failed');
      res.json({ discovered: 0, ideas: [], message: 'Content discovery not available.' });
    }
  });

  /** POST /api/v1/content/script — generate a script for an idea */
  router.post('/script', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { ideaId, topic } = req.body;

    try {
      // Route through the content domain handler
      const { handleContent } = require('../../domains/content-creator');
      const prompt = ideaId
        ? `/script ${ideaId}`
        : `/script ${topic || 'generate a script'}`;
      const result = await handleContent(prompt, userId);
      res.json({ script: result.text, domain: result.domain });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/script failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  /** POST /api/v1/content/pipeline/:id/advance — move idea to next stage */
  router.post('/pipeline/:id/advance', async (req, res: Response) => {
    const { id } = req.params;

    try {
      const db = require('../../services/database').getDb();
      const stageOrder = ['ideas', 'scripted', 'filmed', 'editing', 'published'];

      const idea = db.prepare('SELECT stage FROM content_ideas WHERE id = ?').get(id) as { stage: string } | undefined;
      if (!idea) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Idea not found' } });
        return;
      }

      const currentIdx = stageOrder.indexOf(idea.stage);
      if (currentIdx === -1 || currentIdx >= stageOrder.length - 1) {
        res.json({ advanced: false, message: 'Already at final stage.' });
        return;
      }

      const nextStage = stageOrder[currentIdx + 1];
      db.prepare('UPDATE content_ideas SET stage = ? WHERE id = ?').run(nextStage, id);

      res.json({ advanced: true, newStage: nextStage });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/advance failed');
      res.status(500).json({ error: { code: 'INTERNAL', message: err.message } });
    }
  });

  return router;
}
