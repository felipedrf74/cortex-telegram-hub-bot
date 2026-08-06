// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Adherence trend signal — slice C5 of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Computes a rolling 2-week adherence fraction and emits
 * 'condition_adherence_trend_low' when both weeks fall below 0.70.
 * Consumed by C7 (week conditions aggregator) and C8 (scenario
 * classifier — low-adherence simplification policy).
 *
 * Adherence per week uses canonical session disposition credit for that
 * week's date range: completed=1, partial=0.5, skipped/pending=0. A feedback
 * row alone is not proof of full completion.
 */

import { getDb } from './database';

export interface WeeklyAdherence {
  weekStartDate: string;
  weekEndDate: string;
  completed: number;
  scheduled: number;
  fraction: number;
}

export interface AdherenceTrendResult {
  userId: number;
  tenantId: number;
  currentWeek: WeeklyAdherence;
  priorWeek: WeeklyAdherence;
  rolling2WeekFraction: number;
  trendLow: boolean;
}

/**
 * Compute the rolling 2-week adherence trend ending on `asOfISODate`.
 * The "current week" is the 7 days ending today; the "prior week"
 * is the 7 days before that.
 */
export function computeAdherenceTrend(
  userId: number,
  tenantId: number,
  asOfISODate: string,
  lowThreshold = 0.70,
): AdherenceTrendResult {
  const now = Date.parse(asOfISODate);
  if (!Number.isFinite(now)) {
    throw new Error(`computeAdherenceTrend: invalid asOfISODate ${asOfISODate}`);
  }
  const dayMs = 24 * 3600 * 1000;
  const currentEnd = asOfISODate.slice(0, 10);
  const currentStart = new Date(now - 6 * dayMs).toISOString().slice(0, 10);
  const priorEnd = new Date(now - 7 * dayMs).toISOString().slice(0, 10);
  const priorStart = new Date(now - 13 * dayMs).toISOString().slice(0, 10);

  const currentWeek = computeWeekAdherence(userId, tenantId, currentStart, currentEnd);
  const priorWeek = computeWeekAdherence(userId, tenantId, priorStart, priorEnd);

  const rolling = (currentWeek.completed + priorWeek.completed)
    / Math.max(1, currentWeek.scheduled + priorWeek.scheduled);

  const trendLow = currentWeek.fraction < lowThreshold && priorWeek.fraction < lowThreshold;

  return {
    userId,
    tenantId,
    currentWeek,
    priorWeek,
    rolling2WeekFraction: Math.round(rolling * 1000) / 1000,
    trendLow,
  };
}

function computeWeekAdherence(
  userId: number,
  tenantId: number,
  weekStartDate: string,
  weekEndDate: string,
): WeeklyAdherence {
  const db = getDb();
  const startMs = Date.parse(weekStartDate);
  if (!Number.isFinite(startMs)) {
    return {
      weekStartDate, weekEndDate,
      completed: 0, scheduled: 0, fraction: 0,
    };
  }

  // For each session in this user's plans, compute its scheduled date
  // (plan.start_date + (week_number - 1) * 7 + dayOfWeek index) and
  // check if it falls in the [weekStartDate, weekEndDate] window.
  const dayMap: Record<string, number> = {
    monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
  };

  const rows = db.prepare(`
    SELECT
      p.start_date AS plan_start,
      w.week_number,
      s.id AS session_id,
      s.day_of_week,
      s.status
    FROM fitness_training_plans p
    JOIN training_weeks w ON w.plan_id = p.id
    JOIN training_sessions s ON s.week_id = w.id
    WHERE p.user_id = ? AND p.tenant_id = ? AND p.status = 'active'
  `).all(userId, tenantId) as Array<{
    plan_start: string;
    week_number: number;
    session_id: number;
    day_of_week: string;
    status: string;
  }>;

  let scheduled = 0;
  let completed = 0;
  const endMs = Date.parse(weekEndDate);

  for (const r of rows) {
    const dayIdx = dayMap[r.day_of_week.toLowerCase()];
    if (dayIdx === undefined) continue;
    const planStartMs = Date.parse(r.plan_start);
    if (!Number.isFinite(planStartMs)) continue;
    const sessionMs = planStartMs + (r.week_number - 1) * 7 * 24 * 3600 * 1000 + dayIdx * 24 * 3600 * 1000;
    if (sessionMs < startMs || sessionMs > endMs) continue;
    scheduled++;
    if (r.status === 'completed') completed += 1;
    else if (r.status === 'partial') completed += 0.5;
  }

  return {
    weekStartDate,
    weekEndDate,
    completed,
    scheduled,
    fraction: scheduled === 0 ? 0 : Math.round((completed / scheduled) * 1000) / 1000,
  };
}
