// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { logAudit } from './audit-trail';
import { getStoredDailyCostLimitUsdForTier } from './plan-quotas';
import type { User } from './user-service';
import { signIosJwt } from './ios-jwt';

// AUTH-O4 (closed-beta-auth-hardening, 2026-05-04): refresh-token at-rest
// hashing. The plaintext token leaves the server exactly once (returned
// to iOS in the auth response). The DB stores only the SHA-256 hash.
//
// Active hash: matches the currently-issued refresh token.
// Previous hash: the one we just rotated AWAY from, kept for theft
// detection (if a refresh attempt arrives bearing the previous-only
// hash, the legitimate client already has the new one — only an
// attacker would still be presenting the old one).
//
// SHA-256 (NOT bcrypt) because:
//   - O(1) lookup by hash via index.
//   - 512-bit token entropy (64 bytes hex = 128 chars) makes bcrypt's
//     cost factor irrelevant.
//   - Constant-time-friendly integer compare.
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface AuthSessionPayload {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: number;
    firstName: string;
    lastName?: string;
    language: string;
    /**
     * AUTH-O2 follow-up (2026-05-04). Returning these on every
     * register/login response (not only on `/auth/me`) means the
     * iOS app can drive the post-registration email-verification
     * sheet without an extra round-trip. Existing iOS clients
     * ignore unknown fields per the iOS DTO standard, so this is
     * a purely additive change.
     */
    email?: string;
    emailVerified?: boolean;
    authProvider?: string;
  };
}

interface CreateAuthSessionInput {
  userId: number;
  deviceId: string;
  deviceName: string | null;
  pushToken: string | null;
  user: {
    first_name?: string | null;
    last_name?: string | null;
    language?: string;
  };
  ipAddress?: string;
}

