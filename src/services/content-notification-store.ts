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
 *   3. Secretary Notification Orchestrator decides delivery/push
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
import {
  contentPrivateScopeParams,
  contentPrivateScopePredicate,
  ensureContentTenantScopeColumns,
} from './content-tenant-scope';

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

export interface ContentNotificationPortalScope {
  userId: number;
  tenantId: number;
}

export type ContentNotificationDeepLinkTargetKind =
  | 'approval'
  | 'source_review'
  | 'workflow_object'
  | 'script'
  | 'topic'
  | 'radar_signal'
  | 'reference'
  | 'pipeline_item'
  | 'weekly_package'
  | 'performance'
  | 'agent_insight'
  | 'content_home';

export interface ContentNotificationDeepLink {
  targetKind: ContentNotificationDeepLinkTargetKind;
  targetId: string | null;
  screen: string;
  route: string;
  action: string;
  canOpenConcreteTarget: boolean;
  reasonCodes: string[];
  fallback: {
    screen: 'contentHome';
    route: 'content/home';
  };
  markReadEndpoint: string;
  resolveEndpoint: string;
  sourceDataKeys: string[];
}

export interface ContentNotificationResolution {
  notification: ContentNotification;
  deepLink: ContentNotificationDeepLink;
  contractVersion: 1;
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

/**
 * Legacy notification fixtures and pre-scope databases may still expose the
 * migration-061 table shape. Prepare/backfill its tenant columns before any
 * query embeds a tenant-scope predicate so compatibility reads fail closed
 * instead of degrading badge or inbox results.
 */
function getScopedContentNotificationDb(): ReturnType<typeof getDb> {
  const db = getDb();
  ensureContentTenantScopeColumns(db);
  return db;
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
 * Create a notification AND emit a central NotificationIntent.
 * The orchestrator decides whether push, digest, in-app only, or quiet-hours
 * delay is appropriate. Skills must not call APNs directly.
 */
// createAndPushNotification (the legacy-store→orchestrator bridge) was
// removed 2026-07-04: its last producer (Garmin reauth) now emits a
// first-class orchestrator intent. The legacy table stays READ-ONLY for
// historical rows; the read/merge/badge-exclusion paths below remain until
// phase-2 retirement drains them.
export function getUnreadNotifications(
  userId: number,
  limit = 20,
  tenantId: number = userId,
): ContentNotification[] {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidNotificationScope('get_unread_content_notifications', userId, { limit, tenantId });
    return [];
  }

  const db = getScopedContentNotificationDb();
  const rows = db.prepare(`
    SELECT * FROM content_notifications
    WHERE status = 'unread'
      AND ${contentPrivateScopePredicate()}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...contentPrivateScopeParams(userId, tenantId), limit) as any[];
  return rows.map(mapNotification);
}

/**
 * Get all notifications for a user (any status). Most recent first.
 */
export function getNotifications(
  userId: number,
  opts: { status?: NotificationStatus; type?: NotificationType; limit?: number; tenantId?: number } = {},
): ContentNotification[] {
  const tenantId = opts.tenantId ?? userId;
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidNotificationScope('get_content_notifications', userId, {
      status: opts.status ?? null,
      notificationType: opts.type ?? null,
      limit: opts.limit ?? null,
      tenantId,
    });
    return [];
  }

  const db = getScopedContentNotificationDb();
  const clauses = [contentPrivateScopePredicate()];
  const params: any[] = [...contentPrivateScopeParams(userId, tenantId)];

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
export function getUnreadCount(userId: number, tenantId: number = userId): number {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidNotificationScope('get_unread_content_notification_count', userId, { tenantId });
    return 0;
  }

  const db = getScopedContentNotificationDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM content_notifications
    WHERE status = 'unread'
      AND ${contentPrivateScopePredicate()}
  `).get(...contentPrivateScopeParams(userId, tenantId)) as any;
  return row?.cnt ?? 0;
}

/**
 * List unread legacy notification ids for the given types. Backs the
 * entity-stable bridge dedupe key (`content:<type>:<userId>`): one active
 * center item covers every unread legacy row of that user+type, so the
 * orchestrator expands the key into concrete legacy ids for badge exclusion
 * (getUnreadCountExcludingNotificationIds and the unified-inbox list filter).
 */
export function listUnreadContentNotificationIdsByTypes(
  userId: number,
  types: string[],
  tenantId: number = userId,
): number[] {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidNotificationScope('list_unread_content_notification_ids_by_types', userId, {
      typeCount: types.length,
      tenantId,
    });
    return [];
  }

