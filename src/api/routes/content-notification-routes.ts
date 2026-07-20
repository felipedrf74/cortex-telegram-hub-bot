// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendSuccess } from '../response-helpers';
import { resolveContentNotificationDeepLink } from '../../services/content-notification-store';

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export function registerContentNotificationRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  /**
   * GET /api/v1/content/notifications/:id
   *
   * Read-only resolver for Content notification deep links. The generic
   * notification inbox remains under /api/v1/notifications; this route turns
   * an authenticated user's durable notification into a concrete Content
   * artifact/action target for iOS and portal clients.
   */
  router.get('/notifications/:id', asyncHandler(async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_notification_resolve', {
      notificationId: req.params.id,
    })) return;

    const notificationId = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(notificationId) || notificationId <= 0) {
      sendError(res, 'BAD_REQUEST', 'notification id must be a positive integer', 400);
      return;
    }

    const resolution = resolveContentNotificationDeepLink(notificationId, userId, tenantId);
    if (!resolution) {
      sendError(res, 'NOT_FOUND', 'Content notification not found', 404);
      return;
    }

    sendSuccess(res, resolution);
  }));
}
