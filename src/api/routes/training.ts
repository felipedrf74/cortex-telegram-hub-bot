// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { runOutboxTransaction } from '../../services/event-outbox';
import { consumeResourceBudget } from '../../services/resource-budgets';
import {
  acquireCostLock,
  enforceCostGuardrails,
  type CostGuardrailDecision,
} from '../../services/cost-guardrail';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguageById } from '../../services/user-service';
import type { Lang } from '../../utils/i18n';
import { getCached, setCache } from '../../services/cache-store';
import { invalidateTrainingDerivedCaches } from '../../services/cache-coherence-registry';
import * as trainingPlans from '../../services/training-plans';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import { applyCoachRecommendations, generateCoachBriefing } from '../../services/garmin-coach';
import { buildActiveSignalsResponse } from '../../services/signals-observability';
import {
  looksLikeTrainingCalendarEvent,
} from './training-calendar-utils';
import {
  buildCalendarEventLookup,
  invalidateCalendarLookupCoalesce,
  resetCalendarLookupCoalesceForTests,
} from './training-calendar-lookup';
import {
  COACH_BRIEFING_TTL,
  getCoachBriefingSnapshot,
  restoreCoachBriefingFromLatestReport,
  syncCoachStateForUser,
} from './training-coach-briefing';
import { buildTrainingHomePayload } from './training-home-payload';
import {
  getTrainingWeeklyAdherenceRate,
  resolveTrainingMutationSession,
} from './training-session-mutations';
import {
  getReadiness,
  getTodaySession,
  getAllPlanWeeks,
  getWeekPlan,
} from './training-read-models';
import { registerTrainingAnalyticsRoutes } from './training-analytics-routes';
import { registerTrainingPlanRoutes } from './training-plan-routes';

export { looksLikeTrainingCalendarEvent } from './training-calendar-utils';

const SUMMARY_TTL = 5 * 60;    // 5 minutes
const HOME_TTL = 5 * 60;

function resolveTrainingLanguage(req: Pick<AuthenticatedRequest, 'header'>, userId: number): Lang {
  // `normalizeLangHeader` always returns a value ('pt-BR' default) so a
  // truthy check would never fall back to the user's stored preference.
  // Check the raw header for presence before normalizing so the DB
  // language wins when the client didn't send x-language.
  const rawHeader = req.header?.('x-language');
  if (rawHeader) return normalizeLangHeader(rawHeader);
  return getUserLanguageById(userId);
}

function invalidateTrainingScreenCaches(userId: number) {
  invalidateCalendarLookupCoalesce(userId);
  invalidateTrainingDerivedCaches(userId);
}

function rejectTrainingCostGuardrail(res: Response, decision: Extract<CostGuardrailDecision, { block: true }>): void {
  sendError(
    res,
    decision.reason,
    decision.message,
    decision.status,
    decision.details,
  );
}

function trainingCopy(language: Lang, ptPT: string, ptBR: string, en: string): string {
  if (language === 'pt-PT') return ptPT;
  if (language === 'pt-BR') return ptBR;
  return en;
}

function compactCoachSessionTitle(session: any, language: Lang): string {
  const raw = String(session?.title || session?.type || session?.sessionType || 'workout').trim();
  if (!raw) return trainingCopy(language, 'treino', 'treino', 'workout');
  const normalized = raw.toLowerCase();
  if (language !== 'en-US') {
    if (normalized.includes('easy') && normalized.includes('run')) return 'corrida leve';
    if (normalized.includes('recovery') && normalized.includes('run')) return 'corrida de recuperação';
    if (normalized.includes('strength')) return 'força';
    if (normalized.includes('swim')) return 'natação';
    if (normalized.includes('bike') || normalized.includes('ride') || normalized.includes('cycling')) return 'bicicleta';
  }
  return raw;
}

