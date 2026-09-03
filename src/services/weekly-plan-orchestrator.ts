// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { buildEditorialCoordinationSignals } from '../agents/editorial-coordinator-agent';
import { getCached, setCache } from './cache-store';
import { CONTENT_AGENT_LIFECYCLE_POLICY_VERSION } from './content-agent-lifecycle';
import { safeContentLogErrorFields } from './content-log-safety';
import {
  canConsumeConfirmedContentWorkSchedule,
  createEmptySecretaryMeshContext,
  createEmptyTrainingMeshContext,
  readContentMeshContext,
  readCookingMeshContext,
  readFinanceMeshContext,
  readSecretaryMeshContext,
  readTrainingMeshContext,
  type ContentMeshContext,
  type CookingCalendarStatus,
  type ContentMeshUnavailableSection,
  type ContentWorkPlanStatus,
  type CookingMeshContext,
  type FinanceMeshContext,
  type MeshSignalDraft,
  type SecretaryMeshContext,
  type TrainingMeshContext,
} from './cross-agent-learning';
import { isUserOverDailyCap } from './cost-guardrail';
import { getDb } from './database';
import {
  readSignals,
  reconcileGovernedSignalSet,
  runSignalWriteTransaction,
  writeGovernedSignal,
  type AgentSignal,
  type MeshPriority,
  type SignalType,
} from './intelligence-bus';
import {
  defaultMeshPriorityForSignal,
  resolveDirectiveMatrix,
  type ConflictNote,
  type MeshDirective,
} from './conflict-resolver';
import { formatCurrencyAmount } from './finance-tracker';
import { logger } from '../utils/logger';
import { entitlementPlanToSkillTier, getEffectiveEntitlement } from './entitlement';
import { checkSkillAccess } from './skill-tiers';
import { getWeeksForPlan, getWeeklyAdherence, type TrainingSession } from './training-plans';
import { resolveTrainingPlanTimezone, resolveTrainingTimezone } from './training-date-utils';
import type { MealPlan } from './cooking-chef';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import {
  assertSecretaryPlanningContextMatches,
  mergePlanWarnings,
  planLanguageLocale,
  readyPlanSource,
  resolveSecretaryPlanningContext,
  SecretaryPlanningContextError,
  unavailablePlanSource,
  type PlanSourceHealth,
  type SecretaryPlanningContext,
  type WeeklyPlanSourceHealth,
} from './secretary-planning-context';
import { unavailableWeeklyPlanSourceHealth } from './secretary-planning-snapshot';

const WEEKLY_PLAN_SIGNAL_PRODUCER_VERSION = 'weekly-plan-orchestrator.v1';
/** Bump whenever the externally cached weekly/daily Content plan shape changes. */
export const CONTENT_PLAN_PROJECTION_VERSION = 'content-plan.v4';

export interface PlanDecision {
  summary: string;
  signalId: number | string;
  signalType: SignalType;
  meshPriority: MeshPriority;
}

export interface WeeklyPlanTrainingItem {
  title: string;
  type: string;
  status: 'planned' | 'adjusted' | 'rest' | 'gated';
  durationMinutes: number | null;
  intensity: string | null;
  reason: string;
  decisions: PlanDecision[];
}

export interface WeeklyPlanMealItem {
  mealType: string;
  title: string;
  note: string;
  decisions: PlanDecision[];
}

export interface WeeklyPlanCookingSummary {
  status: 'ready' | 'empty' | 'degraded' | 'unavailable' | 'gated';
  headline: string;
  warningCodes: string[];
}

export interface WeeklyPlanContentItem {
  status: 'scheduled' | 'advisory' | 'blocked' | 'gated';
  planStatus: ContentWorkPlanStatus;
  scheduleAuthority: 'secretary';
  scheduleAuthorityStatus: 'current' | 'partially_unavailable' | 'unavailable';
  scheduleSemantics:
    | 'private_work_session'
    | 'target_date_not_publication'
    | 'proposal_not_calendar_reservation'
    | 'unavailable';
  title: string;
  note: string;
  blockStart: string | null;
  blockEnd: string | null;
  /** Every current Secretary-confirmed private block on this date. */
  confirmedBlocks: Array<{
    itemId: number;
    title: string;
    /** Per-block authority remains current even when the bounded day projection is partial. */
    authorityStatus: 'current';
    /** Explicit confirmation marker for downstream fail-closed consumers. */
    confirmationStatus: 'confirmed';
    itemStatus: NonNullable<ContentMeshContext['workSchedule']['confirmedBlocks'][number]['itemStatus']> | null;
    outcome: string | null;
    estimatedEffortMinutes: number | null;
    dependency: NonNullable<ContentMeshContext['workSchedule']['confirmedBlocks'][number]['dependency']> | null;
    approvalState: NonNullable<ContentMeshContext['workSchedule']['confirmedBlocks'][number]['approvalState']> | null;
    nextAction: NonNullable<ContentMeshContext['workSchedule']['confirmedBlocks'][number]['nextAction']> | null;
    startsAt: string;
    endsAt: string;
    workKind: ContentMeshContext['workSchedule']['confirmedBlocks'][number]['workKind'];
    state: ContentMeshContext['workSchedule']['confirmedBlocks'][number]['state'];
    contentChangedSinceScheduling: boolean;
  }>;
  decisions: PlanDecision[];
}

export interface WeeklyPlanContentScheduleSummary {
  authority: 'secretary';
  authorityStatus: 'current' | 'partially_unavailable' | 'unavailable';
  planStatus: ContentWorkPlanStatus;
  semantics: 'private_work_session';
  confirmedBlockCount: number;
  confirmedBlocksComplete: boolean;
  attentionCount: number;
  deadlineCount: number;
}

export interface WeeklyPlanSecretaryItem {
  focusBlock: {
    start: string;
    end: string;
    note: string;
  } | null;
  pendingTasks: number;
  overdueTasks: number;
  tasksDueOnDate?: number;
  mailUnreadTotal?: number;
  calendarEventCount?: number;
  fragmented?: boolean;
  criticalMeetingCount?: number;
  movableTaskCount?: number;
  fixedTaskCount?: number;
  portableTaskRatio?: number;
  writableCalendar?: boolean;
  travel: boolean;
  busy: boolean;
  priorityNote: string | null;
  sequence: string[];
  tradeoffNote: string | null;
  decisions: PlanDecision[];
}

export interface WeeklyPlanFinanceItem {
  budgetNote: string | null;
  taxNote: string | null;
  subscriptionNote: string | null;
  decisions: PlanDecision[];
}

export interface WeeklyPlanDay {
  date: string;
  weekday: string;
  headline: string;
  training: WeeklyPlanTrainingItem;
  meals: WeeklyPlanMealItem[];
  /** Source-aware Cooking state so an outage is never rendered as an empty plan. */
  cooking?: WeeklyPlanCookingSummary;
  content: WeeklyPlanContentItem | null;
  secretary: WeeklyPlanSecretaryItem;
  finance: WeeklyPlanFinanceItem | null;
}

export function isCurrentConfirmedPrivateContentBlock(
  block: WeeklyPlanContentItem['confirmedBlocks'][number] | null | undefined,
): boolean {
  return Boolean(
    block
    && block.authorityStatus === 'current'
    && block.confirmationStatus === 'confirmed'
    && block.startsAt
    && block.endsAt,
  );
}

/**
 * A partial top-level projection can still contain trustworthy, individually
 * confirmed blocks. Consumers must never infer that trust from the partial
 * aggregate alone; at least one block must carry current authority and an
 * explicit confirmed marker.
 */
export function hasConfirmedPrivateContentBlock(
  content: WeeklyPlanDay['content'],
): content is WeeklyPlanContentItem {
  return Boolean(
    content?.status === 'scheduled'
    && content.scheduleAuthority === 'secretary'
    && (
      content.scheduleAuthorityStatus === 'current'
      || content.scheduleAuthorityStatus === 'partially_unavailable'
    )
    && (content.planStatus === 'confirmed' || content.planStatus === 'partial')
    && content.scheduleSemantics === 'private_work_session'
    && content.blockStart
    && content.blockEnd
    && content.confirmedBlocks.some(isCurrentConfirmedPrivateContentBlock),
  );
}

export interface WeeklyPlanResponse {
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  timezone: string;
  warningCodes: string[];
  warnings: string[];
  sourceHealth: WeeklyPlanSourceHealth;
  variant: 'conservative' | 'steady' | 'push';
  degraded: boolean;
  gated: { skills: string[] };
  garmin_stale: boolean;
  conflicts: ConflictNote[];
  creativeCopy: {
    headline: string;
    note: string;
  };
  contentPlan: WeeklyPlanContentScheduleSummary;
  summary: {
    sessionCount: number;
    mealCount: number;
    activeConflictCount: number;
  };
  days: WeeklyPlanDay[];
}

function unavailableContentPlan(): WeeklyPlanContentScheduleSummary {
  return {
    authority: 'secretary',
    authorityStatus: 'unavailable',
    planStatus: 'unavailable',
    semantics: 'private_work_session',
    confirmedBlockCount: 0,
    confirmedBlocksComplete: false,
    attentionCount: 0,
    deadlineCount: 0,
  };
}

function summarizeContentPlan(content: ContentMeshContext | null): WeeklyPlanContentScheduleSummary {
  if (!content) return unavailableContentPlan();
  if (!content.workSchedule) {
    return {
      ...unavailableContentPlan(),
      deadlineCount: content.deadlines?.length ?? 0,
    };
  }
  return {
    authority: content.workSchedule.authority,
    authorityStatus: content.workSchedule.authorityStatus,
    planStatus: content.workSchedule.planStatus,
    semantics: content.workSchedule.semantics,
    confirmedBlockCount: content.workSchedule.confirmedBlocks.length,
    confirmedBlocksComplete: content.workSchedule.confirmedBlocksComplete ?? true,
    attentionCount: content.workSchedule.attentionCount,
    deadlineCount: content.deadlines?.length ?? 0,
  };
}
async function loadMeshContextOrFallback<T>(opts: {
  label: string;
  userId: number;
  weekStart: string;
  loader: Promise<T>;
  fallback: T;
}): Promise<{ value: T; degraded: boolean }> {
  try {
    return {
      value: await opts.loader,
      degraded: false,
    };
  } catch (err) {
    logger.warn(
      {
        ...safeContentLogErrorFields(err),
        userId: opts.userId,
        weekStart: opts.weekStart,
        label: opts.label,
      },
      'weekly plan mesh context failed — falling back to empty context',
    );
    return {
      value: opts.fallback,
      degraded: true,
    };
  }
}

