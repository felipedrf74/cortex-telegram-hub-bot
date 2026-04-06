// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError } from '../response-helpers';

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

      sendSuccess(res, {
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
      // Table may not exist — soft-fail with empty pipeline
      logger.debug({ err }, 'Content pipeline query failed (table may not exist)');
      sendSuccess(res, {
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

      sendSuccess(res, {
        ideas: ideas.map((row: any) => ({
          id: row.id?.toString(), title: row.title,
          score: row.score || null, createdAt: row.created_at || null,
          stage: row.stage || 'ideas',
        })),
      });
    } catch (err: any) {
      logger.debug({ err }, 'Content ideas query failed');
      sendSuccess(res, { ideas: [] });
    }
  });

  /** POST /api/v1/content/discover — trigger content discovery */
  router.post('/discover', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    try {
      const { runContentDiscovery } = require('../../services/content-discovery');
      const result = await runContentDiscovery(userId);
      sendSuccess(res, {
        discovered: result?.count || 0,
        ideas: result?.ideas || [],
        message: `Discovered ${result?.count || 0} new content ideas.`,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/discover failed');
      sendSuccess(res, { discovered: 0, ideas: [], message: 'Content discovery not available.' });
    }
  });

  /**
   * POST /api/v1/content/script — generate a script for an idea
   *
   * NOTE: This is the only AI-using route in this file. Script generation is
   * a CONTENT GENERATION operation, not a data lookup, so AI involvement is
   * intentional and explicit. All other content endpoints are token-zero.
   */
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
      sendSuccess(res, { script: result.text, domain: result.domain });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/script failed');
      sendError(res, 'INTERNAL', err?.message || 'Script generation failed', 500);
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
        sendError(res, 'NOT_FOUND', 'Idea not found', 404);
        return;
      }

      const currentIdx = stageOrder.indexOf(idea.stage);
      if (currentIdx === -1 || currentIdx >= stageOrder.length - 1) {
        sendSuccess(res, { advanced: false, message: 'Already at final stage.' });
        return;
      }

      const nextStage = stageOrder[currentIdx + 1];
      db.prepare('UPDATE content_ideas SET stage = ? WHERE id = ?').run(nextStage, id);

      sendSuccess(res, { advanced: true, newStage: nextStage });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/advance failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to advance pipeline stage', 500);
    }
  });

  return router;
}
