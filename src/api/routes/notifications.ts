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

  /**
   * GET /api/v1/notifications/inbox
   *
   * Unified inbox feed — merges content notifications + report documents
   * into a single chronologically-sorted list.
   *
   * Each item has:
   *   kind: 'notification' | 'report'
   *   id, title, body/summary, type, status, createdAt
   *
   * Query: ?limit=30
   */
  router.get('/inbox', asyncHandler(async (req, res: Response) => {
    const { userId } = req as unknown as AuthenticatedRequest;
    const limit = parseInt(String(req.query.limit || '30'), 10);

    const { getNotifications, getUnreadCount } = require('../../services/content-notification-store');
    const { getRecentReports, getUnreadReportCount } = require('../../services/report-document-store');

    // Fetch both sources
    const notifications = getNotifications(userId, { limit });
    const reports = getRecentReports(userId, { limit });
    const unreadNotifications = getUnreadCount(userId);
    const unreadReports = getUnreadReportCount(userId);

    // Merge into unified feed
    type InboxItem = {
      kind: 'notification' | 'report';
      id: number;
      title: string;
      body: string | null;
      type: string;
      status: string;
      createdAt: string;
    };

    const items: InboxItem[] = [
      ...notifications.map((n: any) => ({
        kind: 'notification' as const,
        id: n.id,
        title: n.title,
        body: n.body,
        type: n.type,
        status: n.status,
        createdAt: n.createdAt,
      })),
      ...reports.map((r: any) => ({
        kind: 'report' as const,
        id: r.id,
        title: r.title,
        body: r.summary,
        type: r.type,
        status: r.status,
        createdAt: r.createdAt,
      })),
    ];

    // Sort by createdAt DESC (most recent first)
    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    sendSuccess(res, {
      totalUnread: unreadNotifications + unreadReports,
      count: Math.min(items.length, limit),
      items: items.slice(0, limit),
    });
  }));

  return router;
}
