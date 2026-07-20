// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendSuccess } from '../response-helpers';
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
import { getPerformanceSummary, type PerformanceFeedback } from '../../services/content-learning-store';
import { readSignals } from '../../services/intelligence-bus';
import { assertTenantScope, requireTenantIdParam, TenantScopeError } from '../../services/tenant-scope';
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
    const scope = requireContentIntelligenceScope(
      req as AuthenticatedRequest,
      res,
      'content_route_intelligence_summary',
      ensureValidContentRouteScope,
    );
    if (!scope) return;
    const { userId, tenantId } = scope;

    const language = resolveContentLanguage(req, userId);
    const context = readContentIntelligenceContext(userId, tenantId, 'ios-content-intelligence', 25);

    sendSuccess(res, buildContentIntelligenceSummary({
      language,
      reactionJob: context.reactionJob,
      performanceJob: context.performanceJob,
      autoresearchJob: context.autoresearchJob,
      discoverySignals: context.discoverySignals,
      optimizationSignals: context.optimizationSignals,
      performanceSummary: context.performanceSummary,
      voiceEntries: context.voiceEntries,
      knowledgeStats: context.knowledgeStats,
    }));
  }));

  /** GET /api/v1/content/intelligence/detail — deeper backstage view for iOS */
  router.get('/intelligence/detail', asyncHandler(async (req, res: Response) => {
    const scope = requireContentIntelligenceScope(
      req as AuthenticatedRequest,
      res,
      'content_route_intelligence_detail',
      ensureValidContentRouteScope,
    );
    if (!scope) return;
    const { userId, tenantId } = scope;

    const language = resolveContentLanguage(req, userId);
    const context = readContentIntelligenceContext(userId, tenantId, 'ios-content-intelligence-detail', 6);
    const filmingRecommendation = localizeFilmingRecommendation(
      await getFilmingRecommendation(userId, undefined, tenantId),
      language,
    );
    const monitoredPillars = context.radarPreferences.topics.length > 0
      ? buildRadarTopicSummaries(context.radarPreferences.topics, context.discoverySignals)
      : getActiveContentPillars(userId, tenantId);
    const deskItems = getContentDeskItems(userId, 3, tenantId);

    sendSuccess(res, buildContentIntelligenceDetail({
      language,
      reactionJob: context.reactionJob,
      performanceJob: context.performanceJob,
      autoresearchJob: context.autoresearchJob,
      discoverySignals: context.discoverySignals,
      optimizationSignals: context.optimizationSignals,
      performanceSummary: context.performanceSummary,
      voiceEntries: context.voiceEntries,
      knowledgeStats: context.knowledgeStats,
      filmingRecommendation,
      preferredTopics: context.radarPreferences.topics,
      monitoredPillars,
      deskItems,
    }));
  }));
}

function requireContentIntelligenceScope(
  req: AuthenticatedRequest,
  res: Response,
  operation: string,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): { userId: number; tenantId: number } | null {
  if (!ensureValidContentRouteScope(res, req.userId, operation)) return null;
  try {
    return assertTenantScope(req, operation);
  } catch (err) {
    if (err instanceof TenantScopeError) {
      sendError(res, err.code, err.message, err.status);
      return null;
    }
    throw err;
  }
}

function readContentIntelligenceContext(
  userId: number,
  tenantId: number | undefined,
  source: string,
  signalLimit: number,
) {
  // 2026-05-18 (skill-hardening QA P1-1): require validated tenantId; the
  // previous `?? userId` fallback could mis-attribute performance summary
  // across tenants. Route caller must call assertTenantScope first.
  const validatedTenantId = requireTenantIdParam(tenantId, 'readContentIntelligenceContext');
  const jobs = new Map(getJobStatuses().map((job) => [job.name, job]));
  const allDiscoverySignals = readSignals(
    source,
    ['reaction_opportunity', 'trending_spike', 'competitor_upload'],
    signalLimit,
    userId,
    7,
    validatedTenantId,
  );
  const radarPreferences = getContentRadarPreferences(userId, validatedTenantId);
  const discoverySignals = filterSignalsForRadarPreferences(allDiscoverySignals, radarPreferences.topics);
  const optimizationSignals = readSignals(
    source,
    ['hook_effectiveness', 'pillar_performance', 'learning_digest', 'creator_learning_digest', 'content_formula'],
    signalLimit,
    userId,
    14,
    validatedTenantId,
  );
  const performanceSummary = summarizePerformanceFeedback(getPerformanceSummary(userId, 30, validatedTenantId));

  return {
    reactionJob: jobs.get('reaction_radar'),
    performanceJob: jobs.get('performance_agent'),
    autoresearchJob: jobs.get('autoresearch'),
    radarPreferences,
    discoverySignals,
    optimizationSignals,
    performanceSummary,
    voiceEntries: getVoiceDna(undefined, userId, validatedTenantId),
    knowledgeStats: getKnowledgeStats(undefined, userId, validatedTenantId),
  };
}

function summarizePerformanceFeedback(summary: ReturnType<typeof getPerformanceSummary>) {
  const recentEntries = summary.entries.slice(0, 3).map(performanceEntryDigest);
  const topEntry = summary.entries
    .slice()
    .sort((a, b) => performanceScore(b) - performanceScore(a))[0] ?? null;
  return {
    count: summary.count,
    avgViews: summary.avgViews,
    avgRetention: summary.avgRetention,
    totalLikes: summary.totalLikes,
    totalComments: summary.totalComments,
    totalSubsGained: summary.totalSubsGained,
    topEntry: topEntry ? performanceEntryDigest(topEntry) : null,
    recentEntries,
  };
}

function performanceEntryDigest(entry: PerformanceFeedback) {
  return {
    id: entry.id,
    title: entry.selectedTitle ?? entry.hookUsed ?? null,
    views: entry.views,
    retentionPct: entry.retentionPct,
    likes: entry.likes,
    comments: entry.comments,
    subsGained: entry.subsGained,
    loggedAt: entry.loggedAt,
  };
}

function performanceScore(entry: PerformanceFeedback): number {
  return entry.views + entry.likes * 20 + entry.comments * 40 + entry.subsGained * 100 + entry.retentionPct * 10;
}
