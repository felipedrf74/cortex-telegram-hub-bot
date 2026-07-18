// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response, Router } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { logger } from '../../utils/logger';
import {
  CONTENT_CALENDAR_SCHEMA_VERSION,
  CONTENT_SCHEDULE_SCHEMA_VERSION,
  ContentScheduleError,
  cancelContentSchedule,
  confirmContentSchedulePreview,
  createContentSchedulePreview,
  getContentCalendar,
  getContentSchedule,
  type ContentScheduleWorkKind,
} from '../../services/content-workspace-scheduling';
import type { ContentWorkspaceScope } from '../../services/content-workspace';
import { ContentWorkspaceWriteDisabledError } from '../../services/content-workspace-capabilities';

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export function registerContentWorkspaceScheduleRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  /**
   * Canonical calendar read model. Deadlines are target dates and Secretary
   * entries are private work blocks; this route never represents publishing.
   */
  router.get('/workspace/calendar', (req, res: Response) => {
    const scope = resolveScheduleScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_calendar_read',
    );
    if (!scope) return;
    try {
      const calendar = getContentCalendar({
        scope,
        from: readRequiredQueryString(req.query.from, 'from'),
        to: readRequiredQueryString(req.query.to, 'to'),
        limit: readOptionalQueryInteger(req.query.limit, 'limit'),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_CALENDAR_SCHEMA_VERSION,
        calendar,
      });
    } catch (error) {
      sendScheduleError(res, error, scope, 'content calendar read failed');
    }
  });

  /** Preview is read-only in Secretary; it never creates an agenda or provider event. */
  router.post('/workspace/items/:itemId/schedule-previews', (req, res: Response) => {
    const scope = resolveScheduleScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_schedule_preview_create',
      { itemId: req.params.itemId },
    );
    if (!scope) return;
    try {
      const result = createContentSchedulePreview({
        scope,
        itemId: Number(req.params.itemId),
        artifactId: req.body?.artifactId,
        workKind: req.body?.workKind as ContentScheduleWorkKind,
        durationMinutes: req.body?.durationMinutes,
        preferredWindows: req.body?.preferredWindows,
        deadlineAt: req.body?.deadlineAt,
        priority: req.body?.priority,
        shareContentTitle: req.body?.shareContentTitle,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_SCHEDULE_SCHEMA_VERSION,
        preview: result.value,
        mutation: { replayed: result.replayed, changed: result.changed },
      }, { status: result.changed ? 201 : 200 });
    } catch (error) {
      sendScheduleError(res, error, scope, 'content schedule preview failed');
    }
  });

  /** Explicit user confirmation is the sole schedule-creation boundary. */
  router.post('/workspace/schedule-previews/:previewKey/confirm', (req, res: Response) => {
    const scope = resolveScheduleScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_schedule_preview_confirm',
      { previewKey: req.params.previewKey },
    );
    if (!scope) return;
    try {
      const result = confirmContentSchedulePreview({
        scope,
        previewKey: req.params.previewKey,
        selectedSlot: req.body?.selectedSlot,
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_SCHEDULE_SCHEMA_VERSION,
        schedule: result.value,
        mutation: { replayed: result.replayed, changed: result.changed },
      }, { status: result.changed ? 201 : 200 });
    } catch (error) {
      sendScheduleError(res, error, scope, 'content schedule confirmation failed');
    }
  });

  /** Presentation-safe schedule projection; Secretary remains agenda authority. */
  router.get('/workspace/items/:itemId/schedule', (req, res: Response) => {
    const scope = resolveScheduleScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_schedule_read',
      { itemId: req.params.itemId },
    );
    if (!scope) return;
    try {
      sendSuccess(res, {
        schemaVersion: CONTENT_SCHEDULE_SCHEMA_VERSION,
        schedule: getContentSchedule(scope, Number(req.params.itemId)),
      });
    } catch (error) {
      sendScheduleError(res, error, scope, 'content schedule read failed');
    }
  });

  /** Cancellation is durable and truthfully distinguishes provider cleanup. */
  router.post('/workspace/items/:itemId/schedule-cancel', (req, res: Response) => {
    const scope = resolveScheduleScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_schedule_cancel',
      { itemId: req.params.itemId },
    );
    if (!scope) return;
    try {
      const result = cancelContentSchedule({
        scope,
        itemId: Number(req.params.itemId),
        idempotencyKey: readIdempotencyKey(req),
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_SCHEDULE_SCHEMA_VERSION,
        schedule: result.value,
        mutation: { replayed: result.replayed, changed: result.changed },
      });
    } catch (error) {
      sendScheduleError(res, error, scope, 'content schedule cancellation failed');
    }
  });
}

function resolveScheduleScope(
  req: AuthenticatedRequest,
  res: Response,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
  operation: string,
  details?: Record<string, unknown>,
): ContentWorkspaceScope | null {
  if (!ensureValidContentRouteScope(res, req.userId, operation, details)) return null;
  if (!Number.isInteger(req.tenantId) || Number(req.tenantId) <= 0) {
    sendError(res, 'CONTENT_TENANT_SCOPE_REQUIRED', 'A valid tenant scope is required.', 401);
    return null;
  }
  if (Number(req.tenantId) !== req.userId) {
    sendError(res, 'CONTENT_TENANT_SCOPE_MISMATCH', 'The active tenant does not match the authenticated session.', 403);
    return null;
  }
  return { tenantId: Number(req.tenantId), userId: req.userId };
}

function readIdempotencyKey(req: { body?: any; header(name: string): string | undefined }): string {
  if (typeof req.body?.idempotencyKey === 'string') return req.body.idempotencyKey;
  return req.header('x-idempotency-key') ?? '';
}

function readRequiredQueryString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContentScheduleError(
      'CONTENT_VALIDATION_FAILED',
      `${field} is required and must be an ISO date-time.`,
      400,
      { field },
    );
  }
  return value.trim();
}

function readOptionalQueryInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ContentScheduleError(
      'CONTENT_VALIDATION_FAILED',
      `${field} must be a positive integer.`,
      400,
      { field },
    );
  }
  return Number(value);
}

function sendScheduleError(
  res: Response,
  error: unknown,
  scope: ContentWorkspaceScope,
  logMessage: string,
): void {
  if (error instanceof ContentWorkspaceWriteDisabledError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  if (error instanceof ContentScheduleError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  logger.error({
    err: error,
    tenantId: scope.tenantId,
    userId: scope.userId,
  }, logMessage);
  sendInternalError(res, 'Content scheduling is temporarily unavailable. No publication was performed.');
}
