// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendSuccess } from '../response-helpers';
import { buildContentIntelligenceDetail, buildContentIntelligenceSummary } from './content-intelligence-route-utils';
import { getFilmingRecommendation } from '../../services/content-scheduler';
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
import { getJobStatuses } from '../../portal/telemetry';
import { getKnowledgeStats, getVoiceDna } from '../../services/content-dashboard-service';
import { readSignals } from '../../services/intelligence-bus';
import type { Lang } from '../../utils/i18n';

type ResolveContentLanguage = (req: Pick<AuthenticatedRequest, 'header'>, userId: number) => Lang;
type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export function registerContentIntelligenceRoutes(
  router: Router,
  resolveContentLanguage: ResolveContentLanguage,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  /** GET /api/v1/content/intelligence — backstage agent summary for iOS */
  router.get('/intelligence', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_intelligence_summary')) return;

    const language = resolveContentLanguage(req, userId);
    const context = readContentIntelligenceContext(userId, 'ios-content-intelligence', 25);

    sendSuccess(res, buildContentIntelligenceSummary({
      language,
      reactionJob: context.reactionJob,
      performanceJob: context.performanceJob,
      autoresearchJob: context.autoresearchJob,
      discoverySignals: context.discoverySignals,
      optimizationSignals: context.optimizationSignals,
      voiceEntries: context.voiceEntries,
      knowledgeStats: context.knowledgeStats,
    }));
  }));

  /** GET /api/v1/content/intelligence/detail — deeper backstage view for iOS */
  router.get('/intelligence/detail', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_intelligence_detail')) return;

    const language = resolveContentLanguage(req, userId);
    const context = readContentIntelligenceContext(userId, 'ios-content-intelligence-detail', 6);
    const filmingRecommendation = localizeFilmingRecommendation(await getFilmingRecommendation(userId), language);
    const monitoredPillars = context.radarPreferences.topics.length > 0
      ? buildRadarTopicSummaries(context.radarPreferences.topics, context.discoverySignals)
      : getActiveContentPillars(userId);
    const deskItems = getContentDeskItems(userId, 3);

    sendSuccess(res, buildContentIntelligenceDetail({
      language,
      reactionJob: context.reactionJob,
      performanceJob: context.performanceJob,
      autoresearchJob: context.autoresearchJob,
      discoverySignals: context.discoverySignals,
      optimizationSignals: context.optimizationSignals,
      voiceEntries: context.voiceEntries,
      knowledgeStats: context.knowledgeStats,
      filmingRecommendation,
      preferredTopics: context.radarPreferences.topics,
      monitoredPillars,
      deskItems,
    }));
  }));
}

function readContentIntelligenceContext(
  userId: number,
  source: string,
  signalLimit: number,
) {
  const jobs = new Map(getJobStatuses().map((job) => [job.name, job]));
  const allDiscoverySignals = readSignals(
    source,
    ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
    signalLimit,
    userId,
    7,
  );
  const radarPreferences = getContentRadarPreferences(userId);
  const discoverySignals = filterSignalsForRadarPreferences(allDiscoverySignals, radarPreferences.topics);
  const optimizationSignals = readSignals(
    source,
    ['hook_effectiveness', 'pillar_performance', 'learning_digest', 'content_formula'],
    signalLimit,
    userId,
    14,
  );

  return {
    reactionJob: jobs.get('reaction_radar'),
    performanceJob: jobs.get('performance_agent'),
    autoresearchJob: jobs.get('autoresearch'),
    radarPreferences,
    discoverySignals,
    optimizationSignals,
    voiceEntries: getVoiceDna(undefined, userId),
    knowledgeStats: getKnowledgeStats(undefined, userId),
  };
}
