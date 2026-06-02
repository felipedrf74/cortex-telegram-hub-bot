// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cost Guardrail — global daily spend monitoring and alerting + per-user cap.
 *
 * Checks total API spend for the day against configurable limits and
 * enforces a per-user daily cost cap. Call after each AI API call to fire
 * tier alerts; call before each AI call to enforce per-user caps.
 *
 * Telegram alerting fires at 50% / 80% / 100% of the global daily limit
 * (each tier fires once per UTC day).
 *
 * Per-user enforcement uses PER_USER_DAILY_USD_CAP env var (default $1.00).
 * The chat handler should reject requests with 429 when this returns over=true.
 */

import { getDb } from './database';
import { config } from '../config';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import {
  getEffectiveDailyCostLimitUsd,
  getUsageLevelForPlan,
  resolveBillingPlanForUser,
  type BillingPlan,
  type UsageLevel,
} from './plan-quotas';
import { recordOperatorAlert } from './operator-alerts';
import { getNexusPointBalance, listNexusPointPackages, usdToPoints } from './nexus-points';
import { getActiveUserAiBudgetOverride } from './ai-budget-overrides';

// ── Telegram Alert Callback ──────────────────────────────────────

type AlertCallback = (message: string) => Promise<void>;
let _alertFn: AlertCallback | null = null;

/** Register a Telegram alert sender. Called once during startup from index.ts. */
export function setCostAlertCallback(fn: AlertCallback): void {
  _alertFn = fn;
}

// Tier alert ratchet: each tier fires once per UTC day, then ratchets up
type AlertTier = 'none' | 'half' | 'warning' | 'critical';
let _lastAlertTier: AlertTier = 'none';
let _lastAlertDate: string = '';

function tierRank(t: AlertTier): number {
  return t === 'none' ? 0 : t === 'half' ? 1 : t === 'warning' ? 2 : 3;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Per-user cap (USD) ───────────────────────────────────────────
//
// Margin-safe daily cost caps derived from the current Gemini-heavy
// production mix. Local usage traces put routine assistant calls around
// ~$0.0007–$0.0023 and heavy content/deep-search calls around
// ~$0.0026–$0.0076. Caps are sized so that a fully-utilized month still
// leaves room for platform fees, support, retries, and provider mix drift.
//
//   Pro ($19.99/mo): $0.04/day × 30 = $1.20/mo AI COGS
//   Max ($24.99/mo): $0.06/day × 30 = $1.80/mo AI COGS
//
// Typical users should land materially below cap, especially because
// token-zero routes avoid AI spend entirely for deterministic lookups.
// No free tier — unsubscribed users are blocked from AI entirely.
const DEFAULT_DAILY_CAP_USD = Number(process.env.PER_USER_DAILY_USD_CAP || '0.00');

export interface DailyQuotaStatus {
  over: boolean;
  spentUsd: number;
  capUsd: number;
  plan: BillingPlan | string;
  usageLevel: UsageLevel;
  usageFraction: number;
  callsToday: number;
  boostAvailable: boolean;
  limitUsd: number;
  usedUsd: number;
  remainingUsd: number;
  planDailyLimitUsd: number;
  includedRemainingUsd: number;
  nexusPointsBalance: number;
  nexusPointsRemainingUsd: number;
  nexusPointsExpiringSoon: number;
  nexusPointsExpiringSoonUsd: number;
  nextCreditExpiryAt: string | null;
  totalRemainingUsd: number;
  pointsPurchaseAvailable: boolean;
  resetAt: string;
}

function getQuotaResetAt(now = new Date()): string {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  )).toISOString();
}

