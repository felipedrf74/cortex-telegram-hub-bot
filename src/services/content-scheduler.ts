// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Content Scheduler Service
 *
 * TASK-14 Phase 2 — backs the iOS Content skill's Topic scheduler card.
 * Owns a user's self-created topics with optional publish dates: the
 * "here are the videos I plan to make in the next month" workflow.
 *
 * Distinct from `content-workflow.ts`:
 *   - content-workflow.ts → AI-generated topic CANDIDATES the user
 *     approves/rejects (sentiment-driven, runs inside the pipeline
 *     agent cron)
 *   - content-scheduler.ts → user's OWN manually-entered topics with
 *     optional publish dates, edited and reviewed interactively
 *
 * Migration 247 keeps this public API as a compatibility facade while all
 * topic CRUD persists through the canonical Content workspace. The retired
 * content_topics table is read-only and no longer a runtime write path.
 *
 * Status lifecycle:
 *   planned   → drafting → ready → published  (forward, happy path)
 *                                  → cancelled (abandoned, terminal)
 *
 * Scheduling here means a private workspace deadline only. Secretary work
 * blocks use the separate preview + explicit-confirmation contract.
 */

import { DateTime } from 'luxon';
import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { calculateReadiness } from './readiness-scorer';
import { getFocusBlockRecommendation } from './focus-planner';
import { readTrainingContextAll } from './training-signals';
import {
  getActivePlans,
  getSessionsForWeek,
  getWeeksForPlan,
  type TrainingPlan,
  type TrainingSession,
  type TrainingWeek,
} from './training-plans';
import { resolveTrainingPlanTimezone } from './training-date-utils';
import { getEvents, hasWritableCalendarForUser, type UnifiedCalendarEvent } from './unified-calendar';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import {
  countUpcomingContentTopicCompatibility,
  createContentTopicCompatibility,
  deleteContentTopicCompatibility,
  findContentTopicCompatibilityByClientRequestId,
  getContentTopicCompatibility,
  listContentTopicCompatibility,
  updateContentTopicCompatibility,
  type ContentTopicCompatibilityCreatePayload,
} from './content-topic-workspace-compat';

// ─── Types ──────────────────────────────────────────────────────────

export type ContentTopicStatus =
  | 'planned'
  | 'drafting'
  | 'ready'
  | 'published'
  | 'cancelled';

export interface ContentTopic {
  id: number;
  user_id: number;
  tenant_id?: number | null;
  owner_user_id?: number | null;
  visibility_scope?: string | null;
  lifecycle_state?: string | null;
  scope_status?: string | null;
  title: string;
  notes: string | null;
  scheduled_date: string | null;   // YYYY-MM-DD, nullable
  scheduled_at?: string | null;    // ISO local datetime, nullable
  status: ContentTopicStatus;
  secretary_task_list_id?: string | null;
  secretary_task_list_name?: string | null;
  secretary_task_external_id?: string | null;
  calendar_event_id?: string | null;
  calendar_source?: string | null;
  secretary_sync_status?: string | null;
  secretary_sync_error?: string | null;
  created_at: string;
  updated_at: string;
  /** Canonical workspace identity exposed additively during legacy API exit. */
  workspace_item_id?: number;
  compatibility_artifact_id?: number;
  compatibility_schema_version?: string;
  compatibility_mode?: string;
  schedule_semantics?: string;
}

export interface ContentFilmingRecommendation {
  date: string; // YYYY-MM-DD
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  reasons: string[];
  readinessScore: number | null;
  trainingLoad: 'hard' | 'moderate' | 'light' | 'rest' | 'unknown';
  calendarLoad: 'busy' | 'moderate' | 'light' | 'unknown';
  blockStart?: string | null;
  blockEnd?: string | null;
  calendarReservationAvailable?: boolean;
  calendarReservationMessage?: string | null;
}

/** Valid status transitions — enforced at the route layer. */
export const CONTENT_TOPIC_STATUSES: ContentTopicStatus[] = [
  'planned',
  'drafting',
  'ready',
  'published',
  'cancelled',
];

// ─── Create ─────────────────────────────────────────────────────────

