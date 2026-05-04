// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { logAudit } from './audit-trail';
import { getStoredDailyCostLimitUsdForTier } from './plan-quotas';
import type { User } from './user-service';

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
  const accessToken = jwt.sign(
    { userId: input.userId, deviceId: input.deviceId },
    config.ios.jwtSecret,
    { expiresIn: '7d' as any },
  );
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

  try {
    const userRow = db.prepare('SELECT email FROM users WHERE id = ?').get(input.userId) as { email: string } | undefined;
    if (userRow?.email) {
      const { getFounderPlan, syncFounderSubscription } = require('./founders');
      const founderPlan = getFounderPlan(userRow.email);
      if (founderPlan) {
        syncFounderSubscription(userRow.email, founderPlan);
        logger.info({ userId: input.userId, email: userRow.email, plan: founderPlan }, 'Founder subscription granted on registration');
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
    },
  };
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
