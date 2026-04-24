// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-NAV-203b — magic-link token issuance + consumption
 * (2026-04-24).
 *
 * Design:
 *   - Raw tokens are 32-byte random (base64url-encoded, ~43 chars).
 *     That's 256 bits of entropy — well above the 128-bit floor for
 *     resistance to online guessing over any realistic horizon.
 *   - We store SHA-256(token) in `magic_link_tokens.token_hash`.
 *     The raw token lives only in the email (and, in dev, in logs).
 *     A DB snapshot leak does NOT let an attacker forge valid
 *     sessions — they'd need to preimage the hash.
 *   - Consumption is single-use: `consumed_at IS NULL` is part of
 *     the matching WHERE clause, so a second POST with the same
 *     token finds no row and returns `valid: false`.
 *   - Consumption also checks `datetime('now') < expires_at` inside
 *     the query, avoiding the SQLite-text-vs-ISO-8601 parsing trap
 *     we hit previously (see tenant-invite-service.ts for the full
 *     writeup of why we wrap both sides in `datetime()`).
 *
 * Public API:
 *   - `issueMagicLinkToken(opts)`   → `{ rawToken, row }`
 *   - `consumeMagicLinkToken(raw)`  → `{ valid, row? }` (or { valid:false, reason }).
 *   - `purgeExpiredMagicLinkTokens()` → count of rows deleted.
 *     (Called by the scheduler; could also be invoked on boot.)
 *   - Types: `MagicLinkIntent`, `MagicLinkRow`, etc.
 *
 * Caller responsibilities:
 *   - The HANDLER that calls `issueMagicLinkToken` is also
 *     responsible for invoking the mailer (sendMagicLink from
 *     ./mailer.ts). This service deliberately doesn't couple to
 *     the mailer so tests can unit-test issuance independently.
 *   - The handler that calls `consumeMagicLinkToken` is responsible
 *     for acting on the intent (creating a user, accepting an
 *     invite, issuing a session). This service just attests
 *     "this token is valid, here's the metadata".
 */

import crypto from 'crypto';
import { getDb } from './database';
import { logger } from '../utils/logger';

export type MagicLinkIntent = 'invite_signup' | 'passwordless_login' | 'email_verify';

export interface MagicLinkRow {
  id: number;
  email: string;
  intent: MagicLinkIntent;
  tenantId: number | null;
  inviteId: number | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedBy: number | null;
  metadata: Record<string, unknown>;
}

export class MagicLinkError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_EMAIL'
      | 'INVALID_INTENT'
      | 'INVALID_TTL'
      | 'DB_ERROR',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MagicLinkError';
  }
}

// ─── Constants ───────────────────────────────────────────────────────

/** Default TTL when caller doesn't specify — 1 hour is the magic-link norm. */
export const DEFAULT_TTL_SECONDS = 60 * 60;
/** Ceiling on TTL — resist "please give me a 1-year token" abuse. */
export const MAX_TTL_SECONDS = 24 * 60 * 60;
/** Floor — a 30-second token would be unusable. */
export const MIN_TTL_SECONDS = 60;

const ALLOWED_INTENTS: readonly MagicLinkIntent[] = [
  'invite_signup',
  'passwordless_login',
  'email_verify',
];

// ─── Crypto helpers (pure) ───────────────────────────────────────────

/**
 * Generate a url-safe 256-bit random token. Base64url form (no
 * padding, no `+`/`/`) so it drops straight into a query string.
 */
export function generateRawToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** SHA-256 hash of the raw token. Hex-encoded for SQL equality. */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ─── Row mapping ─────────────────────────────────────────────────────

interface RawRow {
  id: number;
  token_hash: string;
  email: string;
  intent: string;
  tenant_id: number | null;
  invite_id: number | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by: number | null;
  metadata_json: string | null;
}

function mapRow(raw: RawRow): MagicLinkRow {
  let metadata: Record<string, unknown> = {};
  if (raw.metadata_json) {
    try {
      const parsed = JSON.parse(raw.metadata_json);
      if (parsed && typeof parsed === 'object') metadata = parsed as Record<string, unknown>;
    } catch {
      // Unparseable JSON — treat as empty object. Shouldn't happen
      // since we JSON.stringify on the way in.
    }
  }
  return {
    id: raw.id,
    email: raw.email,
    intent: raw.intent as MagicLinkIntent,
    tenantId: raw.tenant_id,
    inviteId: raw.invite_id,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    consumedAt: raw.consumed_at,
    consumedBy: raw.consumed_by,
    metadata,
  };
}

// ─── Issue ───────────────────────────────────────────────────────────

export interface IssueMagicLinkOptions {
  email: string;
  intent: MagicLinkIntent;
  tenantId?: number | null;
  inviteId?: number | null;
  /** TTL in seconds; clamped to [MIN_TTL_SECONDS, MAX_TTL_SECONDS]. */
  ttlSeconds?: number;
  /** Small free-form metadata; JSON-serialisable. Stringified on write. */
  metadata?: Record<string, unknown>;
}

export interface IssueMagicLinkResult {
  /** The RAW token — include in the URL sent to the user. Never persisted. */
  rawToken: string;
  /** The persisted row (already mapped). */
  row: MagicLinkRow;
}

