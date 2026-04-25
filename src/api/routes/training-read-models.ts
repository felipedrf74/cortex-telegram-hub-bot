// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../../utils/logger';
import { getCached, setCache } from '../../services/cache-store';
import * as trainingPlans from '../../services/training-plans';
import { calculateReadiness } from '../../services/readiness-scorer';
import type { CoachKernelReadinessInput } from '../../services/training-coach-kernel-plan-generator';
import { getActivitiesByDateForUser } from '../../services/garmin';
import { buildCalendarEventLookup } from './training-calendar-lookup';
import {
  estimateCalendarDurationMinutes,
  humanizeSessionType,
  inferCalendarSessionType,
  looksLikeTrainingCalendarEvent,
  normalizeTrainingStatus,
  parseExercises,
} from './training-calendar-utils';

const READINESS_TTL = 5 * 60; // 5 minutes — intraday energy reserve should move during the day

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
        const range = currentWeekDateRange(activePlan.start_date, currentWeek.week_number);
        const calendarLookup = await buildCalendarEventLookup(range.start, range.end, userId);
        const sessions = trainingPlans.getSessionsForWeek(currentWeek.id);
        const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const rawSession = sessions?.find((s: any) => s.day_of_week === todayName);
        if (rawSession) {
          session = {
            id: rawSession.id != null ? String(rawSession.id) : null,
            type: rawSession.title || humanizeSessionType(rawSession.session_type),
            sessionType: rawSession.session_type || null,
            time: rawSession.calendar_event_id ? calendarLookup.get(rawSession.calendar_event_id)?.time ?? null : null,
            duration: rawSession.duration_minutes || null,
            status: normalizeTrainingStatus(rawSession.status),
            notes: rawSession.description || null,
            exercises: parseExercises(rawSession.exercises_json),
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
        const range = currentWeekDateRange(plan.start_date, weekNumber);
        const calendarLookup = await buildCalendarEventLookup(range.start, range.end, userId);
        sessions = weekSessions.map((s: any) => ({
          id: s.id != null ? String(s.id) : undefined,
          day: s.day_of_week || 'Monday',
          type: s.title || humanizeSessionType(s.session_type),
          title: s.title || humanizeSessionType(s.session_type),
          sessionType: s.session_type || 'workout',
          time: s.calendar_event_id ? calendarLookup.get(s.calendar_event_id)?.time ?? null : null,
          status: normalizeTrainingStatus(s.status),
          description: s.description || null,
          // Structured-sections companion to `description` so iOS can
          // render typed cards. Older rows have NULL `description_json`
          // and iOS falls back to the plain-text `description`.
          descriptionSections: parseDescriptionSections(s.description_json),
          duration: s.duration_minutes || null,
          exercises: parseExercises(s.exercises_json),
        }));
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
  const planStart = new Date(planStartIso);
  const mondayOffset = planStart.getDay() === 0 ? -6 : 1 - planStart.getDay();

  const monday = new Date(planStart);
  monday.setDate(planStart.getDate() + mondayOffset + ((weekNumber - 1) * 7));
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { start: monday, end: sunday };
}
