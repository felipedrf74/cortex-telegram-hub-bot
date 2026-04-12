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
// Margin-safe daily cost caps derived from Gemini 2.5-flash pricing
// ($0.003–$0.006/call average). Caps are sized so that even if a
// user consumes the FULL cap every day of the month, we maintain
// ≥70% margin on Stripe and ≥57% margin on App Store Year 1.
//
//   Pro ($25/mo): $0.25/day × 30 = $7.50/mo COGS → 70% Stripe margin
//   Max ($45/mo): $0.45/day × 30 = $13.50/mo COGS → 70% Stripe margin
//
// Typical users consume ~30–40% of cap → realistic margins are 85–93%.
// No free tier — unsubscribed users are blocked from AI entirely.
const DEFAULT_DAILY_CAP_USD = parseFloat(process.env.PER_USER_DAILY_USD_CAP || '0.00');

// ── Beta mode (paywall bypass) ─────────────────────────────────────
// When PAYWALL_ENABLED=false, ALL users get owner-level access ($100/day).
// Toggle via env var or the portal. Set to 'true' when subscriptions go live.
const PAYWALL_ENABLED = (process.env.PAYWALL_ENABLED ?? 'true') !== 'false';

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

/**
 * Per-user enforcement: returns over=true if the user has exceeded their
 * daily cost cap. The chat handler should call this BEFORE invoking the AI
 * pipeline and return 429 if over.
 *
 * Enforcement is COST-BASED only (not call-count). This aligns with
 * best practices from Claude/OpenAI: the user sees a qualitative progress
 * bar ("Enhanced usage", "Maximum usage"), never raw call counts. The
 * actual dollar caps are internal — not exposed to the iOS client.
 *
 * No free tier: unsubscribed users have $0.00 cap (blocked from AI).
 * They must subscribe to Pro or Max to use AI features.
 *
 * Plan caps (margin-safe, survives daily max consumption × 30 days):
 *   Pro ($25/mo): $0.25/day → worst-case $7.50/mo → 70% Stripe margin
 *   Max ($45/mo): $0.45/day → worst-case $13.50/mo → 70% Stripe margin
 */
export function isUserOverDailyCap(
  userId: number,
): {
  over: boolean;
  spentUsd: number;
  capUsd: number;
  plan: string;
  usageLevel: 'none' | 'enhanced' | 'maximum' | 'owner';
  usageFraction: number;
  callsToday: number;
  boostAvailable: boolean;
} {
  try {
    const db = getDb();

    // Resolve plan-based cost cap from subscription status.
    // No free tier — unsubscribed users get $0.00 cap.
    let plan = 'none';
    let capUsd = DEFAULT_DAILY_CAP_USD;
    let usageLevel: 'none' | 'enhanced' | 'maximum' | 'owner' = 'none';

    // Beta bypass: when paywall is disabled, every user gets owner-level
    // access. This lets closed beta testers use all AI features without
    // needing a subscription. Set PAYWALL_ENABLED=false in .env.
    if (!PAYWALL_ENABLED) {
      plan = 'beta'; capUsd = 100; usageLevel = 'owner';
    }

    // Owner bypass — check BEFORE subscription lookup so the owner
    // is never affected by subscriptions table issues.
    //
    // Two paths: (1) direct Telegram ID match (bot codepath), or
    // (2) iOS user whose `telegram_id` in the users table is an
    // owner Telegram ID. Path 2 is needed because iOS auth creates
    // users with an auto-increment `id` (e.g. 13) that doesn't
    // match the Telegram ID (e.g. 7807541475).
    const ownerTelegramIds = config.telegram.allowedUserIds || [];
    let isOwner = ownerTelegramIds.includes(userId);
    if (!isOwner) {
      try {
        const user = db.prepare(
          "SELECT telegram_id FROM users WHERE id = ?"
        ).get(userId) as { telegram_id: number | null } | undefined;
        if (user?.telegram_id && ownerTelegramIds.includes(user.telegram_id)) {
          isOwner = true;
        }
      } catch { /* users table may not exist */ }
    }
    if (isOwner) {
      plan = 'owner'; capUsd = 100; usageLevel = 'owner';
    }

    // Subscription-based cap (only if not already owner)
    if (plan !== 'owner') {
      try {
        const sub = db.prepare(
          "SELECT plan, status FROM subscriptions WHERE user_id = ?"
        ).get(userId) as { plan: string; status: string } | undefined;

        if (sub && ['active', 'trialing'].includes(sub.status)) {
          plan = sub.plan;
          if (sub.plan === 'max')      { capUsd = 0.45; usageLevel = 'maximum'; }
          else if (sub.plan === 'pro') { capUsd = 0.25; usageLevel = 'enhanced'; }
        }
      } catch { /* subscriptions table may not exist */ }
    }

    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total, COUNT(*) as calls
      FROM api_usage WHERE user_id = ? AND ts >= date('now')
    `).get(userId) as { total: number; calls: number };

    const fraction = capUsd > 0 ? Math.min(row.total / capUsd, 1.0) : 1.0;

    return {
      over: row.total >= capUsd,
      spentUsd: row.total,
      capUsd,
      plan,
      usageLevel,
      usageFraction: Math.round(fraction * 100) / 100,
      callsToday: row.calls,
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
    };
  }
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
