// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Notes routes — token-zero CRUD on the notes table.
 *
 * Notes are quick captures that can optionally be tagged by domain
 * (general, secretary, training, finance, etc.) so the AI domains can
 * pull relevant context later. The routes themselves never invoke AI.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { saveNote, searchNotes } from '../../state/notes';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';

export function notesRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/notes?domain=general&query=foo&tag=bar
   * Returns the most recent notes for the authenticated user, optionally
   * filtered by domain, free-text search, or tag.
   */
  router.get('/', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
    const query = typeof req.query.query === 'string' ? req.query.query : undefined;
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;

    try {
      const notes = searchNotes(userId, { domain, query, tag });
      sendSuccess(res, {
        notes: notes.map(formatNote),
        count: notes.length,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS notes list failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch notes', 500);
    }
  }));

  /**
   * POST /api/v1/notes
   * Body: { content, domain?, tags? }
   * Creates a new note for the authenticated user. Domain defaults to 'general'.
   */
  router.post('/', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { content, domain, tags } = req.body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      sendError(res, 'BAD_REQUEST', 'content is required and must be a non-empty string');
      return;
    }

    try {
      const note = saveNote(userId, {
        content: content.trim(),
        domain: domain || 'general',
        tags: tags || undefined,
      });
      logger.info({ userId, noteId: note.id, domain: note.domain }, 'iOS note created');
      sendSuccess(res, { note: formatNote(note) }, { status: 201 });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS notes create failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to save note', 500);
    }
  }));

  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatNote(n: any) {
  return {
    id: n.id,
    content: n.content,
    domain: n.domain,
    tags: n.tags || null,
    createdAt: n.created_at,
  };
}
