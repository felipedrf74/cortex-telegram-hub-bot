// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';

export interface UserAiBudgetOverride {
  userId: number;
  dailyCostUsd: number;
  monthlyCostUsd: number | null;
  reason: string | null;
  expiresAt: string | null;
}

export function getActiveUserAiBudgetOverride(userId: number, now = new Date()): UserAiBudgetOverride | null {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  try {
    const row = getDb().prepare(`
      SELECT user_id, daily_cost_usd, monthly_cost_usd, reason, expires_at
      FROM user_ai_budget_overrides
      WHERE user_id = ?
        AND active = 1
        AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(userId, now.toISOString()) as {
      user_id: number;
      daily_cost_usd: number;
      monthly_cost_usd: number | null;
      reason: string | null;
      expires_at: string | null;
    } | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      dailyCostUsd: row.daily_cost_usd,
      monthlyCostUsd: row.monthly_cost_usd,
      reason: row.reason,
      expiresAt: row.expires_at,
    };
  } catch {
    try {
      const row = getDb().prepare(`
        SELECT user_id, daily_cost_usd, reason, expires_at
        FROM user_ai_budget_overrides
        WHERE user_id = ?
          AND active = 1
          AND (expires_at IS NULL OR datetime(expires_at) > datetime(?))
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(userId, now.toISOString()) as {
        user_id: number;
        daily_cost_usd: number;
        reason: string | null;
        expires_at: string | null;
      } | undefined;
      return row ? {
        userId: row.user_id,
        dailyCostUsd: row.daily_cost_usd,
        monthlyCostUsd: null,
        reason: row.reason,
        expiresAt: row.expires_at,
      } : null;
    } catch {
      return null;
    }
  }
}

export function setUserAiBudgetOverride(input: {
  userId: number;
  dailyCostUsd: number;
  monthlyCostUsd?: number | null;
  reason?: string | null;
  expiresAt?: string | null;
  updatedBy?: number | null;
}): void {
  if (!Number.isFinite(input.userId) || input.userId <= 0) throw new Error('userId must be positive');
  if (!Number.isFinite(input.dailyCostUsd) || input.dailyCostUsd < 0) throw new Error('dailyCostUsd must be non-negative');
  if (input.monthlyCostUsd != null && (!Number.isFinite(input.monthlyCostUsd) || input.monthlyCostUsd < 0)) {
    throw new Error('monthlyCostUsd must be null or non-negative');
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO user_ai_budget_overrides (user_id, daily_cost_usd, monthly_cost_usd, reason, expires_at, active, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      daily_cost_usd = excluded.daily_cost_usd,
      monthly_cost_usd = COALESCE(excluded.monthly_cost_usd, user_ai_budget_overrides.monthly_cost_usd),
      reason = excluded.reason,
      expires_at = excluded.expires_at,
      active = 1,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).run(
    input.userId,
    input.dailyCostUsd,
    input.monthlyCostUsd ?? null,
    input.reason ?? null,
    input.expiresAt ?? null,
    input.updatedBy ?? null,
  );
  // undefined means "leave the existing monthly override unchanged";
  // explicit null means "clear it and fall back to the plan monthly cap".
  if (input.monthlyCostUsd === null) {
    db.prepare(`
      UPDATE user_ai_budget_overrides
      SET monthly_cost_usd = NULL, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(input.userId);
  }
}

export function clearUserAiBudgetOverride(userId: number, updatedBy?: number | null): void {
  if (!Number.isFinite(userId) || userId <= 0) return;
  try {
    getDb().prepare(`
      UPDATE user_ai_budget_overrides
      SET active = 0, updated_by = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(updatedBy ?? null, userId);
  } catch {
    // Older DBs without the migration should not break admin limit updates.
  }
}
