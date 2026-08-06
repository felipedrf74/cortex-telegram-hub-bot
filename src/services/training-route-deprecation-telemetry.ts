// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Durable aggregate-only evidence for the Training summary deprecation window.
 * Removal remains separately gated by the elapsed window, two supported client
 * releases, and operator review; a zero count is evidence absence, not consent.
 */

import type Database from 'better-sqlite3';

export const TRAINING_SUMMARY_ROUTE_PATH = '/api/v1/training/summary' as const;

export interface TrainingSummaryDeprecationUsage {
  routePath: typeof TRAINING_SUMMARY_ROUTE_PATH;
  windowDays: number;
  requestCount: number;
  firstHitDate: string | null;
  lastHitDate: string | null;
}

export function recordTrainingSummaryDeprecationHit(
  db: Database.Database,
  at: Date = new Date(),
): void {
  const metricDate = utcDate(at);
  db.prepare(`
    INSERT INTO api_route_deprecation_metrics_daily (
      metric_date, route_path, request_count, updated_at
    ) VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(metric_date, route_path) DO UPDATE SET
      request_count = MIN(9007199254740991, request_count + 1),
      updated_at = datetime('now')
  `).run(metricDate, TRAINING_SUMMARY_ROUTE_PATH);
}

export function readTrainingSummaryDeprecationUsage(
  db: Database.Database,
  options: { now?: Date; windowDays?: number } = {},
): TrainingSummaryDeprecationUsage {
  const now = options.now ?? new Date();
  const windowDays = boundedWindowDays(options.windowDays);
  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - (windowDays - 1),
  ));
  const firstDate = utcDate(cutoff);
  const lastDate = utcDate(now);
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(request_count), 0) AS request_count,
      MIN(metric_date) AS first_hit_date,
      MAX(metric_date) AS last_hit_date
    FROM api_route_deprecation_metrics_daily
    WHERE route_path = ?
      AND metric_date >= ?
      AND metric_date <= ?
  `).get(TRAINING_SUMMARY_ROUTE_PATH, firstDate, lastDate) as {
    request_count: number;
    first_hit_date: string | null;
    last_hit_date: string | null;
  };

  return {
    routePath: TRAINING_SUMMARY_ROUTE_PATH,
    windowDays,
    requestCount: nonNegativeInt(row.request_count),
    firstHitDate: row.first_hit_date,
    lastHitDate: row.last_hit_date,
  };
}

function boundedWindowDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return 30;
  return Math.min(365, Math.max(1, Math.trunc(value!)));
}

function utcDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('TRAINING_ROUTE_DEPRECATION_METRIC_DATE_INVALID');
  }
  return value.toISOString().slice(0, 10);
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}
