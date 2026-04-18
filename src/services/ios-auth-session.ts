// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { logAudit } from './audit-trail';
import { getStoredDailyCostLimitUsdForTier } from './plan-quotas';
import type { User } from './user-service';

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

  const db = getDb();
  db.prepare(`
    INSERT INTO ios_devices (user_id, device_id, device_name, push_token, refresh_token)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      user_id = excluded.user_id,
      device_name = excluded.device_name,
      push_token = excluded.push_token,
      refresh_token = excluded.refresh_token,
      last_active_at = datetime('now')
  `).run(input.userId, input.deviceId, input.deviceName, input.pushToken, refreshToken);

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
