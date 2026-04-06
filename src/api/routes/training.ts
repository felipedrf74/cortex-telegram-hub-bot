// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { getCached, setCache, clearCache } from '../../services/cache-store';
import { sendSuccess, sendError } from '../response-helpers';

// Cache TTLs (seconds)
const COACH_TTL = 6 * 3600;    // 6 hours — Garmin data changes once/day
const READINESS_TTL = 30 * 60; // 30 minutes
const SUMMARY_TTL = 5 * 60;    // 5 minutes

export function trainingRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/training/summary
   * Consolidated endpoint: today + week + readiness in ONE call.
   * Cached for 5 minutes in SQLite. Eliminates 3 separate API calls from iOS.
   */
  router.get('/summary', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const cacheKey = `training-summary:${userId}`;

    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    // Parallel fetch — NEVER sequential
    const [todayResult, weekResult, readinessResult] = await Promise.allSettled([
      getTodaySession(userId),
      getWeekPlan(userId),
      getReadiness(userId),
    ]);

    const payload = {
      today: todayResult.status === 'fulfilled' ? todayResult.value : null,
      week: weekResult.status === 'fulfilled' ? weekResult.value : { sessions: [], adherence: 0, weekNumber: 0 },
      readiness: readinessResult.status === 'fulfilled' ? readinessResult.value : { score: 0, factors: {}, recommendation: null },
    };

    setCache(cacheKey, payload, SUMMARY_TTL);
    sendSuccess(res, payload);
  });

  /** GET /api/v1/training/today */
  router.get('/today', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const session = await getTodaySession(userId);
      sendSuccess(res, session);
    } catch (err: any) {
      logger.error({ err }, 'iOS training/today failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch today session', 500);
    }
  });

  /** GET /api/v1/training/week */
  router.get('/week', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const week = await getWeekPlan(userId);
      sendSuccess(res, week);
    } catch (err: any) {
      logger.error({ err }, 'iOS training/week failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to fetch week plan', 500);
    }
  });

  /** GET /api/v1/training/readiness */
  router.get('/readiness', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const readiness = await getReadiness(userId);
      sendSuccess(res, readiness);
    } catch (err: any) {
      logger.error({ err }, 'iOS training/readiness failed');
      // Soft-fail with default — readiness is a "nice to have" indicator,
      // so a missing wearable shouldn't block the screen from rendering.
      sendSuccess(res, { score: 0, factors: {}, recommendation: null });
    }
  });

  /**
   * GET /api/v1/training/coach
   * Coach briefing — cached in SQLite for 6 hours (survives restarts).
   * Use ?refresh=true to force a new AI analysis (costs ~$0.05).
   */
  router.get('/coach', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = `coach-briefing:${userId}`;

    // Return SQLite-cached briefing (survives restarts, no AI call)
    if (!forceRefresh) {
      const cached = getCached(cacheKey);
      if (cached) {
        logger.debug('Returning SQLite-cached coach briefing (no AI call)');
        sendSuccess(res, cached, { cached: true });
        return;
      }
    }

    try {
      const { generateCoachBriefing } = require('../../services/garmin-coach');
      const briefing = await generateCoachBriefing();

      const payload = {
        briefing: briefing?.message || briefing?.text || briefing?.briefing || 'No coach briefing available.',
        recommendations: briefing?.recommendations || [],
        garminData: briefing?.garminData || null,
        cachedAt: new Date().toISOString(),
      };

      setCache(cacheKey, payload, COACH_TTL);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err }, 'iOS training/coach failed');
      // Soft-fail so the screen still renders even when Garmin is offline.
      sendSuccess(res, { briefing: 'Coach briefing unavailable.', recommendations: [], garminData: null });
    }
  });

  /** POST /api/v1/training/complete */
  router.post('/complete', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { sessionId, notes, rpe } = req.body;

    try {
      const { completeSession, getWeeklyAdherence } = require('../../services/training-plans');
      await completeSession(userId, sessionId, { notes, rpe });
      const adh = getWeeklyAdherence ? getWeeklyAdherence(userId) : null;
      const adherenceRate = typeof adh === 'number' ? adh : adh?.adherenceRate || null;

      // Invalidate caches since training status changed
      clearCache(`coach-briefing:${userId}`);
      clearCache(`training-summary:${userId}`);

      sendSuccess(res, { completed: true, weeklyAdherence: adherenceRate });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/complete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to complete session', 500);
    }
  });

  /** POST /api/v1/training/coach/apply */
  router.post('/coach/apply', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { recommendationIds } = req.body;
    try {
      const { applyCoachRecommendations } = require('../../services/garmin-coach');
      const applied = await applyCoachRecommendations(userId, recommendationIds);
      sendSuccess(res, { applied: applied?.count || 0, message: `Calendar updated with ${applied?.count || 0} recommendation(s).` });
    } catch {
      sendSuccess(res, { applied: 0, message: 'Coach recommendations noted.' });
    }
  });

  return router;
}

