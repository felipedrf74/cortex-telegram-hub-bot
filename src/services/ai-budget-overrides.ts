// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';

export interface UserAiBudgetOverride {
  userId: number;
  dailyCostUsd: number;
  reason: string | null;
  expiresAt: string | null;
}

export function getActiveUserAiBudgetOverride(userId: number, now = new Date()): UserAiBudgetOverride | null {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  try {
    const row = getDb().prepare(`
      SELECT user_id, daily_cost_usd, reason, expires_at
      FROM user_ai_budget_overrides
      WHERE user_id = ?
        AND active = 1
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(userId, now.toISOString()) as {
      user_id: number;
      daily_cost_usd: number;
      reason: string | null;
      expires_at: string | null;
    } | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      dailyCostUsd: row.daily_cost_usd,
      reason: row.reason,
      expiresAt: row.expires_at,
    };
  } catch {
    return null;
  }
}

export function setUserAiBudgetOverride(input: {
  userId: number;
  dailyCostUsd: number;
  reason?: string | null;
  expiresAt?: string | null;
  updatedBy?: number | null;
}): void {
  if (!Number.isFinite(input.userId) || input.userId <= 0) throw new Error('userId must be positive');
  if (!Number.isFinite(input.dailyCostUsd) || input.dailyCostUsd < 0) throw new Error('dailyCostUsd must be non-negative');
  const db = getDb();
  db.prepare(`
    INSERT INTO user_ai_budget_overrides (user_id, daily_cost_usd, reason, expires_at, active, updated_by, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      daily_cost_usd = excluded.daily_cost_usd,
      reason = excluded.reason,
      expires_at = excluded.expires_at,
      active = 1,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).run(
    input.userId,
    input.dailyCostUsd,
    input.reason ?? null,
    input.expiresAt ?? null,
    input.updatedBy ?? null,
  );
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
