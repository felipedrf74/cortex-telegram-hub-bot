// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Durable, aggregate-only telemetry for the M14 routing-clarify budget.
 *
 * No tenant, user, prompt, candidate, or response data is stored. One UTC
 * row per day is enough for the operator dashboard to enforce the approved
 * ~10% ceiling across process restarts and multi-process release soaks.
 */

import type Database from 'better-sqlite3';

export const ROUTING_CLARIFY_BUDGET_LIMIT = 0.1;

export interface ChatRoutingClarifyBudget {
  windowDays: number;
  evaluatedTurns: number;
  clarifiedTurns: number;
  rate: number | null;
  budgetLimit: number;
  /** Null means no evaluated-turn evidence; absence is never a vacuous pass. */
  withinBudget: boolean | null;
}

export function ensureChatRoutingClarifyMetricsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_routing_clarify_metrics_daily (
      metric_date TEXT PRIMARY KEY,
      evaluated_turns INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_turns >= 0),
      clarified_turns INTEGER NOT NULL DEFAULT 0 CHECK (
        clarified_turns >= 0 AND clarified_turns <= evaluated_turns
      ),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (length(metric_date) = 10)
    )
  `);
}

export function recordChatRoutingClarifyDecisionPersisted(
  db: Database.Database,
  clarified: boolean,
  at: Date = new Date(),
): void {
  ensureChatRoutingClarifyMetricsTable(db);
  const metricDate = utcDate(at);
  db.prepare(`
    INSERT INTO chat_routing_clarify_metrics_daily (
      metric_date, evaluated_turns, clarified_turns, updated_at
    ) VALUES (?, 1, ?, datetime('now'))
    ON CONFLICT(metric_date) DO UPDATE SET
      evaluated_turns = evaluated_turns + 1,
      clarified_turns = clarified_turns + excluded.clarified_turns,
      updated_at = datetime('now')
  `).run(metricDate, clarified ? 1 : 0);
}

export function readChatRoutingClarifyBudget(
  db: Database.Database,
  options: { now?: Date; windowDays?: number } = {},
): ChatRoutingClarifyBudget {
  ensureChatRoutingClarifyMetricsTable(db);
  const now = options.now ?? new Date();
  const windowDays = boundedWindowDays(options.windowDays);
  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - (windowDays - 1),
  ));
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(evaluated_turns), 0) AS evaluated_turns,
      COALESCE(SUM(clarified_turns), 0) AS clarified_turns
    FROM chat_routing_clarify_metrics_daily
    WHERE metric_date >= ? AND metric_date <= ?
  `).get(utcDate(cutoff), utcDate(now)) as {
    evaluated_turns: number;
    clarified_turns: number;
  };
  const evaluatedTurns = nonNegativeInt(row.evaluated_turns);
  const clarifiedTurns = Math.min(evaluatedTurns, nonNegativeInt(row.clarified_turns));
  const rate = evaluatedTurns > 0 ? round4(clarifiedTurns / evaluatedTurns) : null;
  return {
    windowDays,
    evaluatedTurns,
    clarifiedTurns,
    rate,
    budgetLimit: ROUTING_CLARIFY_BUDGET_LIMIT,
    withinBudget: rate === null ? null : rate <= ROUTING_CLARIFY_BUDGET_LIMIT,
  };
}

function boundedWindowDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return 30;
  return Math.min(365, Math.max(1, Math.trunc(value!)));
}

function utcDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error('CHAT_ROUTING_CLARIFY_METRIC_DATE_INVALID');
  return value.toISOString().slice(0, 10);
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
