// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../../utils/logger';
import { getCached, setCache } from '../../services/cache-store';
import { getDb } from '../../services/database';
import * as trainingPlans from '../../services/training-plans';
import { calculateReadiness } from '../../services/readiness-scorer';
import type { CoachKernelReadinessInput } from '../../services/training-coach-kernel-plan-generator';
import { getActivitiesByDateForUser } from '../../services/garmin';
import { buildCalendarEventLookup, type TrainingCalendarLookup } from './training-calendar-lookup';
import {
  estimateCalendarDurationMinutes,
  humanizeSessionType,
  inferCalendarSessionType,
  looksLikeTrainingCalendarEvent,
  normalizeTrainingStatus,
  parseExercises,
} from './training-calendar-utils';
import { readinessResultToSnapshot } from '../../services/coach-kernel/readiness-snapshot-adapter';
import { adaptSessionForReadiness, type AdaptationContext } from '../../services/coach-kernel/adaptation-engine';
import { isKeepOriginalSetForToday } from '../../services/training-keep-original';
import {
  calendarSyncStateIsLinked,
  resolveCalendarSyncState,
} from '../../services/training-calendar-sync-state';
import { findExistingOwnership } from '../../services/training-plan-lifecycle';
import { isConnected } from '../../services/oauth-store';
import type { Session, SessionType, Sport, ReadinessSnapshot } from '../../services/coach-kernel/types';
import { requireTenantIdParam } from '../../services/tenant-scope';

const READINESS_TTL = 5 * 60; // 5 minutes — intraday energy reserve should move during the day
const READINESS_STALE_MAX_AGE_HOURS = 36;

/**
 * Map the user-facing iOS sessionType label (e.g. `'gym'`, `'run'`) to a
 * coach-kernel `SessionType` enum value. Returns `null` when the label is
 * missing or doesn't fit a kernel category — the caller skips adaptation
 * in that case (better to render the original session than to misclassify).
 */
function inferKernelSessionType(rawSessionType: string | null | undefined, status: string | null | undefined): SessionType | null {
  const normalized = (rawSessionType ?? '').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'rest' || status === 'rest') return 'rest';
  if (normalized === 'mobility' || normalized === 'recovery_mobility') return 'mobility';
  if (normalized === 'gym' || normalized.startsWith('strength')) return 'strength_hypertrophy';
  if (normalized === 'recovery_run') return 'recovery_run';
  if (normalized === 'recovery_ride') return 'recovery_ride';
  if (normalized === 'recovery_swim') return 'recovery_swim';
  // The iOS DTO uses coarse sport labels — for adaptation purposes we
  // only need a "kind" the engine can rule on. Map running/cycling/swimming
  // to a generic threshold/aerobic session — the engine's branch logic
  // doesn't depend on the precise SessionType for non-recovery cases.
  if (normalized === 'run') return 'easy_run';
  if (normalized === 'ride' || normalized === 'bike' || normalized === 'cycling') return 'endurance_ride';
  if (normalized === 'swim' || normalized === 'swimming') return 'aerobic_swim';
  return null;
}

function inferKernelSport(rawSessionType: string | null | undefined): Sport | null {
  const normalized = (rawSessionType ?? '').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'gym' || normalized.startsWith('strength')) return 'strength';
  if (normalized === 'run' || normalized.startsWith('recovery_run') || normalized.endsWith('_run')) return 'running';
  if (normalized === 'ride' || normalized === 'bike' || normalized === 'cycling' || normalized.endsWith('_ride')) return 'cycling';
  if (normalized === 'swim' || normalized === 'swimming' || normalized.endsWith('_swim')) return 'swimming';
  return null;
}

export interface SessionAdaptation {
  /** Multiplier applied to prescribed intensity. Always in [0, 1]. */
  intensityDownshiftPct: number;
  /** Original sessionType before adaptation. Set ONLY when the engine
   *  swapped the type (red readiness or injury). Undefined when intensity
   *  was simply downshifted. */
  originalSessionType?: string;
  /** Why the adapter changed the session. iOS uses this to pick a chip
   *  color and explanatory copy. */
  reason: 'red_readiness' | 'orange_readiness' | 'injury_safe_swap' | 'no_change';
  /** Code-emitted explanation. Stable across runs given the same inputs. */
  explanation: string;
}

/**
 * Apply readiness-aware adaptation to an iOS-shaped session DTO. Returns
 * `null` when adaptation could not be performed (e.g., session has no
 * recognizable sport/type). Pure function — no I/O, no DB.
 *
 * iOS consumes the result via the `adaptation` field on the session DTO
 * to render the "easy day" / "swapped to recovery" chip.
 */
export function adaptDtoSessionForReadiness(
  dtoSession: { sessionType: string | null; status?: string | null },
  snapshot: ReadinessSnapshot,
  injuryAffectsSession?: boolean,
): SessionAdaptation | null {
  const sport = inferKernelSport(dtoSession.sessionType);
  const sessionType = inferKernelSessionType(dtoSession.sessionType, dtoSession.status ?? null);
  if (!sport || !sessionType) return null;

  const kernelSession: Session = {
    id: 'dto',
    sport,
    sessionType,
    title: '',
    description: '',
    dayOfWeek: 'monday',
    durationMinutes: 0,
    intensityZone: 'aerobic',
    fatigueCost: 'medium',
    keySession: false,
    plannedLoad: 0,
    tags: [],
  };

  const ctx: AdaptationContext = {
    readiness: snapshot,
    injuryAffectsSession,
  };
  const adapted = adaptSessionForReadiness(kernelSession, ctx);
  return {
    intensityDownshiftPct: adapted.intensityDownshiftPct ?? 1.0,
    originalSessionType: adapted.originalSessionType,
    reason: adapted.adaptationReason,
    explanation: adapted.adaptationExplanation,
  };
}

