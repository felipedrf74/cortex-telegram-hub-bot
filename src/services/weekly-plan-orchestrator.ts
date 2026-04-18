// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { buildEditorialCoordinationSignals } from '../agents/editorial-coordinator-agent';
import { config } from '../config';
import { getCached, setCache } from './cache-store';
import {
  readContentMeshContext,
  readCookingMeshContext,
  readFinanceMeshContext,
  readSecretaryMeshContext,
  readTrainingMeshContext,
  type ContentMeshContext,
  type CookingMeshContext,
  type FinanceMeshContext,
  type MeshSignalDraft,
  type SecretaryMeshContext,
  type TrainingMeshContext,
} from './cross-agent-learning';
import { isUserOverDailyCap } from './cost-guardrail';
import { getDb } from './database';
import {
  dismissSignal,
  readSignals,
  writeSignal,
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
import { logger } from '../utils/logger';
import { getUserById, type User } from './user-service';
import { getWeeksForPlan, getWeeklyAdherence, type TrainingSession } from './training-plans';
import type { MealPlan } from './cooking-chef';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';

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

export interface WeeklyPlanContentItem {
  status: 'scheduled' | 'advisory' | 'blocked' | 'gated';
  title: string;
  note: string;
  blockStart: string | null;
  blockEnd: string | null;
  decisions: PlanDecision[];
}

export interface WeeklyPlanSecretaryItem {
  focusBlock: {
    start: string;
    end: string;
    note: string;
  } | null;
  pendingTasks: number;
  overdueTasks: number;
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
  content: WeeklyPlanContentItem | null;
  secretary: WeeklyPlanSecretaryItem;
  finance: WeeklyPlanFinanceItem | null;
}

export interface WeeklyPlanResponse {
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  variant: 'conservative' | 'steady' | 'push';
  degraded: boolean;
  gated: { skills: string[] };
  garmin_stale: boolean;
  conflicts: ConflictNote[];
  creativeCopy: {
    headline: string;
    note: string;
  };
  summary: {
    sessionCount: number;
    mealCount: number;
    activeConflictCount: number;
  };
  days: WeeklyPlanDay[];
}

function buildEmptyWeeklyPlanDay(date: string): WeeklyPlanDay {
  return {
    date,
    weekday: DateTime.fromISO(date, { zone: config.app.timezone || 'Europe/Lisbon' }).toFormat('cccc'),
    headline: 'Plan unavailable because tenant scope is invalid for this request.',
    training: {
      title: 'Planning unavailable',
      type: 'gated',
      status: 'gated',
      durationMinutes: null,
      intensity: null,
      reason: 'Tenant scope is invalid, so the planner skipped user-owned orchestration reads.',
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

function buildEmptyWeeklyPlanResponse(opts: {
  userId: number;
  weekStart?: string;
}): WeeklyPlanResponse {
  const window = resolveWeekWindow(opts.weekStart);
  const days = weekIsoDates(window.start).map((date) => buildEmptyWeeklyPlanDay(date));
  return {
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    generatedAt: new Date().toISOString(),
    variant: 'conservative',
    degraded: true,
    gated: { skills: [] },
    garmin_stale: false,
    conflicts: [],
    creativeCopy: {
      headline: '',
      note: '',
    },
    summary: {
      sessionCount: 0,
      mealCount: 0,
      activeConflictCount: 0,
    },
    days,
  };
}

export async function composeWeeklyPlan(opts: {
  userId: number;
  weekStart?: string;
  forceRefresh?: boolean;
}): Promise<WeeklyPlanResponse> {
  if (!isValidTenantUserId(opts.userId)) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'compose_weekly_plan',
      reason: 'invalid_user_scope',
      userId: opts.userId ?? null,
      details: {
        weekStart: opts.weekStart ?? null,
      },
    });
    return buildEmptyWeeklyPlanResponse(opts);
  }

  const window = resolveWeekWindow(opts.weekStart);
  const cacheKey = `plan:week:u:${opts.userId}:${window.weekStart}`;
  if (!opts.forceRefresh) {
    const cached = getCached<WeeklyPlanResponse>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const user = getUserById(opts.userId);
  if (!user) {
    logger.warn(
      { userId: opts.userId },
      'weekly plan user record missing — defaulting to ungated planning context',
    );
  }

  const gatedSkills = resolveGatedSkills(user);
  const degradedQuota = isUserOverDailyCap(opts.userId);
  const garminStale = isGarminMarkedStale(opts.userId);

  const [training, secretary, cooking, content, finance] = await Promise.all([
    readTrainingMeshContext({ userId: opts.userId, weekStart: window.weekStart }),
    readSecretaryMeshContext({ userId: opts.userId, weekStart: window.weekStart }),
    gatedSkills.includes('cooking')
      ? Promise.resolve<CookingMeshContext | null>(null)
      : readCookingMeshContext({ userId: opts.userId, weekStart: window.weekStart }),
    gatedSkills.includes('content')
      ? Promise.resolve<ContentMeshContext | null>(null)
      : readContentMeshContext({ userId: opts.userId, weekStart: window.weekStart }),
    gatedSkills.includes('finance')
      ? Promise.resolve<FinanceMeshContext | null>(null)
      : readFinanceMeshContext({ userId: opts.userId, weekStart: window.weekStart }),
  ]);

  const meshSignals = await syncDerivedSignals(opts.userId, [
    ...training.derivedSignals,
    ...secretary.derivedSignals,
    ...(cooking ? buildCookingMeshSignals(cooking, training, secretary, content) : []),
    ...(content ? [...content.derivedSignals, ...buildEditorialCoordinationSignals({ content, secretary, training }).signals] : []),
    ...(finance ? finance.derivedSignals : []),
  ]);

  const variant = resolveAggressivenessVariant(training, garminStale);
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
  }));

  const response: WeeklyPlanResponse = {
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    generatedAt: new Date().toISOString(),
    variant,
    degraded: degradedQuota.over,
    gated: { skills: gatedSkills },
    garmin_stale: garminStale,
    conflicts: resolution.conflicts,
    creativeCopy: degradedQuota.over
      ? { headline: '', note: '' }
      : buildCreativeCopy(days, variant),
    summary: {
      sessionCount: days.filter((day) => day.training.status !== 'rest' && day.training.status !== 'gated').length,
      mealCount: days.reduce((sum, day) => sum + day.meals.length, 0),
      activeConflictCount: resolution.conflicts.length,
    },
    days,
  };

  setCache(cacheKey, response, 1800);
  return response;
}

