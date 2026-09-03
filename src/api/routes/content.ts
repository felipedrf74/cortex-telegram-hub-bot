// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { Router, Request, Response, type NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendAiBudgetError, sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { buildScreenContractMeta } from '../../services/screen-contract-meta';
import { buildGenerationMeta } from './content-generation-meta';
import {
  buildSignalSummary,
  buildSignalTitle,
  readContentHomeIdeas,
  readContentHomePipeline,
} from './content-home-route-utils';
import { registerContentIntelligenceRoutes } from './content-intelligence-routes';
import { registerContentEditorialRoutes } from './content-editorial-routes';
import { registerContentLearningRoutes } from './content-learning-routes';
import { registerContentNotificationRoutes } from './content-notification-routes';
import { registerContentPipelineRoutes } from './content-pipeline-routes';
import { registerContentReferenceRoutes } from './content-reference-routes';
import { registerContentScriptRoutes } from './content-script-routes';
import { registerContentScriptJobRoutes } from './content-script-job-routes';
import { registerContentTopicRoutes } from './content-topic-routes';
import { registerContentCreatorProfileRoutes } from './content-creator-profile-routes';
import { registerContentAgencyRoutes } from './content-agency-routes';
import { registerContentWorkspaceRoutes } from './content-workspace-routes';
import { registerContentAgentJobRoutes } from './content-agent-job-routes';
import { registerContentWorkspaceScheduleRoutes } from './content-workspace-schedule-routes';
import { registerContentWorkspaceDecisionRoutes } from './content-workspace-decision-routes';
import { registerContentCreativeRoutes } from './content-creative-routes';
import {
  ContentFilmingRecommendationUnavailableError,
  getFilmingRecommendation,
  getTopics,
  type ContentFilmingRecommendation,
} from '../../services/content-scheduler';
import {
  getActiveContentPillars,
  getContentDeskItems,
  localizeFilmingRecommendation,
} from '../../services/content-intelligence';
import {
  buildRadarTopicSummaries,
  filterSignalsForRadarPreferences,
  getContentRadarPreferences,
  type ContentRadarPreferences,
} from '../../services/content-radar-preferences';
import { getDb } from '../../services/database';
import { getKnowledgeStats, getVoiceDna } from '../../services/content-dashboard-service';
import {
  CONTENT_AGENT_LIFECYCLE_POLICY_VERSION,
  PAUSED_CONTENT_AGENT_IDS,
  isActiveContentAgentSignal,
} from '../../services/content-agent-lifecycle';
import { getContentWorkspaceSummaryCounts } from '../../services/content-workspace-read-models';
import { readSignals } from '../../services/intelligence-bus';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguageById, getUserTimezoneById } from '../../services/user-service';
import type { Lang } from '../../utils/i18n';
import { buildContentHomeViewState } from '../../services/content-home-view-state';
import { captureDiscoveredIdea } from '../../services/content-workspace-capture';
import { invalidateContentDerivedCaches } from '../../services/cache-coherence-registry';
import { sendConditionalApiSuccess } from '../conditional-cache';
import { ensureCachedRouteTenantScope, handleCachedRoute, routeCacheKey } from '../route-helpers/cached-route-handler';
import {
  classifyContentWorkspaceWriteSlice,
  resolveContentWorkspaceCapabilities,
} from '../../services/content-workspace-capabilities';
import { recordContentWorkspaceOperationalOutcome } from '../../services/content-workspace-observability';
import { isProviderRequestCancellation } from '../../services/ai-provider';
import { bindContentRequestCancellation } from './content-request-cancellation';

const CONTENT_HOME_TTL_SECONDS = 120;
const CONTENT_HOME_SWR_STALE_SECONDS = 600;

