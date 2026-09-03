// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { getCached, setCache } from './cache-store';
import { CONTENT_AGENT_LIFECYCLE_POLICY_VERSION } from './content-agent-lifecycle';
import { safeContentLogErrorFields } from './content-log-safety';
import {
  composeWeeklyPlan,
  CONTENT_PLAN_PROJECTION_VERSION,
  hasConfirmedPrivateContentBlock,
  type WeeklyPlanDay,
  type WeeklyPlanResponse,
} from './weekly-plan-orchestrator';
import {
  buildSecretaryCoordination,
  type SecretaryCoordinationModel,
  type SecretaryTodayEntryModel,
  type SecretaryTodayDecisionSignals,
  type SecretaryTodaySummaryModel,
} from './secretary-orchestrator';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { logger } from '../utils/logger';
import {
  assertSecretaryPlanningContextMatches,
  mergePlanWarnings,
  resolveSecretaryPlanningContext,
  SecretaryPlanningContextError,
  unavailablePlanSource,
  type DailyPlanSourceHealth,
  type PlanSourceHealth,
  type SecretaryPlanningContext,
} from './secretary-planning-context';
import {
  buildSecretaryDaySnapshot,
  unavailableWeeklyPlanSourceHealth,
  withDecisionCenterHealth,
  type SecretaryDaySnapshot,
} from './secretary-planning-snapshot';
import { readSecretaryDecisionProjection } from './secretary-decision-center-read-adapter';

export interface DailyBriefResponse {
  date: string;
  generatedAt: string;
  timezone: string;
  warningCodes: string[];
  warnings: string[];
  sourceHealth: DailyPlanSourceHealth;
  degraded: boolean;
  gated: { skills: string[] };
  garmin_stale: boolean;
  conflicts: WeeklyPlanResponse['conflicts'];
  creativeCopy: WeeklyPlanResponse['creativeCopy'];
  contentPlan: WeeklyPlanResponse['contentPlan'];
  day: WeeklyPlanDay;
  coordination: SecretaryCoordinationModel;
}

