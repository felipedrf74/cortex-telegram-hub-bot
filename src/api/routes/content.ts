// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response } from 'express';
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
import { registerContentTopicRoutes } from './content-topic-routes';
import { registerContentCreatorProfileRoutes } from './content-creator-profile-routes';
import { registerContentAgencyRoutes } from './content-agency-routes';
import {
  getFilmingRecommendation,
  getTopics,
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
} from '../../services/content-radar-preferences';
import { getDb } from '../../services/database';
import { getKnowledgeStats, getVoiceDna } from '../../services/content-dashboard-service';
import { readSignals } from '../../services/intelligence-bus';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguageById } from '../../services/user-service';
import type { Lang } from '../../utils/i18n';
import { buildContentHomeViewState } from '../../services/content-home-view-state';
import { saveIdea } from '../../state/saved-ideas';
import { sendConditionalApiSuccess } from '../conditional-cache';
import { ensureCachedRouteTenantScope, handleCachedRoute, routeCacheKey } from '../route-helpers/cached-route-handler';

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

  registerContentPipelineRoutes(router);
  registerContentEditorialRoutes(router, ensureValidContentRouteScope);
  registerContentNotificationRoutes(router, ensureValidContentRouteScope);
  registerContentTopicRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);

  /** GET /api/v1/content/home — render-ready landing view state for iOS */
  router.get('/home', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_home')) return;

    const language = resolveContentLanguage(req, userId);
    const cacheKey = contentHomeCacheKey(userId, tenantId, language);

    await handleCachedRoute<Awaited<ReturnType<typeof buildContentHomePayload>>>({
      cacheKey,
      ttlSeconds: CONTENT_HOME_TTL_SECONDS,
      staleSeconds: CONTENT_HOME_SWR_STALE_SECONDS,
      refreshContext: { source: 'content_route', operation: 'content_home_swr_refresh', userId },
      fetchFresh: () => buildContentHomePayload(userId, tenantId, language),
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

    const startMs = Date.now();
    try {
      const { runContentDiscovery } = await import('../../services/content-discovery');
      const result = await runContentDiscovery({ userId, tenantId });
      const ideas = normalizeDiscoveredIdeasForResponse(result?.ideas || [], startMs);
      sendSuccess(res, {
        discovered: ideas.length,
        ideas,
        message: `Discovered ${ideas.length} new content ideas.`,
        generation: buildGenerationMeta({
          mode: 'standard',
          startMs,
          provider: result?.provider || 'provider-routed',
          researchUsed: true,
        }),
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/discover failed');

      // Plan/quota denials are authoritative. Do not disguise a stable
      // AI_PLAN_REQUIRED / daily / monthly response as a successful local
      // discovery fallback; iOS needs the typed code and reset window.
      if (sendAiBudgetError(res, err)) return;

      const language = resolveContentLanguage(req, userId);
      const fallback = await buildLocalDiscoveryFallback({
        userId,
        tenantId,
        requestedTopic: typeof req.body?.topic === 'string' ? req.body.topic : undefined,
        language,
      });
      if (fallback.length > 0) {
        sendSuccess(res, {
          discovered: fallback.length,
          ideas: fallback,
          message: language.startsWith('pt')
            ? 'Radar local pronto. Revê antes de transformar em roteiro.'
            : 'Local radar is ready. Review before turning these into scripts.',
          degraded: true,
          warnings: [language.startsWith('pt')
            ? 'A pesquisa ao vivo não respondeu; estas opções foram geradas a partir dos teus temas guardados.'
            : 'Live discovery did not respond; these options were built from your saved radar topics.'],
          generation: buildGenerationMeta({
            mode: 'quick',
            startMs,
            provider: 'local-fallback',
            researchUsed: false,
          }),
        });
        return;
      }

      sendInternalError(res, 'Content discovery not available.', {
        code: 'DISCOVERY_UNAVAILABLE',
        status: 503,
      });
    }
  });

  registerContentIntelligenceRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);

  registerContentScriptRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);

  registerContentReferenceRoutes(router, ensureValidContentRouteScope);
  registerContentLearningRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);
  // CONTENT-UI-O1 + O2: unified per-tenant creator profile + radar feedback
  registerContentCreatorProfileRoutes(router, ensureValidContentRouteScope);
  registerContentAgencyRoutes(router, ensureValidContentRouteScope);

  return router;
}

