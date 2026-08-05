// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { getDb } from '../../services/database';
import { runOutboxTransaction } from '../../services/event-outbox';
import { consumeResourceBudget } from '../../services/resource-budgets';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguageById } from '../../services/user-service';
import type { Lang } from '../../utils/i18n';
import { getCached, setCache } from '../../services/cache-store';
import { invalidateTrainingDerivedCaches } from '../../services/cache-coherence-registry';
import { markKeepOriginalForToday } from '../../services/training-keep-original';
import { recordTrainingSummaryDeprecationHit } from '../../services/training-route-deprecation-telemetry';
import * as trainingPlans from '../../services/training-plans';
import { sendAiBudgetError, sendSuccess, sendError, sendInternalError } from '../response-helpers';
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
  normalizeTrainingCompletionFeedback,
  TrainingCompletionContractError,
} from '../../services/training-completion-contract';
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
import {
  registerTrainingPlanRevisionRoutes,
  trainingPlanRevisionCapabilitiesForScope,
} from './training-plan-revision-routes';
import { registerTrainingAdaptationRoutes } from './training-adaptation-routes';
import { requireTenantIdParam } from '../../services/tenant-scope';
import {
  isAiInteractiveAllowedForRuntime,
  isCoachBriefingEntitlementEligible,
  isPaidAiCostControlsEnforcementEnabled,
  type UserEntitlement,
} from '../../services/entitlement';
import {
  trainingOperationLockPublicError,
  withTrainingCalendarOperationLock,
} from '../../services/training-operation-locks';

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

