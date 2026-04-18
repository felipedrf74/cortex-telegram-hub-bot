// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { config } from '../config';
import { getCached, setCache } from './cache-store';
import { composeWeeklyPlan, type WeeklyPlanDay, type WeeklyPlanResponse } from './weekly-plan-orchestrator';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';

export interface DailyBriefResponse {
  date: string;
  generatedAt: string;
  degraded: boolean;
  gated: { skills: string[] };
  garmin_stale: boolean;
  conflicts: WeeklyPlanResponse['conflicts'];
  creativeCopy: WeeklyPlanResponse['creativeCopy'];
  day: WeeklyPlanDay;
  coordination: {
    topPriority: string | null;
    executionOrder: string[];
    watchouts: string[];
    handoffs: string[];
  };
}

function buildEmptyDailyBriefDay(date: string): WeeklyPlanDay {
  return {
    date,
    weekday: DateTime.fromISO(date, { zone: config.app.timezone || 'Europe/Lisbon' }).toFormat('cccc'),
    headline: 'Daily brief unavailable because tenant scope is invalid for this request.',
    training: {
      title: 'Brief unavailable',
      type: 'gated',
      status: 'gated',
      durationMinutes: null,
      intensity: null,
      reason: 'Tenant scope is invalid, so the daily brief skipped user-owned planning reads.',
      decisions: [],
    },
    meals: [],
    content: null,
    secretary: {
      focusBlock: null,
      pendingTasks: 0,
      overdueTasks: 0,
      travel: false,
      busy: false,
      priorityNote: null,
      sequence: [],
      tradeoffNote: null,
      decisions: [],
    },
    finance: null,
  };
}

function buildEmptyDailyBriefResponse(opts: { userId: number; date?: string }): DailyBriefResponse {
  const targetDate = resolveTargetDate(opts.date);
  return {
    date: targetDate,
    generatedAt: new Date().toISOString(),
    degraded: true,
    gated: { skills: [] },
    garmin_stale: false,
    conflicts: [],
    creativeCopy: {
      headline: '',
      note: '',
    },
    day: buildEmptyDailyBriefDay(targetDate),
    coordination: {
      topPriority: null,
      executionOrder: [],
      watchouts: [],
      handoffs: [],
    },
  };
}

export async function composeDailyBrief(opts: {
  userId: number;
  date?: string;
  forceRefresh?: boolean;
}): Promise<DailyBriefResponse> {
  if (!isValidTenantUserId(opts.userId)) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'compose_daily_brief',
      reason: 'invalid_user_scope',
      userId: opts.userId ?? null,
      details: {
        date: opts.date ?? null,
      },
    });
    return buildEmptyDailyBriefResponse(opts);
  }

  const targetDate = resolveTargetDate(opts.date);
  const cacheKey = `plan:today:u:${opts.userId}:${targetDate}`;
  if (!opts.forceRefresh) {
    const cached = getCached<DailyBriefResponse>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const weekPlan = await composeWeeklyPlan({
    userId: opts.userId,
    weekStart: weekStartForDate(targetDate),
    forceRefresh: opts.forceRefresh,
  });

  const day = weekPlan.days.find((entry) => entry.date === targetDate) ?? weekPlan.days[0];
  const response: DailyBriefResponse = {
    date: targetDate,
    generatedAt: new Date().toISOString(),
    degraded: weekPlan.degraded,
    gated: weekPlan.gated,
    garmin_stale: weekPlan.garmin_stale,
    conflicts: weekPlan.conflicts.filter((conflict) => conflict.date === targetDate),
    creativeCopy: weekPlan.creativeCopy,
    day,
    coordination: buildDailyCoordination(day, weekPlan.conflicts.filter((conflict) => conflict.date === targetDate)),
  };

  setCache(cacheKey, response, 1800);
  return response;
}

function buildDailyCoordination(
  day: WeeklyPlanDay,
  conflicts: WeeklyPlanResponse['conflicts'],
): DailyBriefResponse['coordination'] {
  const topPriority = day.secretary.priorityNote ?? day.training.reason ?? null;
  const executionOrder = day.secretary.sequence.slice(0, 5);
  const watchouts = compact([
    day.training.status === 'adjusted' ? day.training.reason : null,
    day.secretary.tradeoffNote,
    conflicts[0]?.message ?? null,
    day.finance?.budgetNote && /budget/i.test(day.finance.budgetNote) ? day.finance.budgetNote : null,
    day.content?.status === 'blocked' ? day.content.note : null,
  ]);

  const handoffs = compact([
    day.meals.some((meal) => meal.title === 'Fueling coverage missing')
      ? 'Training depends on meal coverage landing before the key session.'
      : null,
    day.content?.status === 'scheduled' && day.training.status !== 'rest'
      ? 'Content should follow the protected training and fueling commitments instead of displacing them.'
      : null,
    day.content?.status === 'scheduled' && day.finance?.budgetNote
      ? 'Keep the content execution path aligned with the current finance constraints for the week.'
      : null,
  ]);

  return {
    topPriority,
    executionOrder,
    watchouts,
    handoffs,
  };
}

function compact(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && value.trim().length > 0));
}

function resolveTargetDate(date?: string): string {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const parsed = date
    ? DateTime.fromISO(date, { zone }).startOf('day')
    : DateTime.now().setZone(zone).startOf('day');
  return (parsed.isValid ? parsed : DateTime.now().setZone(zone)).toISODate()!;
}

function weekStartForDate(date: string): string {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const parsed = DateTime.fromISO(date, { zone }).startOf('day');
  return (parsed.isValid ? parsed : DateTime.now().setZone(zone)).startOf('week').toISODate()!;
}
