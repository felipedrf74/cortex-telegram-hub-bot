// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tenant-scoped resource CRUD for the workspace surface.
 *
 * Introduced by Phase 2C (2026-04-22). Backs /workspace/books,
 * /workspace/content, /workspace/links with a shared, isolation-safe
 * CRUD pattern over three parallel tables from migration 078.
 *
 * ## Isolation invariant
 *
 * Every read takes `(tenantId, ...)` and every write takes
 * `(tenantId, actorUserId, actorRole, ...)`. The SQL WHERE clause
 * ALWAYS includes `tenant_id = ?` so a buggy caller passing the
 * wrong tenant can at worst return/mutate no rows — never touch
 * another tenant's data.
 *
 * ## Authorship
 *
 * Within a tenant:
 *   - Any member (including viewer) can READ everything visible
 *     in the tenant.
 *   - tenant_member can CREATE and can UPDATE/DELETE rows they
 *     created (author).
 *   - tenant_admin can UPDATE/DELETE any row in the tenant.
 *   - tenant_viewer is read-only.
 *
 * Callers pre-check the role via the workspace guard; this service
 * re-checks authorship for mutations so a compromised route can't
 * silently edit another member's row.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import type { TenantRole } from './tenant-service';

// ── Types ──────────────────────────────────────────────────────────

export type BookStatus = 'want_to_read' | 'reading' | 'finished' | 'abandoned';
export type ContentKind = 'note' | 'idea' | 'draft' | 'published';

export interface BookRow {
  id: number;
  tenantId: number;
  createdBy: number;
  title: string;
  author: string | null;
  notes: string | null;
  tags: string[];
  status: BookStatus;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentNoteRow {
  id: number;
  tenantId: number;
  createdBy: number;
  title: string;
  body: string;
  kind: ContentKind;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LinkRow {
  id: number;
  tenantId: number;
  createdBy: number;
  url: string;
  title: string | null;
  description: string | null;
  tags: string[];
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ResourceErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'BAD_REQUEST'
  | 'DB_ERROR';

export class ResourceError extends Error {
  readonly code: ResourceErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ResourceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ResourceError';
    this.code = code;
    this.details = details;
  }
}

// ── Internal helpers ───────────────────────────────────────────────

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, 48);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(t);
    if (cleaned.length >= 20) break; // soft cap
  }
  return cleaned;
}

/**
 * Role-based mutation gate. Throws ResourceError.FORBIDDEN when
 * the caller can't mutate a given row.
 *
 *   tenant_admin   → always allowed
 *   tenant_member  → allowed iff row.created_by === actorUserId
 *   tenant_viewer  → never
 */
function assertCanMutate(row: { createdBy: number }, actor: { userId: number; role: TenantRole }): void {
  if (actor.role === 'tenant_viewer') {
    throw new ResourceError('FORBIDDEN', 'tenant_viewer is read-only');
  }
  if (actor.role === 'tenant_admin') return;
  // tenant_member: only own rows
  if (row.createdBy !== actor.userId) {
    throw new ResourceError(
      'FORBIDDEN',
      'Only the author or a tenant_admin can modify this row',
      { actorUserId: actor.userId, authorUserId: row.createdBy },
    );
  }
}

interface RawBook {
  id: number; tenant_id: number; created_by: number;
  title: string; author: string | null; notes: string | null;
  tags_json: string; status: string; finished_at: string | null;
  created_at: string; updated_at: string;
}