export interface ContentTopicCreateOptions {
  notes?: string | null;
  scheduledDate?: string | null;
  scheduledAt?: string | null;
  status?: ContentTopicStatus;
  tenantId?: number | null;
  /**
   * BE-2/BE-3 (Content Studio): creation provenance recorded on the
   * immutable canonical idea revision. `clientRequestId` is the retry-safe
   * mutation identity used by supported clients.
   */
  provenance?: { source?: string | null; clientRequestId?: string | null } | null;
}

export function addTopic(
  userId: number,
  title: string,
  opts?: ContentTopicCreateOptions,
): ContentTopic {
  return createContentTopicCompatibility({
    scope: { tenantId: opts?.tenantId ?? userId, userId },
    title,
    notes: opts?.notes,
    scheduledDate: opts?.scheduledDate,
    scheduledAt: opts?.scheduledAt,
    status: opts?.status,
    source: opts?.provenance?.source,
    idempotencyKey: opts?.provenance?.clientRequestId,
  }).topic;
}

/**
 * BE-3 (Content Studio): idempotent-replay lookup. Returns the most recent
 * topic this user created with the given clientRequestId (recorded in
 * audit_metadata_json.provenance by addTopic), or null. Used by
 * POST /api/v1/content/topics to make retries after ambiguous network
 * failures return the original topic instead of creating a duplicate.
 * Gracefully returns null on databases without the audit column or
 * json_extract support.
 */
export function findTopicByClientRequestId(
  userId: number,
  clientRequestId: string,
  tenantId: number = userId,
  expected?: ContentTopicCompatibilityCreatePayload,
): ContentTopic | null {
  return findContentTopicCompatibilityByClientRequestId(
    { tenantId, userId },
    clientRequestId,
    undefined,
    expected,
  );
}

// ─── Read ───────────────────────────────────────────────────────────

/**
 * List topics for a user, with optional filters. Sort order:
 *   1. Scheduled topics first, ordered by scheduled_date ASC
 *   2. Unscheduled topics last, ordered by updated_at DESC
 *
 * This matches the iOS UI expectation: the upcoming timeline at the
 * top of the view, then "later" topics at the bottom.
 */
export function getTopics(
  userId: number,
  filters?: {
    status?: ContentTopicStatus;
    /** Only topics with scheduled_date >= this date (YYYY-MM-DD). */
    from?: string;
    /** Only topics with scheduled_date <= this date (YYYY-MM-DD). */
    to?: string;
    /** If true, only return scheduled topics (excludes null dates). */
    scheduledOnly?: boolean;
    /** Exclude cancelled + published by default — caller can opt in. */
    includeTerminal?: boolean;
    limit?: number;
    /** Required scope for internal/cross-skill callers; defaults to owner tenant for compatibility. */
    tenantId?: number;
  },
): ContentTopic[] {
  return listContentTopicCompatibility({
    scope: { tenantId: filters?.tenantId ?? userId, userId },
    status: filters?.status,
    from: filters?.from,
    to: filters?.to,
    scheduledOnly: filters?.scheduledOnly,
    includeTerminal: filters?.includeTerminal,
    limit: filters?.limit,
  });
}

/** Fetch a single topic by id, scoped to user_id. Returns null on miss. */
export function getTopicById(userId: number, topicId: number, tenantId: number = userId): ContentTopic | null {
  return getContentTopicCompatibility({ tenantId, userId }, topicId);
}

/**
 * Count of topics scheduled within the next N days (default: 14).
 * Used by the iOS Content skill landing page's Topic scheduler card
 * subtitle ("3 topics this week") without loading the full list.
 */
export function getUpcomingTopicCount(
  userId: number,
  daysAhead: number = 14,
  tenantId: number = userId,
): number {
  return countUpcomingContentTopicCompatibility({ tenantId, userId }, daysAhead);
}

// ─── Cross-skill filming recommendation ────────────────────────────

/**
 * Honest first slice of “Secretary talks to Training and picks the day
 * you're ready to film.” It scores the next 7 days using:
 *   - today's recovery/readiness,
 *   - planned training load,
 *   - calendar density,
 *   - existing topic deadlines.
 *
 * We return `null` only when absolutely nothing meaningful can be
 * inferred. Otherwise the response includes a confidence level so the
 * UI can speak with the right tone.
 */
