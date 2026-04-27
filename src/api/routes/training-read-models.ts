// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../../utils/logger';
import { getCached, setCache } from '../../services/cache-store';
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
import type { Session, SessionType, Sport, ReadinessSnapshot } from '../../services/coach-kernel/types';

const READINESS_TTL = 5 * 60; // 5 minutes — intraday energy reserve should move during the day

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

export async function getTodaySession(userId: number) {
  let session: any = null;
  let plan: any = null;

  try {
    const activePlan = trainingPlans.getActivePlan(userId);
    if (activePlan) {
      const currentWeek = trainingPlans.getCurrentWeek(activePlan.id);
      plan = {
        name: activePlan.name,
        weekNumber: currentWeek?.week_number || 1,
        phase: currentWeek?.focus || activePlan.periodization || null,
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
          session = {
            id: rawSession.id != null ? String(rawSession.id) : null,
            type: rawSession.title || humanizeSessionType(rawSession.session_type),
            sessionType: rawSession.session_type || null,
            time: rawSession.calendar_event_id ? calendarLookup.get(rawSession.calendar_event_id)?.time ?? null : null,
            duration: rawSession.duration_minutes || null,
            status: normalizeTrainingStatus(rawSession.status),
            notes: rawSession.description || null,
            exercises: parseExercises(rawSession.exercises_json),
            preferredTimeUnavailable: Number(rawSession.preferred_time_unavailable) === 1,
          };
        }
      }
    }
  } catch (e) {
    logger.debug({ err: e }, 'getTodaySession training-plans lookup failed');
  }

  if (!session) session = await findTodayTrainingFromCalendar(userId);

  if (!session) {
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
  let adaptation: SessionAdaptation | null = null;
  if (session) {
    try {
      const readinessSummary = await getReadiness(userId);
      const snapshot = readinessResultToSnapshot({
        score: typeof readinessSummary?.score === 'number' ? readinessSummary.score : undefined,
        sleepHours: readinessSummary?.factors?.sleepScore != null ? undefined : undefined,
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
        reasoning: typeof readinessSummary?.reasonCode === 'string'
          ? undefined
          : undefined,
      });
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
      type: session.type || session.name || 'Workout',
      sessionType: session.sessionType || null,
      time: session.time || null,
      duration: session.duration || null,
      status: session.status || 'planned',
      notes: session.notes || null,
      exercises: session.exercises || null,
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

export async function getWeekPlan(userId: number) {
  let weekNumber = 0;
  let sessions: any[] = [];
  let adherence = 0;
  let planSummary: { name: string; weekNumber: number; phase: string | null } | null = null;

  try {
    const plan = trainingPlans.getActivePlan(userId);
    if (plan) {
      const currentWeek = trainingPlans.getCurrentWeek(plan.id);
      weekNumber = currentWeek?.week_number || 1;
      planSummary = {
        name: plan.name,
        weekNumber,
        phase: currentWeek?.focus || plan.periodization || null,
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
          const verifiedCalendarEventId = linkedCalendarEvent && calendarEventMatchesSession(s, linkedCalendarEvent.event)
            ? s.calendar_event_id
            : null;
          return {
            id: s.id != null ? String(s.id) : undefined,
            day: s.day_of_week || 'Monday',
            type: s.title || humanizeSessionType(s.session_type),
            title: s.title || humanizeSessionType(s.session_type),
            sessionType: s.session_type || 'workout',
            time: verifiedCalendarEventId ? linkedCalendarEvent?.time ?? null : null,
            calendarEventId: verifiedCalendarEventId,
            calendarSource: verifiedCalendarEventId ? s.calendar_source || null : null,
            status: normalizeTrainingStatus(s.status),
            description: s.description || null,
            // Structured-sections companion to `description` so iOS can
            // render typed cards. Older rows have NULL `description_json`
            // and iOS falls back to the plain-text `description`.
            descriptionSections: parseDescriptionSections(s.description_json),
            duration: s.duration_minutes || null,
            exercises: parseExercises(s.exercises_json),
            // Slice 1.B (coach-engine refactor) — surface the planner's
            // "could not land at preferred time" verdict to iOS so the
            // Week Plan shows a ⚠️ chip rather than silently letting the
            // user discover the wrong time when a meeting overlaps.
            preferredTimeUnavailable: Number(s.preferred_time_unavailable) === 1,
          };
        });
      }
      const adh = currentWeek ? trainingPlans.getWeeklyAdherence?.(plan.id, currentWeek.id) : null;
      adherence = typeof adh === 'number'
        ? adh
        : typeof adh?.adherenceRate === 'number'
          ? adh.adherenceRate / 100
          : 0;
    }
  } catch {}

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
    totalCount: sessions.filter((s: any) => s.status !== 'rest').length,
  };
}

export async function getReadiness(userId: number) {
  const cacheKey = `readiness:${userId}`;
  const cached = getCached<any>(cacheKey);
  if (cached) return cached;

  let score = 0;
  let factors: any = {};
  let recommendation: string | null = null;
  let reasonCode: string | null = null;

  try {
    const readiness = await calculateReadiness(userId);
    score = readiness?.score || 0;
    factors = {
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
    recommendation = humanizeRecommendation(rawRec, score);
    reasonCode = typeof readiness?.reasonCode === 'string' ? readiness.reasonCode : null;
  } catch {}

  const result = { score, factors, recommendation, reasonCode };
  setCache(cacheKey, result, READINESS_TTL);
  return result;
}

export async function fetchCurrentReadinessForPlan(userId: number): Promise<CoachKernelReadinessInput | null> {
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

    return {
      score: readiness.score,
      sleepHours,
      hrvStatus,
      energyReserve,
      reasoning: typeof readiness.reasoning === 'string' ? readiness.reasoning : null,
    };
  } catch (err) {
    logger.debug({ err, userId }, 'fetchCurrentReadinessForPlan failed — plan generator will use neutral fallback');
    return null;
  }
}

function calendarEventMatchesSession(session: any, event: any): boolean {
  if (!event) return false;
  const eventTitle = normalizeCalendarTrainingTitle(event.summary || event.subject || event.title);
  const sessionTitle = normalizeCalendarTrainingTitle(session.title || humanizeSessionType(session.session_type));
  if (!eventTitle || !sessionTitle || eventTitle !== sessionTitle) return false;

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