  const validTypes = Array.from(new Set(
    types.filter((type) => typeof type === 'string' && type.trim().length > 0),
  ));
  if (validTypes.length === 0) return [];

  const placeholders = validTypes.map(() => '?').join(',');
  const rows = getScopedContentNotificationDb().prepare(`
    SELECT id
    FROM content_notifications
    WHERE status = 'unread'
      AND ${contentPrivateScopePredicate()}
      AND type IN (${placeholders})
  `).all(...contentPrivateScopeParams(userId, tenantId), ...validTypes) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/**
 * Count unread legacy content notifications while excluding rows that already
 * have a canonical Notification Center item. The legacy row remains domain
 * history; the central item owns badge/unread contribution.
 *
 * Callers pass concrete legacy row ids: for legacy bridge keys these come
 * straight from the key; for entity-stable keys the orchestrator expands the
 * key via listUnreadContentNotificationIdsByTypes before calling this.
 */
export function getUnreadCountExcludingNotificationIds(
  userId: number,
  excludedIds: number[],
  tenantId: number = userId,
): number {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidNotificationScope('get_unread_content_notification_count_excluding_ids', userId, {
      excludedCount: excludedIds.length,
      tenantId,
    });
    return 0;
  }

  const ids = normalizePositiveIds(excludedIds);
  if (ids.length === 0) return getUnreadCount(userId, tenantId);

  const placeholders = ids.map(() => '?').join(',');
  const row = getScopedContentNotificationDb().prepare(`
    SELECT COUNT(*) as cnt
    FROM content_notifications
    WHERE status = 'unread'
      AND ${contentPrivateScopePredicate()}
      AND id NOT IN (${placeholders})
  `).get(...contentPrivateScopeParams(userId, tenantId), ...ids) as any;
  return row?.cnt ?? 0;
}

/**
 * Read one notification for an authenticated user.
 *
 * This is intentionally scoped by effective tenant and private owner before
 * any resolver data is returned. NULL legacy scope falls back to user_id only
 * inside that user's personal tenant.
 */
export function getNotificationById(
  notificationId: number,
  userId: number,
  tenantId: number = userId,
): ContentNotification | null {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidNotificationScope('get_content_notification_by_id', userId, {
      notificationId,
      tenantId,
    });
    return null;
  }
  if (!Number.isFinite(notificationId) || notificationId <= 0) {
    return null;
  }

  const db = getScopedContentNotificationDb();
  const row = db.prepare(`
    SELECT * FROM content_notifications
    WHERE id = ?
      AND ${contentPrivateScopePredicate()}
    LIMIT 1
  `).get(notificationId, ...contentPrivateScopeParams(userId, tenantId)) as any;

  return row ? mapNotification(row) : null;
}

/**
 * Resolve a content notification to an iOS/portal navigation target.
 *
 * The resolver is read-only: it does not mark notifications as read or
 * resolved. Clients can use the returned mutation endpoints after navigation.
 */