export async function getFilmingRecommendation(
  userId: number,
  topics: ContentTopic[] | undefined = undefined,
  tenantId?: number,
): Promise<ContentFilmingRecommendation | null> {
  const resolvedTenantId = tenantId ?? userId;
  if (
    !isValidTenantUserId(userId)
    || !isValidTenantUserId(resolvedTenantId)
    || resolvedTenantId !== userId
  ) {
    recordTenantScopeAnomaly({
      layer: 'service',
      operation: 'get_content_filming_recommendation',
      reason: resolvedTenantId !== userId ? 'tenant_mismatch' : 'invalid_user_scope',
      userId: isValidTenantUserId(userId) ? userId : null,
      details: { tenantId: resolvedTenantId },
    });
    return null;
  }

  const scopedTopics = topics ?? getTopics(userId, {
    includeTerminal: false,
    limit: 100,
    tenantId: resolvedTenantId,
  });
  const zone = config.app.timezone;
  const today = DateTime.now().setZone(zone).startOf('day');
  const windowDays = 7;
  const rangeEnd = today.plus({ days: windowDays - 1 }).endOf('day');

  const [calendarResult, readinessResult] = await Promise.allSettled([
    getEvents(today.toUTC().toISO()!, rangeEnd.toUTC().toISO()!, userId),
    readBestReadiness(userId, tenantId),
  ]);

  const calendarEvents = calendarResult.status === 'fulfilled' ? calendarResult.value : [];
  const readiness = readinessResult.status === 'fulfilled' ? readinessResult.value : null;
  const trainingContext = readTrainingContextAll({ userId, tenantId });
  const trainingSchedule = buildTrainingSchedule(userId, resolvedTenantId, today, windowDays);

  const hasAnySignal =
    calendarEvents.length > 0 ||
    readiness?.score != null ||
    trainingSchedule.size > 0 ||
    trainingContext.signals.length > 0;

  if (!hasAnySignal) {
    return null;
  }

  const activeTopicDates = new Set(
    scopedTopics
      .filter((topic) => topic.status !== 'cancelled' && topic.status !== 'published')
      .map((topic) => topic.scheduled_date)
      .filter((date): date is string => Boolean(date)),
  );

  const candidates: FilmingCandidate[] = [];

  for (let offset = 0; offset < windowDays; offset += 1) {
    const date = today.plus({ days: offset });
    const iso = date.toISODate()!;
    const training = trainingSchedule.get(iso) ?? {
      load: 'rest' as const,
      scorePenalty: 0,
      reasons: [offset == 0
        ? 'No hard training is scheduled today.'
        : 'No hard training is planned for this day.'],
    };
    const calendar = summarizeCalendarLoad(calendarEvents, iso, zone);

    let score = 100;
    const reasons: string[] = [];

    score -= training.scorePenalty;
    reasons.push(...training.reasons);

    score -= calendar.scorePenalty;
    reasons.push(...calendar.reasons);

    if (activeTopicDates.has(iso)) {
      score -= 8;
      reasons.push('You already have a content deadline on this date.');
    }

    const fatigue = filmingFatiguePenalty({
      offset,
      readinessScore: readiness?.score ?? null,
      flags: trainingContext.flags,
    });
    score -= fatigue.scorePenalty;
    reasons.push(...fatigue.reasons);

    candidates.push({
      date: iso,
      score,
      reasons: dedupePreservingOrder(reasons).slice(0, 4),
      readinessScore: readiness?.score ?? null,
      trainingLoad: training.load,
      calendarLoad: calendar.load,
    });
  }

  candidates.sort((lhs, rhs) => {
    if (rhs.score !== lhs.score) return rhs.score - lhs.score;
    return lhs.date.localeCompare(rhs.date);
  });

  const best = candidates[0];
  if (!best) return null;

  const recommendation = buildRecommendation(best, {
    hadCalendarData: calendarResult.status === 'fulfilled',
    hadReadinessData: readiness?.score != null,
    hadTrainingData: trainingSchedule.size > 0 || trainingContext.signals.length > 0,
  });

  const suggestedBlock = tenantId == null
    ? null
    : await getFocusBlockRecommendation(userId, {
      tenantId,
      durationMinutes: 120,
      preferredDate: recommendation.date,
    });

  if (suggestedBlock?.date === recommendation.date) {
    recommendation.blockStart = suggestedBlock.start;
    recommendation.blockEnd = suggestedBlock.end;
  }

  recommendation.calendarReservationAvailable = hasWritableCalendarForUser(userId);
  recommendation.calendarReservationMessage = recommendation.calendarReservationAvailable
    ? null
    : 'Connect Google Calendar or Outlook in Settings to reserve this filming block.';

  logger.info(
    {
      userId,
      date: recommendation.date,
      confidence: recommendation.confidence,
      trainingLoad: recommendation.trainingLoad,
      calendarLoad: recommendation.calendarLoad,
      readinessScore: recommendation.readinessScore,
    },
    'Content filming recommendation generated',
  );

  return recommendation;
}

