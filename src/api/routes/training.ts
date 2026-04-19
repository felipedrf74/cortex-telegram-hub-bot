// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguage } from '../../services/user-service';
import type { Lang } from '../../utils/i18n';
import { getCached, setCache, clearCache, clearCacheByPrefix } from '../../services/cache-store';
import { invalidatePlanningCaches } from '../../services/plan-cache-invalidator';
import { getLatestByType } from '../../services/report-document-store';
import { setLastCoachState } from '../../domains/domain-handler';
import * as onboarding from '../../services/onboarding';
import * as trainingPlans from '../../services/training-plans';
import { readContentMeshContext, readCookingMeshContext, readFinanceMeshContext, readSecretaryMeshContext, readTrainingMeshContext } from '../../services/cross-agent-learning';
import { buildSharedDecisionContext } from '../../services/shared-decision-context';
import { adaptTrainingPlanToAvailableEquipment, buildTrainingEquipmentAdaptation } from '../../services/training-plan-equipment-adaptation';
import { createEvent, getEvents } from '../../services/unified-calendar';
import { applyTrainingPlanCoordination, buildTrainingPlanCoordination } from '../../services/training-plan-coordination';
import { sendSuccess, sendError } from '../response-helpers';
import { buildQuotaExceededMessage, isUserOverDailyCap } from '../../services/cost-guardrail';
import type { CoachRecommendation } from '../../services/garmin-coach';
import { applyCoachRecommendations, generateCoachBriefing } from '../../services/garmin-coach';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import { buildActiveSignalsResponse } from '../../services/signals-observability';
import { buildTrainingHomeViewState, type CoachRecommendationInput } from '../../services/training-home-view-state';
import { buildScreenContractMeta } from '../../services/screen-contract-meta';
import { buildCoachKernelTrainingPlan } from '../../services/training-coach-kernel-plan-generator';

// Cache TTLs (seconds)
const COACH_TTL = 6 * 3600;    // 6 hours — Garmin data changes once/day
const READINESS_TTL = 5 * 60; // 5 minutes — intraday energy reserve should move during the day
const SUMMARY_TTL = 5 * 60;    // 5 minutes
const HOME_TTL = 5 * 60;

function resolveTrainingLanguage(req: Pick<AuthenticatedRequest, 'header'>, userId: number): Lang {
  // `normalizeLangHeader` always returns a value ('pt-BR' default) so a
  // truthy check would never fall back to the user's stored preference.
  // Check the raw header for presence before normalizing so the DB
  // language wins when the client didn't send x-language.
  const rawHeader = req.header?.('x-language');
  if (rawHeader) return normalizeLangHeader(rawHeader);
  return getUserLanguage(userId);
}

function invalidateTrainingScreenCaches(userId: number) {
  clearCache(`coach-briefing:${userId}`);
  clearCache(`training-summary:${userId}`);
  clearCache(`readiness:${userId}`);
  clearCache(`dashboard-readiness:${userId}`);
  clearCacheByPrefix(`training-home:${userId}:`);
  invalidatePlanningCaches(userId);
}

function invalidCardioSportMessage(language: Lang): string {
  if (language === 'pt-BR') return 'o parâmetro sport deve ser "running" ou "cycling"';
  if (language.startsWith('pt')) return 'o parâmetro sport tem de ser "running" ou "cycling"';
  return 'sport query param must be "running" or "cycling"';
}

type BusyWindow = {
  startMs: number;
  endMs: number;
  title: string;
};

type ObjectiveProfileRequirement = {
  questionnaireId: string;
  title: string;
  missingFields: unknown[];
  message: string;
};

function objectiveNeedsRunningProfile(objective: string): boolean {
  return /(marathon|meia maratona|half marathon|10k|5k|corrida|running|run|trail|ultra)/i.test(objective);
}

function objectiveNeedsGymProfile(objective: string): boolean {
  return /(hipertrofia|hypertrophy|muscle|strength|gym|massa|bodybuilding|força|muscula)/i.test(objective);
}

function resolveObjectiveProfileRequirement(
  objective: string,
  userId: number,
): ObjectiveProfileRequirement | null {
  const lowerObjective = objective.trim();
  const maybeRequirement = (questionnaireId: string, message: string): ObjectiveProfileRequirement | null => {
    const missingFields = onboarding.getMissingProfileFields?.(userId, questionnaireId) || [];
    if (!Array.isArray(missingFields) || missingFields.length === 0) return null;
    const questionnaire = onboarding.getQuestionnaire?.(questionnaireId);
    return {
      questionnaireId,
      title: questionnaire?.title ?? questionnaireId,
      missingFields,
      message,
    };
  };

  if (objectiveNeedsRunningProfile(lowerObjective)) {
    return maybeRequirement(
      'triathlon-running',
      'Complete your running profile first so the plan can ask about race date, target event, current mileage, and workout preferences.',
    );
  }

  if (objectiveNeedsGymProfile(lowerObjective)) {
    return maybeRequirement(
      'triathlon-gym',
      'Complete your strength profile first so the plan can tailor exercise selection, equipment, and gym progression.',
    );
  }

  return null;
}

function normalizePreferredTime(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return /^\d{2}:\d{2}$/.test(trimmed) ? trimmed : fallback;
}

function canonicalTrainingDay(value: string): string {
  const normalized = value.trim().toLowerCase();
  const mapping: Record<string, string> = {
    monday: 'Monday',
    tuesday: 'Tuesday',
    wednesday: 'Wednesday',
    thursday: 'Thursday',
    friday: 'Friday',
    saturday: 'Saturday',
    sunday: 'Sunday',
  };
  return mapping[normalized] ?? value.trim();
}

function buildBusyWindows(events: any[]): BusyWindow[] {
  return (events || []).flatMap((event: any) => {
    const startRaw = event.start?.dateTime || event.startDateTime || event.start;
    const endRaw = event.end?.dateTime || event.endDateTime || event.end;
    const start = new Date(startRaw || '');
    const end = new Date(endRaw || '');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return [];
    return [{
      startMs: start.getTime(),
      endMs: end.getTime(),
      title: event.subject || event.summary || event.title || '',
    }];
  }).sort((a, b) => a.startMs - b.startMs);
}

function preferredTimeForSessionType(
  sessionType: string,
  fallbackPreferredTime: string,
  preferredCardioTime: string,
  preferredStrengthTime: string,
): string {
  switch ((sessionType || '').toLowerCase()) {
    case 'gym':
      return preferredStrengthTime;
    case 'run':
    case 'ride':
    case 'swim':
      return preferredCardioTime;
    default:
      return fallbackPreferredTime;
  }
}

function minutesFromTimeString(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return Math.max(0, Math.min(23 * 60 + 59, (hours || 0) * 60 + (minutes || 0)));
}