async function buildContentHomePayload(userId: number, tenantId: number, language: Lang) {
  const db = getDb();

  let pipeline = null as null | {
    stages: {
      ideas: Array<{ title: string }>;
      scripted: Array<{ title: string }>;
      filmed: Array<{ title: string }>;
      editing: Array<{ title: string }>;
      published: Array<{ title: string }>;
    };
  };
  let ideas: Array<{ title: string }> = [];
  let topics = [] as Array<{ status: 'planned' | 'drafting' | 'ready' | 'published' | 'cancelled'; scheduledDate: string | null }>;
  let lastLoadError: string | null = null;
  const reasonCodes: string[] = [];

  try {
    pipeline = readContentHomePipeline(db, userId, tenantId);
  } catch (err: any) {
    logger.debug({ err, userId }, 'content/home pipeline digest failed');
    lastLoadError = err?.message || 'pipeline_unavailable';
    reasonCodes.push('PIPELINE_UNAVAILABLE');
  }

  try {
    ideas = readContentHomeIdeas(db, userId, tenantId);
  } catch (err: any) {
    logger.debug({ err, userId }, 'content/home ideas digest failed');
    lastLoadError = lastLoadError ?? (err?.message || 'ideas_unavailable');
    reasonCodes.push('IDEAS_UNAVAILABLE');
  }

  try {
    topics = getTopics(userId, {
      includeTerminal: false,
      limit: 100,
    }).map((topic) => ({
      status: topic.status,
      scheduledDate: topic.scheduled_date ?? null,
    }));
  } catch (err: any) {
    logger.debug({ err, userId }, 'content/home topics digest failed');
    lastLoadError = lastLoadError ?? (err?.message || 'topics_unavailable');
    reasonCodes.push('TOPICS_UNAVAILABLE');
  }

  const allDiscoverySignals = readSignals(
    'ios-content-home',
    ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
    6,
    userId,
    7,
  );
  const radarPreferences = getContentRadarPreferences(userId, tenantId);
  const discoverySignals = filterSignalsForRadarPreferences(allDiscoverySignals, radarPreferences.topics);
  const optimizationSignals = readSignals(
    'ios-content-home',
    ['hook_effectiveness', 'pillar_performance', 'learning_digest', 'content_formula'],
    6,
    userId,
    14,
  );
  const monitoredPillars = radarPreferences.topics.length > 0
    ? buildRadarTopicSummaries(radarPreferences.topics, discoverySignals)
    : getActiveContentPillars(userId);
  const deskItems = getContentDeskItems(userId, 3);
  const voiceEntries = getVoiceDna(undefined, userId, tenantId);
  const knowledgeStats = getKnowledgeStats(undefined, userId, tenantId);
  const filmingRecommendation = localizeFilmingRecommendation(await getFilmingRecommendation(userId), language);

  return buildContentHomeViewState({
    pipeline,
    ideas,
    topics,
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

function contentHomeCacheKey(userId: number, tenantId: number, language: Lang): string {
  return routeCacheKey('u', userId, 't', tenantId, 'content', 'home', language);
}

export function normalizeDiscoveredIdeasForResponse(rawIdeas: unknown[], startMs = Date.now()) {
  return rawIdeas
    .map((idea, index) => {
      if (typeof idea === 'string') {
        const title = idea.trim();
        if (!title) return null;
        return {
          id: `discovery-${startMs}-${index}`,
          title,
          score: index < 10 ? 0.7 : 0.4,
          createdAt: new Date(startMs).toISOString(),
          lifecycleState: 'discovered',
          approvalState: 'pending_review',
          reviewState: 'needs_review',
          workflowBlockers: [],
          provenanceSources: [],
        };
      }
      if (idea && typeof idea === 'object') {
        const record = idea as Record<string, unknown>;
        const title = typeof record.title === 'string' ? record.title.trim() : '';
        if (!title) return null;
        return {
          id: typeof record.id === 'string' || typeof record.id === 'number'
            ? String(record.id)
            : `discovery-${startMs}-${index}`,
          title,
          score: typeof record.score === 'number' ? record.score : undefined,
          createdAt: typeof record.createdAt === 'string'
            ? record.createdAt
            : typeof record.created_at === 'string'
              ? record.created_at
              : new Date(startMs).toISOString(),
          lifecycleState: typeof record.lifecycleState === 'string'
            ? record.lifecycleState
            : typeof record.lifecycle_state === 'string'
              ? record.lifecycle_state
              : 'discovered',
          approvalState: typeof record.approvalState === 'string'
            ? record.approvalState
            : typeof record.approval_state === 'string'
              ? record.approval_state
              : 'pending_review',
          reviewState: typeof record.reviewState === 'string'
            ? record.reviewState
            : typeof record.review_state === 'string'
              ? record.review_state
              : 'needs_review',
          workflowBlockers: Array.isArray(record.workflowBlockers)
            ? record.workflowBlockers.filter((value): value is string => typeof value === 'string')
            : [],
          provenanceSources: Array.isArray(record.provenanceSources)
            ? record.provenanceSources
            : [],
        };
      }
      return null;
    })
    .filter((idea): idea is NonNullable<typeof idea> => idea != null);
}

async function buildLocalDiscoveryFallback(params: {
  userId: number;
  tenantId?: number;
  requestedTopic?: string;
  language: Lang;
}) {
  const preferences = getContentRadarPreferences(params.userId, params.tenantId);
  const topics = [
    params.requestedTopic,
    ...preferences.topics,
  ]
    .map((topic) => topic?.replace(/\s+/g, ' ').trim())
    .filter((topic): topic is string => Boolean(topic))
    .slice(0, 4);

  if (topics.length === 0) return [];

  const sourceDate = new Date().toISOString().slice(0, 10);
  const ideas: string[] = [];
  for (const topic of topics) {
    if (params.language.startsWith('pt')) {
      ideas.push(`O que mudou em ${topic} esta semana`);
      ideas.push(`Como usar ${topic} sem cair em hype genérico`);
    } else {
      ideas.push(`What changed in ${topic} this week`);
      ideas.push(`How to use ${topic} without generic hype`);
    }
  }

  const saved: string[] = [];
  const { isDuplicateIdea } = await import('../../services/content-dedup');
  for (const title of ideas.slice(0, 6)) {
    try {
      const dedupe = await isDuplicateIdea(title, undefined, params.userId, params.tenantId);
      if (dedupe.isDuplicate && dedupe.confidence > 0.8) continue;
      saveIdea({
        title,
        sourceDate,
        source: 'discovery',
        score: 0.35,
        workflowEligible: true,
        angleTag: 'local-radar-fallback',
        whyNow: params.language.startsWith('pt')
          ? 'Gerado localmente a partir dos temas guardados enquanto a pesquisa ao vivo estava indisponível.'
          : 'Generated locally from saved radar topics while live discovery was unavailable.',
        userId: params.userId,
      });
      saved.push(title);
    } catch (fallbackErr) {
      logger.warn({ err: fallbackErr, userId: params.userId, title }, 'Content discovery local fallback save failed');
    }
  }

  return normalizeDiscoveredIdeasForResponse(saved, Date.now()).map((idea) => ({
    ...idea,
    score: 0.35,
    provenanceSources: [],
    workflowBlockers: [params.language.startsWith('pt') ? 'Sem pesquisa ao vivo' : 'No live research'],
  }));
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
