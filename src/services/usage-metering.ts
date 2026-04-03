// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Usage metering service — tracks AI usage per user per day.
 *
 * Records message counts, token usage, API calls, and cost.
 * Supports quota enforcement with configurable per-user daily limits.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

// ─── Types ──────────────────────────────────────────────────────────

export interface UsageRecord {
  userId: number;
  date: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  apiCalls: number;
  costUsd: number;
}

export interface UsageQuota {
  userId: number;
  dailyMessageLimit: number | null;
  dailyTokenLimit: number | null;
  dailyCostLimitUsd: number | null;
}

export interface QuotaStatus {
  allowed: boolean;
  usage: UsageRecord;
  quota: UsageQuota | null;
  /** Which limit was exceeded, if any */
  exceeded: ('messages' | 'tokens' | 'cost')[];
}

// ─── Helpers ────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

// ─── Recording ──────────────────────────────────────────────────────

/**
 * Record an AI API call for a user. Uses UPSERT to atomically increment
 * the daily aggregate row.
 *
 * @param userId      Telegram user ID (0 for system/cron calls)
 * @param inputTokens Tokens sent to the model
 * @param outputTokens Tokens received from the model
 * @param costUsd     Computed cost in USD
 * @param isUserMessage Whether this is a user-initiated message (increments message_count)
 */
export function recordUsage(
  userId: number,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  isUserMessage: boolean = false,
): void {
  const date = todayISO();
  const totalTokens = inputTokens + outputTokens;
  const msgIncrement = isUserMessage ? 1 : 0;

  try {
    getDb().prepare(`
      INSERT INTO usage_metering
        (user_id, date, message_count, input_tokens, output_tokens, total_tokens, api_calls, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET
        message_count = message_count + ?,
        input_tokens  = input_tokens  + ?,
        output_tokens = output_tokens + ?,
        total_tokens  = total_tokens  + ?,
        api_calls     = api_calls     + 1,
        cost_usd      = cost_usd      + ?,
        updated_at    = datetime('now')
    `).run(
      userId, date, msgIncrement, inputTokens, outputTokens, totalTokens, costUsd,
      msgIncrement, inputTokens, outputTokens, totalTokens, costUsd,
    );
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to record usage metering');
  }
}

// ─── Querying ───────────────────────────────────────────────────────

const EMPTY_USAGE: Omit<UsageRecord, 'userId' | 'date'> = {
  messageCount: 0, inputTokens: 0, outputTokens: 0,
  totalTokens: 0, apiCalls: 0, costUsd: 0,
};

/** Get a user's usage for a specific date (defaults to today). */
export function getDailyUsage(userId: number, date?: string): UsageRecord {
  const d = date ?? todayISO();
  const row = getDb().prepare(`
    SELECT message_count, input_tokens, output_tokens, total_tokens, api_calls, cost_usd
    FROM usage_metering WHERE user_id = ? AND date = ?
  `).get(userId, d) as any | undefined;

  return {
    userId,
    date: d,
    messageCount: row?.message_count ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    totalTokens: row?.total_tokens ?? 0,
    apiCalls: row?.api_calls ?? 0,
    costUsd: row?.cost_usd ?? 0,
  };
}

