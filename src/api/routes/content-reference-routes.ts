// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { config } from '../../config';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendSuccess } from '../response-helpers';
import { getDb } from '../../services/database';
import {
  ContentKnowledgeUnavailableError,
  getVoiceDna,
} from '../../services/content-dashboard-service';
import { invalidateContentDerivedCaches } from '../../services/cache-coherence-registry';
import { addChannel, getAllChannels } from '../../state/content-references';
import {
  contentPrivateScopeParams,
  contentPrivateScopePredicate,
  contentScopeForInsert,
  ensureContentTenantScopeColumns,
} from '../../services/content-tenant-scope';
import { extractClientIp } from '../rate-limiter';

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

const CONTENT_REFERENCE_INPUT_LIMITS = Object.freeze({
  bookTitleChars: 240,
  bookAuthorChars: 240,
  channelUrlChars: 2_048,
  voiceCategoryChars: 160,
  voicePayloadChars: 20_000,
});

type InputValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function requiredBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
  allowFormattingWhitespace = false,
): InputValidationResult<string> {
  if (typeof value !== 'string') {
    return { ok: false, message: `${field} must be a string` };
  }
  const normalized = value.trim();
  if (!normalized) {
    return { ok: false, message: `${field} must be non-empty` };
  }
  if (normalized.length > maxLength) {
    return { ok: false, message: `${field} must be at most ${maxLength} characters` };
  }
  const unsupported = allowFormattingWhitespace
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
    : /[\u0000-\u001f\u007f-\u009f]/;
  if (unsupported.test(normalized)) {
    return { ok: false, message: `${field} contains unsupported control characters` };
  }
  return { ok: true, value: normalized };
}

