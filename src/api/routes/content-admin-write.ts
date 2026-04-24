// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Admin write surface for the Content portal — POST/PUT/DELETE routes.
//
// The content-dashboard.ts file (949 LOC, GET-only) returns the read
// view. THIS file adds the mutation endpoints that make the portal a
// control center instead of a read-only dashboard.
//
// Auth: this router applies the shared portal scoped-token middleware.
// Read routes can use a portal read or full-access token; mutating routes
// require a portal write or full-access token.
//
// Mount: /api/v1/admin/content (sibling to /api/v1/admin/content-dashboard)

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger';
import { getDb } from '../../services/database';
import { sendInternalError as sendApiInternalError } from '../response-helpers';
import { requirePortalTokenByMethod } from '../secret-guards';

function sendSuccess(res: Response, data: Record<string, unknown> = {}): void {
  res.json({ ok: true, ...data });
}

function sendError(res: Response, code: string, message: string, status = 400): void {
  res.status(status).json({ ok: false, error: { code, message } });
}

function sendInternalError(res: Response, message: string): void {
  sendApiInternalError(res, message);
}

// ─── Route factory ──────────────────────────────────────────────────

export function contentAdminWriteRoutes(): Router {
  const router = Router();
  router.use(requirePortalTokenByMethod);

  // ═══════════════════════════════════════════════════════════════════
  // CHANNELS — YouTube reference channels
  // ═══════════════════════════════════════════════════════════════════

  /** POST /channels — add a new channel and start analysis */
  router.post('/channels', async (req: Request, res: Response) => {
    const { url, addedVia } = req.body;
    if (!url || typeof url !== 'string') {
      return sendError(res, 'BAD_REQUEST', 'url is required');
    }
    try {
      const { addAndAnalyzeChannel } = await import('../../services/channel-learner');
      const result = await addAndAnalyzeChannel(url.trim(), addedVia || 'portal');
      sendSuccess(res, {
        channel: { id: result.channel.id, name: result.channel.channel_name },
        analysis: {
          success: result.analysis.success,
          patternsFound: result.analysis.patternsFound,
          videosAnalyzed: result.analysis.videosAnalyzed,
          error: result.analysis.error,
        },
      });
    } catch (err: any) {
      logger.error({ err }, 'Portal: add channel failed');
      sendInternalError(res, 'Failed to add channel');
    }
  });

  /** DELETE /channels/:id — remove a channel */
  router.delete('/channels/:id', (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid channel id');
    try {
      const { removeChannel } = require('../../state/content-references');
      const removed = removeChannel(id);
      if (!removed) return sendError(res, 'NOT_FOUND', 'Channel not found', 404);
      sendSuccess(res, { removed: true });
    } catch (err: any) {
      logger.error({ err }, 'Portal: remove channel failed');
      sendInternalError(res, 'Failed to remove channel');
    }
  });

  /** POST /channels/:id/reanalyze — trigger re-analysis of one channel */
  router.post('/channels/:id/reanalyze', async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid channel id');
    try {
      const { analyzeChannel } = await import('../../services/channel-learner');
      const result = await analyzeChannel(id);
      sendSuccess(res, { analysis: result });
    } catch (err: any) {
      logger.error({ err }, 'Portal: reanalyze channel failed');
      sendInternalError(res, 'Failed to reanalyze');
    }
  });

  /** POST /channels/relearn — trigger full processAllChannels (on-demand) */
  router.post('/channels/relearn', async (_req: Request, res: Response) => {
    try {
      const { processAllChannelScopes } = await import('../../services/channel-learner');
      const result = await processAllChannelScopes(true); // force=true skips stale threshold
      sendSuccess(res, { result });
    } catch (err: any) {
      logger.error({ err }, 'Portal: channel relearn failed');
      sendInternalError(res, 'Failed to run channel relearn');
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // BOOKS — Book library management
  // ═══════════════════════════════════════════════════════════════════

  /** POST /books — add a book and start extraction */
  router.post('/books', async (req: Request, res: Response) => {
    const { title, author } = req.body;
    if (!title || !author) {
      return sendError(res, 'BAD_REQUEST', 'title and author are required');
    }
    try {
      const { handleAddBookFromPortal } = await import('../../commands/books');
      const result = await handleAddBookFromPortal(title.trim(), author.trim());
      if (result.ok) {
        sendSuccess(res, { message: result.message });
      } else {
        sendError(res, 'EXTRACTION_FAILED', result.message, 500);
      }
    } catch (err: any) {
      logger.error({ err }, 'Portal: add book failed');
      sendInternalError(res, 'Failed to add book');
    }
  });

  /** DELETE /books/:id — remove a book from the library */
  router.delete('/books/:id', (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid book id');
    try {
      const db = getDb();
      const info = db.prepare('DELETE FROM book_library WHERE id = ?').run(id);
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Book not found', 404);
      sendSuccess(res, { removed: true });
    } catch (err: any) {
      logger.error({ err }, 'Portal: delete book failed');
      sendInternalError(res, 'Failed to delete book');
    }
  });

  /** POST /books/:id/retry — retry a failed book extraction */
  router.post('/books/:id/retry', async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid book id');
    try {
      const db = getDb();
      const book = db.prepare('SELECT title, author FROM book_library WHERE id = ?').get(id) as
        { title: string; author: string } | undefined;
      if (!book) return sendError(res, 'NOT_FOUND', 'Book not found', 404);

      // Reset to pending then re-extract
      db.prepare("UPDATE book_library SET extraction_status = 'pending' WHERE id = ?").run(id);
      const { handleAddBookFromPortal } = await import('../../commands/books');
      const result = await handleAddBookFromPortal(book.title, book.author);
      sendSuccess(res, { retried: true, message: result.message });
    } catch (err: any) {
      logger.error({ err }, 'Portal: retry book extraction failed');
      sendInternalError(res, 'Failed to retry extraction');
    }
  });

  /** PATCH /books/:id/notes — update personal notes for a book */
  router.patch('/books/:id/notes', (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid book id');
    const { notes } = req.body;
    if (notes === undefined) return sendError(res, 'BAD_REQUEST', 'notes field is required');
    try {
      const db = getDb();
      const info = db.prepare('UPDATE book_library SET personal_notes = ? WHERE id = ?')
        .run(typeof notes === 'string' ? notes : JSON.stringify(notes), id);
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Book not found', 404);
      sendSuccess(res, { updated: true });
    } catch (err: any) {
      logger.error({ err }, 'Portal: update book notes failed');
      sendInternalError(res, 'Failed to update notes');
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // PILLARS — Reaction Radar topic configuration
  // ═══════════════════════════════════════════════════════════════════

  /** GET /pillars — list all pillars (convenience endpoint) */
  router.get('/pillars', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const rows = db.prepare('SELECT * FROM config_pillars ORDER BY name ASC').all();
      // Parse keywords JSON for each row
      const pillars = (rows as any[]).map((r) => ({
        ...r,
        keywords: JSON.parse(r.keywords || '[]'),
      }));
      sendSuccess(res, { pillars });
    } catch (err: any) {
      logger.error({ err }, 'Portal: list pillars failed');
      sendInternalError(res, 'Failed to list pillars');
    }
  });

  /** POST /pillars — add a new pillar */
  router.post('/pillars', (req: Request, res: Response) => {
    const { name, keywords, weight, language, userId } = req.body;
    if (!name || !keywords || !Array.isArray(keywords)) {
      return sendError(res, 'BAD_REQUEST', 'name (string) and keywords (string[]) are required');
    }
    try {
      const db = getDb();
      const info = db.prepare(`
        INSERT INTO config_pillars (name, keywords, weight, language, user_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        name.trim().toLowerCase(),
        JSON.stringify(keywords),
        weight ?? 1.0,
        language ?? 'pt-BR',
        userId ?? 0,
      );
      sendSuccess(res, { id: info.lastInsertRowid });
    } catch (err: any) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return sendError(res, 'DUPLICATE', `Pillar "${name}" already exists for this user`);
      }
      logger.error({ err }, 'Portal: add pillar failed');
      sendInternalError(res, 'Failed to add pillar');
    }
  });

  /** PATCH /pillars/:id — update a pillar's keywords or weight */
  router.patch('/pillars/:id', (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid pillar id');
    try {
      const db = getDb();
      const sets: string[] = ["updated_at = datetime('now')"];
      const params: unknown[] = [];

      if (req.body.name !== undefined) { sets.push('name = ?'); params.push(req.body.name.trim().toLowerCase()); }
      if (req.body.keywords !== undefined) { sets.push('keywords = ?'); params.push(JSON.stringify(req.body.keywords)); }
      if (req.body.weight !== undefined) { sets.push('weight = ?'); params.push(req.body.weight); }
      if (req.body.language !== undefined) { sets.push('language = ?'); params.push(req.body.language); }
      if (req.body.enabled !== undefined) { sets.push('enabled = ?'); params.push(req.body.enabled ? 1 : 0); }

      if (sets.length === 1) return sendError(res, 'BAD_REQUEST', 'No fields to update');

      params.push(id);
      const info = db.prepare(`UPDATE config_pillars SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Pillar not found', 404);
      sendSuccess(res, { updated: true });
    } catch (err: any) {
      logger.error({ err }, 'Portal: update pillar failed');
      sendInternalError(res, 'Failed to update pillar');
    }
  });

  /** DELETE /pillars/:id — remove a pillar */
  router.delete('/pillars/:id', (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid pillar id');
    try {
      const db = getDb();
      const info = db.prepare('DELETE FROM config_pillars WHERE id = ?').run(id);
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Pillar not found', 404);
      sendSuccess(res, { removed: true });
    } catch (err: any) {
      logger.error({ err }, 'Portal: delete pillar failed');
      sendInternalError(res, 'Failed to delete pillar');
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // VOICE DNA — Channel DNA / voice pattern management
  // ═══════════════════════════════════════════════════════════════════

  /** POST /voice-dna — manually add or overwrite a voice DNA pattern */
  router.post('/voice-dna', (req: Request, res: Response) => {
    const { category, label, payload } = req.body;
    if (!category || !payload) {
      return sendError(res, 'BAD_REQUEST', 'category and payload are required');
    }
    try {
      const { upsertKnowledge } = require('../../state/content-references');
      upsertKnowledge(category, label || category, payload, 'portal-manual');
      sendSuccess(res, { upserted: true });
    } catch (err: any) {
      logger.error({ err }, 'Portal: upsert voice DNA failed');
      sendInternalError(res, 'Failed to upsert voice DNA');
    }
  });

  /** PATCH /voice-dna/:id — edit an existing voice DNA entry's payload */
  router.patch('/voice-dna/:id', (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) return sendError(res, 'BAD_REQUEST', 'Invalid voice DNA id');
    const { payload, label } = req.body;
    if (!payload && !label) return sendError(res, 'BAD_REQUEST', 'payload or label required');
    try {
      const db = getDb();
      const sets: string[] = ["updated_at = datetime('now')"];
      const params: unknown[] = [];
      if (payload) { sets.push('payload = ?'); params.push(typeof payload === 'string' ? payload : JSON.stringify(payload)); }
      if (label) { sets.push('label = ?'); params.push(label); }
      params.push(id);
      const info = db.prepare(`UPDATE content_knowledge SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      if (info.changes === 0) return sendError(res, 'NOT_FOUND', 'Voice DNA entry not found', 404);
      sendSuccess(res, { updated: true });
    } catch (err: any) {
      logger.error({ err }, 'Portal: update voice DNA failed');
      sendInternalError(res, 'Failed to update voice DNA');
    }
  });

  /** POST /voice-dna/synthesize — trigger on-demand voice synthesis */
  router.post('/voice-dna/synthesize', async (_req: Request, res: Response) => {
    try {
      // Voice evolution agent runs a full synthesis cycle
      const { runVoiceEvolutionAgent } = await import('../../agents/voice-evolution-agent');
      const result = await runVoiceEvolutionAgent();
      sendSuccess(res, { synthesized: true, result });
    } catch (err: any) {
      logger.error({ err }, 'Portal: voice DNA synthesis failed');
      sendInternalError(res, 'Voice synthesis failed');
    }
  });

  return router;
}
