// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// AUTH-O7 (closed-beta-auth-hardening, 2026-05-04): per-account login
// lockout. IP-bucket rate limiting (rate-limiter.ts) does not bound
// distributed credential-stuffing across many source IPs. This module
// closes that gap by tracking failures per user_id.
//
// Policy:
//   - 10 failed `/auth/login/email` attempts within a sliding 15-min
//     window → account locked for the NEXT 15 min from the 10th
//     failure.
//   - Successful login clears the row.
//   - Lockout state is purely DB-driven: no in-memory cache, no
//     external service. Acceptable for closed-beta scale; revisit when
//     scaling beyond a single PM2 instance (AUTH-O14).
//
// The route MUST call:
//   `assertNotLocked(userId)` BEFORE bcrypt.compare (to avoid CPU burn
//                                                    on a locked account)
//   `recordFailedLogin(userId, email)` on bcrypt.compare miss.
//   `recordSuccessfulLogin(userId)` on bcrypt.compare hit.
//
// All three are idempotent and safe to call from the route handler.

import { getDb } from './database';
import { logger } from '../utils/logger';

export const FAILED_LOGIN_THRESHOLD = 10;
export const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;    // 15 min

export interface FailedLoginRow {
  user_id: number;
  email_at_first: string | null;
  attempt_count: number;
  first_failed_at: string | null;
  last_failed_at: string | null;
  locked_until: string | null;
  created_at: string;
}

export type LockoutState =
  | { kind: 'unlocked'; attemptsInWindow: number }
  | { kind: 'locked'; until: Date; attemptsInWindow: number };

/**
 * Read current lockout state for a user. Pure read; safe to call from
 * any path that needs to gate auth-sensitive work. Returns 'unlocked'
 * with 0 attempts when no row exists (the user has never failed).
 *
 * Side effect: if `locked_until` is in the past AND `last_failed_at`
 * is older than the sliding window, the row is reset (window expired).
 * This keeps the table from accumulating stale lockouts.
 */
export function getLockoutState(userId: number, now: Date = new Date()): LockoutState {
  const db = getDb();
  const row = db.prepare(`
    SELECT user_id, email_at_first, attempt_count, first_failed_at,
           last_failed_at, locked_until, created_at
    FROM failed_login_attempts
    WHERE user_id = ?
  `).get(userId) as FailedLoginRow | undefined;

  if (!row) return { kind: 'unlocked', attemptsInWindow: 0 };

  // Locked if locked_until > now.
  if (row.locked_until) {
    const until = new Date(row.locked_until);
    if (until.getTime() > now.getTime()) {
      return { kind: 'locked', until, attemptsInWindow: row.attempt_count };
    }
  }

  // Window expired? If first_failed_at is older than the sliding window
  // AND lockout has expired, reset the row (lazy GC).
  if (row.first_failed_at) {
    const firstAge = now.getTime() - new Date(row.first_failed_at).getTime();
    if (firstAge >= FAILED_LOGIN_WINDOW_MS) {
      db.prepare('DELETE FROM failed_login_attempts WHERE user_id = ?').run(userId);
      return { kind: 'unlocked', attemptsInWindow: 0 };
    }
  }

  return { kind: 'unlocked', attemptsInWindow: row.attempt_count };
}

/**
 * Throw-style guard. Routes call this BEFORE bcrypt to avoid CPU burn
 * on a locked account. Returns a normalized state for the caller to
 * audit. Does NOT throw — the route decides how to respond (we want
 * the route to emit a typed audit row).
 */
export function assertNotLocked(userId: number, now: Date = new Date()): LockoutState {
  return getLockoutState(userId, now);
}

/**
 * Record a failed login attempt. Returns the new lockout state. The
 * caller emits the audit row.
 *
 * Schema:
 *   - On the first failure within a window, INSERT the row.
 *   - On subsequent failures within the same window, increment.
 *   - On the threshold-th failure, set locked_until = now + 15min.
 *   - If a previous lockout has expired but the row still exists,
 *     reset the window (`first_failed_at = now`, `attempt_count = 1`).
 */
export function recordFailedLogin(
  userId: number,
  email: string,
  now: Date = new Date(),
): LockoutState {
  const db = getDb();
  const existing = db.prepare(`
    SELECT * FROM failed_login_attempts WHERE user_id = ?
  `).get(userId) as FailedLoginRow | undefined;

  const nowIso = now.toISOString();

  if (!existing) {
    db.prepare(`
      INSERT INTO failed_login_attempts
        (user_id, email_at_first, attempt_count, first_failed_at, last_failed_at, locked_until)
      VALUES (?, ?, 1, ?, ?, NULL)
    `).run(userId, email, nowIso, nowIso);
    return { kind: 'unlocked', attemptsInWindow: 1 };
  }

  // If the existing row's first_failed_at is older than the sliding
  // window, OR the previous lockout has expired, reset the window.
  const firstAgeMs = existing.first_failed_at
    ? now.getTime() - new Date(existing.first_failed_at).getTime()
    : Infinity;
  const lockoutExpired = existing.locked_until
    ? new Date(existing.locked_until).getTime() <= now.getTime()
    : true;

  if (firstAgeMs >= FAILED_LOGIN_WINDOW_MS || (existing.locked_until && lockoutExpired)) {
    db.prepare(`
      UPDATE failed_login_attempts
         SET attempt_count = 1,
             first_failed_at = ?,
             last_failed_at = ?,
             locked_until = NULL,
             email_at_first = ?
       WHERE user_id = ?
    `).run(nowIso, nowIso, email, userId);
    return { kind: 'unlocked', attemptsInWindow: 1 };
  }

  // Increment within the active window.
  const newCount = existing.attempt_count + 1;
  if (newCount >= FAILED_LOGIN_THRESHOLD) {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS);
    db.prepare(`
      UPDATE failed_login_attempts
         SET attempt_count = ?,
             last_failed_at = ?,
             locked_until = ?
       WHERE user_id = ?
    `).run(newCount, nowIso, lockedUntil.toISOString(), userId);
    logger.warn(
      { userId, attemptCount: newCount, event: 'auth.account_locked' },
      'Account locked after threshold failures',
    );
    return { kind: 'locked', until: lockedUntil, attemptsInWindow: newCount };
  }

  db.prepare(`
    UPDATE failed_login_attempts
       SET attempt_count = ?,
           last_failed_at = ?
     WHERE user_id = ?
  `).run(newCount, nowIso, userId);
  return { kind: 'unlocked', attemptsInWindow: newCount };
}

/**
 * Clear lockout state on successful login. Idempotent — safe even if
 * no row exists (i.e. user has never failed).
 */
export function recordSuccessfulLogin(userId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM failed_login_attempts WHERE user_id = ?').run(userId);
}
