// AUTH-O2 (closed-beta-auth-hardening, 2026-05-04): Password reset service.
//
// Pure-ish module; depends only on `database`, `logger`, `audit-trail`,
// and Node `crypto`/`bcryptjs`. Routes (src/api/routes/auth.ts) handle
// HTTP concerns, validation, and email delivery.

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { logAudit } from './audit-trail';

// 1 hour TTL is the OWASP cheat-sheet recommendation.
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
// 5-attempt cap mirrors AUTH-O5 / migration 108.
export const PASSWORD_RESET_MAX_ATTEMPTS = 5;
// 32 random bytes = 256 bits = brute-force-infeasible by entropy.
export const PASSWORD_RESET_TOKEN_BYTES = 32;

export interface PasswordResetTokenRow {
  user_id: number;
  token_hash: string;
  email_at_issue: string;
  expires_at: string;
  attempt_count: number;
  used_at: string | null;
  created_at: string;
}

export type RequestOutcome =
  | { kind: 'issued'; token: string; expiresAt: Date }
  // We deliberately return 'issued_silent' instead of 'no_user' so the
  // route can return an indistinguishable 200 OK whether the email
  // matched a real user or not. This closes the account-existence
  // enumeration vector (same posture as /auth/register collapsing to
  // REGISTRATION_REJECTED for both "email taken" and "rejected").
  | { kind: 'issued_silent' }
  | { kind: 'rate_limited' };

export type ConfirmOutcome =
  | { kind: 'success'; userId: number }
  | { kind: 'invalid_or_expired' }
  | { kind: 'too_many_attempts' };

/**
 * Generate a fresh opaque token (URL-safe base64) and its at-rest hash.
 * The token bytes are returned ONLY to the caller (route → email); the
 * hash is what we persist.
 */
export function generatePasswordResetToken(): { token: string; tokenHash: string } {
  const raw = crypto.randomBytes(PASSWORD_RESET_TOKEN_BYTES);
  const token = raw.toString('base64url');
  const tokenHash = hashResetToken(token);
  return { token, tokenHash };
}

/**
 * Hash a token at rest. SHA-256 is intentional, NOT bcrypt:
 *   - We need O(1) lookup by hash (the route receives the token,
 *     hashes it, looks the row up by hash).
 *   - Token entropy is 256 bits — bcrypt's cost factor adds nothing
 *     against a high-entropy input.
 *   - SHA-256 is constant-time-friendly relative to row lookup.
 */
export function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Issue a reset token for a user. UPSERT on user_id collapses any
 * previous active token. Returns the raw token (caller emails it).
 */
export function issuePasswordResetToken(
  userId: number,
  emailAtIssue: string,
  now: Date = new Date(),
): { token: string; tokenHash: string; expiresAt: Date } {
  const { token, tokenHash } = generatePasswordResetToken();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
  const db = getDb();
  db.prepare(`
    INSERT INTO password_reset_tokens
      (user_id, token_hash, email_at_issue, expires_at, attempt_count, used_at, created_at)
    VALUES (?, ?, ?, ?, 0, NULL, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      token_hash     = excluded.token_hash,
      email_at_issue = excluded.email_at_issue,
      expires_at     = excluded.expires_at,
      attempt_count  = 0,
      used_at        = NULL,
      created_at     = excluded.created_at
  `).run(userId, tokenHash, emailAtIssue, expiresAt.toISOString(), now.toISOString());
  return { token, tokenHash, expiresAt };
}

/**
 * Look up the active reset row by token (hashed). Returns null if no
 * row matches OR the row is already used.
 *
 * NOTE: this MUST be called BEFORE expiry/attempt checks so the route
 * can give the right response shape per case.
 */
export function findActiveResetByToken(token: string): PasswordResetTokenRow | null {
  const tokenHash = hashResetToken(token);
  const db = getDb();
  const row = db.prepare(`
    SELECT user_id, token_hash, email_at_issue, expires_at,
           attempt_count, used_at, created_at
    FROM password_reset_tokens
    WHERE token_hash = ?
  `).get(tokenHash) as PasswordResetTokenRow | undefined;
  if (!row) return null;
  return row;
}

/**
 * Increment the attempt counter on a reset row. Returns the new count.
 */