function buildCookingMeshSignals(
  cooking: CookingMeshContext,
  training: TrainingMeshContext,
  secretary: SecretaryMeshContext,
  content: ContentMeshContext | null,
): MeshSignalDraft[] {
  const fuelingSupport = readFuelingSupportSignal(cooking);
  const executionReadiness = readMealExecutionReadinessSignal(cooking);
  const sessionDates = new Set(training.sessions.map((session) => sessionDateForWeek(session, cooking.weekStart)));
  const mealDates = new Set(cooking.meals.map((meal) => meal.date));
  const riskyDates = fuelingSupport?.hardDatesMissingMeals.length
    ? fuelingSupport.hardDatesMissingMeals
    : fuelingSupport?.trainingDatesMissingMeals.length
      ? fuelingSupport.trainingDatesMissingMeals
      : [...sessionDates].filter((date) => !mealDates.has(date));
  const batchCookDate = chooseBatchCookDate(training, secretary, content, cooking.weekStart);

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
          : 'Training is scheduled but meals are missing on those days.',
      },
    });
  }

  drafts.push({
    sourceAgent: 'mesh.cooking-orchestrator',
    signalType: 'batch_cook_day',
    meshPriority: executionReadiness?.status === 'at_risk' ? 2 : 3,
    priority: executionReadiness?.status === 'at_risk' ? 'normal' : 'background',
    payload: {
      date: batchCookDate,
      reason: executionReadiness?.status === 'at_risk'
        ? 'Meal execution is at risk this week — use the lightest day to prep ahead.'
        : executionReadiness?.status === 'partial'
          ? 'Meal coverage still needs cleanup, so use the lightest day to prep ahead.'
          : 'Lowest planned training load this week.',
    },
  });

  return drafts;
}

