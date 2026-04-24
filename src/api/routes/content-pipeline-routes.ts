// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { getDb } from '../../services/database';
import { invalidateDashboardCoordinationCaches } from '../../services/coordination-cache-invalidator';
import { logger } from '../../utils/logger';

const CONTENT_PIPELINE_STAGE_ORDER = ['ideas', 'scripted', 'filmed', 'editing', 'published'] as const;

type ContentPipelineStage = typeof CONTENT_PIPELINE_STAGE_ORDER[number];

type ContentIdeaRow = {
  id: number | string;
  title: string;
  score?: number | null;
  stage?: string | null;
  created_at?: string | null;
  user_id?: number;
};

function formatIdea(row: ContentIdeaRow): {
  id: string;
  title: string;
  score: number | null;
  createdAt: string | null;
} {
  return {
    id: row.id?.toString(),
    title: row.title,
    score: row.score || null,
    createdAt: row.created_at || null,
  };
}

function emptyPipelinePayload() {
  return {
    stages: { ideas: [], scripted: [], filmed: [], editing: [], published: [] },
    stats: { totalIdeas: 0, publishedThisMonth: 0 },
  };
}

export function registerContentPipelineRoutes(router: Router): void {
  /** GET /api/v1/content/pipeline */
  router.get('/pipeline', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthenticatedRequest;
      const db = getDb();

      // Per-user content pipeline — each user only sees their own ideas.
      const ideas = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'ideas' AND user_id = ? ORDER BY score DESC",
      ).all(userId) as ContentIdeaRow[];

      const scripted = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'scripted' AND user_id = ? ORDER BY created_at DESC",
      ).all(userId) as ContentIdeaRow[];

      const filmed = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'filmed' AND user_id = ? ORDER BY created_at DESC",
      ).all(userId) as ContentIdeaRow[];

      const editing = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'editing' AND user_id = ? ORDER BY created_at DESC",
      ).all(userId) as ContentIdeaRow[];

      const published = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'published' AND user_id = ? ORDER BY created_at DESC LIMIT 10",
      ).all(userId) as ContentIdeaRow[];

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
          publishedThisMonth: published.filter((p) => {
            const d = new Date(p.created_at || '');
            const now = new Date();
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
          }).length,
        },
      });
    } catch (err: any) {
      // Table may not exist — soft-fail with empty pipeline.
      logger.debug({ err }, 'Content pipeline query failed (table may not exist)');
      sendSuccess(res, emptyPipelinePayload());
    }
  });

  /** GET /api/v1/content/ideas — list all content ideas */
  router.get('/ideas', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthenticatedRequest;
      const db = getDb();
      const ideas = db.prepare(
        'SELECT id, title, score, created_at, stage FROM content_ideas WHERE user_id = ? ORDER BY score DESC, created_at DESC',
      ).all(userId) as ContentIdeaRow[];

      sendSuccess(res, {
        ideas: ideas.map((row) => ({
          ...formatIdea(row),
          stage: row.stage || 'ideas',
        })),
        count: ideas.length,
      });
    } catch (err: any) {
      logger.debug({ err }, 'Content ideas query failed');
      sendSuccess(res, { ideas: [], count: 0 });
    }
  });

  /** POST /api/v1/content/pipeline/:id/advance — move idea to next stage */
  router.post('/pipeline/:id/advance', async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;

    try {
      const db = getDb();

      // Ownership check: only advance your own ideas.
      const idea = db.prepare('SELECT stage, user_id FROM content_ideas WHERE id = ?').get(id) as { stage: string; user_id: number } | undefined;
      if (!idea) {
        sendError(res, 'NOT_FOUND', 'Idea not found', 404);
        return;
      }
      if (idea.user_id === 0) {
        sendError(res, 'FORBIDDEN', 'System seed ideas cannot be advanced', 403);
        return;
      }
      if (idea.user_id !== userId) {
        sendError(res, 'FORBIDDEN', 'Not your idea', 403);
        return;
      }

      const currentIdx = CONTENT_PIPELINE_STAGE_ORDER.indexOf(idea.stage as ContentPipelineStage);
      if (currentIdx === -1 || currentIdx >= CONTENT_PIPELINE_STAGE_ORDER.length - 1) {
        sendSuccess(res, { advanced: false, message: 'Already at final stage.' });
        return;
      }

      const nextStage = CONTENT_PIPELINE_STAGE_ORDER[currentIdx + 1];
      const result = db.prepare('UPDATE content_ideas SET stage = ? WHERE id = ? AND user_id = ?').run(nextStage, id, userId);
      if (result.changes < 1) {
        sendError(res, 'CONFLICT', 'Idea could not be advanced; refresh and try again', 409);
        return;
      }
      invalidateDashboardCoordinationCaches(userId);

      sendSuccess(res, { advanced: true, newStage: nextStage });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/advance failed');
      sendInternalError(res, 'Failed to advance pipeline stage');
    }
  });
}
