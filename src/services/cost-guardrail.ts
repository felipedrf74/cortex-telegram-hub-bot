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
import {
  getEffectiveDailyCostLimitUsd,
  getUsageLevelForPlan,
  type BillingPlan,
  type UsageLevel,
} from './plan-quotas';
import { isOwnerUserRef } from './user-service';
import { recordOperatorAlert } from './operator-alerts';

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
//   Pro ($25/mo): $0.20/day × 30 = $6.00/mo AI COGS
//   Max ($45/mo): $0.60/day × 30 = $18.00/mo AI COGS
//
// Typical users should land materially below cap, especially because
// token-zero routes avoid AI spend entirely for deterministic lookups.
// No free tier — unsubscribed users are blocked from AI entirely.
const DEFAULT_DAILY_CAP_USD = parseFloat(process.env.PER_USER_DAILY_USD_CAP || '0.00');

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

function resolvePlanFromSubscriptionState(userId: number): BillingPlan {
  const db = getDb();

  if (!config.billing.paywallEnabled) {
    return 'beta';
  }

  let isOwner = isOwnerUserRef(userId);
  let userTier: string | null = null;

  if (!isOwner) {
    try {
      const user = db.prepare(
        'SELECT telegram_id, tier FROM users WHERE id = ?'
      ).get(userId) as { telegram_id: number | null; tier: string | null } | undefined;
      userTier = user?.tier ?? null;
      if (user?.tier === 'owner') {
        isOwner = true;
      }
    } catch {
      userTier = null;
    }
  }

  if (isOwner) {
    return 'owner';
  }

  try {
    const sub = db.prepare(
      'SELECT plan, status FROM subscriptions WHERE user_id = ?'
    ).get(userId) as { plan: string; status: string } | undefined;

    if (sub && ['active', 'trialing'].includes(sub.status) && (sub.plan === 'pro' || sub.plan === 'max')) {
      return sub.plan;
    }
  } catch {
    // Fall back to the users table below.
  }

  if (userTier === 'max') return 'max';
  if (userTier === 'pro') return 'pro';

  return 'free';
}

export function getDailyQuotaStatus(userId: number): DailyQuotaStatus {
  try {
    const db = getDb();
    const plan = resolvePlanFromSubscriptionState(userId);
    const capUsd = getEffectiveDailyCostLimitUsd(plan as BillingPlan);
    const usageLevel = getUsageLevelForPlan(plan as BillingPlan);

    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as calls
      FROM api_usage WHERE user_id = ? AND ts >= date('now')
    `).get(userId) as { total: number; calls: number };

    const fraction = capUsd > 0 ? Math.min(row.total / capUsd, 1.0) : 1.0;
    const over = capUsd <= 0 ? true : row.total >= capUsd;
    const remainingUsd = capUsd > 0 ? Math.max(capUsd - row.total, 0) : 0;

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
      resetAt: getQuotaResetAt(),
      // AI Boost IAP product not yet configured in App Store Connect.
      // Setting false hides the CTA button in the iOS usage meter.
      // Re-enable when the product is live: row.total >= capUsd && plan !== 'owner'
      boostAvailable: false,
    };
  } catch {
    return {
      over: false, spentUsd: 0, capUsd: DEFAULT_DAILY_CAP_USD,
      plan: 'none', usageLevel: 'none', usageFraction: 0,
      callsToday: 0, boostAvailable: false,
      limitUsd: DEFAULT_DAILY_CAP_USD,
      usedUsd: 0,
      remainingUsd: DEFAULT_DAILY_CAP_USD,
      resetAt: getQuotaResetAt(),
    };
  }
}

export function buildQuotaExceededMessage(quota: Pick<DailyQuotaStatus, 'plan' | 'limitUsd' | 'resetAt'>): string {
  if (quota.plan === 'free' || quota.limitUsd <= 0) {
    return 'AI access is not available on the free plan. Upgrade to Pro or Max to continue.';
  }

  return `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`;
}

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
// The mutex serializes check+spend PER USER so any pending AI call
// completes (and writes its usage row) before the next one checks
// the cap. Across users, execution is still concurrent.
//
// Implementation: a Map<userId, Promise> where each new caller
// chains on the previous tail. Node's single-threaded event loop
// makes this lock-free; the replace-then-await ordering guarantees
// no two callers can observe an empty chain concurrently.

const userCostLocks = new Map<number, Promise<unknown>>();

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
  const prior = userCostLocks.get(userId) ?? Promise.resolve();
  // Swallow prior errors — a previous caller's failure must not chain-
  // fail the next caller. We care only about ordering, not outcome.
  const next = prior.catch(() => { /* swallow */ }).then(fn);
  userCostLocks.set(userId, next);
  try {
    return await next;
  } finally {
    // Clean up the entry only if no one chained onto us while we ran.
    if (userCostLocks.get(userId) === next) {
      userCostLocks.delete(userId);
    }
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
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const prior = userCostLocks.get(userId) ?? Promise.resolve();
  const next = prior.catch(() => { /* swallow */ }).then(() => gate);
  userCostLocks.set(userId, next);
  // Wait for our turn: the prior caller must release before we proceed.
  await prior.catch(() => { /* swallow */ });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    // Clean up if no one chained behind us while we held the lock.
    if (userCostLocks.get(userId) === next) {
      userCostLocks.delete(userId);
    }
  };
}

/** Test-only: drop every in-flight per-user lock. */
export function _resetUserCostLocksForTests(): void {
  userCostLocks.clear();
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
export function getSpendByProvider(date?: string): Record<string, number> {
  try {
    const db = getDb();
    // Use parameterized query to prevent SQL injection
    const filterDate = date || new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT COALESCE(provider, 'anthropic') as provider, COALESCE(SUM(cost_usd), 0) as total
      FROM api_usage
      WHERE ts >= date(?)
      GROUP BY provider
    `).all(filterDate) as { provider: string; total: number }[];

    const result: Record<string, number> = { anthropic: 0, openai: 0, gemini: 0 };
    for (const row of rows) {
      result[row.provider] = row.total;
    }
    return result;
  } catch {
    return { anthropic: 0, openai: 0, gemini: 0 };
  }
}