export function contentRoutes(): Router {
  const router = Router();

  function ensureValidContentRouteScope(
    res: Response,
    userId: number | undefined,
    operation: string,
    details?: Record<string, unknown>,
  ): userId is number {
    return ensureCachedRouteTenantScope(res, userId, operation, details);
  }

  registerContentPipelineRoutes(router, ensureValidContentRouteScope);

  /** Server-authoritative rollout/readiness contract. Always available to an authenticated owner. */
  router.get('/workspace/capabilities', (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_workspace_capabilities')) return;
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || tenantId !== userId) {
      sendError(res, 'CONTENT_TENANT_SCOPE_MISMATCH', 'Content workspace requires the authenticated private owner scope.', 403);
      return;
    }
    sendSuccess(res, resolveContentWorkspaceCapabilities({ userId, tenantId }));
  });
  // Apply to every subsequent Content route. The classifier ignores reads and
  // unrelated mutations, but also recognizes compatibility/editorial paths
  // that write the canonical workspace so they cannot bypass the rollout
  // authority simply because their public URL predates `/workspace`.
  router.use(enforceContentWorkspaceWriteCapability);

  registerContentWorkspaceRoutes(router, ensureValidContentRouteScope);
  registerContentAgentJobRoutes(router, ensureValidContentRouteScope);
  registerContentWorkspaceScheduleRoutes(router, ensureValidContentRouteScope);
  registerContentWorkspaceDecisionRoutes(router, ensureValidContentRouteScope);
  registerContentEditorialRoutes(router, ensureValidContentRouteScope);
  registerContentNotificationRoutes(router, ensureValidContentRouteScope);
  registerContentTopicRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);

  /** GET /api/v1/content/home — render-ready landing view state for iOS */
  router.get('/home', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_home')) return;

    const language = resolveContentLanguage(req, userId);
    const timezone = getUserTimezoneById(userId);
    const cacheKey = contentHomeCacheKey(userId, tenantId, language, timezone);

    await handleCachedRoute<Awaited<ReturnType<typeof buildContentHomePayload>>>({
      cacheKey,
      ttlSeconds: CONTENT_HOME_TTL_SECONDS,
      staleSeconds: CONTENT_HOME_SWR_STALE_SECONDS,
      refreshContext: { source: 'content_route', operation: 'content_home_swr_refresh', userId },
      fetchFresh: () => buildContentHomePayload(userId, tenantId, language, timezone),
      send: (payload, meta) => {
        sendConditionalApiSuccess(res, req, payload, {
          cached: meta.cached,
          maxAgeSeconds: CONTENT_HOME_TTL_SECONDS,
        });
      },
    });
  }));

  /** POST /api/v1/content/discover — trigger content discovery */
  router.post('/discover', async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_discover')) return;
    const discoveryBody = req.body === undefined
      ? {}
      : req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : null;
    if (!discoveryBody) {
      sendError(res, 'CONTENT_VALIDATION_FAILED', 'Request body must be an object.', 400, { field: 'body' });
      return;
    }
    const requestedTopic = readOptionalDiscoveryTopic(discoveryBody.topic);
    if (requestedTopic && 'error' in requestedTopic) {
      sendError(res, 'CONTENT_VALIDATION_FAILED', requestedTopic.error, 400, { field: 'topic' });
      return;
    }

    const startMs = Date.now();
    const requestCancellation = bindContentRequestCancellation(req, res, 'content_discovery');
    try {
      const { runContentDiscovery } = await import('../../services/content-discovery');
      const result = await runContentDiscovery({
        userId,
        tenantId,
        abortSignal: requestCancellation.signal,
      });
      if (requestCancellation.signal.aborted) return;
      const ideas = normalizeDiscoveredIdeasForResponse(result?.ideas || [], startMs);
      sendSuccess(res, {
        discovered: ideas.length,
        ideas,
        message: `Confirmed ${ideas.length} content ideas in the workspace.`,
        persistence: result.persistence ?? {
          status: 'complete',
          confirmedCount: ideas.length,
          createdCount: ideas.length,
          replayedCount: 0,
          duplicateCount: 0,
        },
        generation: buildGenerationMeta({
          mode: 'standard',
          startMs,
          provider: result?.provider || 'provider-routed',
          providerSemantics: 'resolved_provider',
          researchUsed: true,
        }),
      });
    } catch (err: any) {
      if (requestCancellation.signal.aborted || isProviderRequestCancellation(err)) return;
      logger.error({ errorName: safeContentRouteErrorName(err) }, 'iOS content/discover failed');

      if (err?.code === 'CONTENT_DISCOVERY_PERSISTENCE_UNAVAILABLE') {
        sendError(
          res,
          'CONTENT_DISCOVERY_PERSISTENCE_UNAVAILABLE',
          'Content discovery could not confirm every workspace save. Retry to reconcile the result.',
          503,
          {
            retryable: true,
            confirmedBeforeFailure: Number(err?.details?.confirmedBeforeFailure ?? 0),
          },
        );
        return;
      }
      if (err?.code === 'CONTENT_CREATOR_PROFILE_UNAVAILABLE') {
        sendError(
          res,
          'CONTENT_CREATOR_PROFILE_UNAVAILABLE',
          'The creator profile is temporarily unavailable. No discovery was started.',
          503,
          { retryable: true },
        );
        return;
      }
      if (err?.code === 'CONTENT_DEDUP_UNAVAILABLE') {
        sendError(
          res,
          'CONTENT_DEDUP_UNAVAILABLE',
          'Content duplicate detection is temporarily unavailable. No discovery ideas were saved.',
          503,
          { retryable: true },
        );
        return;
      }

      // Plan/quota denials are authoritative. Do not disguise a stable
      // AI_PLAN_REQUIRED / daily / monthly response as a successful local
      // discovery fallback; iOS needs the typed code and reset window.
      if (sendAiBudgetError(res, err)) return;

      const language = resolveContentLanguage(req, userId);
      let fallback: Awaited<ReturnType<typeof buildLocalDiscoveryFallback>>;
      try {
        fallback = await buildLocalDiscoveryFallback({
          userId,
          tenantId,
          requestedTopic: requestedTopic?.value,
          language,
          abortSignal: requestCancellation.signal,
        });
      } catch (fallbackError: any) {
        if (fallbackError?.code === 'CONTENT_RADAR_PREFERENCES_UNAVAILABLE') {
          sendError(
            res,
            'CONTENT_RADAR_PREFERENCES_UNAVAILABLE',
            'Saved radar topics are temporarily unavailable, so local discovery was not attempted.',
            503,
            { retryable: true },
          );
          return;
        }
        if (fallbackError?.code === 'CONTENT_DEDUP_UNAVAILABLE') {
          sendError(
            res,
            'CONTENT_DEDUP_UNAVAILABLE',
            'Content duplicate detection is temporarily unavailable. No local discovery ideas were saved.',
            503,
            { retryable: true },
          );
          return;
        }
        if (fallbackError?.code === 'CONTENT_DISCOVERY_PERSISTENCE_UNAVAILABLE') {
          sendError(
            res,
            'CONTENT_DISCOVERY_PERSISTENCE_UNAVAILABLE',
            'Local discovery could not confirm every workspace save. Retry to reconcile the result.',
            503,
            {
              retryable: true,
              confirmedBeforeFailure: Number(fallbackError?.details?.confirmedBeforeFailure ?? 0),
            },
          );
          return;
        }
        throw fallbackError;
      }
      if (requestCancellation.signal.aborted) return;
      if (fallback.ideas.length > 0) {
        sendSuccess(res, {
          discovered: fallback.ideas.length,
          ideas: fallback.ideas,
          message: language.startsWith('pt')
            ? 'Radar local pronto. Revê antes de transformar em roteiro.'
            : 'Local radar is ready. Review before turning these into scripts.',
          degraded: true,
          warnings: [language.startsWith('pt')
            ? 'A pesquisa ao vivo não respondeu; estas opções foram geradas a partir dos teus temas guardados.'
            : 'Live discovery did not respond; these options were built from your saved radar topics.'],
          persistence: fallback.persistence,
          generation: buildGenerationMeta({
            mode: 'quick',
            startMs,
            provider: 'local-fallback',
            providerSemantics: 'deterministic_local',
            researchUsed: false,
          }),
        });
        return;
      }

      sendInternalError(res, 'Content discovery not available.', {
        code: 'DISCOVERY_UNAVAILABLE',
        status: 503,
      });
    } finally {
      requestCancellation.cleanup();
    }
  });

  registerContentIntelligenceRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);

  registerContentScriptRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);
  registerContentScriptJobRoutes(router, ensureValidContentRouteScope);
  registerContentCreativeRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);

  registerContentReferenceRoutes(router, ensureValidContentRouteScope);
  registerContentLearningRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);
  // CONTENT-UI-O1 + O2: unified per-tenant creator profile + radar feedback
  registerContentCreatorProfileRoutes(router, ensureValidContentRouteScope);
  registerContentAgencyRoutes(router, ensureValidContentRouteScope);

  return router;
}