// ─── Update ─────────────────────────────────────────────────────────

/**
 * Patch a topic. Only the fields present in `updates` are written.
 * `scheduled_date` and `notes` accept explicit null to clear.
 * `status` is validated against the CONTENT_TOPIC_STATUSES allow-list.
 *
 * Returns the updated row, or null if no row matched.
 */
export function updateTopic(
  userId: number,
  topicId: number,
  updates: {
    title?: string;
    notes?: string | null;
    scheduled_date?: string | null;
    scheduled_at?: string | null;
    status?: ContentTopicStatus;
    secretary_task_list_id?: string | null;
    secretary_task_list_name?: string | null;
    secretary_task_external_id?: string | null;
    calendar_event_id?: string | null;
    calendar_source?: string | null;
    secretary_sync_status?: string | null;
    secretary_sync_error?: string | null;
  },
  tenantId: number = userId,
  idempotencyKey?: string,
  compatibilityOptions: { retireLegacySchedule?: boolean } = {},
): ContentTopic | null {
  const retiredSecretaryWrite = [
    updates.secretary_task_list_id,
    updates.secretary_task_list_name,
    updates.secretary_task_external_id,
    updates.calendar_event_id,
    updates.calendar_source,
    updates.secretary_sync_status,
    updates.secretary_sync_error,
  ].some((value) => value !== undefined);
  if (retiredSecretaryWrite) {
    throw new Error('content_topic_legacy_secretary_sync_is_retired');
  }
  return updateContentTopicCompatibility({
    scope: { tenantId, userId },
    compatTopicId: topicId,
    title: updates.title,
    notes: updates.notes,
    scheduledDate: updates.scheduled_date,
    scheduledAt: updates.scheduled_at,
    status: updates.status,
    retireLegacySchedule: compatibilityOptions.retireLegacySchedule,
    idempotencyKey,
  });
}

// ─── Delete ─────────────────────────────────────────────────────────

/**
 * Soft-delete the canonical item while preserving recovery history. The
 * legacy DELETE contract still returns a boolean for older clients.
 */
export function deleteTopic(
  userId: number,
  topicId: number,
  tenantId: number = userId,
  idempotencyKey?: string,
  compatibilityOptions: { retireLegacySchedule?: boolean } = {},
): boolean {
  return deleteContentTopicCompatibility(
    { tenantId, userId },
    topicId,
    { idempotencyKey, retireLegacySchedule: compatibilityOptions.retireLegacySchedule },
  );
}

// ─── Recommendation helpers ────────────────────────────────────────

type TrainingLoad = 'hard' | 'moderate' | 'light' | 'rest' | 'unknown';
type CalendarLoad = 'busy' | 'moderate' | 'light' | 'unknown';

interface FilmingCandidate {
  date: string;
  score: number;
  reasons: string[];
  readinessScore: number | null;
  trainingLoad: TrainingLoad;
  calendarLoad: CalendarLoad;
}