function timeStringFromMinutes(totalMinutes: number): string {
  const clamped = Math.max(5 * 60, Math.min(21 * 60, totalMinutes));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function candidateTimesForPreferredTime(preferredTime: string): string[] {
  const baseMinutes = minutesFromTimeString(preferredTime);
  const offsets = [0, -60, 60, -90, 90, 120, -120, 150, -150];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const offset of offsets) {
    const candidate = timeStringFromMinutes(baseMinutes + offset);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

function overlapsRange(startMs: number, endMs: number, windows: BusyWindow[]): boolean {
  return windows.some((window) => startMs < window.endMs && endMs > window.startMs);
}

function scheduleSessionWindow(
  sessionDate: Date,
  durationMinutes: number,
  preferredTime: string,
  busyWindows: BusyWindow[],
  scheduledWindows: BusyWindow[],
): { start: Date; end: Date } {
  const candidates = candidateTimesForPreferredTime(preferredTime);

  for (const candidate of candidates) {
    const [hours, minutes] = candidate.split(':').map(Number);
    const start = new Date(sessionDate);
    start.setHours(hours, minutes, 0, 0);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    if (!overlapsRange(start.getTime(), end.getTime(), busyWindows) && !overlapsRange(start.getTime(), end.getTime(), scheduledWindows)) {
      return { start, end };
    }
  }

  const [fallbackHours, fallbackMinutes] = preferredTime.split(':').map(Number);
  const fallbackStart = new Date(sessionDate);
  fallbackStart.setHours(fallbackHours || 12, fallbackMinutes || 0, 0, 0);
  return {
    start: fallbackStart,
    end: new Date(fallbackStart.getTime() + durationMinutes * 60 * 1000),
  };
}

function normalizeCoachRecommendation(rec: Record<string, any>) {
  return {
    action: typeof rec.action === 'string' ? rec.action : 'KEEP',
    eventId: typeof rec.eventId === 'string' ? rec.eventId : null,
    source: rec.source === 'google' ? 'google' : 'outlook',
    originalTitle: typeof rec.originalTitle === 'string' ? rec.originalTitle : '',
    newTitle: typeof rec.newTitle === 'string' ? rec.newTitle : null,
    newStart: typeof rec.newStart === 'string' ? rec.newStart : null,
    newEnd: typeof rec.newEnd === 'string' ? rec.newEnd : null,
    summary: typeof rec.summary === 'string' ? rec.summary : null,
    reason: typeof rec.reason === 'string'
      ? rec.reason
      : (typeof rec.summary === 'string' ? rec.summary : ''),
  };
}

function restoreCoachBriefingFromLatestReport(userId: number) {
  if (!isValidTenantUserId(userId)) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation: 'restore_coach_briefing_from_report',
      reason: 'invalid_user_scope',
      userId,
      details: { reportType: 'coach_briefing' },
    });
    return null;
  }

  try {
    const report = getLatestByType(userId, 'coach_briefing');
    if (!report?.documentJson) return null;

    const createdAtMs = Date.parse(report.createdAt || '');
    if (Number.isNaN(createdAtMs)) return null;

    // Avoid surfacing stale coaching advice from days ago as if it
    // were today's automatic briefing.
    if (Date.now() - createdAtMs > COACH_TTL * 1000) return null;

    const documentJson = report.documentJson as Record<string, any>;
    const readiness = documentJson.readiness as Record<string, any> | null | undefined;
    const bodyBattery = readiness?.factors?.bodyBattery?.score;

    return {
      briefing: documentJson.message || report.summary || 'Coach briefing available.',
      recommendations: Array.isArray(documentJson.recommendations)
        ? documentJson.recommendations.map((rec) => normalizeCoachRecommendation(rec as Record<string, any>))
        : [],
      garminData: readiness
        ? {
            sleepScore: readiness.factors?.sleep?.score ?? null,
            bodyBattery: typeof bodyBattery === 'number' ? bodyBattery : null,
            steps: null,
            activeMinutes: null,
          }
        : null,
      degraded: Array.isArray(documentJson.errors) && documentJson.errors.length > 0,
      warnings: Array.isArray(documentJson.errors) ? documentJson.errors : [],
      cachedAt: report.createdAt,
      restoredFromReport: true,
    };
  } catch {
    return null;
  }
}

function syncCoachStateForUser(userId: number, payload: Record<string, any>) {
  const normalizedRecommendations = Array.isArray(payload.recommendations)
    ? payload.recommendations.map((rec) => normalizeCoachRecommendation(rec as Record<string, any>))
    : [];
  const persistedRecommendations: CoachRecommendation[] = normalizedRecommendations.flatMap((rec) =>
    rec.eventId
      ? [{
          action: rec.action as CoachRecommendation['action'],
          eventId: rec.eventId,
          source: rec.source as CoachRecommendation['source'],
          originalTitle: rec.originalTitle,
          newTitle: rec.newTitle,
          newStart: rec.newStart,
          newEnd: rec.newEnd,
          summary: rec.summary ?? '',
          reason: rec.reason,
        }]
      : []
  );
  const briefing = typeof payload.briefing === 'string' && payload.briefing.trim().length > 0
    ? payload.briefing.trim()
    : 'Coach briefing available.';

  setLastCoachState(userId, persistedRecommendations, briefing.slice(0, 500));

  return {
    ...payload,
    recommendations: normalizedRecommendations,
  };
}

function getCoachBriefingSnapshot(userId: number) {
  const cacheKey = `coach-briefing:${userId}`;
  const cached = getCached<Record<string, any>>(cacheKey);
  if (cached) {
    return syncCoachStateForUser(userId, cached) as {
      briefing: string;
      recommendations: CoachRecommendationInput[];
      degraded?: boolean;
      cachedOnlyMiss?: boolean;
    };
  }

  const restored = restoreCoachBriefingFromLatestReport(userId);
  if (!restored) return null;

  const payload = syncCoachStateForUser(userId, restored) as {
    briefing: string;
    recommendations: CoachRecommendationInput[];
    degraded?: boolean;
    cachedOnlyMiss?: boolean;
  };
  setCache(cacheKey, payload, COACH_TTL);
  return payload;
}