function safeContentRouteErrorName(error: unknown): string {
  const candidate = error instanceof Error && error.name ? error.name : typeof error;
  return candidate.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'UnknownError';
}

function readOptionalDiscoveryTopic(
  value: unknown,
): { value: string } | { error: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return { error: 'topic must be a string.' };
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized) return { error: 'topic must not be empty.' };
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    return { error: 'topic contains unsupported control characters.' };
  }
  if (normalized.length > 160) return { error: 'topic must be at most 160 characters.' };
  return { value: normalized };
}

/**
 * Fail-closed mutation gate shared by core, revision, lineage, specialist, and
 * schedule routes. Reads and capability discovery remain available for safe
 * recovery. Route handlers still own full authentication and tenant checks.
 */
export function enforceContentWorkspaceWriteCapability(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const slice = classifyContentWorkspaceWriteSlice(req.method, req.originalUrl || req.url, req.body);
  if (!slice) {
    next();
    return;
  }

  const { userId, tenantId } = req as unknown as AuthenticatedRequest;
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(tenantId) || userId <= 0 || tenantId <= 0 || tenantId !== userId) {
    // Preserve the route's existing typed auth/scope response instead of
    // disclosing rollout state to an invalid scope.
    next();
    return;
  }

  const capabilities = resolveContentWorkspaceCapabilities({ userId, tenantId });
  if (capabilities.writes[slice]) {
    next();
    return;
  }

  recordContentWorkspaceOperationalOutcome({
    operation: 'rollout_gate',
    outcome: 'blocked',
    reason: 'rollout_write_disabled',
  });

  sendError(
    res,
    'CONTENT_WORKSPACE_WRITE_DISABLED',
    slice === 'restore_deleted_items'
      ? 'Content recovery is temporarily unavailable. The deleted item remains preserved in Trash.'
      : 'This Content workspace action is temporarily read-only. Existing content remains available.',
    503,
    {
      capabilitySchemaVersion: capabilities.schemaVersion,
      mode: capabilities.mode,
      writeSlice: slice,
      reasonCode: capabilities.reasonCode,
      retryable: true,
    },
  );
}