async function syncDerivedSignals(
  userId: number,
  drafts: MeshSignalDraft[],
): Promise<Map<SignalType, AgentSignal[]>> {
  const grouped = new Map<SignalType, AgentSignal[]>();
  for (const draft of drafts) {
    const signal = ensureSignal(userId, draft);
    const bucket = grouped.get(signal.signal_type);
    if (bucket) {
      bucket.push(signal);
    } else {
      grouped.set(signal.signal_type, [signal]);
    }
  }
  return grouped;
}

function ensureSignal(userId: number, draft: MeshSignalDraft): AgentSignal {
  const existing = readSignals('mesh.orchestrator', [draft.signalType], 20, userId).find((signal) =>
    signal.source_agent === draft.sourceAgent
    && signal.meshPriority === draft.meshPriority
    && stableStringify(signal.payload) === stableStringify(draft.payload),
  );

  if (existing) {
    return existing;
  }

  dismissSupersededSignals(userId, draft);

  const signalId = writeSignal({
    source_agent: draft.sourceAgent,
    signal_type: draft.signalType,
    payload: draft.payload,
    user_id: userId,
    priority: draft.priority,
    expires_at: draft.expiresAt,
    meshPriority: draft.meshPriority,
  });

  const inserted = readSignals('mesh.orchestrator', [draft.signalType], 20, userId)
    .find((signal) => signal.id === signalId);
  if (!inserted) {
    throw new Error(`Failed to read freshly written mesh signal ${draft.signalType}`);
  }
  return inserted;
}