async function buildTrainingHomePayload(userId: number, language: Lang) {
  const [todayResult, weekResult, readinessResult, signalResult] = await Promise.allSettled([
    getTodaySession(userId),
    getWeekPlan(userId),
    getReadiness(userId),
    Promise.resolve(buildActiveSignalsResponse(userId)),
  ]);

  const today = todayResult.status === 'fulfilled' ? todayResult.value : { session: null, plan: null };
  const week = weekResult.status === 'fulfilled'
    ? weekResult.value
    : { plan: null, sessions: [], adherence: 0, weekNumber: 0, completedCount: 0, totalCount: 0 };
  const readiness = readinessResult.status === 'fulfilled'
    ? readinessResult.value
    : { score: 0, factors: {}, recommendation: null };
  const activeSignals = signalResult.status === 'fulfilled'
    ? signalResult.value
    : { signals: [] };

  const coachBriefing = getCoachBriefingSnapshot(userId);
  const reasonCodes = [
    ...(todayResult.status === 'rejected' ? ['TODAY_UNAVAILABLE'] : []),
    ...(weekResult.status === 'rejected' ? ['WEEK_UNAVAILABLE'] : []),
    ...(readinessResult.status === 'rejected' ? ['READINESS_UNAVAILABLE'] : []),
    ...(readinessResult.status === 'fulfilled' && typeof readinessResult.value?.reasonCode === 'string'
      ? [readinessResult.value.reasonCode]
      : []),
    ...(signalResult.status === 'rejected' ? ['SIGNALS_UNAVAILABLE'] : []),
    ...(coachBriefing?.degraded === true || coachBriefing?.cachedOnlyMiss === true ? ['COACH_STALE'] : []),
  ];
  const tomorrowDayName = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const tomorrowSession = (week.sessions || []).find((session: any) => String(session.day || '').toLowerCase() === tomorrowDayName) || null;
  return buildTrainingHomeViewState({
    todaySession: today.session ?? null,
    readiness,
    coachBriefing,
    signals: activeSignals.signals || [],
    weekSessions: week.sessions || [],
    weeklyAdherence: typeof week.adherence === 'number' ? week.adherence : 0,
    tomorrowSession,
    hasActivePlan: !!(today.plan || week.plan),
    isGarminStale: coachBriefing?.degraded === true || coachBriefing?.cachedOnlyMiss === true,
    meta: buildScreenContractMeta({
      source: 'server',
      isFallback: reasonCodes.length > 0,
      isPartial: todayResult.status === 'rejected'
        || weekResult.status === 'rejected'
        || readinessResult.status === 'rejected'
        || (readinessResult.status === 'fulfilled' && typeof readinessResult.value?.reasonCode === 'string')
        || signalResult.status === 'rejected',
      isStale: coachBriefing?.degraded === true || coachBriefing?.cachedOnlyMiss === true,
      generatedAt: new Date().toISOString(),
      reasonCodes,
    }),
  }, language);
}

