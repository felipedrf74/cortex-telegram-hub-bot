// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OI-WELCOME-201 (2026-04-24) — one-time welcome email on paid
 * upgrade.
 *
 * Fires a transactional email to a user's address the first time
 * they land on a paid tier ('pro' or 'max'). Idempotent by design:
 *   - Checks the audit_trail for a prior `welcome_email.sent` row
 *     scoped to this user. If present → skip.
 *   - Otherwise, fetches the user, dispatches the email via the
 *     existing mailer abstraction (same Resend backend as magic-
 *     link), writes the audit row ONLY on delivery success.
 *
 * Audit-row gating (vs a `users.welcome_sent_at` column):
 *   - No schema migration required.
 *   - Reuses the existing audit trail ops already consult.
 *   - Preserves history across deliveries (future "re-send
 *     welcome" flows land without altering the user row).
 *
 * Callsites (intentionally broad — safe to call anywhere a tier
 * transition happens; the internal idempotency + tier check
 * decide whether a send actually occurs):
 *   - setUserTier (Telegram-flow tier grants)
 *   - ios-auth-session invite-code beta access (ios-exclusive
 *     beta-access grant path, sets tier to 'max')
 *   - Future: Stripe webhook → subscription.created
 *   - Future: admin-grant flows
 *
 * Failure mode: the mailer can fail (Resend outage, domain not
 * verified yet, etc.). We log but DO NOT throw — the tier change
 * always commits; the welcome is best-effort. We also DON'T write
 * the audit row on send failure, so the next tier-adjacent event
 * for that user retries the send.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { sendTransactionalEmail, MailerError } from './mailer';

const WELCOME_AUDIT_ACTION = 'welcome_email.sent';
const PAID_TIERS: ReadonlySet<string> = new Set(['pro', 'max']);

export interface FireWelcomeResult {
  sent: boolean;
  reason?: 'not_paid_tier' | 'no_email' | 'already_sent' | 'user_not_found' | 'send_failed';
  /** Present only when sent=false + reason=send_failed; surfaces the MailerError code. */
  error?: string;
}

function hasPriorWelcome(userId: number): boolean {
  try {
    const row = getDb().prepare(
      `SELECT 1 FROM audit_trail
       WHERE user_id = ? AND action = ?
       LIMIT 1`,
    ).get(userId, WELCOME_AUDIT_ACTION) as { 1: number } | undefined;
    return row !== undefined;
  } catch (err) {
    // If we can't read the ledger, fail SAFE — pretend we sent,
    // to avoid double-spamming users if the audit table is
    // temporarily unavailable. (Inverse of auth-middleware's
    // fail-closed stance: here, the security concern is user-
    // experience-damage from duplicate emails, not unauthorized
    // access.)
    logger.error({ err, userId }, 'welcome-email: hasPriorWelcome read failed; assuming sent');
    return true;
  }
}

function recordWelcomeSent(userId: number, to: string): void {
  try {
    getDb().prepare(
      `INSERT INTO audit_trail (user_id, actor_id, action, resource, details, ts)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      userId,
      userId, // actor = the user themselves (the tier change event caused the send)
      WELCOME_AUDIT_ACTION,
      'user.' + userId,
      // Values: we log the TO address (not PII-sensitive since it's
      // already on users.email) + the template name. Value of the
      // email body is NOT stored — matches the audit invariant from
      // CLAUDE.md.
      JSON.stringify({ to, template: 'welcome.paid_upgrade' }),
    );
  } catch (err) {
    logger.warn({ err, userId }, 'welcome-email: failed to record audit row (send succeeded; retry guard disabled)');
  }
}

function getUserEmailAndTierAndName(userId: number): { email: string | null; tier: string | null; firstName: string | null } | null {
  try {
    const row = getDb().prepare(
      'SELECT email, tier, first_name FROM users WHERE id = ?',
    ).get(userId) as { email: string | null; tier: string | null; first_name: string | null } | undefined;
    return row
      ? { email: row.email, tier: row.tier, firstName: row.first_name }
      : null;
  } catch (err) {
    logger.error({ err, userId }, 'welcome-email: user lookup failed');
    return null;
  }
}

/**
 * Fire a welcome email to `userId` if all gates pass. Idempotent,
 * non-throwing, fire-and-forget-safe. Returns a structured result
 * for callers that want to log the outcome.
 *
 * Gates (in order):
 *   1. User row exists + has an email address.
 *   2. User is currently on a paid tier ('pro' or 'max').
 *   3. No prior `welcome_email.sent` audit row for this user.
 *
 * On success, writes the audit row + returns { sent: true }.
 * On mailer failure, DOES NOT write the audit row (the next
 * call retries).
 */
export async function fireWelcomeEmailIfFirstTimePaid(userId: number): Promise<FireWelcomeResult> {
  if (!Number.isFinite(userId) || userId <= 0) {
    return { sent: false, reason: 'user_not_found' };
  }
  const row = getUserEmailAndTierAndName(userId);
  if (!row) return { sent: false, reason: 'user_not_found' };
  if (!row.email) return { sent: false, reason: 'no_email' };
  if (!row.tier || !PAID_TIERS.has(row.tier)) return { sent: false, reason: 'not_paid_tier' };
  if (hasPriorWelcome(userId)) return { sent: false, reason: 'already_sent' };

  try {
    await sendTransactionalEmail({
      template: 'welcome.paid_upgrade',
      to: row.email,
      subject: 'Welcome to Nexus Hub',
      context: {
        firstName: row.firstName || 'there',
        tier: row.tier,
        consoleUrl: (process.env.PORTAL_PUBLIC_URL || 'https://nexushub.me') + '/console',
      },
    });
    recordWelcomeSent(userId, row.email);
    logger.info({ userId, email: row.email, tier: row.tier }, 'welcome-email: sent');
    return { sent: true };
  } catch (err) {
    const mailerErr = err instanceof MailerError ? err : null;
    logger.error({ err, userId, email: row.email }, 'welcome-email: send failed; will retry on next tier event');
    return {
      sent: false,
      reason: 'send_failed',
      error: mailerErr ? mailerErr.code : 'UNKNOWN',
    };
  }
}

/**
 * Fire-and-forget variant for callers inside a sync code path
 * that can't await. Swallows errors entirely — nothing blocks the
 * caller, nothing throws. Used by setUserTier + ios-auth-session
 * so a mailer hiccup never impacts the tier transition.
 */
export function fireWelcomeEmailInBackground(userId: number): void {
  fireWelcomeEmailIfFirstTimePaid(userId).catch((err) => {
    logger.warn({ err, userId }, 'welcome-email: background fire swallowed error');
  });
}