export function getDailyQuotaStatus(userId: number): DailyQuotaStatus {
  try {
    const db = getDb();
    const plan = resolveBillingPlanForUser(userId);
    const userOverride = getActiveUserAiBudgetOverride(userId);
    const capUsd = userOverride?.dailyCostUsd ?? getEffectiveDailyCostLimitUsd(plan as BillingPlan);
    const usageLevel = getUsageLevelForPlan(plan as BillingPlan);
    const nexusPoints = getNexusPointBalance(userId);

    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as calls
      FROM api_usage WHERE user_id = ? AND ts >= date('now')
    `).get(userId) as { total: number; calls: number };
    let debitedTodayUsd = 0;
    try {
      const debitRow = db.prepare(`
        SELECT COALESCE(SUM(usd_cost_debited), 0) AS debited
        FROM nexus_point_debits
        WHERE user_id = ? AND created_at >= date('now')
      `).get(userId) as { debited: number };
      debitedTodayUsd = debitRow.debited || 0;
    } catch {
      debitedTodayUsd = 0;
    }

    const includedRemainingUsd = capUsd > 0 ? Math.max(capUsd - row.total, 0) : 0;
    const unsettledOverageUsd = Math.max(row.total - capUsd - debitedTodayUsd, 0);
    const nexusPointsRemainingUsd = Math.max(nexusPoints.usdBalance - unsettledOverageUsd, 0);
    const nexusPointsRemaining = Math.max(nexusPoints.pointsBalance - usdToPoints(unsettledOverageUsd), 0);
    const totalRemainingUsd = includedRemainingUsd + nexusPointsRemainingUsd;
    const fraction = capUsd > 0 ? Math.min(row.total / capUsd, 1.0) : 1.0;
    const over = totalRemainingUsd <= 0 && row.total >= capUsd;
    const remainingUsd = Math.max(totalRemainingUsd, 0);
    const pointsPurchaseAvailable = plan === 'pro' || plan === 'max' || plan === 'beta';

    return {
      over,
      spentUsd: row.total,
      capUsd,
      plan,
      usageLevel,
      usageFraction: Math.round(fraction * 100) / 100,
      callsToday: row.calls,
      limitUsd: capUsd,
      usedUsd: row.total,
      remainingUsd,
      planDailyLimitUsd: capUsd,
      includedRemainingUsd,
      nexusPointsBalance: Math.round(nexusPointsRemaining * 1000) / 1000,
      nexusPointsRemainingUsd,
      nexusPointsExpiringSoon: nexusPoints.pointsExpiringSoon,
      nexusPointsExpiringSoonUsd: nexusPoints.usdExpiringSoon,
      nextCreditExpiryAt: nexusPoints.nextCreditExpiryAt,
      totalRemainingUsd,
      resetAt: getQuotaResetAt(),
      boostAvailable: pointsPurchaseAvailable,
      pointsPurchaseAvailable,
    };
  } catch {
    return {
      over: false, spentUsd: 0, capUsd: DEFAULT_DAILY_CAP_USD,
      plan: 'none', usageLevel: 'none', usageFraction: 0,
      callsToday: 0, boostAvailable: false,
      limitUsd: DEFAULT_DAILY_CAP_USD,
      usedUsd: 0,
      remainingUsd: DEFAULT_DAILY_CAP_USD,
      planDailyLimitUsd: DEFAULT_DAILY_CAP_USD,
      includedRemainingUsd: DEFAULT_DAILY_CAP_USD,
      nexusPointsBalance: 0,
      nexusPointsRemainingUsd: 0,
      nexusPointsExpiringSoon: 0,
      nexusPointsExpiringSoonUsd: 0,
      nextCreditExpiryAt: null,
      totalRemainingUsd: DEFAULT_DAILY_CAP_USD,
      pointsPurchaseAvailable: false,
      resetAt: getQuotaResetAt(),
    };
  }
}

export function buildQuotaExceededMessage(quota: Pick<DailyQuotaStatus, 'plan' | 'limitUsd' | 'resetAt' | 'pointsPurchaseAvailable'>): string {
  if (quota.plan === 'free' || quota.limitUsd <= 0) {
    return 'AI access is not available on the free plan. Upgrade to Pro or Max to continue.';
  }

  const points = quota.pointsPurchaseAvailable ? ' Buy Nexus Points for more AI usage, or wait for the daily reset.' : '';
  return `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.${points}`;
}

export function buildQuotaUsagePayload(quota: DailyQuotaStatus): Record<string, unknown> {
  const usageFraction = Math.max(0, Math.min(1, quota.usageFraction));
  return {
    plan: quota.plan,
    resetAt: quota.resetAt,
    usageLevel: quota.usageLevel,
    usageFraction,
    usagePercent: Math.round(usageFraction * 100),
    isOverLimit: quota.over,
    boostAvailable: quota.boostAvailable,
    nexusPointsBalance: quota.nexusPointsBalance,
    nexusPointsExpiringSoon: quota.nexusPointsExpiringSoon,
    nextCreditExpiryAt: quota.nextCreditExpiryAt,
    pointsPurchaseAvailable: quota.pointsPurchaseAvailable,
    nexusPointPackages: listNexusPointPackages().map((pkg) => ({
      productId: pkg.productId,
      label: pkg.label,
      points: pkg.points,
    })),
  };
}

export function buildQuotaExceededPayload(quota: DailyQuotaStatus): Record<string, unknown> {
  return buildQuotaUsagePayload(quota);
}

export type CostGuardrailDecision =
  | {
      block: false;
      status: 200;
      reason: 'ok';
      global: ReturnType<typeof checkGlobalCostGuardrail>;
      quota: DailyQuotaStatus;
    }
  | {
      block: true;
      status: 429;
      reason: 'SERVICE_DEGRADED';
      message: string;
      global: ReturnType<typeof checkGlobalCostGuardrail>;
      quota: DailyQuotaStatus;
      details: Record<string, unknown>;
    }
  | {
      block: true;
      status: 429;
      reason: 'daily_limit_exceeded';
      message: string;
      global: ReturnType<typeof checkGlobalCostGuardrail>;
      quota: DailyQuotaStatus;
      details: Record<string, unknown>;
    };

/**
 * Check global daily spend against configured limits.
 * Sends Telegram alerts at 50% / 80% / 100% (each fires once per UTC day).
 * Returns the current daily spend.
 */
export function checkGlobalCostGuardrail(): { totalUsd: number; limitUsd: number; exceeded: boolean } {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM api_usage WHERE ts >= date('now')
    `).get() as { total: number };

    const limit = config.aiSafety.globalDailyLimitUsd;
    const half = limit * 0.5;
    const warning = limit * config.aiSafety.alertThresholdPercent; // default 0.80

    // Reset ratchet on new UTC day
    const today = todayKey();
    if (today !== _lastAlertDate) {
      _lastAlertTier = 'none';
      _lastAlertDate = today;
    }

    // Determine current tier based on spend
    let currentTier: AlertTier = 'none';
    if (row.total >= limit) currentTier = 'critical';
    else if (row.total >= warning) currentTier = 'warning';
    else if (row.total >= half) currentTier = 'half';

    // Fire alert if we crossed UP a tier today (won't re-fire same tier)
    if (tierRank(currentTier) > tierRank(_lastAlertTier)) {
      const pct = Math.round((row.total / limit) * 100);
      const icon = currentTier === 'critical' ? '🔴' : currentTier === 'warning' ? '🟠' : '🟡';
      const verb = currentTier === 'critical' ? 'REACHED' : 'crossed';
      logger.warn(
        { total: row.total, limit, tier: currentTier },
        `Cost guardrail tier ${currentTier} ${verb}`,
      );
      recordOperatorAlert({
        severity: currentTier === 'critical' ? 'critical' : 'warning',
        source: 'cost_guardrail',
        dedupeKey: `cost:${today}:${currentTier}`,
        title: `AI cost ${verb.toLowerCase()} ${pct}%`,
        detail: `Daily AI spend is $${row.total.toFixed(4)} of $${limit.toFixed(2)}.`,
        owner: 'ops',
        suspectedArea: 'ai_cost',
        userImpact: currentTier === 'critical'
          ? 'The global AI cost guardrail has been reached; AI-backed flows may be blocked or degraded.'
          : 'AI spend is elevated and should be checked before it affects beta usage.',
        runbookUrl: 'docs/OBSERVABILITY-ONCALL.md#cost-guardrail-alerts',
        metadata: {
          totalUsd: row.total,
          limitUsd: limit,
          percentOfLimit: pct,
          tier: currentTier,
        },
      });
      if (_alertFn) {
        const msg =
          `${icon} <b>AI cost ${verb}</b>\n\n` +
          `Today: <code>$${row.total.toFixed(4)}</code> / $${limit.toFixed(2)} (${pct}%)\n` +
          `Tier: <b>${currentTier}</b>`;
        // Fire-and-forget — never cascade alert failures
        _alertFn(msg).catch(() => { /* swallow */ });
      }
      _lastAlertTier = currentTier;
    }

    return { totalUsd: row.total, limitUsd: limit, exceeded: row.total >= limit };
  } catch {
    return { totalUsd: 0, limitUsd: config.aiSafety.globalDailyLimitUsd, exceeded: false };
  }
}