function normalizeVoicePayload(value: unknown): InputValidationResult<string> {
  if (typeof value === 'string') {
    return requiredBoundedText(
      value,
      'payload',
      CONTENT_REFERENCE_INPUT_LIMITS.voicePayloadChars,
      true,
    );
  }
  if (
    value === null
    || value === undefined
    || typeof value === 'function'
    || typeof value === 'symbol'
    || typeof value === 'bigint'
    || (typeof value === 'number' && !Number.isFinite(value))
  ) {
    return { ok: false, message: 'payload must be a string or valid JSON value' };
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, message: 'payload must be valid JSON' };
  }
  if (!serialized) {
    return { ok: false, message: 'payload must be non-empty' };
  }
  if (serialized.length > CONTENT_REFERENCE_INPUT_LIMITS.voicePayloadChars) {
    return {
      ok: false,
      message: `payload must be at most ${CONTENT_REFERENCE_INPUT_LIMITS.voicePayloadChars} characters after JSON serialization`,
    };
  }
  return { ok: true, value: serialized };
}

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
  const referenceRouter = Router();
  const mutationLimit = config.ios?.rateLimit || 60;
  const readLimit = config.ios?.readRateLimit || Math.max(mutationLimit, 300);
  referenceRouter.use(rateLimit({
    windowMs: 60_000,
    limit: (req: Request) => req.method === 'GET' || req.method === 'HEAD'
      ? readLimit
      : mutationLimit,
    keyGenerator: (req: Request) => {
      const userId = (req as AuthenticatedRequest).userId;
      return typeof userId === 'number' && userId > 0
        ? `user:${userId}`
        : `ip:${ipKeyGenerator(extractClientIp(req))}`;
    },
    legacyHeaders: false,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      const retryAfter = Math.max(1, Math.ceil(options.windowMs / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(options.statusCode).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Slow down.',
          retryAfter,
        },
      });
    },
  }));

  // ═══════════════════════════════════════════════════════════════════
  // BOOKS — per-user book library (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/books — authenticated user's private book library */
  referenceRouter.get('/books', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_books_list')) return;

    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const rows = db.prepare(
      `SELECT id, title, author, core_thesis, extraction_status, personal_notes,
              user_id, owner_scope, tenant_id, owner_user_id, visibility_scope, scope_status
         FROM book_library
        WHERE ${contentPrivateScopePredicate()}
        ORDER BY title ASC`
    ).all(...contentPrivateScopeParams(userId, tenantId)) as ContentBookRow[];
    const books = dedupeContentBooks(rows, userId)
      .map(({ user_id, owner_scope, tenant_id, owner_user_id, visibility_scope, scope_status, ...row }: any) => row);
    sendSuccess(res, { books });
  }));

  /** POST /api/v1/content/books — add a book to user's library */
  referenceRouter.post('/books', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_books_create')) return;

    const title = requiredBoundedText(
      req.body?.title,
      'title',
      CONTENT_REFERENCE_INPUT_LIMITS.bookTitleChars,
    );
    if (!title.ok) { sendError(res, 'VALIDATION', title.message, 400); return; }
    const author = requiredBoundedText(
      req.body?.author,
      'author',
      CONTENT_REFERENCE_INPUT_LIMITS.bookAuthorChars,
    );
    if (!author.ok) { sendError(res, 'VALIDATION', author.message, 400); return; }
    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const scope = contentScopeForInsert(userId, tenantId, 'user_private', 'pending');
    const result = db.prepare(
      `INSERT OR IGNORE INTO book_library (
        title, author, extraction_status, user_id, owner_scope, tenant_id, owner_user_id,
        visibility_scope, lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      title.value,
      author.value,
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
    sendSuccess(res, { id: result.lastInsertRowid, title: title.value }, { status: 201 });
  }));

  /** DELETE /api/v1/content/books/:id */
  referenceRouter.delete('/books/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const rawId = String(req.params.id);
    const id = /^[1-9]\d*$/u.test(rawId) ? Number(rawId) : Number.NaN;
    if (!Number.isSafeInteger(id)) { sendError(res, 'VALIDATION', 'Book id must be a positive integer', 400); return; }
    if (!ensureValidContentRouteScope(res, userId, 'content_route_books_delete', { bookId: id })) return;

    const db = getDb();
    ensureContentTenantScopeColumns(db);
    // Public mutations are limited to the caller's active private row.
    const info = db.prepare(
      `DELETE FROM book_library WHERE id = ? AND ${contentPrivateScopePredicate()}`
    ).run(id, ...contentPrivateScopeParams(userId, tenantId));
    if (info.changes === 0) { sendError(res, 'NOT_FOUND', 'Book not found or not owned by you', 404); return; }
    invalidateContentDerivedCaches(userId);
    sendSuccess(res, { removed: true });
  }));

  // ═══════════════════════════════════════════════════════════════════
  // CHANNELS — per-user YouTube reference channels (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/channels — authenticated user's private channels */
  referenceRouter.get('/channels', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_channels_list')) return;

    const channels = getAllChannels(userId, tenantId);
    sendSuccess(res, { channels });
  }));

  /** POST /api/v1/content/channels — add a channel */
  referenceRouter.post('/channels', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_channels_create')) return;

    const url = requiredBoundedText(
      req.body?.url,
      'url',
      CONTENT_REFERENCE_INPUT_LIMITS.channelUrlChars,
    );
    if (!url.ok) { sendError(res, 'VALIDATION', url.message, 400); return; }
    const channel = addChannel(url.value, 'ios', userId, tenantId);
    invalidateContentDerivedCaches(userId);
    sendSuccess(res, { channel: { id: channel.id, url: channel.channel_url, name: channel.channel_name } }, { status: 201 });
  }));

  /** DELETE /api/v1/content/channels/:id */
  referenceRouter.delete('/channels/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const rawId = String(req.params.id);
    const id = /^[1-9]\d*$/u.test(rawId) ? Number(rawId) : Number.NaN;
    if (!Number.isSafeInteger(id)) { sendError(res, 'VALIDATION', 'Channel id must be a positive integer', 400); return; }
    if (!ensureValidContentRouteScope(res, userId, 'content_route_channels_delete', { channelId: id })) return;

    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const info = db.prepare(
      `DELETE FROM content_ref_channels WHERE id = ? AND ${contentPrivateScopePredicate()}`
    ).run(id, ...contentPrivateScopeParams(userId, tenantId));
    if (info.changes === 0) { sendError(res, 'NOT_FOUND', 'Channel not found or not owned by you', 404); return; }
    invalidateContentDerivedCaches(userId);
    sendSuccess(res, { removed: true });
  }));

  // ═══════════════════════════════════════════════════════════════════
  // VOICE DNA — per-user brand voice (iOS sync)
  // ═══════════════════════════════════════════════════════════════════

  /** GET /api/v1/content/voice-dna — user's voice DNA entries */
  referenceRouter.get('/voice-dna', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_voice_dna_list')) return;

    try {
      const entries = getVoiceDna(undefined, userId, tenantId, { strict: true }).map((entry) => ({
        id: entry.id,
        category: entry.category,
        label: entry.label,
        payload: entry.text,
        source_channels: JSON.stringify(entry.sources),
        version: entry.version,
        updated_at: entry.updatedAt,
      }));
      sendSuccess(res, { entries });
    } catch (error) {
      if (!(error instanceof ContentKnowledgeUnavailableError)) throw error;
      sendError(res, error.code, error.message, error.status, error.details);
    }
  }));

  /** POST /api/v1/content/voice-dna — upsert a voice DNA entry */
  referenceRouter.post('/voice-dna', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_voice_dna_upsert')) return;

    const category = requiredBoundedText(
      req.body?.category,
      'category',
      CONTENT_REFERENCE_INPUT_LIMITS.voiceCategoryChars,
    );
    if (!category.ok) { sendError(res, 'VALIDATION', category.message, 400); return; }
    const payload = normalizeVoicePayload(req.body?.payload);
    if (!payload.ok) { sendError(res, 'VALIDATION', payload.message, 400); return; }
    const db = getDb();
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
      category.value,
      payload.value,
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

  router.use(referenceRouter);
}