async function buildContentHomePayload(userId: number, tenantId: number, language: Lang, timezone: string) {
  const db = getDb();

  let pipeline = null as ReturnType<typeof readContentHomePipeline> | null;
  let ideas: Array<{ title: string }> = [];
  let topics = [] as Array<{ status: 'planned' | 'drafting' | 'ready' | 'published' | 'cancelled'; scheduledDate: string | null }>;
  let workSchedule = null as null | {
    confirmedThisWeek: number;
    attentionThisWeek: number;
    authorityStatus: 'current' | 'partially_unavailable' | 'unavailable';
    semantics: 'private_work_session';
  };
  let lastLoadError: string | null = null;
  const reasonCodes: string[] = [];
  const recordUnavailableSection = (reasonCode: string, error: unknown): void => {
    logger.debug({ errorName: safeContentRouteErrorName(error), userId },
      `content/home ${reasonCode.toLocaleLowerCase('en-US')} digest failed`);
    lastLoadError = lastLoadError ?? reasonCode.toLocaleLowerCase('en-US');
    reasonCodes.push(reasonCode);
  };

  try {
    pipeline = readContentHomePipeline(db, userId, tenantId);
  } catch (err: unknown) {
    logger.debug({ errorName: safeContentRouteErrorName(err), userId }, 'content/home pipeline digest failed');
    lastLoadError = 'pipeline_unavailable';
    reasonCodes.push('PIPELINE_UNAVAILABLE');
  }

  try {
    ideas = readContentHomeIdeas(db, userId, tenantId);
  } catch (err: unknown) {
    logger.debug({ errorName: safeContentRouteErrorName(err), userId }, 'content/home ideas digest failed');
    lastLoadError = lastLoadError ?? 'ideas_unavailable';
    reasonCodes.push('IDEAS_UNAVAILABLE');
  }

  try {
    topics = getTopics(userId, {
      includeTerminal: false,
      limit: 100,
      tenantId,
    }).map((topic) => ({
      status: topic.status,
      scheduledDate: topic.scheduled_date ?? null,
    }));
  } catch (err: unknown) {
    logger.debug({ errorName: safeContentRouteErrorName(err), userId }, 'content/home topics digest failed');
    lastLoadError = lastLoadError ?? 'topics_unavailable';
    reasonCodes.push('TOPICS_UNAVAILABLE');
  }

  try {
    const scheduleSummary = getContentWorkspaceSummaryCounts(
      { tenantId, userId },
      db,
      new Date(),
      timezone,
    );
    workSchedule = {
      confirmedThisWeek: scheduleSummary.scheduledThisWeek,
      attentionThisWeek: scheduleSummary.scheduleAttentionThisWeek,
      authorityStatus: scheduleSummary.scheduleAuthorityStatus,
      semantics: scheduleSummary.scheduleSemantics,
    };
  } catch (err: unknown) {
    logger.debug({ errorName: safeContentRouteErrorName(err), userId }, 'content/home work schedule digest failed');
    lastLoadError = lastLoadError ?? 'work_schedule_unavailable';
    reasonCodes.push('WORK_SCHEDULE_UNAVAILABLE');
    workSchedule = {
      confirmedThisWeek: 0,
      attentionThisWeek: 0,
      authorityStatus: 'unavailable',
      semantics: 'private_work_session',
    };
  }

  let allDiscoverySignals: ReturnType<typeof readSignals> = [];
  let discoverySignalsAvailable = true;
  try {
    allDiscoverySignals = readSignals(
      'ios-content-home',
      ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
      6,
      userId,
      7,
      tenantId,
      { excludeSourceAgents: PAUSED_CONTENT_AGENT_IDS, strict: true },
    ).filter(isActiveContentAgentSignal);
  } catch (error) {
    discoverySignalsAvailable = false;
    recordUnavailableSection('DISCOVERY_SIGNALS_UNAVAILABLE', error);
  }
  let radarPreferences: ContentRadarPreferences = { topics: [], updatedAt: null };
  let radarPreferencesAvailable = true;
  try {
    radarPreferences = getContentRadarPreferences(userId, tenantId, { strict: true });
  } catch (error) {
    radarPreferencesAvailable = false;
    recordUnavailableSection('RADAR_PREFERENCES_UNAVAILABLE', error);
  }
  const discoverySignals = discoverySignalsAvailable && radarPreferencesAvailable
    ? filterSignalsForRadarPreferences(allDiscoverySignals, radarPreferences.topics)
    : [];
  let optimizationSignals: ReturnType<typeof readSignals> = [];
  try {
    optimizationSignals = readSignals(
      'ios-content-home',
      ['hook_effectiveness', 'pillar_performance', 'learning_digest', 'creator_learning_digest', 'content_formula'],
      6,
      userId,
      14,
      tenantId,
      { excludeSourceAgents: PAUSED_CONTENT_AGENT_IDS, strict: true },
    ).filter(isActiveContentAgentSignal);
  } catch (error) {
    recordUnavailableSection('OPTIMIZATION_SIGNALS_UNAVAILABLE', error);
  }
  let monitoredPillars: ReturnType<typeof getActiveContentPillars> = [];
  if (radarPreferencesAvailable && radarPreferences.topics.length > 0) {
    monitoredPillars = discoverySignalsAvailable
      ? buildRadarTopicSummaries(radarPreferences.topics, discoverySignals)
      : radarPreferences.topics.map((name) => ({ name, keywordCount: 0 }));
  } else if (radarPreferencesAvailable) {
    try {
      monitoredPillars = getActiveContentPillars(userId, tenantId);
    } catch (error) {
      recordUnavailableSection('PILLARS_UNAVAILABLE', error);
    }
  }
  let deskItems: ReturnType<typeof getContentDeskItems> = [];
  try {
    deskItems = getContentDeskItems(userId, 3, tenantId);
  } catch (error) {
    recordUnavailableSection('CONTENT_DESK_UNAVAILABLE', error);
  }
  let voiceEntries: ReturnType<typeof getVoiceDna> = [];
  try {
    voiceEntries = getVoiceDna(undefined, userId, tenantId, { strict: true });
  } catch (error) {
    recordUnavailableSection('VOICE_DNA_UNAVAILABLE', error);
  }
  let knowledgeStats: ReturnType<typeof getKnowledgeStats> = { categories: [], referenceChannels: 0 };
  try {
    knowledgeStats = getKnowledgeStats(undefined, userId, tenantId, { strict: true });
  } catch (error) {
    recordUnavailableSection('KNOWLEDGE_STATS_UNAVAILABLE', error);
  }
  let filmingRecommendation: ContentFilmingRecommendation | null = null;
  try {
    filmingRecommendation = localizeFilmingRecommendation(
      await getFilmingRecommendation(userId, undefined, tenantId),
      language,
    );
  } catch (error) {
    if (!(error instanceof ContentFilmingRecommendationUnavailableError)) throw error;
    recordUnavailableSection('FILMING_RECOMMENDATION_UNAVAILABLE', error);
  }

  return buildContentHomeViewState({
    pipeline,
    ideas,
    topics,
    workSchedule,
    discovery: {
      activeCount: discoverySignals.length,
      deskReadyCount: deskItems.length,
      deskItems: deskItems.map((item) => ({
        title: item.title,
        body: item.body,
      })),
      monitoredPillars: monitoredPillars.map((pillar) => ({
        name: pillar.name,
      })),
    },
    script: {
      voicePatternCount: voiceEntries.length,
      hasBrandVoice: voiceEntries.some((entry) => entry.category === 'brand_voice' || entry.category === 'voice_summary')
        || knowledgeStats.categories.some((entry) => entry.category === 'brand_voice' || entry.category === 'voice_summary'),
    },
    optimization: {
      activeInsightCount: optimizationSignals.length,
      recentSignals: optimizationSignals.map((signal) => ({
        title: buildSignalTitle(signal, language),
        summary: buildSignalSummary(signal, language),
      })),
    },
    filmingRecommendation: filmingRecommendation
      ? {
          date: filmingRecommendation.date,
          confidence: filmingRecommendation.confidence,
          localizedReason: filmingRecommendation.reason,
          localizedConfidenceLabel: language.startsWith('pt')
            ? filmingRecommendation.confidence === 'high'
              ? 'Alta confiança'
              : filmingRecommendation.confidence === 'medium'
                ? 'Confiança média'
                : 'Baixa confiança'
            : filmingRecommendation.confidence === 'high'
              ? 'High confidence'
              : filmingRecommendation.confidence === 'medium'
                ? 'Medium confidence'
                : 'Low confidence',
        }
      : null,
    hasAttemptedLoad: true,
    lastLoadError,
    meta: buildScreenContractMeta({
      source: 'server',
      isFallback: reasonCodes.length > 0,
      isPartial: reasonCodes.length > 0,
      isStale: false,
      generatedAt: new Date().toISOString(),
      reasonCodes,
    }),
  }, language);
}