/** Get usage for a date range (inclusive). Returns one entry per user per day. */
export function getUsageRange(userId: number, startDate: string, endDate: string): UsageRecord[] {
  const rows = getDb().prepare(`
    SELECT user_id, date, message_count, input_tokens, output_tokens,
           total_tokens, api_calls, cost_usd
    FROM usage_metering
    WHERE user_id = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(userId, startDate, endDate) as any[];

  return rows.map((r) => ({
    userId: r.user_id,
    date: r.date,
    messageCount: r.message_count,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    totalTokens: r.total_tokens,
    apiCalls: r.api_calls,
    costUsd: r.cost_usd,
  }));
}

/** Get aggregated usage across all users for a specific date. */
export function getGlobalDailyUsage(date?: string): Omit<UsageRecord, 'userId'> {
  const d = date ?? todayISO();
  const row = getDb().prepare(`
    SELECT
      SUM(message_count) as message_count,
      SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(total_tokens) as total_tokens,
      SUM(api_calls) as api_calls,
      SUM(cost_usd) as cost_usd
    FROM usage_metering WHERE date = ?
  `).get(d) as any;

  return {
    date: d,
    messageCount: row?.message_count ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    totalTokens: row?.total_tokens ?? 0,
    apiCalls: row?.api_calls ?? 0,
    costUsd: row?.cost_usd ?? 0,
  };
}

// ─── Quota Management ───────────────────────────────────────────────

/** Get the quota configuration for a user (null if no quota set). */
export function getQuota(userId: number): UsageQuota | null {
  const row = getDb().prepare(`
    SELECT user_id, daily_message_limit, daily_token_limit, daily_cost_limit_usd
    FROM usage_quotas WHERE user_id = ?
  `).get(userId) as any | undefined;

  if (!row) return null;

  return {
    userId: row.user_id,
    dailyMessageLimit: row.daily_message_limit,
    dailyTokenLimit: row.daily_token_limit,
    dailyCostLimitUsd: row.daily_cost_limit_usd,
  };
}

/** Set or update a quota for a user. Pass null for any limit to make it unlimited. */
export function setQuota(
  userId: number,
  limits: { dailyMessageLimit?: number | null; dailyTokenLimit?: number | null; dailyCostLimitUsd?: number | null },
): void {
  getDb().prepare(`
    INSERT INTO usage_quotas (user_id, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      daily_message_limit  = COALESCE(?, daily_message_limit),
      daily_token_limit    = COALESCE(?, daily_token_limit),
      daily_cost_limit_usd = COALESCE(?, daily_cost_limit_usd),
      updated_at = datetime('now')
  `).run(
    userId,
    limits.dailyMessageLimit ?? null,
    limits.dailyTokenLimit ?? null,
    limits.dailyCostLimitUsd ?? null,
    limits.dailyMessageLimit ?? null,
    limits.dailyTokenLimit ?? null,
    limits.dailyCostLimitUsd ?? null,
  );
}

/**
 * Check whether a user is within their daily quota.
 * Reads limits from the users table (TASK-02) or falls back to usage_quotas.
 * Returns { allowed: true } or { allowed: false, exceeded: [...] }.
 */
export function checkQuota(userId: number): QuotaStatus {
  const usage = getDailyUsage(userId);

  // Try to get limits from users table first (TASK-02)
  let limits: { messages: number; tokens: number; cost: number } | null = null;
  try {
    const { getUserByTelegramId } = require('./user-service');
    const user = getUserByTelegramId(userId);
    if (user) {
      limits = {
        messages: user.daily_message_limit,
        tokens: user.daily_token_limit,
        cost: user.daily_cost_limit_usd,
      };
    }
  } catch { /* user-service not available — fall through */ }

  // Fall back to legacy usage_quotas table
  if (!limits) {
    const quota = getQuota(userId);
    if (!quota) return { allowed: true, usage, quota: null, exceeded: [] };
    limits = {
      messages: quota.dailyMessageLimit ?? 0,
      tokens: quota.dailyTokenLimit ?? 0,
      cost: quota.dailyCostLimitUsd ?? 0,
    };
  }

  const exceeded: ('messages' | 'tokens' | 'cost')[] = [];

  // 0 = unlimited (owner tier and unset limits)
  if (limits.messages > 0 && usage.messageCount >= limits.messages) {
    exceeded.push('messages');
  }
  if (limits.tokens > 0 && usage.totalTokens >= limits.tokens) {
    exceeded.push('tokens');
  }
  if (limits.cost > 0 && usage.costUsd >= limits.cost) {
    exceeded.push('cost');
  }

  return {
    allowed: exceeded.length === 0,
    usage,
    quota: { userId, dailyMessageLimit: limits.messages, dailyTokenLimit: limits.tokens, dailyCostLimitUsd: limits.cost },
    exceeded,
  };
}
