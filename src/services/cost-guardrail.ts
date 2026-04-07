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
// Default $1.00/user/day. Override with PER_USER_DAILY_USD_CAP env var.
// At ~$0.04/Sonnet call this is ~25 expensive calls or ~1000 Gemini calls.
const PER_USER_DAILY_USD_CAP = parseFloat(process.env.PER_USER_DAILY_USD_CAP || '1.00');

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
 * This is the cost-protection layer that the per-minute rate limiter cannot
 * provide: a stuck retry loop costs ~$0.04/call × 60 calls/min = $2.40/min
 * within the existing rate limit. The cost cap stops bleed after the first
 * ~$1.00 of spend.
 *
 * Cap is configured via PER_USER_DAILY_USD_CAP env (default $1.00/day).
 */
export function isUserOverDailyCap(
  userId: number,
): { over: boolean; spentUsd: number; capUsd: number } {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM api_usage WHERE user_id = ? AND ts >= date('now')
    `).get(userId) as { total: number };
    return {
      over: row.total >= PER_USER_DAILY_USD_CAP,
      spentUsd: row.total,
      capUsd: PER_USER_DAILY_USD_CAP,
    };
  } catch {
    return { over: false, spentUsd: 0, capUsd: PER_USER_DAILY_USD_CAP };
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