function requireCoachBriefingEligibility(req: AuthenticatedRequest, res: Response): boolean {
  const entitlement = (req as AuthenticatedRequest & {
    entitlement?: UserEntitlement;
  }).entitlement;
  const enforcementEnabled = isPaidAiCostControlsEnforcementEnabled();
  const eligible = entitlement && (enforcementEnabled
    ? isAiInteractiveAllowedForRuntime(entitlement)
    : isCoachBriefingEntitlementEligible(entitlement));
  if (!eligible) {
    sendError(
      res,
      enforcementEnabled ? 'AI_PLAN_REQUIRED' : 'TIER_REQUIRED',
      'A Pro or Max plan is required for coach briefings.',
      403,
      {
        requiredPlan: 'pro',
        currentPlan: entitlement?.plan ?? 'free',
        skill: 'training',
        blockReason: entitlement?.blockReason ?? 'plan_required',
        window: 'plan',
        unblocksAt: null,
        retryable: false,
      },
    );
    return false;
  }

  let tenantId: number;
  try {
    tenantId = requireTenantIdParam(req.tenantId, 'training.coach.eligibility');
  } catch {
    sendError(res, 'TENANT_SCOPE_REQUIRED', 'Coach briefing requires a validated tenant scope.', 400);
    return false;
  }

  try {
    if (!trainingPlans.getActivePlan(req.userId, tenantId)) {
      sendError(
        res,
        'ACTIVE_TRAINING_PLAN_REQUIRED',
        'An active workout plan is required for coach briefings.',
        409,
      );
      return false;
    }
  } catch (err) {
    logger.warn({ err, userId: req.userId, tenantId }, 'Coach briefing eligibility check failed');
    sendError(res, 'COACH_ELIGIBILITY_UNAVAILABLE', 'Coach briefing eligibility is temporarily unavailable.', 503);
    return false;
  }

  return true;
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
    getReadiness(userId, tenantId),
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

function parsePersistedStringArray(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function persistedBoolean(value: unknown): boolean {
  return value === true || value === 1;
}

/**
 * Additive server readback for the released iOS feedback sheet. Build it
 * from the committed row, rather than echoing request input, so aliases and
 * defaults reflect the canonical durable state.
 */
function serializeTrainingCompletionFeedback(
  row: Partial<ReturnType<typeof trainingPlans.logCompletion>> | null,
): Record<string, unknown> | null {
  if (!row) return null;
  const completionState = row.completion_state ?? 'completed';
  const actualDurationMinutes = typeof row.completed_duration_sec === 'number'
    ? row.completed_duration_sec / 60
    : typeof row.duration_minutes === 'number'
      ? row.duration_minutes
      : null;

  return {
    sessionId: row.session_id == null ? null : String(row.session_id),
    completionState,
    status: completionState,
    actualDurationMinutes,
    rpe: row.rpe_overall ?? null,
    energyLevel: row.energy_level ?? null,
    sorenessLevel: row.soreness_level ?? null,
    notes: row.notes ?? null,
    readinessLevel: row.readiness_level ?? null,
    difficulty: row.difficulty_feedback ?? null,
    difficultyFeedback: row.difficulty_feedback ?? null,
    durationFeedback: row.duration_feedback ?? null,
    discomfortFlag: persistedBoolean(row.discomfort_flag),
    discomfortFlags: parsePersistedStringArray(row.discomfort_flags_json),
    discomfortLocations: parsePersistedStringArray(row.discomfort_locations_json),
    discomfortDetails: row.discomfort_details ?? null,
    substitutionsUsed: parsePersistedStringArray(row.substitutions_used_json),
    skippedReason: row.missed_reason ?? null,
    feltTooHard: persistedBoolean(row.felt_too_hard),
    feltTooEasy: persistedBoolean(row.felt_too_easy),
    feltTooLong: persistedBoolean(row.felt_too_long),
    feltTooShort: persistedBoolean(row.felt_too_short),
    modality: row.modality ?? null,
    sessionRole: row.session_role ?? null,
    completedDistanceMeters: row.completed_distance_meters ?? null,
    rir: row.rir ?? null,
    painScore: row.pain_score ?? null,
    painLocation: row.pain_location ?? null,
    technicalSuccessScore: row.technical_success_score ?? null,
    externalTrainingDeclared: persistedBoolean(row.external_training_declared),
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
      const revisionCapabilities = trainingPlanRevisionCapabilitiesForScope({ userId, tenantId });
      sendSuccess(res, {
        ...(cached as Record<string, unknown>),
        ...(revisionCapabilities ? { revisionCapabilities } : {}),
      }, { cached: true });
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
      const revisionCapabilities = trainingPlanRevisionCapabilitiesForScope({ userId, tenantId });
      sendSuccess(res, {
        ...payload,
        ...(revisionCapabilities ? { revisionCapabilities } : {}),
      });
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

    // F37: keep the compatibility endpoint operational while measuring its
    // deprecation window. The date is an earliest review point, not removal
    // authority: two supported client releases and operator telemetry review
    // are still required before this route can be deleted.
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'Fri, 02 Oct 2026 00:00:00 GMT');
    res.setHeader('Link', '</api/v1/training/home>; rel="successor-version"');
    try {
      recordTrainingSummaryDeprecationHit(getDb());
    } catch (err) {
      // Telemetry must never make the compatibility read unavailable.
      logger.warn({ err }, 'Training summary deprecation telemetry recording failed');
    }

    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    // Parallel fetch — NEVER sequential
    const [todayResult, weekResult, readinessResult] = await Promise.allSettled([
      getTodaySession(userId, tenantId),
      getWeekPlan(userId, tenantId),
      getReadiness(userId, tenantId),
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
    const { userId, tenantId } = req as AuthenticatedRequest;
    try {
      const readiness = await getReadiness(userId, tenantId);
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
    let dataUserId: number;
    try {
      dataUserId = requireTenantIdParam(tenantId, 'training.coach');
    } catch {
      sendError(res, 'TENANT_SCOPE_REQUIRED', 'Coach briefing requires a validated tenant scope.', 400);
      return;
    }
    // Eligibility is request state, while the briefing cache can outlive an
    // entitlement or active-plan change. Revalidate before reading any cache
    // or restored report so a stale paid snapshot cannot bypass a downgrade.
    if (!requireCoachBriefingEligibility(req as AuthenticatedRequest, res)) return;

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

    try {
      const briefing = await generateCoachBriefing(dataUserId, {
        tenantId: dataUserId,
        meteringUserId: userId,
        budgetRequestSource: 'interactive',
        budgetJobName: 'coach_refresh',
      });

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
      if (sendAiBudgetError(res, err)) return;
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
    // The report endpoint shares the briefing cache/restore path, so it must
    // enforce the same current-request eligibility before either read.
    if (!requireCoachBriefingEligibility(req as AuthenticatedRequest, res)) return;

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

    try {
      const briefing = await generateCoachBriefing(dataUserId, {
        tenantId: dataUserId,
        meteringUserId: userId,
        budgetRequestSource: 'interactive',
        budgetJobName: 'coach_report',
      });
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
      if (sendAiBudgetError(res, err)) return;
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
    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    let completionFeedback: ReturnType<typeof normalizeTrainingCompletionFeedback>;
    try {
      completionFeedback = normalizeTrainingCompletionFeedback(requestBody, 'completed');
    } catch (err) {
      if (err instanceof TrainingCompletionContractError) {
        sendError(res, err.code, err.message, err.statusCode);
        return;
      }
      throw err;
    }
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
      actualDurationMinutes,
      energyLevel,
      sorenessLevel,
      fatigueLevel,
    } = requestBody;
    // R4 P2 fix — stricter V2 field validation. Codex caught that
    // R3's `typeof v === 'number'` accepted NaN and Infinity, and
    // the event hash only fingerprinted field presence (so
    // `{ painScore: 1, rir: 2 }` and `{ painScore: 9, rir: 0 }`
    // collided to the same outbox key). This pass requires
    // Number.isFinite + per-field ranges and switches the event
    // hash to a canonical *value* hash.
    const completionInputErrors: string[] = [];
    const checkNumberInRange = (
      name: string,
      v: unknown,
      min: number,
      max: number,
    ): void => {
      if (v === undefined || v === null) return;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        completionInputErrors.push(`${name} must be a finite number`);
        return;
      }
      if (v < min || v > max) {
        completionInputErrors.push(`${name} must be between ${min} and ${max} (got ${v})`);
      }
    };
    const checkString = (name: string, v: unknown, maxLen = 1024): void => {
      if (v === undefined || v === null) return;
      if (typeof v !== 'string') {
        completionInputErrors.push(`${name} must be a string`);
        return;
      }
      if (v.length > maxLen) {
        completionInputErrors.push(`${name} must be ≤ ${maxLen} characters`);
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
        completionInputErrors.push(`${name} must be a boolean`);
      }
    };
    // Per-field ranges per A0c semantics (RPE/RIR scales, plausible
    // distances/durations). Out-of-range payloads are bugs, not data.
    if (rpe === null) completionInputErrors.push('rpe must be a finite number');
    else checkNumberInRange('rpe', rpe, 0, 10);
    if (notes === null) completionInputErrors.push('notes must be a string');
    else checkString('notes', notes, 1024);
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
    checkNumberInRange('actualDurationMinutes', actualDurationMinutes, 0, 24 * 60);
    checkNumberInRange('energyLevel', energyLevel, 0, 10);
    checkNumberInRange('sorenessLevel', sorenessLevel, 0, 10);
    checkNumberInRange('fatigueLevel', fatigueLevel, 0, 10);
    if (completionInputErrors.length > 0) {
      sendError(res, 'BAD_INPUT', `Invalid completion feedback: ${completionInputErrors.join('; ')}`, 400);
      return;
    }

    // rerun-6 S12: the iOS feedback sheet collects "Fatigue" and
    // "Soreness", so it sends `fatigueLevel` + `sorenessLevel` but no
    // `energyLevel`. The `training_completions` table has an
    // `energy_level` column and no fatigue column, so energy_level
    // landed NULL while soreness_level was set — an inconsistent row.
    // Energy and fatigue are the standard complementary 0-10
    // self-report pair, so derive energy from the rated fatigue
    // (high fatigue => low energy). An explicit `energyLevel` still
    // wins; with neither field the column stays NULL (honest).
    const normalizedEnergyLevel =
      typeof energyLevel === 'number'
        ? energyLevel
        : typeof fatigueLevel === 'number'
          ? 10 - fatigueLevel
          : undefined;

    // rerun-5 S12: the iOS feedback sheet sends the user-confirmed
    // duration as `actualDurationMinutes` (and wellbeing as
    // `energyLevel`/`sorenessLevel`). This route only read the V2
    // `completedDurationSec`, so every iOS completion persisted with a
    // NULL duration — the cardio progression aggregation then skipped
    // the row ("No running logged") while weekly activity and history
    // counted it. Normalize the minutes alias into the V2 seconds
    // column here; an explicit completedDurationSec still wins.
    const normalizedCompletedDurationSec =
      typeof completedDurationSec === 'number'
        ? completedDurationSec
        : typeof actualDurationMinutes === 'number'
          ? actualDurationMinutes * 60
          : undefined;

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
          completed: completionFeedback.completionState === 'completed',
          skipped: completionFeedback.completionState === 'skipped',
          completionState: completionFeedback.completionState,
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
        normalizedCompletedDurationSec != null || completedDistanceMeters != null ||
        completedSetsJson != null || completedRepsJson != null ||
        completedLoadJson != null ||
        normalizedEnergyLevel != null || sorenessLevel != null || fatigueLevel != null ||
        completionFeedback.stateWasExplicit || completionFeedback.hasRichFeedback
      );

      const writeCompletion = () => {
        if (notes || rpe != null || hasV2Field) {
          return trainingPlans.logCompletion({
            session_id: rowId,
            plan_id: session.plan_id,
            rpe_overall: typeof rpe === 'number' ? rpe : undefined,
            notes: typeof notes === 'string' ? notes : undefined,
            rir: typeof rir === 'number' ? rir : undefined,
            pain_score: typeof painScore === 'number' ? painScore : undefined,
            pain_location: typeof painLocation === 'string' ? painLocation : undefined,
            technical_success_score: typeof technicalSuccessScore === 'number' ? technicalSuccessScore : undefined,
            missed_reason: completionFeedback.missedReason ?? undefined,
            external_training_declared: externalTrainingDeclared === true,
            energy_level: typeof normalizedEnergyLevel === 'number' ? normalizedEnergyLevel : undefined,
            soreness_level: typeof sorenessLevel === 'number' ? sorenessLevel : undefined,
            completed_duration_sec: typeof normalizedCompletedDurationSec === 'number' ? normalizedCompletedDurationSec : undefined,
            completed_distance_meters: typeof completedDistanceMeters === 'number' ? completedDistanceMeters : undefined,
            completed_sets_json: typeof completedSetsJson === 'string' ? completedSetsJson : undefined,
            completed_reps_json: typeof completedRepsJson === 'string' ? completedRepsJson : undefined,
            completed_load_json: typeof completedLoadJson === 'string' ? completedLoadJson : undefined,
            completion_state: completionFeedback.completionState,
            readiness_level: completionFeedback.readinessLevel ?? undefined,
            difficulty_feedback: completionFeedback.difficultyFeedback ?? undefined,
            duration_feedback: completionFeedback.durationFeedback ?? undefined,
            discomfort_flag: completionFeedback.discomfortFlag,
            discomfort_flags_json: JSON.stringify(completionFeedback.discomfortFlags),
            discomfort_locations_json: JSON.stringify(completionFeedback.discomfortLocations),
            discomfort_details: completionFeedback.discomfortDetails ?? undefined,
            substitutions_used_json: JSON.stringify(completionFeedback.substitutionsUsed),
            felt_too_hard: completionFeedback.feltTooHard,
            felt_too_easy: completionFeedback.feltTooEasy,
            felt_too_long: completionFeedback.feltTooLong,
            felt_too_short: completionFeedback.feltTooShort,
            modality: completionFeedback.modality ?? undefined,
            session_role: completionFeedback.sessionRole ?? undefined,
          });
        }
        // Preserve the released lightweight call: only an absent state and no
        // feedback skips creation of a completion detail row.
        if (!trainingPlans.markSessionCompleted(rowId)) {
          throw new Error(`TRAINING_COMPLETION_SESSION_STATE_WRITE_FAILED:${rowId}`);
        }
        return null;
      };
      const persistedCompletion = runOutboxTransaction((emitDomainEvent) => {
        const completionRow = writeCompletion();
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
          hasMissedReason: completionFeedback.missedReason !== null,
          externalTrainingDeclared: externalTrainingDeclared === true,
          hasCompletedDurationSec: normalizedCompletedDurationSec != null,
          hasCompletedDistanceMeters: completedDistanceMeters != null,
          hasCompletedSetsJson: typeof completedSetsJson === 'string' && completedSetsJson.length > 0,
          hasCompletedRepsJson: typeof completedRepsJson === 'string' && completedRepsJson.length > 0,
          hasCompletedLoadJson: typeof completedLoadJson === 'string' && completedLoadJson.length > 0,
          hasEnergyLevel: normalizedEnergyLevel != null,
          hasSorenessLevel: sorenessLevel != null,
        };
        // Hash *values*, not just presence. Helper is exported from a
        // sibling module so it can be unit-tested in isolation (see
        // R4 P2 fix in training-completion-v2-hash.ts).
        const v2HashHex = computeV2IdempotencyHashHex({
          notes: typeof notes === 'string' ? notes : null,
          rpe: typeof rpe === 'number' ? rpe : null,
          rir: typeof rir === 'number' ? rir : null,
          painScore: typeof painScore === 'number' ? painScore : null,
          painLocation: typeof painLocation === 'string' ? painLocation : null,
          technicalSuccessScore: typeof technicalSuccessScore === 'number' ? technicalSuccessScore : null,
          missedReason: completionFeedback.missedReason,
          externalTrainingDeclared: externalTrainingDeclared === true,
          completedDurationSec: typeof normalizedCompletedDurationSec === 'number' ? normalizedCompletedDurationSec : null,
          completedDistanceMeters: typeof completedDistanceMeters === 'number' ? completedDistanceMeters : null,
          completedSetsJson: typeof completedSetsJson === 'string' ? completedSetsJson : null,
          completedRepsJson: typeof completedRepsJson === 'string' ? completedRepsJson : null,
          completedLoadJson: typeof completedLoadJson === 'string' ? completedLoadJson : null,
          energyLevel: typeof normalizedEnergyLevel === 'number' ? normalizedEnergyLevel : null,
          sorenessLevel: typeof sorenessLevel === 'number' ? sorenessLevel : null,
          completionState: completionFeedback.completionState,
          readinessLevel: completionFeedback.readinessLevel,
          difficultyFeedback: completionFeedback.difficultyFeedback,
          durationFeedback: completionFeedback.durationFeedback,
          discomfortFlag: completionFeedback.discomfortFlag,
          discomfortFlagsJson: JSON.stringify(completionFeedback.discomfortFlags),
          discomfortLocationsJson: JSON.stringify(completionFeedback.discomfortLocations),
          discomfortDetails: completionFeedback.discomfortDetails,
          substitutionsUsedJson: JSON.stringify(completionFeedback.substitutionsUsed),
          feltTooHard: completionFeedback.feltTooHard,
          feltTooEasy: completionFeedback.feltTooEasy,
          feltTooLong: completionFeedback.feltTooLong,
          feltTooShort: completionFeedback.feltTooShort,
          modality: completionFeedback.modality,
          sessionRole: completionFeedback.sessionRole,
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
              status: completionFeedback.completionState,
              hasNotes: Boolean(notes),
              hasRpe: rpe != null,
              v2: v2Summary,
            },
            action: 'updated',
          },
          privacyClassification: 'health',
          idempotencyKey: `training.feedback.recorded:${userId}:${rowId}:${completionFeedback.completionState}:v2-${v2HashHex}`,
        });
        return completionRow;
      });

      const adherenceRate = getTrainingWeeklyAdherenceRate(userId, tenantId, {
        getActivePlan: trainingPlans.getActivePlan,
        getCurrentWeek: trainingPlans.getCurrentWeek,
        getWeeklyAdherence: trainingPlans.getWeeklyAdherence,
      });

      // Invalidate caches since training status changed
      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, {
        completed: completionFeedback.completionState === 'completed',
        skipped: completionFeedback.completionState === 'skipped',
        completionState: completionFeedback.completionState,
        completionId: persistedCompletion?.id ?? null,
        feedback: serializeTrainingCompletionFeedback(persistedCompletion),
        weeklyAdherence: adherenceRate,
      });
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
    const requestBody = (req.body ?? {}) as Record<string, unknown>;
    let completionFeedback: ReturnType<typeof normalizeTrainingCompletionFeedback>;
    try {
      completionFeedback = normalizeTrainingCompletionFeedback(requestBody, 'skipped');
    } catch (err) {
      if (err instanceof TrainingCompletionContractError) {
        sendError(res, err.code, err.message, err.statusCode);
        return;
      }
      throw err;
    }
    const {
      sessionId,
      notes,
      rpe,
      rir,
      painScore,
      painLocation,
      technicalSuccessScore,
      externalTrainingDeclared,
      completedDurationSec,
      completedDistanceMeters,
      completedSetsJson,
      completedRepsJson,
      completedLoadJson,
      actualDurationMinutes,
      energyLevel,
      fatigueLevel,
      sorenessLevel,
    } = requestBody;
    const skipInputErrors: string[] = [];
    const validateNumber = (field: string, value: unknown, min: number, max: number) => {
      if (value === undefined) return;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        skipInputErrors.push(`${field} must be a finite number between ${min} and ${max}`);
      }
    };
    const validateString = (field: string, value: unknown, max: number) => {
      if (value === undefined) return;
      if (typeof value !== 'string' || value.length > max) {
        skipInputErrors.push(`${field} must be a string of at most ${max} characters`);
      }
    };
    validateNumber('rpe', rpe, 0, 10);
    validateNumber('rir', rir, 0, 10);
    validateNumber('painScore', painScore, 0, 10);
    validateNumber('technicalSuccessScore', technicalSuccessScore, 0, 10);
    validateNumber('completedDurationSec', completedDurationSec, 0, 24 * 3600);
    validateNumber('completedDistanceMeters', completedDistanceMeters, 0, 500_000);
    validateNumber('actualDurationMinutes', actualDurationMinutes, 0, 24 * 60);
    validateNumber('energyLevel', energyLevel, 0, 10);
    validateNumber('fatigueLevel', fatigueLevel, 0, 10);
    validateNumber('sorenessLevel', sorenessLevel, 0, 10);
    validateString('notes', notes, 1024);
    validateString('painLocation', painLocation, 256);
    validateString('completedSetsJson', completedSetsJson, 8 * 1024);
    validateString('completedRepsJson', completedRepsJson, 8 * 1024);
    validateString('completedLoadJson', completedLoadJson, 8 * 1024);
    if (externalTrainingDeclared !== undefined && typeof externalTrainingDeclared !== 'boolean') {
      skipInputErrors.push('externalTrainingDeclared must be a boolean');
    }
    if (skipInputErrors.length > 0) {
      sendError(res, 'BAD_INPUT', `Invalid skip feedback: ${skipInputErrors.join('; ')}`, 400);
      return;
    }
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
          completionState: 'skipped',
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

      const normalizedEnergyLevel = typeof energyLevel === 'number'
        ? energyLevel
        : typeof fatigueLevel === 'number'
          ? 10 - fatigueLevel
          : undefined;
      const normalizedCompletedDurationSec = typeof completedDurationSec === 'number'
        ? completedDurationSec
        : typeof actualDurationMinutes === 'number'
          ? actualDurationMinutes * 60
          : undefined;

      const writeSkip = () => {
        return trainingPlans.logCompletion({
          session_id: rowId,
          plan_id: session.plan_id,
          completion_state: 'skipped',
          notes: typeof notes === 'string' ? notes : undefined,
          rpe_overall: typeof rpe === 'number' ? rpe : undefined,
          rir: typeof rir === 'number' ? rir : undefined,
          pain_score: typeof painScore === 'number' ? painScore : undefined,
          pain_location: typeof painLocation === 'string' ? painLocation : undefined,
          technical_success_score: typeof technicalSuccessScore === 'number' ? technicalSuccessScore : undefined,
          missed_reason: completionFeedback.missedReason ?? undefined,
          external_training_declared: externalTrainingDeclared === true,
          completed_duration_sec: normalizedCompletedDurationSec,
          completed_distance_meters: typeof completedDistanceMeters === 'number' ? completedDistanceMeters : undefined,
          completed_sets_json: typeof completedSetsJson === 'string' ? completedSetsJson : undefined,
          completed_reps_json: typeof completedRepsJson === 'string' ? completedRepsJson : undefined,
          completed_load_json: typeof completedLoadJson === 'string' ? completedLoadJson : undefined,
          energy_level: normalizedEnergyLevel,
          soreness_level: typeof sorenessLevel === 'number' ? sorenessLevel : undefined,
          readiness_level: completionFeedback.readinessLevel ?? undefined,
          difficulty_feedback: completionFeedback.difficultyFeedback ?? undefined,
          duration_feedback: completionFeedback.durationFeedback ?? undefined,
          discomfort_flag: completionFeedback.discomfortFlag,
          discomfort_flags_json: JSON.stringify(completionFeedback.discomfortFlags),
          discomfort_locations_json: JSON.stringify(completionFeedback.discomfortLocations),
          discomfort_details: completionFeedback.discomfortDetails ?? undefined,
          substitutions_used_json: JSON.stringify(completionFeedback.substitutionsUsed),
          felt_too_hard: completionFeedback.feltTooHard,
          felt_too_easy: completionFeedback.feltTooEasy,
          felt_too_long: completionFeedback.feltTooLong,
          felt_too_short: completionFeedback.feltTooShort,
          modality: completionFeedback.modality ?? undefined,
          session_role: completionFeedback.sessionRole ?? undefined,
        });
      };
      const persistedCompletion = runOutboxTransaction((emitDomainEvent) => {
        const completionRow = writeSkip();
        const feedbackHash = computeV2IdempotencyHashHex({
          notes: typeof notes === 'string' ? notes : null,
          rpe: typeof rpe === 'number' ? rpe : null,
          rir: typeof rir === 'number' ? rir : null,
          painScore: typeof painScore === 'number' ? painScore : null,
          painLocation: typeof painLocation === 'string' ? painLocation : null,
          technicalSuccessScore: typeof technicalSuccessScore === 'number' ? technicalSuccessScore : null,
          missedReason: completionFeedback.missedReason,
          externalTrainingDeclared: externalTrainingDeclared === true,
          completedDurationSec: normalizedCompletedDurationSec ?? null,
          completedDistanceMeters: typeof completedDistanceMeters === 'number' ? completedDistanceMeters : null,
          completedSetsJson: typeof completedSetsJson === 'string' ? completedSetsJson : null,
          completedRepsJson: typeof completedRepsJson === 'string' ? completedRepsJson : null,
          completedLoadJson: typeof completedLoadJson === 'string' ? completedLoadJson : null,
          energyLevel: normalizedEnergyLevel ?? null,
          sorenessLevel: typeof sorenessLevel === 'number' ? sorenessLevel : null,
          completionState: 'skipped',
          readinessLevel: completionFeedback.readinessLevel,
          difficultyFeedback: completionFeedback.difficultyFeedback,
          durationFeedback: completionFeedback.durationFeedback,
          discomfortFlag: completionFeedback.discomfortFlag,
          discomfortFlagsJson: JSON.stringify(completionFeedback.discomfortFlags),
          discomfortLocationsJson: JSON.stringify(completionFeedback.discomfortLocations),
          discomfortDetails: completionFeedback.discomfortDetails,
          substitutionsUsedJson: JSON.stringify(completionFeedback.substitutionsUsed),
          feltTooHard: completionFeedback.feltTooHard,
          feltTooEasy: completionFeedback.feltTooEasy,
          feltTooLong: completionFeedback.feltTooLong,
          feltTooShort: completionFeedback.feltTooShort,
          modality: completionFeedback.modality,
          sessionRole: completionFeedback.sessionRole,
        });
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'training',
          eventType: 'training.session.updated',
          entityType: 'training_session',
          entityId: rowId,
          payload: {
            summary: {
              status: 'skipped',
              hasSkippedReason: completionFeedback.missedReason !== null,
              hasDiscomfort: completionFeedback.discomfortFlag,
              hasReadiness: completionFeedback.readinessLevel !== null,
            },
            action: 'updated',
          },
          privacyClassification: 'health',
          idempotencyKey: `training.session.updated:${userId}:${rowId}:skipped:v2-${feedbackHash}`,
        });
        return completionRow;
      });

      const adherenceRate = getTrainingWeeklyAdherenceRate(userId, tenantId, {
        getActivePlan: trainingPlans.getActivePlan,
        getCurrentWeek: trainingPlans.getCurrentWeek,
        getWeeklyAdherence: trainingPlans.getWeeklyAdherence,
      });

      invalidateTrainingScreenCaches(userId);

      sendSuccess(res, {
        skipped: true,
        completionState: 'skipped',
        completionId: persistedCompletion?.id ?? null,
        feedback: serializeTrainingCompletionFeedback(persistedCompletion),
        weeklyAdherence: adherenceRate,
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/skip failed');
      sendInternalError(res, 'Failed to skip session');
    }
  });

  /**
   * POST /api/v1/training/today/keep-original
   *
   * Training redesign Phase 0 — per-day adaptation opt-out. Persists a
   * (userId, local date) flag so both adaptation read paths (the today
   * read model and the Home kernel context) render today's prescription
   * exactly as written, clearing the swap banner. Idempotent: a second
   * call on the same local day refreshes the flag and still succeeds.
   */
  router.post('/today/keep-original', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!consumeTrainingWriteBudget(res, tenantId, userId, 'training_keep_original')) return;

    try {
      markKeepOriginalForToday(userId);
      // The Today/Home read models cache adapted prescriptions — clear
      // them so the next read reflects the opt-out immediately.
      invalidateTrainingScreenCaches(userId);
      sendSuccess(res, { kept: true });
    } catch (err: any) {
      logger.error({ err }, 'iOS training/today/keep-original failed');
      sendInternalError(res, 'Failed to keep original session');
    }
  });

  /** POST /api/v1/training/coach/apply */
  router.post('/coach/apply', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const { recommendationIds } = req.body;
    try {
      // Coach state, Training rows, provider credentials, and the operation
      // lock all belong to the active data owner. The authenticated actor is
      // passed separately for authorization/audit semantics.
      const dataUserId = requireTenantIdParam(tenantId, 'training.coach.apply');
      const applied = await withTrainingCalendarOperationLock(
        { userId: dataUserId, tenantId: dataUserId, operation: 'coach_apply' },
        (lease) => applyCoachRecommendations(userId, dataUserId, recommendationIds, { lease }),
      );
      // Applying a coach recommendation changes the coach briefing and
      // training summary the client just read — clear those caches too,
      // otherwise the next read serves the pre-apply brief and the user
      // sees the same recommendation they just accepted. Mirrors the
      // cache-clear set used by /training/complete above.
      invalidateTrainingScreenCaches(dataUserId);
      sendSuccess(res, {
        applied: applied?.count || 0,
        message: `Calendar updated with ${applied?.count || 0} recommendation(s).`,
        appliedRecommendations: applied?.appliedRecommendations || [],
      });
    } catch (err: any) {
      if (sendCoachApplyRouteError(res, err)) return;
      logger.error({ err }, 'iOS training/coach/apply failed');
      sendInternalError(res, 'Failed to apply coach recommendations', {
        code: 'COACH_APPLY_FAILED',
        status: 503,
      });
    }
  });

  registerTrainingAnalyticsRoutes(router, resolveTrainingLanguage);
  registerTrainingPlanRoutes(router, { invalidateTrainingScreenCaches });
  registerTrainingPlanRevisionRoutes(router);
  registerTrainingAdaptationRoutes(router);

  return router;
}

function sendCoachApplyRouteError(res: Response, error: unknown): boolean {
  const lockError = trainingOperationLockPublicError(error);
  if (lockError) {
    logger.warn(
      { code: lockError.code, operation: lockError.operation },
      'Coach apply deferred by the shared Training operation lock',
    );
    sendError(res, lockError.code, lockError.message, lockError.status, lockError.details);
    return true;
  }

  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'COACH_APPLY_PARTIAL_FAILURE') {
    sendError(
      res,
      'COACH_APPLY_PARTIAL_FAILURE',
      'Calendar changed, but Training could not confirm the matching update. Refresh before retrying.',
      409,
      {
        providerMutationApplied: true,
        localSyncConfirmed: false,
        retryable: false,
      },
    );
    return true;
  }
  if (code === 'COACH_RECOMMENDATION_STALE') {
    sendError(
      res,
      'COACH_RECOMMENDATION_STALE',
      'This coach recommendation is stale. Refresh the coach briefing before retrying.',
      409,
      { retryable: false },
    );
    return true;
  }
  return false;
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
