// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tenant-scoped channel CRUD for the workspace surface.
 *
 * Added 2026-04-22 as part of OI-DATA-002 on branch
 * feature/nexus-hub-portal-uiux-admin-user-console.
 *
 * ## Purpose
 *
 * Channels are "sources your skills watch" — YouTube channels, RSS
 * feeds, podcasts, newsletters, twitter handles. The per-user
 * `channels` table from earlier migrations stays untouched (it's
 * tangled with the content-creator pipeline). This service backs a
 * NEW tenant-scoped table (`tenant_channels` from migration 079)
 * that slots cleanly into the Reference Center alongside books /
 * notes / links.
 *
 * ## Isolation + authorship invariants
 *
 * Identical to tenant-resource-service:
 *   - Every SQL statement includes `WHERE tenant_id = ?`. A buggy
 *     caller passing the wrong tenant reads/writes nothing — cross-
 *     tenant leak is impossible by construction.
 *   - Mutations require `actor.role`. `tenant_viewer` is read-only.
 *     `tenant_member` can only mutate rows where `created_by ===
 *     actor.userId`. `tenant_admin` can mutate any row.
 *
 * ## Shape decisions
 *
 *   - `kind` is an enum (generic / rss / youtube / podcast /
 *     newsletter / twitter / substack). Enforced by a CHECK
 *     constraint in the schema; re-validated here for nicer errors.
 *   - `status` = active | muted | archived. Muted means "stop
 *     surfacing recommendations" without deleting the record;
 *     archived hides it from the default list entirely.
 *   - `url` + `handle` are both optional but in practice at least
 *     one should be set. The service doesn't enforce that —
 *     callers may want to stash a channel as a placeholder before
 *     attaching a URL.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import type { TenantRole } from './tenant-service';

// ── Types ──────────────────────────────────────────────────────────

export type ChannelKind =
  | 'generic'
  | 'rss'
  | 'youtube'
  | 'podcast'
  | 'newsletter'
  | 'twitter'
  | 'substack';

export type ChannelStatus = 'active' | 'muted' | 'archived';

const ALLOWED_KINDS: readonly ChannelKind[] = [
  'generic', 'rss', 'youtube', 'podcast', 'newsletter', 'twitter', 'substack',
];
const ALLOWED_STATUSES: readonly ChannelStatus[] = ['active', 'muted', 'archived'];

export interface ChannelRow {
  id: number;
  tenantId: number;
  createdBy: number;
  title: string;
  url: string | null;
  handle: string | null;
  description: string | null;
  kind: ChannelKind;
  status: ChannelStatus;
  tags: string[];
  lastFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChannelErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'BAD_REQUEST'
  | 'DB_ERROR';

export class ChannelError extends Error {
  readonly code: ChannelErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ChannelErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ChannelError';
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
    if (cleaned.length >= 20) break;
  }
  return cleaned;
}

function assertCanMutate(row: { createdBy: number }, actor: { userId: number; role: TenantRole }): void {
  if (actor.role === 'tenant_viewer') {
    throw new ChannelError('FORBIDDEN', 'tenant_viewer is read-only');
  }
  if (actor.role === 'tenant_admin') return;
  if (row.createdBy !== actor.userId) {
    throw new ChannelError(
      'FORBIDDEN',
      'Only the author or a tenant_admin can modify this channel',
      { actorUserId: actor.userId, authorUserId: row.createdBy },
    );
  }
}

interface RawChannel {
  id: number; tenant_id: number; created_by: number;
  title: string; url: string | null; handle: string | null; description: string | null;
  kind: string; status: string; tags_json: string; last_fetched_at: string | null;
  created_at: string; updated_at: string;
}

function mapChannel(r: RawChannel): ChannelRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    createdBy: r.created_by,
    title: r.title,
    url: r.url,
    handle: r.handle,
    description: r.description,
    kind: (r.kind as ChannelKind) || 'generic',
    status: (r.status as ChannelStatus) || 'active',
    tags: parseTags(r.tags_json),
    lastFetchedAt: r.last_fetched_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Shallow URL shape check. Not a full validator — we accept anything
