// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { invalidateDashboardCoordinationCaches } from '../../services/coordination-cache-invalidator';
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
import { logger } from '../../utils/logger';
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

    sendSuccess(res, setContentRadarPreferences(userId, topics));
  }));

  /**
   * GET /api/v1/content/topics?status=&from=&to=&scheduledOnly=&limit=
   *
   * Returns the user's topics sorted with scheduled topics first
   * (by date ASC), unscheduled last (by updated_at DESC). Cancelled
   * topics are hidden unless the caller passes ?status=cancelled.
   */
  router.get('/topics', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_list')) return;

    const status = typeof req.query.status === 'string'
      ? (req.query.status as ContentTopicStatus)
      : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const scheduledOnly = req.query.scheduledOnly === 'true';
    const limit = req.query.limit
      ? Math.min(parseInt(String(req.query.limit), 10) || 100, 500)
      : 100;

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
   * Body: { title, notes?, scheduledDate?, status? }
   *
   * Creates a new topic. `scheduledDate` is nullable — unscheduled
   * topics go in the "later" bucket in the iOS UI. `status` defaults
   * to 'planned' server-side.
   */
  router.post('/topics', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_create')) return;

    const { title, notes, scheduledDate, status } = req.body;
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

    try {
      const topic = addTopic(userId, title.trim(), {
        notes: notes ?? null,
        scheduledDate: scheduledDate ?? null,
        status: status ?? 'planned',
      });
      invalidateDashboardCoordinationCaches(userId);
      sendSuccess(res, { topic }, { status: 201 });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS content topic create failed');
      sendInternalError(res, 'Failed to create topic');
    }
  }));

  /**
   * PATCH /api/v1/content/topics/:id
   * Body: { title?, notes?, scheduledDate?, status? }
   *
   * Partial update — only the fields present in the body are modified.
   * `scheduledDate` and `notes` accept explicit null to clear.
   */
  router.patch('/topics/:id', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const topicId = parseContentTopicId(req.params.id);
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_update', { topicId })) return;

    const { title, notes, scheduledDate, status } = req.body;
    if (topicId == null) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }
    if (title === undefined && notes === undefined && scheduledDate === undefined && status === undefined) {
      sendError(res, 'BAD_REQUEST', 'At least one of title, notes, scheduledDate, or status must be provided');
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

    try {
      const updated = updateTopic(userId, topicId, {
        title: title !== undefined ? title.trim() : undefined,
        notes: notes !== undefined ? (notes === null ? null : String(notes)) : undefined,
        scheduled_date: scheduledDate !== undefined ? scheduledDate : undefined,
        status,
      });
      if (!updated) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      invalidateDashboardCoordinationCaches(userId);
      sendSuccess(res, { topic: updated });
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
    const { userId } = req as unknown as AuthenticatedRequest;
    const topicId = parseContentTopicId(req.params.id);
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_delete', { topicId })) return;

    if (topicId == null) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }

    try {
      const deleted = deleteTopic(userId, topicId);
      if (!deleted) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      invalidateDashboardCoordinationCaches(userId);
      sendSuccess(res, { deleted: true, id: topicId });
    } catch (err: any) {
      logger.error({ err, userId, topicId }, 'iOS content topic delete failed');
      sendInternalError(res, 'Failed to delete topic');
    }
  }));
}
