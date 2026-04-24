// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tenant invite service — the create/list/accept/revoke flow that
 * makes multi-member tenants possible.
 *
 * Introduced by Phase 2B of the portal redesign (2026-04-22). See
 * `migrations/077_tenant_invites.sql` for the schema + rationale.
 *
 * ## Lifecycle
 *
 *   (tenant_admin) createInvite(tenantId, email, role)
 *     → row { status: 'pending', invite_code }
 *
 *   (invitee, logged in)   listPendingForEmail(email)
 *     → rows the current user can act on
 *
 *   (invitee)              acceptInvite(code, userId)
 *     → tenant_members row created + invite row updated
 *
 *   (tenant_admin)         revokeInvite(inviteId, actorId)
 *     → invite row status='revoked'; membership untouched if already accepted
 *
 * ## Idempotency
 *
 * `acceptInvite` is idempotent on the membership side (INSERT OR
 * IGNORE into tenant_members) but NOT on the invite row — a second
 * accept attempt on an already-accepted invite returns
 * `ALREADY_ACCEPTED`. Tests pin this.
 *
 * ## Fail-closed
 *
 * Any DB error returns a typed InviteError; the HTTP layer converts
 * to 500/403/404 as appropriate. Unknown code → 404 (not 400 — we
 * don't want enumerators to distinguish "invalid code format" from
 * "valid format, revoked" via status code).
 */

import crypto from 'crypto';
import { getDb } from './database';
import { logger } from '../utils/logger';

export type InviteRole = 'tenant_admin' | 'tenant_member' | 'tenant_viewer';
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InviteRow {
  id: number;
  tenantId: number;
  email: string;
  role: InviteRole;
  inviteCode: string;
  status: InviteStatus;
  createdAt: string;
  createdBy: number;
  expiresAt: string | null;
  acceptedAt: string | null;
  acceptedBy: number | null;
  revokedAt: string | null;
  revokedBy: number | null;
}

export type InviteErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_ACCEPTED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'EMAIL_MISMATCH'
  | 'DUPLICATE_PENDING'
  | 'DB_ERROR';

export class InviteError extends Error {
  readonly code: InviteErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: InviteErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'InviteError';
    this.code = code;
    this.details = details;
  }
}

// ── Row mapping ────────────────────────────────────────────────────

interface RawRow {
  id: number;
  tenant_id: number;
  email: string;
  role: string;
  invite_code: string;
  status: string;
  created_at: string;
  created_by: number;
  expires_at: string | null;
  accepted_at: string | null;
  accepted_by: number | null;
  revoked_at: string | null;
  revoked_by: number | null;
}

function mapRow(r: RawRow): InviteRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    email: r.email,
    role: r.role as InviteRole,
    inviteCode: r.invite_code,
    status: r.status as InviteStatus,
    createdAt: r.created_at,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    acceptedBy: r.accepted_by,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
  };
}

// ── Invite creation ───────────────────────────────────────────────

export interface CreateInviteOptions {
  tenantId: number;
  email: string;
  role: InviteRole;
  createdBy: number;
  expiresAt?: string | null;   // ISO-8601; null/undefined = never
}

/**
 * Create a pending invite. Returns the full row including the
 * randomly-generated `invite_code` (32 bytes base64url). If a
 * pending invite already exists for (tenant, email), throws
 * InviteError('DUPLICATE_PENDING') — the caller decides whether to
 * revoke+recreate or just surface the existing row.
 */