function dismissSupersededSignals(userId: number, draft: MeshSignalDraft): void {
  const currentPayload = stableStringify(draft.payload);
  const activeSignals = readSignals('mesh.orchestrator', [draft.signalType], 50, userId)
    .filter((signal) =>
      signal.source_agent === draft.sourceAgent
      && (
        signal.meshPriority !== draft.meshPriority
        || stableStringify(signal.payload) !== currentPayload
      ),
    );

  for (const signal of activeSignals) {
    dismissSignal(signal.id);
  }
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
        summary: 'Training is scheduled but meal coverage is still missing.',
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
      summary: 'Use this lighter day to batch-cook for the rest of the week.',
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

  for (const signal of opts.meshSignals.get('shoot_day_locked') ?? []) {
    const date = typeof signal.payload.date === 'string' ? signal.payload.date : null;
    if (date) {
      directives.push({
        id: `shoot:${signal.id}:${date}`,
        date,
        target: 'primary-commitment',
        domain: 'content',
        summary: 'Filming slot is ready to lock',
        action: 'shoot',
        signalType: signal.signal_type,
        signalId: signal.id,
        meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
      });
    }
  }

  for (const signal of opts.meshSignals.get('publishing_commitment') ?? []) {
    const dates = readDateList(signal.payload.dates);
    const topicTitlesByDate = readPublishingTopicTitlesByDate(signal.payload.topics);
    for (const date of dates) {
      const titles = topicTitlesByDate.get(date) ?? [];
      directives.push({
        id: `publish:${signal.id}:${date}`,
        date,
        target: 'content-execution',
        domain: 'content',
        summary: titles.length > 0
          ? `Publishing is due for ${titles.join(', ')}.`
          : 'A publishing commitment is due on this day.',
        action: 'publish',
        signalType: signal.signal_type,
        signalId: signal.id,
        meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
      });
    }
  }

  for (const signal of opts.meshSignals.get('sponsor_deliverable_due') ?? []) {
    const date = opts.content?.filmingRecommendation?.date ?? opts.training.weekStart;
    directives.push({
      id: `sponsor:${signal.id}:${date}`,
      date,
      target: 'primary-commitment',
      domain: 'content',
      summary: 'Sponsor deliverable needs a committed slot',
      action: 'sponsor',
      signalType: signal.signal_type,
      signalId: signal.id,
      meshPriority: signal.meshPriority ?? defaultMeshPriorityForSignal(signal.signal_type),
    });
  }

  return directives;
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
}): WeeklyPlanDay {
  const weekday = DateTime.fromISO(opts.date, { zone: config.app.timezone || 'Europe/Lisbon' }).toFormat('cccc');
  const trainingSession = sessionForDate(opts.training.sessions, opts.date, opts.training.weekStart);
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
  const meals = opts.gatedSkills.includes('cooking') || !opts.cooking
    ? []
    : buildMealPlanForDay({
        meals: mealsForDate(opts.cooking.meals, opts.date),
        trainingSession,
        availabilityDirective,
        mealCoverageDirective,
        mealPrepDirective,
        spendingDirective,
        budget,
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
  });
  const headline = buildDayHeadline(opts.date, trainingItem, contentItem, availabilityDirective, mealCoverageDirective);

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
    content: opts.gatedSkills.includes('content')
      ? {
          status: 'gated',
          title: 'Content gated',
          note: 'Upgrade to unlock content coordination in the mesh plan.',
          blockStart: null,
          blockEnd: null,
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
  if (!filmingToday && !contentExecutionDirective && deferredPrimaryDirective?.domain !== 'content') {
    return null;
  }

  if (availabilityDirective) {
    return {
      status: 'blocked',
      title: contentExecutionDirective ? 'Content work deferred' : 'Filming deferred',
      note: contentExecutionDirective
        ? `Content execution should wait because ${availabilityDirective.summary.toLowerCase()}.`
        : `Filming should wait because ${availabilityDirective.summary.toLowerCase()}.`,
      blockStart: filmingToday?.blockStart ?? null,
      blockEnd: filmingToday?.blockEnd ?? null,
      decisions: compactDirectives([contentExecutionDirective, availabilityDirective]),
    };
  }

  if (!contentExecutionDirective && primaryDirective?.domain === 'finance') {
    return {
      status: 'blocked',
      title: deferredPrimaryDirective?.domain === 'content' ? 'Content commitment deferred' : 'Filming deferred',
      note: deferredPrimaryDirective?.domain === 'content'
        ? `${deferredPrimaryDirective.summary} It still needs a protected slot after the finance/admin block clears.`
        : 'A higher-priority finance deadline needs this day first.',
      blockStart: filmingToday?.blockStart ?? null,
      blockEnd: filmingToday?.blockEnd ?? null,
      decisions: compactDirectives([primaryDirective, deferredPrimaryDirective]),
    };
  }

  if (!contentExecutionDirective && deferredPrimaryDirective?.domain === 'content') {
    return {
      status: 'blocked',
      title: 'Content commitment deferred',
      note: `${deferredPrimaryDirective.summary} Keep it visible as the next protected block after today's higher-priority obligation.`,
      blockStart: filmingToday?.blockStart ?? null,
      blockEnd: filmingToday?.blockEnd ?? null,
      decisions: compactDirectives([primaryDirective, deferredPrimaryDirective]),
    };
  }

  if (contentExecutionDirective) {
    const hasFilmingBlock = primaryDirective?.domain === 'content'
      && primaryDirective.action === 'shoot'
      && Boolean(filmingToday);
    const noteParts = [
      contentExecutionDirective.summary,
      hasFilmingBlock
        ? 'Use the filming block as the capture pass, then finish the publishing handoff the same day.'
        : filmingToday?.reason,
      primaryDirective?.domain === 'finance'
        ? 'Finance/admin still takes the first protected slot, so content should ship after that block.'
        : null,
      deferredPrimaryDirective?.domain === 'content'
        ? `${deferredPrimaryDirective.summary} should stay visible after the protected slot.`
        : null,
      spendingDirective
        ? `Keep the execution path lower-friction because ${spendingDirective.summary.toLowerCase()}.`
        : null,
    ].filter((value): value is string => Boolean(value));

    return {
      status: 'scheduled',
      title: hasFilmingBlock ? 'Capture + publishing day' : 'Publishing commitment',
      note: noteParts.join(' '),
      blockStart: filmingToday?.blockStart ?? null,
      blockEnd: filmingToday?.blockEnd ?? null,
      decisions: compactDirectives([
        contentExecutionDirective,
        hasFilmingBlock ? primaryDirective : undefined,
        primaryDirective?.domain === 'finance' ? primaryDirective : undefined,
        deferredPrimaryDirective?.domain === 'content' ? deferredPrimaryDirective : undefined,
        spendingDirective,
      ]),
    };
  }

  return {
    status: primaryDirective?.action === 'shoot' ? 'scheduled' : 'advisory',
    title: primaryDirective?.action === 'shoot' ? 'Filming block ready' : 'Filming opportunity',
    note: spendingDirective
      ? `${filmingToday?.reason ?? 'This looks like a workable filming window.'} Keep this production pass lower-friction because ${spendingDirective.summary.toLowerCase()}.`
      : filmingToday?.reason ?? 'This looks like a workable filming window.',
    blockStart: filmingToday?.blockStart ?? null,
    blockEnd: filmingToday?.blockEnd ?? null,
    decisions: compactDirectives([
      ...(primaryDirective?.action === 'shoot' ? [primaryDirective] : []),
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
}): WeeklyPlanSecretaryItem {
  const {
    secretary,
    date,
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
    return opts.deferredPrimaryDirective?.domain === 'content'
      ? 'Finance/admin needs the first protected slot today, but content still needs a real follow-on block after it.'
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
    steps.push('Reserve a real publish/delivery slot so content ships deliberately instead of becoming leftover work.');
  }

  if (opts.primaryDirective?.domain === 'content') {
    steps.push(
      opts.contentExecutionDirective
        ? 'Use the filming or sponsor block only after the publish/delivery commitment is protected.'
        : 'Use the filming or sponsor block only after training and core obligations are protected.',
    );
  }

  if (opts.spendingDirective) {
    steps.push('Bundle only essential errands or purchases and leave discretionary spend for another week.');
  }

  if (opts.deferredPrimaryDirective?.domain === 'content') {
    steps.push('Keep the deferred content commitment visible as the next protected block once the higher-priority work is done.');
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
  if (opts.availabilityDirective?.action === 'travel' && opts.trainingProtectionDirective) {
    return 'Travel compresses the day, so training needs protection first and everything optional should stay secondary.';
  }
  if (opts.trainingProtectionDirective && opts.mealCoverageDirective && opts.contentExecutionDirective && opts.primaryDirective?.domain === 'content') {
    return 'Training is the anchor, meals need closing before it, publishing still needs a real slot, and filming should only use whatever bandwidth remains after all three are protected.';
  }
  if (opts.trainingProtectionDirective && opts.mealCoverageDirective && opts.contentExecutionDirective) {
    return 'The day should sequence around training first, then meal support, then the publishing commitment before anything lower-value expands.';
  }
  if (opts.trainingProtectionDirective && opts.mealCoverageDirective && opts.primaryDirective?.domain === 'content') {
    return 'Training is the anchor, meals need closing before it, and content should only use whatever bandwidth remains after both are protected.';
  }
  if (opts.trainingProtectionDirective && opts.mealCoverageDirective) {
    return 'The day should sequence around training first, then meal support, before any lower-value work expands.';
  }
  if (opts.contentExecutionDirective && opts.primaryDirective?.domain === 'content') {
    return 'Publishing is the real delivery commitment today, so filming should support that outcome instead of displacing it.';
  }
  if (opts.primaryDirective?.domain === 'finance' && opts.spendingDirective) {
    return 'Admin needs the first slot, and the rest of the day should stay lean so finance pressure does not spread further.';
  }
  if (opts.primaryDirective?.domain === 'finance' && opts.deferredPrimaryDirective?.domain === 'content') {
    return 'Finance keeps the first protected slot, but content is still a real obligation and should be the next block instead of disappearing from the day.';
  }
  if (opts.contentExecutionDirective && opts.spendingDirective) {
    return 'Content still needs a real shipping slot today, but keep the production path lean and low-friction this week.';
  }
  if (opts.primaryDirective?.domain === 'content' && opts.spendingDirective) {
    return 'Content can still happen, but only in a lower-friction way that respects the tighter budget week.';
  }
  return null;
}

function compactDirectives(directives: Array<MeshDirective | undefined>): PlanDecision[] {
  return directives
    .filter((directive): directive is MeshDirective => Boolean(directive))
    .map((directive) => directiveDecision(directive));
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
  const budgetRatio = finance.monthlySummary.totalIncome > 0
    ? (finance.monthlySummary.totalIncome - finance.monthlySummary.totalExpenses) / finance.monthlySummary.totalIncome
    : 0;
  const nearestPending = finance.taxEvents.find((event) => String(event.status).toLowerCase() !== 'paid') ?? null;
  const renewalDate = finance.subscription.currentPeriodEnd
    ? DateTime.fromISO(finance.subscription.currentPeriodEnd).toISODate()
    : null;

  return {
    budgetNote: spendingDirective?.summary
      ?? (budget
        ? `Budget mode is ${budget.budgetMode}; grocery mode is ${budget.groceryMode}; training spend mode is ${budget.trainingSpendMode}; content spend mode is ${budget.contentSpendMode}.`
        : null)
      ?? (budgetRatio <= 0.25
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

function readMealExecutionReadinessSignal(cooking: CookingMeshContext): { status: string } | null {
  const signal = cooking.derivedSignals.find((entry) => entry.signalType === 'meal_execution_readiness');
  const status = signal?.payload.status;
  return typeof status === 'string' ? { status } : null;
}

function readBudgetSignal(finance: FinanceMeshContext): {
  budgetMode: string;
  groceryMode: string;
  trainingSpendMode: string;
  contentSpendMode: string;
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
    return null;
  }
  return { budgetMode, groceryMode, trainingSpendMode, contentSpendMode };
}

function buildDayHeadline(
  date: string,
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
    return content.title === 'Publishing commitment' || content.title === 'Capture + publishing day'
      ? 'Content is due today, so protect a clean shipping block.'
      : 'Energy and calendar line up well for filming here.';
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
): { headline: string; note: string } {
  const trainingDays = days.filter((day) => day.training.status !== 'rest').length;
  const filmingDay = days.find((day) => day.content?.status === 'scheduled');
  return {
    headline: variant === 'push'
      ? 'The mesh sees room to press a little harder this week.'
      : variant === 'conservative'
        ? 'This week protects consistency first, then performance.'
        : 'This week stays balanced across training, focus, and recovery.',
    note: filmingDay
      ? `Training, cooking, and content align cleanly around ${filmingDay.weekday}.`
      : `${trainingDays} training days are scheduled with the current cross-skill constraints in mind.`,
  };
}

function resolveAggressivenessVariant(
  training: TrainingMeshContext,
  garminStale: boolean,
): 'conservative' | 'steady' | 'push' {
  if (garminStale || training.trainingContext.flags.lowAdherence) {
    return 'conservative';
  }

  if (!training.activePlan) {
    return 'conservative';
  }

  const zone = config.app.timezone || 'Europe/Lisbon';
  const planAgeDays = Math.max(
    0,
    DateTime.now().setZone(zone).startOf('day').diff(
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
): TrainingSession | null {
  return sessions.find((session) => sessionDateForWeek(session, weekStart) === date) ?? null;
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
  secretary: SecretaryMeshContext,
  content: ContentMeshContext | null,
  weekStart: string,
): string {
  const dates = weekIsoDates(DateTime.fromISO(weekStart, { zone: config.app.timezone || 'Europe/Lisbon' }));
  const trainingLoadByDate = new Map(
    training.sessions.map((session) => {
      const date = sessionDateForWeek(session, weekStart);
      const load = inferTrainingLoadForBatchCook(session);
      return [date, load] as const;
    }),
  );
  const busyDates = new Set(
    readDateList(
      secretary.derivedSignals
        .find((signal) => signal.signalType === 'calendar_busy_blocks')
        ?.payload?.dates,
    ),
  );
  const travelDates = new Set(
    readDateList(
      secretary.derivedSignals
        .find((signal) => signal.signalType === 'travel_window')
        ?.payload?.dates,
    ),
  );
  const focusDate = secretary.focusBlock?.date ?? null;
  const filmingDate = content?.filmingRecommendation?.date ?? null;

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

  return dates
    .slice()
    .sort((lhs, rhs) => {
      const lhsScore =
        scoreLoad(trainingLoadByDate.get(lhs))
        + (travelDates.has(lhs) ? 8 : 0)
        + (busyDates.has(lhs) ? 4 : 0)
        + (filmingDate === lhs ? 3 : 0)
        + (focusDate === lhs ? 2 : 0);
      const rhsScore =
        scoreLoad(trainingLoadByDate.get(rhs))
        + (travelDates.has(rhs) ? 8 : 0)
        + (busyDates.has(rhs) ? 4 : 0)
        + (filmingDate === rhs ? 3 : 0)
        + (focusDate === rhs ? 2 : 0);

      if (lhsScore !== rhsScore) return lhsScore - rhsScore;
      return lhs.localeCompare(rhs);
    })[0] ?? dates[0];
}

function weekIsoDates(start: DateTime): string[] {
  return Array.from({ length: 7 }, (_, index) => start.plus({ days: index }).toISODate()!);
}

function resolveWeekWindow(weekStart?: string): { start: DateTime; weekStart: string; weekEnd: string } {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const base = weekStart
    ? DateTime.fromISO(weekStart, { zone }).startOf('day')
    : DateTime.now().setZone(zone).startOf('week');
  const start = (base.isValid ? base : DateTime.now().setZone(zone)).startOf('week');
  return {
    start,
    weekStart: start.toISODate()!,
    weekEnd: start.plus({ days: 6 }).toISODate()!,
  };
}

function resolveGatedSkills(user: User | null): string[] {
  if (!user) {
    return [];
  }
  if (user.tier === 'free') {
    return ['cooking', 'content', 'finance'];
  }
  return [];
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

function readPublishingTopicTitlesByDate(value: unknown): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  if (!Array.isArray(value)) {
    return grouped;
  }

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const date = typeof record.date === 'string' ? record.date : null;
    const title = typeof record.title === 'string' ? record.title : null;
    if (!date || !title) {
      continue;
    }
    const existing = grouped.get(date);
    if (existing) {
      existing.push(title);
    } else {
      grouped.set(date, [title]);
    }
  }

  return grouped;
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

function sessionDateForWeek(session: TrainingSession, weekStart: string): string {
  const start = DateTime.fromISO(weekStart, { zone: config.app.timezone || 'Europe/Lisbon' }).startOf('day');
  const normalized = session.day_of_week.trim().toLowerCase();
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const offset = weekdays.indexOf(normalized);
  return (offset >= 0 ? start.plus({ days: offset }) : start).toISODate()!;
}