export function isUserOverDailyCap(userId: number): DailyQuotaStatus {
  return getDailyQuotaStatus(userId);
}

export function enforceCostGuardrails(userId: number): CostGuardrailDecision {
  const global = checkGlobalCostGuardrail();
  const quota = isUserOverDailyCap(userId);

  if (global.exceeded) {
    return {
      block: true,
      status: 429,
      reason: 'SERVICE_DEGRADED',
      message: 'AI-backed features are temporarily degraded because the workspace daily AI budget has been reached. Token-zero reads remain available.',
      global,
      quota,
      details: {
        serviceDegraded: true,
        ...buildQuotaExceededPayload(quota),
      },
    };
  }

  if (quota.over) {
    return {
      block: true,
      status: 429,
      reason: 'daily_limit_exceeded',
      message: buildQuotaExceededMessage(quota),
      global,
      quota,
      details: {
        ...buildQuotaExceededPayload(quota),
      },
    };
  }

  return {
    block: false,
    status: 200,
    reason: 'ok',
    global,
    quota,
  };
}

// ── Per-user check+spend mutex ───────────────────────────────────
//
// TOCTOU fix (hardening audit follow-up 2026-04-21 pass 2):
//
// Before this mutex, concurrent requests from the same user could
// both pass `isUserOverDailyCap` BEFORE either one wrote its
// `api_usage` row. Example on Free ($0.005/day) with $0.002/call:
//
//   req A: isUserOverDailyCap → over=false (spent=0)
//   req B: isUserOverDailyCap → over=false (spent=0) ← race!
//   req A: AI call completes, writes $0.002 (spent=0.002)
//   req B: AI call completes, writes $0.002 (spent=0.004) ✓
//   req C: (fresh request)    → over=false (spent=0.004)
//   req C: writes $0.002 (spent=0.006)  ← exceeds cap $0.005
//
// The mutex serializes check+spend PER USER so any pending AI call completes
// and writes its usage row before the next one checks the cap. Because PM2 can
// run multiple Node processes, the lock is SQLite-backed instead of a
// process-local Map. If SQLite locking is unavailable, callers fail closed.

