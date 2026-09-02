// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import {
  planLanguageLocale,
  resolveSecretaryPlanningContext,
  type SecretaryPlanningContext,
} from './secretary-planning-context';
import { buildSecretaryDaySnapshot, type SecretaryDaySnapshot } from './secretary-planning-snapshot';
import { composeDailyBrief, type DailyBriefResponse } from './daily-brief-orchestrator';
import { composeWeeklyPlan, type WeeklyPlanResponse } from './weekly-plan-orchestrator';

export type SecretaryScheduledReportKind =
  | 'morning_briefing'
  | 'weekly_review'
  | 'evening_summary';

export interface SecretaryScheduledPlanningSnapshot {
  context: SecretaryPlanningContext;
  week: WeeklyPlanResponse;
  today: SecretaryDaySnapshot;
  daily: DailyBriefResponse;
}

export interface SecretaryScheduledReportProjection {
  title: string;
  summary: string;
  documentJson: Record<string, unknown>;
}

/**
 * Canonical scheduled-report read path: resolve account/timezone/language once,
 * compose one week, then derive today from that exact week object.
 */
export async function composeSecretaryScheduledPlanningSnapshot(scope: {
  userId: number;
  tenantId: number;
  localDate?: string;
}): Promise<SecretaryScheduledPlanningSnapshot> {
  const context = resolveSecretaryPlanningContext({
    userId: scope.userId,
    tenantId: scope.tenantId,
    ...(scope.localDate ? { date: scope.localDate } : {}),
  });
  const week = await composeWeeklyPlan({
    userId: scope.userId,
    tenantId: scope.tenantId,
    weekStart: context.weekStart,
    language: context.language,
    context,
  });
  const today = buildSecretaryDaySnapshot({ context, week });
  // forceRefresh prevents an independently cached Today response from winning
  // over the exact week object supplied by this report execution.
  const daily = await composeDailyBrief({
    userId: scope.userId,
    tenantId: scope.tenantId,
    date: context.targetDate,
    language: context.language,
    context,
    weekPlan: week,
    daySnapshot: today,
    forceRefresh: true,
  });
  return { context, week, today, daily };
}

/**
 * Report documents retain canonical source-health metadata. Unknown or failed
 * sources therefore remain explicit instead of collapsing into zero/all-clear
 * legacy counters.
 */
export function projectSecretaryScheduledReport(
  snapshot: SecretaryScheduledPlanningSnapshot,
  kind: SecretaryScheduledReportKind,
): SecretaryScheduledReportProjection {
  const copy = scheduledReportCopy(snapshot.context.language);
  const localDateLabel = DateTime.fromISO(snapshot.context.targetDate, {
    zone: snapshot.context.timezone,
  })
    .setLocale(planLanguageLocale(snapshot.context.language))
    .toFormat('cccc, LLLL dd');
  const common = {
    schemaVersion: 1,
    reportKind: kind,
    timezone: snapshot.today.timezone,
    localDate: snapshot.today.date,
    weekStart: snapshot.week.weekStart,
    weekEnd: snapshot.week.weekEnd,
    gated: snapshot.week.gated,
    garminStale: snapshot.week.garmin_stale,
  };

  if (kind === 'weekly_review') {
    return {
      title: copy.weeklyTitle,
      summary: incompleteSourceSummary(snapshot.week.sourceHealth)
        ?? nonEmpty(snapshot.week.creativeCopy.headline)
        ?? `${snapshot.week.weekStart} – ${snapshot.week.weekEnd}`,
      documentJson: {
        ...common,
        generatedAt: snapshot.week.generatedAt,
        warningCodes: snapshot.week.warningCodes,
        warnings: snapshot.week.warnings,
        sourceHealth: snapshot.week.sourceHealth,
        degraded: snapshot.week.degraded,
        planningSnapshot: snapshot.week,
      },
    };
  }

  const daySummary = incompleteSourceSummary(snapshot.daily.sourceHealth)
    ?? nonEmpty(snapshot.daily.day?.headline)
    ?? copy.planningSnapshot(snapshot.today.date);
  return {
    title: kind === 'morning_briefing'
      ? `☀️ ${localDateLabel}`
      : copy.eveningTitle,
    summary: daySummary,
    documentJson: {
      ...common,
      generatedAt: snapshot.daily.generatedAt,
      warningCodes: snapshot.daily.warningCodes,
      warnings: snapshot.daily.warnings,
      sourceHealth: snapshot.daily.sourceHealth,
      degraded: snapshot.daily.degraded,
      planningSnapshot: snapshot.daily,
    },
  };
}

function scheduledReportCopy(language: SecretaryPlanningContext['language']): {
  weeklyTitle: string;
  eveningTitle: string;
  planningSnapshot: (date: string) => string;
} {
  if (language === 'pt-BR') {
    return {
      weeklyTitle: '📊 Resumo da semana',
      eveningTitle: 'Resumo do fim do dia',
      planningSnapshot: (date) => `Planejamento de ${date}`,
    };
  }
  if (language === 'pt-PT') {
    return {
      weeklyTitle: '📊 Resumo da semana',
      eveningTitle: 'Resumo do final do dia',
      planningSnapshot: (date) => `Planeamento de ${date}`,
    };
  }
  return {
    weeklyTitle: '📊 Week in Review',
    eveningTitle: 'End-of-day summary',
    planningSnapshot: (date) => `Planning snapshot for ${date}`,
  };
}

function incompleteSourceSummary(
  sourceHealth: Record<string, {
    status: string;
    warningCodes?: string[];
    warnings?: string[];
  }>,
): string | null {
  const incomplete = Object.entries(sourceHealth)
    .filter(([, health]) => health.status !== 'ready' && !isEntitlementGate(health.warningCodes));
  if (incomplete.length === 0) return null;
  const warning = incomplete
    .flatMap(([, health]) => health.warnings ?? [])
    .map(nonEmpty)
    .find((value): value is string => value !== null);
  if (warning) return warning;
  return incomplete
    .map(([source, health]) => `${source}: ${health.status}`)
    .join(' · ');
}

function isEntitlementGate(warningCodes: string[] | undefined): boolean {
  return (warningCodes ?? []).some((code) => code.endsWith('_SKILL_GATED'));
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