export function createAuthSessionAndRegisterDevice(input: CreateAuthSessionInput): AuthSessionPayload {
  const accessToken = signIosJwt({ userId: input.userId, deviceId: input.deviceId });
  const refreshToken = crypto.randomBytes(64).toString('hex');
  const refreshTokenHash = hashRefreshToken(refreshToken);

  const db = getDb();
  // AUTH-O4: write hash to refresh_token_hash; clear plaintext column
  // and previous_refresh_token_hash on a fresh session/registration
  // (no theft-detection lineage when registering a new device row).
  db.prepare(`
    INSERT INTO ios_devices (
      user_id, device_id, device_name, push_token,
      refresh_token, refresh_token_hash, previous_refresh_token_hash
    )
    VALUES (?, ?, ?, ?, NULL, ?, NULL)
    ON CONFLICT(device_id) DO UPDATE SET
      user_id = excluded.user_id,
      device_name = excluded.device_name,
      push_token = excluded.push_token,
      refresh_token = NULL,
      refresh_token_hash = excluded.refresh_token_hash,
      previous_refresh_token_hash = NULL,
      last_active_at = datetime('now')
  `).run(input.userId, input.deviceId, input.deviceName, input.pushToken, refreshTokenHash);

  // AUTH-O2 follow-up (2026-05-04): also pull email_verified +
  // auth_provider so the registration response can carry them.
  // Without these, a freshly-registered email user has no
  // `emailVerified` flag locally until their NEXT app launch
  // (when AuthManager fires /auth/me rehydration), which means
  // the post-registration email-verification sheet wouldn't
  // present until the second cold launch. The values are
  // optional in the response shape and older iOS clients ignore
  // unknown fields by contract.
  let registeredUserEmail: string | undefined;
  let registeredUserEmailVerified: boolean | undefined;
  let registeredUserAuthProvider: string | undefined;
  try {
    const userRow = db
      .prepare(
        'SELECT email, email_verified AS emailVerified, auth_provider AS authProvider FROM users WHERE id = ?',
      )
      .get(input.userId) as
        | { email: string | null; emailVerified: number | null; authProvider: string | null }
        | undefined;
    if (userRow) {
      registeredUserEmail = userRow.email ?? undefined;
      registeredUserEmailVerified =
        typeof userRow.emailVerified === 'number'
          ? Boolean(userRow.emailVerified)
          : undefined;
      registeredUserAuthProvider = userRow.authProvider ?? undefined;
    }
    if (registeredUserEmail) {
      const { getFounderPlan, syncFounderSubscription } = require('./founders');
      const founderPlan = getFounderPlan(registeredUserEmail);
      if (founderPlan) {
        syncFounderSubscription(registeredUserEmail, founderPlan);
        logger.info({ userId: input.userId, email: registeredUserEmail, plan: founderPlan }, 'Founder subscription granted on registration');
      }
    }
  } catch { /* founders table may not exist yet */ }

  logAudit({
    userId: input.userId,
    actorId: input.userId,
    action: 'access',
    resource: 'auth.register',
    details: {
      deviceId: input.deviceId,
      deviceName: input.deviceName,
    },
    ipAddress: input.ipAddress,
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: 604800,
    user: {
      id: input.userId,
      firstName: input.user.first_name || 'User',
      lastName: input.user.last_name || undefined,
      language: input.user.language || 'en',
      // AUTH-O2 follow-up (2026-05-04): purely additive fields.
      // Older iOS builds ignore them by contract; newer builds
      // use them to drive the post-registration verification
      // gate without an extra /auth/me round-trip.
      email: registeredUserEmail,
      emailVerified: registeredUserEmailVerified,
      authProvider: registeredUserAuthProvider,
    },
  };
}

export function backfillLegacyRefreshTokenHashes(): { inspectedRows: number; hashedRows: number; clearedPlaintextRows: number } {
  const db = getDb();
  const columns = db.prepare(`PRAGMA table_info(ios_devices)`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('refresh_token') || !names.has('refresh_token_hash')) {
    return { inspectedRows: 0, hashedRows: 0, clearedPlaintextRows: 0 };
  }

  const rows = db.prepare(`
    SELECT id, refresh_token, refresh_token_hash
    FROM ios_devices
    WHERE refresh_token IS NOT NULL
      AND refresh_token != ''
  `).all() as Array<{ id: number; refresh_token: string; refresh_token_hash: string | null }>;

  let hashedRows = 0;
  let clearedPlaintextRows = 0;
  const updateWithHash = db.prepare(`
    UPDATE ios_devices
       SET refresh_token_hash = ?,
           refresh_token = NULL
     WHERE id = ?
       AND refresh_token = ?
  `);
  const clearPlaintext = db.prepare(`
    UPDATE ios_devices
       SET refresh_token = NULL
     WHERE id = ?
       AND refresh_token = ?
  `);

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!row.refresh_token_hash) {
        const result = updateWithHash.run(hashRefreshToken(row.refresh_token), row.id, row.refresh_token);
        if (result.changes === 1) {
          hashedRows += 1;
          clearedPlaintextRows += 1;
        }
      } else {
        const result = clearPlaintext.run(row.id, row.refresh_token);
        if (result.changes === 1) clearedPlaintextRows += 1;
      }
    }
  });
  tx();

  return { inspectedRows: rows.length, hashedRows, clearedPlaintextRows };
}

export function grantBetaSandboxAccess(userId: number): void {
  const db = getDb();
  const periodStart = new Date().toISOString();
  const periodEnd = new Date(Date.now() + (365 * 24 * 60 * 60 * 1000)).toISOString();

  db.prepare(`
    UPDATE users
    SET tier = 'max',
        status = 'active',
        auth_provider = 'invite_code',
        daily_cost_limit_usd = CASE
          WHEN daily_cost_limit_usd < ? THEN ?
          ELSE daily_cost_limit_usd
        END
    WHERE id = ?
  `).run(
    getStoredDailyCostLimitUsdForTier('max'),
    getStoredDailyCostLimitUsdForTier('max'),
    userId,
  );

  db.prepare(`
    INSERT INTO subscriptions (
      user_id,
      plan,
      period,
      status,
      provider,
      current_period_start,
      current_period_end,
      updated_at
    )
    VALUES (?, 'max', 'yearly', 'trialing', 'none', ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      period = excluded.period,
      status = excluded.status,
      provider = excluded.provider,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      updated_at = datetime('now')
  `).run(userId, periodStart, periodEnd);
}
