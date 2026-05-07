// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Small resource-budget / circuit-breaker helper.
 *
 * Counters are keyed by tenant/user and a fixed window. This is intentionally
 * modest: enough to cap expensive loops without adding a new dependency.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { logger } from '../utils/logger';

export interface BudgetCheckInput {
  tenantId: number;
  userId?: number | null;
  budgetKey: string;
  limit: number;
  windowSeconds: number;
  increment?: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  budgetKey: string;
  count: number;
  limit: number;
  resetAt: string;
  degradedReason?: string;
}

export function ensureResourceBudgetTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_budget_counters (
      counter_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER,
      budget_key TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_seconds INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_budget_unique
      ON resource_budget_counters(tenant_id, COALESCE(user_id, 0), budget_key, window_start);
    CREATE INDEX IF NOT EXISTS idx_resource_budget_scope
      ON resource_budget_counters(tenant_id, user_id, budget_key, window_start);
  `);
}

export function consumeResourceBudget(input: BudgetCheckInput, db?: Database.Database): BudgetCheckResult {
  assertBudgetScope(input);
  let database = db;
  if (!database) {
    try {
      database = getDb();
    } catch (err) {
      if (err instanceof Error && err.message.includes('Database not initialized')) {
        return failOpenWhenDatabaseUnavailable(input);
      }
      throw err;
    }
  }
  ensureResourceBudgetTables(database);
  const increment = Math.max(1, Math.floor(input.increment ?? 1));
  const limit = Math.max(1, Math.floor(input.limit));
  const windowSeconds = Math.max(1, Math.floor(input.windowSeconds));
  const windowStartEpoch = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000;
  const windowStart = new Date(windowStartEpoch).toISOString();
  const resetAt = new Date(windowStartEpoch + windowSeconds * 1000).toISOString();
  const counterId = budgetCounterId(input.tenantId, input.userId ?? null, input.budgetKey, windowStart);
  const userScope = input.userId ?? null;

  database.prepare(`
    INSERT OR IGNORE INTO resource_budget_counters (
      counter_id, tenant_id, user_id, budget_key, window_start, window_seconds, count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `).run(counterId, input.tenantId, userScope, input.budgetKey, windowStart, windowSeconds);

  const updated = database.prepare(`
    UPDATE resource_budget_counters
    SET count = count + ?,
        updated_at = datetime('now')
    WHERE counter_id = ?
      AND count + ? <= ?
    RETURNING count
  `).get(increment, counterId, increment, limit) as { count: number } | undefined;

  const result = updated
    ? { count: Number(updated.count), allowed: true }
    : {
        allowed: false,
        count: Number((database.prepare('SELECT count FROM resource_budget_counters WHERE counter_id = ?')
          .get(counterId) as { count: number } | undefined)?.count ?? 0),
      };
  if (!result.allowed) {
    logger.warn(
      {
        tenantId: input.tenantId,
        userId: userScope,
        budgetKey: input.budgetKey,
        count: result.count,
        limit,
        resetAt,
      },
      'resource_budget_exceeded',
    );
  }
  return {
    allowed: result.allowed,
    budgetKey: input.budgetKey,
    count: result.count,
    limit,
    resetAt,
    degradedReason: result.allowed ? undefined : 'resource_budget_exceeded',
  };
}

function failOpenWhenDatabaseUnavailable(input: BudgetCheckInput): BudgetCheckResult {
  const windowSeconds = Math.max(1, Math.floor(input.windowSeconds));
  const windowStartEpoch = Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000;
  return {
    allowed: true,
    budgetKey: input.budgetKey,
    count: 0,
    limit: Math.max(1, Math.floor(input.limit)),
    resetAt: new Date(windowStartEpoch + windowSeconds * 1000).toISOString(),
  };
}

export function capSyncPageSize(rawLimit: unknown): number {
  const parsed = typeof rawLimit === 'string'
    ? Number.parseInt(rawLimit, 10)
    : typeof rawLimit === 'number'
      ? rawLimit
      : 100;
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(Math.floor(parsed), 200));
}

function assertBudgetScope(input: BudgetCheckInput): void {
  if (!isValidTenantUserId(input.tenantId)) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation: 'resource_budget',
      reason: 'invalid_user_scope',
      userId: typeof input.tenantId === 'number' ? input.tenantId : null,
      details: { budgetKey: input.budgetKey },
    });
    throw new Error('tenantId required: must be a positive integer');
  }
  if (input.userId != null && !isValidTenantUserId(input.userId)) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation: 'resource_budget',
      reason: 'invalid_user_scope',
      userId: typeof input.userId === 'number' ? input.userId : null,
      details: { budgetKey: input.budgetKey },
    });
    throw new Error('userId required: must be a positive integer when provided');
  }
}

function budgetCounterId(tenantId: number, userId: number | null, budgetKey: string, windowStart: string): string {
  const hash = createHash('sha256')
    .update(`${tenantId}:${userId ?? 0}:${budgetKey}:${windowStart}`)
    .digest('hex')
    .slice(0, 32);
  return `budget_${hash}`;
}