function buildEmptyDailyBriefDay(date: string, language?: string, timezone = 'Europe/Lisbon'): WeeklyPlanDay {
  const localizedWeekday = localizedDailyBriefWeekday(date, language, timezone);
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
    cooking: {
      status: 'unavailable',
      headline: 'Cooking plan unavailable for this day.',
      warningCodes: ['COOKING_CONTEXT_UNAVAILABLE'],
    },
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

function buildEmptyDailyBriefResponse(opts: {
  userId: number;
  date?: string;
  language?: string;
  timezone?: string;
}): DailyBriefResponse {
  const timezone = opts.timezone ?? 'Europe/Lisbon';
  const targetDate = resolveTargetDate(opts.date, timezone);
  const sourceHealth = withDecisionCenterHealth(
    unavailableWeeklyPlanSourceHealth(),
    unavailablePlanSource('DECISION_CENTER_UNAVAILABLE', 'Decision Center state is unavailable.'),
  );
  return {
    date: targetDate,
    generatedAt: new Date().toISOString(),
    timezone,
    warningCodes: ['PLANNING_COMPOSITION_UNAVAILABLE'],
    warnings: ['Planning state is unavailable because the canonical composition did not complete.'],
    sourceHealth,
    degraded: true,
    gated: { skills: [] },
    garmin_stale: false,
    conflicts: [],
    creativeCopy: {
      headline: '',
      note: '',
    },
    contentPlan: {
      authority: 'secretary',
      authorityStatus: 'unavailable',
      planStatus: 'unavailable',
      semantics: 'private_work_session',
      confirmedBlockCount: 0,
      confirmedBlocksComplete: false,
      attentionCount: 0,
      deadlineCount: 0,
    },
    day: buildEmptyDailyBriefDay(targetDate, opts.language, timezone),
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
      secretaryToday: emptySecretaryTodaySummary(opts.language),
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

function buildUnavailableDailyBriefDay(date: string, language?: string, timezone = 'Europe/Lisbon'): WeeklyPlanDay {
  const localizedWeekday = localizedDailyBriefWeekday(date, language, timezone);
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
    cooking: {
      status: 'unavailable',
      headline: 'Cooking plan unavailable for this day.',
      warningCodes: ['COOKING_CONTEXT_UNAVAILABLE'],
    },
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

function buildUnavailableDailyBriefResponse(opts: {
  userId: number;
  date?: string;
  language?: string;
  timezone?: string;
}): DailyBriefResponse {
  const timezone = opts.timezone ?? 'Europe/Lisbon';
  const targetDate = resolveTargetDate(opts.date, timezone);
  return {
    ...buildEmptyDailyBriefResponse(opts),
    date: targetDate,
    generatedAt: new Date().toISOString(),
    day: buildUnavailableDailyBriefDay(targetDate, opts.language, timezone),
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
      secretaryToday: emptySecretaryTodaySummary(opts.language),
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
  tenantId?: number;
  date?: string;
  language?: string;
  timezone?: string;
  context?: SecretaryPlanningContext;
  daySnapshot?: SecretaryDaySnapshot;
  forceRefresh?: boolean;
  cacheMode?: 'read-write' | 'bypass';
  /** Recompute supplies its exact weekly snapshot so daily never re-reads. */
  weekPlan?: WeeklyPlanResponse;
}): Promise<DailyBriefResponse> {
  let context: SecretaryPlanningContext;
  try {
    if (opts.context) {
      assertSecretaryPlanningContextMatches(opts.context, opts);
      context = opts.context;
    } else {
      context = resolveSecretaryPlanningContext({
        userId: opts.userId,
        tenantId: opts.tenantId,
        date: opts.date,
        language: opts.language,
      });
    }
  } catch (error) {
    if (!(error instanceof SecretaryPlanningContextError)
      || !['INVALID_SCOPE', 'TENANT_SCOPE_MISMATCH'].includes(error.code)) {
      throw error;
    }
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: error.code === 'TENANT_SCOPE_MISMATCH'
        ? 'compose_daily_brief_tenant_scope'
        : 'compose_daily_brief',
      reason: error.code === 'TENANT_SCOPE_MISMATCH' ? 'tenant_mismatch' : 'invalid_user_scope',
      userId: isValidTenantUserId(opts.userId) ? opts.userId : opts.userId ?? null,
      details: {
        tenantId: opts.tenantId ?? null,
        date: opts.date ?? null,
      },
    });
    throw error;
  }
  const tenantId = context.tenantId;
  const targetDate = context.targetDate;
  const suppliedWeekPlan = opts.weekPlan ?? opts.daySnapshot?.week;
  if (opts.daySnapshot && suppliedWeekPlan) {
    assertDaySnapshotMatchesContext(opts.daySnapshot, context, suppliedWeekPlan);
  }
  const cacheKey = [
    'plan', 'today', 'u', opts.userId, 't', tenantId, targetDate,
    'tz', context.timezone, 'lang', context.language,
    'content-policy', CONTENT_AGENT_LIFECYCLE_POLICY_VERSION,
    'projection', CONTENT_PLAN_PROJECTION_VERSION,
  ].join(':');
  const ownsCache = opts.cacheMode !== 'bypass';
  // A caller-supplied week is the canonical input for this composition. Do not
  // let an independently cached Today response replace that exact snapshot.
  if (ownsCache && !opts.forceRefresh && !opts.weekPlan && !opts.daySnapshot) {
    const cached = getCached<DailyBriefResponse>(cacheKey);
    if (cached) {
      return normalizeCachedDailyBrief(cached, context);
    }
  }

  try {
    const weekPlan = suppliedWeekPlan ?? await composeWeeklyPlan({
      userId: opts.userId,
      tenantId,
      weekStart: context.weekStart,
      language: context.language,
      context,
      forceRefresh: opts.forceRefresh,
      cacheMode: opts.cacheMode,
    });
    const snapshot = opts.daySnapshot ?? buildSecretaryDaySnapshot({ context, week: weekPlan });
    const fallbackDay = buildUnavailableDailyBriefDay(targetDate, context.language, context.timezone);
    const day = snapshot.day ?? fallbackDay;
    const conflicts = snapshot.conflicts;
    const decisionState = readSecretaryDecisionProjection(opts.userId, tenantId);
    const sourceHealth = withDecisionCenterHealth(snapshot.sourceHealth, decisionState.health);
    const warningMetadata = mergePlanWarnings(context, sourceHealth, {
      warningCodes: snapshot.warningCodes,
      warnings: snapshot.warnings,
    });
    let coordination = buildUnavailableDailyBriefResponse({
      ...opts,
      language: context.language,
      timezone: context.timezone,
    }).coordination;
    let coordinationDegraded = snapshot.day == null;

    if (!coordinationDegraded) {
      try {
        coordination = buildDailyCoordination({
          date: targetDate,
          day,
          weekPlan,
          conflicts,
          language: context.language,
          secretaryTodaySignals: decisionState.signals,
        });
        coordination = applySourceHealthToCoordination(coordination, sourceHealth, context.language);
      } catch (err) {
        coordinationDegraded = true;
        logger.warn(
          { ...safeContentLogErrorFields(err), userId: opts.userId, date: targetDate },
          'daily brief coordination build failed — returning empty coordination shell',
        );
      }
    }

    const response: DailyBriefResponse = {
      date: targetDate,
      generatedAt: weekPlan.generatedAt ?? new Date().toISOString(),
      timezone: context.timezone,
      warningCodes: warningMetadata.warningCodes,
      warnings: warningMetadata.warnings,
      sourceHealth,
      degraded: weekPlan.degraded || coordinationDegraded || decisionState.health.status !== 'ready',
      gated: weekPlan.gated,
      garmin_stale: weekPlan.garmin_stale,
      conflicts,
      creativeCopy: weekPlan.creativeCopy,
      contentPlan: weekPlan.contentPlan,
      day,
      coordination,
    };

    if (ownsCache) setCache(cacheKey, response, 1800);
    return response;
  } catch (err) {
    // Scope/date contract errors are caller errors, not source-health
    // degradation. Returning a fallback here would hide a cross-account
    // snapshot mismatch and let an internal caller treat the request as a
    // successful (albeit degraded) plan.
    if (err instanceof SecretaryPlanningContextError) throw err;
    logger.warn(
      { ...safeContentLogErrorFields(err), userId: opts.userId, date: targetDate },
      'daily brief weekly-plan compose failed — returning degraded fallback',
    );
    return buildUnavailableDailyBriefResponse({
      ...opts,
      language: context.language,
      timezone: context.timezone,
    });
  }
}

function assertDaySnapshotMatchesContext(
  snapshot: SecretaryDaySnapshot,
  context: SecretaryPlanningContext,
  weekPlan: WeeklyPlanResponse,
): void {
  if (snapshot.week !== weekPlan
      || snapshot.context.userId !== context.userId
      || snapshot.context.tenantId !== context.tenantId
      || snapshot.context.timezone !== context.timezone
      || snapshot.context.language !== context.language
      || snapshot.date !== context.targetDate) {
    throw new SecretaryPlanningContextError(
      'TENANT_SCOPE_MISMATCH',
      'Secretary day snapshot does not match the active planning context.',
    );
  }
}

function normalizeCachedDailyBrief(
  cached: DailyBriefResponse,
  context: SecretaryPlanningContext,
): DailyBriefResponse {
  const legacy = cached as DailyBriefResponse & {
    timezone?: string;
    warningCodes?: string[];
    warnings?: string[];
    sourceHealth?: DailyPlanSourceHealth;
  };
  if (legacy.timezone && legacy.warningCodes && legacy.warnings && legacy.sourceHealth) {
    return cached;
  }
  const sourceHealth = legacy.sourceHealth ?? withDecisionCenterHealth(
    unavailableWeeklyPlanSourceHealth(),
    unavailablePlanSource(
      'DECISION_CENTER_STATE_UNAVAILABLE',
      'Decision Center state is unavailable.',
    ),
  );
  return {
    ...cached,
    timezone: legacy.timezone ?? context.timezone,
    warningCodes: [...new Set([
      ...(legacy.warningCodes ?? []),
      'PLANNING_SOURCE_HEALTH_UNAVAILABLE',
    ])],
    warnings: [...new Set([
      ...(legacy.warnings ?? []),
      'Cached planning data predates source-health metadata and cannot be treated as fully current.',
    ])],
    sourceHealth,
    degraded: true,
  };
}

function buildDailyCoordination(opts: {
  date: string;
  day: WeeklyPlanDay;
  weekPlan: WeeklyPlanResponse;
  conflicts: WeeklyPlanResponse['conflicts'];
  language?: string;
  secretaryTodaySignals?: SecretaryTodayDecisionSignals;
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
    secretaryTodaySignals: opts.secretaryTodaySignals,
    sourceHealth: opts.weekPlan.sourceHealth,
  });
  const hasConfirmedContentBlock = hasConfirmedPrivateContentBlock(opts.day.content);

  return {
    ...coordination,
    executionOrder: coordination.executionOrder.length > 0
      ? coordination.executionOrder
      : opts.day.secretary.sequence.slice(0, 3),
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
        hasConfirmedContentBlock && opts.day.training.status !== 'rest'
          ? 'A Secretary-confirmed private Content work block is reserved today; reconcile any overlap without treating it as publication.'
          : null,
        hasConfirmedContentBlock && opts.day.finance?.budgetNote
          ? 'Keep the confirmed private Content work block aligned with the current finance constraints without implying a delivery commitment.'
          : null,
      ]),
  };
}