/**
 * Parse the `description_json` column into a structured object for
 * iOS rendering. Returns `null` when the column is empty or contains
 * malformed JSON — iOS falls back to the plain-text `description` in
 * that case so we never break the read path on a bad row.
 */
function parseDescriptionSections(raw: string | null | undefined): unknown {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    logger.warn({ err }, 'Failed to parse training_sessions.description_json — falling back to plain text');
    return null;
  }
}

export async function getTodaySession(userId: number, tenantId: number) {
  let session: any = null;
  let plan: any = null;

  try {
    const activePlan = trainingPlans.getActivePlan(userId, tenantId);
    if (activePlan) {
      const currentWeek = trainingPlans.getCurrentWeek(activePlan.id);
      plan = {
        id: activePlan.id,
        name: activePlan.name,
        planVersion: activePlan.plan_version ?? null,
        lifecycleState: activePlan.status ?? 'active',
        weekNumber: currentWeek?.week_number || 1,
        phase: currentWeek?.focus || activePlan.periodization || null,
        calendarSource: resolvePlanCalendarSource(activePlan),
      };
      if (currentWeek) {
        const sessions = trainingPlans.getSessionsForWeek(currentWeek.id);
        const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const rawSession = sessions?.find((s: any) => s.day_of_week === todayName);
        if (rawSession) {
          // Calendar enrichment is purely decorative — it adds the
          // `time:` field. If Outlook/Google calendar is degraded
          // (invalid_grant, rate-limit, transient error), buildCalendarEventLookup
          // throws — we MUST NOT let that erase the real session
          // (title, exercises, duration) we already loaded from SQLite.
          // Production bug 2026-04-26: when calendar lookup threw, today's
          // card silently fell through to Garmin/calendar fallbacks and
          // the week list went empty even though the plan was real.
          let calendarLookup: TrainingCalendarLookup = new Map();
          try {
            const range = currentWeekDateRange(activePlan.start_date, currentWeek.week_number);
            calendarLookup = await buildCalendarEventLookup(range.start, range.end, userId);
          } catch (err) {
            logger.debug({ err, userId }, 'getTodaySession: calendar enrichment failed — rendering session without start time');
          }
          const providerDisconnected = isSessionCalendarProviderDisconnected(rawSession, userId);
          const linkedCalendarEvent = rawSession.calendar_event_id
            ? calendarLookup.get(rawSession.calendar_event_id)
            : null;
          const verifiedCalendarEventId = providerDisconnected
            ? null
            : resolveVerifiedCalendarEventId({
                session: rawSession,
                plan: activePlan,
                linkedCalendarEvent,
                userId,
                tenantId,
              });
          session = {
            id: rawSession.id != null ? String(rawSession.id) : null,
            planId: rawSession.plan_id != null ? String(rawSession.plan_id) : null,
            planVersion: activePlan.plan_version ?? null,
            sessionIdentityKey: rawSession.session_identity_key || null,
            sessionShapeHash: rawSession.session_shape_hash || null,
            lifecycleState: rawSession.status || 'pending',
            type: rawSession.title || humanizeSessionType(rawSession.session_type),
            sessionType: rawSession.session_type || null,
            time: verifiedCalendarEventId ? linkedCalendarEvent?.time ?? null : null,
            calendarEventId: verifiedCalendarEventId,
            calendarSource: verifiedCalendarEventId ? rawSession.calendar_source || null : null,
            calendarSyncState: resolveCalendarSyncState({
              hasStoredCalendarEventId: Boolean(rawSession.calendar_event_id),
              verifiedCalendarEventId,
              providerDisconnected,
              manualUnscheduled: normalizeTrainingStatus(rawSession.status) === 'unscheduled',
            }),
            duration: rawSession.duration_minutes || null,
            status: normalizeTrainingStatus(rawSession.status),
            notes: rawSession.description || null,
            descriptionSections: parseDescriptionSections(rawSession.description_json),
            exercises: parseExercises(rawSession.exercises_json),
            preferredTimeUnavailable: Number(rawSession.preferred_time_unavailable) === 1,
          };
        }
      }
    }
  } catch (e) {
    logger.debug({ err: e }, 'getTodaySession training-plans lookup failed');
  }

  // Bug fix 2026-04-28 (no-plan create-CTA): the calendar and Garmin
  // fallbacks below ran UNCONDITIONALLY, so a user who deleted their
  // active Training plan but had a Garmin-recorded workout that day
  // would see "Today's workout completed (status: completed)"
  // composed from Garmin activity data — even though no Nexus plan
  // existed. That hid the create-plan CTA on the iOS Training screen
  // because the iOS hero classifier checks `.completed` before
  // `.noPlan` and gave the user no way to start fresh. Gating both
  // fallbacks on `plan != null` keeps the legitimate "active plan +
  // Garmin records the day's session" UX intact while ensuring that
  // a deleted/cancelled plan returns a null session — which iOS then
  // resolves to the .noPlan hero state with the "Create plan" action.
  //
  // We use the local `plan` variable (set only inside the active-
  // plan try block above when getActivePlan returned non-null) as
  // the gate. If the DB read itself threw, `plan` stays null and we
  // also skip the fallbacks — that's the safer choice than dressing
  // up Garmin data as a Nexus session under partial-failure
  // conditions.
  if (!session && plan) {
    session = await findTodayTrainingFromCalendar(userId);
  }

  if (!session && plan) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const activities = await getActivitiesByDateForUser(userId, today, today);
      if (activities.length > 0) {
        const activity = activities[activities.length - 1];
        const activityType = activity.activityType?.typeKey || activity.activityName || 'workout';
        session = {
          id: activity.activityId ? String(activity.activityId) : null,
          type: isStrengthActivity(activityType)
            ? `Strength: ${activity.activityName || 'Gym Session'}`
            : activity.activityName || 'Workout',
          sessionType: isStrengthActivity(activityType) ? 'gym' : 'run',
          time: null,
          duration: activity.duration ? Math.round(activity.duration / 60) : null,
          status: 'completed',
          notes: null,
          exercises: null,
        };
      }
    } catch {
      // Garmin unavailable — continue with null session (rest day)
    }
  }

  // Slice 1.C — best-effort readiness-aware adaptation. We call the cached
  // `getReadiness(userId)` (5-min TTL) so this is cheap on the hot path.
  // If readiness is unavailable, adaptation is skipped and the session
  // renders as written.
  //
  // Training redesign Phase 0 — keep-original opt-out: when the user posted
  // /training/today/keep-original for the current local day, skip adaptation
  // entirely so the session renders exactly as written (`adaptation: null`
  // → iOS hides the chip).
  let adaptation: SessionAdaptation | null = null;
  if (session && !isKeepOriginalSetForToday(userId)) {
    try {
      const readinessSummary = await getReadiness(userId);
      const snapshot = readinessResultToSnapshot({
        score: typeof readinessSummary?.score === 'number' ? readinessSummary.score : undefined,
        sleepHours: typeof readinessSummary?.sleepDurationHours === 'number' && readinessSummary.sleepDurationHours > 0
          ? readinessSummary.sleepDurationHours
          : undefined,
        hrvStatus: readinessSummary?.factors?.hrvStatus === 'down'
          ? 'low'
          : readinessSummary?.factors?.hrvStatus === 'up'
            ? 'high'
            : readinessSummary?.factors?.hrvStatus === 'stable'
              ? 'normal'
              : undefined,
        energyReserve: typeof readinessSummary?.factors?.bodyBattery === 'number'
          ? readinessSummary.factors.bodyBattery
          : undefined,
        reasoning: typeof readinessSummary?.reasoning === 'string'
          ? readinessSummary.reasoning
          : undefined,
      });
      // Moderate-injury auto-swap is intentionally deferred on this read model.
      // `injuryAffectsSession` stays undefined until product opts into deriving
      // it from structured intake for today's session.
      adaptation = adaptDtoSessionForReadiness(
        { sessionType: session.sessionType ?? null, status: session.status ?? null },
        snapshot,
      );
    } catch (err) {
      logger.debug({ err, userId }, 'getTodaySession: readiness-aware adaptation skipped');
    }
  }

  return {
    session: session ? {
      id: session.id ? String(session.id) : null,
      planId: session.planId ? String(session.planId) : null,
      planVersion: session.planVersion ?? null,
      sessionIdentityKey: session.sessionIdentityKey ?? null,
      sessionShapeHash: session.sessionShapeHash ?? null,
      lifecycleState: session.lifecycleState ?? session.status ?? 'planned',
      type: session.type || session.name || 'Workout',
      sessionType: session.sessionType || null,
      time: session.time || null,
      duration: session.duration || null,
      status: session.status || 'planned',
      notes: session.notes || null,
      descriptionSections: session.descriptionSections || null,
      exercises: session.exercises || null,
      calendarEventId: session.calendarEventId || null,
      calendarSource: session.calendarSource || null,
      calendarSyncState: session.calendarSyncState || null,
      // Default to false when the session source is calendar/garmin
      // fallback (which never has a planner-derived flag).
      preferredTimeUnavailable: session.preferredTimeUnavailable === true,
      // Slice 1.C — readiness-aware adaptation. Null when adaptation
      // could not be inferred (unknown sessionType, no readiness data,
      // calendar/garmin fallback session). iOS only renders the chip
      // when this is non-null AND `reason !== 'no_change'`.
      adaptation,
    } : null,
    plan,
  };
}

