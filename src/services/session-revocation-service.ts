// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-ADM-302c (2026-04-24) — session-revocation ledger.
 *
 * Every row in `session_revocations` is a checkpoint: "any JWT for
 * this user whose `iat` (issued-at) is earlier than this row's
 * `revoked_at` is invalid." The auth-middleware consults this
 * ledger AFTER verifying the JWT signature and checking user
 * status, and returns 401 SESSION_REVOKED when the check fails.
 *
 * Public API:
 *   - revokeSessionsForUser(userId, reason, actor?)
 *   - revokeSessionsForTenant(tenantId, reason, actor?) — cascades
 *     to every tenant member via tenant_members.
 *   - getLatestRevokedAt(userId) — returns the epoch-seconds
 *     timestamp of the user's most recent revocation, or null.
 *   - isTokenRevoked(userId, iatUnixSeconds) — the hot-path check
 *     the auth-middleware uses. Cheap: one indexed SELECT, returns
 *     boolean.
 *   - listRevocationsForUser(userId, limit) — audit-UI feed.
 *
 * Time-handling note: JWT `iat` is unix seconds; SQLite's
 * datetime('now') returns ISO-text. We convert to unix seconds at
 * comparison time via `strftime('%s', revoked_at)` — avoids the
 * ISO-parse-ambiguity we've been burned by in tenant-invite-service
 * + magic-link-service. All comparisons are done SQLite-side in
 * seconds for consistency.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export interface SessionRevocationRow {
  id: number;
  userId: number;
  revokedAt: string;
  revokedAtEpochSeconds: number;
  reason: string;
  actorUserId: number | null;
  details: Record<string, unknown>;
}

export class SessionRevocationError extends Error {
  constructor(
    public readonly code: 'INVALID_USER_ID' | 'INVALID_TENANT_ID' | 'DB_ERROR',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SessionRevocationError';
  }
}

interface RawRow {
  id: number;
  user_id: number;
  revoked_at: string;
  revoked_at_seconds: number;
  reason: string;
  actor_user_id: number | null;
  details_json: string | null;
}

function mapRow(raw: RawRow): SessionRevocationRow {
  let details: Record<string, unknown> = {};
  if (raw.details_json) {
    try {
      const parsed = JSON.parse(raw.details_json);
      if (parsed && typeof parsed === 'object') details = parsed as Record<string, unknown>;
    } catch {
      // Malformed JSON — keep empty details, the row is still meaningful.
    }
  }
  return {
    id: raw.id,
    userId: raw.user_id,
    revokedAt: raw.revoked_at,
    revokedAtEpochSeconds: Number(raw.revoked_at_seconds),
    reason: raw.reason,
    actorUserId: raw.actor_user_id,
    details,
  };
}

// ─── Write path ──────────────────────────────────────────────────────

export interface RevokeSessionsOptions {
  reason: string;
  actorUserId?: number | null;
  details?: Record<string, unknown>;
}

export function revokeSessionsForUser(
  userId: number,
  opts: RevokeSessionsOptions,
): SessionRevocationRow {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new SessionRevocationError('INVALID_USER_ID', 'userId must be a positive integer', { userId });
  }
  try {
    const db = getDb();
    const res = db.prepare(
      `INSERT INTO session_revocations (user_id, reason, actor_user_id, details_json)
       VALUES (?, ?, ?, ?)`,
    ).run(
      userId,
      opts.reason || 'unspecified',
      opts.actorUserId ?? null,
      JSON.stringify(opts.details || {}),
    );
    const id = Number(res.lastInsertRowid);
    const row = db.prepare(
      `SELECT id, user_id, revoked_at, strftime('%s', revoked_at) AS revoked_at_seconds,
              reason, actor_user_id, details_json
       FROM session_revocations WHERE id = ?`,
    ).get(id) as RawRow;
    return mapRow(row);
  } catch (err) {
    logger.error({ err, userId, reason: opts.reason }, 'session-revocation-service: revokeSessionsForUser failed');
    throw new SessionRevocationError('DB_ERROR', 'Failed to record session revocation');
  }
}

