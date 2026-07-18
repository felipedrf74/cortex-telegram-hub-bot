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
import { saveNote, searchNotes, updateNote, deleteNote, getNoteById } from '../../state/notes';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

export function notesRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'notes_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * GET /api/v1/notes?domain=general&query=foo&tag=bar&limit=100
   * Returns the most recent notes for the authenticated user, optionally
   * filtered by domain, free-text search, or tag. Limit defaults to 20
   * for chat-domain context reads and can be raised up to 100 for the
   * iOS Notes list view where the user expects to see their full history.
   */
  router.get('/', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
    const query = typeof req.query.query === 'string' ? req.query.query : undefined;
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 20, 100)
      : 20;

    if (isContentIdeaDomain(domain)) {
      sendError(
        res,
        'CONTENT_IDEA_REQUIRES_WORKSPACE',
        'Content ideas are available from the Content workspace, where status and revisions remain authoritative.',
        409,
      );
      return;
    }

    try {
      const notes = searchNotes(userId, {
        domain,
        query,
        tag,
        limit,
        excludeDomain: 'content_idea',
      });
      sendSuccess(res, {
        notes: notes.map(formatNote),
        count: notes.length,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS notes list failed');
      sendInternalError(res, 'Failed to fetch notes');
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
    if (isContentIdeaDomain(domain)) {
      sendError(
        res,
        'CONTENT_IDEA_REQUIRES_WORKSPACE',
        'Content ideas must be captured through the Content workspace so drafts, revisions, status, and recovery stay connected.',
        409,
      );
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
      sendInternalError(res, 'Failed to save note');
    }
  }));

  /**
   * PATCH /api/v1/notes/:id
   * Body: { content?, domain?, tags? }
   *
   * Partial update — only the fields present in the body are modified.
   * The state layer validates ownership (scoped to user_id) so this
   * route cannot be used to patch another user's note. Returns 404
   * if no matching note exists.
   */
  router.patch('/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const noteId = parseInt(req.params.id, 10);
    const { content, domain, tags } = req.body;

    if (Number.isNaN(noteId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    // Reject completely-empty bodies — they're almost certainly a client bug.
    if (content === undefined && domain === undefined && tags === undefined) {
      sendError(res, 'BAD_REQUEST', 'At least one of content, domain, or tags must be provided');
      return;
    }

    if (content !== undefined && (typeof content !== 'string' || !content.trim())) {
      sendError(res, 'BAD_REQUEST', 'content must be a non-empty string when provided');
      return;
    }
    if (isContentIdeaDomain(domain)) {
      sendError(
        res,
        'CONTENT_IDEA_REQUIRES_WORKSPACE',
        'A legacy note cannot be converted into a Content idea. Capture it through the Content workspace.',
        409,
      );
      return;
    }

    try {
      const existing = getNoteById(userId, noteId);
      if (existing && isContentIdeaDomain(existing.domain)) {
        sendError(
          res,
          'CONTENT_IDEA_LEGACY_READ_ONLY',
          'Legacy Content-idea notes are read-only. Duplicate or remix the idea in the Content workspace.',
          409,
        );
        return;
      }
      const updated = updateNote(userId, noteId, {
        content: content !== undefined ? content.trim() : undefined,
        domain: domain !== undefined ? String(domain) : undefined,
        // Accept explicit null to clear tags; pass-through otherwise.
        tags: tags !== undefined ? (tags === null ? null : String(tags)) : undefined,
      });

      if (!updated) {
        sendError(res, 'NOT_FOUND', 'Note not found or not owned by user', 404);
        return;
      }

      logger.info({ userId, noteId }, 'iOS note updated');
      sendSuccess(res, { note: formatNote(updated) });
    } catch (err: any) {
      logger.error({ err, userId, noteId }, 'iOS notes update failed');
      sendInternalError(res, 'Failed to update note');
    }
  }));

  /**
   * DELETE /api/v1/notes/:id
   * Hard-delete. Scoped to the caller's user_id. Returns 404 if no
   * matching row exists.
   */
  router.delete('/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const noteId = parseInt(req.params.id, 10);

    if (Number.isNaN(noteId)) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    try {
      const existing = getNoteById(userId, noteId);
      if (existing && isContentIdeaDomain(existing.domain)) {
        sendError(
          res,
          'CONTENT_IDEA_LEGACY_READ_ONLY',
          'Legacy Content-idea notes are managed through the Content workspace and cannot be deleted from Notes.',
          409,
        );
        return;
      }
      const deleted = deleteNote(userId, noteId);
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Note not found or not owned by user', 404);
        return;
      }
      logger.info({ userId, noteId }, 'iOS note deleted');
      sendSuccess(res, { deleted: true, id: noteId });
    } catch (err: any) {
      logger.error({ err, userId, noteId }, 'iOS notes delete failed');
      sendInternalError(res, 'Failed to delete note');
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

function isContentIdeaDomain(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLocaleLowerCase('en-US') === 'content_idea';
}