export async function getWeekPlan(userId: number, tenantId: number) {
  let weekNumber = 0;
  let sessions: any[] = [];
  let adherence = 0;
  let planSummary: {
    id?: number;
    name: string;
    planVersion?: number | null;
    lifecycleState?: string | null;
    weekNumber: number;
    phase: string | null;
    calendarSource?: string | null;
  } | null = null;

  try {
    const plan = trainingPlans.getActivePlan(userId, tenantId);
    if (plan) {
      const currentWeek = trainingPlans.getCurrentWeek(plan.id);
      weekNumber = currentWeek?.week_number || 1;
      planSummary = {
        id: plan.id,
        name: plan.name,
        planVersion: plan.plan_version ?? null,
        lifecycleState: plan.status ?? 'active',
        weekNumber,
        phase: currentWeek?.focus || plan.periodization || null,
        calendarSource: resolvePlanCalendarSource(plan),
      };
      const weekSessions = currentWeek ? trainingPlans.getSessionsForWeek(currentWeek.id) : [];
      if (Array.isArray(weekSessions) && weekSessions.length > 0) {
        // Calendar enrichment is purely decorative (adds `time:`). A
        // calendar provider failure (invalid_grant, rate-limit, etc.)
        // must NOT erase the user's plan from the Week view — we render
        // the SQLite sessions as-is and just drop the start-time field.
        // Production bug 2026-04-26: when Outlook tokens went bad, the
        // calendar await threw, the outer try/catch swallowed it, and
        // sessions stayed empty so iOS Week 1 showed "no sessions yet"
        // even though the plan/week/session rows were intact.
        let calendarLookup: TrainingCalendarLookup = new Map();
        try {
          const range = currentWeekDateRange(plan.start_date, weekNumber);
          calendarLookup = await buildCalendarEventLookup(range.start, range.end, userId);
        } catch (err) {
          logger.debug({ err, userId }, 'getWeekPlan: calendar enrichment failed — rendering sessions without start times');
        }
        sessions = weekSessions.map((s: any) => {
          const linkedCalendarEvent = s.calendar_event_id
            ? calendarLookup.get(s.calendar_event_id) ?? null
            : null;
          return buildWeekSessionDto(s, plan, linkedCalendarEvent, userId, tenantId);
        });
      }
      const adh = currentWeek ? trainingPlans.getWeeklyAdherence?.(plan.id, currentWeek.id) : null;
      adherence = typeof adh === 'number'
        ? adh
        : typeof adh?.adherenceRate === 'number'
          ? adh.adherenceRate / 100
          : 0;
    }
  } catch (err) {
    logger.debug({ err, userId, tenantId }, 'getWeekPlan: primary read-model assembly failed — falling back to calendar-derived week');
  }

  if (planSummary && sessions.length === 0) {
    sessions = await buildWeekFromCalendar(userId);
    const completed = sessions.filter((s) => s.status === 'completed').length;
    const total = sessions.filter((s) => s.status !== 'rest').length;
    adherence = total > 0 ? completed / total : 0;
  }

  return {
    plan: planSummary,
    weekNumber,
    sessions,
    adherence: typeof adherence === 'number' ? adherence : 0,
    completedCount: sessions.filter((s: any) => s.status === 'completed').length,
    totalCount: sessions.filter((s: any) => !isInactiveTrainingReadModelStatus(s.status)).length,
    ...summarizeTrainingSyncState(sessions),
    calendarCleanup: buildTrainingCalendarCleanupSnapshot(userId, tenantId),
  };
}

