// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendSuccess } from '../response-helpers';
import { getDb } from '../../services/database';
import { getVoiceDna } from '../../services/content-dashboard-service';
import { invalidateContentDerivedCaches } from '../../services/cache-coherence-registry';
import { addChannel, getAllChannels } from '../../state/content-references';
import {
  contentScopeForInsert,
  contentScopeOrderExpr,
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
} from '../../services/content-tenant-scope';

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

type ContentBookRow = {
  title: string;
  author: string;
  user_id?: number | null;
  owner_scope?: string | null;
  [key: string]: unknown;
};

export function dedupeContentBooks<T extends ContentBookRow>(rows: T[], userId: number): T[] {
  const deduped = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.title}::${row.author}`;
    const existing = deduped.get(key);
    const rowIsUser = row.user_id === userId && (row.owner_scope === 'user' || (row.owner_scope == null && row.user_id !== 0));
    const existingIsUser = existing && existing.user_id === userId
      && (existing.owner_scope === 'user' || (existing.owner_scope == null && existing.user_id !== 0));
    if (!existing || (rowIsUser && !existingIsUser)) {
      deduped.set(key, row);
    }
  }
  return Array.from(deduped.values());
}

export function registerContentReferenceRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  // ═══════════════════════════════════════════════════════════════════
  // BOOKS — per-user book library (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/books — user's book library (own + global) */
  router.get('/books', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_books_list')) return;

    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const rows = db.prepare(
      `SELECT id, title, author, core_thesis, extraction_status, personal_notes,
              user_id, owner_scope, tenant_id, owner_user_id, visibility_scope, scope_status
         FROM book_library
        WHERE ${contentScopePredicate()}
        ORDER BY ${contentScopeOrderExpr(undefined, userId)},
                 title ASC`
    ).all(...contentScopeParams(userId, tenantId)) as ContentBookRow[];
    const books = dedupeContentBooks(rows, userId)
      .map(({ user_id, owner_scope, tenant_id, owner_user_id, visibility_scope, scope_status, ...row }: any) => row);
    sendSuccess(res, { books });
  }));

  /** POST /api/v1/content/books — add a book to user's library */
  router.post('/books', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_books_create')) return;

    const { title, author } = req.body;
    if (!title || !author) { sendError(res, 'VALIDATION', 'title and author required', 400); return; }
    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const scope = contentScopeForInsert(userId, tenantId, 'user_private', 'pending');
    const result = db.prepare(
      `INSERT OR IGNORE INTO book_library (
        title, author, extraction_status, user_id, owner_scope, tenant_id, owner_user_id,
        visibility_scope, lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      title.trim(),
      author.trim(),
      'pending',
      userId,
      'user',
      scope.tenantId,
      scope.ownerUserId,
      scope.visibilityScope,
      scope.lifecycleState,
      scope.scopeStatus,
      scope.createdBy,
      scope.updatedBy,
      scope.auditMetadataJson,
    );
    invalidateContentDerivedCaches(userId);
    sendSuccess(res, { id: result.lastInsertRowid, title: title.trim() }, { status: 201 });
  }));

  /** DELETE /api/v1/content/books/:id */
  router.delete('/books/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const id = parseInt(String(req.params.id), 10);
    if (!ensureValidContentRouteScope(res, userId, 'content_route_books_delete', { bookId: id })) return;

    const db = getDb();
    ensureContentTenantScopeColumns(db);
    // Users can only delete their own books (not global ones)
    const info = db.prepare(
      `DELETE FROM book_library WHERE id = ? AND ${contentScopePredicate()}`
    ).run(id, ...contentScopeParams(userId, tenantId));
    if (info.changes === 0) { sendError(res, 'NOT_FOUND', 'Book not found or not owned by you', 404); return; }
    invalidateContentDerivedCaches(userId);
    sendSuccess(res, { removed: true });
  }));

  // ═══════════════════════════════════════════════════════════════════
  // CHANNELS — per-user YouTube reference channels (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/channels — user's channels (own + global) */
  router.get('/channels', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_channels_list')) return;

    const channels = getAllChannels(userId, tenantId);
    sendSuccess(res, { channels });
  }));

  /** POST /api/v1/content/channels — add a channel */
  router.post('/channels', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_channels_create')) return;

    const { url } = req.body;
    if (!url) { sendError(res, 'VALIDATION', 'url required', 400); return; }
    const channel = addChannel(url.trim(), 'ios', userId, tenantId);
    invalidateContentDerivedCaches(userId);
    sendSuccess(res, { channel: { id: channel.id, url: channel.channel_url, name: channel.channel_name } }, { status: 201 });
  }));

  /** DELETE /api/v1/content/channels/:id */
  router.delete('/channels/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const id = parseInt(String(req.params.id), 10);
    if (!ensureValidContentRouteScope(res, userId, 'content_route_channels_delete', { channelId: id })) return;

    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const info = db.prepare(
      `DELETE FROM content_ref_channels WHERE id = ? AND ${contentScopePredicate()}`
    ).run(id, ...contentScopeParams(userId, tenantId));
    if (info.changes === 0) { sendError(res, 'NOT_FOUND', 'Channel not found or not owned by you', 404); return; }
    invalidateContentDerivedCaches(userId);
    sendSuccess(res, { removed: true });
  }));

  // ═══════════════════════════════════════════════════════════════════
  // VOICE DNA — per-user brand voice (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/voice-dna — user's voice DNA entries */
  router.get('/voice-dna', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_voice_dna_list')) return;

    const entries = getVoiceDna(undefined, userId, tenantId).map((entry) => ({
      id: entry.id,
      category: entry.category,
      label: entry.label,
      payload: entry.text,
      source_channels: JSON.stringify(entry.sources),
      version: entry.version,
      updated_at: entry.updatedAt,
    }));
    sendSuccess(res, { entries });
  }));

  /** POST /api/v1/content/voice-dna — upsert a voice DNA entry */
  router.post('/voice-dna', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_voice_dna_upsert')) return;

    const { category, payload } = req.body;
    if (!category || !payload) { sendError(res, 'VALIDATION', 'category and payload required', 400); return; }
    const db = getDb();
    const normalizedPayload = typeof payload === 'string' ? payload.trim() : JSON.stringify(payload);
    if (!normalizedPayload) {
      sendError(res, 'VALIDATION', 'payload must be non-empty', 400);
      return;
    }
    ensureContentTenantScopeColumns(db);
    const scope = contentScopeForInsert(userId, tenantId);
    db.prepare(`
      INSERT INTO content_knowledge (
        category, synthesized_text, source_channels, user_id, owner_scope, version,
        tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
        created_by, updated_by, audit_metadata_json
      )
      VALUES (?, ?, '[]', ?, 'user', 1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, category) DO UPDATE SET
        synthesized_text = excluded.synthesized_text,
        owner_scope = excluded.owner_scope,
        tenant_id = excluded.tenant_id,
        owner_user_id = excluded.owner_user_id,
        visibility_scope = excluded.visibility_scope,
        lifecycle_state = excluded.lifecycle_state,
        scope_status = excluded.scope_status,
        updated_by = excluded.updated_by,
        updated_at = datetime('now'),
        version = content_knowledge.version + 1
    `).run(
      category,
      normalizedPayload,
      userId,
      scope.tenantId,
      scope.ownerUserId,
      scope.visibilityScope,
      scope.lifecycleState,
      scope.scopeStatus,
      scope.createdBy,
      scope.updatedBy,
      scope.auditMetadataJson,
    );
    invalidateContentDerivedCaches(userId);
    sendSuccess(res, { upserted: true });
  }));
}
