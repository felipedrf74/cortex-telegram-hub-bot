// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'node:crypto';
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { invalidateContentDerivedCaches } from '../../services/cache-coherence-registry';
import {
  addTopic,
  findTopicByClientRequestId,
  getFilmingRecommendation,
  getTopics,
  getUpcomingTopicCount,
  updateTopic,
  deleteTopic,
  getTopicById,
  CONTENT_TOPIC_STATUSES,
  type ContentTopicStatus,
  type ContentTopic,
} from '../../services/content-scheduler';
import {
  getContentRadarPreferences,
  setContentRadarPreferences,
} from '../../services/content-radar-preferences';
import { localizeFilmingRecommendation } from '../../services/content-intelligence';
import { cleanupContentTopicSecretaryArtifacts } from '../../services/content-topic-secretary-sync';
import {
  assertContentTopicCompatibilityCanArchive,
  findContentTopicCompatibilityUpdateReplay,
  hasContentTopicCompatibilityDeleteReplay,
} from '../../services/content-topic-workspace-compat';
import { ContentWorkspaceError } from '../../services/content-workspace';
import { logger } from '../../utils/logger';
import { runOutboxTransaction } from '../../services/event-outbox';
import { consumeResourceBudget } from '../../services/resource-budgets';
import { recordContentWorkspaceProductSignal } from '../../services/content-workspace-observability';
import { ContentWorkspaceWriteDisabledError } from '../../services/content-workspace-capabilities';
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
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_radar_preferences_read')) return;

    sendSuccess(res, getContentRadarPreferences(userId, tenantId));
  }));

  /** PUT /api/v1/content/radar-preferences — replace creator topics for Reaction Radar */
  router.put('/radar-preferences', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_radar_preferences_write')) return;

    const topics = Array.isArray(req.body?.topics) ? req.body.topics : null;
    if (!topics || topics.some((topic: unknown) => typeof topic !== 'string')) {
      sendError(res, 'BAD_REQUEST', 'topics must be an array of strings', 400);
      return;
    }

    const preferences = setContentRadarPreferences(userId, topics, tenantId);
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
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_list')) return;
    recordContentWorkspaceProductSignal('legacy_topics_compatibility_read');

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
        tenantId,
      });

      // Precompute the upcoming count so the iOS landing page card
      // can render a "N this week" subtitle without a second request.
      const [upcomingCount, filmingRecommendation] = await Promise.all([
        Promise.resolve(getUpcomingTopicCount(userId, 14, tenantId)),
        getFilmingRecommendation(userId, topics, tenantId),
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
   * Body: { title, notes?, scheduledDate?, scheduledDateTime?, status?,
   *         source?, idempotencyKey? }
   *
   * Creates a new topic. `scheduledDate` is nullable — unscheduled
   * topics go in the "later" bucket in the iOS UI. `status` defaults
   * to 'planned' server-side.
   *
   * BE-2/BE-3 (Content Studio, additive):
   * - `source` ("capture" | "composer" | "manual") is recorded as creation
   *   provenance in audit_metadata_json — the gate that lets future
   *   topic-consuming intelligence filter raw captures.
   * - `idempotencyKey` (body, or `Idempotency-Key` header) makes the create
   *   retry-safe: a replay returns 200 with the original topic and consumes
   *   no write budget, instead of creating a duplicate.
   */
  router.post('/topics', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_create')) return;
    recordContentWorkspaceProductSignal('legacy_topics_compatibility_mutation');

    const { title, notes, scheduledDate, scheduledDateTime, status, source } = req.body;
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
    const TOPIC_CREATE_SOURCES = ['capture', 'composer', 'manual'];
    if (source !== undefined && source !== null
      && (typeof source !== 'string' || !TOPIC_CREATE_SOURCES.includes(source))) {
      sendError(res, 'BAD_REQUEST', `source must be one of: ${TOPIC_CREATE_SOURCES.join(', ')}`);
      return;
    }
    const headerIdempotencyKey = req.header('Idempotency-Key');
    const rawIdempotencyKey = typeof req.body?.idempotencyKey === 'string'
      ? req.body.idempotencyKey
      : (typeof headerIdempotencyKey === 'string' ? headerIdempotencyKey : undefined);
    const idempotencyKey = rawIdempotencyKey?.trim() || undefined;
    if (idempotencyKey !== undefined && idempotencyKey.length > 128) {
      sendError(res, 'BAD_REQUEST', 'idempotencyKey must be at most 128 characters');
      return;
    }

    try {
      const language = resolveContentLanguage(req, userId);
      const effectiveScheduledDate = scheduledDate
        ?? datePartFromScheduledDateTime(scheduledDateTime)
        ?? null;
      // Replay validation includes the complete normalized payload. Reusing a
      // key with a different status, deadline, or content is a typed conflict,
      // not permission to return or mutate the earlier idea.
      if (idempotencyKey) {
        const existing = findTopicByClientRequestId(userId, idempotencyKey, tenantId, {
          title: title.trim(),
          notes: notes ?? null,
          scheduledDate: effectiveScheduledDate,
          scheduledAt: scheduledDateTime ?? null,
          status: status ?? 'planned',
          source: source ?? null,
        });
        if (existing) {
          sendSuccess(res, { topic: existing, idempotentReplay: true }, { status: 200 });
          return;
        }
      }
      if (!consumeContentWriteBudget(res, tenantId, userId, 'content_topic_create')) return;

      const writeTopic = () => addTopic(userId, title.trim(), {
        notes: notes ?? null,
        scheduledDate: effectiveScheduledDate,
        scheduledAt: scheduledDateTime ?? null,
        status: status ?? 'planned',
        tenantId,
        ...(source != null || idempotencyKey != null
          ? { provenance: { source: source ?? null, clientRequestId: idempotencyKey ?? null } }
          : {}),
      });
      const topic = runOutboxTransaction((emitDomainEvent) => {
        const created = writeTopic();
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'content',
          eventType: 'content.idea.created',
          entityType: 'content_workspace_item',
          entityId: created.workspace_item_id ?? created.id,
          payload: {
            summary: {
              status: created.status,
              scheduled: Boolean(created.scheduled_date ?? created.scheduled_at),
              syncPending: false,
              scheduleSemantics: created.schedule_semantics ?? 'none',
            },
            action: 'created',
            language,
          },
          privacyClassification: 'private_content',
          idempotencyKey: `content.idea.created:${userId}:${created.workspace_item_id ?? created.id}`,
        });
        return created;
      });
      invalidateContentDerivedCaches(userId);
      sendSuccess(res, { topic }, { status: 201 });
    } catch (err: any) {
      sendContentTopicError(res, err, userId, tenantId, 'iOS content topic create failed');
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
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const topicId = parseContentTopicId(req.params.id);
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_update', { topicId })) return;
    recordContentWorkspaceProductSignal('legacy_topics_compatibility_mutation');

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
    const headerIdempotencyKey = req.header('Idempotency-Key');
    const rawIdempotencyKey = typeof req.body?.idempotencyKey === 'string'
      ? req.body.idempotencyKey
      : (typeof headerIdempotencyKey === 'string' ? headerIdempotencyKey : undefined);
    const idempotencyKey = rawIdempotencyKey?.trim() || undefined;
    if (idempotencyKey !== undefined && idempotencyKey.length > 128) {
      sendError(res, 'BAD_REQUEST', 'idempotencyKey must be at most 128 characters');
      return;
    }

    try {
      const existingTopic = getTopicById(userId, topicId, tenantId);
      if (!existingTopic) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      const effectiveScheduledDate = scheduledDate !== undefined
        ? scheduledDate
        : scheduledDateTime === null
          ? existingTopic.scheduled_date
          : datePartFromScheduledDateTime(scheduledDateTime);
      const retiresLegacySchedule = topicHasSecretaryRefs(existingTopic)
        && (topicScheduleChanged(existingTopic, scheduledDate, scheduledDateTime) || status === 'cancelled');
      const normalizedUpdate = {
        scope: { tenantId, userId },
        compatTopicId: topicId,
        title: title !== undefined ? title.trim() : undefined,
        notes: notes !== undefined ? (notes === null ? null : String(notes)) : undefined,
        scheduledDate: effectiveScheduledDate,
        scheduledAt: scheduledDateTime !== undefined ? scheduledDateTime : undefined,
        status,
        retireLegacySchedule: retiresLegacySchedule,
        idempotencyKey,
      };
      if (idempotencyKey) {
        const replay = findContentTopicCompatibilityUpdateReplay(normalizedUpdate);
        if (replay) {
          sendSuccess(res, { topic: replay, idempotentReplay: true });
          return;
        }
      }
      if (!consumeContentWriteBudget(res, tenantId, userId, 'content_topic_update')) return;

      if (status === 'cancelled') {
        assertContentTopicCompatibilityCanArchive({ tenantId, userId }, topicId);
      }
      if (retiresLegacySchedule) {
        const cleanup = await cleanupContentTopicSecretaryArtifacts(userId, existingTopic, { tenantId });
        if (cleanup.errors.length > 0) {
          sendInternalError(res, 'Failed to clean up synced Secretary artifacts');
          return;
        }
      }
      const operationKey = idempotencyKey ?? `server-${randomUUID()}`;
      const mutationFingerprint = stableMutationFingerprint({ ...normalizedUpdate, idempotencyKey: operationKey });
      const writeUpdate = () => updateTopic(userId, topicId, {
        title: normalizedUpdate.title,
        notes: normalizedUpdate.notes,
        scheduled_date: normalizedUpdate.scheduledDate,
        scheduled_at: normalizedUpdate.scheduledAt,
        status: normalizedUpdate.status,
      }, tenantId, operationKey, {
        retireLegacySchedule: retiresLegacySchedule,
      });
      const updated = runOutboxTransaction((emitDomainEvent) => {
        const row = writeUpdate();
        if (!row) return null;
        const topic = row;
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'content',
          eventType: 'content.idea.updated',
          entityType: 'content_workspace_item',
          entityId: topic.workspace_item_id ?? topic.id,
          payload: {
            summary: {
              status: topic.status,
              scheduled: Boolean(topic.scheduled_date ?? topic.scheduled_at),
              syncPending: false,
              scheduleSemantics: topic.schedule_semantics ?? 'none',
            },
            action: 'updated',
            language: resolveContentLanguage(req, userId),
          },
          privacyClassification: 'private_content',
          idempotencyKey: `content.idea.updated:${userId}:${topic.workspace_item_id ?? topic.id}:${mutationFingerprint}`,
        });
        return topic;
      });
      if (!updated) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      invalidateContentDerivedCaches(userId);
      sendSuccess(res, { topic: updated });
    } catch (err: any) {
      sendContentTopicError(res, err, userId, tenantId, 'iOS content topic update failed', { topicId });
    }
  }));

  /**
   * DELETE /api/v1/content/topics/:id
   * Compatibility delete. The canonical item moves to recoverable trash;
   * content and revisions are not hard-deleted.
   */
  router.delete('/topics/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const topicId = parseContentTopicId(req.params.id);
    if (!ensureValidContentRouteScope(res, userId, 'content_route_topics_delete', { topicId })) return;
    recordContentWorkspaceProductSignal('legacy_topics_compatibility_mutation');

    if (topicId == null) {
      sendError(res, 'BAD_REQUEST', 'id must be a number');
      return;
    }
    const headerIdempotencyKey = req.header('Idempotency-Key');
    const rawIdempotencyKey = typeof req.body?.idempotencyKey === 'string'
      ? req.body.idempotencyKey
      : (typeof headerIdempotencyKey === 'string' ? headerIdempotencyKey : undefined);
    const idempotencyKey = rawIdempotencyKey?.trim() || undefined;
    if (idempotencyKey !== undefined && idempotencyKey.length > 128) {
      sendError(res, 'BAD_REQUEST', 'idempotencyKey must be at most 128 characters');
      return;
    }

    try {
      if (idempotencyKey && hasContentTopicCompatibilityDeleteReplay(
        { tenantId, userId },
        topicId,
        { idempotencyKey },
      )) {
        sendSuccess(res, { deleted: true, id: topicId, idempotentReplay: true });
        return;
      }
      if (!consumeContentWriteBudget(res, tenantId, userId, 'content_topic_delete')) return;

      const topic = getTopicById(userId, topicId, tenantId);
      if (!topic) {
        sendError(res, 'NOT_FOUND', 'Topic not found or not owned by user', 404);
        return;
      }
      assertContentTopicCompatibilityCanArchive({ tenantId, userId }, topicId);
      const retiresLegacySchedule = topicHasSecretaryRefs(topic);
      if (topicHasSecretaryRefs(topic)) {
        const cleanup = await cleanupContentTopicSecretaryArtifacts(userId, topic, { tenantId });
        if (cleanup.errors.length > 0) {
          sendInternalError(res, 'Failed to clean up synced Secretary artifacts');
          return;
        }
      }
      const operationKey = idempotencyKey ?? `server-${randomUUID()}`;
      const writeDelete = () => deleteTopic(
        userId,
        topicId,
        tenantId,
        operationKey,
        { retireLegacySchedule: retiresLegacySchedule },
      );
      const deleted = runOutboxTransaction((emitDomainEvent) => {
        const didDelete = writeDelete();
        if (!didDelete) return false;
        emitDomainEvent({
          tenantId,
          userId,
          sourceSkill: 'content',
          eventType: 'content.idea.updated',
          entityType: 'content_workspace_item',
          entityId: topic.workspace_item_id ?? topicId,
          payload: {
            summary: { deleted: true },
            action: 'deleted',
          },
          privacyClassification: 'private_content',
          idempotencyKey: `content.idea.deleted:${userId}:${topic.workspace_item_id ?? topicId}:${stableMutationFingerprint({ operationKey })}`,
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
      sendContentTopicError(res, err, userId, tenantId, 'iOS content topic delete failed', { topicId });
    }
  }));
}

function stableMutationFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest('hex')
    .slice(0, 16);
}

function topicHasSecretaryRefs(topic: ContentTopic): boolean {
  return Boolean(
    (topic.secretary_task_external_id && topic.secretary_task_list_id)
    || (topic.calendar_event_id && topic.calendar_source),
  );
}

function topicScheduleChanged(
  existing: ContentTopic,
  scheduledDate: string | null | undefined,
  scheduledDateTime: string | null | undefined,
): boolean {
  if (scheduledDate !== undefined && scheduledDate !== existing.scheduled_date) return true;
  if (scheduledDateTime !== undefined && scheduledDateTime !== existing.scheduled_at) return true;
  return false;
}

function sendContentTopicError(
  res: Response,
  error: unknown,
  userId: number,
  tenantId: number,
  logMessage: string,
  details: Record<string, unknown> = {},
): void {
  if (error instanceof ContentWorkspaceWriteDisabledError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  if (error instanceof ContentWorkspaceError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  logger.error({ err: error, userId, tenantId, ...details }, logMessage);
  sendInternalError(res, 'Content workspace is temporarily unavailable.');
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
