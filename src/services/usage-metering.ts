// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Usage Metering — Tracks AI messages per tenant per day.
 *
 * Records message counts, token usage, and cost per user/domain/day.
 * Provides query helpers for daily, weekly, and monthly usage summaries.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import type { DomainName } from '../domains/types';

// ─── Types ──────────────────────────────────────────────────────────

export interface UsageRecord {
  user_id: number;
  date: string;
  domain: DomainName;
  message_count: number;
  token_count: number;
  cost_usd: number;
}

export interface DailyUsageSummary {
  date: string;
  total_messages: number;
  total_tokens: number;
  total_cost: number;
  by_domain: { domain: string; messages: number; tokens: number; cost: number }[];
}

export interface UserUsageSummary {
  user_id: number;
  period: string;
  total_messages: number;
  total_tokens: number;
  total_cost: number;
  by_domain: { domain: string; messages: number; tokens: number; cost: number }[];
}

// ─── Prepared Statement Cache ───────────────────────────────────────

import type BetterSqlite3 from 'better-sqlite3';

let _stmts: Record<string, BetterSqlite3.Statement> | null = null;

function stmts(): Record<string, BetterSqlite3.Statement> {
  if (_stmts) return _stmts;
  const db = getDb();
  _stmts = {
    upsert: db.prepare(`
      INSERT INTO usage_metering (user_id, date, domain, message_count, token_count, cost_usd, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, datetime('now'))
      ON CONFLICT(user_id, date, domain) DO UPDATE SET
        message_count = message_count + 1,
        token_count   = token_count + excluded.token_count,
        cost_usd      = cost_usd + excluded.cost_usd,
        updated_at    = datetime('now')
    `),
    userToday: db.prepare(`
      SELECT domain, message_count as messages, token_count as tokens, cost_usd as cost
      FROM usage_metering
      WHERE user_id = ? AND date = date('now')
    `),
    userRange: db.prepare(`
      SELECT domain, SUM(message_count) as messages, SUM(token_count) as tokens, SUM(cost_usd) as cost
      FROM usage_metering
      WHERE user_id = ? AND date >= ? AND date <= ?
      GROUP BY domain
    `),
    dailyTotals: db.prepare(`
      SELECT date, SUM(message_count) as total_messages, SUM(token_count) as total_tokens, SUM(cost_usd) as total_cost
      FROM usage_metering
      WHERE date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date DESC
    `),
    allUsersToday: db.prepare(`
      SELECT user_id, domain, message_count as messages, token_count as tokens, cost_usd as cost
      FROM usage_metering
      WHERE date = date('now')
    `),
    userMessageCountToday: db.prepare(`
      SELECT COALESCE(SUM(message_count), 0) as count
      FROM usage_metering
      WHERE user_id = ? AND date = date('now')
    `),
  };
  return _stmts;
}

// ─── Core Functions ─────────────────────────────────────────────────

/**
 * Record a single AI message for a user in a domain.
 * Upserts into the daily aggregate row — one row per user/domain/day.
 */
export function recordUsage(
  userId: number,
  domain: DomainName,
  tokens: number,
  costUsd: number,
): void {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    stmts().upsert.run(userId, today, domain, tokens, costUsd);
  } catch (err) {
    logger.warn({ err, userId, domain }, 'Failed to record usage metering');
  }
}

/**
 * Get today's usage breakdown for a specific user.
 */
export function getUserUsageToday(userId: number): UserUsageSummary {
  const rows = stmts().userToday.all(userId) as { domain: string; messages: number; tokens: number; cost: number }[];
  return {
    user_id: userId,
    period: 'today',
    total_messages: rows.reduce((s, r) => s + r.messages, 0),
    total_tokens: rows.reduce((s, r) => s + r.tokens, 0),
    total_cost: rows.reduce((s, r) => s + r.cost, 0),
    by_domain: rows,
  };
}

/**
 * Get usage for a user over a date range.
 */
export function getUserUsageRange(userId: number, startDate: string, endDate: string): UserUsageSummary {
  const rows = stmts().userRange.all(userId, startDate, endDate) as { domain: string; messages: number; tokens: number; cost: number }[];
  return {
    user_id: userId,
    period: `${startDate} to ${endDate}`,
    total_messages: rows.reduce((s, r) => s + r.messages, 0),
    total_tokens: rows.reduce((s, r) => s + r.tokens, 0),
    total_cost: rows.reduce((s, r) => s + r.cost, 0),
    by_domain: rows,
  };
}

/**
 * Get daily totals across all users for a date range.
 */
export function getDailyTotals(startDate: string, endDate: string): DailyUsageSummary[] {
  const rows = stmts().dailyTotals.all(startDate, endDate) as {
    date: string; total_messages: number; total_tokens: number; total_cost: number;
  }[];
  return rows.map((r) => ({
    date: r.date,
    total_messages: r.total_messages,
    total_tokens: r.total_tokens,
    total_cost: r.total_cost,
    by_domain: [], // lightweight — caller can fetch domain breakdown separately
  }));
}

/**
 * Get today's total message count for a user (across all domains).
 */
export function getUserMessageCountToday(userId: number): number {
  const row = stmts().userMessageCountToday.get(userId) as { count: number };
  return row.count;
}

/**
 * Reset cached prepared statements (needed when DB is re-initialized, e.g. in tests).
 */
export function resetMeteringStatements(): void {
  _stmts = null;
}