export function createInvite(opts: CreateInviteOptions): InviteRow {
  const email = opts.email.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new InviteError('DB_ERROR', 'email must be a valid address', { email: opts.email });
  }
  const inviteCode = crypto.randomBytes(24).toString('base64url');
  try {
    const db = getDb();
    const result = db
      .prepare(
        `INSERT INTO tenant_invites
           (tenant_id, email, role, invite_code, status, created_by, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        opts.tenantId,
        email,
        opts.role,
        inviteCode,
        opts.createdBy,
        opts.expiresAt ?? null,
      );
    const id = Number(result.lastInsertRowid);
    return getInviteById(id)!;
  } catch (err: any) {
    if (/UNIQUE constraint failed/i.test(err?.message || '')) {
      throw new InviteError(
        'DUPLICATE_PENDING',
        `A pending invite for ${email} already exists on tenant ${opts.tenantId}`,
        { tenantId: opts.tenantId, email },
      );
    }
    logger.error({ err, opts }, 'tenant-invite-service: createInvite failed');
    throw new InviteError('DB_ERROR', 'Failed to create invite');
  }
}

// ── Reads ─────────────────────────────────────────────────────────

export function getInviteById(id: number): InviteRow | null {
  if (!Number.isFinite(id) || id <= 0) return null;
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM tenant_invites WHERE id = ?')
      .get(id) as RawRow | undefined;
    return row ? mapRow(row) : null;
  } catch (err) {
    logger.error({ err, id }, 'tenant-invite-service: getInviteById failed');
    return null;
  }
}

export function getInviteByCode(code: string): InviteRow | null {
  if (typeof code !== 'string' || code.length < 16) return null;
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT * FROM tenant_invites WHERE invite_code = ?')
      .get(code) as RawRow | undefined;
    return row ? mapRow(row) : null;
  } catch (err) {
    logger.error({ err }, 'tenant-invite-service: getInviteByCode failed');
    return null;
  }
}

// ─── OI-NAV-203a: public invite-inspection for cold invitees ─────────

/**
 * Public metadata for an invite, returned unauthenticated by the
 * /invite/inspect/:code route. Exposed to anyone holding the code
 * (which is the invitee by design). Contains enough for the cold-
 * invitee UI to decide between "sign in to accept" (email has an
 * existing account) and "create an account to accept" (first-time
 * user) — without leaking tenant membership or any other tenant's
 * data.
 *
 * Deliberately DOES NOT include the raw `createdBy` user id or any
 * internal tenant ids — those would expose the inviting user's
 * identity to an unauthenticated caller holding a guessed code.
 * The invite code itself is the security boundary; adding inviting
 * identity would widen the attack surface with no user benefit.
 */
export interface PublicInviteInfo {
  valid: boolean;
  /** Populated only when valid: */
  tenantSlug?: string;
  tenantName?: string;
  inviteeEmail?: string;
  role?: string;
  expiresAt?: string | null;
  status?: string; // 'pending' | 'accepted' | 'revoked' | 'expired'
  /** True iff a user row already exists with the invitee's email. */
  hasAccount?: boolean;
  /** True iff the invite has passed its expiresAt timestamp. */
  isExpired?: boolean;
  /** Machine-readable reason when valid=false: 'not_found' | 'malformed'. */
  reason?: string;
}

export function getPublicInviteInfo(code: string): PublicInviteInfo {
  if (typeof code !== 'string' || code.length < 16) {
    return { valid: false, reason: 'malformed' };
  }
  const invite = getInviteByCode(code);
  if (!invite) return { valid: false, reason: 'not_found' };
  try {
    const db = getDb();
    // Tenant display metadata — name is OK to leak to the holder of
    // the code; it's also in the invite email body.
    const tenantRow = db
      .prepare('SELECT slug, display_name FROM tenants WHERE id = ?')
      .get(invite.tenantId) as { slug: string; display_name: string } | undefined;
    // Has-account check — lowercase-normalise to match getUserByEmail.
    const userRow = db
      .prepare('SELECT 1 FROM users WHERE lower(email) = lower(?) LIMIT 1')
      .get(invite.email) as { 1: number } | undefined;

    const now = Date.now();
    const isExpired = invite.expiresAt != null
      ? new Date(invite.expiresAt).getTime() < now
      : false;

    return {
      valid: true,
      tenantSlug: tenantRow?.slug ?? `tenant-${invite.tenantId}`,
      tenantName: tenantRow?.display_name ?? tenantRow?.slug ?? 'a Nexus Hub workspace',
      inviteeEmail: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      status: invite.status,
      hasAccount: userRow !== undefined,
      isExpired,
    };
  } catch (err) {
    logger.error({ err }, 'tenant-invite-service: getPublicInviteInfo failed');
    return { valid: false, reason: 'not_found' };
  }
}

/**
 * Admin view: every invite (any status) for a tenant, newest first.
 * Used by GET /workspace/invites (tenant_admin only).
 */
export function listInvitesForTenant(tenantId: number): InviteRow[] {
  if (!Number.isFinite(tenantId) || tenantId <= 0) return [];
  try {
    const db = getDb();
    const rows = db
      .prepare(
        'SELECT * FROM tenant_invites WHERE tenant_id = ? ORDER BY created_at DESC',
      )
      .all(tenantId) as RawRow[];
    return rows.map(mapRow);
  } catch (err) {
    logger.error({ err, tenantId }, 'tenant-invite-service: listInvitesForTenant failed');
    return [];
  }
}

/**
 * Invitee view: pending invites addressed to this email. Used by
 * GET /workspace/my-invites. Matches case-insensitively.
 */
export function listPendingForEmail(email: string): InviteRow[] {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return [];
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM tenant_invites
         WHERE LOWER(email) = ? AND status = 'pending'
         ORDER BY created_at DESC`,
      )
      .all(normalized) as RawRow[];
    return rows.map(mapRow);
  } catch (err) {
    logger.error({ err }, 'tenant-invite-service: listPendingForEmail failed');
    return [];
  }
}

// ── Accept ────────────────────────────────────────────────────────

/**
 * Accept a pending invite. The caller's userId AND email are
 * required — we refuse to accept on behalf of another user. If the
 * caller's email doesn't match the invite, throws EMAIL_MISMATCH
 * (this is the anti-probe defense — we do NOT reveal whether the
 * code exists but belongs to a different email).
 *
 * On success, returns the invite row post-update. The tenant_members
 * row is created idempotently; a second accept of an already-
 * accepted invite returns ALREADY_ACCEPTED (not a silent no-op —
 * the client should know their state is stale).
 */
