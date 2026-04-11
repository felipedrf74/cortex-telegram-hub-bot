// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import {
  addTopic,
  getTopics,
  getUpcomingTopicCount,
  updateTopic,
  deleteTopic,
  CONTENT_TOPIC_STATUSES,
  type ContentTopicStatus,
} from '../../services/content-scheduler';

export function contentRoutes(): Router {
  const router = Router();

  /** GET /api/v1/content/pipeline */
  router.get('/pipeline', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthenticatedRequest;
      const db = require('../../services/database').getDb();

      // Per-user content pipeline — each user only sees their own ideas
      const ideas = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'ideas' AND user_id = ? ORDER BY score DESC",
      ).all(userId) as any[];

      const scripted = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'scripted' AND user_id = ? ORDER BY created_at DESC",
      ).all(userId) as any[];

      const filmed = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'filmed' AND user_id = ? ORDER BY created_at DESC",
      ).all(userId) as any[];

      const editing = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'editing' AND user_id = ? ORDER BY created_at DESC",
      ).all(userId) as any[];

      const published = db.prepare(
        "SELECT id, title, score, created_at FROM content_ideas WHERE stage = 'published' AND user_id = ? ORDER BY created_at DESC LIMIT 10",
      ).all(userId) as any[];

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
  router.get('/ideas', async (req, res: Response) => {
    try {
      const { userId } = req as unknown as AuthenticatedRequest;
      const db = require('../../services/database').getDb();
      const ideas = db.prepare(
        'SELECT id, title, score, created_at, stage FROM content_ideas WHERE user_id = ? ORDER BY score DESC, created_at DESC',
      ).all(userId) as any[];

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

  // ────────────────────────────────────────────────────────────────
  // Topic scheduler (TASK-14 Phase 2)
  //
  // User-created topics with optional publish dates. Distinct from
  // the AI-generated topic candidates that content-workflow.ts manages
  // — these are the user's OWN planned topics for the iOS Content
  // skill's Topic scheduler card.
  //
  // Routes are all scoped to req.userId via AuthenticatedRequest so
  // one user can never read/write another user's topics.
  // ────────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/content/topics?status=&from=&to=&scheduledOnly=&limit=
   *
   * Returns the user's topics sorted with scheduled topics first
   * (by date ASC), unscheduled last (by updated_at DESC). Cancelled
   * topics are hidden unless the caller passes ?status=cancelled.
   */
  router.get('/topics', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;

    const status = typeof req.query.status === 'string'
      ? (req.query.status as ContentTopicStatus)
      : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const scheduledOnly = req.query.scheduledOnly === 'true';
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 100, 500)
      : 100;

    if (status && !CONTENT_TOPIC_STATUSES.includes(status)) {
      sendError(res, 'BAD_REQUEST', `status must be one of: ${CONTENT_TOPIC_STATUSES.join(', ')}`);
      return;
    }

    try {
      const topics = getTopics(userId, {
        status,
        from,
        to,
        scheduledOnly,
        includeTerminal: status === 'cancelled' || status === 'published',
        limit,
      });

      // Precompute the upcoming count so the iOS landing page card
      // can render a "N this week" subtitle without a second request.
      const upcomingCount = getUpcomingTopicCount(userId, 14);

      sendSuccess(res, {
        topics,
        count: topics.length,
        upcomingCount,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS content topics list failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch topics', 500);
    }
  }));

  /**
   * POST /api/v1/content/topics
   * Body: { title, notes?, scheduledDate?, status? }
   *
   * Creates a new topic. `scheduledDate` is nullable — unscheduled
   * topics go in the "later" bucket in the iOS UI. `status` defaults
   * to 'planned' server-side.
   */
  router.post('/topics', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { title, notes, scheduledDate, status } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      sendError(res, 'BAD_REQUEST', 'title is required and must be non-empty');
      return;
    }
    if (status !== undefined && !CONTENT_TOPIC_STATUSES.includes(status)) {
      sendError(res, 'BAD_REQUEST', `status must be one of: ${CONTENT_TOPIC_STATUSES.join(', ')}`);
      return;
    }
    if (scheduledDate !== undefined && scheduledDate !== null) {
      // Light validation — expect YYYY-MM-DD.
      if (typeof scheduledDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
        sendError(res, 'BAD_REQUEST', 'scheduledDate must be YYYY-MM-DD or null');
        return;
      }
    }

    try {
      const topic = addTopic(userId, title.trim(), {
        notes: notes ?? null,
        scheduledDate: scheduledDate ?? null,
        status: status ?? 'planned',
      });
      sendSuccess(res, { topic }, { status: 201 });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS content topic create failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to create topic', 500);
    }
  }));

  /**
   * PATCH /api/v1/content/topics/:id
   * Body: { title?, notes?, scheduledDate?, status? }
   *
   * Partial update — only the fields present in the body are modified.
   * `scheduledDate` and `notes` accept explicit null to clear.
   */
  router.patch('/topics/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const topicId = parseInt(req.params.id, 10);
    const { title, notes, scheduledDate, status } = req.body;

    if (Number.isNaN(topicId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    if (title === undefined && notes === undefined && scheduledDate === undefined && status === undefined) {
      sendError(res, 'BAD_REQUEST', 'At least one of title, notes, scheduledDate, or status must be provided');
      return;
    }

    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      sendError(res, 'BAD_REQUEST', 'title must be a non-empty string when provided');
      return;
    }
    if (status !== undefined && !CONTENT_TOPIC_STATUSES.includes(status)) {
      sendError(res, 'BAD_REQUEST', `status must be one of: ${CONTENT_TOPIC_STATUSES.join(', ')}`);
      return;
    }
    if (scheduledDate !== undefined && scheduledDate !== null) {
      if (typeof scheduledDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
        sendError(res, 'BAD_REQUEST', 'scheduledDate must be YYYY-MM-DD or null');
        return;
      }
    }

    try {
      const updated = updateTopic(userId, topicId, {
        title: title !== undefined ? title.trim() : undefined,
        notes: notes !== undefined ? (notes === null ? null : String(notes)) : undefined,
        scheduled_date: scheduledDate !== undefined ? scheduledDate : undefined,
        status,
      });
      if (!updated) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { topic: updated });
    } catch (err: any) {
      logger.error({ err, userId, topicId }, 'iOS content topic update failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to update topic', 500);
    }
  }));

  /**
   * DELETE /api/v1/content/topics/:id
   * Hard-delete. UIs that want to preserve history can PATCH
   * status='cancelled' instead.
   */
  router.delete('/topics/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const topicId = parseInt(req.params.id, 10);

    if (Number.isNaN(topicId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    try {
      const deleted = deleteTopic(userId, topicId);
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      sendSuccess(res, { deleted: true, id: topicId });
    } catch (err: any) {
      logger.error({ err, userId, topicId }, 'iOS content topic delete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to delete topic', 500);
    }
  }));

  // ═══════════════════════════════════════════════════════════════════
  // BOOKS — per-user book library (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/books — user's book library (own + global) */
  router.get('/books', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const db = require('../../services/database').getDb();
    const books = db.prepare(
      'SELECT id, title, author, core_thesis, extraction_status, personal_notes FROM book_library WHERE user_id IN (0, ?) ORDER BY title ASC'
    ).all(userId);
    sendSuccess(res, { books });
  }));

  /** POST /api/v1/content/books — add a book to user's library */
  router.post('/books', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { title, author } = req.body;
    if (!title || !author) { sendError(res, 'VALIDATION', 'title and author required', 400); return; }
    const db = require('../../services/database').getDb();
    const result = db.prepare(
      'INSERT OR IGNORE INTO book_library (title, author, extraction_status, user_id) VALUES (?, ?, ?, ?)'
    ).run(title.trim(), author.trim(), 'pending', userId);
    sendSuccess(res, { id: result.lastInsertRowid, title: title.trim() }, { status: 201 });
  }));

  /** DELETE /api/v1/content/books/:id */
  router.delete('/books/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const id = parseInt(String(req.params.id), 10);
    const db = require('../../services/database').getDb();
    // Users can only delete their own books (not global ones)
    const info = db.prepare('DELETE FROM book_library WHERE id = ? AND user_id = ?').run(id, userId);
    if (info.changes === 0) { sendError(res, 'NOT_FOUND', 'Book not found or not owned by you', 404); return; }
    sendSuccess(res, { removed: true });
  }));

  // ═══════════════════════════════════════════════════════════════════
  // CHANNELS — per-user YouTube reference channels (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/channels — user's channels (own + global) */
  router.get('/channels', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { getAllChannels } = require('../../state/content-references');
    const channels = getAllChannels(userId);
    sendSuccess(res, { channels });
  }));

  /** POST /api/v1/content/channels — add a channel */
  router.post('/channels', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { url } = req.body;
    if (!url) { sendError(res, 'VALIDATION', 'url required', 400); return; }
    const { addChannel } = require('../../state/content-references');
    const channel = addChannel(url.trim(), 'ios', userId);
    sendSuccess(res, { channel: { id: channel.id, url: channel.channel_url, name: channel.channel_name } }, { status: 201 });
  }));

  /** DELETE /api/v1/content/channels/:id */
  router.delete('/channels/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const id = parseInt(String(req.params.id), 10);
    const db = require('../../services/database').getDb();
    const info = db.prepare('DELETE FROM content_ref_channels WHERE id = ? AND user_id = ?').run(id, userId);
    if (info.changes === 0) { sendError(res, 'NOT_FOUND', 'Channel not found or not owned by you', 404); return; }
    sendSuccess(res, { removed: true });
  }));

  // ═══════════════════════════════════════════════════════════════════
  // VOICE DNA — per-user brand voice (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/voice-dna — user's voice DNA entries */
  router.get('/voice-dna', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const db = require('../../services/database').getDb();
    const entries = db.prepare(
      'SELECT id, category, label, payload FROM content_knowledge WHERE user_id IN (0, ?) ORDER BY category ASC'
    ).all(userId);
    sendSuccess(res, { entries });
  }));

  /** POST /api/v1/content/voice-dna — upsert a voice DNA entry */
  router.post('/voice-dna', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { category, payload } = req.body;
    if (!category || !payload) { sendError(res, 'VALIDATION', 'category and payload required', 400); return; }
    const db = require('../../services/database').getDb();
    db.prepare(`
      INSERT INTO content_knowledge (category, label, payload, source, user_id, version)
      VALUES (?, ?, ?, 'ios', ?, 1)
      ON CONFLICT(category, user_id) DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')
    `).run(category, category, typeof payload === 'string' ? payload : JSON.stringify(payload), userId);
    sendSuccess(res, { upserted: true });
  }));

  return router;
}