export function resolveContentNotificationDeepLink(
  notificationId: number,
  userId: number,
  tenantId: number = userId,
): ContentNotificationResolution | null {
  const notification = getNotificationById(notificationId, userId, tenantId);
  if (!notification) return null;

  return {
    notification,
    deepLink: buildContentNotificationDeepLink(notification),
    contractVersion: 1,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Update
// ═══════════════════════════════════════════════════════════════════

/**
 * Mark a notification as read.
 */
export function markRead(notificationId: number, userId: number, tenantId: number = userId): boolean {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidNotificationScope('mark_content_notification_read', userId, {
      notificationId,
      tenantId,
    });
    return false;
  }

  const db = getScopedContentNotificationDb();
  const result = db.prepare(`
    UPDATE content_notifications
    SET status = 'read'
    WHERE id = ?
      AND ${contentPrivateScopePredicate()}
  `).run(notificationId, ...contentPrivateScopeParams(userId, tenantId));
  return result.changes > 0;
}

/**
 * Mark all unread notifications as read for a user.
 */
export function markAllRead(userId: number, tenantId: number = userId): number {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidNotificationScope('mark_all_content_notifications_read', userId, { tenantId });
    return 0;
  }

  const db = getScopedContentNotificationDb();
  const result = db.prepare(`
    UPDATE content_notifications
    SET status = 'read'
    WHERE status = 'unread'
      AND ${contentPrivateScopePredicate()}
  `).run(...contentPrivateScopeParams(userId, tenantId));
  return result.changes;
}

/**
 * Resolve a notification (action completed).
 */
export function resolveNotification(notificationId: number, userId: number, tenantId: number = userId): boolean {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidNotificationScope('resolve_content_notification', userId, {
      notificationId,
      tenantId,
    });
    return false;
  }

  const db = getScopedContentNotificationDb();
  const result = db.prepare(`
    UPDATE content_notifications
    SET status = 'resolved', resolved_at = datetime('now')
    WHERE id = ?
      AND ${contentPrivateScopePredicate()}
  `).run(notificationId, ...contentPrivateScopeParams(userId, tenantId));
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
 * Get legacy content notifications for a single authenticated portal scope.
 * Portal callers must never fall back to an all-tenant read.
 */