async function readBestReadiness(userId: number, tenantId?: number): Promise<{ score: number | null } | null> {
  try {
    const readiness = await calculateReadiness(userId, { tenantId });
    return { score: readiness?.score ?? null };
  } catch (err) {
    logger.debug({ err, userId }, 'Content filming recommendation readiness lookup failed');
    return null;
  }
}

function buildTrainingSchedule(
  userId: number,
  tenantId: number,
  startDate: DateTime,
  windowDays: number,
): Map<string, { load: TrainingLoad; scorePenalty: number; reasons: string[] }> {
  const byDate = new Map<string, { load: TrainingLoad; scorePenalty: number; reasons: string[] }>();
  const plans = getActivePlans(userId, tenantId);

  for (const plan of plans) {
    const weeks = getWeeksForPlan(plan.id);
    const schedulingTimezone = resolveTrainingPlanTimezone(plan);
    for (let offset = 0; offset < windowDays; offset += 1) {
      const date = startDate.plus({ days: offset });
      const planDate = date.setZone(schedulingTimezone).startOf('day');
      const week = weekForDate(plan, weeks, planDate, schedulingTimezone);
      if (!week) continue;
      const weekday = planDate.toFormat('EEEE');
      const sessions = getSessionsForWeek(week.id).filter((session) => session.day_of_week === weekday);
      if (sessions.length === 0) continue;

      const summary = summarizeTrainingSessions(sessions);
      const existing = byDate.get(date.toISODate()!);
      if (!existing || trainingPenaltyRank(summary.scorePenalty) > trainingPenaltyRank(existing.scorePenalty)) {
        byDate.set(date.toISODate()!, summary);
      }
    }
  }

  return byDate;
}

function weekForDate(
  plan: TrainingPlan,
  weeks: TrainingWeek[],
  date: DateTime,
  schedulingTimezone: string = resolveTrainingPlanTimezone(plan),
): TrainingWeek | null {
  const planStart = DateTime.fromISO(plan.start_date, { zone: schedulingTimezone }).startOf('day');
  const diffDays = Math.floor(date.startOf('day').diff(planStart, 'days').days);
  if (diffDays < 0) return null;
  const weekNumber = Math.floor(diffDays / 7) + 1;
  if (weekNumber < 1 || weekNumber > Math.max(1, plan.duration_weeks || 1)) return null;
  return weeks.find((week) => week.week_number === weekNumber) ?? null;
}

function summarizeTrainingSessions(sessions: TrainingSession[]): {
  load: TrainingLoad;
  scorePenalty: number;
  reasons: string[];
} {
  const hard = sessions.some(isHardSession);
  const moderate = sessions.some(isModerateSession);

  if (hard) {
    return {
      load: 'hard',
      scorePenalty: 34,
      reasons: ['There is a hard training session planned, so filming would compete with your best energy.'],
    };
  }

  if (moderate) {
    return {
      load: 'moderate',
      scorePenalty: 16,
      reasons: ['Training is planned, but it looks manageable around a filming block.'],
    };
  }

  return {
    load: 'light',
    scorePenalty: 6,
    reasons: ['Only light training is planned, so it should be easier to film well.'],
  };
}

function isHardSession(session: TrainingSession): boolean {
  const blob = `${session.session_type} ${session.title} ${session.intensity_text ?? ''} ${session.description ?? ''}`.toLowerCase();
  return /\b(interval|vo2|threshold|tempo|race|long ride|long run|heavy|max|squat|deadlift|track|ftp)\b/.test(blob);
}

function isModerateSession(session: TrainingSession): boolean {
  const blob = `${session.session_type} ${session.title} ${session.intensity_text ?? ''} ${session.description ?? ''}`.toLowerCase();
  return /\b(run|ride|swim|gym|strength|endurance|cycling|running|muscula|corrida|pedal|natação|natacao)\b/.test(blob);
}

function trainingPenaltyRank(scorePenalty: number): number {
  if (scorePenalty >= 30) return 3;
  if (scorePenalty >= 15) return 2;
  if (scorePenalty > 0) return 1;
  return 0;
}

