// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-DATA-005c (2026-04-24) — saved filter presets for audit viewers.
 *
 * Scope and isolation:
 *   - Presets are PERSONAL. owner_user_id + scope scopes every
 *     query; the service never reads another user's presets.
 *   - `scope` distinguishes 'workspace' (User Console Activity
 *     feed presets) from 'owner' (Admin Console audit viewer
 *     presets). Kept in one table so a future cross-surface
 *     feature doesn't need a schema change.
 *
 * Filter shape:
 *   filters_json holds the same keys the URL params carry:
 *     { actor?: string, action?: string, from?: string,
 *       to?: string, q?: string }
 *   Values are ALL strings because that's what URLSearchParams
 *   produces. Extra keys are allowed (forward-compat for future
 *   filters) but normalized down to strings at save time.
 *
 * Naming:
 *   64-char cap enforced app-side. Empty names are refused.
 *   Duplicates within the same (owner, scope) are ALLOWED — users
 *   iterate on filter names ("Invite bursts v1", "v2") and
 *   enforcing uniqueness would add friction.
 *
 * What this module does NOT do:
 *   - Evaluate the filter (that's the /audit or /activity route)
 *   - Update presets in place (delete + re-save instead; simpler
 *     mental model, matches browser-bookmark semantics)
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export type AuditPresetScope = 'workspace' | 'owner';

export interface AuditPresetFilters {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  q?: string;
}

export interface AuditPreset {
  id: number;
  ownerUserId: number;
  scope: AuditPresetScope;
  name: string;
  filters: AuditPresetFilters;
  createdAt: string;
  updatedAt: string;
}

export class AuditPresetError extends Error {
  constructor(
    public readonly code: 'INVALID_NAME' | 'INVALID_SCOPE' | 'INVALID_FILTERS' | 'NOT_FOUND' | 'DB_ERROR',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AuditPresetError';
  }
}

const MAX_NAME_LEN = 64;
const MAX_FILTER_VALUE_LEN = 256;
const ALLOWED_FILTER_KEYS: readonly string[] = ['actor', 'action', 'from', 'to', 'q'];

function isScope(v: unknown): v is AuditPresetScope {
  return v === 'workspace' || v === 'owner';
}

/**
 * Normalize a caller-supplied filters blob to the canonical shape.
 * - Unknown keys: dropped (forward-compat — we don't barf on a
 *   future client that adds a new filter field we don't know
 *   about yet; it'll just round-trip missing next time).
 * - Non-string values: coerced to string.
 * - Over-long values: rejected (256-char cap matches the
 *   server-side input validation on /audit).
 * - Empty strings: kept as "" (means "this filter was set to
 *   empty on purpose") — the viewer URL builder drops empties
 *   when applying.
 */
function normalizeFilters(raw: unknown): AuditPresetFilters {
  if (!raw || typeof raw !== 'object') {
    throw new AuditPresetError('INVALID_FILTERS', 'filters must be a non-null object');
  }
  const out: AuditPresetFilters = {};
  const input = raw as Record<string, unknown>;
  for (const key of ALLOWED_FILTER_KEYS) {
    if (!(key in input)) continue;
    const v = input[key];
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (s.length > MAX_FILTER_VALUE_LEN) {
      throw new AuditPresetError(
        'INVALID_FILTERS',
        `filter "${key}" exceeds ${MAX_FILTER_VALUE_LEN}-char cap`,
      );
    }
    (out as Record<string, string>)[key] = s;
  }
  return out;
}

function mapRow(row: {
  id: number;
  owner_user_id: number;
  scope: string;
  name: string;
  filters_json: string;
  created_at: string;
  updated_at: string;
}): AuditPreset {
  let filters: AuditPresetFilters = {};
  try {
    const parsed = JSON.parse(row.filters_json);
    if (parsed && typeof parsed === 'object') filters = normalizeFilters(parsed);
  } catch {
    // Malformed JSON (shouldn't happen — we write it ourselves)
    // falls through to empty filters rather than crashing the
    // list query.
    logger.warn({ id: row.id }, 'audit-preset-service: malformed filters_json, treating as empty');
  }
  if (!isScope(row.scope)) {
    logger.warn({ id: row.id, scope: row.scope }, 'audit-preset-service: unknown scope in row');
  }
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    scope: row.scope as AuditPresetScope,
    name: row.name,
    filters,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List presets for (user, scope). Newest-first by updatedAt —
 * matches how browser bookmark managers order most-recently-used.
 */
export function listAuditPresets(ownerUserId: number, scope: AuditPresetScope): AuditPreset[] {
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) return [];
  if (!isScope(scope)) return [];
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, owner_user_id, scope, name, filters_json, created_at, updated_at
       FROM audit_filter_presets
       WHERE owner_user_id = ? AND scope = ?
       ORDER BY updated_at DESC, id DESC`,
    ).all(ownerUserId, scope) as Parameters<typeof mapRow>[0][];
    return rows.map(mapRow);
  } catch (err) {
    logger.error({ err, ownerUserId, scope }, 'audit-preset-service: list failed');
    return [];
  }
}

/**
 * Create a new preset. Returns the saved row. Validates name
 * + filters; refuses on bad input with AuditPresetError.
 */
export function createAuditPreset(
  ownerUserId: number,
  scope: AuditPresetScope,
  name: string,
  filters: unknown,
): AuditPreset {
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
    throw new AuditPresetError('INVALID_NAME', 'ownerUserId must be a positive integer');
  }
  if (!isScope(scope)) {
    throw new AuditPresetError('INVALID_SCOPE', 'scope must be "workspace" or "owner"');
  }
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName) {
    throw new AuditPresetError('INVALID_NAME', 'name is required');
  }
  if (trimmedName.length > MAX_NAME_LEN) {
    throw new AuditPresetError('INVALID_NAME', `name exceeds ${MAX_NAME_LEN}-char cap`);
  }
  const normalized = normalizeFilters(filters);
  try {
    const db = getDb();
    const info = db.prepare(
      `INSERT INTO audit_filter_presets (owner_user_id, scope, name, filters_json)
       VALUES (?, ?, ?, ?)`,
    ).run(ownerUserId, scope, trimmedName, JSON.stringify(normalized));
    const row = db.prepare(
      `SELECT id, owner_user_id, scope, name, filters_json, created_at, updated_at
       FROM audit_filter_presets WHERE id = ?`,
    ).get(Number(info.lastInsertRowid)) as Parameters<typeof mapRow>[0] | undefined;
    if (!row) {
      throw new AuditPresetError('DB_ERROR', 'Inserted row could not be read back');
    }
    return mapRow(row);
  } catch (err) {
    if (err instanceof AuditPresetError) throw err;
    logger.error({ err, ownerUserId, scope, name: trimmedName }, 'audit-preset-service: create failed');
    throw new AuditPresetError('DB_ERROR', 'Failed to save preset');
  }
}

/**
 * Delete a preset. Scoped by owner so a caller can only delete
 * their OWN presets — a user who guesses another user's preset id
 * hits NOT_FOUND, not FORBIDDEN (consistent with how we handle
 * cross-tenant resource DELETEs per OI-TEST-001's "existence
 * non-leak" invariant).
 */
export function deleteAuditPreset(ownerUserId: number, id: number): void {
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0
      || !Number.isFinite(id) || id <= 0) {
    throw new AuditPresetError('NOT_FOUND', 'No such preset');
  }
  try {
    const db = getDb();
    const result = db.prepare(
      `DELETE FROM audit_filter_presets WHERE id = ? AND owner_user_id = ?`,
    ).run(id, ownerUserId);
    if (result.changes === 0) {
      throw new AuditPresetError('NOT_FOUND', 'No such preset');
    }
  } catch (err) {
    if (err instanceof AuditPresetError) throw err;
    logger.error({ err, ownerUserId, id }, 'audit-preset-service: delete failed');
    throw new AuditPresetError('DB_ERROR', 'Failed to delete preset');
  }
}