function applySourceHealthToCoordination(
  coordination: DailyBriefResponse['coordination'],
  sourceHealth: DailyPlanSourceHealth,
  language: string,
): DailyBriefResponse['coordination'] {
  const calendarReady = sourceHealth.calendar.status === 'ready';
  const tasksReady = sourceHealth.tasks.status === 'ready';
  const mailReady = sourceHealth.mail.status === 'ready';
  const checked = coordination.secretaryToday.checked.filter((entry) => {
    if (!calendarReady && (entry.id === 'agenda-sync' || entry.id === 'conflict-scan')) return false;
    if ((!tasksReady || !mailReady) && entry.id === 'reminder-pressure') return false;
    return true;
  });
  const waiting = [...coordination.secretaryToday.waitingOnSource];
  const healthEntries = Object.entries(sourceHealth)
    .filter(([, health]) => health.status !== 'ready' && !isGatedHealth(health))
    .map(([source, health]) => sourceHealthWaitingEntry(source, health, language));
  for (const entry of healthEntries) {
    if (!waiting.some((existing) => existing.id === entry.id)) waiting.push(entry);
  }
  const sourceStateIncomplete = healthEntries.length > 0;
  const secretaryToday = {
    ...coordination.secretaryToday,
    checked,
    waitingOnSource: waiting,
    summary: sourceStateIncomplete
      ? localizeDailyBriefFallback(
          language,
          'A Secretary montou o melhor estado possível, mas uma ou mais fontes ainda precisam de confirmar dados.',
          'A Secretary montou o melhor estado possível, mas uma ou mais fontes ainda precisam confirmar dados.',
          'Secretary built the best available state, but one or more sources still need to confirm data.',
        )
      : coordination.secretaryToday.summary,
    counts: {
      ...coordination.secretaryToday.counts,
      checked: checked.length,
      waitingOnSource: waiting.length,
    },
  };

  return {
    ...coordination,
    confidence: sourceStateIncomplete ? 'low' : coordination.confidence,
    secretaryToday,
    dayOrchestration: !calendarReady
      ? {
          ...coordination.dayOrchestration,
          title: localizeDailyBriefFallback(
            language,
            'O plano de hoje precisa de confirmação da agenda.',
            'O plano de hoje precisa de confirmação da agenda.',
            'Today’s plan needs calendar confirmation.',
          ),
          summary: localizeDailyBriefFallback(
            language,
            'A agenda atual não pôde ser confirmada, por isso nenhuma janela livre é tratada como segura.',
            'A agenda atual não pôde ser confirmada, por isso nenhuma janela livre é tratada como segura.',
            'Current calendar state could not be confirmed, so no free window is treated as safe.',
          ),
          confidence: 'low',
          mainThing: null,
        }
      : sourceStateIncomplete
        ? { ...coordination.dayOrchestration, confidence: 'low' }
        : coordination.dayOrchestration,
    weekOrchestration: sourceStateIncomplete
      ? { ...coordination.weekOrchestration, confidence: 'low' }
      : coordination.weekOrchestration,
  };
}