// ── Shared Logic (used by individual routes AND /summary) ───────────

async function getTodaySession(userId: number) {
  let session: any = null;
  let plan: any = null;

  try {
    const tp = require('../../services/training-plans');
    const activePlan = tp.getActivePlan(userId);
    if (activePlan) {
      plan = { name: activePlan.name, weekNumber: activePlan.currentWeek || 1, phase: activePlan.phase || null };
      const sessions = tp.getSessionsForWeek(userId);
      session = sessions?.find((s: any) => s.isToday) || null;
    }
  } catch {}

  if (!session) session = await findTodayTrainingFromCalendar();

  return {
    session: session ? {
      id: session.id || null, type: session.type || session.name || 'Workout',
      time: session.time || null, duration: session.duration || null,
      status: session.status || 'planned', notes: session.notes || null,
      exercises: session.exercises || null,
    } : null,
    plan,
  };
}

async function getWeekPlan(userId: number) {
  let weekNumber = 0;
  let sessions: any[] = [];
  let adherence = 0;

  try {
    const tp = require('../../services/training-plans');
    const plan = tp.getActivePlan(userId);
    if (plan) {
      weekNumber = plan.currentWeek || 1;
      const weekSessions = tp.getSessionsForWeek(userId);
      if (Array.isArray(weekSessions) && weekSessions.length > 0) {
        sessions = weekSessions.map((s: any) => ({
          day: s.day || s.dayOfWeek, type: s.type || s.name,
          time: s.time || null, status: s.status || 'planned',
        }));
      }
      const adh = tp.getWeeklyAdherence?.(userId);
      adherence = typeof adh === 'number' ? adh : adh?.adherenceRate || 0;
    }
  } catch {}

  if (sessions.length === 0) {
    sessions = await buildWeekFromCalendar();
    const completed = sessions.filter(s => s.status === 'completed').length;
    const total = sessions.filter(s => s.status !== 'rest').length;
    adherence = total > 0 ? completed / total : 0;
  }

  return {
    weekNumber,
    sessions,
    adherence: typeof adherence === 'number' ? adherence : 0,
    completedCount: sessions.filter((s: any) => s.status === 'completed').length,
    totalCount: sessions.filter((s: any) => s.status !== 'rest').length,
  };
}

async function getReadiness(userId: number) {
  const cacheKey = `readiness:${userId}`;

  // Check SQLite cache first (survives restarts)
  const cached = getCached<any>(cacheKey);
  if (cached) return cached;

  let score = 0;
  let factors: any = {};
  let recommendation: string | null = null;

  try {
    const { calculateReadiness } = require('../../services/readiness-scorer');
    const readiness = await calculateReadiness(userId);
    score = readiness?.score || 0;
    factors = {
      sleepScore: readiness?.sleepScore || readiness?.factors?.sleepScore || null,
      hrvStatus: readiness?.hrvStatus || readiness?.factors?.hrvStatus || null,
      bodyBattery: normalizeBodyBattery(readiness?.bodyBattery || readiness?.factors?.bodyBattery),
      trainingLoad: readiness?.trainingLoad || readiness?.factors?.trainingLoad || null,
      restingHeartRate: readiness?.restingHeartRate || readiness?.factors?.restingHeartRate || null,
      stressLevel: readiness?.stressLevel || readiness?.factors?.stressLevel || null,
    };
    const rawRec = readiness?.recommendation || readiness?.action || '';
    recommendation = humanizeRecommendation(rawRec, score);
  } catch {}

  if (!factors.bodyBattery) {
    try {
      const garmin = require('../../services/garmin');
      const todayStr = new Date().toISOString().slice(0, 10);
      const bb = await garmin.getBodyBattery?.(todayStr);
      factors.bodyBattery = normalizeBodyBattery(bb);
    } catch {}
  }

  const result = { score, factors, recommendation };
  setCache(cacheKey, result, READINESS_TTL);
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────

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
    'full_send': 'Excellent recovery — go all out today!',
    'normal': 'Good to train at normal intensity.',
    'reduce_10pct': 'Slightly fatigued — reduce intensity by ~10%.',
    'reduce_25pct': 'Below baseline — reduce volume by ~25% or swap for easy session.',
    'reduce_50pct': 'Significantly fatigued — halve the planned volume.',
    'rest': 'Your body needs rest today. Skip the workout.',
    'deload': 'Consider a deload — light movement only.',
  };
  return map[code] || code.replace(/_/g, ' ');
}