/**
 * Revoke sessions for every member of `tenantId`. Returns the list
 * of rows inserted (one per member). Used by the tenant-suspend
 * cascade in OI-ADM-302c — when an admin suspends a tenant, every
 * active iOS + web session for every member is invalidated on the
 * next auth check.
 *
 * Idempotent at the member-set level: if a user is a member of
 * multiple suspended tenants, each call appends a fresh row (which
 * is correct — the latest revokedAt is what the auth check reads).
 */
export function revokeSessionsForTenant(
  tenantId: number,
  opts: RevokeSessionsOptions,
): SessionRevocationRow[] {
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    throw new SessionRevocationError('INVALID_TENANT_ID', 'tenantId must be a positive integer', { tenantId });
  }
  const db = getDb();
  const members = db.prepare(
    'SELECT user_id FROM tenant_members WHERE tenant_id = ?',
  ).all(tenantId) as Array<{ user_id: number }>;
  if (members.length === 0) return [];
  const rows: SessionRevocationRow[] = [];
  for (const m of members) {
    try {
      rows.push(revokeSessionsForUser(m.user_id, opts));
    } catch (err) {
      // Best-effort — log and continue. A single failed row shouldn't
      // abort the cascade for the other members.
      logger.warn({ err, tenantId, userId: m.user_id }, 'session-revocation-service: cascade partial failure');
    }
  }
  return rows;
}

// ─── Read path ───────────────────────────────────────────────────────

export function getLatestRevokedAt(userId: number): number | null {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  try {
    const row = getDb().prepare(
      `SELECT strftime('%s', revoked_at) AS revoked_at_seconds
       FROM session_revocations
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    ).get(userId) as { revoked_at_seconds: string | null } | undefined;
    if (!row || row.revoked_at_seconds == null) return null;
    const secs = Number(row.revoked_at_seconds);
    return Number.isFinite(secs) ? secs : null;
  } catch (err) {
    logger.error({ err, userId }, 'session-revocation-service: getLatestRevokedAt failed');
    // Fail CLOSED — if we can't read the ledger, don't assume "no
    // revocation." The caller (auth-middleware) treats null as "no
    // revocation," so we'd rather throw. But throwing from the hot
    // path is too aggressive. Compromise: log + return a very-large
    // sentinel that ensures iat < sentinel is always true → the
    // middleware fails closed to 401 instead of silently admitting.
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Check whether a JWT's iat (issued-at, unix seconds) is earlier
 * than the user's latest revocation. Returns true when the token
 * should be treated as revoked. The auth-middleware hot path.
 *
 * Edge cases:
 *   - User has no revocation rows → returns false (token is fine).
 *   - iat is missing or malformed → returns true (fail closed).
 *   - DB error → returns true (fail closed; see getLatestRevokedAt).
 */
export function isTokenRevoked(userId: number, iatUnixSeconds: unknown): boolean {
  if (typeof iatUnixSeconds !== 'number' || !Number.isFinite(iatUnixSeconds)) {
    // No iat → we can't compare — treat as revoked.
    return true;
  }
  const latest = getLatestRevokedAt(userId);
  if (latest === null) return false;
  return iatUnixSeconds < latest;
}

export function listRevocationsForUser(userId: number, limit = 20): SessionRevocationRow[] {
  if (!Number.isFinite(userId) || userId <= 0) return [];
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  try {
    const rows = getDb().prepare(
      `SELECT id, user_id, revoked_at, strftime('%s', revoked_at) AS revoked_at_seconds,
              reason, actor_user_id, details_json
       FROM session_revocations
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    ).all(userId, safeLimit) as RawRow[];
    return rows.map(mapRow);
  } catch (err) {
    logger.error({ err, userId }, 'session-revocation-service: listRevocationsForUser failed');
    return [];
  }
}