// parseable as a URL. The server doesn't fetch URLs here, so tighter
// validation is premature.
function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  if (t.length > 2048) throw new ChannelError('BAD_REQUEST', 'url too long (max 2048 chars)');
  // Accept only http(s) to keep this out of javascript:/data:/file:/
  // territory — callers are generally OK pasting full URLs, and
  // restricting protocol has a material security benefit (the URL
  // may get rendered as a link downstream).
  if (!/^https?:\/\//i.test(t)) {
    throw new ChannelError('BAD_REQUEST', 'url must start with http:// or https://');
  }
  return t;
}

// ── CRUD ───────────────────────────────────────────────────────────

export interface CreateChannelInput {
  title: string;
  url?: string | null;
  handle?: string | null;
  description?: string | null;
  kind?: ChannelKind;
  status?: ChannelStatus;
  tags?: string[];
}

export interface UpdateChannelInput {
  title?: string;
  url?: string | null;
  handle?: string | null;
  description?: string | null;
  kind?: ChannelKind;
  status?: ChannelStatus;
  tags?: string[];
}

export interface ListChannelsOptions {
  limit?: number;
  offset?: number;
  status?: ChannelStatus | 'all';   // default: excludes 'archived'
  kind?: ChannelKind;
}

export function listChannels(tenantId: number, opts: ListChannelsOptions = {}): ChannelRow[] {
  if (!Number.isFinite(tenantId) || tenantId <= 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const clauses: string[] = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];

  // Default scope: exclude archived (non-destructive soft-delete).
  // Callers pass status='all' to include archived, or a specific
  // status to pin down.
  if (opts.status === undefined) {
    clauses.push("status != 'archived'");
  } else if (opts.status !== 'all') {
    if (!ALLOWED_STATUSES.includes(opts.status)) {
      throw new ChannelError('BAD_REQUEST', 'invalid status filter');
    }
    clauses.push('status = ?');
    params.push(opts.status);
  }

  if (opts.kind !== undefined) {
    if (!ALLOWED_KINDS.includes(opts.kind)) {
      throw new ChannelError('BAD_REQUEST', 'invalid kind filter');
    }
    clauses.push('kind = ?');
    params.push(opts.kind);
  }

  try {
    const rows = getDb()
      .prepare(
        `SELECT * FROM tenant_channels WHERE ${clauses.join(' AND ')}
         ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as RawChannel[];
    return rows.map(mapChannel);
  } catch (err) {
    logger.error({ err, tenantId }, 'tenant-channel-service: listChannels failed');
    return [];
  }
}

export function countActiveChannels(tenantId: number): number {
  if (!Number.isFinite(tenantId) || tenantId <= 0) return 0;
  try {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS c FROM tenant_channels WHERE tenant_id = ? AND status = 'active'")
      .get(tenantId) as { c: number } | undefined;
    return row?.c ?? 0;
  } catch (err) {
    logger.error({ err, tenantId }, 'tenant-channel-service: countActiveChannels failed');
    return 0;
  }
}

export function getChannel(tenantId: number, id: number): ChannelRow | null {
  if (!Number.isFinite(tenantId) || !Number.isFinite(id)) return null;
  try {
    const row = getDb()
      .prepare('SELECT * FROM tenant_channels WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as RawChannel | undefined;
    return row ? mapChannel(row) : null;
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-channel-service: getChannel failed');
    return null;
  }
}

export function createChannel(
  tenantId: number,
  actor: { userId: number; role: TenantRole },
  input: CreateChannelInput,
): ChannelRow {
  if (actor.role === 'tenant_viewer') {
    throw new ChannelError('FORBIDDEN', 'tenant_viewer is read-only');
  }
  const title = (input.title ?? '').trim();
  if (!title) throw new ChannelError('BAD_REQUEST', 'title is required');
  if (title.length > 200) throw new ChannelError('BAD_REQUEST', 'title too long (max 200 chars)');

  const kind = input.kind ?? 'generic';
  if (!ALLOWED_KINDS.includes(kind)) {
    throw new ChannelError('BAD_REQUEST', 'invalid kind', { allowed: ALLOWED_KINDS });
  }
  const status = input.status ?? 'active';
  if (!ALLOWED_STATUSES.includes(status)) {
    throw new ChannelError('BAD_REQUEST', 'invalid status', { allowed: ALLOWED_STATUSES });
  }

  const url = input.url === undefined ? null : normalizeUrl(input.url);
  const handle = input.handle?.trim()?.slice(0, 128) || null;
  const description = input.description?.trim()?.slice(0, 1024) || null;
  const tags = normalizeTags(input.tags);

  try {
    const result = getDb()
      .prepare(
        `INSERT INTO tenant_channels
           (tenant_id, created_by, title, url, handle, description, kind, status, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId, actor.userId, title, url, handle, description,
        kind, status, JSON.stringify(tags),
      );
    return getChannel(tenantId, Number(result.lastInsertRowid))!;
  } catch (err) {
    logger.error({ err, tenantId, actor }, 'tenant-channel-service: createChannel failed');
    throw new ChannelError('DB_ERROR', 'Failed to create channel');
  }
}

export function updateChannel(
  tenantId: number,
  id: number,
  actor: { userId: number; role: TenantRole },
  input: UpdateChannelInput,
): ChannelRow {
  const existing = getChannel(tenantId, id);
  if (!existing) throw new ChannelError('NOT_FOUND', 'Channel not found', { tenantId, id });
  assertCanMutate(existing, actor);

  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.title !== undefined) {
    const t = input.title.trim();
    if (!t) throw new ChannelError('BAD_REQUEST', 'title cannot be empty');
    if (t.length > 200) throw new ChannelError('BAD_REQUEST', 'title too long');
    sets.push('title = ?'); values.push(t);
  }
  if (input.url !== undefined) {
    sets.push('url = ?');
    values.push(input.url === null ? null : normalizeUrl(input.url));
  }
  if (input.handle !== undefined) {
    sets.push('handle = ?');
    values.push(input.handle?.trim()?.slice(0, 128) || null);
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    values.push(input.description?.trim()?.slice(0, 1024) || null);
  }
  if (input.kind !== undefined) {
    if (!ALLOWED_KINDS.includes(input.kind)) {
      throw new ChannelError('BAD_REQUEST', 'invalid kind', { allowed: ALLOWED_KINDS });
    }
    sets.push('kind = ?'); values.push(input.kind);
  }
  if (input.status !== undefined) {
    if (!ALLOWED_STATUSES.includes(input.status)) {
      throw new ChannelError('BAD_REQUEST', 'invalid status', { allowed: ALLOWED_STATUSES });
    }
    sets.push('status = ?'); values.push(input.status);
  }
  if (input.tags !== undefined) {
    sets.push('tags_json = ?'); values.push(JSON.stringify(normalizeTags(input.tags)));
  }

  if (sets.length === 0) throw new ChannelError('BAD_REQUEST', 'no fields to update');
  sets.push("updated_at = datetime('now')");
  values.push(id, tenantId);

  try {
    getDb()
      .prepare(`UPDATE tenant_channels SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`)
      .run(...values);
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-channel-service: updateChannel failed');
    throw new ChannelError('DB_ERROR', 'Failed to update channel');
  }
  return getChannel(tenantId, id)!;
}

export function deleteChannel(
  tenantId: number,
  id: number,
  actor: { userId: number; role: TenantRole },
): void {
  const existing = getChannel(tenantId, id);
  if (!existing) throw new ChannelError('NOT_FOUND', 'Channel not found');
  assertCanMutate(existing, actor);
  try {
    getDb()
      .prepare('DELETE FROM tenant_channels WHERE id = ? AND tenant_id = ?')
      .run(id, tenantId);
  } catch (err) {
    logger.error({ err, tenantId, id }, 'tenant-channel-service: deleteChannel failed');
    throw new ChannelError('DB_ERROR', 'Failed to delete channel');
  }
}