export async function composeWeeklyPlan(opts: {
  userId: number;
  tenantId?: number;
  weekStart?: string;
  timezone?: string;
  language?: string;
  context?: SecretaryPlanningContext;
  forceRefresh?: boolean;
  syncSignals?: boolean;
  /** Route-owned SWR callers bypass the orchestrator cache to avoid two owners. */
  cacheMode?: 'read-write' | 'bypass';
}): Promise<WeeklyPlanResponse> {
  let context: SecretaryPlanningContext;
  try {
    if (opts.context) {
      assertSecretaryPlanningContextMatches(opts.context, opts);
      context = opts.context;
    } else {
      context = resolveSecretaryPlanningContext({
        userId: opts.userId,
        tenantId: opts.tenantId,
        weekStart: opts.weekStart,
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
        ? 'compose_weekly_plan_tenant_scope'
        : 'compose_weekly_plan',
      reason: error.code === 'TENANT_SCOPE_MISMATCH' ? 'tenant_mismatch' : 'invalid_user_scope',
      userId: isValidTenantUserId(opts.userId) ? opts.userId : opts.userId ?? null,
      details: {
        tenantId: opts.tenantId ?? null,
        weekStart: opts.weekStart ?? null,
      },
    });
    throw error;
  }
  const tenantId = context.tenantId;
  const window = resolveWeekWindow(context.weekStart, context.timezone);
  const currentWeekStart = DateTime.fromISO(context.capturedAt, { setZone: true })
    .setZone(context.timezone)
    .startOf('week')
    .toISODate();
  // Durable mesh signals describe only the request clock's current local week.
  // Historical and future projections must not replace that active snapshot.
  const shouldSyncSignals = opts.syncSignals === true
    && window.weekStart === currentWeekStart;
  const cacheKey = [
    'plan', 'week', 'u', opts.userId, 't', tenantId, window.weekStart,
    'tz', context.timezone, 'lang', context.language,
    'sync', shouldSyncSignals ? '1' : '0',
    'content-policy', CONTENT_AGENT_LIFECYCLE_POLICY_VERSION,
    'projection', CONTENT_PLAN_PROJECTION_VERSION,
  ].join(':');
  const ownsCache = opts.cacheMode !== 'bypass';
  if (ownsCache && !opts.forceRefresh) {
    const cached = getCached<WeeklyPlanResponse>(cacheKey);
    if (cached) {
      return normalizeCachedWeeklyPlan(cached, context);
    }
  }

  const user = context.user;
  if (!user) {
    logger.warn(
      { userId: opts.userId },
      'weekly plan user record missing — failing closed for paid skill context',
    );
  }

  const gatedSkills = resolveGatedSkills(user);
  const degradedQuota = isUserOverDailyCap(opts.userId);
  const garminStale = isGarminMarkedStale(opts.userId);

  const [trainingLoad, secretaryLoad, cookingLoad, contentLoad, financeLoad] = await Promise.all([
    loadMeshContextOrFallback({
      label: 'training',
      userId: opts.userId,
      weekStart: window.weekStart,
      loader: readTrainingMeshContext({ userId: opts.userId, tenantId, weekStart: window.weekStart }),
      fallback: createEmptyTrainingMeshContext({ userId: opts.userId, weekStart: window.weekStart }),
    }),
    loadMeshContextOrFallback({
      label: 'secretary',
      userId: opts.userId,
      weekStart: window.weekStart,
      loader: readSecretaryMeshContext({
        userId: opts.userId,
        tenantId,
        weekStart: window.weekStart,
        timezone: context.timezone,
        referenceDate: context.targetDate,
      }),
      fallback: createEmptySecretaryMeshContext({ userId: opts.userId, weekStart: window.weekStart, timezone: context.timezone }),
    }),
    gatedSkills.includes('cooking')
      ? Promise.resolve<{ value: CookingMeshContext | null; degraded: boolean }>({ value: null, degraded: false })
      : loadMeshContextOrFallback<CookingMeshContext | null>({
          label: 'cooking',
          userId: opts.userId,
          weekStart: window.weekStart,
          loader: readCookingMeshContext({
            userId: opts.userId,
            tenantId,
            weekStart: window.weekStart,
            timezone: context.timezone,
          }),
          fallback: null,
        }),
    gatedSkills.includes('content')
      ? Promise.resolve<{ value: ContentMeshContext | null; degraded: boolean }>({ value: null, degraded: false })
      : loadMeshContextOrFallback<ContentMeshContext | null>({
          label: 'content',
          userId: opts.userId,
          weekStart: window.weekStart,
          loader: readContentMeshContext({
            userId: opts.userId,
            tenantId,
            weekStart: window.weekStart,
            timezone: context.timezone,
            referenceNow: context.capturedAt,
          }),
          fallback: null,
        }),
    gatedSkills.includes('finance')
      ? Promise.resolve<{ value: FinanceMeshContext | null; degraded: boolean }>({ value: null, degraded: false })
      : loadMeshContextOrFallback<FinanceMeshContext | null>({
          label: 'finance',
          userId: opts.userId,
          weekStart: window.weekStart,
          loader: readFinanceMeshContext({
            userId: opts.userId,
            tenantId,
            weekStart: window.weekStart,
            timezone: context.timezone,
            referenceNow: context.capturedAt,
          }),
          fallback: null,
        }),
  ]);
  const training = trainingLoad.value;
  const secretary = secretaryLoad.value;
  const cooking = cookingLoad.value;
  const content = contentLoad.value;
  const finance = financeLoad.value;
  const contentSnapshotDegraded = content != null && content.availability !== 'available';
  const contentUnavailableSections = new Set(content?.unavailableSections ?? []);
  const contentCalendarReliable = content != null && !contentUnavailableSections.has('calendar');
  const contentEditorialInputSections: readonly ContentMeshUnavailableSection[] = [
    'filming_recommendation',
    'content_desk',
    'pillars',
    'signals',
    'topics',
    'next_execution',
  ];
  const contentEditorialInputsReliable = content != null
    && contentEditorialInputSections.every((section) => !contentUnavailableSections.has(section));
  let orchestrationDegraded =
    trainingLoad.degraded
    || secretaryLoad.degraded
    || cookingLoad.degraded
    || contentLoad.degraded
    || contentSnapshotDegraded
    || financeLoad.degraded;
  if (cooking && !isCookingCalendarAvailabilityVerified(cooking.calendar?.status)) {
    orchestrationDegraded = true;
  }
  if (cooking && (!cooking.sourceHealth
      || !cooking.sourceHealth.safety
      || Object.values(cooking.sourceHealth).some((source) => source.status !== 'ready'))) {
    orchestrationDegraded = true;
  }

  const derivedSignalDrafts = [
    ...training.derivedSignals,
    ...secretary.derivedSignals,
    ...(cooking ? buildCookingMeshSignals(
      cooking,
      training,
      contentCalendarReliable ? content : null,
      context.capturedAt,
    ) : []),
    ...(content
      ? [
          ...content.derivedSignals,
          ...(contentEditorialInputsReliable
            ? buildEditorialCoordinationSignals({ content, secretary, training }).signals
            : []),
        ]
      : []),
    ...(finance ? finance.derivedSignals : []),
  ];
  const authoritativeSignalSources = new Set(derivedSignalDrafts.map((draft) => draft.sourceAgent));
  if (!trainingLoad.degraded) authoritativeSignalSources.add('mesh.training-context');
  if (!secretaryLoad.degraded) authoritativeSignalSources.add('mesh.secretary-context');
  if (!cookingLoad.degraded) authoritativeSignalSources.add('mesh.cooking-orchestrator');
  if (!contentLoad.degraded && content?.availability === 'available') {
    authoritativeSignalSources.add('mesh.content-context');
    authoritativeSignalSources.add('mesh.editorial-coordinator');
  }
  if (!financeLoad.degraded) authoritativeSignalSources.add('mesh.finance-context');
  const currentLocalDate = DateTime.fromISO(context.capturedAt, { zone: 'utc' })
    .setZone(context.timezone)
    .toISODate()!;
  const isHistoricalWindow = window.weekEnd < currentLocalDate;
  let meshSignals = new Map<SignalType, AgentSignal[]>();
  try {
    meshSignals = shouldSyncSignals && !isHistoricalWindow
      ? await syncDerivedSignals(
          opts.userId,
          tenantId,
          derivedSignalDrafts,
          context.capturedAt,
          authoritativeSignalSources,
        )
      : groupDerivedSignalDrafts(opts.userId, tenantId, derivedSignalDrafts, context.capturedAt);
  } catch (err) {
    orchestrationDegraded = true;
    // Durable synchronization is an optimization over inputs already loaded
    // for this plan. Preserve those in-memory safety/conflict directives when
    // the signal store is unavailable instead of silently planning as though
    // the inputs did not exist.
    meshSignals = groupDerivedSignalDrafts(opts.userId, tenantId, derivedSignalDrafts, context.capturedAt);
    logger.warn(
      { ...safeContentLogErrorFields(err), userId: opts.userId, weekStart: window.weekStart },
      'weekly plan signal sync failed — continuing with unsynced in-memory mesh signals',
    );
  }

  const variant = resolveAggressivenessVariant(training, garminStale, context.capturedAt);
  const directives = buildDirectiveSet({
    training,
    secretary,
    content,
    finance,
    meshSignals,
  });
  const resolution = resolveDirectiveMatrix(directives);
  const acceptedByDay = indexAcceptedDirectives(resolution.accepted);
  const shadowedByDay = indexAcceptedDirectives(resolution.shadowed);
  const days = weekIsoDates(window.start).map((date) => buildPlanDay({
    date,
    variant,
    gatedSkills,
    training,
    cooking,
    content,
    secretary,
    finance,
    acceptedDirectives: acceptedByDay.get(date) ?? [],
    shadowedDirectives: shadowedByDay.get(date) ?? [],
    timezone: context.timezone,
    language: context.language,
  }));

  const sourceHealth = resolveWeeklySourceHealth({
    training,
    secretary,
    cooking,
    content,
    finance,
    gatedSkills,
    trainingFailed: trainingLoad.degraded,
    cookingFailed: cookingLoad.degraded,
    contentFailed: contentLoad.degraded,
    financeFailed: financeLoad.degraded,
  });
  orchestrationDegraded = orchestrationDegraded || Object.entries(sourceHealth).some(([key, health]) =>
    !gatedSkills.includes(key) && health.status !== 'ready',
  );
  const warningMetadata = mergePlanWarnings(context, sourceHealth, degradedQuota.over
    ? {
        warningCodes: ['AI_COPY_QUOTA_REACHED'],
        warnings: ['Creative plan copy is unavailable at the current AI allowance; deterministic planning remains current.'],
      }
    : undefined);

  const response: WeeklyPlanResponse = {
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    generatedAt: context.capturedAt,
    timezone: context.timezone,
    warningCodes: warningMetadata.warningCodes,
    warnings: warningMetadata.warnings,
    sourceHealth,
    variant,
    degraded: orchestrationDegraded,
    gated: { skills: gatedSkills },
    garmin_stale: garminStale,
    conflicts: resolution.conflicts,
    creativeCopy: degradedQuota.over
      ? { headline: '', note: '' }
      : buildCreativeCopy(days, variant, sourceHealth, gatedSkills),
    contentPlan: summarizeContentPlan(content),
    summary: {
      sessionCount: days.filter((day) => day.training.status !== 'rest' && day.training.status !== 'gated').length,
      mealCount: days.reduce((sum, day) => sum + day.meals.length, 0),
      activeConflictCount: resolution.conflicts.length,
    },
    days,
  };

  if (ownsCache) setCache(cacheKey, response, 1800);
  return response;
}

function normalizeCachedWeeklyPlan(
  cached: WeeklyPlanResponse,
  context: SecretaryPlanningContext,
): WeeklyPlanResponse {
  const legacy = cached as WeeklyPlanResponse & {
    timezone?: string;
    warningCodes?: string[];
    warnings?: string[];
    sourceHealth?: WeeklyPlanSourceHealth;
  };
  if (legacy.timezone && legacy.warningCodes && legacy.warnings && legacy.sourceHealth) {
    return cached;
  }
  const sourceHealth = legacy.sourceHealth ?? unavailableWeeklyPlanSourceHealth();
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

function resolveWeeklySourceHealth(input: {
  training: TrainingMeshContext;
  secretary: SecretaryMeshContext;
  cooking: CookingMeshContext | null;
  content: ContentMeshContext | null;
  finance: FinanceMeshContext | null;
  gatedSkills: string[];
  trainingFailed: boolean;
  cookingFailed: boolean;
  contentFailed: boolean;
  financeFailed: boolean;
}): WeeklyPlanSourceHealth {
  const secretaryHealth = input.secretary.sourceHealth ?? {
    calendar: unavailablePlanSource(
      'CALENDAR_STATE_UNKNOWN',
      'Calendar state could not be confirmed.',
    ),
    tasks: unavailablePlanSource(
      'TASKS_STATE_UNKNOWN',
      'Task state could not be confirmed.',
    ),
    mail: unavailablePlanSource(
      'MAIL_STATE_UNKNOWN',
      'Mail state could not be confirmed.',
    ),
    focus: unavailablePlanSource(
      'FOCUS_STATE_UNKNOWN',
      'Focus state could not be confirmed.',
    ),
  };
  const skillHealth = (
    skill: 'cooking' | 'content' | 'finance',
    failed: boolean,
    health: PlanSourceHealth | undefined,
  ) => {
    if (input.gatedSkills.includes(skill)) {
      return unavailablePlanSource(
        `${skill.toUpperCase()}_SKILL_GATED`,
        `${capitalizeFirstLetter(skill)} planning is not available on the current tier.`,
      );
    }
    if (failed) {
      return unavailablePlanSource(
        `${skill.toUpperCase()}_STATE_UNAVAILABLE`,
        `${capitalizeFirstLetter(skill)} planning state is unavailable.`,
      );
    }
    return health ?? unavailablePlanSource(
      `${skill.toUpperCase()}_STATE_UNKNOWN`,
      `${capitalizeFirstLetter(skill)} planning source health was not reported.`,
    );
  };
  return {
    ...secretaryHealth,
    training: input.trainingFailed
      ? unavailablePlanSource('TRAINING_STATE_UNAVAILABLE', 'Training planning state is unavailable.')
      : input.training.sourceHealth ?? unavailablePlanSource(
          'TRAINING_STATE_UNKNOWN',
          'Training planning source health was not reported.',
        ),
    cooking: input.gatedSkills.includes('cooking')
      ? unavailablePlanSource(
          'COOKING_SKILL_GATED',
          'Cooking planning is not available on the current tier.',
        )
      : input.cookingFailed
        ? unavailablePlanSource('COOKING_STATE_UNAVAILABLE', 'Cooking planning state is unavailable.')
        : aggregateCookingSourceHealth(input.cooking),
    content: skillHealth('content', input.contentFailed, input.content?.sourceHealth),
    finance: skillHealth('finance', input.financeFailed, input.finance?.sourceHealth),
  };
}

function aggregateCookingSourceHealth(cooking: CookingMeshContext | null): PlanSourceHealth {
  const health = cooking?.sourceHealth;
  if (!health) {
    return unavailablePlanSource(
      'COOKING_STATE_UNKNOWN',
      'Cooking planning source health was not reported.',
    );
  }
  const flatHealth = health as Partial<PlanSourceHealth>;
  if (typeof flatHealth.status === 'string'
      && Array.isArray(flatHealth.warningCodes)
      && Array.isArray(flatHealth.warnings)) {
    return flatHealth as PlanSourceHealth;
  }

  const sourceHealth = [health.mealPlan, health.shoppingList, health.recipes, health.focus];
  if (health.safety) sourceHealth.push(health.safety);
  const warningCodes = [...new Set([
    ...sourceHealth.flatMap((source) => source.warningCodes),
    ...(cooking.calendar?.warningCodes ?? []),
  ])];
  if (!health.safety) warningCodes.push('COOKING_SAFETY_STATE_UNKNOWN');
  if (!cooking.calendar) warningCodes.push('COOKING_CALENDAR_STATE_UNKNOWN');

  if (health.mealPlan.status === 'unavailable' || health.safety?.status === 'unavailable') {
    return {
      status: 'unavailable',
      warningCodes: [...new Set(warningCodes)],
      warnings: ['Cooking meal or safety state is unavailable.'],
    };
  }

  const calendarReady = cooking.calendar?.status === 'ready'
    || cooking.calendar?.status === 'not_configured';
  const allReady = Boolean(health.safety)
    && sourceHealth.every((source) => source.status === 'ready')
    && calendarReady;
  return allReady
    ? readyPlanSource()
    : {
        status: 'degraded',
        warningCodes: [...new Set(warningCodes.length > 0
          ? warningCodes
          : ['COOKING_STATE_DEGRADED'])],
        warnings: ['Some Cooking planning state is unavailable.'],
      };
}

function groupDerivedSignalDrafts(
  userId: number,
  tenantId: number,
  drafts: MeshSignalDraft[],
  observedAt: string,
): Map<SignalType, AgentSignal[]> {
  const grouped = new Map<SignalType, AgentSignal[]>();
  const createdAt = observedAt;
  drafts.forEach((draft, index) => {
    const signal: AgentSignal = {
      id: -(index + 1),
      source_agent: draft.sourceAgent,
      signal_type: draft.signalType,
      payload: draft.payload,
      priority: draft.priority,
      consumed_by: [],
      status: 'active',
      created_at: createdAt,
      expires_at: draft.expiresAt
        ?? DateTime.fromISO(observedAt, { zone: 'utc' }).plus({ days: 7 }).toISO()!,
      user_id: userId,
      tenant_id: tenantId,
      signal_identity: null,
      confidence: 0.5,
      format_tag: null,
      pillar_tag: null,
      evidence_count: 1,
      meshPriority: draft.meshPriority,
    };
    const bucket = grouped.get(signal.signal_type);
    if (bucket) {
      bucket.push(signal);
    } else {
      grouped.set(signal.signal_type, [signal]);
    }
  });
  return grouped;
}

function buildCookingMeshSignals(
  cooking: CookingMeshContext,
  training: TrainingMeshContext,
  content: ContentMeshContext | null,
  referenceNow: string,
): MeshSignalDraft[] {
  const fuelingSupport = readFuelingSupportSignal(cooking);
  const executionReadiness = readMealExecutionReadinessSignal(cooking);
  const trainingTimezone = resolveTrainingPlanTimezone(training.activePlan);
  const sessionDates = new Set(training.sessions.map(
    (session) => sessionDateForWeek(session, cooking.weekStart, trainingTimezone),
  ));
  const mealDates = new Set(cooking.meals.map((meal) => meal.date));
  const sourceHealth = cooking.sourceHealth;
  const hasDetailedHealth = sourceHealth != null
    && 'mealPlan' in sourceHealth
    && 'shoppingList' in sourceHealth
    && 'focus' in sourceHealth;
  const hasVerifiedMealCoverage = hasDetailedHealth
    && sourceHealth.mealPlan.status === 'ready'
    && sourceHealth.shoppingList.status === 'ready'
    && sourceHealth.safety != null
    && sourceHealth.safety.status !== 'unavailable';
  const riskyDates = !hasVerifiedMealCoverage
    ? []
    : fuelingSupport?.hardDatesMissingMeals.length
      ? fuelingSupport.hardDatesMissingMeals
      : fuelingSupport?.trainingDatesMissingMeals.length
        ? fuelingSupport.trainingDatesMissingMeals
        : [...sessionDates].filter((date) => !mealDates.has(date));
  const hasVerifiedAvailability = isCookingCalendarAvailabilityVerified(cooking.calendar?.status)
    && hasDetailedHealth
    && sourceHealth.focus.status === 'ready'
    && sourceHealth.safety != null
    && sourceHealth.safety.status !== 'unavailable'
    && (cooking.calendar?.status === 'not_configured' || Boolean(cooking.availability));
  const hasActualPrepNeed = executionReadiness != null
    && cooking.meals.length > 0
    && (
      executionReadiness.prepPressureDates.length > 0
      || executionReadiness.highEffortMealCount > 0
      || executionReadiness.totalPrepMinutes + executionReadiness.totalCookMinutes >= 90
      || (cooking.meals.length >= 3 && !executionReadiness.shoppingReady)
    );
  const batchCookDate = hasVerifiedAvailability && hasActualPrepNeed
    ? chooseBatchCookDate(training, cooking, content, cooking.weekStart, referenceNow)
    : null;

  const drafts: MeshSignalDraft[] = [];
  if (riskyDates.length > 0) {
    drafts.push({
      sourceAgent: 'mesh.cooking-orchestrator',
      signalType: 'fueling_gap_risk',
      meshPriority: 3,
      priority: 'normal',
      payload: {
        dates: riskyDates,
        reason: fuelingSupport?.hardDatesMissingMeals.length
          ? 'A harder training day still lacks meal support.'
          : executionReadiness?.prepPressureDates.length
            ? `Meal execution is already under prep pressure on ${executionReadiness.prepPressureDates.join(', ')}.`
          : 'Training is scheduled but meals are missing on those days.',
      },
    });
  }

  if (batchCookDate) {
    drafts.push({
      sourceAgent: 'mesh.cooking-orchestrator',
      signalType: 'batch_cook_day',
      meshPriority: executionReadiness?.status === 'at_risk' ? 2 : 3,
      priority: executionReadiness?.status === 'at_risk' ? 'normal' : 'background',
      payload: {
        date: batchCookDate,
        reason: executionReadiness?.status === 'at_risk'
          ? executionReadiness.prepPressureDates.length > 0
            ? `Meal execution is at risk this week, especially around ${executionReadiness.prepPressureDates.join(', ')} — use the lightest day to prep ahead.`
            : 'Meal execution is at risk this week — use the lightest day to prep ahead.'
          : executionReadiness?.status === 'partial'
            ? executionReadiness.prepPressureDates.length > 0
              ? `Meal coverage still needs cleanup and prep pressure already lands on ${executionReadiness.prepPressureDates.join(', ')}.`
              : 'Meal coverage still needs cleanup, so use the lightest day to prep ahead.'
            : 'Lowest planned training load this week.',
      },
    });
  }

  return drafts;
}

async function syncDerivedSignals(
  userId: number,
  tenantId: number,
  drafts: MeshSignalDraft[],
  observedAt: string,
  authoritativeSourceAgents: ReadonlySet<string>,
): Promise<Map<SignalType, AgentSignal[]>> {
  return runSignalWriteTransaction(() => {
    const grouped = new Map<SignalType, AgentSignal[]>();
    const keepSignalIdsBySource = new Map<string, number[]>();
    for (const draft of drafts) {
      const signal = ensureSignal(userId, tenantId, draft, observedAt);
      const keepSignalIds = keepSignalIdsBySource.get(draft.sourceAgent) ?? [];
      keepSignalIds.push(signal.id);
      keepSignalIdsBySource.set(draft.sourceAgent, keepSignalIds);
      const bucket = grouped.get(signal.signal_type);
      if (bucket) {
        bucket.push(signal);
      } else {
        grouped.set(signal.signal_type, [signal]);
      }
    }
    for (const sourceAgent of authoritativeSourceAgents) {
      reconcileGovernedSignalSet({
        sourceAgent,
        userId,
        tenantId,
        keepSignalIds: keepSignalIdsBySource.get(sourceAgent) ?? [],
      });
    }
    return grouped;
  });
}

function ensureSignal(
  userId: number,
  tenantId: number,
  draft: MeshSignalDraft,
  observedAt: string,
): AgentSignal {
  const existing = readSignals('mesh.orchestrator', [draft.signalType], 20, userId, undefined, tenantId).find((signal) =>
    signal.source_agent === draft.sourceAgent
    && signal.meshPriority === draft.meshPriority
    && stableStringify(signal.payload) === stableStringify(draft.payload),
  );

  if (existing) {
    return existing;
  }

  const signalId = writeGovernedSignal({
    source_agent: draft.sourceAgent,
    signal_type: draft.signalType,
    payload: draft.payload,
    user_id: userId,
    tenant_id: tenantId,
    priority: draft.priority,
    expires_at: draft.expiresAt
      ?? DateTime.fromISO(observedAt, { zone: 'utc' }).plus({ days: 7 }).toISO()!,
    meshPriority: draft.meshPriority,
    provenance: {
      producerVersion: WEEKLY_PLAN_SIGNAL_PRODUCER_VERSION,
      source: 'runtime',
      observedAt,
    },
  });

  const inserted = readSignals('mesh.orchestrator', [draft.signalType], 20, userId, undefined, tenantId)
    .find((signal) => signal.id === signalId);
  if (!inserted) {
    throw new Error(`Failed to read freshly written mesh signal ${draft.signalType}`);
  }
  return inserted;
}

function buildDirectiveSet(opts: {
  training: TrainingMeshContext;
  secretary: SecretaryMeshContext;
  content: ContentMeshContext | null;
  finance: FinanceMeshContext | null;
  meshSignals: Map<SignalType, AgentSignal[]>;
}): MeshDirective[] {
  const directives: MeshDirective[] = [];

  for (const signal of opts.meshSignals.get('travel_window') ?? []) {
    const dates = readDateList(signal.payload.dates);
    for (const date of dates) {
      directives.push({
        id: `travel:${signal.id}:${date}`,
        date,
        target: 'availability',
        domain: 'secretary',
        summary: 'Travel blocks this day',
        action: 'travel',
        signalType: signal.signal_type,
        signalId: signal.id,
        meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
      });
    }
  }

  for (const signal of opts.meshSignals.get('calendar_busy_blocks') ?? []) {
    const dates = readDateList(signal.payload.dates);
    for (const date of dates) {
      directives.push({
        id: `busy:${signal.id}:${date}`,
        date,
        target: 'availability',
        domain: 'secretary',
        summary: 'Calendar is already packed',
        action: 'busy',
        signalType: signal.signal_type,
        signalId: signal.id,
        meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
      });
    }
  }

  for (const signal of opts.meshSignals.get('rest_day_scheduled') ?? []) {
    const dates = readDateList(signal.payload.dates);
    for (const date of dates) {
      directives.push({
        id: `rest:${signal.id}:${date}`,
        date,
        target: 'training-load',
        domain: 'training',
        summary: 'Recovery takes priority on this day',
        action: 'rest',
        signalType: signal.signal_type,
        signalId: signal.id,
        meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
      });
    }
  }

  for (const signal of opts.meshSignals.get('recovery_state') ?? []) {
    const state = typeof signal.payload.state === 'string' ? signal.payload.state : null;
    const date = typeof signal.payload.date === 'string' ? signal.payload.date : null;
    if (!date || !state || (state !== 'critical' && state !== 'strained')) {
      continue;
    }

    directives.push({
      id: `recovery:${signal.id}:${date}`,
      date,
      target: 'training-recovery',
      domain: 'training',
      summary: state === 'critical'
        ? 'Recovery is critical — reduce intensity and protect bandwidth.'
        : 'Recovery is strained — keep training conservative and easy to absorb.',
      action: state,
      signalType: signal.signal_type,
      signalId: signal.id,
      meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
    });
  }

  for (const signal of opts.meshSignals.get('session_prescription') ?? []) {
    const date = typeof signal.payload.date === 'string' ? signal.payload.date : null;
    const title = typeof signal.payload.title === 'string' ? signal.payload.title : 'planned session';
    if (!date) {
      continue;
    }

    directives.push({
      id: `session:${signal.id}:${date}`,
      date,
      target: 'training-focus',
      domain: 'training',
      summary: `Anchor the day around ${title}.`,
      action: 'anchor-session',
      signalType: signal.signal_type,
      signalId: signal.id,
      meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
    });
  }

  for (const signal of opts.meshSignals.get('session_immovability') ?? []) {
    const date = typeof signal.payload.date === 'string' ? signal.payload.date : null;
    const title = typeof signal.payload.title === 'string' ? signal.payload.title : 'planned session';
    const level = typeof signal.payload.level === 'string' ? signal.payload.level : 'protected';
    if (!date) {
      continue;
    }

    directives.push({
      id: `session-protection:${signal.id}:${date}`,
      date,
      target: 'time-protection',
      domain: 'secretary',
      summary: `Protect ${title} as a ${level}-immovability training block.`,
      action: 'protect-training-window',
      signalType: signal.signal_type,
      signalId: signal.id,
      meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
    });
  }

  for (const signal of opts.meshSignals.get('fueling_gap_risk') ?? []) {
    const dates = readDateList(signal.payload.dates);
    for (const date of dates) {
      directives.push({
        id: `fueling-gap:${signal.id}:${date}`,
        date,
        target: 'meal-coverage',
        domain: 'cooking',
        summary: typeof signal.payload.reason === 'string'
          ? signal.payload.reason
          : 'Training is scheduled but meal coverage is still missing.',
        action: 'cover-fueling',
        signalType: signal.signal_type,
        signalId: signal.id,
        meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
      });
    }
  }

  for (const signal of opts.meshSignals.get('batch_cook_day') ?? []) {
    const date = typeof signal.payload.date === 'string' ? signal.payload.date : null;
    if (!date) {
      continue;
    }

    directives.push({
        id: `batch-cook:${signal.id}:${date}`,
        date,
        target: 'meal-prep',
        domain: 'cooking',
        summary: typeof signal.payload.reason === 'string'
          ? signal.payload.reason
          : 'Use this lighter day to batch-cook for the rest of the week.',
        action: 'batch-cook',
        signalType: signal.signal_type,
        signalId: signal.id,
        meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
    });
  }

  for (const signal of opts.meshSignals.get('budget_remaining') ?? []) {
    const remainingRatio = typeof signal.payload.remainingRatio === 'number'
      ? signal.payload.remainingRatio
      : null;
    const budgetMode = typeof signal.payload.budgetMode === 'string' ? signal.payload.budgetMode : null;
    if (remainingRatio === null || remainingRatio > 0.3) {
      continue;
    }

    directives.push({
      id: `budget:${signal.id}:${opts.training.weekStart}`,
      date: opts.training.weekStart,
      target: 'spending',
      domain: 'finance',
      summary: budgetMode === 'tight'
        ? 'Budget headroom is tight this week — keep discretionary spend lean and essentials first.'
        : 'Budget is controlled this week — keep discretionary spend selective.',
      action: budgetMode === 'tight' ? 'budget-tight' : 'budget-controlled',
      signalType: signal.signal_type,
      signalId: signal.id,
      meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
    });
  }

  for (const signal of opts.meshSignals.get('tax_deadline') ?? []) {
    const reminderDate = typeof signal.payload.reminderDate === 'string' ? signal.payload.reminderDate : null;
    if (reminderDate) {
      directives.push({
        id: `tax:${signal.id}:${reminderDate}`,
        date: reminderDate,
        target: 'primary-commitment',
        domain: 'finance',
        summary: 'Tax deadline needs attention',
        action: 'tax',
        signalType: signal.signal_type,
        signalId: signal.id,
        meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
      });
    }
  }

  for (const signal of opts.meshSignals.get('sponsor_deliverable_due') ?? []) {
    if (signal.source_agent !== 'mesh.editorial-coordinator') continue;
    if (
      signal.payload.status !== 'factual_constraint'
      || signal.payload.publicationAuthority !== 'not_established'
      || signal.payload.semantics !== 'external_deadline_not_publication_authority'
    ) continue;

    const dueAt = typeof signal.payload.dueAt === 'string' ? signal.payload.dueAt.trim() : '';
    const parsedDueAt = dueAt.length > 0
      ? DateTime.fromISO(dueAt, { setZone: true })
      : DateTime.invalid('missing sponsor due date');
    const date = parsedDueAt.isValid && Number.isFinite(parsedDueAt.toMillis())
      ? parsedDueAt.toISODate()
      : null;
    if (!date) continue;

    const title = typeof signal.payload.title === 'string' && signal.payload.title.trim().length > 0
      ? signal.payload.title.trim()
      : 'External Content deliverable';
    directives.push({
      id: `sponsor-deadline:${signal.id}:${date}`,
      date,
      target: 'primary-commitment',
      domain: 'content',
      summary: `${title} has an external deadline at ${dueAt}. It needs attention, but it does not reserve calendar time or authorize publication.`,
      action: 'external-deadline-attention',
      signalType: signal.signal_type,
      signalId: signal.id,
      meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
    });
  }

  for (const signal of opts.meshSignals.get('shoot_day_locked') ?? []) {
    const date = typeof signal.payload.date === 'string' ? signal.payload.date : null;
    const itemId = typeof signal.payload.itemId === 'number' ? signal.payload.itemId : null;
    const blockStart = typeof signal.payload.blockStart === 'string' ? signal.payload.blockStart : null;
    const blockEnd = typeof signal.payload.blockEnd === 'string' ? signal.payload.blockEnd : null;
    const confirmedSchedule = canConsumeConfirmedContentWorkSchedule(opts.content?.workSchedule)
      ? opts.content!.workSchedule
      : null;
    const canonicalBlock = confirmedSchedule?.confirmedBlocks.find((block) => (
      block.workKind === 'record'
      && block.authority === 'secretary'
      && block.authorityStatus === 'current'
      && block.semantics === 'private_work_session'
      && isConfirmedContentBlockState(block.state)
      && block.itemId === itemId
      && block.date === date
      && block.startsAt === blockStart
      && block.endsAt === blockEnd
    ));
    const confirmedBySecretary = signal.payload.planStatus === 'confirmed'
      && signal.payload.scheduleAuthority === 'secretary'
      && signal.payload.scheduleAuthorityStatus === 'current'
      && signal.payload.semantics === 'private_work_session'
      && signal.payload.workKind === 'filming'
      && signal.payload.sourceWorkKind === canonicalBlock?.workKind
      && signal.payload.sourceState === canonicalBlock?.state
      && signal.payload.providerAttention === (canonicalBlock?.state === 'sync_failed')
      && signal.source_agent === 'mesh.editorial-coordinator'
      && canonicalBlock != null;
    if (date && confirmedBySecretary && canonicalBlock) {
      const title = canonicalBlock.title;
      const externalDeadline = directives.find((directive) => (
        directive.date === date
        && directive.signalType === 'sponsor_deliverable_due'
        && directive.action === 'external-deadline-attention'
      ));
      directives.push({
        id: `shoot:${signal.id}:${date}`,
        date,
        target: 'primary-commitment',
        domain: 'content',
        summary: `${title} has a Secretary-confirmed private filming block.`,
        action: 'shoot',
        signalType: signal.signal_type,
        signalId: signal.id,
        // Bring the exact confirmed block into the same bounded negotiation as
        // a same-day external deadline. The resolver then preserves the block
        // as the only protected time while retaining the deadline as attention.
        meshPriority: externalDeadline?.meshPriority
          ?? signal.meshPriority
          ?? defaultMeshPriorityForSignal(signal.signal_type),
      });
    }
  }

  for (const signal of opts.meshSignals.get('content_capture_opportunity') ?? []) {
    if (signal.source_agent !== 'mesh.editorial-coordinator') {
      continue;
    }

    const date = typeof signal.payload.date === 'string' ? signal.payload.date : null;
    if (!date) {
      continue;
    }

    const title = typeof signal.payload.title === 'string' ? signal.payload.title : 'Content execution';
    const angle = typeof signal.payload.angle === 'string' ? signal.payload.angle : null;
    const reason = typeof signal.payload.reason === 'string' ? signal.payload.reason : null;

    directives.push({
      id: `content-capture:${signal.id}:${date}`,
      date,
      target: 'content-execution',
      domain: 'content',
      summary: `Proposal: ${reason ?? defaultContentExecutionSummary(angle, title)}`,
      action: normalizeContentExecutionAction(angle),
      signalType: signal.signal_type,
      signalId: signal.id,
      meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
    });
  }

  return directives;
}

function normalizeContentExecutionAction(angle: string | null): string {
  switch (angle) {
    case 'reaction_window':
    case 'script_ready':
    case 'publish_ready':
    case 'film_window':
      return angle;
    default:
      return 'content_execution';
  }
}

function defaultContentExecutionSummary(angle: string | null, title: string): string {
  switch (angle) {
    case 'reaction_window':
      return `Reaction window is live for ${title}.`;
    case 'script_ready':
      return `Script is ready for ${title} — move it into execution.`;
    case 'publish_ready':
      return `A publication candidate is ready for review for ${title}.`;
    case 'film_window':
      return `Capture window is open for ${title}.`;
    default:
      return `Content execution window is open for ${title}.`;
  }
}

function contentExecutionTitle(action: string | null, hasConfirmedBlock: boolean): string {
  switch (action) {
    case 'reaction_window':
      return hasConfirmedBlock ? 'Confirmed block + reaction proposal' : 'Reaction content proposal';
    case 'script_ready':
      return hasConfirmedBlock ? 'Confirmed block for a ready script' : 'Ready-script work proposal';
    case 'publish_ready':
      return hasConfirmedBlock ? 'Confirmed review block' : 'Publication candidate for review';
    case 'film_window':
      return hasConfirmedBlock ? 'Confirmed capture block' : 'Capture-window proposal';
    default:
      return hasConfirmedBlock ? 'Confirmed Content work block' : 'Content work proposal';
  }
}

function contentWorkKindLabel(
  workKind: ContentMeshContext['workSchedule']['confirmedBlocks'][number]['workKind'],
): string {
  switch (workKind) {
    case 'record': return 'filming';
    case 'edit': return 'editing';
    case 'write': return 'writing';
    case 'revise': return 'revision';
    case 'publish_prep': return 'publication-preparation';
    default: return workKind.replace(/_/g, ' ');
  }
}

function isConfirmedContentBlockState(state: string): state is 'scheduled' | 'provider_synced' | 'sync_failed' {
  return state === 'scheduled' || state === 'provider_synced' || state === 'sync_failed';
}

function isExternalContentDeadlineDirective(
  directive: MeshDirective | undefined,
): directive is MeshDirective {
  return directive?.signalType === 'sponsor_deliverable_due'
    && directive.action === 'external-deadline-attention';
}

function includesMergedExternalContentDeadline(directive: MeshDirective | undefined): boolean {
  return directive?.signalType === 'shoot_day_locked'
    && directive.summary.startsWith('A sponsor deadline needs attention,');
}

function isConfirmedShootDirective(directive: MeshDirective | undefined): directive is MeshDirective {
  return directive?.signalType === 'shoot_day_locked' && directive.action === 'shoot';
}

function secretaryContentExecutionSequenceStep(directive: MeshDirective): string {
  switch (directive.action) {
    case 'reaction_window':
      return 'Review a fast reaction-slot proposal while the context is still fresh.';
    case 'script_ready':
      return 'Review a short production-slot proposal for the ready script.';
    case 'film_window':
      return 'Review a capture-slot proposal while the content window is still usable.';
    default:
      return 'Review the proposed Content work slot; it is not reserved until Secretary confirms it.';
  }
}

function secretaryContentPrimarySequenceStep(directive: MeshDirective): string {
  switch (directive.action) {
    case 'reaction_window':
      return 'Use the confirmed private work block; keep the reaction idea secondary to its recorded purpose.';
    case 'script_ready':
      return 'Use the confirmed private work block for the ready script without inferring publication.';
    case 'film_window':
      return 'Use the confirmed private work block for capture; it does not publish content.';
    default:
      return 'Honor the Secretary-confirmed private work block without treating it as a publishing commitment.';
  }
}

function secretaryContentExecutionTradeoffLabel(directive: MeshDirective): string {
  switch (directive.action) {
    case 'reaction_window':
      return 'the reaction-window proposal still needs Secretary confirmation';
    case 'script_ready':
      return 'the ready-script proposal still needs Secretary confirmation';
    case 'film_window':
      return 'the capture-window proposal still needs Secretary confirmation';
    default:
      return 'the Content work proposal still needs Secretary confirmation';
  }
}

function buildPlanDay(opts: {
  date: string;
  variant: 'conservative' | 'steady' | 'push';
  gatedSkills: string[];
  training: TrainingMeshContext;
  cooking: CookingMeshContext | null;
  content: ContentMeshContext | null;
  secretary: SecretaryMeshContext;
  finance: FinanceMeshContext | null;
  acceptedDirectives: MeshDirective[];
  shadowedDirectives: MeshDirective[];
  timezone: string;
  language: SecretaryPlanningContext['language'];
}): WeeklyPlanDay {
  const trainingTimezone = resolveTrainingPlanTimezone(opts.training.activePlan);
  const weekday = DateTime.fromISO(opts.date, { zone: opts.timezone })
    .setLocale(planLanguageLocale(opts.language))
    .toFormat('cccc');
  const trainingSession = sessionForDate(
    opts.training.sessions,
    opts.date,
    opts.training.weekStart,
    trainingTimezone,
  );
  const availabilityDirective = opts.acceptedDirectives.find((directive) => directive.target === 'availability');
  const restDirective = opts.acceptedDirectives.find((directive) => directive.target === 'training-load');
  const recoveryDirective = opts.acceptedDirectives.find((directive) => directive.target === 'training-recovery');
  const trainingFocusDirective = opts.acceptedDirectives.find((directive) => directive.target === 'training-focus');
  const trainingProtectionDirective = opts.acceptedDirectives.find((directive) => directive.target === 'time-protection');
  const primaryDirective = opts.acceptedDirectives.find((directive) => directive.target === 'primary-commitment');
  const contentExecutionDirective = opts.acceptedDirectives.find((directive) => directive.target === 'content-execution');
  const mealCoverageDirective = opts.acceptedDirectives.find((directive) => directive.target === 'meal-coverage');
  const mealPrepDirective = opts.acceptedDirectives.find((directive) => directive.target === 'meal-prep');
  const spendingDirective = opts.acceptedDirectives.find((directive) => directive.target === 'spending');
  const deferredPrimaryDirective = opts.shadowedDirectives.find((directive) => directive.target === 'primary-commitment');
  const budget = opts.finance ? readBudgetSignal(opts.finance) : null;
  const persistedMealsForDate = opts.cooking ? mealsForDate(opts.cooking.meals, opts.date) : [];
  const meals = opts.gatedSkills.includes('cooking') || !opts.cooking
    ? []
    : buildMealPlanForDay({
        meals: persistedMealsForDate,
        trainingSession,
        availabilityDirective,
        mealCoverageDirective,
        mealPrepDirective,
        spendingDirective,
        budget,
      });
  const cookingSummary = buildCookingDaySummary({
    gated: opts.gatedSkills.includes('cooking'),
    cooking: opts.cooking,
    date: opts.date,
    persistedMealCount: persistedMealsForDate.length,
  });

  const trainingItem = buildTrainingItem({
    trainingSession,
    availabilityDirective,
    restDirective,
    recoveryDirective,
    focusDirective: trainingFocusDirective,
    gated: false,
    variant: opts.variant,
  });

  const contentItem = opts.gatedSkills.includes('content') || !opts.content
    ? null
    : buildContentItem(
        opts.content,
        opts.date,
        primaryDirective,
        contentExecutionDirective,
        availabilityDirective,
        spendingDirective,
        deferredPrimaryDirective,
      );

  const financeItem = opts.gatedSkills.includes('finance') || !opts.finance
    ? null
    : buildFinanceItem(opts.finance, opts.date, primaryDirective, spendingDirective, deferredPrimaryDirective);

  const secretaryItem = buildSecretaryItem({
    secretary: opts.secretary,
    date: opts.date,
    availabilityDirective,
    trainingFocusDirective,
    trainingProtectionDirective,
    mealCoverageDirective,
    contentExecutionDirective,
    primaryDirective,
    spendingDirective,
    deferredPrimaryDirective,
    timezone: opts.timezone,
  });
  const headline = buildDayHeadline(
    trainingItem,
    contentItem,
    availabilityDirective,
    mealCoverageDirective,
  );

  return {
    date: opts.date,
    weekday,
    headline,
    training: trainingItem,
    meals: opts.gatedSkills.includes('cooking')
      ? [{
          mealType: 'all',
          title: 'Cooking gated',
          note: 'Upgrade to unlock cooking coordination in the mesh plan.',
          decisions: [],
        }]
      : meals,
    cooking: cookingSummary,
    content: opts.gatedSkills.includes('content')
      ? {
          status: 'gated',
          planStatus: 'unavailable',
          scheduleAuthority: 'secretary',
          scheduleAuthorityStatus: 'unavailable',
          scheduleSemantics: 'unavailable',
          title: 'Content gated',
          note: 'Upgrade to unlock content coordination in the mesh plan.',
          blockStart: null,
          blockEnd: null,
          confirmedBlocks: [],
          decisions: [],
        }
      : contentItem,
    secretary: secretaryItem,
    finance: opts.gatedSkills.includes('finance')
      ? {
          budgetNote: 'Upgrade to unlock finance coordination in the mesh plan.',
          taxNote: null,
          subscriptionNote: null,
          decisions: [],
        }
      : financeItem,
  };
}

function buildCookingDaySummary(opts: {
  gated: boolean;
  cooking: CookingMeshContext | null;
  date: string;
  persistedMealCount: number;
}): WeeklyPlanCookingSummary {
  if (opts.gated) {
    return {
      status: 'gated',
      headline: 'Cooking coordination is gated for this account.',
      warningCodes: [],
    };
  }
  if (!opts.cooking?.sourceHealth) {
    return {
      status: 'unavailable',
      headline: 'Cooking plan unavailable for this day.',
      warningCodes: ['COOKING_CONTEXT_UNAVAILABLE'],
    };
  }
  const safetyHealth = opts.cooking.sourceHealth.safety;
  if (!safetyHealth) {
    return {
      status: 'unavailable',
      headline: 'Cooking safety context is unavailable for this day; saved meals are not assumed safe.',
      warningCodes: ['COOKING_SAFETY_CONTEXT_UNAVAILABLE'],
    };
  }
  const sourceEntries = Object.values(opts.cooking.sourceHealth);
  const warningCodes = [...new Set([
    ...sourceEntries.flatMap((source) => source.warningCodes),
    ...(opts.cooking.calendar?.warningCodes ?? []),
  ])];
  if (opts.cooking.sourceHealth.mealPlan.status === 'unavailable') {
    return {
      status: 'unavailable',
      headline: 'Meal-plan data is unavailable for this day; an empty result is not assumed.',
      warningCodes,
    };
  }
  if (safetyHealth.status === 'unavailable') {
    return {
      status: 'unavailable',
      headline: 'Cooking safety preferences are unavailable for this day; saved meals are withheld rather than assumed safe.',
      warningCodes,
    };
  }
  const excludedMealCount = safetyHealth.excludedMealDates.filter((date) => date === opts.date).length;
  if (excludedMealCount > 0) {
    const excludedMealsForDate = safetyHealth.excludedMeals?.filter((meal) => meal.date === opts.date) ?? [];
    const conflict = excludedMealsForDate.length > 0
      ? excludedMealsForDate.some((meal) => meal.reason !== 'unverified_recipe')
      : warningCodes.includes('COOKING_SAVED_MEAL_ALLERGY_CONFLICT')
        || warningCodes.includes('COOKING_SAVED_MEAL_DIETARY_RESTRICTION_CONFLICT');
    const unverified = excludedMealsForDate.length > 0
      ? excludedMealsForDate.some((meal) => meal.reason !== 'preference_conflict')
      : warningCodes.includes('COOKING_SAVED_MEAL_RECIPE_UNVERIFIED');
    const reason = conflict && unverified
      ? 'because of current safety-preference conflicts or incomplete recipe verification'
      : conflict
        ? 'because of current safety-preference conflicts'
        : 'because recipe safety could not be verified against current preferences';
    const shownMeals = `${opts.persistedMealCount} verified-safe planned ${opts.persistedMealCount === 1 ? 'meal' : 'meals'}`;
    const withheldMeals = `${excludedMealCount} saved ${excludedMealCount === 1 ? 'meal' : 'meals'}`;
    return {
      status: 'degraded',
      headline: opts.persistedMealCount > 0
        ? `${shownMeals} shown; ${withheldMeals} withheld ${reason}.`
        : `${withheldMeals} withheld ${reason}.`,
      warningCodes,
    };
  }
  const degraded = sourceEntries.some((source) => source.status !== 'ready')
    || !isCookingCalendarAvailabilityVerified(opts.cooking.calendar?.status);
  if (degraded) {
    return {
      status: 'degraded',
      headline: safetyHealth.status === 'degraded'
        ? opts.persistedMealCount > 0
          ? `${opts.persistedMealCount} verified-safe planned ${opts.persistedMealCount === 1 ? 'meal' : 'meals'} shown; other Cooking safety content was withheld.`
          : 'No saved meals were found for this day; other Cooking safety content was withheld.'
        : opts.persistedMealCount > 0
          ? `${opts.persistedMealCount} planned meal(s) shown; some Cooking context is unavailable.`
          : 'No saved meals were found, but some Cooking context is unavailable.',
      warningCodes,
    };
  }
  if (opts.persistedMealCount === 0) {
    return { status: 'empty', headline: 'No meals planned for this day.', warningCodes: [] };
  }
  return {
    status: 'ready',
    headline: opts.persistedMealCount === 1
      ? '1 meal planned for this day.'
      : `${opts.persistedMealCount} meals planned for this day.`,
    warningCodes: [],
  };
}

function isCookingCalendarAvailabilityVerified(status: CookingCalendarStatus | undefined): boolean {
  return status === 'ready' || status === 'not_configured';
}

function buildTrainingItem(opts: {
  trainingSession: TrainingSession | null;
  availabilityDirective?: MeshDirective;
  restDirective?: MeshDirective;
  recoveryDirective?: MeshDirective;
  focusDirective?: MeshDirective;
  gated: boolean;
  variant: 'conservative' | 'steady' | 'push';
}): WeeklyPlanTrainingItem {
  if (opts.gated) {
    return {
      title: 'Training gated',
      type: 'gated',
      status: 'gated',
      durationMinutes: null,
      intensity: null,
      reason: 'Training planning is not available on this tier.',
      decisions: [],
    };
  }

  if (!opts.trainingSession) {
    return {
      title: 'Recovery / open day',
      type: 'rest',
      status: 'rest',
      durationMinutes: null,
      intensity: null,
      reason: opts.restDirective?.summary ?? 'No training session is scheduled for this day.',
      decisions: opts.restDirective ? [directiveDecision(opts.restDirective)] : [],
    };
  }

  const decisions: PlanDecision[] = [];
  let status: WeeklyPlanTrainingItem['status'] = 'planned';
  let reason = opts.variant === 'push'
    ? 'High adherence keeps the planned stimulus intact.'
    : opts.variant === 'conservative'
      ? 'This week stays conservative because recovery or adherence says to protect consistency first.'
      : 'Keep the planned session, then adjust around calendar pressure if needed.';

  if (opts.availabilityDirective) {
    status = 'adjusted';
    decisions.push(directiveDecision(opts.availabilityDirective));
    reason = `${opts.trainingSession.title} should move because ${opts.availabilityDirective.summary.toLowerCase()}.`;
  } else if (opts.restDirective) {
    status = 'adjusted';
    decisions.push(directiveDecision(opts.restDirective));
    reason = opts.restDirective.summary;
  } else if (opts.recoveryDirective) {
    status = 'adjusted';
    decisions.push(directiveDecision(opts.recoveryDirective));
    reason = opts.recoveryDirective.summary;
  }

  if (opts.focusDirective) {
    decisions.push(directiveDecision(opts.focusDirective));
    if (status === 'planned') {
      reason = opts.focusDirective.summary;
    }
  }

  return {
    title: opts.trainingSession.title,
    type: opts.trainingSession.session_type,
    status,
    durationMinutes: opts.trainingSession.duration_minutes,
    intensity: opts.trainingSession.intensity_text,
    reason,
    decisions,
  };
}

function buildMealPlanForDay(opts: {
  meals: MealPlan[];
  trainingSession: TrainingSession | null;
  availabilityDirective?: MeshDirective;
  mealCoverageDirective?: MeshDirective;
  mealPrepDirective?: MeshDirective;
  spendingDirective?: MeshDirective;
  budget: {
    budgetMode: string;
    groceryMode: string;
    trainingSpendMode: string;
    contentSpendMode: string;
  } | null;
}): WeeklyPlanMealItem[] {
  const items = opts.meals.map((meal) => buildMealItem(
    meal,
    opts.trainingSession,
    opts.availabilityDirective,
    opts.mealCoverageDirective,
    opts.spendingDirective,
    opts.budget,
  ));

  if (items.length === 0 && opts.mealCoverageDirective) {
    items.push({
      mealType: 'guidance',
      title: 'Fueling coverage missing',
      note: opts.budget?.groceryMode === 'cost_aware'
        ? 'A training session is planned here, but meals are still missing. Add a simple staple carb + protein option you already buy so fueling stays cheap and reliable.'
        : 'A training session is planned here, but meals are still missing. Add a simple pre/post-session option.',
      decisions: [directiveDecision(opts.mealCoverageDirective)],
    });
  }

  if (opts.mealPrepDirective) {
    items.push({
      mealType: 'prep',
      title: 'Batch-cook window',
      note: opts.budget?.groceryMode === 'cost_aware'
        ? `${opts.mealPrepDirective.summary} Favor repeatable lower-cost staples so the week stays easy to execute.`
        : opts.mealPrepDirective.summary,
      decisions: [directiveDecision(opts.mealPrepDirective)],
    });
  }

  return items;
}

function buildMealItem(
  meal: MealPlan,
  trainingSession: TrainingSession | null,
  availabilityDirective?: MeshDirective,
  mealCoverageDirective?: MeshDirective,
  spendingDirective?: MeshDirective,
  budget?: {
    budgetMode: string;
    groceryMode: string;
    trainingSpendMode: string;
    contentSpendMode: string;
  } | null,
): WeeklyPlanMealItem {
  const decisions: PlanDecision[] = [];
  let note = 'Meal is ready.';

  if (availabilityDirective?.action === 'travel') {
    decisions.push(directiveDecision(availabilityDirective));
    note = 'Travel day — keep this meal simple and easy to carry.';
  } else if (trainingSession) {
    const lower = `${trainingSession.title} ${trainingSession.session_type}`.toLowerCase();
    if (/\b(interval|tempo|threshold|ftp|race|track|hill)\b/.test(lower)) {
      note = 'Training load is high — keep this meal supportive for the harder session.';
    } else if (/\b(recovery|easy|mobility)\b/.test(lower)) {
      note = 'Recovery day — keep the meal lighter and easier to digest.';
    }
  }

  if (mealCoverageDirective) {
    decisions.push(directiveDecision(mealCoverageDirective));
    note = `${note} Keep this meal locked in so training is not under-fueled.`;
  }

  if (spendingDirective) {
    decisions.push(directiveDecision(spendingDirective));
    note = `${note} Keep ingredients budget-aware this week.`;
  }

  if (budget?.groceryMode === 'cost_aware') {
    note = `${note} Lean on repeatable staples and pantry-friendly ingredients rather than specialty extras.`;
  }

  return {
    mealType: meal.meal_type,
    title: meal.title,
    note,
    decisions,
  };
}

function buildContentItem(
  content: ContentMeshContext,
  date: string,
  primaryDirective?: MeshDirective,
  contentExecutionDirective?: MeshDirective,
  availabilityDirective?: MeshDirective,
  spendingDirective?: MeshDirective,
  deferredPrimaryDirective?: MeshDirective,
): WeeklyPlanContentItem | null {
  const recommendation = content.filmingRecommendation;
  const filmingToday = recommendation?.date === date ? recommendation : null;
  const deadlineToday = content.deadlines?.find((deadline) => deadline.date === date) ?? null;
  const externalDeadlineDirective = isExternalContentDeadlineDirective(primaryDirective)
    || includesMergedExternalContentDeadline(primaryDirective)
    ? primaryDirective
    : isExternalContentDeadlineDirective(deferredPrimaryDirective)
      ? deferredPrimaryDirective
      : undefined;
  const confirmedSchedule = canConsumeConfirmedContentWorkSchedule(content.workSchedule)
    ? content.workSchedule
    : null;
  const confirmedBlocks = (confirmedSchedule?.confirmedBlocks ?? [])
    .filter((block) => (
      block.date === date
      && block.authority === 'secretary'
      && block.authorityStatus === 'current'
      && block.semantics === 'private_work_session'
      && isConfirmedContentBlockState(block.state)
    ))
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const confirmedBlock = confirmedBlocks[0] ?? null;
  const publicConfirmedBlocks: WeeklyPlanContentItem['confirmedBlocks'] = confirmedBlocks.map((block) => ({
    itemId: block.itemId,
    title: block.title,
    authorityStatus: block.authorityStatus,
    confirmationStatus: 'confirmed',
    itemStatus: block.itemStatus ?? null,
    outcome: block.outcome ?? null,
    estimatedEffortMinutes: block.estimatedEffortMinutes ?? null,
    dependency: block.dependency ?? null,
    approvalState: block.approvalState ?? null,
    nextAction: block.nextAction ?? null,
    startsAt: block.startsAt,
    endsAt: block.endsAt,
    workKind: block.workKind,
    state: block.state,
    contentChangedSinceScheduling: block.contentChangedSinceScheduling,
  }));
  const scheduleAuthorityStatus = content.workSchedule?.authorityStatus ?? 'unavailable';
  const basePlanStatus = content.workSchedule?.planStatus ?? 'unavailable';
  const effectivePlanStatus: ContentWorkPlanStatus = basePlanStatus === 'unplanned'
    && (filmingToday != null || contentExecutionDirective != null)
    ? 'proposed'
    : basePlanStatus;
  const hasContentProposal = filmingToday != null || contentExecutionDirective != null;
  const hasDeferredConfirmedBlock = isConfirmedShootDirective(deferredPrimaryDirective);

  if (!confirmedBlock && !deadlineToday && !externalDeadlineDirective && !hasContentProposal && !hasDeferredConfirmedBlock) {
    return null;
  }

  if (confirmedBlock) {
    const conflict = availabilityDirective
      ?? (primaryDirective?.domain === 'finance' ? primaryDirective : undefined)
      ?? (hasDeferredConfirmedBlock ? deferredPrimaryDirective : undefined);
    const noteParts = [
      `${confirmedBlock.title} has a current Secretary-confirmed private ${contentWorkKindLabel(confirmedBlock.workKind)} block.`,
      'It reserves work time only; it is not evidence of publication or a promise to publish.',
      confirmedBlock.state === 'sync_failed'
        ? 'Provider sync needs attention, but the current local Secretary block remains confirmed.'
        : null,
      deadlineToday
        ? `${deadlineToday.title} also has an advisory target date today; that target does not publish or reserve time.`
        : null,
      externalDeadlineDirective
        ? externalDeadlineDirective.summary
        : null,
      contentExecutionDirective
        ? `${contentExecutionDirective.summary} Treat this as guidance inside the confirmed block, not as added calendar authority.`
        : null,
      confirmedBlock.contentChangedSinceScheduling
        ? 'The content changed after scheduling, so review the block purpose before starting.'
        : null,
      confirmedBlocks.length > 1
        ? `${confirmedBlocks.length - 1} additional Secretary-confirmed private Content block(s) are also preserved in confirmedBlocks for this date.`
        : null,
      content.workSchedule.confirmedBlocksComplete === false
        ? 'The bounded calendar projection was truncated, so confirmedBlocks is partial and Secretary authority requires attention before treating this as the complete day plan.'
        : null,
      conflict
        ? `${conflict.summary} Ask Secretary to reconcile the conflict; this planner does not move or cancel the confirmed block.`
        : null,
      spendingDirective
        ? `Keep the work path lower-friction because ${spendingDirective.summary.toLowerCase()}.`
        : null,
    ].filter((value): value is string => Boolean(value));

    return {
      // A collision does not erase the canonical reservation. Keep the block
      // scheduled and surface reconciliation through title/note/decisions.
      status: 'scheduled',
      planStatus: effectivePlanStatus,
      scheduleAuthority: confirmedBlock.authority,
      scheduleAuthorityStatus,
      scheduleSemantics: 'private_work_session',
      title: conflict
        ? 'Confirmed Content block needs review'
        : confirmedBlock.state === 'sync_failed'
          ? 'Confirmed Content block needs provider attention'
        : contentExecutionTitle(contentExecutionDirective?.action ?? null, true),
      note: noteParts.join(' '),
      blockStart: confirmedBlock.startsAt,
      blockEnd: confirmedBlock.endsAt,
      confirmedBlocks: publicConfirmedBlocks,
      decisions: compactDirectives([
        primaryDirective?.domain === 'content' ? primaryDirective : undefined,
        externalDeadlineDirective !== primaryDirective ? externalDeadlineDirective : undefined,
        contentExecutionDirective,
        conflict,
        spendingDirective,
      ]),
    };
  }

  if (deadlineToday || externalDeadlineDirective) {
    const deadlinePlanStatus: ContentWorkPlanStatus = scheduleAuthorityStatus === 'unavailable'
      ? 'unavailable'
      : scheduleAuthorityStatus === 'partially_unavailable'
        ? 'partial'
        : hasContentProposal
          ? 'proposed'
          : 'unplanned';
    const noteParts = [
      deadlineToday ? `${deadlineToday.title} has a target date today.` : null,
      externalDeadlineDirective?.summary ?? null,
      'This deadline attention is advisory: it is not a publication event and does not reserve calendar time.',
      hasContentProposal
        ? 'A separate work proposal exists, but Secretary has not confirmed a private Content block.'
        : 'No Secretary-confirmed private Content block exists for this date.',
      availabilityDirective ? availabilityDirective.summary : null,
      spendingDirective
        ? `Keep any chosen work lower-friction because ${spendingDirective.summary.toLowerCase()}.`
        : null,
    ].filter((value): value is string => Boolean(value));

    return {
      status: 'advisory',
      planStatus: deadlinePlanStatus,
      scheduleAuthority: 'secretary',
      scheduleAuthorityStatus,
      scheduleSemantics: 'target_date_not_publication',
      title: externalDeadlineDirective ? 'External Content deadline attention' : 'Content deadline target',
      note: noteParts.join(' '),
      blockStart: null,
      blockEnd: null,
      confirmedBlocks: [],
      decisions: compactDirectives([
        contentExecutionDirective,
        externalDeadlineDirective,
        availabilityDirective,
        primaryDirective?.domain === 'finance' ? primaryDirective : undefined,
        spendingDirective,
      ]),
    };
  }

  const conflict = availabilityDirective
    ?? (primaryDirective?.domain === 'finance' ? primaryDirective : undefined)
    ?? (hasDeferredConfirmedBlock ? deferredPrimaryDirective : undefined);
  const contentExecutionAction = contentExecutionDirective?.action ?? null;
  const proposalReason = contentExecutionDirective?.summary
    ?? filmingToday?.reason
    ?? deferredPrimaryDirective?.summary
    ?? 'A Content work window is available for review.';
  const noteParts = [
    proposalReason,
    'This is a proposal, not a protected block. Secretary must confirm a private work session before the time becomes reserved.',
    conflict
      ? `${conflict.summary} Review the proposal after the conflict is resolved.`
      : null,
    spendingDirective
      ? `Keep the proposed work lower-friction because ${spendingDirective.summary.toLowerCase()}.`
      : null,
  ].filter((value): value is string => Boolean(value));

  return {
    status: conflict ? 'blocked' : 'advisory',
    planStatus: effectivePlanStatus === 'unavailable' ? 'unavailable' : 'proposed',
    scheduleAuthority: 'secretary',
    scheduleAuthorityStatus,
    scheduleSemantics: 'proposal_not_calendar_reservation',
    title: conflict ? 'Content work proposal needs review' : contentExecutionTitle(contentExecutionAction, false),
    note: noteParts.join(' '),
    blockStart: filmingToday?.blockStart ?? null,
    blockEnd: filmingToday?.blockEnd ?? null,
    confirmedBlocks: [],
    decisions: compactDirectives([
      contentExecutionDirective,
      conflict,
      spendingDirective,
    ]),
  };
}

function buildSecretaryItem(opts: {
  secretary: SecretaryMeshContext;
  date: string;
  availabilityDirective?: MeshDirective;
  trainingFocusDirective?: MeshDirective;
  trainingProtectionDirective?: MeshDirective;
  mealCoverageDirective?: MeshDirective;
  contentExecutionDirective?: MeshDirective;
  primaryDirective?: MeshDirective;
  spendingDirective?: MeshDirective;
  deferredPrimaryDirective?: MeshDirective;
  timezone: string;
}): WeeklyPlanSecretaryItem {
  const {
    secretary,
    date,
    timezone,
    availabilityDirective,
    trainingFocusDirective,
    trainingProtectionDirective,
    mealCoverageDirective,
    contentExecutionDirective,
    primaryDirective,
    spendingDirective,
    deferredPrimaryDirective,
  } = opts;
  const focusBlock = secretary.focusBlock?.date === date
    ? {
        start: secretary.focusBlock.start,
        end: secretary.focusBlock.end,
        note: secretary.focusBlock.reason,
      }
    : null;
  const dateEvents = secretary.events.filter((event) => planningLocalDate(String(event.start ?? ''), timezone) === date);
  const localAgendaItems = (secretary.localAgendaItems ?? []).filter((item) => planningLocalDate(item.startAt, timezone) === date);
  const scheduleTitles = [
    ...dateEvents.map((event) => String(event.summary ?? '')),
    ...localAgendaItems.map((item) => item.title),
  ];
  const criticalMeetingCount = scheduleTitles.filter((title) => /\b(client|cliente|interview|entrevista|doctor|m[eé]dico|meeting|reuni[aã]o|call|sponsor|patroc[ií]nio|filming|shoot|flight|voo|deadline)\b/i.test(title)).length;
  const tasksDueOnDate = secretary.pending.filter((task) => planningLocalDate(String(task.dueDate ?? ''), timezone) === date).length;
  const fixedTaskCount = secretary.pending.filter((task) => Boolean(task.dueDate)).length;
  const movableTaskCount = Math.max(0, secretary.pending.length - fixedTaskCount);
  const portableTaskRatio = secretary.pending.length > 0
    ? Math.round((movableTaskCount / secretary.pending.length) * 100) / 100
    : 0;

  const sequence = buildSecretarySequence({
    focusBlock,
    availabilityDirective,
    trainingFocusDirective,
    trainingProtectionDirective,
    mealCoverageDirective,
    contentExecutionDirective,
    primaryDirective,
    spendingDirective,
    deferredPrimaryDirective,
  });
  const priorityNote = buildSecretaryPriorityNote({
    focusBlock,
    availabilityDirective,
    trainingProtectionDirective,
    primaryDirective,
    mealCoverageDirective,
    contentExecutionDirective,
    spendingDirective,
    deferredPrimaryDirective,
  });
  const tradeoffNote = buildSecretaryTradeoffNote({
    availabilityDirective,
    trainingProtectionDirective,
    mealCoverageDirective,
    contentExecutionDirective,
    primaryDirective,
    spendingDirective,
    deferredPrimaryDirective,
  });
  const decisions = compactDirectives([
    availabilityDirective,
    trainingProtectionDirective,
    trainingFocusDirective,
    mealCoverageDirective,
    contentExecutionDirective,
    primaryDirective,
    spendingDirective,
    deferredPrimaryDirective,
  ]);

  return {
    focusBlock,
    pendingTasks: secretary.pending.length,
    overdueTasks: secretary.overdue.length,
    tasksDueOnDate,
    mailUnreadTotal: secretary.mailPressure?.totalUnread ?? 0,
    calendarEventCount: dateEvents.length + localAgendaItems.length,
    fragmented: dateEvents.length + localAgendaItems.length >= 4,
    criticalMeetingCount,
    movableTaskCount,
    fixedTaskCount,
    portableTaskRatio,
    writableCalendar: secretary.writableCalendar,
    travel: availabilityDirective?.action === 'travel',
    busy: availabilityDirective?.action === 'busy',
    priorityNote,
    sequence,
    tradeoffNote,
    decisions,
  };
}

function buildSecretaryPriorityNote(opts: {
  focusBlock: WeeklyPlanSecretaryItem['focusBlock'];
  availabilityDirective?: MeshDirective;
  trainingProtectionDirective?: MeshDirective;
  primaryDirective?: MeshDirective;
  mealCoverageDirective?: MeshDirective;
  contentExecutionDirective?: MeshDirective;
  spendingDirective?: MeshDirective;
  deferredPrimaryDirective?: MeshDirective;
}): string | null {
  if (opts.availabilityDirective?.action === 'travel') {
    return 'Travel is the main constraint today, so keep the day portable and lighter.';
  }
  if (opts.availabilityDirective?.action === 'busy') {
    return 'Calendar load is already high, so only protect the highest-value blocks.';
  }
  if (opts.primaryDirective?.domain === 'finance') {
    return isConfirmedShootDirective(opts.deferredPrimaryDirective)
      ? 'Finance/admin and a Secretary-confirmed Content block conflict today; ask Secretary to reconcile them instead of assuming either moved.'
      : isExternalContentDeadlineDirective(opts.deferredPrimaryDirective)
        ? 'Finance/admin is the protected commitment; a separate external Content deadline needs attention but does not reserve time.'
      : 'Finance/admin needs the first protected slot today.';
  }
  if (opts.trainingProtectionDirective) {
    return opts.trainingProtectionDirective.summary;
  }
  if (opts.contentExecutionDirective) {
    return opts.contentExecutionDirective.summary;
  }
  if (opts.primaryDirective?.domain === 'content') {
    return opts.primaryDirective.summary;
  }
  if (opts.mealCoverageDirective) {
    return 'Meal coverage needs closing before the session so the day does not run under-fueled.';
  }
  if (opts.spendingDirective) {
    return 'Keep today lean and avoid discretionary errands or purchases.';
  }
  return opts.focusBlock?.note ?? null;
}

function buildSecretarySequence(opts: {
  focusBlock: WeeklyPlanSecretaryItem['focusBlock'];
  availabilityDirective?: MeshDirective;
  trainingFocusDirective?: MeshDirective;
  trainingProtectionDirective?: MeshDirective;
  mealCoverageDirective?: MeshDirective;
  contentExecutionDirective?: MeshDirective;
  primaryDirective?: MeshDirective;
  spendingDirective?: MeshDirective;
  deferredPrimaryDirective?: MeshDirective;
}): string[] {
  const steps: string[] = [];

  if (opts.availabilityDirective?.action === 'travel') {
    steps.push('Treat travel as fixed and move anything optional off the day.');
  } else if (opts.availabilityDirective?.action === 'busy') {
    steps.push('Treat the existing calendar load as fixed before adding anything else.');
  }

  if (opts.primaryDirective?.domain === 'finance') {
    steps.push('Handle the finance/admin block before optional creative or logistics work.');
  }

  if (opts.trainingProtectionDirective) {
    steps.push('Protect the key training window before moving meetings, errands, or filming onto the day.');
  } else if (opts.trainingFocusDirective) {
    steps.push('Anchor the day around the planned training session so the rest of the schedule bends around it.');
  }

  if (opts.mealCoverageDirective) {
    steps.push('Lock meal or shopping coverage before the session so training support is not left to chance.');
  }

  if (opts.contentExecutionDirective) {
    steps.push(secretaryContentExecutionSequenceStep(opts.contentExecutionDirective));
  }

  if (opts.primaryDirective?.domain === 'content') {
    if (isExternalContentDeadlineDirective(opts.primaryDirective)) {
      steps.push('Review the factual external Content deadline and decide the response; it does not reserve time or authorize publication.');
    } else if (isConfirmedShootDirective(opts.primaryDirective)) {
      steps.push(
        includesMergedExternalContentDeadline(opts.primaryDirective)
          ? 'Honor the Secretary-confirmed private filming block and separately address the external deadline; only the work block reserves time, and neither authorizes publication.'
          : opts.contentExecutionDirective
            ? secretaryContentPrimarySequenceStep(opts.contentExecutionDirective)
            : 'Honor the Secretary-confirmed private Content block; it reserves work time but does not imply publication.',
      );
    }
  }

  if (opts.spendingDirective) {
    steps.push('Bundle only essential errands or purchases and leave discretionary spend for another week.');
  }

  if (isExternalContentDeadlineDirective(opts.deferredPrimaryDirective)) {
    steps.push('Keep the external Content deadline visible as factual attention; it is not a conflicting calendar reservation.');
  } else if (isConfirmedShootDirective(opts.deferredPrimaryDirective)) {
    steps.push('Keep the conflicting Secretary-confirmed Content block visible and ask Secretary to reconcile it; do not assume it moved.');
  }

  if (opts.focusBlock) {
    steps.push('Keep the recommended focus block clean once the non-negotiables are sequenced.');
  }

  return dedupeStrings(steps);
}

function buildSecretaryTradeoffNote(opts: {
  availabilityDirective?: MeshDirective;
  trainingProtectionDirective?: MeshDirective;
  mealCoverageDirective?: MeshDirective;
  contentExecutionDirective?: MeshDirective;
  primaryDirective?: MeshDirective;
  spendingDirective?: MeshDirective;
  deferredPrimaryDirective?: MeshDirective;
}): string | null {
  const contentPressure = opts.contentExecutionDirective
    ? secretaryContentExecutionTradeoffLabel(opts.contentExecutionDirective)
    : null;
  if (opts.availabilityDirective?.action === 'travel' && opts.trainingProtectionDirective) {
    return 'Travel compresses the day, so training needs protection first and everything optional should stay secondary.';
  }
  if (opts.trainingProtectionDirective && opts.mealCoverageDirective && opts.contentExecutionDirective && isConfirmedShootDirective(opts.primaryDirective)) {
    return `Training is an anchor, meals need closing, and the Secretary-confirmed private Content block also remains scheduled; ${contentPressure} is guidance, not another reservation.`;
  }
  if (opts.trainingProtectionDirective && opts.mealCoverageDirective && opts.contentExecutionDirective) {
    return `The day should sequence around training and meal support; ${contentPressure} remains a proposal until Secretary confirms a private block.`;
  }
  if (opts.trainingProtectionDirective && opts.mealCoverageDirective && isConfirmedShootDirective(opts.primaryDirective)) {
    return 'Training, meal coverage, and the Secretary-confirmed private Content block all need to remain visible; ask Secretary to reconcile any overlap.';
  }
  if (opts.trainingProtectionDirective && opts.mealCoverageDirective) {
    return 'The day should sequence around training first, then meal support, before any lower-value work expands.';
  }
  if (opts.contentExecutionDirective && isConfirmedShootDirective(opts.primaryDirective)) {
    return 'The Secretary-confirmed private Content block is the only scheduling authority today; the work proposal guides that block but does not imply publication.';
  }
  if (opts.primaryDirective?.domain === 'finance' && opts.spendingDirective) {
    return 'Admin needs the first slot, and the rest of the day should stay lean so finance pressure does not spread further.';
  }
  if (opts.primaryDirective?.domain === 'finance' && isConfirmedShootDirective(opts.deferredPrimaryDirective)) {
    return 'Finance and a Secretary-confirmed Content block conflict; ask Secretary to reconcile them instead of inventing a new order.';
  }
  if (opts.primaryDirective?.domain === 'finance' && isExternalContentDeadlineDirective(opts.deferredPrimaryDirective)) {
    return 'Finance keeps the protected slot; the external Content deadline remains attention only and does not reserve another block.';
  }
  if (opts.contentExecutionDirective && opts.spendingDirective) {
    return `${capitalizeFirstLetter(contentPressure ?? 'the Content work proposal still needs Secretary confirmation')}, and keep the proposed path lean and low-friction this week.`;
  }
  if (isExternalContentDeadlineDirective(opts.primaryDirective) && opts.spendingDirective) {
    return 'The external Content deadline needs a lean response plan, but it does not reserve time or authorize publication.';
  }
  if (isConfirmedShootDirective(opts.primaryDirective) && opts.spendingDirective) {
    return 'The confirmed private Content block remains scheduled, but its work path should stay low-friction during the tighter budget week.';
  }
  return null;
}

function compactDirectives(directives: Array<MeshDirective | undefined>): PlanDecision[] {
  return directives
    .filter((directive): directive is MeshDirective => Boolean(directive))
    .map((directive) => directiveDecision(directive));
}

function capitalizeFirstLetter(value: string): string {
  return value.length > 0 ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildFinanceItem(
  finance: FinanceMeshContext,
  date: string,
  primaryDirective?: MeshDirective,
  spendingDirective?: MeshDirective,
  deferredPrimaryDirective?: MeshDirective,
): WeeklyPlanFinanceItem {
  const budget = readBudgetSignal(finance);
  const budgetRatio = budget?.remainingRatio
    ?? finance.budgetView.projectedRemainingRatio
    ?? finance.budgetView.currentRemainingRatio
    ?? null;
  const nearestPending = finance.taxEvents.find((event) => String(event.status).toLowerCase() !== 'paid') ?? null;
  const renewalDate = finance.subscription.currentPeriodEnd
    ? DateTime.fromISO(finance.subscription.currentPeriodEnd).toISODate()
    : null;
  const recurringPressure = finance.budgetView.recurringExpenseEstimate > 0
    ? `Recurring commitments still likely this month add ${formatCurrencyAmount(finance.budgetView.basisCurrency, finance.budgetView.recurringExpenseEstimate)} of pressure.`
    : null;
  const mixedCurrencyBudgetNote = finance.budgetView.integrity === 'mixed_currency'
    ? `Budget headroom is provisional because ${finance.budgetView.currencies.join(', ')} are mixed this month.`
    : null;

  return {
    budgetNote: spendingDirective?.summary
      ?? (budget
        ? `Budget mode is ${budget.budgetMode}; grocery mode is ${budget.groceryMode}; training spend mode is ${budget.trainingSpendMode}; content spend mode is ${budget.contentSpendMode}.`
        : null)
      ?? mixedCurrencyBudgetNote
      ?? recurringPressure
      ?? (budgetRatio != null && budgetRatio <= 0.25
        ? 'Budget headroom is tight this month, so keep discretionary spend conservative.'
        : null),
    taxNote: nearestPending && taxReminderDate(nearestPending.month) === date
      ? `Tax follow-up is due for ${nearestPending.month}.`
      : primaryDirective?.action === 'tax'
        ? primaryDirective.summary
        : deferredPrimaryDirective?.domain === 'finance'
          ? `${deferredPrimaryDirective.summary} Keep it as the next protected slot after today's higher-priority block.`
        : null,
    subscriptionNote: renewalDate === date
      ? `Subscription renews today on the ${finance.subscription.plan} plan.`
      : null,
    decisions: [
      ...(primaryDirective?.domain === 'finance' ? [directiveDecision(primaryDirective)] : []),
      ...(deferredPrimaryDirective?.domain === 'finance' ? [directiveDecision(deferredPrimaryDirective)] : []),
      ...(spendingDirective ? [directiveDecision(spendingDirective)] : []),
    ],
  };
}

function readFuelingSupportSignal(cooking: CookingMeshContext): {
  status: string;
  trainingDatesMissingMeals: string[];
  hardDatesMissingMeals: string[];
} | null {
  const signal = cooking.derivedSignals.find((entry) => entry.signalType === 'fueling_support_status');
  const status = signal?.payload.status;
  const trainingDatesMissingMeals = Array.isArray(signal?.payload.trainingDatesMissingMeals)
    ? signal.payload.trainingDatesMissingMeals.filter((value): value is string => typeof value === 'string')
    : [];
  const hardDatesMissingMeals = Array.isArray(signal?.payload.hardDatesMissingMeals)
    ? signal.payload.hardDatesMissingMeals.filter((value): value is string => typeof value === 'string')
    : [];
  if (typeof status !== 'string') return null;
  return { status, trainingDatesMissingMeals, hardDatesMissingMeals };
}

function readMealExecutionReadinessSignal(cooking: CookingMeshContext): {
  status: string;
  prepPressureDates: string[];
  constrainedMealDates: string[];
  highEffortMealCount: number;
  totalPrepMinutes: number;
  totalCookMinutes: number;
  shoppingReady: boolean;
} | null {
  const signal = cooking.derivedSignals.find((entry) => entry.signalType === 'meal_execution_readiness');
  const status = signal?.payload.status;
  if (typeof status !== 'string') return null;
  return {
    status,
    prepPressureDates: Array.isArray(signal?.payload.prepPressureDates)
      ? signal.payload.prepPressureDates.filter((value): value is string => typeof value === 'string')
      : [],
    constrainedMealDates: Array.isArray(signal?.payload.constrainedMealDates)
      ? signal.payload.constrainedMealDates.filter((value): value is string => typeof value === 'string')
      : [],
    highEffortMealCount: typeof signal?.payload.highEffortMealCount === 'number'
      ? signal.payload.highEffortMealCount
      : 0,
    totalPrepMinutes: typeof signal?.payload.totalPrepMinutes === 'number'
      ? signal.payload.totalPrepMinutes
      : 0,
    totalCookMinutes: typeof signal?.payload.totalCookMinutes === 'number'
      ? signal.payload.totalCookMinutes
      : 0,
    shoppingReady: signal?.payload.shoppingReady === true,
  };
}

function readBudgetSignal(finance: FinanceMeshContext): {
  budgetMode: string;
  groceryMode: string;
  trainingSpendMode: string;
  contentSpendMode: string;
  remainingRatio: number | null;
  integrity: string | null;
  recurringExpenseEstimate: number;
  recurringExpenseCount: number;
} | null {
  const signal = finance.derivedSignals.find((entry) => entry.signalType === 'budget_remaining');
  const budgetMode = signal?.payload.budgetMode;
  const groceryMode = signal?.payload.groceryMode;
  const trainingSpendMode = signal?.payload.trainingSpendMode;
  const contentSpendMode = signal?.payload.contentSpendMode;
  if (
    typeof budgetMode !== 'string'
    || typeof groceryMode !== 'string'
    || typeof trainingSpendMode !== 'string'
    || typeof contentSpendMode !== 'string'
  ) {
    if (finance.budgetView.integrity === 'mixed_currency' || finance.budgetView.recurringExpenseEstimate > 0) {
      return {
        budgetMode: 'provisional',
        groceryMode: 'cost_aware',
        trainingSpendMode: 'selective',
        contentSpendMode: 'selective',
        remainingRatio: finance.budgetView.projectedRemainingRatio ?? finance.budgetView.currentRemainingRatio,
        integrity: finance.budgetView.integrity,
        recurringExpenseEstimate: finance.budgetView.recurringExpenseEstimate,
        recurringExpenseCount: finance.budgetView.recurringExpenseCount,
      };
    }
    return null;
  }
  return {
    budgetMode,
    groceryMode,
    trainingSpendMode,
    contentSpendMode,
    remainingRatio: typeof signal?.payload.projectedRemainingRatio === 'number'
      ? signal.payload.projectedRemainingRatio
      : typeof signal?.payload.remainingRatio === 'number'
        ? signal.payload.remainingRatio
        : finance.budgetView.projectedRemainingRatio ?? finance.budgetView.currentRemainingRatio,
    integrity: typeof signal?.payload.integrity === 'string'
      ? signal.payload.integrity
      : finance.budgetView.integrity,
    recurringExpenseEstimate: typeof signal?.payload.recurringExpenseEstimate === 'number'
      ? signal.payload.recurringExpenseEstimate
      : finance.budgetView.recurringExpenseEstimate,
    recurringExpenseCount: typeof signal?.payload.recurringExpenseCount === 'number'
      ? signal.payload.recurringExpenseCount
      : finance.budgetView.recurringExpenseCount,
  };
}

function buildDayHeadline(
  training: WeeklyPlanTrainingItem,
  content: WeeklyPlanContentItem | null,
  availabilityDirective?: MeshDirective,
  mealCoverageDirective?: MeshDirective,
): string {
  if (availabilityDirective?.action === 'travel') {
    return 'Travel day — keep the schedule lighter and portable.';
  }
  if (mealCoverageDirective) {
    return 'Fueling needs attention so the day can support the planned session.';
  }
  if (content?.status === 'scheduled') {
    return 'A Secretary-confirmed private Content work block is reserved today; it does not imply publication.';
  }
  if (content?.status === 'blocked' && content.scheduleSemantics === 'private_work_session') {
    return 'A confirmed private Content block conflicts with today’s constraints and needs Secretary review.';
  }
  if (content?.status === 'advisory' && content.scheduleSemantics === 'target_date_not_publication') {
    return 'Content has an advisory target date today, not a publishing or calendar commitment.';
  }
  if (content?.status === 'advisory') {
    return 'A Content work proposal is available, but no private block is confirmed yet.';
  }
  if (training.status === 'adjusted') {
    return 'This day needs a small adjustment to stay aligned.';
  }
  if (training.status === 'rest') {
    return 'Recovery day — protect bandwidth for the rest of the week.';
  }
  return `Keep ${training.title.toLowerCase()} on track.`;
}

function buildCreativeCopy(
  days: WeeklyPlanDay[],
  variant: 'conservative' | 'steady' | 'push',
  sourceHealth: WeeklyPlanSourceHealth,
  gatedSkills: string[],
): { headline: string; note: string } {
  const trainingDays = days.filter((day) => day.training.status !== 'rest').length;
  const confirmedContentDay = days.find((day) => day.content?.status === 'scheduled');
  const hasUnhealthyEnabledSource = Object.entries(sourceHealth).some(
    ([source, health]) => !gatedSkills.includes(source) && health.status !== 'ready',
  );
  if (hasUnhealthyEnabledSource) {
    return {
      headline: 'The plan keeps confirmed commitments visible while some sources recover.',
      note: 'Unavailable, stale, or degraded sources remain marked as partial and are not treated as clear.',
    };
  }

  const crossSkillAlignmentReady = ['calendar', 'training', 'cooking', 'content'].every(
    (source) => !gatedSkills.includes(source) && sourceHealth[source as keyof WeeklyPlanSourceHealth].status === 'ready',
  );
  return {
    headline: variant === 'push'
      ? 'The mesh sees room to press a little harder this week.'
      : variant === 'conservative'
        ? 'This week protects consistency first, then performance.'
        : 'This week stays balanced across training, focus, and recovery.',
    note: confirmedContentDay
      ? crossSkillAlignmentReady
        ? `Training, cooking, and a Secretary-confirmed private Content work block align around ${confirmedContentDay.weekday}; the block does not imply publication.`
        : `A Secretary-confirmed private Content work block appears on ${confirmedContentDay.weekday}; gated skills were not used to confirm cross-skill alignment and the block does not imply publication.`
      : `${trainingDays} training days are scheduled with the current cross-skill constraints in mind.`,
  };
}

function resolveAggressivenessVariant(
  training: TrainingMeshContext,
  garminStale: boolean,
  referenceNow: string,
): 'conservative' | 'steady' | 'push' {
  if (garminStale || training.trainingContext.flags.lowAdherence) {
    return 'conservative';
  }

  if (!training.activePlan) {
    return 'conservative';
  }

  const zone = resolveTrainingPlanTimezone(training.activePlan);
  const planAgeDays = Math.max(
    0,
    DateTime.fromISO(referenceNow, { setZone: true }).setZone(zone).startOf('day').diff(
      DateTime.fromISO(training.activePlan.start_date, { zone }).startOf('day'),
      'days',
    ).days,
  );
  if (planAgeDays < 14) {
    return 'conservative';
  }

  const trailingHighAdherence = readTrailingAdherence(training) >= 0.9;
  if (training.trainingContext.flags.highAdherence && trailingHighAdherence) {
    return 'push';
  }

  return 'steady';
}

function readTrailingAdherence(training: TrainingMeshContext): number {
  if (!training.activePlan) {
    return 0;
  }
  const planId = training.activePlan.id;
  const weeks = getWeeksForPlan(planId);
  if (weeks.length < 4) {
    return 0;
  }
  const recent = weeks.slice(-4).map((week) => getWeeklyAdherence(planId, week.id));

  if (recent.length < 4) {
    return 0;
  }

  return recent.reduce((sum, item) => sum + item.adherenceRate / 100, 0) / recent.length;
}

function indexAcceptedDirectives(directives: MeshDirective[]): Map<string, MeshDirective[]> {
  const map = new Map<string, MeshDirective[]>();
  for (const directive of directives) {
    const bucket = map.get(directive.date);
    if (bucket) {
      bucket.push(directive);
    } else {
      map.set(directive.date, [directive]);
    }
  }
  return map;
}

function sessionForDate(
  sessions: TrainingSession[],
  date: string,
  weekStart: string,
  schedulingTimezone: string,
): TrainingSession | null {
  return sessions.find(
    (session) => sessionDateForWeek(session, weekStart, schedulingTimezone) === date,
  ) ?? null;
}

function mealsForDate(meals: MealPlan[], date: string): MealPlan[] {
  return meals.filter((meal) => meal.date === date);
}

function inferTrainingLoadForBatchCook(session: TrainingSession): 'hard' | 'moderate' | 'light' {
  const title = `${session.title} ${session.session_type} ${session.intensity_text ?? ''}`.toLowerCase();
  if (/\b(interval|tempo|threshold|ftp|race|track|hill|long run|long ride|vo2)\b/.test(title)) {
    return 'hard';
  }
  if (/\b(strength|brick|endurance|steady|build|moderate)\b/.test(title)) {
    return 'moderate';
  }
  return 'light';
}

function chooseBatchCookDate(
  training: TrainingMeshContext,
  cooking: CookingMeshContext,
  content: ContentMeshContext | null,
  weekStart: string,
  referenceNow: string,
): string | null {
  const trainingTimezone = resolveTrainingPlanTimezone(training.activePlan);
  const dates = weekIsoDates(DateTime.fromISO(weekStart, { zone: trainingTimezone }));
  const today = DateTime.fromISO(referenceNow, { setZone: true })
    .setZone(resolveTrainingTimezone(cooking.timezone))
    .toISODate();
  const eligibleDates = today && today >= dates[0]! && today <= dates[dates.length - 1]!
    ? dates.filter((date) => date >= today)
    : dates;
  if (eligibleDates.length === 0) return null;
  const trainingLoadRank = { light: 1, moderate: 2, hard: 3 } as const;
  const trainingLoadByDate = new Map<string, 'hard' | 'moderate' | 'light'>();
  for (const session of training.sessions) {
    const date = sessionDateForWeek(session, weekStart, trainingTimezone);
    const load = inferTrainingLoadForBatchCook(session);
    const existing = trainingLoadByDate.get(date);
    if (!existing || trainingLoadRank[load] > trainingLoadRank[existing]) {
      trainingLoadByDate.set(date, load);
    }
  }
  const busyDates = new Set(cooking.availability?.busyDates ?? []);
  const fragmentedDates = new Set(cooking.availability?.fragmentedDates ?? []);
  const travelDates = new Set(cooking.availability?.travelDates ?? []);
  const focusDate = cooking.availability?.focusDate ?? null;
  const confirmedSchedule = canConsumeConfirmedContentWorkSchedule(content?.workSchedule)
    ? content!.workSchedule
    : null;
  const confirmedContentDates = new Set(
    confirmedSchedule?.confirmedBlocks
      .filter((block) => (
        block.authority === 'secretary'
        && block.authorityStatus === 'current'
        && block.semantics === 'private_work_session'
        && isConfirmedContentBlockState(block.state)
      ))
      .map((block) => block.date) ?? [],
  );

  const scoreLoad = (load: 'hard' | 'moderate' | 'light' | undefined): number => {
    switch (load) {
      case 'hard':
        return 6;
      case 'moderate':
        return 3;
      case 'light':
        return 1;
      default:
        return 0;
    }
  };

  return eligibleDates
    .slice()
    .sort((lhs, rhs) => {
      const lhsScore =
        scoreLoad(trainingLoadByDate.get(lhs))
        + (travelDates.has(lhs) ? 8 : 0)
        + (busyDates.has(lhs) ? 4 : 0)
        + (fragmentedDates.has(lhs) ? 4 : 0)
        + (confirmedContentDates.has(lhs) ? 3 : 0)
        + (focusDate === lhs ? 2 : 0);
      const rhsScore =
        scoreLoad(trainingLoadByDate.get(rhs))
        + (travelDates.has(rhs) ? 8 : 0)
        + (busyDates.has(rhs) ? 4 : 0)
        + (fragmentedDates.has(rhs) ? 4 : 0)
        + (confirmedContentDates.has(rhs) ? 3 : 0)
        + (focusDate === rhs ? 2 : 0);

      if (lhsScore !== rhsScore) return lhsScore - rhsScore;
      return lhs.localeCompare(rhs);
    })[0] ?? null;
}

function weekIsoDates(start: DateTime): string[] {
  return Array.from({ length: 7 }, (_, index) => start.plus({ days: index }).toISODate()!);
}

function planningLocalDate(value: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed.setZone(timezone).toISODate()! : value.slice(0, 10);
}

function resolveWeekWindow(weekStart?: string, timezone = 'Europe/Lisbon'): {
  start: DateTime;
  weekStart: string;
  weekEnd: string;
  timezone: string;
} {
  const zone = timezone;
  const fallback = DateTime.now().setZone(zone).startOf('week');
  const base = weekStart
    ? DateTime.fromISO(weekStart, { zone }).startOf('day')
    : fallback;
  const start = (base.isValid ? base : fallback).startOf('week');
  return {
    start,
    weekStart: start.toISODate()!,
    weekEnd: start.plus({ days: 6 }).toISODate()!,
    timezone: zone,
  };
}

function resolveGatedSkills(user: SecretaryPlanningContext['user']): string[] {
  const paidDomains = ['cooking', 'content', 'finance'] as const;
  if (!user) {
    return [...paidDomains];
  }
  const entitlement = getEffectiveEntitlement(user.id);
  const effectiveUser = {
    id: user.id,
    tier: entitlementPlanToSkillTier(entitlement.plan),
  };
  return paidDomains.filter((skill) => !checkSkillAccess(effectiveUser, skill).allowed);
}

function isGarminMarkedStale(userId: number): boolean {
  const row = getDb().prepare(
    'SELECT status FROM garmin_user_tokens WHERE user_id = ?'
  ).get(userId) as { status?: string } | undefined;
  return row?.status === 'needs_reauth';
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function readDateList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function directiveDecision(directive: MeshDirective): PlanDecision {
  return {
    summary: directive.summary,
    signalId: directive.signalId,
    signalType: directive.signalType,
    meshPriority: directive.meshPriority ?? defaultMeshPriorityForSignal(directive.signalType),
  };
}

function taxReminderDate(month: string): string {
  const parsed = DateTime.fromFormat(month, 'yyyy-MM', { zone: 'UTC' });
  return parsed.isValid ? parsed.endOf('month').toISODate()! : `${month}-28`;
}

function sessionDateForWeek(
  session: TrainingSession,
  weekStart: string,
  schedulingTimezone: string,
): string {
  const start = DateTime.fromISO(weekStart, { zone: schedulingTimezone }).startOf('day');
  const normalized = session.day_of_week.trim().toLowerCase();
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const offset = weekdays.indexOf(normalized);
  return (offset >= 0 ? start.plus({ days: offset }) : start).toISODate()!;
}