async function findTodayTrainingFromCalendar(): Promise<any | null> {
  try {
    const today = new Date();
    const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);

    const [outlookResult, googleResult] = await Promise.allSettled([
      (async () => { const { getEvents } = require('../../services/outlook-calendar'); return await getEvents(startOfDay.toISOString(), endOfDay.toISOString()); })(),
      (async () => { const { getEvents } = require('../../services/google-calendar'); return await getEvents(startOfDay.toISOString(), endOfDay.toISOString()); })(),
    ]);

    const calEvents = [
      ...(outlookResult.status === 'fulfilled' && Array.isArray(outlookResult.value) ? outlookResult.value : []),
      ...(googleResult.status === 'fulfilled' && Array.isArray(googleResult.value) ? googleResult.value : []),
    ];

    const keywords = ['run', 'gym', 'swim', 'bike', 'cycle', 'training', 'workout', 'strength', 'hiit', 'yoga'];
    const trainingEvent = calEvents.find((e: any) => {
      const title = (e.subject || e.summary || e.title || '').toLowerCase();
      return keywords.some(kw => title.includes(kw));
    });

    if (trainingEvent) {
      const title = trainingEvent.subject || trainingEvent.summary || trainingEvent.title;
      const startRaw = trainingEvent.start?.dateTime || trainingEvent.start;
      const endRaw = trainingEvent.end?.dateTime || trainingEvent.end;
      let duration: number | null = null;
      try { const s = new Date(startRaw); const e = new Date(endRaw); duration = Math.round((e.getTime() - s.getTime()) / 60000); } catch {}
      const timeMatch = String(startRaw).match(/T(\d{2}:\d{2})/);
      return { id: trainingEvent.id, type: title, time: timeMatch ? timeMatch[1] : null, duration, status: 'planned', notes: null, exercises: null };
    }
  } catch {}
  return null;
}

async function buildWeekFromCalendar(): Promise<any[]> {
  try {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today); monday.setDate(today.getDate() + mondayOffset); monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); sunday.setHours(23, 59, 59, 999);

    const [outlookResult] = await Promise.allSettled([
      (async () => { const { getEvents } = require('../../services/outlook-calendar'); return await getEvents(monday.toISOString(), sunday.toISOString()); })(),
    ]);

    const calEvents = outlookResult.status === 'fulfilled' && Array.isArray(outlookResult.value) ? outlookResult.value : [];
    const keywords = ['run', 'gym', 'swim', 'bike', 'cycle', 'training', 'workout', 'strength', 'hiit', 'yoga'];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    const dayMap = new Map<number, any>();
    for (const e of calEvents) {
      const title = (e.subject || e.summary || e.title || '').toLowerCase();
      if (!keywords.some(kw => title.includes(kw))) continue;
      const startRaw = e.start?.dateTime || e.start;
      const d = new Date(startRaw);
      const dayIdx = d.getDay();
      if (!dayMap.has(dayIdx)) {
        const timeMatch = String(startRaw).match(/T(\d{2}:\d{2})/);
        dayMap.set(dayIdx, {
          day: dayNames[dayIdx], type: e.subject || e.summary || e.title || 'Workout',
          // Mark as 'completed' only if the event's DATE is in the past (not time-of-day)
          // This avoids false-positives like a 6am event showing "completed" at 6:01am
          time: timeMatch ? timeMatch[1] : null, status: d.toDateString() < today.toDateString() ? 'completed' : 'planned',
        });
      }
    }

    const sessions = [];
    for (let i = 1; i <= 7; i++) {
      const dayIdx = i % 7;
      sessions.push(dayMap.get(dayIdx) || { day: dayNames[dayIdx], type: 'Rest', time: null, status: 'rest' });
    }
    return sessions;
  } catch {}
  return [];
}