function buildCoachReportResponse(
  snapshot: Record<string, any>,
  language: Lang,
): Record<string, unknown> {
  const briefing = String(snapshot.briefing || '').trim();
  const recommendations = Array.isArray(snapshot.recommendations) ? snapshot.recommendations : [];
  const primaryRecommendation = recommendations
    .map((rec: any) => String(rec?.summary || rec?.reason || '').trim())
    .find(Boolean);
  const garminData = snapshot.garminData && typeof snapshot.garminData === 'object'
    ? snapshot.garminData as Record<string, unknown>
    : null;
  const signals = [
    typeof garminData?.sleepScore === 'number' ? `Sleep score ${garminData.sleepScore}` : null,
    typeof garminData?.bodyBattery === 'number' ? `Body Battery ${garminData.bodyBattery}` : null,
    snapshot.degraded ? trainingCopy(language, 'Dados parciais', 'Dados parciais', 'Partial data') : null,
  ].filter(Boolean);

  const sections = [
    {
      key: 'coach_summary',
      title: trainingCopy(language, 'Resumo do coach', 'Resumo do coach', 'Coach summary'),
      body: briefing || trainingCopy(language, 'Relatório do coach disponível.', 'Relatório do coach disponível.', 'Coach report available.'),
    },
    {
      key: 'recommendation',
      title: trainingCopy(language, 'Recomendação', 'Recomendação', 'Recommendation'),
      body: primaryRecommendation || trainingCopy(language, 'Segue o plano com atenção à recuperação de hoje.', 'Siga o plano com atenção à recuperação de hoje.', 'Follow the plan with attention to today’s recovery.'),
    },
    {
      key: 'signals_used',
      title: trainingCopy(language, 'Sinais usados', 'Sinais usados', 'Signals used'),
      body: signals.length > 0
        ? signals.join(' · ')
        : trainingCopy(language, 'Sinais recentes limitados; Nexus está a ser conservador.', 'Sinais recentes limitados; Nexus está sendo conservador.', 'Recent signals are limited; Nexus is staying conservative.'),
    },
    {
      key: 'confidence_uncertainty',
      title: trainingCopy(language, 'Confiança e incerteza', 'Confiança e incerteza', 'Confidence and uncertainty'),
      body: snapshot.degraded
        ? trainingCopy(language, 'Confiança média/baixa porque alguns dados não estavam frescos.', 'Confiança média/baixa porque alguns dados não estavam frescos.', 'Medium-low confidence because some data was not fresh.')
        : trainingCopy(language, 'Confiança média: usa o plano atual e sinais disponíveis.', 'Confiança média: usa o plano atual e sinais disponíveis.', 'Medium confidence: based on the current plan and available signals.'),
    },
    {
      key: 'sources_details',
      title: trainingCopy(language, 'Detalhes', 'Detalhes', 'Details'),
      body: snapshot.restoredFromReport
        ? trainingCopy(language, 'Restaurado do último relatório do coach.', 'Restaurado do último relatório do coach.', 'Restored from the latest coach report.')
        : trainingCopy(language, 'Gerado a partir do estado atual do treino.', 'Gerado a partir do estado atual do treino.', 'Generated from current Training state.'),
      collapsed: true,
    },
  ];

  return {
    ...snapshot,
    report: {
      sections,
      sanitized: true,
      structured: true,
    },
  };
}

