// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { invalidateContentDerivedCaches } from '../../services/cache-coherence-registry';
import {
  addTopic,
  getFilmingRecommendation,
  getTopics,
  getUpcomingTopicCount,
  updateTopic,
  deleteTopic,
  CONTENT_TOPIC_STATUSES,
  type ContentTopicStatus,
} from '../../services/content-scheduler';
import {
  getContentRadarPreferences,
  setContentRadarPreferences,
} from '../../services/content-radar-preferences';
import { localizeFilmingRecommendation } from '../../services/content-intelligence';
import { syncContentTopicSecretaryArtifacts } from '../../services/content-topic-secretary-sync';
import { logger } from '../../utils/logger';
import { runOutboxTransaction } from '../../services/event-outbox';
import { consumeResourceBudget } from '../../services/resource-budgets';
import type { Lang } from '../../utils/i18n';

type ResolveContentLanguage = (req: Pick<AuthenticatedRequest, 'header'>, userId: number) => Lang;
type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

function parseContentTopicId(value: string): number | null {
  const topicId = parseInt(value, 10);
  return Number.isNaN(topicId) ? null : topicId;
}

function isValidScheduledDate(value: unknown): value is string | null | undefined {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidScheduledDateTime(value: unknown): value is string | null | undefined {
  if (value === undefined || value === null) return true;
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function datePartFromScheduledDateTime(value: string | null | undefined): string | undefined {
  return typeof value === 'string' ? value.slice(0, 10) : undefined;
}

export function registerContentTopicRoutes(
  router: Router,
  resolveContentLanguage: ResolveContentLanguage,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  /** GET /api/v1/content/radar-preferences — creator topics for Reaction Radar */
  router.get('/radar-preferences', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_radar_preferences_read')) return;

    sendSuccess(res, getContentRadarPreferences(userId));
  }));

  /** PUT /api/v1/content/radar-preferences — replace creator topics for Reaction Radar */
  router.put('/radar-preferences', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_radar_preferences_write')) return;

    const topics = Array.isArray(req.body?.topics) ? req.body.topics : null;
    if (!topics || topics.some((topic: unknown) => typeof topic !== 'string')) {
      sendError(res, 'BAD_REQUEST', 'topics must be an array of strings', 400);
      return;
    }

    const preferences = setContentRadarPreferences(userId, topics);
    invalidateContentDerivedCaches(userId);
    sendSuccess(res, preferences);
  }));

  /**
   * GET /api/v1/content/topics?status=&from=&to=&scheduledOnly=&limit=
   *
   * Returns the user's topics sorted with scheduled topics first
   * (by date ASC), unscheduled last (by updated_at DESC). Cancelled
   * topics are hidden unless the caller passes ?status=cancelled.
   */
  router.get('/topics', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId = userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_list')) return;

    const status = typeof req.query.status === 'string'
      ? (req.query.status as ContentTopicStatus)
      : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const scheduledOnly = req.query.scheduledOnly === 'true';
    const limit = Math.min(parseInt(String(req.query.limit ?? ''), 10) || 20, 500);

    if (status && !CONTENT_TOPIC_STATUSES.includes(status)) {
      sendError(res, 'BAD_REQUEST', `status must be one of: ${CONTENT_TOPIC_STATUSES.join(', ')}`);
      return;
    }

    try {
      const topics = getTopics(userId, {
        status,
        from,
        to,
        scheduledOnly,
        includeTerminal: status === 'cancelled' || status === 'published',
        limit,
      });

      // Precompute the upcoming count so the iOS landing page card
      // can render a "N this week" subtitle without a second request.
      const [upcomingCount, filmingRecommendation] = await Promise.all([
        Promise.resolve(getUpcomingTopicCount(userId, 14)),
        getFilmingRecommendation(userId, topics),
      ]);
      const language = resolveContentLanguage(req, userId);

      sendSuccess(res, {
        topics,
        count: topics.length,
        upcomingCount,
        filmingRecommendation: localizeFilmingRecommendation(filmingRecommendation, language),
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS content topics list failed');
      sendInternalError(res, 'Failed to fetch topics');
    }
  }));

  /**
   * POST /api/v1/content/topics
   * Body: { title, notes?, scheduledDate?, scheduledDateTime?, status? }
   *
   * Creates a new topic. `scheduledDate` is nullable — unscheduled
   * topics go in the "later" bucket in the iOS UI. `status` defaults
   * to 'planned' server-side.
   */
  router.post('/topics', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId = userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_create')) return;

    const { title, notes, scheduledDate, scheduledDateTime, status } = req.body;
    if (!title || typeof title !== 'string' || !title.trim()) {
      sendError(res, 'BAD_REQUEST', 'title is required and must be non-empty');
      return;
    }
    if (status !== undefined && !CONTENT_TOPIC_STATUSES.includes(status)) {
      sendError(res, 'BAD_REQUEST', `status must be one of: ${CONTENT_TOPIC_STATUSES.join(', ')}`);
      return;
    }
    if (!isValidScheduledDate(scheduledDate)) {
      sendError(res, 'BAD_REQUEST', 'scheduledDate must be YYYY-MM-DD or null');
      return;
    }
    if (!isValidScheduledDateTime(scheduledDateTime)) {
      sendError(res, 'BAD_REQUEST', 'scheduledDateTime must be ISO datetime or null');
      return;
    }
    if (!consumeContentWriteBudget(res, tenantId, userId, 'content_topic_create')) return;

    try {
      const language = resolveContentLanguage(req, userId);
      const effectiveScheduledDate = scheduledDate
        ?? datePartFromScheduledDateTime(scheduledDateTime)
        ?? null;
      const writeTopic = () => addTopic(userId, title.trim(), {
        notes: notes ?? null,
        scheduledDate: effectiveScheduledDate,
        scheduledAt: scheduledDateTime ?? null,
        status: status ?? 'planned',
      });
      const topic = runOutboxTransaction((emitDomainEvent) => {
        const created = writeTopic();
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'content',
          eventType: 'content.idea.created',
          entityType: 'content_topic',
          entityId: created.id,
          payload: {
            summary: { status: created.status, scheduled: Boolean(created.scheduled_date ?? created.scheduled_at) },
            action: 'created',
          },
          privacyClassification: 'private_content',
          idempotencyKey: `content.idea.created:${userId}:${created.id}`,
        });
        return created;
      });
      const syncedTopic = await syncContentTopicSecretaryArtifacts(userId, topic, { language });
      invalidateContentDerivedCaches(userId);
      sendSuccess(res, { topic: syncedTopic }, { status: 201 });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS content topic create failed');
      sendInternalError(res, 'Failed to create topic');
    }
  }));

  /**
   * PATCH /api/v1/content/topics/:id
   * Body: { title?, notes?, scheduledDate?, scheduledDateTime?, status? }
   *
   * Partial update — only the fields present in the body are modified.
   * `scheduledDate` and `notes` accept explicit null to clear.
   */
  router.patch('/topics/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId = userId } = req as unknown as AuthenticatedRequest;
    const topicId = parseContentTopicId(req.params.id);
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_update', { topicId })) return;

    const { title, notes, scheduledDate, scheduledDateTime, status } = req.body;
    if (topicId == null) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }
    if (title === undefined && notes === undefined && scheduledDate === undefined && scheduledDateTime === undefined && status === undefined) {
      sendError(res, 'BAD_REQUEST', 'At least one of title, notes, scheduledDate, scheduledDateTime, or status must be provided');
      return;
    }
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      sendError(res, 'BAD_REQUEST', 'title must be a non-empty string when provided');
      return;
    }
    if (status !== undefined && !CONTENT_TOPIC_STATUSES.includes(status)) {
      sendError(res, 'BAD_REQUEST', `status must be one of: ${CONTENT_TOPIC_STATUSES.join(', ')}`);
      return;
    }
    if (!isValidScheduledDate(scheduledDate)) {
      sendError(res, 'BAD_REQUEST', 'scheduledDate must be YYYY-MM-DD or null');
      return;
    }
    if (!isValidScheduledDateTime(scheduledDateTime)) {
      sendError(res, 'BAD_REQUEST', 'scheduledDateTime must be ISO datetime or null');
      return;
    }
    if (!consumeContentWriteBudget(res, tenantId, userId, 'content_topic_update')) return;

    try {
      const effectiveScheduledDate = scheduledDate !== undefined
        ? scheduledDate
        : datePartFromScheduledDateTime(scheduledDateTime);
      const mutationFingerprint = stableMutationFingerprint({
        title: title !== undefined ? title.trim() : undefined,
        notes: notes !== undefined ? (notes === null ? null : String(notes)) : undefined,
        scheduledDate: effectiveScheduledDate,
        scheduledDateTime: scheduledDateTime !== undefined ? scheduledDateTime : undefined,
        status,
      });
      const writeUpdate = () => updateTopic(userId, topicId, {
        title: title !== undefined ? title.trim() : undefined,
        notes: notes !== undefined ? (notes === null ? null : String(notes)) : undefined,
        scheduled_date: effectiveScheduledDate,
        scheduled_at: scheduledDateTime !== undefined ? scheduledDateTime : undefined,
        status,
      });
      const updated = runOutboxTransaction((emitDomainEvent) => {
        const row = writeUpdate();
        if (!row) return null;
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'content',
          eventType: 'content.idea.updated',
          entityType: 'content_topic',
          entityId: row.id,
          payload: {
            summary: { status: row.status, scheduled: Boolean(row.scheduled_date ?? row.scheduled_at) },
            action: 'updated',
          },
          privacyClassification: 'private_content',
          idempotencyKey: `content.idea.updated:${userId}:${row.id}:${mutationFingerprint}`,
        });
        return row;
      });
      if (!updated) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      const syncedTopic = await syncContentTopicSecretaryArtifacts(userId, updated, {
        language: resolveContentLanguage(req, userId),
      });
      invalidateContentDerivedCaches(userId);
      sendSuccess(res, { topic: syncedTopic });
    } catch (err: any) {
      logger.error({ err, userId, topicId }, 'iOS content topic update failed');
      sendInternalError(res, 'Failed to update topic');
    }
  }));

  /**
   * DELETE /api/v1/content/topics/:id
   * Hard-delete. UIs that want to preserve history can PATCH
   * status='cancelled' instead.
   */
  router.delete('/topics/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId = userId } = req as unknown as AuthenticatedRequest;
    const topicId = parseContentTopicId(req.params.id);
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_delete', { topicId })) return;

    if (topicId == null) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }
    if (!consumeContentWriteBudget(res, tenantId, userId, 'content_topic_delete')) return;

    try {
      const writeDelete = () => deleteTopic(userId, topicId);
      const deleted = runOutboxTransaction((emitDomainEvent) => {
        const didDelete = writeDelete();
        if (!didDelete) return false;
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'content',
          eventType: 'content.idea.updated',
          entityType: 'content_topic',
          entityId: topicId,
          payload: {
            summary: { deleted: true },
            action: 'deleted',
          },
          privacyClassification: 'private_content',
          idempotencyKey: `content.idea.deleted:${userId}:${topicId}`,
        });
        return true;
      });
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      invalidateContentDerivedCaches(userId);
      sendSuccess(res, { deleted: true, id: topicId });
    } catch (err: any) {
      logger.error({ err, userId, topicId }, 'iOS content topic delete failed');
      sendInternalError(res, 'Failed to delete topic');
    }
  }));
}

function stableMutationFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest('hex')
    .slice(0, 16);
}

function consumeContentWriteBudget(res: Response, tenantId: number, userId: number, budgetKey: string): boolean {
  const budget = consumeResourceBudget({
    tenantId,
    userId,
    budgetKey,
    limit: 60,
    windowSeconds: 60,
  });
  if (budget.allowed) return true;
  setRetryAfter(res, budget.resetAt);
  sendError(res, 'RATE_LIMITED', 'Too many content write requests. Try again shortly.', 429, {
    resetAt: budget.resetAt,
    budgetKey: budget.budgetKey,
  });
  return false;
}

function setRetryAfter(res: Response, resetAt: string): void {
  const seconds = Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000));
  res.setHeader('Retry-After', String(Number.isFinite(seconds) ? seconds : 60));
}
