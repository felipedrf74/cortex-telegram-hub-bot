// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendSuccess } from '../response-helpers';
import { getDb } from '../../services/database';
import { invalidateContentDerivedCaches } from '../../services/cache-coherence-registry';
import {
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
} from '../../services/content-tenant-scope';
import {
  buildGeneratedTopicCandidatesResponse,
  buildLearnedPatternsResponse,
  buildPendingTopicsResponse,
  buildRecentScriptsResponse,
  buildTasteProfileResponse,
  buildWeeklyPackageResponse,
} from './content-learning-route-utils';
import { invalidTopicGeneratorFormatMessage } from './content-script-utils';
import type { Lang } from '../../utils/i18n';
import {
  getContentSourcePackage,
  recordContentVariantFeedback,
} from '../../services/content-token-artifact-store';

type ContentTopicGeneratorFormat = 'reel' | 'youtube';
type ResolveContentLanguage = (req: Pick<AuthenticatedRequest, 'header'>, userId: number) => Lang;
type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

const VALID_TOPIC_GENERATOR_FORMATS = new Set<ContentTopicGeneratorFormat>(['reel', 'youtube']);
const VALID_FEEDBACK_SENTIMENTS = ['approved', 'skipped', 'rejected'] as const;
const VALID_VARIANT_KINDS = new Set([
  'hook',
  'title',
  'caption',
  'cta',
  'angle',
  'thumbnail',
  'script',
  'section',
  'repurpose',
]);

function isTopicGeneratorFormat(format: unknown): format is ContentTopicGeneratorFormat {
  return typeof format === 'string' && VALID_TOPIC_GENERATOR_FORMATS.has(format as ContentTopicGeneratorFormat);
}