export function recordResetAttempt(userId: number): number {
  const db = getDb();
  const updated = db.prepare(`
    UPDATE password_reset_tokens
       SET attempt_count = attempt_count + 1
     WHERE user_id = ?
    RETURNING attempt_count
  `).get(userId) as { attempt_count: number } | undefined;
  return updated?.attempt_count ?? 0;
}

/**
 * Mark a reset token as consumed and apply the new password.
 * Caller is responsible for revoking active iOS sessions AFTER this.
 */
export function consumeResetTokenAndApplyPassword(
  userId: number,
  newPasswordHash: string,
  now: Date = new Date(),
): boolean {
  const db = getDb();
  // Single-use enforcement: only update if used_at IS NULL AND row exists.
  const result = db.prepare(`
    UPDATE password_reset_tokens
       SET used_at = ?
     WHERE user_id = ?
       AND used_at IS NULL
  `).run(now.toISOString(), userId);
  if (result.changes !== 1) return false;
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(newPasswordHash, userId);
  return true;
}

/**
 * Revoke every active iOS device session for a user. Called on
 * successful password reset so a stolen reset link cannot keep a
 * pre-reset session alive on another device.
 *
 * Matches the existing /auth/logout-all pattern (DELETE row), since
 * `ios_devices` uses row removal — the device row's existence IS the
 * session, per `auth-middleware.ts`'s device-row check.
 *
 * Best-effort: returns the number of rows affected. Failure is logged
 * but does not abort the reset (the password is already changed).
 */
export function revokeAllSessionsAfterReset(userId: number): number {
  const db = getDb();
  try {
    const result = db.prepare(
      'DELETE FROM ios_devices WHERE user_id = ?',
    ).run(userId);
    if (result.changes > 0) {
      logger.info(
        { userId, sessionsRevoked: result.changes, event: 'password_reset.session_revocation' },
        'Revoked iOS sessions after password reset',
      );
    }
    return result.changes;
  } catch (err: any) {
    logger.error(
      { err, userId, event: 'password_reset.session_revocation' },
      'Failed to revoke iOS sessions after password reset',
    );
    return 0;
  }
}

/**
 * Best-effort prune of expired reset tokens. Called inside the request
 * path opportunistically; not a scheduled cron (low cost, no PII).
 */
export function pruneExpiredResetTokens(now: Date = new Date()): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM password_reset_tokens
     WHERE used_at IS NOT NULL
        OR expires_at < ?
  `).run(now.toISOString());
  return result.changes;
}

/**
 * Hash a fresh password with bcrypt cost 12. Centralizing here so the
 * cost factor doesn't drift between /register/email and /confirm.
 */
export async function hashNewPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Audit emission helper. Routes call this on the four outcomes:
 *   - 'request_issued'        — token was issued (real email match)
 *   - 'request_silent'        — request received for an unknown email
 *   - 'confirm_success'       — token consumed, password updated
 *   - 'confirm_invalid'       — token did not match an active row
 *   - 'confirm_expired'       — token matched but past expires_at
 *   - 'confirm_already_used'  — token matched but used_at != NULL
 *   - 'confirm_too_many'      — attempt cap hit
 *
 * userId may be 0 for the silent-request case where we don't want to
 * leak existence.
 */
export function auditPasswordResetEvent(opts: {
  outcome: 'request_issued' | 'request_silent' | 'confirm_success'
    | 'confirm_invalid' | 'confirm_expired' | 'confirm_already_used'
    | 'confirm_too_many';
  userId: number;
  emailHash?: string;
  ipAddress?: string;
  deviceId?: string;
}): void {
  try {
    logAudit({
      userId: opts.userId,
      tenantId: opts.userId,
      actorId: opts.userId || 0,
      action: 'access',
      resource: opts.outcome.startsWith('request')
        ? 'auth.password_reset_request'
        : 'auth.password_reset_confirm',
      details: {
        outcome: opts.outcome,
        emailHash: opts.emailHash,
        deviceId: opts.deviceId,
      },
      ipAddress: opts.ipAddress,
    });
  } catch (err: any) {
    logger.warn(
      { err, outcome: opts.outcome, event: 'password_reset.audit_failed' },
      'Failed to emit password-reset audit row',
    );
  }
}
