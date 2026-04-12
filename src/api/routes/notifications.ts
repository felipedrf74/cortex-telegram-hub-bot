// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';

/**
 * Content Notification Inbox — iOS API routes.
 *
 * These endpoints power the iOS notification center and the portal's
 * notification inspector. Notifications are durable — they survive
 * push delivery failures and are the system of record.
 *
 * Lifecycle:
 *   1. Content event creates notification (status='unread')
 *   2. APNs push sent as delivery hint
 *   3. iOS reads via GET /notifications
 *   4. User marks read via POST /notifications/:id/read
 *   5. User resolves via POST /notifications/:id/resolve
 */
export function notificationRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/notifications
   *
   * List notifications for the authenticated user.
   * Query: ?status=unread (default: unread), ?type=topic_candidates_ready, ?limit=20
   */
  router.get('/', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const status = (req.query.status as string) || undefined;
    const type = (req.query.type as string) || undefined;
    const limit = parseInt(String(req.query.limit || '20'), 10);

    const { getNotifications, getUnreadCount } = require('../../services/content-notification-store');

    const notifications = status === undefined
      ? getNotifications(userId, { limit })
      : getNotifications(userId, { status, type, limit });

    const unreadCount = getUnreadCount(userId);

    sendSuccess(res, {
      unreadCount,
      count: notifications.length,
      notifications: notifications.map((n: any) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        data: n.data,
        status: n.status,
        createdAt: n.createdAt,
      })),
    });
  }));

  /**
   * GET /api/v1/notifications/unread-count
   *
   * Just the unread count for badge display.
   */
  router.get('/unread-count', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { getUnreadCount } = require('../../services/content-notification-store');
    sendSuccess(res, { unreadCount: getUnreadCount(userId) });
  }));

  /**
   * POST /api/v1/notifications/:id/read
   *
   * Mark a notification as read.
   */
  router.post('/:id/read', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;
    const { markRead } = require('../../services/content-notification-store');
    const success = markRead(parseInt(id, 10), userId);
    if (!success) {
      sendError(res, 'NOT_FOUND', 'Notification not found', 404);
      return;
    }
    sendSuccess(res, { marked: true });
  }));

  /**
   * POST /api/v1/notifications/read-all
   *
   * Mark all unread notifications as read.
   */
  router.post('/read-all', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { markAllRead } = require('../../services/content-notification-store');
    const count = markAllRead(userId);
    sendSuccess(res, { markedCount: count });
  }));

  /**
   * POST /api/v1/notifications/:id/resolve
   *
   * Resolve a notification (action completed).
   */
  router.post('/:id/resolve', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;
    const { resolveNotification } = require('../../services/content-notification-store');
    const success = resolveNotification(parseInt(id, 10), userId);
    if (!success) {
      sendError(res, 'NOT_FOUND', 'Notification not found', 404);
      return;
    }
    sendSuccess(res, { resolved: true });
  }));

  return router;
}