function mapBook(r: RawBook): BookRow {
  return {
    id: r.id, tenantId: r.tenant_id, createdBy: r.created_by,
    title: r.title, author: r.author, notes: r.notes,
    tags: parseTags(r.tags_json),
    status: (r.status as BookStatus) || 'reading',
    finishedAt: r.finished_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface RawNote {
  id: number; tenant_id: number; created_by: number;
  title: string; body: string; kind: string;
  tags_json: string; created_at: string; updated_at: string;
}

function mapNote(r: RawNote): ContentNoteRow {
  return {
    id: r.id, tenantId: r.tenant_id, createdBy: r.created_by,
    title: r.title, body: r.body,
    kind: (r.kind as ContentKind) || 'note',
    tags: parseTags(r.tags_json),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface RawLink {
  id: number; tenant_id: number; created_by: number;
  url: string; title: string | null; description: string | null;
  tags_json: string; is_favorite: number;
  created_at: string; updated_at: string;
}

function mapLink(r: RawLink): LinkRow {
  return {
    id: r.id, tenantId: r.tenant_id, createdBy: r.created_by,
    url: r.url, title: r.title, description: r.description,
    tags: parseTags(r.tags_json),
    isFavorite: r.is_favorite === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ── Books ──────────────────────────────────────────────────────────

export interface CreateBookInput {
  title: string;
  author?: string | null;
  notes?: string | null;
  tags?: string[];
  status?: BookStatus;
}

export function listBooks(tenantId: number, opts: { limit?: number; offset?: number } = {}): BookRow[] {
  if (!Number.isFinite(tenantId) || tenantId <= 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  try {
    const rows = getDb()
      .prepare(
        `SELECT * FROM tenant_books WHERE tenant_id = ?
         ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(tenantId, limit, offset) as RawBook[];
    return rows.map(mapBook);
  } catch (err) {
    logger.error({ err, tenantId }, 'tenant-resource-service: listBooks failed');
    return [];
  }
}

export function getBook(tenantId: number, id: number): BookRow | null {
  if (!Number.isFinite(tenantId) || !Number.isFinite(id)) return null;
  try {
    const row = getDb()
      .prepare('SELECT * FROM tenant_books WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as RawBook | undefined;
    return row ? mapBook(row) : null;
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-resource-service: getBook failed');
    return null;
  }
}

export function createBook(
  tenantId: number,
  actor: { userId: number; role: TenantRole },
  input: CreateBookInput,
): BookRow {
  if (actor.role === 'tenant_viewer') {
    throw new ResourceError('FORBIDDEN', 'tenant_viewer is read-only');
  }
  const title = (input.title ?? '').trim();
  if (!title) throw new ResourceError('BAD_REQUEST', 'title is required');
  if (title.length > 300) throw new ResourceError('BAD_REQUEST', 'title too long (max 300 chars)');
  const status: BookStatus = input.status ?? 'reading';
  if (!['want_to_read', 'reading', 'finished', 'abandoned'].includes(status)) {
    throw new ResourceError('BAD_REQUEST', 'invalid status');
  }
  const tags = normalizeTags(input.tags);
  try {
    const result = getDb()
      .prepare(
        `INSERT INTO tenant_books (tenant_id, created_by, title, author, notes, tags_json, status, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        actor.userId,
        title,
        input.author?.trim() || null,
        input.notes?.trim() || null,
        JSON.stringify(tags),
        status,
        status === 'finished' ? new Date().toISOString() : null,
      );
    return getBook(tenantId, Number(result.lastInsertRowid))!;
  } catch (err) {
    logger.error({ err, tenantId, actor }, 'tenant-resource-service: createBook failed');
    throw new ResourceError('DB_ERROR', 'Failed to create book');
  }
}

export interface UpdateBookInput {
  title?: string;
  author?: string | null;
  notes?: string | null;
  tags?: string[];
  status?: BookStatus;
}

export function updateBook(
  tenantId: number,
  id: number,
  actor: { userId: number; role: TenantRole },
  input: UpdateBookInput,
): BookRow {
  const existing = getBook(tenantId, id);
  if (!existing) throw new ResourceError('NOT_FOUND', 'Book not found', { tenantId, id });
  assertCanMutate(existing, actor);

  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (!t) throw new ResourceError('BAD_REQUEST', 'title cannot be empty');
    if (t.length > 300) throw new ResourceError('BAD_REQUEST', 'title too long');
    sets.push('title = ?'); values.push(t);
  }
  if (input.author !== undefined) {
    sets.push('author = ?'); values.push(input.author?.trim() || null);
  }
  if (input.notes !== undefined) {
    sets.push('notes = ?'); values.push(input.notes?.trim() || null);
  }
  if (input.tags !== undefined) {
    sets.push('tags_json = ?'); values.push(JSON.stringify(normalizeTags(input.tags)));
  }
  if (input.status !== undefined) {
    if (!['want_to_read', 'reading', 'finished', 'abandoned'].includes(input.status)) {
      throw new ResourceError('BAD_REQUEST', 'invalid status');
    }
    sets.push('status = ?'); values.push(input.status);
    if (input.status === 'finished' && !existing.finishedAt) {
      sets.push('finished_at = ?'); values.push(new Date().toISOString());
    } else if (input.status !== 'finished' && existing.finishedAt) {
      sets.push('finished_at = NULL');
    }
  }

  if (sets.length === 0) throw new ResourceError('BAD_REQUEST', 'no fields to update');
  sets.push("updated_at = datetime('now')");
  values.push(id, tenantId);

  try {
    getDb().prepare(`UPDATE tenant_books SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...values);
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-resource-service: updateBook failed');
    throw new ResourceError('DB_ERROR', 'Failed to update book');
  }
  return getBook(tenantId, id)!;
}

export function deleteBook(
  tenantId: number,
  id: number,
  actor: { userId: number; role: TenantRole },
): void {
  const existing = getBook(tenantId, id);
  if (!existing) throw new ResourceError('NOT_FOUND', 'Book not found');
  assertCanMutate(existing, actor);
  try {
    getDb().prepare('DELETE FROM tenant_books WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-resource-service: deleteBook failed');
    throw new ResourceError('DB_ERROR', 'Failed to delete book');
  }
}

// ── Content notes ──────────────────────────────────────────────────

export interface CreateNoteInput {
  title: string;
  body?: string;
  kind?: ContentKind;
  tags?: string[];
}

export function listContentNotes(tenantId: number, opts: { limit?: number; offset?: number; kind?: ContentKind } = {}): ContentNoteRow[] {
  if (!Number.isFinite(tenantId) || tenantId <= 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  try {
    const rows = opts.kind
      ? getDb().prepare(
          `SELECT * FROM tenant_content_notes WHERE tenant_id = ? AND kind = ?
           ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ).all(tenantId, opts.kind, limit, offset) as RawNote[]
      : getDb().prepare(
          `SELECT * FROM tenant_content_notes WHERE tenant_id = ?
           ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ).all(tenantId, limit, offset) as RawNote[];
    return rows.map(mapNote);
  } catch (err) {
    logger.error({ err, tenantId }, 'tenant-resource-service: listContentNotes failed');
    return [];
  }
}

export function getContentNote(tenantId: number, id: number): ContentNoteRow | null {
  try {
    const row = getDb()
      .prepare('SELECT * FROM tenant_content_notes WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as RawNote | undefined;
    return row ? mapNote(row) : null;
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-resource-service: getContentNote failed');
    return null;
  }
}

export function createContentNote(
  tenantId: number,
  actor: { userId: number; role: TenantRole },
  input: CreateNoteInput,
): ContentNoteRow {
  if (actor.role === 'tenant_viewer') {
    throw new ResourceError('FORBIDDEN', 'tenant_viewer is read-only');
  }
  const title = (input.title ?? '').trim();
  if (!title) throw new ResourceError('BAD_REQUEST', 'title is required');
  if (title.length > 300) throw new ResourceError('BAD_REQUEST', 'title too long');
  const kind: ContentKind = input.kind ?? 'note';
  if (!['note', 'idea', 'draft', 'published'].includes(kind)) {
    throw new ResourceError('BAD_REQUEST', 'invalid kind');
  }
  const body = (input.body ?? '').slice(0, 50_000);
  const tags = normalizeTags(input.tags);
  try {
    const result = getDb()
      .prepare(
        `INSERT INTO tenant_content_notes (tenant_id, created_by, title, body, kind, tags_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(tenantId, actor.userId, title, body, kind, JSON.stringify(tags));
    return getContentNote(tenantId, Number(result.lastInsertRowid))!;
  } catch (err) {
    logger.error({ err, tenantId, actor }, 'tenant-resource-service: createContentNote failed');
    throw new ResourceError('DB_ERROR', 'Failed to create note');
  }
}

export interface UpdateNoteInput {
  title?: string;
  body?: string;
  kind?: ContentKind;
  tags?: string[];
}

export function updateContentNote(
  tenantId: number,
  id: number,
  actor: { userId: number; role: TenantRole },
  input: UpdateNoteInput,
): ContentNoteRow {
  const existing = getContentNote(tenantId, id);
  if (!existing) throw new ResourceError('NOT_FOUND', 'Note not found');
  assertCanMutate(existing, actor);

  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (!t) throw new ResourceError('BAD_REQUEST', 'title cannot be empty');
    sets.push('title = ?'); values.push(t);
  }
  if (input.body !== undefined) {
    sets.push('body = ?'); values.push(input.body.slice(0, 50_000));
  }
  if (input.kind !== undefined) {
    if (!['note', 'idea', 'draft', 'published'].includes(input.kind)) {
      throw new ResourceError('BAD_REQUEST', 'invalid kind');
    }
    sets.push('kind = ?'); values.push(input.kind);
  }
  if (input.tags !== undefined) {
    sets.push('tags_json = ?'); values.push(JSON.stringify(normalizeTags(input.tags)));
  }

  if (sets.length === 0) throw new ResourceError('BAD_REQUEST', 'no fields to update');
  sets.push("updated_at = datetime('now')");
  values.push(id, tenantId);

  try {
    getDb().prepare(`UPDATE tenant_content_notes SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...values);
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-resource-service: updateContentNote failed');
    throw new ResourceError('DB_ERROR', 'Failed to update note');
  }
  return getContentNote(tenantId, id)!;
}

export function deleteContentNote(
  tenantId: number,
  id: number,
  actor: { userId: number; role: TenantRole },
): void {
  const existing = getContentNote(tenantId, id);
  if (!existing) throw new ResourceError('NOT_FOUND', 'Note not found');
  assertCanMutate(existing, actor);
  try {
    getDb().prepare('DELETE FROM tenant_content_notes WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-resource-service: deleteContentNote failed');
    throw new ResourceError('DB_ERROR', 'Failed to delete note');
  }
}

// ── Links ──────────────────────────────────────────────────────────

export interface CreateLinkInput {
  url: string;
  title?: string | null;
  description?: string | null;
  tags?: string[];
  isFavorite?: boolean;
}

// A very permissive URL check — we accept anything that has a
// scheme. This is a bookmark, not a protocol filter.
function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return !!u.protocol && u.protocol.length < 32;
  } catch {
    return false;
  }
}

export function listLinks(tenantId: number, opts: { limit?: number; offset?: number; favoritesOnly?: boolean } = {}): LinkRow[] {
  if (!Number.isFinite(tenantId) || tenantId <= 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  try {
    const rows = opts.favoritesOnly
      ? getDb().prepare(
          `SELECT * FROM tenant_links WHERE tenant_id = ? AND is_favorite = 1
           ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ).all(tenantId, limit, offset) as RawLink[]
      : getDb().prepare(
          `SELECT * FROM tenant_links WHERE tenant_id = ?
           ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ).all(tenantId, limit, offset) as RawLink[];
    return rows.map(mapLink);
  } catch (err) {
    logger.error({ err, tenantId }, 'tenant-resource-service: listLinks failed');
    return [];
  }
}

export function getLink(tenantId: number, id: number): LinkRow | null {
  try {
    const row = getDb()
      .prepare('SELECT * FROM tenant_links WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as RawLink | undefined;
    return row ? mapLink(row) : null;
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-resource-service: getLink failed');
    return null;
  }
}

export function createLink(
  tenantId: number,
  actor: { userId: number; role: TenantRole },
  input: CreateLinkInput,
): LinkRow {
  if (actor.role === 'tenant_viewer') {
    throw new ResourceError('FORBIDDEN', 'tenant_viewer is read-only');
  }
  const url = (input.url ?? '').trim();
  if (!url || !isValidUrl(url)) throw new ResourceError('BAD_REQUEST', 'valid url is required');
  if (url.length > 2048) throw new ResourceError('BAD_REQUEST', 'url too long');
  const tags = normalizeTags(input.tags);
  try {
    const result = getDb()
      .prepare(
        `INSERT INTO tenant_links (tenant_id, created_by, url, title, description, tags_json, is_favorite)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        actor.userId,
        url,
        input.title?.trim().slice(0, 300) || null,
        input.description?.trim().slice(0, 1000) || null,
        JSON.stringify(tags),
        input.isFavorite ? 1 : 0,
      );
    return getLink(tenantId, Number(result.lastInsertRowid))!;
  } catch (err) {
    logger.error({ err, tenantId, actor }, 'tenant-resource-service: createLink failed');
    throw new ResourceError('DB_ERROR', 'Failed to create link');
  }
}

export interface UpdateLinkInput {
  url?: string;
  title?: string | null;
  description?: string | null;
  tags?: string[];
  isFavorite?: boolean;
}

export function updateLink(
  tenantId: number,
  id: number,
  actor: { userId: number; role: TenantRole },
  input: UpdateLinkInput,
): LinkRow {
  const existing = getLink(tenantId, id);
  if (!existing) throw new ResourceError('NOT_FOUND', 'Link not found');
  assertCanMutate(existing, actor);

  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.url !== undefined) {
    const u = input.url.trim();
    if (!isValidUrl(u)) throw new ResourceError('BAD_REQUEST', 'invalid url');
    sets.push('url = ?'); values.push(u);
  }
  if (input.title !== undefined) {
    sets.push('title = ?'); values.push(input.title?.trim().slice(0, 300) || null);
  }
  if (input.description !== undefined) {
    sets.push('description = ?'); values.push(input.description?.trim().slice(0, 1000) || null);
  }
  if (input.tags !== undefined) {
    sets.push('tags_json = ?'); values.push(JSON.stringify(normalizeTags(input.tags)));
  }
  if (input.isFavorite !== undefined) {
    sets.push('is_favorite = ?'); values.push(input.isFavorite ? 1 : 0);
  }

  if (sets.length === 0) throw new ResourceError('BAD_REQUEST', 'no fields to update');
  sets.push("updated_at = datetime('now')");
  values.push(id, tenantId);

  try {
    getDb().prepare(`UPDATE tenant_links SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...values);
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-resource-service: updateLink failed');
    throw new ResourceError('DB_ERROR', 'Failed to update link');
  }
  return getLink(tenantId, id)!;
}

export function deleteLink(
  tenantId: number,
  id: number,
  actor: { userId: number; role: TenantRole },
): void {
  const existing = getLink(tenantId, id);
  if (!existing) throw new ResourceError('NOT_FOUND', 'Link not found');
  assertCanMutate(existing, actor);
  try {
    getDb().prepare('DELETE FROM tenant_links WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-resource-service: deleteLink failed');
    throw new ResourceError('DB_ERROR', 'Failed to delete link');
  }
}
