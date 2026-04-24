// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { config } from '../config';
import { getCached, setCache } from './cache-store';
import { composeWeeklyPlan, type WeeklyPlanDay, type WeeklyPlanResponse } from './weekly-plan-orchestrator';
import { buildSecretaryCoordination, type SecretaryCoordinationModel } from './secretary-orchestrator';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { logger } from '../utils/logger';

export interface DailyBriefResponse {
  date: string;
  generatedAt: string;
  degraded: boolean;
  gated: { skills: string[] };
  garmin_stale: boolean;
  conflicts: WeeklyPlanResponse['conflicts'];
  creativeCopy: WeeklyPlanResponse['creativeCopy'];
  day: WeeklyPlanDay;
  coordination: SecretaryCoordinationModel;
}

function buildEmptyDailyBriefDay(date: string, language?: string): WeeklyPlanDay {
  const localizedWeekday = localizedDailyBriefWeekday(date, language);
  return {
    date,
    weekday: localizedWeekday,
    headline: localizeDailyBriefFallback(
      language,
      'O briefing diário está indisponível porque o contexto desta conta não é válido para este pedido.',
      'O briefing diário está indisponível porque o contexto desta conta não é válido para este pedido.',
      'Daily brief unavailable because tenant scope is invalid for this request.',
    ),
    training: {
      title: localizeDailyBriefFallback(language, 'Briefing indisponível', 'Briefing indisponível', 'Brief unavailable'),
      type: 'gated',
      status: 'gated',
      durationMinutes: null,
      intensity: null,
      reason: localizeDailyBriefFallback(
        language,
        'O contexto da conta não é válido, por isso o briefing diário ignorou leituras de planeamento do utilizador.',
        'O contexto da conta não é válido, por isso o briefing diário ignorou leituras de planeamento do utilizador.',
        'Tenant scope is invalid, so the daily brief skipped user-owned planning reads.',
      ),
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

function buildEmptyDailyBriefResponse(opts: { userId: number; date?: string; language?: string }): DailyBriefResponse {
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
    day: buildEmptyDailyBriefDay(targetDate, opts.language),
    coordination: {
      topPriority: null,
      executionOrder: [],
      watchouts: [],
      handoffs: [],
      confidence: 'low',
      dayOrchestration: {
        posture: 'stable_day',
        title: localizeDailyBriefFallback(
          opts.language,
          'Orquestração diária indisponível.',
          'Orquestração diária indisponível.',
          'Daily orchestration unavailable.',
        ),
        summary: localizeDailyBriefFallback(
          opts.language,
          'Não foi possível montar uma postura de agenda fiável para este pedido.',
          'Não foi possível montar uma postura de agenda fiável para este pedido.',
          'No reliable scheduling posture could be built for this request.',
        ),
        confidence: 'low',
        mainThing: null,
        reasons: [],
        affectedSkills: ['secretary'],
      },
      weekOrchestration: {
        posture: 'stable',
        title: localizeDailyBriefFallback(
          opts.language,
          'Orquestração semanal indisponível.',
          'Orquestração semanal indisponível.',
          'Weekly orchestration unavailable.',
        ),
        summary: localizeDailyBriefFallback(
          opts.language,
          'Não foi possível montar uma postura semanal fiável para este pedido.',
          'Não foi possível montar uma postura semanal fiável para este pedido.',
          'No reliable weekly posture could be built for this request.',
        ),
        confidence: 'low',
        reasons: [],
        affectedSkills: ['secretary'],
      },
      nextBestAction: null,
      blockers: [],
      suggestedMoves: [],
      protectedBlocks: [],
      risks: [],
      crossSkillImpacts: [],
    },
  };
}

function buildUnavailableDailyBriefDay(date: string, language?: string): WeeklyPlanDay {
  const localizedWeekday = localizedDailyBriefWeekday(date, language);
  return {
    date,
    weekday: localizedWeekday,
    headline: localizeDailyBriefFallback(
      language,
      'O briefing diário está temporariamente indisponível. Mostramos um estado seguro até a orquestração recuperar.',
      'O briefing diário está temporariamente indisponível. Mostramos um estado seguro até a orquestração recuperar.',
      'The daily brief is temporarily unavailable. Showing a safe fallback until orchestration recovers.',
    ),
    training: {
      title: localizeDailyBriefFallback(language, 'Briefing indisponível', 'Briefing indisponível', 'Brief unavailable'),
      type: 'gated',
      status: 'gated',
      durationMinutes: null,
      intensity: null,
      reason: localizeDailyBriefFallback(
        language,
        'A orquestração diária falhou antes de consolidar as leituras necessárias.',
        'A orquestração diária falhou antes de consolidar as leituras necessárias.',
        'Daily orchestration failed before it could consolidate the required reads.',
      ),
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

function buildUnavailableDailyBriefResponse(opts: { userId: number; date?: string; language?: string }): DailyBriefResponse {
  const targetDate = resolveTargetDate(opts.date);
  return {
    ...buildEmptyDailyBriefResponse(opts),
    date: targetDate,
    generatedAt: new Date().toISOString(),
    day: buildUnavailableDailyBriefDay(targetDate, opts.language),
    coordination: {
      topPriority: null,
      executionOrder: [],
      watchouts: [],
      handoffs: [],
      confidence: 'low',
      dayOrchestration: {
        posture: 'stable_day',
        title: localizeDailyBriefFallback(
          opts.language,
          'Orquestração diária temporariamente indisponível.',
          'Orquestração diária temporariamente indisponível.',
          'Daily orchestration temporarily unavailable.',
        ),
        summary: localizeDailyBriefFallback(
          opts.language,
          'Não foi possível consolidar o plano do dia de forma fiável. Voltámos para um fallback seguro.',
          'Não foi possível consolidar o plano do dia de forma fiável. Voltámos para um fallback seguro.',
          'The day plan could not be consolidated reliably. Falling back to a safe shell.',
        ),
        confidence: 'low',
        mainThing: null,
        reasons: [],
        affectedSkills: ['secretary'],
      },
      weekOrchestration: {
        posture: 'stable',
        title: localizeDailyBriefFallback(
          opts.language,
          'Orquestração semanal temporariamente indisponível.',
          'Orquestração semanal temporariamente indisponível.',
          'Weekly orchestration temporarily unavailable.',
        ),
        summary: localizeDailyBriefFallback(
          opts.language,
          'A semana não pôde ser consolidada com dados suficientes nesta tentativa.',
          'A semana não pôde ser consolidada com dados suficientes nesta tentativa.',
          'The week could not be consolidated with enough data on this attempt.',
        ),
        confidence: 'low',
        reasons: [],
        affectedSkills: ['secretary'],
      },
      nextBestAction: null,
      blockers: [],
      suggestedMoves: [],
      protectedBlocks: [],
      risks: [],
      crossSkillImpacts: [],
    },
  };
}

export async function composeDailyBrief(opts: {
  userId: number;
  date?: string;
  language?: string;
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
  const languageBucket = resolveLanguageBucket(opts.language);
  const cacheKey = `plan:today:u:${opts.userId}:${targetDate}:${languageBucket}`;
  if (!opts.forceRefresh) {
    const cached = getCached<DailyBriefResponse>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  try {
    const weekPlan = await composeWeeklyPlan({
      userId: opts.userId,
      weekStart: weekStartForDate(targetDate),
      forceRefresh: opts.forceRefresh,
    });

    const fallbackDay = buildUnavailableDailyBriefDay(targetDate, opts.language);
    const day = weekPlan.days.find((entry) => entry.date === targetDate) ?? fallbackDay;
    const conflicts = weekPlan.conflicts.filter((conflict) => conflict.date === targetDate);
    let coordination = buildUnavailableDailyBriefResponse(opts).coordination;
    let coordinationDegraded = day === fallbackDay;

    if (!coordinationDegraded) {
      try {
        coordination = buildDailyCoordination({
          date: targetDate,
          day,
          weekPlan,
          conflicts,
          language: opts.language,
        });
      } catch (err) {
        coordinationDegraded = true;
        logger.warn(
          { err, userId: opts.userId, date: targetDate },
          'daily brief coordination build failed — returning empty coordination shell',
        );
      }
    }

    const response: DailyBriefResponse = {
      date: targetDate,
      generatedAt: new Date().toISOString(),
      degraded: weekPlan.degraded || coordinationDegraded,
      gated: weekPlan.gated,
      garmin_stale: weekPlan.garmin_stale,
      conflicts,
      creativeCopy: weekPlan.creativeCopy,
      day,
      coordination,
    };

    setCache(cacheKey, response, 1800);
    return response;
  } catch (err) {
    logger.warn(
      { err, userId: opts.userId, date: targetDate },
      'daily brief weekly-plan compose failed — returning degraded fallback',
    );
    return buildUnavailableDailyBriefResponse(opts);
  }
}

function buildDailyCoordination(opts: {
  date: string;
  day: WeeklyPlanDay;
  weekPlan: WeeklyPlanResponse;
  conflicts: WeeklyPlanResponse['conflicts'];
  language?: string;
}): DailyBriefResponse['coordination'] {
  const coordination = buildSecretaryCoordination({
    date: opts.date,
    day: opts.day,
    weekPlan: {
      days: opts.weekPlan.days,
      conflicts: opts.weekPlan.conflicts,
      variant: opts.weekPlan.variant,
    },
    conflicts: opts.conflicts,
    language: opts.language,
  });

  return {
    ...coordination,
    executionOrder: coordination.executionOrder.length > 0
      ? coordination.executionOrder
      : opts.day.secretary.sequence.slice(0, 5),
    watchouts: coordination.watchouts.length > 0
      ? coordination.watchouts
      : compact([
        opts.day.training.status === 'adjusted' ? opts.day.training.reason : null,
        opts.day.secretary.tradeoffNote,
        opts.conflicts[0]?.message ?? null,
        opts.day.finance?.budgetNote && /budget/i.test(opts.day.finance.budgetNote) ? opts.day.finance.budgetNote : null,
        opts.day.content?.status === 'blocked' ? opts.day.content.note : null,
      ]),
    handoffs: coordination.handoffs.length > 0
      ? coordination.handoffs
      : compact([
        opts.day.meals.some((meal) => meal.title === 'Fueling coverage missing')
          ? 'Training depends on meal coverage landing before the key session.'
          : null,
        opts.day.content?.status === 'scheduled' && opts.day.training.status !== 'rest'
          ? 'Content should follow the protected training and fueling commitments instead of displacing them.'
          : null,
        opts.day.content?.status === 'scheduled' && opts.day.finance?.budgetNote
          ? 'Keep the content execution path aligned with the current finance constraints for the week.'
          : null,
      ]),
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

function resolveLanguageBucket(language?: string): string {
  if (typeof language !== 'string' || language.trim().length === 0) return 'en';
  const normalized = language.trim().toLowerCase();
  if (normalized.startsWith('pt-br')) return 'pt-br';
  if (normalized.startsWith('pt')) return 'pt';
  return 'en';
}

function localizeDailyBriefFallback(language: string | undefined, ptPt: string, ptBr: string, en: string): string {
  const bucket = resolveLanguageBucket(language);
  if (bucket === 'pt-br') return ptBr;
  if (bucket === 'pt') return ptPt;
  return en;
}

function localizedDailyBriefWeekday(date: string, language?: string): string {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const parsed = DateTime.fromISO(date, { zone }).startOf('day');
  const locale = resolveLanguageBucket(language) === 'pt-br'
    ? 'pt-BR'
    : resolveLanguageBucket(language) === 'pt'
      ? 'pt-PT'
      : 'en-US';
  return (parsed.isValid ? parsed : DateTime.now().setZone(zone))
    .setLocale(locale)
    .toFormat('cccc');
}