export function registerContentLearningRoutes(
  router: Router,
  resolveContentLanguage: ResolveContentLanguage,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  router.use((req: Request, res: Response, next: NextFunction) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_learning')) return;
    next();
  });

  /**
   * POST /api/v1/content/topics/generate
   *
   * Generate topic candidates and store them in the DB.
   * Returns structured data the iOS app renders as native approval cards.
   *
   * Body: { format: "reel" | "youtube", sourceJob?: string }
   */
  router.post('/topics/generate', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const requestLanguage = resolveContentLanguage(req as AuthenticatedRequest, userId);
    const { format = 'reel', sourceJob = 'manual' } = req.body;

    if (!isTopicGeneratorFormat(format)) {
      sendError(res, 'VALIDATION', invalidTopicGeneratorFormatMessage(requestLanguage), 400);
      return;
    }

    const startMs = Date.now();
    const { generateAndStoreTopicCandidates } = await import('../../services/content-workflow');
    const result = await generateAndStoreTopicCandidates(userId, format, sourceJob, tenantId);
    invalidateContentDerivedCaches(userId);

    sendSuccess(res, buildGeneratedTopicCandidatesResponse(result, format, sourceJob, startMs));
  }));

  /**
   * POST /api/v1/content/topics/:feedbackId/feedback
   *
   * Record approval/skip/reject for a topic candidate.
   * Body: { sentiment: "approved" | "skipped" | "rejected" }
   */
  router.post('/topics/:feedbackId/feedback', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const { feedbackId } = req.params;
    const { sentiment } = req.body;

    if (!sentiment || !VALID_FEEDBACK_SENTIMENTS.includes(sentiment)) {
      sendError(res, 'VALIDATION', `sentiment must be one of: ${VALID_FEEDBACK_SENTIMENTS.join(', ')}`, 400);
      return;
    }

    const id = parseInt(feedbackId, 10);

    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const topicRow = db.prepare(
      `SELECT id, topic, user_id, tenant_id, owner_user_id, visibility_scope, scope_status
         FROM content_topic_feedback
        WHERE id = ?`
    ).get(id) as { id: number; topic: string; user_id: number; tenant_id?: number; owner_user_id?: number; visibility_scope?: string; scope_status?: string } | undefined;

    if (!topicRow) {
      sendError(res, 'NOT_FOUND', 'Topic not found', 404);
      return;
    }
    if (
      topicRow.user_id <= 0
      || topicRow.user_id !== userId
      || topicRow.scope_status === 'quarantined'
      || (topicRow.tenant_id != null && topicRow.tenant_id !== tenantId)
    ) {
      sendError(res, 'FORBIDDEN', 'Not your topic', 403);
      return;
    }

    const { updateFeedback } = await import('../../services/content-workflow');
    updateFeedback(id, sentiment, userId, tenantId);
    invalidateContentDerivedCaches(userId);
    sendSuccess(res, { feedbackId: id, sentiment, title: topicRow.topic });
  }));

  /**
   * POST /api/v1/content/variant-feedback
   *
   * Records the user's accept/reject signal for generated hooks, titles,
   * captions, CTAs, thumbnail concepts, or script sections. This is a
   * direct REST learning path; it never routes through chat or triggers
   * generation.
   *
   * Body: {
   *   topic: string,
   *   variantText: string,
   *   sentiment: "approved" | "skipped" | "rejected",
   *   variantKind?: "hook" | "title" | "caption" | "cta" | ...
   *   sourcePackageId?: string,
   *   angle?: string,
   *   format?: string,
   *   notes?: string
   * }
   */
  router.post('/variant-feedback', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const routeTenantId = typeof tenantId === 'number' ? tenantId : userId;
    const topic = cleanFeedbackString(req.body?.topic, 240);
    const variantText = cleanFeedbackString(req.body?.variantText, 360);
    const sentiment = req.body?.sentiment;
    const variantKind = cleanFeedbackString(req.body?.variantKind, 64) || 'script';
    const sourcePackageId = cleanFeedbackString(req.body?.sourcePackageId, 80);

    if (!topic || !variantText) {
      sendError(res, 'VALIDATION', 'topic and variantText are required', 400);
      return;
    }
    if (!sentiment || !VALID_FEEDBACK_SENTIMENTS.includes(sentiment)) {
      sendError(res, 'VALIDATION', `sentiment must be one of: ${VALID_FEEDBACK_SENTIMENTS.join(', ')}`, 400);
      return;
    }
    if (!VALID_VARIANT_KINDS.has(variantKind)) {
      sendError(res, 'VALIDATION', `variantKind must be one of: ${Array.from(VALID_VARIANT_KINDS).join(', ')}`, 400);
      return;
    }
    if (sourcePackageId) {
      if (!/^sp_[a-f0-9]{16}_[a-f0-9]{16}$/i.test(sourcePackageId)) {
        sendError(res, 'VALIDATION', 'invalid sourcePackageId', 400);
        return;
      }
      if (!getContentSourcePackage({ tenantId: routeTenantId, userId }, sourcePackageId)) {
        sendError(res, 'NOT_FOUND', 'source package not found', 404);
        return;
      }
    }

    const recorded = recordContentVariantFeedback({
      tenantId: routeTenantId,
      userId,
      topic,
      variantText,
      sentiment,
      variantKind,
      sourcePackageId,
      angle: cleanFeedbackString(req.body?.angle, 160),
      format: cleanFeedbackString(req.body?.format, 64),
      notes: cleanFeedbackString(req.body?.notes, 320),
    });

    invalidateContentDerivedCaches(userId);
    sendSuccess(res, recorded);
  }));

  /**
   * GET /api/v1/content/topics/pending
   *
   * List pending topic candidates awaiting user feedback.
   */
  router.get('/topics/pending', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const db = getDb();
    ensureContentTenantScopeColumns(db);

    const rows = db.prepare(`
      SELECT id, topic, niche, format, hook_idea, why_now, angle_tag, source_job, created_at
      FROM content_topic_feedback
      WHERE sentiment = 'pending' AND ${contentScopePredicate()}
      ORDER BY created_at DESC
      LIMIT 50
    `).all(...contentScopeParams(userId, tenantId)) as any[];

    sendSuccess(res, buildPendingTopicsResponse(rows));
  }));

  /**
   * POST /api/v1/content/weekly-package
   *
   * Generate the full weekly content package (2 YT + 4 reels).
   * Returns structured data — iOS renders as a grouped approval UI.
   */
  router.post('/weekly-package', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const startMs = Date.now();

    const { generateWeeklyPackage } = await import('../../services/content-workflow');
    const result = await generateWeeklyPackage(userId, tenantId);
    invalidateContentDerivedCaches(userId);

    sendSuccess(res, buildWeeklyPackageResponse(result, startMs));
  }));

  /**
   * GET /api/v1/content/taste-profile
   *
   * Returns the user's content taste profile built from feedback history.
   * The iOS app uses this for the "Your Content DNA" card in the Content tab.
   */
  router.get('/taste-profile', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const db = getDb();
    ensureContentTenantScopeColumns(db);

    const rows = db.prepare(`
      SELECT topic, niche, sentiment, created_at
      FROM content_topic_feedback
      WHERE sentiment IN ('approved', 'rejected')
        AND created_at > datetime('now', '-60 days')
        AND ${contentScopePredicate()}
      ORDER BY created_at DESC
      LIMIT 100
    `).all(...contentScopeParams(userId, tenantId)) as { topic: string; niche: string; sentiment: string; created_at: string }[];

    sendSuccess(res, buildTasteProfileResponse(rows));
  }));

  /**
   * POST /api/v1/content/performance
   *
   * Log performance feedback for a published video.
   * Replaces the Python content-engine feedback.json file.
   */
  router.post('/performance', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const {
      pipelineId,
      videoUrl,
      views,
      retentionPct,
      likes,
      comments,
      subsGained,
      hookUsed,
      selectedTitle,
      finalCaption,
      finalCta,
      finalScriptVariant,
      publishedHashtags,
      notes,
    } = req.body;

    if (views === undefined || retentionPct === undefined) {
      sendError(res, 'VALIDATION', 'views and retentionPct are required', 400);
      return;
    }

    const { logPerformanceFeedback } = await import('../../services/content-learning-store');
    const id = logPerformanceFeedback({
      pipelineId, videoUrl, views, retentionPct,
      likes, comments, subsGained, hookUsed, selectedTitle,
      finalCaption, finalCta, finalScriptVariant, publishedHashtags, notes,
      userId,
      tenantId,
    });

    invalidateContentDerivedCaches(userId);
    sendSuccess(res, { feedbackId: id });
  }));

  /**
   * GET /api/v1/content/performance
   *
   * Get performance summary for the authenticated user.
   * Query: ?days=30 (default 30)
   */
  router.get('/performance', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const days = parseInt(String(req.query.days || '30'), 10);

    const { getPerformanceSummary } = await import('../../services/content-learning-store');
    const summary = getPerformanceSummary(userId, days, tenantId);

    sendSuccess(res, summary);
  }));

  /**
   * GET /api/v1/content/learned-patterns
   *
   * Get durable learned voice/content patterns.
   * Query: ?category=voice_addition (optional filter)
   */
  router.get('/learned-patterns', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const category = req.query.category as string | undefined;

    const { getLearnedPatterns } = await import('../../services/content-learning-store');
    const patterns = getLearnedPatterns(userId, category, tenantId);

    sendSuccess(res, buildLearnedPatternsResponse(patterns));
  }));

  /**
   * GET /api/v1/content/artifact-chain/:pipelineId
   *
   * Trace the full artifact chain for a pipeline entry:
   * idea → topic feedback → pipeline → script → performance → patterns
   *
   * Ownership-gated: the pipeline must belong to the authenticated user.
   */
  router.get('/artifact-chain/:pipelineId', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const pipelineId = parseInt(req.params.pipelineId, 10);

    if (Number.isNaN(pipelineId)) {
      sendError(res, 'BAD_REQUEST', 'pipelineId must be a number', 400);
      return;
    }

    const db = getDb();
    ensureContentTenantScopeColumns(db);
    const row = db.prepare(
      `SELECT user_id, tenant_id, owner_user_id, visibility_scope, scope_status
         FROM content_pipeline
        WHERE id = ?`
    ).get(pipelineId) as { user_id: number; tenant_id?: number; owner_user_id?: number; visibility_scope?: string; scope_status?: string } | undefined;

    if (!row) {
      sendError(res, 'NOT_FOUND', 'Pipeline entry not found', 404);
      return;
    }
    if (row.user_id <= 0 || row.user_id !== userId || row.scope_status === 'quarantined' || (row.tenant_id != null && row.tenant_id !== tenantId)) {
      sendError(res, 'FORBIDDEN', 'Not your pipeline entry', 403);
      return;
    }

    const { getArtifactChain } = await import('../../services/content-learning-store');
    const chain = getArtifactChain(pipelineId, userId, tenantId);

    sendSuccess(res, chain);
  }));

  /**
   * GET /api/v1/content/scripts/recent
   *
   * Get recent generated scripts (raw text).
   * Used by iOS content review UI and portal script inspector.
   * Query: ?days=30&limit=10
   */
  router.get('/scripts/recent', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const days = parseInt(String(req.query.days || '30'), 10);
    const limit = parseInt(String(req.query.limit || '10'), 10);

    const { getRecentScripts } = await import('../../services/content-learning-store');
    const { tenantId } = req as unknown as AuthenticatedRequest;
    const scripts = getRecentScripts(userId, days, limit, tenantId);

    sendSuccess(res, buildRecentScriptsResponse(scripts));
  }));
}

function cleanFeedbackString(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  return cleaned || null;
}