export async function getAllPlanWeeks(userId: number, tenantId: number) {
  const plan = trainingPlans.getActivePlan(userId, tenantId);
  if (!plan) {
    return {
      plan: null,
      weeks: [],
      // Ghost provider events can outlive the plan that created them —
      // a canceled plan whose deletes dead-lettered is exactly the case
      // the count exists for, so it ships on the no-plan path too.
      calendarCleanup: buildTrainingCalendarCleanupSnapshot(userId, tenantId),
    };
  }

  // preferences_json is written by training-plan-generation (raceDate,
  // goalMode, trainingLearningPath, ...) but legacy plans can carry null
  // or malformed JSON — tolerate both rather than failing the whole read
  // model.
  const planPreferences = parsePlanPreferences(plan.preferences_json);
  const learningByWeek = buildTrainingLearningWeekLookup(planPreferences?.trainingLearningPath);
  const weeks = trainingPlans.getWeeksForPlan(plan.id);
  const mappedWeeks = [];

  for (const week of weeks) {
    let calendarLookup: TrainingCalendarLookup = new Map();
    try {
      const range = currentWeekDateRange(plan.start_date, week.week_number);
      calendarLookup = await buildCalendarEventLookup(range.start, range.end, userId);
    } catch (err) {
      logger.debug({ err, userId, planId: plan.id, weekNumber: week.week_number }, 'getAllPlanWeeks: calendar enrichment failed');
    }

    const sessions = trainingPlans.getSessionsForWeek(week.id).map((session: any) => {
      const linkedCalendarEvent = session.calendar_event_id
        ? calendarLookup.get(session.calendar_event_id) ?? null
        : null;
      return buildWeekSessionDto(session, plan, linkedCalendarEvent, userId, tenantId);
    });
    const syncSummary = summarizeTrainingSyncState(sessions);

    mappedWeeks.push({
      weekNumber: week.week_number,
      phase: week.focus || plan.periodization || null,
      intensityPct: typeof week.intensity_pct === 'number' ? week.intensity_pct : null,
      adjustmentReason: week.adjustment_reason || null,
      learningFocus: learningByWeek.get(Number(week.week_number)) ?? null,
      sessions,
      activeSessionCount: syncSummary.activeSessionCount,
      syncedSessionCount: syncSummary.syncedSessionCount,
      missingSessionCount: syncSummary.missingSessionCount,
      weekSyncStatus: syncSummary.planSyncStatus,
    });
  }

  return {
    plan: {
      id: plan.id,
      name: plan.name,
      planVersion: plan.plan_version ?? null,
      durationWeeks: plan.duration_weeks,
      lifecycleState: plan.status ?? 'active',
      startDate: plan.start_date,
      endDate: plan.end_date,
      periodization: plan.periodization ?? null,
      raceDate: typeof planPreferences?.raceDate === 'string' ? planPreferences.raceDate : null,
      goalMode: typeof planPreferences?.goalMode === 'string' ? planPreferences.goalMode : null,
      // Requested-vs-scheduled transparency: the flat preference keys are
      // REALIZED targets (re-persisted from the finalized plan), while
      // requestedTargets preserves what the user asked for. Legacy plans
      // (pre-4.14.211) have no requestedTargets — `requested` stays null
      // rather than guessing.
      weeklyTargets: buildPlanWeeklyTargetsSnapshot(planPreferences),
      whyThisPlan: Array.isArray(planPreferences?.trainingPlanQuality?.whyThisPlan)
        ? planPreferences.trainingPlanQuality.whyThisPlan
            .map((value: unknown) => String(value || '').trim())
            .filter(Boolean)
        : [],
      calendarSource: resolvePlanCalendarSource(plan),
    },
    weeks: mappedWeeks,
    calendarCleanup: buildTrainingCalendarCleanupSnapshot(userId, tenantId),
  };
}