export function trainingRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/training/home
   * Render-ready training home state. Pure deterministic composition:
   * today + week + readiness + active signals + cached coach snapshot.
   * Never triggers a fresh AI coach run.
   */
  router.get('/home', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const language = resolveTrainingLanguage(req as AuthenticatedRequest, userId);
    const cacheKey = `training-home:${userId}:${language}`;

    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const payload = await buildTrainingHomePayload(userId, language);
      setCache(cacheKey, payload, HOME_TTL);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS training/home failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to build training home state', 500);
    }
  });

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
    const cacheOnly = req.query.cacheOnly === 'true';
    const cacheKey = `coach-briefing:${userId}`;

    // Return SQLite-cached briefing (survives restarts, no AI call)
    if (!forceRefresh) {
      const cached = getCached(cacheKey);
      if (cached) {
        logger.debug('Returning SQLite-cached coach briefing (no AI call)');
        const payload = syncCoachStateForUser(userId, cached);
        sendSuccess(res, payload, { cached: true });
        return;
      }

      const restored = restoreCoachBriefingFromLatestReport(userId);
      if (restored) {
        const payload = syncCoachStateForUser(userId, restored);
        setCache(cacheKey, payload, COACH_TTL);
        logger.debug({ userId }, 'Restored coach briefing from latest report document');
        sendSuccess(res, payload, { cached: true });
        return;
      }
    }

    if (cacheOnly) {
      sendSuccess(res, {
        briefing: '',
        recommendations: [],
        garminData: null,
        cachedOnlyMiss: true,
      });
      return;
    }

    try {
      const briefing = await generateCoachBriefing(userId);

      // `briefing.message` is the only briefing text field on CoachBriefingResult;
      // garminData is hydrated later via syncCoachStateForUser and the cache-restore
      // path, not by generateCoachBriefing itself. Previous fallbacks to
      // briefing?.text / briefing?.briefing / briefing?.garminData were dead code
      // (those keys never exist on the return type) and the inline `require()`
      // hid the type mismatch.
      const payload = {
        briefing: briefing?.message || 'No coach briefing available.',
        recommendations: briefing?.recommendations || [],
        garminData: null as unknown,
        cachedAt: new Date().toISOString(),
      };

      const hydratedPayload = syncCoachStateForUser(userId, payload);
      setCache(cacheKey, hydratedPayload, COACH_TTL);
      sendSuccess(res, hydratedPayload);
    } catch (err: any) {
      logger.error({ err }, 'iOS training/coach failed');
      sendSuccess(res, {
        briefing: 'Coach briefing unavailable.',
        recommendations: [],
        garminData: null,
        degraded: true,
        warnings: [err?.message || 'Coach briefing unavailable.'],
      });
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
      // 1. Resolve session id → numeric row id
      let rowId: number | null = null;
      if (sessionId && sessionId !== 'today' && !isNaN(Number(sessionId))) {
        rowId = Number(sessionId);
      } else {
        // Look up from active plan
        const plan = trainingPlans.getActivePlan(userId);
        if (plan) {
          const week = trainingPlans.getCurrentWeek(plan.id);
          if (week) {
            const sessions = trainingPlans.getSessionsForWeek(week.id);
            const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
            const todaySession = sessions?.find(
              (s: any) => s.day_of_week === todayName && s.status !== 'completed',
            );
            if (todaySession) rowId = todaySession.id;
          }
        }
      }

      if (rowId === null) {
        sendSuccess(res, {
          completed: true,
          weeklyAdherence: null,
          noActiveSession: true,
        });
        return;
      }

      // 2. Mark completed (and log completion if we have RPE/notes)
      let adherenceRate: number | null = null;
      if (notes || rpe != null) {
        const session = trainingPlans.getSessionById(rowId);
        if (session) {
          trainingPlans.logCompletion({
            session_id: rowId,
            plan_id: session.plan_id,
            rpe_overall: rpe ?? null,
            notes: notes ?? null,
          });
        } else {
          trainingPlans.markSessionCompleted(rowId);
        }
      } else {
        trainingPlans.markSessionCompleted(rowId);
      }

      // Adherence calculation — need planId + weekId
      try {
        const plan = trainingPlans.getActivePlan(userId);
        if (plan) {
          const week = trainingPlans.getCurrentWeek(plan.id);
          if (week) {
            const adh = trainingPlans.getWeeklyAdherence(plan.id, week.id);
            adherenceRate = typeof adh?.adherenceRate === 'number'
              ? adh.adherenceRate / 100  // backend returns 0-100, iOS expects 0-1
              : null;
          }
        }
      } catch (e) {
        logger.debug({ err: e }, 'Adherence calc failed (non-critical)');
      }

      // Invalidate caches since training status changed
      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, { completed: true, weeklyAdherence: adherenceRate });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/complete failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to complete session', 500);
    }
  });

  /**
   * POST /api/v1/training/skip
   *
   * Marks today's session (or an explicit numeric session id) as skipped so
   * adherence and coaching context can reflect the miss instead of pretending
   * the planned session still happened.
   */
  router.post('/skip', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { sessionId } = req.body;

    try {
      let rowId: number | null = null;
      if (sessionId && sessionId !== 'today' && !isNaN(Number(sessionId))) {
        rowId = Number(sessionId);
      } else {
        const plan = trainingPlans.getActivePlan(userId);
        if (plan) {
          const week = trainingPlans.getCurrentWeek(plan.id);
          if (week) {
            const sessions = trainingPlans.getSessionsForWeek(week.id);
            const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
            const todaySession = sessions?.find(
              (s: any) => s.day_of_week === todayName && s.status !== 'completed' && s.status !== 'skipped',
            );
            if (todaySession) rowId = todaySession.id;
          }
        }
      }

      if (rowId === null) {
        sendSuccess(res, {
          skipped: true,
          weeklyAdherence: null,
          noActiveSession: true,
        });
        return;
      }

      trainingPlans.markSessionSkipped(rowId);

      let adherenceRate: number | null = null;
      try {
        const plan = trainingPlans.getActivePlan(userId);
        if (plan) {
          const week = trainingPlans.getCurrentWeek(plan.id);
          if (week) {
            const adh = trainingPlans.getWeeklyAdherence(plan.id, week.id);
            adherenceRate = typeof adh?.adherenceRate === 'number'
              ? adh.adherenceRate / 100
              : null;
          }
        }
      } catch (err) {
        logger.debug({ err }, 'Skip adherence calc failed (non-critical)');
      }

      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, { skipped: true, weeklyAdherence: adherenceRate });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/skip failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to skip session', 500);
    }
  });

  /** POST /api/v1/training/coach/apply */
  router.post('/coach/apply', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { recommendationIds } = req.body;
    try {
      const applied = await applyCoachRecommendations(userId, recommendationIds);
      // Applying a coach recommendation changes the coach briefing and
      // training summary the client just read — clear those caches too,
      // otherwise the next read serves the pre-apply brief and the user
      // sees the same recommendation they just accepted. Mirrors the
      // cache-clear set used by /training/complete above.
      invalidateTrainingScreenCaches(userId);
      sendSuccess(res, {
        applied: applied?.count || 0,
        message: `Calendar updated with ${applied?.count || 0} recommendation(s).`,
        appliedRecommendations: applied?.appliedRecommendations || [],
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/coach/apply failed');
      sendError(res, 'COACH_APPLY_FAILED', err?.message || 'Failed to apply coach recommendations', 503);
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
    const language = resolveTrainingLanguage(req as AuthenticatedRequest, userId);
    const sportRaw = typeof req.query.sport === 'string' ? req.query.sport : '';
    if (sportRaw !== 'running' && sportRaw !== 'cycling') {
      sendError(res, 'BAD_REQUEST', invalidCardioSportMessage(language), 400);
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
      const { getUnifiedWeeklyActivitySummary } = require('../../services/session-analytics');
      const summary = await getUnifiedWeeklyActivitySummary(userId);

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
    const {
      objective,
      durationWeeks = 4,
      preferredTime = '12:00',
      preferredCardioTime,
      preferredStrengthTime,
      sessionsPerWeek = 5,
      strengthSessionsPerWeek = 2,
      longWorkoutDay,
      notes,
    } = req.body;

    if (!objective || typeof objective !== 'string') {
      sendError(res, 'VALIDATION', 'objective is required (e.g., "Lisbon Marathon October 2026")', 400);
      return;
    }

    const quota = isUserOverDailyCap(userId);
    if (quota.over) {
      sendError(
        res,
        'QUOTA_EXCEEDED',
        buildQuotaExceededMessage(quota),
        402,
        { plan: quota.plan, resetAt: quota.resetAt },
      );
      return;
    }

    try {
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

      const objectiveRequirement = resolveObjectiveProfileRequirement(objective, userId);
      if (objectiveRequirement) {
        sendSuccess(res, {
          needsProfile: true,
          requiredQuestionnaireId: objectiveRequirement.questionnaireId,
          requiredQuestionnaireTitle: objectiveRequirement.title,
          message: objectiveRequirement.message,
          missingFields: objectiveRequirement.missingFields,
        });
        return;
      }

      // ── Step 2: Get calendar free slots for next N weeks ────────
      const now = new Date();
      const endDate = new Date(now.getTime() + durationWeeks * 7 * 24 * 60 * 60 * 1000);
      const startStr = now.toISOString().slice(0, 10);
      const endStr = endDate.toISOString().slice(0, 10);

      let busyWindows: BusyWindow[] = [];
      try {
        const events = await getEvents(startStr, endStr, userId);
        busyWindows = buildBusyWindows(events || []);
      } catch {
        // Calendar unavailable — plan without schedule constraints
      }

      // ── Step 3: One AI call → structured plan JSON ─────────────
      const equipmentAdaptation = buildTrainingEquipmentAdaptation({
        fitnessProfile,
        gymProfile,
      });

      let sharedDecisionContext = '';
      let coordination = buildTrainingPlanCoordination({
        sessionsPerWeek: Math.max(3, Math.min(7, Number(sessionsPerWeek) || 5)),
        strengthSessionsPerWeek: Math.max(0, Math.min(4, Number(strengthSessionsPerWeek) || 0)),
        longWorkoutDay: typeof longWorkoutDay === 'string' ? longWorkoutDay.trim() : null,
        fitnessProfile,
        gymProfile,
        runProfile,
        training: null,
        cooking: null,
        finance: null,
        content: null,
        secretary: null,
      });

      try {
        const [trainingContextResult, cookingContextResult, financeContextResult, contentContextResult, secretaryContextResult, sharedContextResult] = await Promise.allSettled([
          readTrainingMeshContext({ userId, weekStart: startStr }),
          readCookingMeshContext({ userId, weekStart: startStr }),
          readFinanceMeshContext({ userId, weekStart: startStr }),
          readContentMeshContext({ userId, weekStart: startStr }),
          readSecretaryMeshContext({ userId, weekStart: startStr }),
          buildSharedDecisionContext('triathlon', userId),
        ]);

        sharedDecisionContext = sharedContextResult.status === 'fulfilled' ? sharedContextResult.value : '';
        coordination = buildTrainingPlanCoordination({
          sessionsPerWeek: Math.max(3, Math.min(7, Number(sessionsPerWeek) || 5)),
          strengthSessionsPerWeek: Math.max(0, Math.min(4, Number(strengthSessionsPerWeek) || 0)),
          longWorkoutDay: typeof longWorkoutDay === 'string' ? longWorkoutDay.trim() : null,
          fitnessProfile,
          gymProfile,
          runProfile,
          training: trainingContextResult.status === 'fulfilled' ? trainingContextResult.value : null,
          cooking: cookingContextResult.status === 'fulfilled' ? cookingContextResult.value : null,
          finance: financeContextResult.status === 'fulfilled' ? financeContextResult.value : null,
          content: contentContextResult.status === 'fulfilled' ? contentContextResult.value : null,
          secretary: secretaryContextResult.status === 'fulfilled' ? secretaryContextResult.value : null,
          sharedDecisionContext,
        });
      } catch (err) {
        logger.warn({ err, userId }, 'training plan coordination context unavailable — falling back to profile/calendar only');
      }

      const dayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const normalizedPreferredTime = normalizePreferredTime(preferredTime, '12:00');
      const normalizedPreferredCardioTime = normalizePreferredTime(preferredCardioTime, normalizedPreferredTime);
      const normalizedPreferredStrengthTime = normalizePreferredTime(preferredStrengthTime, normalizedPreferredTime);

      let usedFallbackTemplate = false;
      let planData: any;
      try {
        planData = adaptTrainingPlanToAvailableEquipment(
          applyTrainingPlanCoordination(buildCoachKernelTrainingPlan({
            userId,
            objective,
            durationWeeks,
            startDate: startStr,
            sessionsPerWeek: Math.max(3, Math.min(7, Number(sessionsPerWeek) || 5)),
            strengthSessionsPerWeek: Math.max(0, Math.min(4, Number(strengthSessionsPerWeek) || 0)),
            preferredTime: normalizedPreferredTime,
            preferredCardioTime: normalizedPreferredCardioTime,
            preferredStrengthTime: normalizedPreferredStrengthTime,
            longWorkoutDay: typeof longWorkoutDay === 'string' ? longWorkoutDay.trim() : null,
            notes: typeof notes === 'string' ? notes.trim() : null,
            fitnessProfile,
            gymProfile,
            runProfile,
          }), coordination),
          equipmentAdaptation,
        );
      } catch (err: any) {
        logger.warn(
          { err, userId, objective },
          'Coach-kernel training plan generation unavailable — using deterministic fallback template',
        );
        planData = adaptTrainingPlanToAvailableEquipment(
          applyTrainingPlanCoordination(buildDeterministicTrainingPlan(objective, durationWeeks, {
            sessionsPerWeek: Math.max(3, Math.min(7, Number(sessionsPerWeek) || 5)),
            strengthSessionsPerWeek: Math.max(0, Math.min(4, Number(strengthSessionsPerWeek) || 0)),
            longWorkoutDay: typeof longWorkoutDay === 'string' ? longWorkoutDay.trim() : null,
          }), coordination),
          equipmentAdaptation,
        );
        usedFallbackTemplate = true;
      }

      // ── Step 4: Bulk insert plan + weeks + sessions ────────────
      const plan = trainingPlans.createPlan({
        user_id: userId,
        name: planData.planName || `${objective} Plan`,
        sport: planData.sport || 'hybrid',
        goal: objective,
        duration_weeks: durationWeeks,
        periodization: planData.periodization || 'undulating',
        start_date: startStr,
        end_date: endStr,
        preferences_json: JSON.stringify({
          preferredTime: normalizedPreferredTime,
          preferredCardioTime: normalizedPreferredCardioTime,
          preferredStrengthTime: normalizedPreferredStrengthTime,
          sessionsPerWeek,
          strengthSessionsPerWeek,
          longWorkoutDay: longWorkoutDay || null,
          notes: notes || null,
        }),
      });

      let totalSessions = 0;
      const calendarEvents: any[] = [];
      const scheduledWindows: BusyWindow[] = [];

      for (const weekData of (planData.weeks || [])) {
        const week = trainingPlans.createWeek({
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
          if (daysUntil < 0) daysUntil += 7;
          const sessionDate = new Date(weekStart);
          sessionDate.setDate(sessionDate.getDate() + daysUntil);

          const resolvedPreferredTime = typeof sess.preferredStartTime === 'string' && /^\d{2}:\d{2}$/.test(sess.preferredStartTime)
            ? sess.preferredStartTime
            : preferredTimeForSessionType(
            sess.sessionType,
            normalizedPreferredTime,
            normalizedPreferredCardioTime,
            normalizedPreferredStrengthTime,
          );
          const durationMinutes = sess.durationMinutes || 60;
          const scheduledWindow = scheduleSessionWindow(
            sessionDate,
            durationMinutes,
            resolvedPreferredTime,
            busyWindows,
            scheduledWindows,
          );
          const sessionStart = scheduledWindow.start;
          const sessionEnd = scheduledWindow.end;
          scheduledWindows.push({
            startMs: sessionStart.getTime(),
            endMs: sessionEnd.getTime(),
            title: sess.title,
          });

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

          const session = trainingPlans.createSession({
            week_id: week.id,
            plan_id: plan.id,
            day_of_week: sess.dayOfWeek,
            session_type: sess.sessionType,
            title: sess.title,
            description: sess.description || '',
            exercises_json: JSON.stringify(sess.exercises || []),
            duration_minutes: durationMinutes,
            intensity_text: `RPE ${weekData.intensityPct || 70}%`,
          });

          // Queue calendar event creation
          const emoji = sess.sessionType === 'gym' ? '💪' :
                        sess.sessionType === 'run' ? '🏃' :
                        sess.sessionType === 'ride' ? '🚴' :
                        sess.sessionType === 'swim' ? '🏊' : '🏋️';

          calendarEvents.push({
            sessionId: session.id,
            title: `${emoji} ${sess.title} (${durationMinutes}min)`,
            start: sessionStart.toISOString(),
            end: sessionEnd.toISOString(),
            description: calBody,
          });

          totalSessions++;
        }
      }

      // ── Step 5: Create calendar events (parallel) ──────────────
      let eventsCreated = 0;
      const eventResults = await Promise.allSettled(
        calendarEvents.map(async (ev) => {
          try {
            const event = await createEvent(
              { title: ev.title, start: ev.start, end: ev.end, description: ev.description },
              undefined, // auto-detect source
              userId,
            );
            trainingPlans.linkSessionToCalendar(ev.sessionId, event.id, event.source);
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
      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, {
        planId: plan.id,
        planName: planData.planName,
        sport: planData.sport,
        objective,
        durationWeeks,
        totalSessions,
        eventsCreated,
        preferredCardioTime: normalizedPreferredCardioTime,
        preferredStrengthTime: normalizedPreferredStrengthTime,
        weeks: (planData.weeks || []).map((w: any) => ({
          weekNumber: w.weekNumber,
          focus: w.focus,
          sessionCount: w.sessions?.filter((s: any) => s.sessionType !== 'rest').length || 0,
        })),
        fallbackTemplateUsed: usedFallbackTemplate,
        message: usedFallbackTemplate
          ? `Plan created with a reliable fallback template. ${totalSessions} sessions scheduled across ${durationWeeks} weeks. ${eventsCreated} calendar events created.`
          : `Plan created! ${totalSessions} sessions scheduled across ${durationWeeks} weeks. ${eventsCreated} calendar events created.`,
      }, { status: 201 });

    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan generation failed');
      sendError(res, 'INTERNAL', 'Failed to generate training plan. Please try again.', 500);
    }
  });

  router.post('/plan/cancel', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const requestedPlanId = Number(req.body?.planId);

    try {
      const tp = require('../../services/training-plans');
      const { deleteEvent } = require('../../services/unified-calendar');

      let plan = Number.isFinite(requestedPlanId) && requestedPlanId > 0
        ? tp.getPlanById(requestedPlanId)
        : tp.getActivePlan(userId);

      if (plan && plan.user_id !== userId) {
        sendError(res, 'FORBIDDEN', 'This training plan does not belong to the current user.', 403);
        return;
      }
      if (!plan) {
        sendSuccess(res, {
          cancelled: false,
          removedEvents: 0,
          message: 'No active training plan to cancel.',
        });
        return;
      }

      const weeks = tp.getWeeksForPlan(plan.id);
      const sessions = weeks.flatMap((week: any) => tp.getSessionsForWeek(week.id));
      const deletableSessions = sessions.filter((session: any) => session.calendar_event_id && session.calendar_source);

      const deletionResults = await Promise.allSettled(
        deletableSessions.map((session: any) =>
          deleteEvent(session.calendar_event_id, session.calendar_source, userId),
        ),
      );
      const removedEvents = deletionResults.filter(r => r.status === 'fulfilled').length;

      for (const session of sessions) {
        const nextStatus = session.status === 'completed' ? 'completed' : 'skipped';
        tp.updateSession(session.id, {
          status: nextStatus,
          calendar_event_id: null,
          calendar_source: null,
        });
      }

      tp.updatePlanStatus(plan.id, 'cancelled');

      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, {
        cancelled: true,
        planId: plan.id,
        removedEvents,
        totalSessions: sessions.length,
        message: `Plan cancelled. ${removedEvents} scheduled workout${removedEvents === 1 ? '' : 's'} removed from the calendar.`,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'Training plan cancellation failed');
      sendError(res, 'INTERNAL', err?.message || 'Failed to cancel training plan', 500);
    }
  });

  return router;
}

// ── Shared Logic (used by individual routes AND /summary) ───────────

async function getTodaySession(userId: number) {
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
        // getSessionsForWeek takes a weekId, NOT a userId
        const sessions = trainingPlans.getSessionsForWeek(currentWeek.id);
        const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
        const rawSession = sessions?.find(
          (s: any) => s.day_of_week === todayName,
        );
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

  // CHAT-M3: Third fallback — check Garmin for today's recorded activities.
  // Users who do ad-hoc gym sessions (not in the plan or calendar) will have
  // the activity on their watch. This surfaces it so "training today" shows
  // something instead of "rest day" when they've already worked out.
  if (!session) {
    try {
      const { getTodayData, isStrength } = require('../../services/garmin');
      const garminData = await getTodayData(userId);
      const activities = garminData?.activities || [];
      if (activities.length > 0) {
        // Pick the most recent activity
        const activity = activities[activities.length - 1];
        const activityType = activity.activityType?.typeKey || activity.activityName || 'workout';
        session = {
          id: activity.activityId ? String(activity.activityId) : null,
          type: isStrength(activityType)
            ? `Strength: ${activity.activityName || 'Gym Session'}`
            : activity.activityName || 'Workout',
          sessionType: isStrength(activityType) ? 'gym' : 'run',
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
    const completed = sessions.filter(s => s.status === 'completed').length;
    const total = sessions.filter(s => s.status !== 'rest').length;
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

function buildDeterministicTrainingPlan(
  objective: string,
  durationWeeks: number,
  options: { sessionsPerWeek?: number; strengthSessionsPerWeek?: number; longWorkoutDay?: string | null } = {},
) {
  const template = inferTrainingTemplate(objective.toLowerCase(), options);
  const weeks = Array.from({ length: durationWeeks }, (_, index) => {
    const weekNumber = index + 1;
    const isDeload = weekNumber === durationWeeks;
    const durationScale = isDeload ? 0.8 : 1 + Math.min(index, 2) * 0.05;

    return {
      weekNumber,
      focus: isDeload ? 'deload' : template.focuses[Math.min(index, template.focuses.length - 1)],
      intensityPct: isDeload ? 58 : 66 + Math.min(index, 2) * 6,
      sessions: template.sessions.map((session: any) => ({
        ...session,
        durationMinutes: Math.max(35, Math.round(session.durationMinutes * durationScale)),
        description: isDeload
          ? `${session.description} Keep the effort controlled and finish feeling fresh.`
          : session.description,
        exercises: Array.isArray(session.exercises)
          ? session.exercises.map((exercise: any) => ({
              ...exercise,
              sets: typeof exercise.sets === 'number'
                ? Math.max(2, Math.round(exercise.sets * (isDeload ? 0.75 : 1)))
                : exercise.sets,
            }))
          : [],
      })),
    };
  });

  return {
    planName: `${objective.trim()} — ${durationWeeks} Week Plan`,
    sport: template.sport,
    periodization: 'undulating',
    weeks,
  };
}

function inferTrainingTemplate(
  lowerObjective: string,
  options: { sessionsPerWeek?: number; strengthSessionsPerWeek?: number; longWorkoutDay?: string | null } = {},
) {
  const targetSessionsPerWeek = Math.max(3, Math.min(7, options.sessionsPerWeek || 5));
  const targetStrengthSessions = Math.max(0, Math.min(4, options.strengthSessionsPerWeek || 0));

  if (/(triathlon|triatlo|70\.3|ironman|half ironman)/i.test(lowerObjective)) {
    return {
      sport: 'hybrid',
      focuses: ['base', 'endurance', 'speed'],
      sessions: [
        {
          dayOfWeek: 'monday',
          sessionType: 'swim',
          title: 'Swim Technique + Aerobic Base',
          durationMinutes: 45,
          description: 'Easy technical swim with drills, relaxed breathing, and smooth aerobic work.',
          exercises: [],
        },
        {
          dayOfWeek: 'tuesday',
          sessionType: 'ride',
          title: 'Bike Endurance',
          durationMinutes: 60,
          description: 'Steady zone 2 ride focused on cadence and sustained aerobic work.',
          exercises: [],
        },
        {
          dayOfWeek: 'wednesday',
          sessionType: 'gym',
          title: 'Strength + Core',
          durationMinutes: 50,
          description: 'Full-body strength session with controlled form and core stability.',
          exercises: baseStrengthExercises(),
        },
        {
          dayOfWeek: 'thursday',
          sessionType: 'run',
          title: 'Run Tempo / Intervals',
          durationMinutes: 50,
          description: 'Quality run with warm-up, focused work, and a calm cooldown.',
          exercises: [],
        },
        {
          dayOfWeek: 'saturday',
          sessionType: 'ride',
          title: 'Long Ride',
          durationMinutes: 95,
          description: 'Long aerobic ride with nutrition practice and steady pacing.',
          exercises: [],
        },
        {
          dayOfWeek: 'sunday',
          sessionType: 'run',
          title: 'Long Run',
          durationMinutes: 65,
          description: 'Comfortable long run focused on endurance and consistency.',
          exercises: [],
        },
      ],
    };
  }

  if (/(marathon|meia maratona|half marathon|10k|5k|corrida|running|run)/i.test(lowerObjective)) {
    return {
      sport: 'running',
      focuses: ['base', 'endurance', 'speed'],
      sessions: buildRunnerFallbackSessions(
        targetSessionsPerWeek,
        targetStrengthSessions,
        options.longWorkoutDay ?? null,
      ),
    };
  }

  if (/(hipertrofia|hypertrophy|muscle|strength|gym|massa|bodybuilding)/i.test(lowerObjective)) {
    return {
      sport: 'gym',
      focuses: ['hypertrophy', 'strength', 'strength'],
      sessions: [
        {
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Upper Body A',
          durationMinutes: 60,
          description: 'Push and pull hypertrophy with controlled tempo and full range of motion.',
          exercises: upperBodyExercises(),
        },
        {
          dayOfWeek: 'tuesday',
          sessionType: 'gym',
          title: 'Lower Body A',
          durationMinutes: 65,
          description: 'Squat-dominant lower-body strength with core work.',
          exercises: lowerBodyExercises(),
        },
        {
          dayOfWeek: 'thursday',
          sessionType: 'gym',
          title: 'Upper Body B',
          durationMinutes: 60,
          description: 'Secondary upper-body day with vertical press, rows, and arms.',
          exercises: upperBodyBExercises(),
        },
        {
          dayOfWeek: 'friday',
          sessionType: 'gym',
          title: 'Lower Body B',
          durationMinutes: 65,
          description: 'Hinge-dominant lower-body session with posterior-chain emphasis.',
          exercises: lowerBodyBExercises(),
        },
      ],
    };
  }

  return {
    sport: 'hybrid',
    focuses: ['base', 'strength', 'endurance'],
    sessions: [
      {
        dayOfWeek: 'monday',
        sessionType: 'gym',
        title: 'Full Body Strength',
        durationMinutes: 50,
        description: 'Balanced full-body strength work with moderate volume and controlled effort.',
        exercises: baseStrengthExercises(),
      },
      {
        dayOfWeek: 'wednesday',
        sessionType: 'run',
        title: 'Zone 2 Cardio',
        durationMinutes: 45,
        description: 'Easy aerobic session to build conditioning and recovery capacity.',
        exercises: [],
      },
      {
        dayOfWeek: 'friday',
        sessionType: 'gym',
        title: 'Full Body Strength B',
        durationMinutes: 50,
        description: 'Second strength session focused on movement quality and progression.',
        exercises: lowerBodyBExercises(),
      },
      {
        dayOfWeek: 'saturday',
        sessionType: 'ride',
        title: 'Long Conditioning Session',
        durationMinutes: 60,
        description: 'Steady conditioning block — bike, brisk walk, or easy jog depending on context.',
        exercises: [],
      },
    ],
  };
}

function buildRunnerFallbackSessions(
  sessionsPerWeek: number,
  strengthSessionsPerWeek: number,
  longWorkoutDay: string | null,
) {
  const canonicalLongDay = canonicalTrainingDay(longWorkoutDay?.trim() || 'Saturday').toLowerCase();
  const runTemplates = [
    {
      dayOfWeek: 'monday',
      sessionType: 'run',
      title: 'Recovery Run',
      durationMinutes: 40,
      description: 'Easy aerobic run with relaxed mechanics and a short cooldown.',
      exercises: [],
    },
    {
      dayOfWeek: 'tuesday',
      sessionType: 'run',
      title: 'Threshold Session',
      durationMinutes: 55,
      description: 'Warm-up, controlled threshold work, and cooldown to build marathon durability.',
      exercises: [],
    },
    {
      dayOfWeek: 'wednesday',
      sessionType: 'run',
      title: 'Base Run',
      durationMinutes: 45,
      description: 'Steady zone 2 run to reinforce aerobic consistency.',
      exercises: [],
    },
    {
      dayOfWeek: 'thursday',
      sessionType: 'run',
      title: 'Intervals / Economy',
      durationMinutes: 50,
      description: 'Quality run with faster segments, full warm-up, and relaxed cooldown.',
      exercises: [],
    },
    {
      dayOfWeek: 'friday',
      sessionType: 'run',
      title: 'Easy Shakeout',
      durationMinutes: 35,
      description: 'Short easy run focused on rhythm and low fatigue.',
      exercises: [],
    },
    {
      dayOfWeek: canonicalLongDay,
      sessionType: 'run',
      title: 'Long Run',
      durationMinutes: 85,
      description: 'Aerobic long run at conversational effort with fueling practice.',
      exercises: [],
    },
    {
      dayOfWeek: canonicalLongDay === 'sunday' ? 'saturday' : 'sunday',
      sessionType: 'run',
      title: 'Base + Strides',
      durationMinutes: 50,
      description: 'Easy aerobic run finished with relaxed strides and mobility.',
      exercises: [],
    },
  ];

  const strengthTemplates = [
    {
      dayOfWeek: 'monday',
      sessionType: 'gym',
      title: 'Runner Strength A',
      durationMinutes: 40,
      description: 'Runner-supportive strength focused on hips, posterior chain, and trunk stability.',
      exercises: runnerStrengthExercises(),
    },
    {
      dayOfWeek: 'wednesday',
      sessionType: 'gym',
      title: 'Runner Strength B',
      durationMinutes: 40,
      description: 'Single-leg strength, calf durability, and controlled trunk work.',
      exercises: runnerStrengthExercises(),
    },
    {
      dayOfWeek: 'friday',
      sessionType: 'gym',
      title: 'Runner Strength C',
      durationMinutes: 35,
      description: 'Short lower-load durability lift that keeps the legs fresh for key run work.',
      exercises: runnerStrengthExercises(),
    },
    {
      dayOfWeek: 'sunday',
      sessionType: 'gym',
      title: 'Mobility + Strength Support',
      durationMinutes: 30,
      description: 'Short support lift with mobility and tissue resilience work.',
      exercises: runnerStrengthExercises(),
    },
  ];

  return [
    ...runTemplates.slice(0, Math.max(1, Math.min(runTemplates.length, sessionsPerWeek))),
    ...strengthTemplates.slice(0, Math.max(0, Math.min(strengthTemplates.length, strengthSessionsPerWeek))),
  ];
}

function baseStrengthExercises() {
  return [
    { name: 'Goblet Squat', sets: 4, reps: 8, rpe: '7', restSec: 90 },
    { name: 'Romanian Deadlift', sets: 3, reps: 8, rpe: '7', restSec: 90 },
    { name: 'Push-Up / DB Press', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'One-Arm Row', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Front Plank', sets: 3, reps: 45, rpe: '6', restSec: 45 },
  ];
}

function runnerStrengthExercises() {
  return [
    { name: 'Split Squat', sets: 3, reps: 8, rpe: '7', restSec: 75 },
    { name: 'Single-Leg RDL', sets: 3, reps: 8, rpe: '7', restSec: 75 },
    { name: 'Step-Up', sets: 3, reps: 10, rpe: '7', restSec: 60 },
    { name: 'Calf Raise', sets: 3, reps: 15, rpe: '7', restSec: 45 },
    { name: 'Dead Bug', sets: 3, reps: 10, rpe: '6', restSec: 45 },
  ];
}

function upperBodyExercises() {
  return [
    { name: 'Bench Press', sets: 4, reps: 8, rpe: '7-8', restSec: 90 },
    { name: 'Chest-Supported Row', sets: 4, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Incline DB Press', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Lateral Raise', sets: 3, reps: 15, rpe: '8', restSec: 45 },
    { name: 'Cable / Band Triceps Pressdown', sets: 3, reps: 12, rpe: '8', restSec: 45 },
  ];
}

function lowerBodyExercises() {
  return [
    { name: 'Back Squat', sets: 4, reps: 6, rpe: '7-8', restSec: 120 },
    { name: 'Walking Lunge', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Leg Curl', sets: 3, reps: 12, rpe: '8', restSec: 60 },
    { name: 'Hanging Knee Raise', sets: 3, reps: 12, rpe: '7', restSec: 45 },
  ];
}

function upperBodyBExercises() {
  return [
    { name: 'Overhead Press', sets: 4, reps: 6, rpe: '7-8', restSec: 90 },
    { name: 'Lat Pulldown / Pull-Up', sets: 4, reps: 8, rpe: '7', restSec: 75 },
    { name: 'Seated Cable Row', sets: 3, reps: 10, rpe: '7', restSec: 75 },
    { name: 'Incline Curl', sets: 3, reps: 12, rpe: '8', restSec: 45 },
    { name: 'Face Pull', sets: 3, reps: 15, rpe: '8', restSec: 45 },
  ];
}

function lowerBodyBExercises() {
  return [
    { name: 'Romanian Deadlift', sets: 4, reps: 6, rpe: '7-8', restSec: 105 },
    { name: 'Leg Press', sets: 3, reps: 10, rpe: '7', restSec: 90 },
    { name: 'Bulgarian Split Squat', sets: 3, reps: 8, rpe: '8', restSec: 75 },
    { name: 'Seated Calf Raise', sets: 3, reps: 15, rpe: '8', restSec: 45 },
    { name: 'Pallof Press', sets: 3, reps: 12, rpe: '6', restSec: 45 },
  ];
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
  let reasonCode: string | null = null;

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
    reasonCode = typeof readiness?.reasonCode === 'string' ? readiness.reasonCode : null;
  } catch {}

  const result = { score, factors, recommendation, reasonCode };
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

async function findTodayTrainingFromCalendar(userId: number): Promise<any | null> {
  try {
    const today = new Date();
    const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);
    const calendarLookup = await buildCalendarEventLookup(startOfDay, endOfDay, userId);
    const calEvents = [...calendarLookup.values()].map(entry => entry.event);
    const trainingEvent = calEvents.find((e: any) => {
      const title = e.subject || e.summary || e.title || '';
      return looksLikeTrainingCalendarEvent(title);
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

async function buildWeekFromCalendar(userId: number): Promise<any[]> {
  try {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today); monday.setDate(today.getDate() + mondayOffset); monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); sunday.setHours(23, 59, 59, 999);

    const calendarLookup = await buildCalendarEventLookup(monday, sunday, userId);
    const calEvents = [...calendarLookup.values()].map(entry => entry.event);
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
          type: e.subject || e.summary || e.title || 'Workout',
          title: e.subject || e.summary || e.title || 'Workout',
          sessionType: inferCalendarSessionType(e.subject || e.summary || e.title || ''),
          time: timeMatch ? timeMatch[1] : null,
          status: 'planned',
          description: e.description || null,
          duration: estimateCalendarDurationMinutes(e.start?.dateTime || e.start, e.end?.dateTime || e.end),
          exercises: null,
        });
      }
    }

    if (dayMap.size === 0) {
      return [];
    }

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

async function buildCalendarEventLookup(
  start: Date,
  end: Date,
  userId: number,
): Promise<Map<string, { time: string | null; event: any }>> {
  const lookup = new Map<string, { time: string | null; event: any }>();
  const events = await getEvents(start.toISOString(), end.toISOString(), userId);

  for (const event of events || []) {
    if (!event?.id) continue;
    const timeMatch = String(event.start || '').match(/T(\d{2}:\d{2})/);
    lookup.set(event.id, {
      time: timeMatch ? timeMatch[1] : null,
      event,
    });
  }

  return lookup;
}

function normalizeTrainingStatus(status?: string | null): string {
  switch ((status || '').toLowerCase()) {
    case 'completed':
      return 'completed';
    case 'skipped':
      return 'skipped';
    case 'rest':
      return 'rest';
    default:
      return 'planned';
  }
}

function parseExercises(exercisesJson?: string | null): any[] | null {
  if (!exercisesJson) return null;
  try {
    const parsed = JSON.parse(exercisesJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function humanizeSessionType(sessionType?: string | null): string {
  switch ((sessionType || '').toLowerCase()) {
    case 'gym': return 'Gym';
    case 'run': return 'Run';
    case 'ride': return 'Ride';
    case 'swim': return 'Swim';
    case 'rest': return 'Rest';
    default: return 'Workout';
  }
}

function inferCalendarSessionType(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('run') || lower.includes('corrida')) return 'run';
  if (lower.includes('swim') || lower.includes('nata')) return 'swim';
  if (lower.includes('bike') || lower.includes('ride') || lower.includes('cicl')) return 'ride';
  if (lower.includes('gym') || lower.includes('strength') || lower.includes('upper body') || lower.includes('lower body')) return 'gym';
  if (lower.includes('rest')) return 'rest';
  return 'workout';
}

export function looksLikeTrainingCalendarEvent(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  if (!normalized) return false;

  const excludedPatterns = [
    /\bwake\s*up\b/i,
    /\bprepare\b/i,
    /\breading\b/i,
    /\batomic\s+habits\b/i,
    /\bmorning\s+routine\b/i,
    /\brotina\b/i,
    /\bschool\b/i,
    /\bescola\b/i,
    /\bmeeting\b/i,
    /\breuni[aã]o\b/i,
  ];
  if (excludedPatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const explicitTrainingPatterns = [
    /\b(?:tempo|interval|long)\s+(?:run|ride)\b/i,
    /\b(?:run|running|corrida|ride|riding|bike|cycling|cycle|swim|swimming|nata[cç][aã]o|gym|academia|strength|for[çc]a|workout|training|treino|muscula[çc][aã]o|hiit|hyrox|pilates|yoga|mobility|ftp|zone\s*2|z2)\b/i,
    /\b(?:brisk|power|recovery)\s+walk\b/i,
    /\bcaminhada\s+(?:r[aá]pida|zona\s*2|recupera[çc][aã]o)\b/i,
  ];

  return explicitTrainingPatterns.some((pattern) => pattern.test(normalized));
}

function estimateCalendarDurationMinutes(startRaw?: string | null, endRaw?: string | null): number | null {
  if (!startRaw || !endRaw) return null;
  try {
    const start = new Date(startRaw);
    const end = new Date(endRaw);
    const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  } catch {
    return null;
  }
}