const SQLITE_COST_LOCK_TTL_MS = 120_000;
const SQLITE_COST_LOCK_WAIT_MS = 30_000;
const SQLITE_COST_LOCK_POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryGetCostLockDb(): ReturnType<typeof getDb> | null {
  try {
    return getDb() ?? null;
  } catch {
    return null;
  }
}

function ensureCostLockTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_guardrail_locks (
      lock_key TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      acquired_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
  `);
}

async function acquireSqliteUserCostLock(userId: number): Promise<(() => void) | null> {
  const db = tryGetCostLockDb();
  if (!db) {
    throw new Error('COST_GUARDRAIL_LOCK_UNAVAILABLE');
  }

  ensureCostLockTable(db);
  const lockKey = `user:${userId}`;
  const ownerToken = crypto.randomUUID();
  const startedAt = Date.now();

  while (Date.now() - startedAt < SQLITE_COST_LOCK_WAIT_MS) {
    const nowMs = Date.now();
    db.prepare('DELETE FROM cost_guardrail_locks WHERE lock_key = ? AND expires_at_ms <= ?')
      .run(lockKey, nowMs);
    const result = db.prepare(`
      INSERT OR IGNORE INTO cost_guardrail_locks (lock_key, owner_token, acquired_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(lockKey, ownerToken, nowMs, nowMs + SQLITE_COST_LOCK_TTL_MS);
    if (result.changes > 0) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          db.prepare('DELETE FROM cost_guardrail_locks WHERE lock_key = ? AND owner_token = ?')
            .run(lockKey, ownerToken);
        } catch (err) {
          logger.warn({ err, userId }, 'Cost guardrail SQLite lock release failed');
        }
      };
    }
    await sleep(SQLITE_COST_LOCK_POLL_MS);
  }

  throw new Error(`COST_GUARDRAIL_LOCK_TIMEOUT: ${lockKey}`);
}