// Dead-lettered calendar-cleanup visibility (migration 220): counts
// Training-sourced agenda rows whose provider delete permanently failed
// (`delete_failed` at/over the dead-letter threshold) — those events
// still exist in the user's Google/Outlook calendar and the sync loop
// has stopped retrying them. `null` means "nothing to report" (zero
// rows, pre-migration DB, or the table is unavailable) so old clients
// and healthy states stay byte-identical.
// Mirrors PROVIDER_SYNC_DEAD_LETTER_THRESHOLD in
// services/secretary-agenda-provider-sync.ts (module-private there).
const TRAINING_CALENDAR_CLEANUP_DEAD_LETTER_THRESHOLD = 5;

function buildTrainingCalendarCleanupSnapshot(
  userId: number,
  tenantId: number,
): { deadLetteredCount: number } | null {
  try {
    const db = getDb();
    const hasTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get('secretary_agenda_items');
    if (!hasTable) return null;
    const columns = db.prepare('PRAGMA table_info(secretary_agenda_items)').all() as Array<{ name?: string }>;
    if (!columns.some((column) => column?.name === 'provider_sync_failure_count')) return null;
    const row = db.prepare(`
      SELECT COUNT(*) AS deadLetteredCount
      FROM secretary_agenda_items
      WHERE owner_user_id = ?
        AND tenant_id = ?
        AND source_skill = 'training'
        AND provider_sync_state = 'delete_failed'
        AND provider_sync_failure_count >= ?
    `).get(userId, String(tenantId), TRAINING_CALENDAR_CLEANUP_DEAD_LETTER_THRESHOLD) as
      { deadLetteredCount?: number } | undefined;
    const count = typeof row?.deadLetteredCount === 'number' ? row.deadLetteredCount : 0;
    return count > 0 ? { deadLetteredCount: count } : null;
  } catch (err) {
    logger.debug({ err, userId, tenantId }, 'training calendar cleanup snapshot failed — omitting');
    return null;
  }
}

function resolvePlanCalendarSource(plan: any): 'google' | 'outlook' | null {
  const preferences = parsePlanPreferences(plan?.preferences_json);
  const source = preferences?.trainingCalendarSource ?? preferences?.calendarSource;
  return source === 'google' || source === 'outlook' ? source : null;
}

function normalizeReadModelCalendarSource(value: unknown): 'google' | 'outlook' | null {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'google' || normalized === 'outlook' ? normalized : null;
}

function isSessionCalendarProviderDisconnected(session: any, userId: number): boolean {
  if (!session?.calendar_event_id) return false;
  const source = normalizeReadModelCalendarSource(session.calendar_source);
  if (!source) return false;
  try {
    return !isConnected(userId, source);
  } catch {
    return true;
  }
}

function parsePlanPreferences(raw: unknown): Record<string, any> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

type WeeklyTargetSnapshot = {
  sessionsPerWeek: number | null;
  runSessionsPerWeek: number | null;
  bikeSessionsPerWeek: number | null;
  swimSessionsPerWeek: number | null;
  strengthSessionsPerWeek: number | null;
};

function normalizeWeeklyTargetSnapshot(raw: unknown): WeeklyTargetSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const pick = (key: string): number | null => {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const snapshot: WeeklyTargetSnapshot = {
    sessionsPerWeek: pick('sessionsPerWeek'),
    runSessionsPerWeek: pick('runSessionsPerWeek'),
    bikeSessionsPerWeek: pick('bikeSessionsPerWeek'),
    swimSessionsPerWeek: pick('swimSessionsPerWeek'),
    strengthSessionsPerWeek: pick('strengthSessionsPerWeek'),
  };
  const hasAnyValue = Object.values(snapshot).some((value) => value != null);
  return hasAnyValue ? snapshot : null;
}

function buildPlanWeeklyTargetsSnapshot(
  planPreferences: Record<string, any> | null,
): { requested: WeeklyTargetSnapshot | null; scheduled: WeeklyTargetSnapshot | null } | null {
  // `requestedTargets` is the nested user-ask object; the SCHEDULED side
  // reads the same five flat keys off the preferences root (realized
  // targets, re-persisted after finalization).
  const requested = normalizeWeeklyTargetSnapshot(planPreferences?.requestedTargets);
  const scheduled = normalizeWeeklyTargetSnapshot(planPreferences);
  if (!requested && !scheduled) return null;
  return { requested, scheduled };
}

function buildTrainingLearningWeekLookup(value: unknown): Map<number, Record<string, unknown>> {
  const learningPath = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
  const weeklyPath = Array.isArray(learningPath?.weeklyPath) ? learningPath.weeklyPath : [];
  const byWeek = new Map<number, Record<string, unknown>>();
  for (const item of weeklyPath) {
    const mapped = mapTrainingLearningWeek(item);
    if (mapped) byWeek.set(mapped.weekNumber, mapped);
  }
  return byWeek;
}