function sourceHealthWaitingEntry(
  source: string,
  health: PlanSourceHealth,
  language: string,
): SecretaryTodayEntryModel {
  const label = localizeDailyBriefFallback(
    language,
    `${sourceHealthLabel(source, 'pt')} por confirmar`,
    `${sourceHealthLabel(source, 'pt')} por confirmar`,
    `${sourceHealthLabel(source, 'en')} needs confirmation`,
  );
  return {
    id: `source-health-${source}`,
    label,
    detail: health.warnings[0] ?? localizeDailyBriefFallback(
      language,
      'Esta fonte ainda não tem estado atual fiável.',
      'Esta fonte ainda não tem estado atual confiável.',
      'This source does not have reliable current state yet.',
    ),
    status: 'waiting_on_source',
    source: 'source_health',
  };
}

function sourceHealthLabel(source: string, language: 'pt' | 'en'): string {
  const labels: Record<string, { pt: string; en: string }> = {
    calendar: { pt: 'Agenda', en: 'Calendar' },
    tasks: { pt: 'Tarefas', en: 'Tasks' },
    mail: { pt: 'Email', en: 'Mail' },
    focus: { pt: 'Foco', en: 'Focus' },
    training: { pt: 'Treino', en: 'Training' },
    cooking: { pt: 'Cozinha', en: 'Cooking' },
    content: { pt: 'Conteúdo', en: 'Content' },
    finance: { pt: 'Finanças', en: 'Finance' },
    decision_center: { pt: 'Centro de Decisões', en: 'Decision Center' },
  };
  return labels[source]?.[language] ?? source;
}