export function getAllNotifications(
  limit = 100,
  scope: ContentNotificationPortalScope,
): ContentNotification[] {
  if (!scope || !isValidTenantUserId(scope.userId) || !isValidTenantUserId(scope.tenantId) || scope.userId !== scope.tenantId) {
    reportInvalidNotificationScope('portal_list_content_notifications', scope?.userId, {
      tenantId: scope?.tenantId,
    });
    throw new Error('notification tenant scope required');
  }
  const db = getScopedContentNotificationDb();
  const rows = db.prepare(`
    SELECT * FROM content_notifications
    WHERE ${contentPrivateScopePredicate()}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...contentPrivateScopeParams(scope.userId, scope.tenantId), limit) as any[];
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

function normalizePositiveIds(ids: number[]): number[] {
  return Array.from(new Set(
    ids
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0),
  ));
}

function buildContentNotificationDeepLink(notification: ContentNotification): ContentNotificationDeepLink {
  const data = isRecord(notification.data) ? notification.data : {};
  const target = resolveDeepLinkTarget(notification, data);
  const action = resolveDeepLinkAction(notification, data, target.targetKind);
  const concreteTarget = target.targetKind !== 'content_home' && target.targetId !== null;
  const reasonCodes = [...target.reasonCodes];

  if (!concreteTarget && !reasonCodes.includes('no_concrete_content_target')) {
    reasonCodes.push('no_concrete_content_target');
  }

  return {
    targetKind: target.targetKind,
    targetId: target.targetId,
    screen: target.screen,
    route: target.route,
    action,
    canOpenConcreteTarget: concreteTarget,
    reasonCodes,
    fallback: {
      screen: 'contentHome',
      route: 'content/home',
    },
    markReadEndpoint: `/api/v1/notifications/${notification.id}/read`,
    resolveEndpoint: `/api/v1/notifications/${notification.id}/resolve`,
    sourceDataKeys: Object.keys(data).sort(),
  };
}

function resolveDeepLinkTarget(
  notification: ContentNotification,
  data: Record<string, unknown>,
): {
  targetKind: ContentNotificationDeepLinkTargetKind;
  targetId: string | null;
  screen: string;
  route: string;
  reasonCodes: string[];
} {
  const contentObjectId = firstScalar(data, ['contentObjectId', 'workflowObjectId', 'objectId', 'draftId', 'ideaId']);
  const sourceReviewId = firstScalar(data, ['sourceReviewId', 'source_review_id']);
  const approvalId = firstScalar(data, ['approvalId', 'approval_id']);
  const scriptId = firstScalar(data, ['scriptId', 'script_id']);
  const topicId = firstScalar(data, ['topicId', 'topic_id']);
  const radarSignalId = firstScalar(data, ['radarSignalId', 'signalId', 'radar_signal_id', 'signal_id']);
  const referenceId = firstScalar(data, ['referenceId', 'reference_id']);
  const pipelineId = firstScalar(data, ['pipelineId', 'pipeline_id']);
  const weeklyPackageId = firstScalar(data, ['weeklyPackageId', 'weekly_package_id', 'packageId']);
  const performanceId = firstScalar(data, ['performanceId', 'performance_id']);
  const insightId = firstScalar(data, ['insightId', 'insight_id']);
  const requestedAction = firstScalar(data, ['action', 'requiredAction']);

  if (isSourceReviewAction(requestedAction) && contentObjectId) {
    return target('source_review', contentObjectId, 'contentSourceReview', `content/workflow/${contentObjectId}/source-review`, [
      'source_review_action_target',
    ]);
  }
  if (sourceReviewId) {
    return target('source_review', sourceReviewId, 'contentSourceReview', `content/source-reviews/${sourceReviewId}`, [
      'source_review_id_target',
    ]);
  }
  if (approvalId && contentObjectId) {
    return target('approval', contentObjectId, 'contentApproval', `content/workflow/${contentObjectId}/approval`, [
      'approval_target_from_workflow_object',
    ]);
  }
  if (approvalId) {
    return target('approval', approvalId, 'contentApproval', `content/approvals/${approvalId}`, [
      'approval_id_target',
    ]);
  }
  if (contentObjectId) {
    return target('workflow_object', contentObjectId, 'contentWorkflow', `content/workflow/${contentObjectId}`, [
      'workflow_object_target',
    ]);
  }
  if (scriptId) {
    return target('script', scriptId, 'contentScript', `content/scripts/${scriptId}`, [
      'script_target',
    ]);
  }
  if (topicId) {
    return target('topic', topicId, 'contentTopic', `content/topics/${topicId}`, [
      'topic_target',
    ]);
  }
  if (radarSignalId) {
    return target('radar_signal', radarSignalId, 'contentRadarSignal', `content/radar/${radarSignalId}`, [
      'radar_signal_target',
    ]);
  }
  if (referenceId) {
    return target('reference', referenceId, 'contentReference', `content/references/${referenceId}`, [
      'reference_target',
    ]);
  }
  if (pipelineId) {
    return target('pipeline_item', pipelineId, 'contentPipelineItem', `content/pipeline/${pipelineId}`, [
      'pipeline_item_target',
    ]);
  }
  if (weeklyPackageId) {
    return target('weekly_package', weeklyPackageId, 'contentWeeklyPackage', `content/weekly-packages/${weeklyPackageId}`, [
      'weekly_package_target',
    ]);
  }
  if (performanceId || notification.type === 'performance_logged') {
    return target('performance', performanceId, 'contentPerformance', performanceId ? `content/performance/${performanceId}` : 'content/performance', [
      performanceId ? 'performance_target' : 'performance_summary_target',
    ]);
  }
  if (insightId || notification.type === 'agent_insight') {
    return target('agent_insight', insightId, 'contentInsight', insightId ? `content/insights/${insightId}` : 'content/insights', [
      insightId ? 'agent_insight_target' : 'agent_insight_summary_target',
    ]);
  }

  if (notification.type === 'topic_candidates_ready') {
    return target('content_home', null, 'contentHome', 'content/home', [
      'topic_candidates_without_topic_id',
    ]);
  }
  if (notification.type === 'weekly_package_ready') {
    return target('content_home', null, 'contentHome', 'content/home', [
      'weekly_package_without_package_id',
    ]);
  }

  return target('content_home', null, 'contentHome', 'content/home', [
    'no_supported_artifact_id',
  ]);
}

function target(
  targetKind: ContentNotificationDeepLinkTargetKind,
  targetId: string | null,
  screen: string,
  route: string,
  reasonCodes: string[],
): {
  targetKind: ContentNotificationDeepLinkTargetKind;
  targetId: string | null;
  screen: string;
  route: string;
  reasonCodes: string[];
} {
  return { targetKind, targetId, screen, route, reasonCodes };
}

function resolveDeepLinkAction(
  notification: ContentNotification,
  data: Record<string, unknown>,
  targetKind: ContentNotificationDeepLinkTargetKind,
): string {
  const explicitAction = firstScalar(data, ['action', 'requiredAction']);
  if (explicitAction) return normalizeAction(explicitAction);

  if (targetKind === 'source_review') return 'review_sources';
  if (targetKind === 'approval') return 'review_approval';

  switch (notification.type) {
    case 'topic_candidates_ready':
      return 'review_topics';
    case 'weekly_package_ready':
      return 'open_weekly_package';
    case 'script_ready':
      return 'open_script';
    case 'content_action_required':
      return 'review_required_action';
    case 'performance_logged':
      return 'open_performance';
    case 'agent_insight':
      return 'open_insight';
    default:
      return 'open_content';
  }
}

function normalizeAction(action: string): string {
  return action.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'open_content';
}

function isSourceReviewAction(action: string | null): boolean {
  if (!action) return false;
  const normalized = normalizeAction(action);
  return normalized === 'source_review' || normalized === 'review_sources' || normalized === 'source_review_required';
}

function firstScalar(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeParseJSON(val: any, fallback: any): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function mapContentTypeToIntentType(type: NotificationType): import('./notification-orchestrator').NotificationIntentType {
  switch (type) {
    case 'script_ready':
    case 'content_action_required':
      return 'approval_required';
    case 'topic_candidates_ready':
    case 'weekly_package_ready':
      return 'decision_required';
    case 'performance_logged':
    case 'agent_insight':
    default:
      return 'insight';
  }
}

function mapContentTypeToPriority(type: NotificationType): import('./notification-orchestrator').NotificationPriority {
  switch (type) {
    case 'script_ready':
    case 'content_action_required':
      return 'active';
    case 'topic_candidates_ready':
    case 'weekly_package_ready':
    case 'performance_logged':
    case 'agent_insight':
    default:
      return 'passive';
  }
}

function isContentApprovalNotification(type: NotificationType): boolean {
  return type === 'script_ready' || type === 'content_action_required';
}

function mapContentTypeToActions(type: NotificationType, executableApproval = false): import('./notification-orchestrator').NotificationActionButton[] {
  if (isContentApprovalNotification(type) && executableApproval) {
    return [
      { id: 'approve_script', label: 'Approve', style: 'primary' },
      { id: 'request_rewrite', label: 'Rewrite', style: 'secondary' },
    ];
  }
  if (isContentApprovalNotification(type)) {
    return [{ id: 'open_detail', label: 'Review', style: 'primary' }];
  }
  return [{ id: 'open_detail', label: 'Open', style: 'primary' }];
}

function contentNotificationDeeplink(notificationId: number, data?: Record<string, any>): string {
  const scriptId = data?.scriptId ?? data?.script_id;
  if (scriptId) return `nexus://content/script/${scriptId}`;
  return `nexus://notifications/${notificationId}`;
}