function mapTrainingLearningWeek(item: unknown): (Record<string, unknown> & { weekNumber: number }) | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const raw = item as Record<string, unknown>;
  const weekNumber = Number(raw.weekNumber);
  if (!Number.isFinite(weekNumber) || weekNumber <= 0) return null;
  return {
    weekNumber: Math.trunc(weekNumber),
    title: readTrainingLearningString(raw.title),
    phaseGoal: readTrainingLearningString(raw.phaseGoal),
    weeklyLearningFocus: readTrainingLearningString(raw.weeklyLearningFocus),
    whyThisMatters: readTrainingLearningString(raw.whyThisMatters),
    techniqueCards: readTrainingLearningStringArray(raw.techniqueCards, 4),
    benchmarkSessionTitles: readTrainingLearningStringArray(raw.benchmarkSessionTitles, 3),
    assessmentPrompt: readTrainingLearningString(raw.assessmentPrompt),
  };
}

function readTrainingLearningString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readTrainingLearningStringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => readTrainingLearningString(item))
        .filter((item): item is string => Boolean(item))
        .slice(0, limit)
    : [];
}

function resolveVerifiedCalendarEventId(input: {
  session: any;
  plan: any;
  linkedCalendarEvent: any;
  userId: number;
  tenantId: number;
}): string | null {
  const storedEventId = input.session?.calendar_event_id ? String(input.session.calendar_event_id) : '';
  if (!storedEventId || !input.linkedCalendarEvent) return null;
  const sessionId = Number(input.session?.id);
  const planId = Number(input.plan?.id ?? input.session?.plan_id);
  const planVersion = Number(input.plan?.plan_version ?? 1);
  if (!Number.isFinite(sessionId) || !Number.isFinite(planId) || !Number.isFinite(planVersion)) return null;

  let ownership: ReturnType<typeof findExistingOwnership> | null = null;
  try {
    ownership = findExistingOwnership({
      planId,
      planVersion,
      sessionId,
      tenantId: input.tenantId,
      userId: input.userId,
    });
  } catch (err) {
    logger.debug({ err, planId, sessionId, userId: input.userId }, 'training read model ownership lookup failed');
    return null;
  }
  if (!ownership) return null;
  if (String(ownership.calendar_event_id) !== storedEventId) return null;
  if (input.session.calendar_source && ownership.calendar_source && String(ownership.calendar_source) !== String(input.session.calendar_source)) {
    return null;
  }
  return calendarEventMatchesSession(input.session, input.linkedCalendarEvent.event)
    ? storedEventId
    : null;
}

function buildWeekSessionDto(session: any, plan: any, linkedCalendarEvent: any, userId: number, tenantId: number) {
  const providerDisconnected = isSessionCalendarProviderDisconnected(session, userId);
  const verifiedCalendarEventId = providerDisconnected
    ? null
    : resolveVerifiedCalendarEventId({
        session,
        plan,
        linkedCalendarEvent,
        userId,
        tenantId,
      });
  const calendarSyncState = resolveCalendarSyncState({
    hasStoredCalendarEventId: Boolean(session.calendar_event_id),
    verifiedCalendarEventId,
    providerDisconnected,
    manualUnscheduled: normalizeTrainingStatus(session.status) === 'unscheduled',
  });
  return {
    id: session.id != null ? String(session.id) : undefined,
    planId: session.plan_id != null ? String(session.plan_id) : undefined,
    planVersion: plan.plan_version ?? null,
    sessionIdentityKey: session.session_identity_key || null,
    sessionShapeHash: session.session_shape_hash || null,
    day: session.day_of_week || 'Monday',
    type: session.title || humanizeSessionType(session.session_type),
    title: session.title || humanizeSessionType(session.session_type),
    sessionType: session.session_type || 'workout',
    time: verifiedCalendarEventId ? linkedCalendarEvent?.time ?? null : null,
    calendarEventId: verifiedCalendarEventId,
    calendarSource: verifiedCalendarEventId ? session.calendar_source || null : null,
    calendarSyncState,
    legacyCalendarSyncState: calendarSyncState === 'verified'
      ? 'synced'
      : calendarSyncState === 'repair_needed' || calendarSyncState === 'provider_disconnected'
        ? 'stale'
        : 'missing',
    lifecycleState: session.status || 'pending',
    status: normalizeTrainingStatus(session.status),
    description: session.description || null,
    descriptionSections: parseDescriptionSections(session.description_json),
    duration: session.duration_minutes || null,
    exercises: parseExercises(session.exercises_json),
    preferredTimeUnavailable: Number(session.preferred_time_unavailable) === 1,
  };
}

function summarizeTrainingSyncState(sessions: any[]) {
  const activeSessions = sessions.filter((session) => !isInactiveTrainingReadModelStatus(session.lifecycleState ?? session.status));
  const syncedSessionCount = activeSessions.filter((session) => calendarSyncStateIsLinked(session.calendarSyncState)).length;
  const missingSessionCount = Math.max(0, activeSessions.length - syncedSessionCount);
  const planSyncStatus = activeSessions.length === 0
    ? 'unscheduled'
    : syncedSessionCount === activeSessions.length
      ? 'all_synced'
      : syncedSessionCount > 0
        ? 'partial'
        : 'unsynced';
  return {
    planSyncStatus,
    activeSessionCount: activeSessions.length,
    syncedSessionCount,
    missingSessionCount,
  };
}

function isInactiveTrainingReadModelStatus(status: unknown): boolean {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'rest'
    || normalized === 'deferred'
    || normalized === 'dropped'
    || normalized === 'cancelled'
    || normalized === 'superseded';
}