function contentHomeCacheKey(userId: number, tenantId: number, language: Lang, timezone: string): string {
  return routeCacheKey(
    'content', 'home', CONTENT_AGENT_LIFECYCLE_POLICY_VERSION,
    'u', userId,
    't', tenantId,
    language,
    'tz', timezone,
    // Prevent a pre-publication-truth payload (which rendered Published: 0)
    // from replaying after the response contract gained explicit unavailability.
    'publication-truth.v3',
  );
}

export function normalizeDiscoveredIdeasForResponse(rawIdeas: unknown, startMs = Date.now()) {
  if (!Array.isArray(rawIdeas) || rawIdeas.length > 15) {
    throw contentDiscoveryOutputContractError('idea batch');
  }
  const responseStartMs = Number.isFinite(startMs) && startMs >= 0 ? startMs : Date.now();
  const createdAt = new Date(responseStartMs).toISOString();
  const seen = new Set<string>();
  return rawIdeas.flatMap((idea, index) => {
    const candidate = typeof idea === 'string'
      ? idea
      : idea && typeof idea === 'object'
        ? (idea as Record<string, unknown>).title
        : undefined;
    if (typeof candidate !== 'string') throw contentDiscoveryOutputContractError('title');
    const title = candidate.replace(/\s+/gu, ' ').trim();
    if (
      title.length === 0
      || Array.from(title).length > 240
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(candidate)
    ) {
      throw contentDiscoveryOutputContractError('title');
    }
    const key = title
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('en-US');
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      id: `discovery-${responseStartMs}-${index}`,
      title,
      score: index < 10 ? 0.7 : 0.4,
      createdAt,
      lifecycleState: 'discovered' as const,
      approvalState: 'pending_review' as const,
      reviewState: 'needs_review' as const,
      workflowBlockers: [] as string[],
      provenanceSources: [] as unknown[],
    }];
  });
}

