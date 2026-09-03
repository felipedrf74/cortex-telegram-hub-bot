// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { WeeklyPlanDay, WeeklyPlanResponse } from './weekly-plan-orchestrator';
import type {
  DailyPlanSourceHealth,
  PlanSourceHealth,
  SecretaryPlanningContext,
  WeeklyPlanSourceHealth,
} from './secretary-planning-context';

export interface SecretaryDaySnapshot {
  context: SecretaryPlanningContext;
  week: WeeklyPlanResponse;
  date: string;
  day: WeeklyPlanDay | null;
  conflicts: WeeklyPlanResponse['conflicts'];
  timezone: string;
  warningCodes: string[];
  warnings: string[];
  sourceHealth: WeeklyPlanSourceHealth;
}

export function buildSecretaryDaySnapshot(input: {
  context: SecretaryPlanningContext;
  week: WeeklyPlanResponse;
}): SecretaryDaySnapshot {
  return {
    context: input.context,
    week: input.week,
    date: input.context.targetDate,
    day: input.week.days.find((entry) => entry.date === input.context.targetDate) ?? null,
    conflicts: input.week.conflicts.filter((conflict) => conflict.date === input.context.targetDate),
    timezone: input.week.timezone ?? input.context.timezone,
    warningCodes: input.week.warningCodes ?? [],
    warnings: input.week.warnings ?? [],
    sourceHealth: input.week.sourceHealth ?? unavailableWeeklyPlanSourceHealth(),
  };
}

export function readyWeeklyPlanSourceHealth(): WeeklyPlanSourceHealth {
  return {
    calendar: ready(),
    tasks: ready(),
    mail: ready(),
    focus: ready(),
    training: ready(),
    cooking: ready(),
    content: ready(),
    finance: ready(),
  };
}

export function unavailableWeeklyPlanSourceHealth(): WeeklyPlanSourceHealth {
  return Object.fromEntries(
    Object.keys(readyWeeklyPlanSourceHealth()).map((key) => [key, {
      status: 'unavailable',
      warningCodes: ['PLANNING_SOURCE_UNAVAILABLE'],
      warnings: ['Planning source state is unavailable.'],
    }]),
  ) as unknown as WeeklyPlanSourceHealth;
}

export function unavailableDailyPlanSourceHealth(): DailyPlanSourceHealth {
  return {
    ...unavailableWeeklyPlanSourceHealth(),
    decision_center: {
      status: 'unavailable',
      warningCodes: ['DECISION_CENTER_STATE_UNAVAILABLE'],
      warnings: ['Decision Center state is unavailable.'],
    },
  };
}

export function withDecisionCenterHealth(
  weekly: WeeklyPlanSourceHealth,
  decisionCenter: PlanSourceHealth,
): DailyPlanSourceHealth {
  return { ...weekly, decision_center: decisionCenter };
}

export function markWeeklyPlanSourcesStale<T extends {
  sourceHealth?: WeeklyPlanSourceHealth;
  warningCodes?: string[];
  warnings?: string[];
}>(value: T): T {
  if (!value.sourceHealth) {
    return {
      ...value,
      sourceHealth: unavailableWeeklyPlanSourceHealth(),
      warningCodes: unique([...(value.warningCodes ?? []), 'PLAN_CACHE_STALE', 'PLANNING_SOURCE_UNAVAILABLE']),
      warnings: unique([
        ...(value.warnings ?? []),
        'This cached plan does not include current source health.',
      ]),
    } as T;
  }
  const sourceHealth = Object.fromEntries(
    Object.entries(value.sourceHealth).map(([key, health]) => [key, health.status === 'ready'
      ? { ...health, status: 'stale' as const }
      : health]),
  ) as unknown as WeeklyPlanSourceHealth;
  return {
    ...value,
    sourceHealth,
    warningCodes: unique([...(value.warningCodes ?? []), 'PLAN_CACHE_STALE']),
    warnings: unique([...(value.warnings ?? []), 'This plan is cached while current source state refreshes.']),
  };
}

export function markDailyPlanSourcesStale<T extends {
  sourceHealth?: DailyPlanSourceHealth;
  warningCodes?: string[];
  warnings?: string[];
}>(value: T): T {
  if (!value.sourceHealth) {
    return {
      ...value,
      sourceHealth: unavailableDailyPlanSourceHealth(),
      warningCodes: unique([...(value.warningCodes ?? []), 'PLAN_CACHE_STALE', 'PLANNING_SOURCE_UNAVAILABLE']),
      warnings: unique([
        ...(value.warnings ?? []),
        'This cached plan does not include current source health.',
      ]),
    } as T;
  }
  const sourceHealth = Object.fromEntries(
    Object.entries(value.sourceHealth).map(([key, health]) => [key, health.status === 'ready'
      ? { ...health, status: 'stale' as const }
      : health]),
  ) as unknown as DailyPlanSourceHealth;
  return {
    ...value,
    sourceHealth,
    warningCodes: unique([...(value.warningCodes ?? []), 'PLAN_CACHE_STALE']),
    warnings: unique([...(value.warnings ?? []), 'This plan is cached while current source state refreshes.']),
  };
}

function ready(): PlanSourceHealth {
  return { status: 'ready', warningCodes: [], warnings: [] };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
