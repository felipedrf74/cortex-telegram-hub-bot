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

  return router;
}