function contentDiscoveryOutputContractError(field: string): Error {
  return Object.assign(new Error(`Content discovery ${field} did not match the bounded response contract.`), {
    name: 'ContentDiscoveryOutputContractError',
    code: 'CONTENT_DISCOVERY_OUTPUT_INVALID',
  });
}

interface LocalDiscoveryFallbackResult {
  ideas: ReturnType<typeof normalizeDiscoveredIdeasForResponse>;
  persistence: {
    status: 'complete';
    confirmedCount: number;
    createdCount: number;
    replayedCount: number;
    duplicateCount: number;
  };
}

function emptyLocalDiscoveryFallback(): LocalDiscoveryFallbackResult {
  return {
    ideas: [],
    persistence: {
      status: 'complete',
      confirmedCount: 0,
      createdCount: 0,
      replayedCount: 0,
      duplicateCount: 0,
    },
  };
}

async function buildLocalDiscoveryFallback(params: {
  userId: number;
  tenantId?: number;
  requestedTopic?: string;
  language: Lang;
  abortSignal?: AbortSignal;
}): Promise<LocalDiscoveryFallbackResult> {
  throwIfContentRouteCancelled(params.abortSignal);
  if (!Number.isSafeInteger(params.tenantId) || Number(params.tenantId) <= 0) {
    return emptyLocalDiscoveryFallback();
  }
  const tenantId = Number(params.tenantId);
  const preferences = getContentRadarPreferences(params.userId, params.tenantId, { strict: true });
  const topics = [
    params.requestedTopic,
    ...preferences.topics,
  ]
    .map((topic) => topic?.replace(/\s+/g, ' ').trim())
    .filter((topic): topic is string => Boolean(topic))
    .slice(0, 4);

  if (topics.length === 0) return emptyLocalDiscoveryFallback();

  const sourceDate = new Date().toISOString().slice(0, 10);
  const ideas: string[] = [];
  for (const topic of topics) {
    if (params.language.startsWith('pt')) {
      ideas.push(`Uma forma prática de explorar ${topic}`);
      ideas.push(`Como usar ${topic} sem cair em hype genérico`);
    } else {
      ideas.push(`A practical way to explore ${topic}`);
      ideas.push(`How to use ${topic} without generic hype`);
    }
  }

  const saved: string[] = [];
  let workspaceChanged = false;
  let createdCount = 0;
  let replayedCount = 0;
  let duplicateCount = 0;
  const { isDuplicateIdea, isDuplicateIdeaInBatch } = await import('../../services/content-dedup');
  throwIfContentRouteCancelled(params.abortSignal);
  const eligibleIdeas: string[] = [];
  const acceptedForBatch: { title: string }[] = [];
  for (const title of ideas.slice(0, 6)) {
    throwIfContentRouteCancelled(params.abortSignal);
    const dedupe = await isDuplicateIdea(title, undefined, params.userId, params.tenantId);
    throwIfContentRouteCancelled(params.abortSignal);
    const inBatchDedupe = isDuplicateIdeaInBatch(title, undefined, acceptedForBatch);
    if ((dedupe.isDuplicate && dedupe.confidence > 0.8)
        || (inBatchDedupe.isDuplicate && inBatchDedupe.confidence > 0.8)) {
      duplicateCount += 1;
      continue;
    }
    eligibleIdeas.push(title);
    acceptedForBatch.push({ title });
  }

  for (const title of eligibleIdeas) {
    throwIfContentRouteCancelled(params.abortSignal);
    try {
      const captured = captureDiscoveredIdea({
        scope: { tenantId, userId: params.userId },
        title,
        sourceDate,
        score: 0.35,
        workflowEligible: true,
        angleTag: 'local-radar-fallback',
        whyNow: params.language.startsWith('pt')
          ? 'Gerado localmente a partir dos temas guardados enquanto a pesquisa ao vivo estava indisponível.'
          : 'Generated locally from saved radar topics while live discovery was unavailable.',
        provider: 'local-fallback',
      });
      workspaceChanged ||= !captured.replayed;
      if (captured.replayed) replayedCount += 1;
      else createdCount += 1;
      // Replays return the already-saved canonical item without creating a
      // duplicate, but the user still sees the refreshed recommendation.
      saved.push(title);
    } catch (fallbackErr) {
      throwIfContentRouteCancelled(params.abortSignal, fallbackErr);
      logger.warn({
        errorName: safeContentRouteErrorName(fallbackErr),
        userId: params.userId,
        titleLength: title.length,
        titleHash: createHash('sha256').update(title).digest('hex').slice(0, 16),
      }, 'Content discovery local fallback save failed');
      if (workspaceChanged) invalidateContentDerivedCaches(params.userId);
      throw Object.assign(new Error('Local content discovery persistence is unavailable.'), {
        name: 'ContentDiscoveryPersistenceError',
        code: 'CONTENT_DISCOVERY_PERSISTENCE_UNAVAILABLE',
        status: 503,
        details: { confirmedBeforeFailure: saved.length, retryable: true },
      });
    }
  }
  if (workspaceChanged) invalidateContentDerivedCaches(params.userId);

  return {
    ideas: normalizeDiscoveredIdeasForResponse(saved, Date.now()).map((idea) => ({
      ...idea,
      score: 0.35,
      provenanceSources: [],
      workflowBlockers: [params.language.startsWith('pt') ? 'Sem pesquisa ao vivo' : 'No live research'],
    })),
    persistence: {
      status: 'complete',
      confirmedCount: saved.length,
      createdCount,
      replayedCount,
      duplicateCount,
    },
  };
}

function throwIfContentRouteCancelled(abortSignal?: AbortSignal, error?: unknown): void {
  if (!abortSignal?.aborted) return;
  if (abortSignal.reason instanceof Error) throw abortSignal.reason;
  if (isProviderRequestCancellation(error)) throw error;
  throw Object.assign(new Error('content_route_client_disconnected'), {
    name: 'AbortError',
    code: 'CONTENT_CLIENT_DISCONNECTED',
  });
}

function resolveContentLanguage(req: Pick<AuthenticatedRequest, 'header'>, userId: number): Lang {
  // `normalizeLangHeader` always returns a value ('pt-BR' default) for
  // backwards-compat with callers that want a string no matter what.
  // That means checking its return is NEVER falsy and would silently
  // override the user's stored preference on every request that didn't
  // send an x-language header. Check the raw header for presence first.
  const rawHeader = req.header?.('x-language');
  if (rawHeader) return normalizeLangHeader(rawHeader);
  return getUserLanguageById(userId);
}
