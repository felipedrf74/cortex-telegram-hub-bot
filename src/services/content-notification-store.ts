// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Content Notification Store — durable inbox for the iOS app and portal.
 *
 * This is the SYSTEM OF RECORD for content notifications. Push
 * notifications (APNs) are delivery adapters on top of this model.
 *
 * The lifecycle of a notification:
 *   1. Created by a content event (topic ready, script generated, etc.)
 *   2. Stored in content_notifications table (status='unread')
 *   3. APNs push sent as a delivery hint (push_sent=1)
 *   4. iOS app reads via GET /api/v1/notifications
 *   5. User marks as read (status='read')
 *   6. User resolves the action (status='resolved')
 *
 * If the push fails (device offline, token expired), the notification
 * is still durable in the DB. The app fetches unread notifications
 * on launch and catches up.
 *
 * Consumers:
 *   - content-workflow.ts — creates notifications after topic/script generation
 *   - scheduler.ts — creates notifications for scheduled content jobs
 *   - iOS API routes — lists, marks read, resolves
 *   - portal — admin view of all notifications
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type NotificationType =
  | 'topic_candidates_ready'
  | 'weekly_package_ready'
  | 'script_ready'
  | 'content_action_required'
  | 'performance_logged'
  | 'agent_insight';

export type NotificationStatus = 'unread' | 'read' | 'resolved';

export interface ContentNotification {
  id: number;
  userId: number;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, any>;
  status: NotificationStatus;
  pushSent: boolean;
  pushSentAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

function reportInvalidNotificationScope(
  operation: string,
  userId: number | undefined,
  details?: Record<string, unknown>,
): void {
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: userId == null ? 'missing_user_scope' : 'invalid_user_scope',
    userId: userId ?? null,
    details,
  });
}

// ═══════════════════════════════════════════════════════════════════
// Create
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a content notification. Returns the notification ID.
 *
 * This is the primary write path — all content events go through here.
 * APNs push is sent separately via the delivery adapter.
 */
export function createNotification(opts: {
  userId: number;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, any>;
}): number {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidNotificationScope('create_content_notification', opts.userId, {
      notificationType: opts.type,
    });
    return -1;
  }

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO content_notifications (user_id, type, title, body, data)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    opts.userId,
    opts.type,
    opts.title,
    opts.body,
    JSON.stringify(opts.data ?? {}),
  );
  const id = Number(result.lastInsertRowid);
  logger.info({ notificationId: id, type: opts.type, userId: opts.userId }, 'Content notification created');
  return id;
}

/**
 * Create a notification AND send a push via APNs.
 * The push is a delivery hint — the notification is durable regardless.
 */
export async function createAndPushNotification(opts: {
  userId: number;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, any>;
}): Promise<number> {
  const id = createNotification(opts);
  if (id <= 0) {
    return -1;
  }

  // Try APNs push (non-blocking, non-fatal)
  try {
    const { sendPushNotification } = await import('./apns-sender');
    const result = await sendPushNotification(opts.userId, {
      title: opts.title,
      body: opts.body,
      data: { notificationId: id, type: opts.type, ...opts.data },
      threadId: `content-${opts.type}`,
      sound: 'default',
    });

    if (result.sent) {
      markPushSent(id);
    }
  } catch (err) {
    logger.debug({ err, notificationId: id }, 'APNs push skipped (non-fatal)');
  }

  return id;
}

// ═══════════════════════════════════════════════════════════════════
// Read
// ═══════════════════════════════════════════════════════════════════

/**
 * Get unread notifications for a user. Most recent first.
 */
export function getUnreadNotifications(
  userId: number,
  limit = 20,
): ContentNotification[] {
  if (!isValidTenantUserId(userId)) {
    reportInvalidNotificationScope('get_unread_content_notifications', userId, { limit });
    return [];
  }

  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM content_notifications
    WHERE user_id = ? AND status = 'unread'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit) as any[];
  return rows.map(mapNotification);
}

/**
 * Get all notifications for a user (any status). Most recent first.
 */
export function getNotifications(
  userId: number,
  opts: { status?: NotificationStatus; type?: NotificationType; limit?: number } = {},
): ContentNotification[] {
  if (!isValidTenantUserId(userId)) {
    reportInvalidNotificationScope('get_content_notifications', userId, {
      status: opts.status ?? null,
      notificationType: opts.type ?? null,
      limit: opts.limit ?? null,
    });
    return [];
  }

  const db = getDb();
  const clauses = ['user_id = ?'];
  const params: any[] = [userId];

  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  if (opts.type) {
    clauses.push('type = ?');
    params.push(opts.type);
  }

  params.push(opts.limit ?? 50);

  const rows = db.prepare(`
    SELECT * FROM content_notifications
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as any[];
  return rows.map(mapNotification);
}

/**
 * Get unread count for badge display.
 */
export function getUnreadCount(userId: number): number {
  if (!isValidTenantUserId(userId)) {
    reportInvalidNotificationScope('get_unread_content_notification_count', userId);
    return 0;
  }

  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM content_notifications WHERE user_id = ? AND status = 'unread'",
  ).get(userId) as any;
  return row?.cnt ?? 0;
}

// ═══════════════════════════════════════════════════════════════════
// Update
// ═══════════════════════════════════════════════════════════════════

/**
 * Mark a notification as read.
 */
export function markRead(notificationId: number, userId: number): boolean {
  if (!isValidTenantUserId(userId)) {
    reportInvalidNotificationScope('mark_content_notification_read', userId, {
      notificationId,
    });
    return false;
  }

  const db = getDb();
  const result = db.prepare(
    "UPDATE content_notifications SET status = 'read' WHERE id = ? AND user_id = ?",
  ).run(notificationId, userId);
  return result.changes > 0;
}

/**
 * Mark all unread notifications as read for a user.
 */
export function markAllRead(userId: number): number {
  if (!isValidTenantUserId(userId)) {
    reportInvalidNotificationScope('mark_all_content_notifications_read', userId);
    return 0;
  }

  const db = getDb();
  const result = db.prepare(
    "UPDATE content_notifications SET status = 'read' WHERE user_id = ? AND status = 'unread'",
  ).run(userId);
  return result.changes;
}

/**
 * Resolve a notification (action completed).
 */
export function resolveNotification(notificationId: number, userId: number): boolean {
  if (!isValidTenantUserId(userId)) {
    reportInvalidNotificationScope('resolve_content_notification', userId, {
      notificationId,
    });
    return false;
  }

  const db = getDb();
  const result = db.prepare(
    "UPDATE content_notifications SET status = 'resolved', resolved_at = datetime('now') WHERE id = ? AND user_id = ?",
  ).run(notificationId, userId);
  return result.changes > 0;
}

/**
 * Mark push as sent (internal — called after successful APNs delivery).
 */
function markPushSent(notificationId: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE content_notifications SET push_sent = 1, push_sent_at = datetime('now') WHERE id = ?",
  ).run(notificationId);
}

// ═══════════════════════════════════════════════════════════════════
// Admin (Portal)
// ═══════════════════════════════════════════════════════════════════

/**
 * Get all notifications across all users (admin/portal view).
 */
export function getAllNotifications(limit = 100): ContentNotification[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM content_notifications
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map(mapNotification);
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function mapNotification(row: any): ContentNotification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: safeParseJSON(row.data, {}),
    status: row.status,
    pushSent: !!row.push_sent,
    pushSentAt: row.push_sent_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

function safeParseJSON(val: any, fallback: any): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}
