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
import { mountCoachV2Routes } from './training-coach-v2';
import { computeV2IdempotencyHashHex } from './training-completion-v2-hash';
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
import { requireTenantIdParam } from '../../services/tenant-scope';

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
  tenantId: number,
  language: Lang,
): Promise<Record<string, unknown> | null> {
  const [todayResult, weekResult, readinessResult] = await Promise.allSettled([
    getTodaySession(userId, tenantId),
    getWeekPlan(userId, tenantId),
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

  // ── Coach periodization v2 routes (Codex P1 wiring) ──────────────
  // Mounted EARLY so the feature-flag check fires before any other
  // handler. When the flag is OFF, the helper short-circuits with
  // 404 for /week/travel, /week/:weekId/reflow, and
  // /plans/:planId/coach-policy paths — leaving the legacy training
  // surface untouched.
  mountCoachV2Routes(router);

  /**
   * GET /api/v1/training/home
   * Render-ready training home state. Pure deterministic composition:
   * today + week + readiness + active signals + cached coach snapshot.
   * Never triggers a fresh AI coach run.
   */
  router.get('/home', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const language = resolveTrainingLanguage(req as AuthenticatedRequest, userId);
    const cacheKey = `training-home:${tenantId}:${userId}:${language}`;

    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const payload = await buildTrainingHomePayload(userId, tenantId, language, {
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
    const { userId, tenantId } = req as AuthenticatedRequest;
    const cacheKey = `training-summary:${tenantId}:${userId}`;

    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    // Parallel fetch — NEVER sequential
    const [todayResult, weekResult, readinessResult] = await Promise.allSettled([
      getTodaySession(userId, tenantId),
      getWeekPlan(userId, tenantId),
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
    const { userId, tenantId } = req as AuthenticatedRequest;
    try {
      const session = await getTodaySession(userId, tenantId);
      sendSuccess(res, session);
    } catch (err: any) {
      logger.error({ err }, 'iOS training/today failed');
      sendInternalError(res, 'Failed to fetch today session');
    }
  });

  /** GET /api/v1/training/week */
  router.get('/week', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    try {
      const week = await getWeekPlan(userId, tenantId);
      sendSuccess(res, week);
    } catch (err: any) {
      logger.error({ err }, 'iOS training/week failed');
      sendInternalError(res, 'Failed to fetch week plan');
    }
  });

  /** GET /api/v1/training/plan/weeks */
  router.get('/plan/weeks', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    try {
      const weeks = await getAllPlanWeeks(userId, tenantId);
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
    const { userId, tenantId } = req as AuthenticatedRequest;
    const dataUserId = tenantId;
    const forceRefresh = req.query.refresh === 'true';
    const cacheOnly = req.query.cacheOnly === 'true';
    const cacheKey = `coach-briefing:${dataUserId}`;
    const language = resolveTrainingLanguage(req as AuthenticatedRequest, userId);

    // Return SQLite-cached briefing (survives restarts, no AI call)
    if (!forceRefresh) {
      const cached = getCached<Record<string, unknown>>(cacheKey);
      if (cached) {
        logger.debug('Returning SQLite-cached coach briefing (no AI call)');
        const payload = syncCoachStateForUser(dataUserId, cached);
        sendSuccess(res, payload, { cached: true });
        return;
      }

      const restored = restoreCoachBriefingFromLatestReport(dataUserId);
      if (restored) {
        const payload = syncCoachStateForUser(dataUserId, restored);
        setCache(cacheKey, payload, COACH_BRIEFING_TTL);
        logger.debug({ userId, tenantId: dataUserId }, 'Restored coach briefing from latest report document');
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

      const briefing = await generateCoachBriefing(dataUserId, { tenantId: dataUserId, meteringUserId: userId });

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

      const hydratedPayload = syncCoachStateForUser(dataUserId, payload);
      setCache(cacheKey, hydratedPayload, COACH_BRIEFING_TTL);
      sendSuccess(res, hydratedPayload);
    } catch (err: any) {
      logger.error({ err }, 'iOS training/coach failed');
      const fallback = await buildDeterministicCoachFallback(dataUserId, dataUserId, language).catch((fallbackErr) => {
        logger.debug({ err: fallbackErr, userId, tenantId: dataUserId }, 'training/coach deterministic fallback failed');
        return null;
      });
      if (fallback) {
        const hydratedFallback = syncCoachStateForUser(dataUserId, {
          ...fallback,
          degraded: true,
          warnings: [
            ...(
              Array.isArray((fallback as any).warnings)
                ? (fallback as any).warnings.filter((warning: unknown): warning is string => typeof warning === 'string')
                : []
            ),
            'Coach AI unavailable; deterministic fallback used.',
          ],
        });
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
    let tenantId: number;
    try {
      tenantId = requireTenantIdParam((req as AuthenticatedRequest).tenantId, 'training.coach.report');
    } catch {
      sendError(res, 'TENANT_SCOPE_REQUIRED', 'Training coach report requires a validated tenant scope.', 400);
      return;
    }
    const dataUserId = tenantId;
    const forceRefresh = req.body?.refresh === true;
    const cacheKey = `coach-briefing:${dataUserId}`;
    const language = resolveTrainingLanguage(req as AuthenticatedRequest, userId);

    if (!forceRefresh) {
      const cached = getCached<Record<string, unknown>>(cacheKey);
      if (cached) {
        const payload = syncCoachStateForUser(dataUserId, cached);
        sendSuccess(res, buildCoachReportResponse(payload, language), { cached: true });
        return;
      }
      const restored = restoreCoachBriefingFromLatestReport(dataUserId);
      if (restored) {
        const payload = syncCoachStateForUser(dataUserId, restored);
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

      const briefing = await generateCoachBriefing(dataUserId, { tenantId: dataUserId, meteringUserId: userId });
      const payload = syncCoachStateForUser(dataUserId, {
        briefing: briefing?.message || 'No coach briefing available.',
        recommendations: briefing?.recommendations || [],
        garminData: null as unknown,
        cachedAt: new Date().toISOString(),
      });
      setCache(cacheKey, payload, COACH_BRIEFING_TTL);
      sendSuccess(res, buildCoachReportResponse(payload, language));
    } catch (err: any) {
      logger.error({ err, userId, tenantId: dataUserId }, 'iOS training/coach/report failed');
      const fallback = await buildDeterministicCoachFallback(dataUserId, dataUserId, language).catch(() => null);
      if (fallback) {
        const payload = syncCoachStateForUser(dataUserId, fallback);
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
    const { userId, tenantId } = req as AuthenticatedRequest;
    // Codex R2 P2 fix — accept the A0c CompletionFeedbackV2 fields.
    // Legacy callers that only send sessionId/notes/rpe continue to
    // work unchanged; the new fields are all optional.
    const {
      sessionId,
      notes,
      rpe,
      rir,
      painScore,
      painLocation,
      technicalSuccessScore,
      missedReason,
      externalTrainingDeclared,
      completedDurationSec,
      completedDistanceMeters,
      completedSetsJson,
      completedRepsJson,
      completedLoadJson,
    } = req.body as Record<string, unknown>;
    // R4 P2 fix — stricter V2 field validation. Codex caught that
    // R3's `typeof v === 'number'` accepted NaN and Infinity, and
    // the event hash only fingerprinted field presence (so
    // `{ painScore: 1, rir: 2 }` and `{ painScore: 9, rir: 0 }`
    // collided to the same outbox key). This pass requires
    // Number.isFinite + per-field ranges and switches the event
    // hash to a canonical *value* hash.
    const v2TypeErrors: string[] = [];
    const checkNumberInRange = (
      name: string,
      v: unknown,
      min: number,
      max: number,
    ): void => {
      if (v === undefined || v === null) return;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        v2TypeErrors.push(`${name} must be a finite number`);
        return;
      }
      if (v < min || v > max) {
        v2TypeErrors.push(`${name} must be between ${min} and ${max} (got ${v})`);
      }
    };
    const checkString = (name: string, v: unknown, maxLen = 1024): void => {
      if (v === undefined || v === null) return;
      if (typeof v !== 'string') {
        v2TypeErrors.push(`${name} must be a string`);
        return;
      }
      if (v.length > maxLen) {
        v2TypeErrors.push(`${name} must be ≤ ${maxLen} characters`);
      }
    };
    // R7 P2/P3 fix — Codex caught that null was silently treated as
    // "field omitted." That made `external_training_declared: null`
    // collapse to `false` instead of failing as wrong-type. The
    // documented contract (R6 P3 prompt) was reject-on-non-boolean
    // including null. Only `undefined` (field absent from payload)
    // is treated as omitted now; explicit `null` falls through to
    // the type check.
    const checkBoolean = (name: string, v: unknown): void => {
      if (v === undefined) return;
      if (typeof v !== 'boolean') {
        v2TypeErrors.push(`${name} must be a boolean`);
      }
    };
    // Per-field ranges per A0c semantics (RPE/RIR scales, plausible
    // distances/durations). Out-of-range payloads are bugs, not data.
    checkNumberInRange('rir', rir, 0, 10);
    checkNumberInRange('painScore', painScore, 0, 10);
    checkString('painLocation', painLocation, 256);
    checkNumberInRange('technicalSuccessScore', technicalSuccessScore, 0, 10);
    checkString('missedReason', missedReason, 256);
    checkBoolean('externalTrainingDeclared', externalTrainingDeclared);
    checkNumberInRange('completedDurationSec', completedDurationSec, 0, 24 * 3600);
    checkNumberInRange('completedDistanceMeters', completedDistanceMeters, 0, 500_000);
    checkString('completedSetsJson', completedSetsJson, 8 * 1024);
    checkString('completedRepsJson', completedRepsJson, 8 * 1024);
    checkString('completedLoadJson', completedLoadJson, 8 * 1024);
    if (v2TypeErrors.length > 0) {
      sendError(res, 'BAD_INPUT', `Invalid V2 completion fields: ${v2TypeErrors.join('; ')}`, 400);
      return;
    }

    if (!consumeTrainingWriteBudget(res, tenantId, userId, 'training_session_complete')) return;

    try {
      const resolved = resolveTrainingMutationSession(userId, tenantId, sessionId, {
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

      if (resolved.kind === 'bad_input') {
        sendError(res, 'BAD_INPUT', resolved.message, 400);
        return;
      }

      if (resolved.kind === 'not_found') {
        sendError(res, 'NOT_FOUND', 'Training session not found', 404);
        return;
      }

      if (resolved.kind === 'forbidden') {
        sendError(res, 'NOT_FOUND', 'Training session not found', 404);
        return;
      }

      const { rowId, session } = resolved;

      // Codex R2 P2 fix — surface CompletionFeedbackV2 fields from
      // the REST payload. The service layer normalizes undefined →
      // NULL so a partial payload doesn't clobber other fields.
      const hasV2Field = (
        rir != null || painScore != null || painLocation != null ||
        technicalSuccessScore != null || missedReason != null ||
        externalTrainingDeclared === true ||
        completedDurationSec != null || completedDistanceMeters != null ||
        completedSetsJson != null || completedRepsJson != null ||
        completedLoadJson != null
      );

      const writeCompletion = () => {
        if (notes || rpe != null || hasV2Field) {
          trainingPlans.logCompletion({
            session_id: rowId,
            plan_id: session.plan_id,
            rpe_overall: typeof rpe === 'number' ? rpe : undefined,
            notes: typeof notes === 'string' ? notes : undefined,
            rir: typeof rir === 'number' ? rir : undefined,
            pain_score: typeof painScore === 'number' ? painScore : undefined,
            pain_location: typeof painLocation === 'string' ? painLocation : undefined,
            technical_success_score: typeof technicalSuccessScore === 'number' ? technicalSuccessScore : undefined,
            missed_reason: typeof missedReason === 'string' ? missedReason : undefined,
            external_training_declared: externalTrainingDeclared === true,
            completed_duration_sec: typeof completedDurationSec === 'number' ? completedDurationSec : undefined,
            completed_distance_meters: typeof completedDistanceMeters === 'number' ? completedDistanceMeters : undefined,
            completed_sets_json: typeof completedSetsJson === 'string' ? completedSetsJson : undefined,
            completed_reps_json: typeof completedRepsJson === 'string' ? completedRepsJson : undefined,
            completed_load_json: typeof completedLoadJson === 'string' ? completedLoadJson : undefined,
          });
        } else {
          trainingPlans.markSessionCompleted(rowId);
        }
      };
      runOutboxTransaction((emitDomainEvent) => {
        writeCompletion();
        // R3 P2 fix — include V2 fields in the dedup hash so two
        // distinct V2 payloads don't collapse onto the same event.
        // R4 P2 fix — the prior version only hashed *presence flags*
        // (e.g. `hasRir: rir != null`). That meant
        // `{ painScore: 1, rir: 2 }` and `{ painScore: 9, rir: 0 }`
        // produced the same idempotency key and got deduped at the
        // outbox. The summary kept here (emitted on the event) stays
        // presence-only to avoid leaking values into log lines, but
        // the hash basis now fingerprints the *canonical values* so
        // two distinct logged completions can't collapse onto one key.
        const v2Summary = {
          hasRir: rir != null,
          hasPainScore: painScore != null,
          hasPainLocation: typeof painLocation === 'string' && painLocation.length > 0,
          hasTechnicalSuccessScore: technicalSuccessScore != null,
          hasMissedReason: typeof missedReason === 'string' && missedReason.length > 0,
          externalTrainingDeclared: externalTrainingDeclared === true,
          hasCompletedDurationSec: completedDurationSec != null,
          hasCompletedDistanceMeters: completedDistanceMeters != null,
          hasCompletedSetsJson: typeof completedSetsJson === 'string' && completedSetsJson.length > 0,
          hasCompletedRepsJson: typeof completedRepsJson === 'string' && completedRepsJson.length > 0,
          hasCompletedLoadJson: typeof completedLoadJson === 'string' && completedLoadJson.length > 0,
        };
        // Hash *values*, not just presence. Helper is exported from a
        // sibling module so it can be unit-tested in isolation (see
        // R4 P2 fix in training-completion-v2-hash.ts).
        const v2HashHex = computeV2IdempotencyHashHex({
          rir: typeof rir === 'number' ? rir : null,
          painScore: typeof painScore === 'number' ? painScore : null,
          painLocation: typeof painLocation === 'string' ? painLocation : null,
          technicalSuccessScore: typeof technicalSuccessScore === 'number' ? technicalSuccessScore : null,
          missedReason: typeof missedReason === 'string' ? missedReason : null,
          externalTrainingDeclared: externalTrainingDeclared === true,
          completedDurationSec: typeof completedDurationSec === 'number' ? completedDurationSec : null,
          completedDistanceMeters: typeof completedDistanceMeters === 'number' ? completedDistanceMeters : null,
          completedSetsJson: typeof completedSetsJson === 'string' ? completedSetsJson : null,
          completedRepsJson: typeof completedRepsJson === 'string' ? completedRepsJson : null,
          completedLoadJson: typeof completedLoadJson === 'string' ? completedLoadJson : null,
        });
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'training',
          eventType: 'training.feedback.recorded',
          entityType: 'training_session',
          entityId: rowId,
          payload: {
            summary: {
              status: 'completed',
              hasNotes: Boolean(notes),
              hasRpe: rpe != null,
              v2: v2Summary,
            },
            action: 'updated',
          },
          privacyClassification: 'health',
          idempotencyKey: `training.feedback.recorded:${userId}:${rowId}:completed:${Boolean(notes)}:${rpe ?? 'none'}:v2-${v2HashHex}`,
        });
      });

      const adherenceRate = getTrainingWeeklyAdherenceRate(userId, tenantId, {
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
    const { userId, tenantId } = req as AuthenticatedRequest;
    const { sessionId } = req.body;
    if (!consumeTrainingWriteBudget(res, tenantId, userId, 'training_session_skip')) return;

    try {
      const resolved = resolveTrainingMutationSession(userId, tenantId, sessionId, {
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

      if (resolved.kind === 'bad_input') {
        sendError(res, 'BAD_INPUT', resolved.message, 400);
        return;
      }

      if (resolved.kind === 'not_found') {
        sendError(res, 'NOT_FOUND', 'Training session not found', 404);
        return;
      }

      if (resolved.kind === 'forbidden') {
        sendError(res, 'NOT_FOUND', 'Training session not found', 404);
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

      const adherenceRate = getTrainingWeeklyAdherenceRate(userId, tenantId, {
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
    const { userId, tenantId } = req as AuthenticatedRequest;
    const { recommendationIds } = req.body;
    try {
      const applied = await applyCoachRecommendations(userId, tenantId, recommendationIds);
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
