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
      const briefing = await generateCoachBriefing(userId);

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

  /**
   * POST /api/v1/training/complete
   *
   * Accepts either a numeric `sessionId` (from a SQLite training_sessions row)
   * or the sentinel string `"today"` — in which case we look up the active
   * plan's current week, find today's session by day name, and mark it.
   *
   * Gracefully no-ops with `completed: true` when there is no active plan —
   * iOS users who haven't set up a structured plan should still see their
   * "Concluir" button work (it's an optimistic UX signal, not a DB invariant).
   */
  router.post('/complete', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { sessionId, notes, rpe } = req.body;

    try {
      const tp = require('../../services/training-plans');

      // 1. Resolve session id → numeric row id
      let rowId: number | null = null;
      if (sessionId && sessionId !== 'today' && !isNaN(Number(sessionId))) {
        rowId = Number(sessionId);
      } else {
        // Look up from active plan
        const plan = tp.getActivePlan(userId);
        if (plan) {
          const week = tp.getCurrentWeek(plan.id);
          if (week) {
            const sessions = tp.getSessionsForWeek(week.id);
            const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
            const todaySession = sessions?.find(
              (s: any) => s.day_of_week === todayName && s.status !== 'completed',
            );
            if (todaySession) rowId = todaySession.id;
          }
        }
      }

      // 2. Mark completed (and log completion if we have RPE/notes)
      let adherenceRate: number | null = null;
      if (rowId !== null) {
        if (notes || rpe != null) {
          const session = tp.getSessionById(rowId);
          if (session) {
            tp.logCompletion({
              session_id: rowId,
              plan_id: session.plan_id,
              rpe_overall: rpe ?? null,
              notes: notes ?? null,
            });
          } else {
            tp.markSessionCompleted(rowId);
          }
        } else {
          tp.markSessionCompleted(rowId);
        }

        // Adherence calculation — need planId + weekId
        try {
          const plan = tp.getActivePlan(userId);
          if (plan) {
            const week = tp.getCurrentWeek(plan.id);
            if (week) {
              const adh = tp.getWeeklyAdherence(plan.id, week.id);
              adherenceRate = typeof adh?.adherenceRate === 'number'
                ? adh.adherenceRate / 100  // backend returns 0-100, iOS expects 0-1
                : null;
            }
          }
        } catch (e) {
          logger.debug({ err: e }, 'Adherence calc failed (non-critical)');
        }
      }

      // Invalidate caches since training status changed
      clearCache(`coach-briefing:${userId}`);
      clearCache(`training-summary:${userId}`);
      clearCache(`readiness:${userId}`);

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

  /**
   * GET /api/v1/training/activity/weekly
   *
   * Phase 4 Slice A — longitudinal session activity summary for the
   * current week, with per-sport breakdowns (gym/running/cycling/swim/
   * other), total duration, average RPE, and streak info over a 90-day
   * lookback.
   *
   * Pure SQL aggregation over `training_completions` — no LLM calls.
   * Cheap enough to call on every training tab open; cached briefly
   * to deduplicate repeat opens within a few seconds.
   */
  /**
   * GET /api/v1/training/progression/cardio
   *
   * Phase 4 Slice F — longitudinal cardio progression for running
   * or cycling. Same shape philosophy as /progression/strength but
   * aggregates by WEEK rather than per-exercise, since cardio
   * sessions don't have per-lift 1RM trajectories.
   *
   * Query params:
   *   sport — "running" or "cycling". Required. 400 if missing.
   *   weeks — lookback window in weeks. Defaults to 8. Clamped [1,52].
   *
   * Cached 2 minutes keyed on (userId, sport, weeks).
   */
  router.get('/progression/cardio', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const sportRaw = typeof req.query.sport === 'string' ? req.query.sport : '';
    if (sportRaw !== 'running' && sportRaw !== 'cycling') {
      sendError(res, 'BAD_REQUEST', 'sport query param must be "running" or "cycling"', 400);
      return;
    }
    const sport = sportRaw as 'running' | 'cycling';

    const weeksRaw = Number(req.query.weeks);
    const weeks = Number.isFinite(weeksRaw)
      ? Math.min(52, Math.max(1, Math.floor(weeksRaw)))
      : 8;

    const cacheKey = `cardio-progression:${userId}:${sport}:${weeks}`;
    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const { getCardioProgression } = require('../../services/progression-analytics');
      const report = getCardioProgression(userId, sport, weeks);
      setCache(cacheKey, report, 120);
      sendSuccess(res, report);
    } catch (err: any) {
      logger.error({ err, userId, sport, weeks }, 'GET /progression/cardio failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to load cardio progression', 500);
    }
  });

  /**
   * GET /api/v1/training/progression/strength
   *
   * Phase 4 Slice D — longitudinal strength progression. Returns a
   * per-lift trajectory over the past N weeks (default 8) extracted
   * from training_completions.actual_exercises_json. Drives the iOS
   * progression view (Slice E) and mirrors the exact shape the coach
   * context injection uses.
   *
   * Query params:
   *   weeks — lookback window in weeks. Defaults to 8. Clamped to
   *           the range [1, 52] to prevent pathological reads.
   *
   * Pure SQL + in-memory aggregation. Cached 2 minutes — strength
   * data changes only when the user logs a session, so a longer TTL
   * than the weekly-activity endpoint is fine.
   */
  router.get('/progression/strength', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const weeksRaw = Number(req.query.weeks);
    const weeks = Number.isFinite(weeksRaw)
      ? Math.min(52, Math.max(1, Math.floor(weeksRaw)))
      : 8;

    const cacheKey = `strength-progression:${userId}:${weeks}`;
    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const { getStrengthProgression } = require('../../services/progression-analytics');
      const report = getStrengthProgression(userId, weeks);
      setCache(cacheKey, report, 120); // 2 minutes
      sendSuccess(res, report);
    } catch (err: any) {
      logger.error({ err, userId, weeks }, 'GET /progression/strength failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to load strength progression', 500);
    }
  });

  router.get('/activity/weekly', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const cacheKey = `training-activity-weekly:${userId}`;

    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const { getWeeklyActivitySummary } = require('../../services/session-analytics');
      const summary = getWeeklyActivitySummary(userId);

      // Phase 4 Slice C — Publish adherence signals as a side effect
      // of this fetch. The orchestrator is idempotent (skips when a
      // matching signal is already active), so calling it on every
      // tab open doesn't flood the bus. Wrapped in try/catch because
      // a bus write failure shouldn't take down the weekly summary.
      try {
        const { publishAdherenceSignalsForUser } = require('../../services/adherence-signals');
        publishAdherenceSignalsForUser(userId);
      } catch (err) {
        logger.warn({ err, userId }, 'adherence signal publish failed — summary still returned');
      }

      // Phase 4 Slice G — Publish plan drift signal when the user's
      // actual sport distribution over the past 4 weeks diverges
      // from their plan's declared sport. Same idempotency pattern
      // as adherence — safe to call on every tab open.
      try {
        const { publishPlanDriftSignalForUser } = require('../../services/adherence-signals');
        publishPlanDriftSignalForUser(userId);
      } catch (err) {
        logger.warn({ err, userId }, 'plan drift signal publish failed — summary still returned');
      }

      // Short TTL — users commonly refresh the training tab right
      // after logging a session, and they want to see the new row
      // show up. 60s is enough to deduplicate tab bounces without
      // making the data feel stale.
      setCache(cacheKey, summary, 60);
      sendSuccess(res, summary);
    } catch (err: any) {
      logger.error({ err, userId }, 'GET /activity/weekly failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to load weekly activity', 500);
    }
  });

  /**
   * POST /api/v1/training/plan/generate
   *
   * Token-efficient training plan generation. One AI call produces a
   * full monthly plan — replaces the 70+ tool-call chat flow with a
   * single structured JSON generation + bulk insert.
   *
   * Flow:
   *   1. Read user's fitness profile from onboarding answers
   *   2. Fetch calendar events for the next 4 weeks → find free slots
   *   3. One Gemini call → get structured plan JSON
   *   4. Bulk insert: plan + weeks + sessions + calendar events
   *   5. Return plan summary to iOS
   *
   * Body: { objective: string, durationWeeks?: number, preferredTime?: string }
   */
  router.post('/plan/generate', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { objective, durationWeeks = 4, preferredTime = '12:00' } = req.body;

    if (!objective || typeof objective !== 'string') {
      sendError(res, 'VALIDATION', 'objective is required (e.g., "Lisbon Marathon October 2026")', 400);
      return;
    }

    try {
      const tp = require('../../services/training-plans');
      const onboarding = require('../../services/onboarding');
      const { getEvents } = require('../../services/unified-calendar');
      const { completeOneShotWithFallback } = require('../../services/gemini-provider');

      // ── Step 1: Check user profile ──────────────────────────────
      const fitnessProfile = onboarding.getProfile?.(userId, 'fitness');
      const gymProfile = onboarding.getProfile?.(userId, 'triathlon-gym');
      const runProfile = onboarding.getProfile?.(userId, 'triathlon-running');

      if (!fitnessProfile || Object.keys(fitnessProfile).length === 0) {
        sendSuccess(res, {
          needsProfile: true,
          message: 'Complete your Fitness Profile first to generate a personalized plan.',
          missingFields: onboarding.getMissingProfileFields?.(userId, 'fitness') || [],
        });
        return;
      }

      // ── Step 2: Get calendar free slots for next N weeks ────────
      const now = new Date();
      const endDate = new Date(now.getTime() + durationWeeks * 7 * 24 * 60 * 60 * 1000);
      const startStr = now.toISOString().slice(0, 10);
      const endStr = endDate.toISOString().slice(0, 10);

      let busySlots: string[] = [];
      try {
        const events = await getEvents(startStr, endStr);
        const allEvents = [...(events.today || []), ...(events.upcoming || [])];
        busySlots = allEvents.map((e: any) => {
          const start = e.start || e.startDateTime || '';
          const title = e.subject || e.summary || e.title || '';
          return `${start}: ${title}`;
        }).slice(0, 50); // Cap to avoid context overflow
      } catch {
        // Calendar unavailable — plan without schedule constraints
      }

      // ── Step 3: One AI call → structured plan JSON ─────────────
      const profileSummary = [
        fitnessProfile ? `Fitness: ${JSON.stringify(fitnessProfile)}` : '',
        gymProfile ? `Gym: ${JSON.stringify(gymProfile)}` : '',
        runProfile ? `Running: ${JSON.stringify(runProfile)}` : '',
      ].filter(Boolean).join('\n');

      const dayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

      const planPrompt = `You are a sports coach creating a ${durationWeeks}-week training plan.

ATHLETE PROFILE:
${profileSummary}

OBJECTIVE: ${objective}

BUSY CALENDAR SLOTS (avoid these times):
${busySlots.length > 0 ? busySlots.join('\n') : 'No calendar data — schedule freely.'}

PREFERRED TRAINING TIME: ${preferredTime}

START DATE: ${startStr}

RULES:
- Plan ${durationWeeks} weeks of training.
- Week ${durationWeeks} should be a DELOAD week (lower volume/intensity).
- Each session needs: day_of_week, session_type (gym/run/ride/swim/rest), title, duration_minutes, exercises as a list.
- For gym sessions: include exercise name, sets, reps, RPE, rest_sec.
- For cardio: include type, distance_km or duration, pace/zone, notes.
- Respect the athlete's equipment, experience level, and injury history.
- Place sessions on days that DON'T conflict with busy calendar slots.
- Maximum 6 training days per week. At least 1 rest day.
- Include warm-up and cool-down notes in the description.

Return ONLY valid JSON in this exact shape:
{
  "planName": "string",
  "sport": "hybrid|running|cycling|swimming|gym",
  "periodization": "linear|undulating|block",
  "weeks": [
    {
      "weekNumber": 1,
      "focus": "base|strength|hypertrophy|endurance|speed|deload",
      "intensityPct": 70,
      "sessions": [
        {
          "dayOfWeek": "monday",
          "sessionType": "gym|run|ride|swim|rest",
          "title": "Upper Body A — Hypertrophy",
          "durationMinutes": 65,
          "description": "Full warm-up + exercises description for calendar body",
          "exercises": [
            { "name": "Incline DB Press", "sets": 4, "reps": 10, "rpe": "7-8", "restSec": 90 }
          ]
        }
      ]
    }
  ]
}`;

      const { text: rawPlan } = await completeOneShotWithFallback(
        'You are a structured training plan generator. Return ONLY valid JSON, no markdown.',
        planPrompt,
        'training_plan_generation',
        { maxTokens: 4096, temperature: 0.3, userId },
      );

      // Parse the JSON — strip markdown fences, extract JSON object/array
      let planData: any;
      try {
        // Try progressively more aggressive extraction:
        // 1. Strip markdown fences
        let cleaned = rawPlan.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        // 2. Extract the first { ... } block if there's prose before/after
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) cleaned = jsonMatch[0];
        planData = JSON.parse(cleaned);
      } catch (parseErr) {
        // 3. Last resort: try to find and parse just the JSON portion
        try {
          const braceStart = rawPlan.indexOf('{');
          const braceEnd = rawPlan.lastIndexOf('}');
          if (braceStart >= 0 && braceEnd > braceStart) {
            planData = JSON.parse(rawPlan.slice(braceStart, braceEnd + 1));
          } else {
            throw new Error('No JSON object found');
          }
        } catch {
          logger.error({ rawPlan: rawPlan.slice(0, 500) }, 'Failed to parse plan JSON from AI');
          sendError(res, 'AI_PARSE_ERROR', 'AI generated invalid plan JSON. Try again.', 500);
          return;
        }
      }

      // ── Step 4: Bulk insert plan + weeks + sessions ────────────
      const plan = tp.createPlan({
        user_id: userId,
        name: planData.planName || `${objective} Plan`,
        sport: planData.sport || 'hybrid',
        goal: objective,
        duration_weeks: durationWeeks,
        periodization: planData.periodization || 'undulating',
        start_date: startStr,
        end_date: endStr,
      });

      let totalSessions = 0;
      const calendarEvents: any[] = [];

      for (const weekData of (planData.weeks || [])) {
        const week = tp.createWeek({
          plan_id: plan.id,
          week_number: weekData.weekNumber || 1,
          focus: weekData.focus || 'base',
          intensity_pct: weekData.intensityPct || 70,
          volume_sessions: weekData.sessions?.length || 0,
        });

        for (const sess of (weekData.sessions || [])) {
          if (sess.sessionType === 'rest') continue;

          const dayIndex = dayNames.indexOf(sess.dayOfWeek?.toLowerCase());
          if (dayIndex < 0) continue;

          // Calculate the actual date for this session
          const weekStart = new Date(now);
          weekStart.setDate(weekStart.getDate() + ((weekData.weekNumber - 1) * 7));
          // Find the next occurrence of this day
          const currentDay = weekStart.getDay(); // 0=Sun
          const targetDay = dayIndex + 1; // 1=Mon
          let daysUntil = targetDay - currentDay;
          if (daysUntil <= 0) daysUntil += 7;
          const sessionDate = new Date(weekStart);
          sessionDate.setDate(sessionDate.getDate() + daysUntil);

          const [prefH, prefM] = preferredTime.split(':').map(Number);
          sessionDate.setHours(prefH || 12, prefM || 0, 0, 0);
          const sessionEnd = new Date(sessionDate.getTime() + (sess.durationMinutes || 60) * 60 * 1000);

          // Build calendar body with exercise details
          let calBody = `${planData.planName || objective}\n\n`;
          calBody += `${sess.title}\n\n`;
          if (sess.exercises?.length) {
            calBody += 'EXERCISES:\n';
            sess.exercises.forEach((ex: any, i: number) => {
              calBody += `${i + 1}. ${ex.name}`;
              if (ex.sets && ex.reps) calBody += ` — ${ex.sets}×${ex.reps}`;
              if (ex.rpe) calBody += ` @ RPE ${ex.rpe}`;
              if (ex.restSec) calBody += ` | ${ex.restSec}s rest`;
              if (ex.distance_km) calBody += ` — ${ex.distance_km}km`;
              if (ex.pace) calBody += ` @ ${ex.pace}`;
              calBody += '\n';
            });
          }
          if (sess.description) calBody += `\n${sess.description}`;
          calBody += `\n\nTIME: ~${sess.durationMinutes || 60} min total`;

          const session = tp.createSession({
            week_id: week.id,
            plan_id: plan.id,
            day_of_week: sess.dayOfWeek,
            session_type: sess.sessionType,
            title: sess.title,
            description: sess.description || '',
            exercises_json: JSON.stringify(sess.exercises || []),
            duration_minutes: sess.durationMinutes || 60,
            intensity_text: `RPE ${weekData.intensityPct || 70}%`,
          });

          // Queue calendar event creation
          const emoji = sess.sessionType === 'gym' ? '💪' :
                        sess.sessionType === 'run' ? '🏃' :
                        sess.sessionType === 'ride' ? '🚴' :
                        sess.sessionType === 'swim' ? '🏊' : '🏋️';

          calendarEvents.push({
            sessionId: session.id,
            title: `${emoji} ${sess.title} (${sess.durationMinutes || 60}min)`,
            start: sessionDate.toISOString(),
            end: sessionEnd.toISOString(),
            description: calBody,
          });

          totalSessions++;
        }
      }

      // ── Step 5: Create calendar events (parallel) ──────────────
      let eventsCreated = 0;
      const { createEvent } = require('../../services/unified-calendar');

      const eventResults = await Promise.allSettled(
        calendarEvents.map(async (ev) => {
          try {
            const event = await createEvent(
              { title: ev.title, start: ev.start, end: ev.end, description: ev.description },
              undefined, // auto-detect source
              userId,
            );
            tp.linkSessionToCalendar(ev.sessionId, event.id, event.source);
            eventsCreated++;
            return event;
          } catch (err) {
            logger.warn({ err, title: ev.title }, 'Failed to create calendar event for session');
            return null;
          }
        })
      );

      logger.info({
        userId, planId: plan.id, totalSessions, eventsCreated,
        objective, durationWeeks,
      }, 'Training plan generated and scheduled');

      sendSuccess(res, {
        planId: plan.id,
        planName: planData.planName,
        sport: planData.sport,
        objective,
        durationWeeks,
        totalSessions,
        eventsCreated,
        weeks: (planData.weeks || []).map((w: any) => ({
          weekNumber: w.weekNumber,
          focus: w.focus,
          sessionCount: w.sessions?.filter((s: any) => s.sessionType !== 'rest').length || 0,
        })),
        message: `Plan created! ${totalSessions} sessions scheduled across ${durationWeeks} weeks. ${eventsCreated} calendar events created.`,
      }, { status: 201 });

    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan generation failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to generate training plan', 500);
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
      const currentWeek = tp.getCurrentWeek(activePlan.id);
      plan = {
        name: activePlan.name,
        weekNumber: currentWeek?.week_number || 1,
        phase: activePlan.phase || null,
      };
      if (currentWeek) {
        // getSessionsForWeek takes a weekId, NOT a userId
        const sessions = tp.getSessionsForWeek(currentWeek.id);
        const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const rawSession = sessions?.find(
          (s: any) => s.day_of_week === todayName,
        );
        if (rawSession) {
          session = {
            id: rawSession.id != null ? String(rawSession.id) : null,
            type: rawSession.title || rawSession.session_type || 'Workout',
            time: null,
            duration: rawSession.duration_minutes || null,
            status: rawSession.status || 'planned',
            notes: rawSession.description || null,
            exercises: null,
          };
        }
      }
    }
  } catch (e) {
    logger.debug({ err: e }, 'getTodaySession training-plans lookup failed');
  }

  if (!session) session = await findTodayTrainingFromCalendar();

  return {
    session: session ? {
      id: session.id ? String(session.id) : null,
      type: session.type || session.name || 'Workout',
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

  // Provider-agnostic readiness: calculateReadiness() handles
  // Garmin → Apple Health → neutral fallback internally.
  // No Garmin-owner / Telegram-era gating — all users get readiness
  // from whatever wearable they have connected.
  let score = 0;
  let factors: any = {};
  let recommendation: string | null = null;

  try {
    const { calculateReadiness } = require('../../services/readiness-scorer');
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
  } catch {}

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

    const keywords = [
      'run', 'gym', 'swim', 'bike', 'cycle', 'training', 'workout', 'strength', 'hiit', 'yoga',
      'treino', 'corrida', 'academia', 'natação', 'musculação', 'ciclismo', 'caminhada', 'walk',
      'easy run', 'interval', 'tempo', 'long run', 'cross', 'stretch',
    ];
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
    const keywords = [
      'run', 'gym', 'swim', 'bike', 'cycle', 'training', 'workout', 'strength', 'hiit', 'yoga',
      'treino', 'corrida', 'academia', 'natação', 'musculação', 'ciclismo', 'caminhada', 'walk',
      'easy run', 'interval', 'tempo', 'long run', 'cross', 'stretch',
    ];
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