function summarizeCalendarLoad(
  events: UnifiedCalendarEvent[],
  isoDate: string,
  zone: string,
): { load: CalendarLoad; scorePenalty: number; reasons: string[] } {
  const dayEvents = events.filter((event) => {
    const localDay = DateTime.fromISO(event.start, { zone: 'utc' }).setZone(zone).toISODate();
    return localDay === isoDate && !looksLikeTrainingEvent(event.summary || '');
  });

  if (dayEvents.length === 0) {
    return {
      load: 'light',
      scorePenalty: 0,
      reasons: ['Your calendar is clear, so you have room to film without collisions.'],
    };
  }

  const totalHours = dayEvents.reduce((sum, event) => {
    const start = DateTime.fromISO(event.start, { zone: 'utc' });
    const end = DateTime.fromISO(event.end, { zone: 'utc' });
    return sum + Math.max(0, end.diff(start, 'hours').hours);
  }, 0);

  if (dayEvents.length >= 4 || totalHours >= 5) {
    return {
      load: 'busy',
      scorePenalty: 28,
      reasons: ['Your calendar is busy that day, so filming would likely fragment or run late.'],
    };
  }

  if (dayEvents.length >= 2 || totalHours >= 2.5) {
    return {
      load: 'moderate',
      scorePenalty: 12,
      reasons: ['You have a few calendar commitments, but there is still some room to film.'],
    };
  }

  return {
    load: 'light',
    scorePenalty: 4,
    reasons: ['The calendar looks light, which is good for a focused filming block.'],
  };
}

function looksLikeTrainingEvent(summary: string): boolean {
  return /\b(workout|training|run|ride|swim|strength|gym|interval|tempo|recovery|corrida|treino|pedal|natação|natacao|musculação|musculacao)\b/i.test(summary);
}

function filmingFatiguePenalty(opts: {
  offset: number;
  readinessScore: number | null;
  flags: {
    lowSleep: boolean;
    lowHrv: boolean;
    lowReadiness: boolean;
    highLegLoad: boolean;
  };
}): { scorePenalty: number; reasons: string[] } {
  const reasons: string[] = [];
  let scorePenalty = 0;
  const fatigueActive = opts.flags.lowReadiness || opts.flags.lowSleep || opts.flags.lowHrv || opts.flags.highLegLoad;

  if (opts.offset === 0 && opts.readinessScore != null && opts.readinessScore < 55) {
    scorePenalty += 24;
    reasons.push(`Today's readiness is only ${opts.readinessScore}/100, so filming tomorrow or later is safer.`);
  } else if (opts.offset === 1 && opts.readinessScore != null && opts.readinessScore < 55) {
    scorePenalty += 10;
    reasons.push('Giving yourself one more recovery day should improve filming quality.');
  } else if (opts.readinessScore != null && opts.readinessScore >= 70 && opts.offset <= 2) {
    reasons.push(`Readiness looks solid at ${opts.readinessScore}/100, which supports a focused filming block.`);
  }

  if (fatigueActive && opts.offset === 0) {
    scorePenalty += 18;
    reasons.push('Recent recovery signals suggest protecting today rather than stacking filming on top.');
  } else if (fatigueActive && opts.offset === 1) {
    scorePenalty += 6;
    reasons.push('This gives your current recovery dip a little more room to settle.');
  }

  return { scorePenalty, reasons };
}

function buildRecommendation(
  candidate: FilmingCandidate,
  opts: {
    hadCalendarData: boolean;
    hadReadinessData: boolean;
    hadTrainingData: boolean;
  },
): ContentFilmingRecommendation {
  const dataSources = [opts.hadCalendarData, opts.hadReadinessData, opts.hadTrainingData].filter(Boolean).length;
  const confidence: ContentFilmingRecommendation['confidence'] =
    dataSources >= 3 ? 'high' : dataSources === 2 ? 'medium' : 'low';

  return {
    date: candidate.date,
    confidence,
    reason: candidate.reasons[0] ?? 'This day has the cleanest mix of energy and calendar space for filming.',
    reasons: candidate.reasons,
    readinessScore: candidate.readinessScore,
    trainingLoad: candidate.trainingLoad,
    calendarLoad: candidate.calendarLoad,
  };
}

function dedupePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