export interface AcceptInviteOptions {
  code: string;
  userId: number;
  userEmail: string;
}

export function acceptInvite(opts: AcceptInviteOptions): InviteRow {
  const code = opts.code;
  const userId = opts.userId;
  const userEmail = String(opts.userEmail || '').trim().toLowerCase();

  if (!Number.isFinite(userId) || userId <= 0) {
    throw new InviteError('NOT_FOUND', 'invalid user id');
  }
  if (!userEmail) {
    throw new InviteError('EMAIL_MISMATCH', 'caller has no email on file');
  }

  const existing = getInviteByCode(code);
  if (!existing) {
    throw new InviteError('NOT_FOUND', 'No invite with that code', { code });
  }
  if (existing.status === 'revoked') {
    throw new InviteError('REVOKED', 'Invite has been revoked');
  }
  if (existing.status === 'expired') {
    throw new InviteError('EXPIRED', 'Invite has expired');
  }
  if (existing.status === 'accepted') {
    throw new InviteError('ALREADY_ACCEPTED', 'Invite already accepted', {
      tenantId: existing.tenantId,
      acceptedBy: existing.acceptedBy,
    });
  }
  // Validation pass (2026-04-22): expiry comparison moved from
  //   `new Date(existing.expiresAt) < new Date()`
  // to a SQLite-side comparison. Rationale: SQLite's datetime()
  // returns UTC text without a trailing 'Z' (e.g. '2026-04-22 20:05:10'),
  // while callers store expires_at as ISO-8601 (e.g.
  // '2026-04-22T20:05:00.000Z'). JS Date() parses the SQLite form as
  // LOCAL time in some Node versions, giving a ±timezone offset skew
  // on the expiry check. Delegating to SQLite fixes that, BUT we must
  // wrap both sides in datetime() so SQLite normalizes the ISO input
  // ('T' + 'Z') into its internal 'YYYY-MM-DD HH:MM:SS' format —
  // otherwise the naive string compare treats 'T' (0x54) > ' ' (0x20)
  // and the expired check never fires.
  if (existing.expiresAt) {
    const row = getDb()
      .prepare("SELECT datetime('now') >= datetime(?) AS expired")
      .get(existing.expiresAt) as { expired: number } | undefined;
    if (row?.expired === 1) {
      // Lazy expiry: mark and throw.
      try {
        getDb()
          .prepare(
            "UPDATE tenant_invites SET status = 'expired' WHERE id = ? AND status = 'pending'",
          )
          .run(existing.id);
      } catch {
        // non-fatal; the throw below still runs
      }
      throw new InviteError('EXPIRED', 'Invite has expired');
    }
  }
  if (existing.email.toLowerCase() !== userEmail) {
    throw new InviteError(
      'EMAIL_MISMATCH',
      'This invite was issued to a different email',
      { inviteEmail: existing.email },
    );
  }

  // Atomic: upsert membership + mark invite accepted. Wrap in a
  // transaction so a crash between the two doesn't leave an orphan
  // "accepted" invite without a membership row.
  try {
    const db = getDb();
    const runTxn = db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO tenant_members
           (tenant_id, user_id, role, joined_at, invited_by)
         VALUES (?, ?, ?, datetime('now'), ?)`,
      ).run(existing.tenantId, userId, existing.role, existing.createdBy);

      db.prepare(
        `UPDATE tenant_invites
         SET status = 'accepted',
             accepted_at = datetime('now'),
             accepted_by = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(userId, existing.id);
    });
    runTxn();
  } catch (err) {
    logger.error({ err, inviteId: existing.id, userId }, 'tenant-invite-service: accept transaction failed');
    throw new InviteError('DB_ERROR', 'Failed to accept invite');
  }

  return getInviteById(existing.id)!;
}

// ── Revoke ────────────────────────────────────────────────────────

export function revokeInvite(inviteId: number, actorUserId: number): InviteRow {
  const existing = getInviteById(inviteId);
  if (!existing) {
    throw new InviteError('NOT_FOUND', 'Invite not found', { inviteId });
  }
  if (existing.status === 'accepted') {
    throw new InviteError(
      'ALREADY_ACCEPTED',
      'Cannot revoke — invite already accepted. Remove the member from the tenant instead.',
      { tenantId: existing.tenantId, acceptedBy: existing.acceptedBy },
    );
  }
  if (existing.status !== 'pending') {
    // Already revoked/expired — idempotent success; return as-is.
    return existing;
  }
  try {
    getDb()
      .prepare(
        `UPDATE tenant_invites
         SET status = 'revoked', revoked_at = datetime('now'), revoked_by = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(actorUserId, inviteId);
  } catch (err) {
    logger.error({ err, inviteId }, 'tenant-invite-service: revokeInvite failed');
    throw new InviteError('DB_ERROR', 'Failed to revoke invite');
  }
  return getInviteById(inviteId)!;
}