export function issueMagicLinkToken(opts: IssueMagicLinkOptions): IssueMagicLinkResult {
  const email = (opts.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new MagicLinkError('INVALID_EMAIL', 'email must be a non-empty address', { email: opts.email });
  }
  if (!ALLOWED_INTENTS.includes(opts.intent)) {
    throw new MagicLinkError('INVALID_INTENT', `intent must be one of ${ALLOWED_INTENTS.join(' | ')}`, { intent: opts.intent });
  }
  const ttlRaw = typeof opts.ttlSeconds === 'number' ? opts.ttlSeconds : DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttlRaw) || ttlRaw < MIN_TTL_SECONDS || ttlRaw > MAX_TTL_SECONDS) {
    throw new MagicLinkError(
      'INVALID_TTL',
      `ttlSeconds must be a finite integer in [${MIN_TTL_SECONDS}, ${MAX_TTL_SECONDS}]`,
      { ttlSeconds: opts.ttlSeconds },
    );
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const metadataJson = JSON.stringify(opts.metadata || {});

  try {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO magic_link_tokens
         (token_hash, email, intent, tenant_id, invite_id,
          created_at, expires_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now', ?), ?)`,
    );
    stmt.run(
      tokenHash,
      email,
      opts.intent,
      opts.tenantId ?? null,
      opts.inviteId ?? null,
      `+${Math.floor(ttlRaw)} seconds`,
      metadataJson,
    );
    // Fetch the row we just wrote (hash-unique → safe).
    const row = db
      .prepare('SELECT * FROM magic_link_tokens WHERE token_hash = ?')
      .get(tokenHash) as RawRow;
    return { rawToken, row: mapRow(row) };
  } catch (err) {
    logger.error({ err, email, intent: opts.intent }, 'magic-link-service: issueMagicLinkToken failed');
    throw new MagicLinkError('DB_ERROR', 'Failed to issue magic link token');
  }
}

// ─── Consume ─────────────────────────────────────────────────────────

export interface ConsumeMagicLinkResult {
  valid: boolean;
  row?: MagicLinkRow;
  reason?: 'not_found' | 'expired' | 'already_consumed';
}

/**
 * Verify a raw token and mark it consumed. Atomic: we UPDATE with
 * `WHERE token_hash = ? AND consumed_at IS NULL AND datetime('now')
 * < datetime(expires_at)`, so two concurrent consumes can't both
 * succeed. The caller is expected to pass `consumedByUserId` — the
 * user id that used the link (may be a newly-created user for the
 * invite-signup intent).
 *
 * If the token was valid but already used, returns `{ valid: false,
 * reason: 'already_consumed' }` along with the row for audit; if
 * the token was never valid (unknown hash), returns `{ valid: false,
 * reason: 'not_found' }` with no row.
 */
export function consumeMagicLinkToken(
  rawToken: string,
  consumedByUserId: number | null,
): ConsumeMagicLinkResult {
  if (typeof rawToken !== 'string' || rawToken.length < 16) {
    return { valid: false, reason: 'not_found' };
  }
  const tokenHash = hashToken(rawToken);
  try {
    const db = getDb();
    // Snapshot the row first so we can report what went wrong.
    const existing = db
      .prepare('SELECT * FROM magic_link_tokens WHERE token_hash = ?')
      .get(tokenHash) as RawRow | undefined;
    if (!existing) return { valid: false, reason: 'not_found' };
    if (existing.consumed_at !== null) {
      return { valid: false, reason: 'already_consumed', row: mapRow(existing) };
    }
    // SQLite-side expiry comparison — same rationale as
    // tenant-invite-service.ts's acceptInvite.
    const nowCheck = db
      .prepare('SELECT CASE WHEN datetime(?) < datetime(?) THEN 1 ELSE 0 END AS expired')
      .get(existing.expires_at, new Date().toISOString()) as { expired: number };
    if (nowCheck.expired === 1) {
      return { valid: false, reason: 'expired', row: mapRow(existing) };
    }
    // Atomic consume — one of { 0, 1 } rows updated.
    const res = db.prepare(
      `UPDATE magic_link_tokens
         SET consumed_at = datetime('now'), consumed_by = ?
       WHERE token_hash = ?
         AND consumed_at IS NULL
         AND datetime('now') < datetime(expires_at)`,
    ).run(consumedByUserId, tokenHash);
    if (res.changes !== 1) {
      // Race — someone else consumed between our snapshot and UPDATE.
      const after = db
        .prepare('SELECT * FROM magic_link_tokens WHERE token_hash = ?')
        .get(tokenHash) as RawRow | undefined;
      if (after && after.consumed_at !== null) {
        return { valid: false, reason: 'already_consumed', row: mapRow(after) };
      }
      return { valid: false, reason: 'expired' };
    }
    // Refetch for the updated timestamps.
    const refreshed = db
      .prepare('SELECT * FROM magic_link_tokens WHERE token_hash = ?')
      .get(tokenHash) as RawRow;
    return { valid: true, row: mapRow(refreshed) };
  } catch (err) {
    logger.error({ err }, 'magic-link-service: consumeMagicLinkToken failed');
    return { valid: false, reason: 'not_found' };
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────

/**
 * Delete rows whose expiry is in the past AND which were never
 * consumed (or were consumed >7 days ago — keeping the recent
 * history around for forensics). Returns the count deleted.
 */
export function purgeExpiredMagicLinkTokens(): number {
  try {
    const res = getDb().prepare(
      `DELETE FROM magic_link_tokens
       WHERE (consumed_at IS NULL AND datetime('now') >= datetime(expires_at))
          OR (consumed_at IS NOT NULL AND datetime('now', '-7 days') >= datetime(consumed_at))`,
    ).run();
    return res.changes;
  } catch (err) {
    logger.error({ err }, 'magic-link-service: purgeExpiredMagicLinkTokens failed');
    return 0;
  }
}