export async function getReadiness(userId: number) {
  const cacheKey = `readiness:${userId}`;
  const cached = getCached<any>(cacheKey);
  if (cached) return cached;

  try {
    const readiness = await calculateReadiness(userId);
    const score = readiness?.score || 0;
    const factors = {
      sleepScore: readiness?.factors?.sleep?.score ?? readiness?.factors?.sleep?.qualityScore ?? null,
      hrvStatus: readiness?.factors?.hrv?.trend ?? null,
      bodyBattery: normalizeBodyBattery(readiness?.factors?.bodyBattery?.current),
      trainingLoad: readiness?.factors?.trainingLoad?.acwr
        ? `ACWR ${readiness.factors.trainingLoad.acwr.toFixed(2)}`
        : null,
      restingHeartRate: null,
      stressLevel: null,
    };
    const rawRec = readiness?.recommendation || '';
    const recommendation = humanizeRecommendation(rawRec, score);
    const reasonCode = typeof readiness?.reasonCode === 'string' ? readiness.reasonCode : null;
    const source = typeof readiness?.source === 'string' ? readiness.source : null;
    const asOf = typeof readiness?.asOf === 'string' ? readiness.asOf : null;
    // Adaptation snapshots need raw sleep duration and reasoning prose; the
    // display-shaped `factors` above intentionally drops both.
    const sleepDurationHours = typeof readiness?.factors?.sleep?.durationHours === 'number' && readiness.factors.sleep.durationHours > 0
      ? readiness.factors.sleep.durationHours
      : null;
    const reasoning = typeof readiness?.reasoning === 'string' && readiness.reasoning.trim().length > 0
      ? readiness.reasoning.trim()
      : null;
    const result = { score, factors, recommendation, reasonCode, source, asOf, sleepDurationHours, reasoning };
    setCache(cacheKey, result, READINESS_TTL);
    return result;
  } catch (err) {
    logger.debug({ err, userId }, 'getReadiness failed — returning uncached unavailable snapshot');
    return {
      score: 0,
      factors: {},
      recommendation: null,
      reasonCode: 'READINESS_UNAVAILABLE',
      unavailable: true,
    };
  }
}

export async function fetchCurrentReadinessForPlan(userId: number, tenantId: number): Promise<CoachKernelReadinessInput | null> {
  const scopedTenantId = requireTenantIdParam(tenantId, 'fetchCurrentReadinessForPlan');
  try {
    const readiness = await calculateReadiness(userId);
    if (!readiness || typeof readiness.score !== 'number' || readiness.score <= 0) return null;

    const hrvTrend = readiness.factors?.hrv?.trend;
    const hrvStatus: CoachKernelReadinessInput['hrvStatus'] =
      hrvTrend === 'up' ? 'high' : hrvTrend === 'down' ? 'low' : hrvTrend === 'stable' ? 'normal' : undefined;

    const sleepHours = typeof readiness.factors?.sleep?.durationHours === 'number' && readiness.factors.sleep.durationHours > 0
      ? readiness.factors.sleep.durationHours
      : undefined;
    const energyReserve = typeof readiness.factors?.bodyBattery?.current === 'number'
      ? readiness.factors.bodyBattery.current
      : undefined;

    const noData = readiness.reasonCode === 'WEARABLE_INTEGRATION_MISSING';
    const isStale = !noData && isReadinessSnapshotStale(readiness.asOf);

    return {
      score: readiness.score,
      confidence: noData ? 'no_data' : isStale ? 'stale_provider' : 'fresh_wearable',
      dataSource: noData ? 'fallback' : 'wearable',
      isStale,
      reasonCode: readiness.reasonCode ?? (isStale ? 'wearable_sync_stale' : null),
      sleepHours,
      hrvStatus,
      energyReserve,
      reasoning: typeof readiness.reasoning === 'string' ? readiness.reasoning : null,
    };
  } catch (err) {
    logger.debug({ err, userId, tenantId: scopedTenantId }, 'fetchCurrentReadinessForPlan failed — plan generator will use neutral fallback');
    return null;
  }
}

function isReadinessSnapshotStale(asOf: string | null | undefined, now = new Date()): boolean {
  if (typeof asOf !== 'string' || asOf.trim() === '') return false;
  const capturedAt = Date.parse(asOf);
  if (!Number.isFinite(capturedAt)) return false;
  const ageMs = now.getTime() - capturedAt;
  if (ageMs < 0) return false;
  return ageMs > READINESS_STALE_MAX_AGE_HOURS * 60 * 60 * 1000;
}

function calendarEventMatchesSession(session: any, event: any): boolean {
  if (!event) return false;
  const eventId = event.id || event.eventId || event.providerEventId || event.uid;
  if (session.calendar_event_id && eventId && String(eventId) !== String(session.calendar_event_id)) return false;

  const eventTitle = normalizeCalendarTrainingTitle(event.summary || event.subject || event.title);
  const sessionTitle = normalizeCalendarTrainingTitle(session.title || humanizeSessionType(session.session_type));
  const titleMatches = (!eventTitle && session.calendar_event_id && eventId)
    || (Boolean(eventTitle) && Boolean(sessionTitle) && eventTitle === sessionTitle);
  if (!titleMatches) return false;

  const expectedDuration = Number(session.duration_minutes);
  if (!Number.isFinite(expectedDuration) || expectedDuration <= 0) return true;
  const actualDuration = estimateCalendarDurationMinutes(
    typeof event.start === 'string' ? event.start : event.start?.dateTime ?? event.start?.date,
    typeof event.end === 'string' ? event.end : event.end?.dateTime ?? event.end?.date,
  );
  return actualDuration == null || Math.abs(actualDuration - expectedDuration) <= 2;
}

