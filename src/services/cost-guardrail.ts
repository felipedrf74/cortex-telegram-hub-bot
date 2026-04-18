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

// ── Beta mode (paywall bypass) ─────────────────────────────────────
// When PAYWALL_ENABLED=false, ALL users get owner-level access ($100/day).
// Toggle via env var or the portal. Set to 'true' when subscriptions go live.
const PAYWALL_ENABLED = (process.env.PAYWALL_ENABLED ?? 'true') !== 'false';

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

  if (!PAYWALL_ENABLED) {
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