/**
 * Run `fn` with exclusive per-user ordering against any other
 * `withUserCostLock(userId, ...)` call. Serialized within a user,
 * concurrent across users. Safe to nest only if all nested calls use
 * DIFFERENT userIds — same-user re-entry deadlocks.
 *
 * The lock survives `fn` throwing; errors bubble to the caller and
 * the chain advances to the next waiter.
 *
 * Callers should wrap the ENTIRE check+AI-call+record boundary:
 *
 *   await withUserCostLock(userId, async () => {
 *     const cap = isUserOverDailyCap(userId);
 *     if (cap.over) { return send402(); }
 *     await callAI();                    // writes api_usage inside
 *   });
 */
export async function withUserCostLock<T>(
  userId: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(userId) || userId <= 0) {
    // Invalid userId → no lock (the route will 401 anyway). This is
    // belt-and-suspenders: we never want a bad userId to queue behind
    // a real user's request.
    return fn();
  }
  const releaseSqliteLock = await acquireSqliteUserCostLock(userId);
  try {
    return await fn();
  } finally {
    releaseSqliteLock?.();
  }
}

/**
 * Explicit-release variant for route handlers that would prefer a
 * try/finally pattern over the callback form. Returns a `release()`
 * function that MUST be called exactly once (in `finally`) to advance
 * the chain. Calling it more than once is a no-op; failing to call it
 * leaves every subsequent same-user request hanging until the process
 * restarts.
 *
 *   const releaseCostLock = await acquireCostLock(userId);
 *   try {
 *     const cap = isUserOverDailyCap(userId);
 *     if (cap.over) return send402();
 *     await callAI();   // writes api_usage inside the lock window
 *   } finally {
 *     releaseCostLock();
 *   }
 */
export async function acquireCostLock(userId: number): Promise<() => void> {
  if (!Number.isFinite(userId) || userId <= 0) {
    return () => { /* no-op for invalid userId */ };
  }
  const releaseSqliteLock = await acquireSqliteUserCostLock(userId);
  return releaseSqliteLock ?? (() => { /* unreachable; acquire throws on unavailable DB */ });
}

/** Test-only: drop every in-flight per-user lock. */
export function _resetUserCostLocksForTests(): void {
  // Kept for backwards-compatible tests; SQLite lock rows are released by
  // test DB teardown or explicit release functions.
}

/**
 * Get daily spend for a specific user (for portal display).
 */
export function getUserDailySpend(userId: number): { totalUsd: number; messageCount: number } {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as count
      FROM api_usage
      WHERE user_id = ? AND ts >= date('now')
    `).get(userId) as { total: number; count: number };
    return { totalUsd: row.total, messageCount: row.count };
  } catch {
    return { totalUsd: 0, messageCount: 0 };
  }
}

/**
 * Get today's spend breakdown by provider.
 * Returns: { anthropic: number, openai: number, gemini: number }
 */
export function getSpendByProvider(
  date?: string,
  scope: { userId?: number | null; tenantId?: number | null } = {},
): Record<string, number> {
  try {
    const db = getDb();
    // Use parameterized query to prevent SQL injection
    const filterDate = date || new Date().toISOString().slice(0, 10);
    const predicates = ['ts >= date(?)'];
    const params: any[] = [filterDate];
    if (scope.userId != null) {
      predicates.push('user_id = ?');
      params.push(scope.userId);
    }
    if (scope.tenantId != null) {
      predicates.push('tenant_id = ?');
      params.push(scope.tenantId);
    }
    const rows = db.prepare(`
      SELECT COALESCE(provider, 'anthropic') as provider, COALESCE(SUM(cost_usd), 0) as total
      FROM api_usage
      WHERE ${predicates.join(' AND ')}
      GROUP BY provider
    `).all(...params) as { provider: string; total: number }[];

    const result: Record<string, number> = { anthropic: 0, openai: 0, gemini: 0, ollama: 0 };
    for (const row of rows) {
      result[row.provider] = row.total;
    }
    return result;
  } catch {
    return { anthropic: 0, openai: 0, gemini: 0, ollama: 0 };
  }
}