async function buildDeterministicCoachFallback(
  userId: number,
  language: Lang,
): Promise<Record<string, unknown> | null> {
  const [todayResult, weekResult, readinessResult] = await Promise.allSettled([
    getTodaySession(userId),
    getWeekPlan(userId),
    getReadiness(userId),
  ]);

  const today = todayResult.status === 'fulfilled' ? todayResult.value?.session : null;
  const plan = todayResult.status === 'fulfilled' ? todayResult.value?.plan : null;
  const week = weekResult.status === 'fulfilled' ? weekResult.value : null;
  const readiness = readinessResult.status === 'fulfilled' ? readinessResult.value : null;
  const sessions = Array.isArray(week?.sessions) ? week.sessions : [];
  const nextSession = sessions.find((session: any) => session?.status !== 'completed' && session?.status !== 'skipped') ?? today;
  const hasTrainingContext = Boolean(today || nextSession || plan || sessions.length > 0);
  const readinessScore = typeof readiness?.score === 'number' ? readiness.score : null;

  if (!hasTrainingContext) return null;

  const sessionTitle = compactCoachSessionTitle(nextSession || today, language);
  const readinessText = readinessScore != null
    ? trainingCopy(language, `Prontidão ${readinessScore}/100`, `Prontidão ${readinessScore}/100`, `readiness ${readinessScore}/100`)
    : trainingCopy(language, 'prontidão ainda limitada', 'prontidão ainda limitada', 'limited readiness data');
  const plannedCount = sessions.filter((session: any) => session?.status !== 'rest').length;
  const completedCount = sessions.filter((session: any) => session?.status === 'completed').length;

  const briefing = trainingCopy(
    language,
    `Leitura rápida do coach: ${sessionTitle} está no plano com ${readinessText}. Mantém a sessão conservadora se sono, HRV ou energia estiverem abaixo do normal. Semana: ${completedCount}/${plannedCount} sessões concluídas.`,
    `Leitura rápida do coach: ${sessionTitle} está no plano com ${readinessText}. Mantém a sessão conservadora se sono, HRV ou energia estiverem abaixo do normal. Semana: ${completedCount}/${plannedCount} sessões concluídas.`,
    `Quick coach read: ${sessionTitle} is on the plan with ${readinessText}. Keep the session conservative if sleep, HRV, or energy are below normal. Week: ${completedCount}/${plannedCount} sessions completed.`,
  );

  return {
    briefing,
    recommendations: [],
    garminData: null,
    degraded: false,
    warnings: [],
    deterministicFallback: true,
    cachedAt: new Date().toISOString(),
  };
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
      const payload = await buildTrainingHomePayload(userId, language, {
        getTodaySession,
        getWeekPlan,
        getReadiness,
        buildActiveSignalsResponse,
        getCoachBriefingSnapshot,
      });
      setCache(cacheKey, payload, HOME_TTL);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS training/home failed');
      sendInternalError(res, 'Failed to build training home state');
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
      sendInternalError(res, 'Failed to fetch today session');
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
      sendInternalError(res, 'Failed to fetch week plan');
    }
  });

  /** GET /api/v1/training/plan/weeks */
  router.get('/plan/weeks', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const weeks = await getAllPlanWeeks(userId);
      sendSuccess(res, weeks);
    } catch (err: any) {
      logger.error({ err }, 'iOS training/plan/weeks failed');
      sendInternalError(res, 'Failed to fetch training plan weeks');
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
    const language = resolveTrainingLanguage(req as AuthenticatedRequest, userId);

    // Return SQLite-cached briefing (survives restarts, no AI call)
    if (!forceRefresh) {
      const cached = getCached<Record<string, unknown>>(cacheKey);
      if (cached) {
        logger.debug('Returning SQLite-cached coach briefing (no AI call)');
        const payload = syncCoachStateForUser(userId, cached);
        sendSuccess(res, payload, { cached: true });
        return;
      }

      const restored = restoreCoachBriefingFromLatestReport(userId);
      if (restored) {
        const payload = syncCoachStateForUser(userId, restored);
        setCache(cacheKey, payload, COACH_BRIEFING_TTL);
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

    const releaseCostLock = await acquireCostLock(userId);
    try {
      const guardrail = enforceCostGuardrails(userId);
      if (guardrail.block) {
        rejectTrainingCostGuardrail(res, guardrail);
        return;
      }

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
      setCache(cacheKey, hydratedPayload, COACH_BRIEFING_TTL);
      sendSuccess(res, hydratedPayload);
    } catch (err: any) {
      logger.error({ err }, 'iOS training/coach failed');
      const fallback = await buildDeterministicCoachFallback(userId, language).catch((fallbackErr) => {
        logger.debug({ err: fallbackErr, userId }, 'training/coach deterministic fallback failed');
        return null;
      });
      if (fallback) {
        const hydratedFallback = syncCoachStateForUser(userId, fallback);
        setCache(cacheKey, hydratedFallback, COACH_BRIEFING_TTL);
        sendSuccess(res, hydratedFallback);
        return;
      }
      sendSuccess(res, {
        briefing: 'Coach briefing unavailable.',
        recommendations: [],
        garminData: null,
        degraded: true,
        warnings: ['Coach briefing unavailable.'],
      });
    } finally {
      releaseCostLock();
    }
  });

  router.post('/coach/report', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const forceRefresh = req.body?.refresh === true;
    const cacheKey = `coach-briefing:${userId}`;
    const language = resolveTrainingLanguage(req as AuthenticatedRequest, userId);

    if (!forceRefresh) {
      const cached = getCached<Record<string, unknown>>(cacheKey);
      if (cached) {
        const payload = syncCoachStateForUser(userId, cached);
        sendSuccess(res, buildCoachReportResponse(payload, language), { cached: true });
        return;
      }
      const restored = restoreCoachBriefingFromLatestReport(userId);
      if (restored) {
        const payload = syncCoachStateForUser(userId, restored);
        setCache(cacheKey, payload, COACH_BRIEFING_TTL);
        sendSuccess(res, buildCoachReportResponse(payload, language), { cached: true });
        return;
      }
    }

    const releaseCostLock = await acquireCostLock(userId);
    try {
      const guardrail = enforceCostGuardrails(userId);
      if (guardrail.block) {
        rejectTrainingCostGuardrail(res, guardrail);
        return;
      }

      const briefing = await generateCoachBriefing(userId);
      const payload = syncCoachStateForUser(userId, {
        briefing: briefing?.message || 'No coach briefing available.',
        recommendations: briefing?.recommendations || [],
        garminData: null as unknown,
        cachedAt: new Date().toISOString(),
      });
      setCache(cacheKey, payload, COACH_BRIEFING_TTL);
      sendSuccess(res, buildCoachReportResponse(payload, language));
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS training/coach/report failed');
      const fallback = await buildDeterministicCoachFallback(userId, language).catch(() => null);
      if (fallback) {
        const payload = syncCoachStateForUser(userId, fallback);
        sendSuccess(res, buildCoachReportResponse(payload, language));
        return;
      }
      sendSuccess(res, buildCoachReportResponse({
        briefing: trainingCopy(language, 'Relatório do coach indisponível.', 'Relatório do coach indisponível.', 'Coach report unavailable.'),
        recommendations: [],
        garminData: null,
        degraded: true,
        warnings: ['Coach report unavailable.'],
      }, language));
    } finally {
      releaseCostLock();
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
    const { userId, tenantId = userId } = req as AuthenticatedRequest;
    const { sessionId, notes, rpe } = req.body;
    if (!consumeTrainingWriteBudget(res, tenantId, userId, 'training_session_complete')) return;

    try {
      const resolved = resolveTrainingMutationSession(userId, sessionId, {
        getActivePlan: trainingPlans.getActivePlan,
        getCurrentWeek: trainingPlans.getCurrentWeek,
        getSessionsForWeek: trainingPlans.getSessionsForWeek,
        getSessionById: trainingPlans.getSessionById,
        getPlanById: trainingPlans.getPlanById,
        getWeeklyAdherence: trainingPlans.getWeeklyAdherence,
      });

      if (resolved.kind === 'no_active_session') {
        sendSuccess(res, {
          completed: true,
          weeklyAdherence: null,
          noActiveSession: true,
        });
        return;
      }

      if (resolved.kind === 'not_found') {
        sendError(res, 'NOT_FOUND', 'Training session not found', 404);
        return;
      }

      if (resolved.kind === 'forbidden') {
        sendError(res, 'FORBIDDEN', 'Training session belongs to another account', 403);
        return;
      }

      const { rowId, session } = resolved;

      const writeCompletion = () => {
        if (notes || rpe != null) {
          trainingPlans.logCompletion({
            session_id: rowId,
            plan_id: session.plan_id,
            rpe_overall: rpe ?? null,
            notes: notes ?? null,
          });
        } else {
          trainingPlans.markSessionCompleted(rowId);
        }
      };
      runOutboxTransaction((emitDomainEvent) => {
        writeCompletion();
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'training',
          eventType: 'training.feedback.recorded',
          entityType: 'training_session',
          entityId: rowId,
          payload: {
            summary: { status: 'completed', hasNotes: Boolean(notes), hasRpe: rpe != null },
            action: 'updated',
          },
          privacyClassification: 'health',
          idempotencyKey: `training.feedback.recorded:${userId}:${rowId}:completed:${Boolean(notes)}:${rpe ?? 'none'}`,
        });
      });

      const adherenceRate = getTrainingWeeklyAdherenceRate(userId, {
        getActivePlan: trainingPlans.getActivePlan,
        getCurrentWeek: trainingPlans.getCurrentWeek,
        getWeeklyAdherence: trainingPlans.getWeeklyAdherence,
      });

      // Invalidate caches since training status changed
      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, { completed: true, weeklyAdherence: adherenceRate });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/complete failed');
      sendInternalError(res, 'Failed to complete session');
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
    const { userId, tenantId = userId } = req as AuthenticatedRequest;
    const { sessionId } = req.body;
    if (!consumeTrainingWriteBudget(res, tenantId, userId, 'training_session_skip')) return;

    try {
      const resolved = resolveTrainingMutationSession(userId, sessionId, {
        getActivePlan: trainingPlans.getActivePlan,
        getCurrentWeek: trainingPlans.getCurrentWeek,
        getSessionsForWeek: trainingPlans.getSessionsForWeek,
        getSessionById: trainingPlans.getSessionById,
        getPlanById: trainingPlans.getPlanById,
        getWeeklyAdherence: trainingPlans.getWeeklyAdherence,
      }, {
        excludeSkippedSessions: true,
      });

      if (resolved.kind === 'no_active_session') {
        sendSuccess(res, {
          skipped: true,
          weeklyAdherence: null,
          noActiveSession: true,
        });
        return;
      }

      if (resolved.kind === 'not_found') {
        sendError(res, 'NOT_FOUND', 'Training session not found', 404);
        return;
      }

      if (resolved.kind === 'forbidden') {
        sendError(res, 'FORBIDDEN', 'Training session belongs to another account', 403);
        return;
      }

      const { rowId } = resolved;

      const writeSkip = () => {
        trainingPlans.markSessionSkipped(rowId);
      };
      runOutboxTransaction((emitDomainEvent) => {
        writeSkip();
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'training',
          eventType: 'training.session.updated',
          entityType: 'training_session',
          entityId: rowId,
          payload: {
            summary: { status: 'skipped' },
            action: 'updated',
          },
          privacyClassification: 'health',
          idempotencyKey: `training.session.updated:${userId}:${rowId}:skipped`,
        });
      });

      const adherenceRate = getTrainingWeeklyAdherenceRate(userId, {
        getActivePlan: trainingPlans.getActivePlan,
        getCurrentWeek: trainingPlans.getCurrentWeek,
        getWeeklyAdherence: trainingPlans.getWeeklyAdherence,
      });

      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, { skipped: true, weeklyAdherence: adherenceRate });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/skip failed');
      sendInternalError(res, 'Failed to skip session');
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
      sendInternalError(res, 'Failed to apply coach recommendations', {
        code: 'COACH_APPLY_FAILED',
        status: 503,
      });
    }
  });

  registerTrainingAnalyticsRoutes(router, resolveTrainingLanguage);
  registerTrainingPlanRoutes(router, { invalidateTrainingScreenCaches });

  return router;
}

function consumeTrainingWriteBudget(res: Response, tenantId: number, userId: number, budgetKey: string): boolean {
  const budget = consumeResourceBudget({
    tenantId,
    userId,
    budgetKey,
    limit: 60,
    windowSeconds: 60,
  });
  if (budget.allowed) return true;
  setRetryAfter(res, budget.resetAt);
  sendError(res, 'RATE_LIMITED', 'Too many training write requests. Try again shortly.', 429, {
    resetAt: budget.resetAt,
    budgetKey: budget.budgetKey,
  });
  return false;
}

function setRetryAfter(res: Response, resetAt: string): void {
  const seconds = Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000));
  res.setHeader('Retry-After', String(Number.isFinite(seconds) ? seconds : 60));
}

/** Test-only: reset the coalescing caches between cases. */
export function _resetCalendarLookupCoalesceForTests(): void {
  resetCalendarLookupCoalesceForTests();
}

/** Test-only: expose buildCalendarEventLookup so coalescing behavior
 *  can be pinned by unit tests. Production code should not call this
 *  re-export — it exists solely to keep the test surface narrow. */
export const _buildCalendarEventLookupForTests = buildCalendarEventLookup;
