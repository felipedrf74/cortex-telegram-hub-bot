// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
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
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';

export function contentRoutes(): Router {
  const router = Router();

  function ensureValidContentRouteScope(
    res: Response,
    userId: number | undefined,
    operation: string,
    details?: Record<string, unknown>,
  ): userId is number {
    if (isValidTenantUserId(userId)) return true;
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation,
      reason: 'invalid_user_scope',
      userId: typeof userId === 'number' ? userId : null,
      details,
    });
    sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
    return false;
  }

  registerContentPipelineRoutes(router);
  registerContentEditorialRoutes(router, ensureValidContentRouteScope);
  registerContentNotificationRoutes(router, ensureValidContentRouteScope);
  registerContentTopicRoutes(router, resolveContentLanguage, ensureValidContentRouteScope);

  /** GET /api/v1/content/home — render-ready landing view state for iOS */
  router.get('/home', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_home')) return;

    const db = getDb();
    const language = resolveContentLanguage(req, userId);

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
      pipeline = readContentHomePipeline(db, userId);
    } catch (err: any) {
      logger.debug({ err, userId }, 'content/home pipeline digest failed');
      lastLoadError = err?.message || 'pipeline_unavailable';
      reasonCodes.push('PIPELINE_UNAVAILABLE');
    }

    try {
      ideas = readContentHomeIdeas(db, userId);
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

    sendSuccess(res, buildContentHomeViewState({
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
    }, language));
  }));

  /** POST /api/v1/content/discover — trigger content discovery */
  router.post('/discover', async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_discover')) return;

    const startMs = Date.now();
    try {
      const { runContentDiscovery } = require('../../services/content-discovery');
      const result = await runContentDiscovery(userId, tenantId);
      sendSuccess(res, {
        discovered: result?.count || 0,
        ideas: result?.ideas || [],
        message: `Discovered ${result?.count || 0} new content ideas.`,
        generation: buildGenerationMeta({
          mode: 'standard',
          startMs,
          provider: result?.provider || 'provider-routed',
          researchUsed: true,
        }),
      });
    } catch (err: any) {
      logger.error({ err }, 'iOS content/discover failed');
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

  return router;
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