function normalizeCalendarTrainingTitle(value: unknown): string {
  return String(value || '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\(\s*\d+\s*min\s*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeBodyBattery(bb: any): number | null {
  if (bb === null || bb === undefined) return null;
  if (typeof bb === 'number') return Math.round(bb);
  if (typeof bb === 'object') {
    const val = bb.current !== undefined ? bb.current
      : bb.charged !== undefined ? bb.charged
      : bb.score !== undefined ? bb.score
      : null;
    return val !== null && val !== undefined ? Math.round(Number(val)) : null;
  }
  return null;
}

function humanizeRecommendation(code: string, score: number): string {
  if (!code || code === 'null') {
    if (score >= 80) return 'Great recovery! Go hard today.';
    if (score >= 60) return 'Decent recovery. Train at moderate intensity.';
    if (score >= 40) return 'Recovery is below optimal. Consider a lighter session.';
    return 'Poor recovery. Rest or very light activity recommended.';
  }
  const map: Record<string, string> = {
    full_send: 'Excellent recovery — go all out today!',
    normal: 'Good to train at normal intensity.',
    reduce_10pct: 'Slightly fatigued — reduce intensity by ~10%.',
    reduce_25pct: 'Below baseline — reduce volume by ~25% or swap for easy session.',
    reduce_50pct: 'Significantly fatigued — halve the planned volume.',
    rest: 'Your body needs rest today. Skip the workout.',
    deload: 'Consider a deload — light movement only.',
  };
  return map[code] || code.replace(/_/g, ' ');
}

function isStrengthActivity(activityType: string | null | undefined): boolean {
  if (!activityType) return false;
  return /strength|gym|weight/i.test(activityType);
}

async function findTodayTrainingFromCalendar(userId: number): Promise<any | null> {
  try {
    const today = new Date();
    const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);
    const calendarLookup = await buildCalendarEventLookup(startOfDay, endOfDay, userId);
    const calEvents = [...calendarLookup.values()].map((entry) => entry.event);
    const trainingEvent = calEvents.find((e: any) => {
      const title = e.subject || e.summary || e.title || '';
      return looksLikeTrainingCalendarEvent(title);
    });

    if (trainingEvent) {
      const title = trainingEvent.subject || trainingEvent.summary || trainingEvent.title;
      const startRaw = trainingEvent.start?.dateTime || trainingEvent.start;
      const endRaw = trainingEvent.end?.dateTime || trainingEvent.end;
      let duration: number | null = null;
      try {
        const s = new Date(startRaw);
        const e = new Date(endRaw);
        duration = Math.round((e.getTime() - s.getTime()) / 60000);
      } catch {}
      const timeMatch = String(startRaw).match(/T(\d{2}:\d{2})/);
      return {
        id: trainingEvent.id,
        type: title,
        sessionType: inferCalendarSessionType(title),
        time: timeMatch ? timeMatch[1] : null,
        duration,
        status: 'planned',
        notes: null,
        exercises: null,
      };
    }
  } catch {}
  return null;
}

async function buildWeekFromCalendar(userId: number): Promise<any[]> {
  try {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const calendarLookup = await buildCalendarEventLookup(monday, sunday, userId);
    const calEvents = [...calendarLookup.values()].map((entry) => entry.event);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    const dayMap = new Map<number, any>();
    for (const e of calEvents) {
      const title = e.subject || e.summary || e.title || '';
      if (!looksLikeTrainingCalendarEvent(title)) continue;
      const startRaw = e.start?.dateTime || e.start;
      const d = new Date(startRaw);
      const dayIdx = d.getDay();
      if (!dayMap.has(dayIdx)) {
        const timeMatch = String(startRaw).match(/T(\d{2}:\d{2})/);
        dayMap.set(dayIdx, {
          day: dayNames[dayIdx],
          type: title,
          title,
          sessionType: inferCalendarSessionType(title),
          time: timeMatch ? timeMatch[1] : null,
          status: 'planned',
          description: e.description || null,
          duration: estimateCalendarDurationMinutes(e.start?.dateTime || e.start, e.end?.dateTime || e.end),
          exercises: null,
        });
      }
    }

    if (dayMap.size === 0) return [];

    const sessions = [];
    for (let i = 1; i <= 7; i++) {
      const dayIdx = i % 7;
      sessions.push(dayMap.get(dayIdx) || {
        day: dayNames[dayIdx],
        type: 'Rest',
        title: 'Rest',
        sessionType: 'rest',
        time: null,
        status: 'rest',
        description: null,
        duration: null,
        exercises: null,
      });
    }
    return sessions;
  } catch {}
  return [];
}

function currentWeekDateRange(planStartIso: string, weekNumber: number) {
  const safeWeekNumber = Math.max(1, Math.round(Number(weekNumber) || 1));
  const start = parsePlanStartDate(planStartIso);
  start.setUTCDate(start.getUTCDate() + ((safeWeekNumber - 1) * 7));
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);

  return { start, end };
}

function parsePlanStartDate(planStartIso: string): Date {
  const match = String(planStartIso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

  const parsed = new Date(planStartIso);
  if (!Number.isNaN(parsed.getTime())) {
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  }

  const fallback = new Date();
  return new Date(Date.UTC(fallback.getUTCFullYear(), fallback.getUTCMonth(), fallback.getUTCDate()));
}
