// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Durable, user-scoped OAuth authentication failures.
 *
 * Only deterministic re-auth signals are accepted. Transient network,
 * provider availability, quota, and server failures return `null` from the
 * classifier and never become a user-facing revoked state.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

export type UserScopedOAuthProvider = 'google' | 'outlook';

export type OAuthAuthFailureReason =
  | 'invalid_grant'
  | 'invalid_token'
  | 'interaction_required'
  | 'token_expired'
  | 'token_revoked';

export interface OAuthConnectionAuthFailure {
  provider: UserScopedOAuthProvider;
  state: 'auth_rejected';
  reasonCode: OAuthAuthFailureReason;
  firstDetectedAt: string;
  lastDetectedAt: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : null;
}

function collectFailureSignals(error: unknown): string[] {
  const signals: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || value === undefined || seen.has(value)) return;
    if (typeof value === 'string' || typeof value === 'number') {
      signals.push(String(value).toLowerCase());
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    seen.add(value);
    for (const key of [
      'message',
      'code',
      'error',
      'errorCode',
      'subError',
      'error_description',
      'errorDescription',
      'response',
      'data',
      'body',
    ]) {
      visit(record[key], depth + 1);
    }
  };
  visit(error, 0);
  return signals;
}

/**
 * Classify only provider responses that require the current user to re-auth.
 * App/client credential failures are intentionally excluded because they are
 * global operator problems, not evidence that one user's grant is revoked.
 */
export function classifyOAuthAuthFailure(error: unknown): OAuthAuthFailureReason | null {
  const signals = collectFailureSignals(error);
  const includesCode = (code: string): boolean => signals.some((signal) => (
    signal === code || new RegExp(`(^|[^a-z0-9])${code}([^a-z0-9]|$)`, 'i').test(signal)
  ));

  if (includesCode('invalid_grant')) return 'invalid_grant';
  if (includesCode('invalid_token')) return 'invalid_token';
  if (
    includesCode('interaction_required')
    || includesCode('login_required')
    || includesCode('consent_required')
  ) {
    return 'interaction_required';
  }

  const refreshTokenSignal = signals.find((signal) => /refresh[ _-]?token/.test(signal));
  if (refreshTokenSignal && /\b(expired|expiration)\b/.test(refreshTokenSignal)) {
    return 'token_expired';
  }
  if (refreshTokenSignal && /\b(revoked|invalid|rejected)\b/.test(refreshTokenSignal)) {
    return 'token_revoked';
  }
  return null;
}

function validUserId(userId: number): boolean {
  return Number.isSafeInteger(userId) && userId > 0;
}

export function markOAuthConnectionAuthFailure(
  userId: number,
  provider: UserScopedOAuthProvider,
  reasonCode: OAuthAuthFailureReason,
): boolean {
  if (!validUserId(userId)) return false;
  try {
    getDb().prepare(`
      INSERT INTO user_oauth_connection_health (
        user_id, tenant_id, provider, state, reason_code,
        first_detected_at, last_detected_at
      ) VALUES (?, ?, ?, 'auth_rejected', ?, datetime('now'), datetime('now'))
      ON CONFLICT(user_id, tenant_id, provider) DO UPDATE SET
        state = 'auth_rejected',
        reason_code = excluded.reason_code,
        last_detected_at = datetime('now')
    `).run(userId, userId, provider, reasonCode);
    return true;
  } catch (err) {
    // Do not replace the provider's original error with health bookkeeping.
    logger.warn({ err, userId, provider }, 'Could not persist scoped OAuth auth-failure state');
    return false;
  }
}

export function clearOAuthConnectionAuthFailure(
  userId: number,
  provider: UserScopedOAuthProvider,
): boolean {
  if (!validUserId(userId)) return false;
  try {
    const result = getDb().prepare(`
      DELETE FROM user_oauth_connection_health
      WHERE user_id = ? AND tenant_id = ? AND provider = ?
    `).run(userId, userId, provider);
    return Number(result.changes ?? 0) > 0;
  } catch (err) {
    // Allows token writes during a rolling transition before migration 272 is
    // visible to every process; the missing signal is logged and never faked.
    logger.debug({ err, userId, provider }, 'Could not clear scoped OAuth auth-failure state');
    return false;
  }
}

export function getOAuthConnectionAuthFailure(
  userId: number,
  provider: UserScopedOAuthProvider,
): OAuthConnectionAuthFailure | null {
  if (!validUserId(userId)) return null;
  try {
    const row = getDb().prepare(`
      SELECT provider, state, reason_code, first_detected_at, last_detected_at
      FROM user_oauth_connection_health
      WHERE user_id = ? AND tenant_id = ? AND provider = ?
    `).get(userId, userId, provider) as {
      provider: UserScopedOAuthProvider;
      state: 'auth_rejected';
      reason_code: OAuthAuthFailureReason;
      first_detected_at: string;
      last_detected_at: string;
    } | undefined;
    if (!row) return null;
    return {
      provider: row.provider,
      state: row.state,
      reasonCode: row.reason_code,
      firstDetectedAt: row.first_detected_at,
      lastDetectedAt: row.last_detected_at,
    };
  } catch (err) {
    logger.debug({ err, userId, provider }, 'Scoped OAuth auth-failure state unavailable');
    return null;
  }
}