function isGatedHealth(health: PlanSourceHealth): boolean {
  return health.warningCodes.some((code) => code.endsWith('_SKILL_GATED'));
}

function emptySecretaryTodaySummary(language?: string): SecretaryTodaySummaryModel {
  return {
    title: localizeDailyBriefFallback(language, 'Secretary hoje', 'Secretary hoje', 'Secretary today'),
    summary: localizeDailyBriefFallback(
      language,
      'A orquestração diária ainda não tem estado operacional fiável para mostrar.',
      'A orquestração diária ainda não tem estado operacional fiável para mostrar.',
      'Daily orchestration does not have reliable operational state to show yet.',
    ),
    checked: [],
    handled: [],
    needsUser: [],
    waitingOnSource: [],
    nextBestMove: null,
    counts: {
      checked: 0,
      handled: 0,
      needsUser: 0,
      waitingOnSource: 0,
    },
  };
}

function compact(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && value.trim().length > 0));
}

function resolveTargetDate(date?: string, timezone = 'Europe/Lisbon', fallbackLocalDate?: string): string {
  const zone = timezone;
  const parsed = date
    ? DateTime.fromISO(date, { zone }).startOf('day')
    : DateTime.fromISO(fallbackLocalDate ?? '', { zone }).startOf('day');
  return (parsed.isValid ? parsed : DateTime.now().setZone(zone)).toISODate()!;
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

function localizedDailyBriefWeekday(date: string, language?: string, timezone = 'Europe/Lisbon'): string {
  const zone = timezone;
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
