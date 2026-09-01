// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Report Document Store — durable structured reports for iOS + portal.
 *
 * Reports (morning briefing, evening summary, weekly review, coach briefing)
 * are stored as structured JSON documents. The iOS app renders them natively;
 * the portal inspects them for operational visibility.
 *
 * Lifecycle:
 *   1. Scheduler generates report → storeReport()
 *   2. Secretary Notification Orchestrator decides delivery hints
 *   3. iOS fetches via GET /api/v1/reports
 *   4. User opens → markRead(reportId)
 *   5. Portal admin views all reports via GET /api/reports
 *
 * Pattern mirrors content-notification-store.ts.
 */

import { getDb } from './database';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type ReportType =
  | 'morning_briefing'
  | 'evening_summary'
  | 'weekly_review'
  | 'coach_briefing'
  | 'decision_briefing'
  | 'coach_phase'; // persistent training coach narrative state across weeks

export const REPORT_TYPES: readonly ReportType[] = [
  'morning_briefing',
  'evening_summary',
  'weekly_review',
  'coach_briefing',
  'decision_briefing',
  'coach_phase',
];

export function isReportType(value: unknown): value is ReportType {
  return typeof value === 'string' && (REPORT_TYPES as readonly string[]).includes(value);
}

export interface ReportDocument {
  id: number;
  userId: number;
  tenantId: number;
  type: ReportType;
  title: string;
  summary: string | null;
  documentJson: Record<string, any>;
  sourceJob: string | null;
  status: 'unread' | 'read';
  readAt: string | null;
  createdAt: string;
}

function reportInvalidReportScope(
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
 * Store a durable report document. Returns the report ID.
 *
 * Called by scheduler cron jobs after generating report content.
 * The documentJson should be the FULL structured payload that iOS
 * renders natively — not Telegram HTML.
 */
export function storeReport(opts: {
  userId: number;
  /** Canonical tenant scope. Legacy/manual callers default to the user's own tenant. */
  tenantId?: number;
  type: ReportType;
  title: string;
  summary?: string;
  documentJson: Record<string, any>;
  sourceJob?: string;
  /** Stable scheduler-owned key for crash-safe report replay. */
  dispatchKey?: string;
}): number {
  const tenantId = opts.tenantId ?? opts.userId;
  if (!isValidTenantUserId(opts.userId) || !isValidTenantUserId(tenantId)) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation: 'store_report',
      reason: opts.userId == null ? 'missing_user_scope' : 'invalid_user_scope',
      userId: opts.userId ?? null,
      details: {
        tenantId,
        reportType: opts.type,
        sourceJob: opts.sourceJob ?? null,
      },
    });
    return -1;
  }

  const db = getDb();
  const dispatchKey = normalizeDispatchKey(opts.dispatchKey);
  const insertReport = () => Number(db.prepare(`
      INSERT INTO report_documents_scoped (
        tenant_id, user_id, type, title, summary, document_json, source_job, dispatch_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      opts.userId,
      opts.type,
      opts.title,
      opts.summary ?? null,
      JSON.stringify(opts.documentJson),
      opts.sourceJob ?? null,
      dispatchKey,
    ).lastInsertRowid);
  if (!dispatchKey) {
    const id = insertReport();
    logger.info({ reportId: id, type: opts.type, userId: opts.userId }, 'Report document stored');
    return id;
  }
  const stored = db.transaction(() => {
    const existing = db.prepare(`
      SELECT reports.id
        FROM report_document_dispatch_receipts receipts
        JOIN report_documents_scoped reports ON reports.id = receipts.report_document_id
       WHERE receipts.tenant_id = ?
         AND receipts.user_id = ?
         AND receipts.report_type = ?
         AND receipts.dispatch_key = ?
         AND reports.tenant_id = receipts.tenant_id
         AND reports.user_id = receipts.user_id
         AND reports.type = receipts.report_type
       LIMIT 1
    `).get(tenantId, opts.userId, opts.type, dispatchKey) as { id: number } | undefined;
    if (existing) return { id: existing.id, replayed: true };
    const id = insertReport();
    const receipt = db.prepare(`
      INSERT INTO report_document_dispatch_receipts (
        tenant_id, user_id, report_type, dispatch_key, report_document_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(tenantId, opts.userId, opts.type, dispatchKey, id);
    if (receipt.changes !== 1) throw new Error('REPORT_DOCUMENT_DISPATCH_RECEIPT_NOT_WRITTEN');
    return { id, replayed: false };
  }).immediate();
  const id = stored.id;
  if (stored.replayed) {
    logger.info({ reportId: id, type: opts.type, userId: opts.userId }, 'Report document replayed');
    return id;
  }
  logger.info({ reportId: id, type: opts.type, userId: opts.userId, tenantId }, 'Report document stored');
  return id;
}

/**
 * Store a report AND emit a central NotificationIntent referencing it.
 * The orchestrator decides push/digest/in-app timing and privacy handling.
 */
export async function storeAndPushReport(opts: {
  userId: number;
  /** Canonical tenant scope. Legacy/manual callers default to the user's own tenant. */
  tenantId?: number;
  type: ReportType;
  title: string;
  summary?: string;
  documentJson: Record<string, any>;
  sourceJob?: string;
  pushCategory?: string;
  /** Stable scheduler-owned key reused by the report and Decision proposal. */
  dispatchKey?: string;
  /** Scheduled delivery fails and retries if its durable proposal cannot be created. */
  requireNotificationIntent?: boolean;
}): Promise<number> {
  const tenantId = opts.tenantId ?? opts.userId;
  const id = storeReport(opts);
  if (id <= 0) {
    return -1;
  }

  // Check push preferences before sending
  const stored = getReportById(id, opts.userId, tenantId);
  if (!stored) throw new Error('REPORT_DOCUMENT_READBACK_MISSING');
  if (!isPushEnabled(opts.userId, opts.pushCategory || stored.type)) {
    logger.debug({ userId: opts.userId, type: opts.type }, 'Push suppressed by user preference');
    return id;
  }

  try {
    const { createNotificationIntent, userHasActivePushDeviceToken } = await import('./notification-orchestrator');

    // Optional producer gate (default OFF): with
    // NOTIFICATION_DIGEST_REQUIRE_DEVICE_TOKEN=true, push-less users keep the
    // durable report but no push intent is minted — it could only ever end as
    // a blocked_missing_device_token decision.
    if (
      process.env.NOTIFICATION_DIGEST_REQUIRE_DEVICE_TOKEN === 'true'
      && !userHasActivePushDeviceToken(opts.userId)
    ) {
      logger.debug(
        { userId: opts.userId, reportId: id, type: opts.type },
        'Report stored without notification intent: no active device token',
      );
      return id;
    }

    await createNotificationIntent({
      ...(opts.dispatchKey ? {
        intentId: `ni_report_${createHash('sha256').update(JSON.stringify({
          userId: opts.userId,
          tenantId: stored.tenantId,
          type: stored.type,
          dispatchKey: opts.dispatchKey,
        })).digest('hex').slice(0, 32)}`,
      } : {}),
      userId: opts.userId,
      tenantId: stored.tenantId,
      sourceSkill: mapReportTypeToSourceSkill(stored.type),
      type: mapReportTypeToIntentType(stored.type),
      priority: mapReportTypeToPriority(stored.type),
      relatedEntityId: id,
      relatedEntityType: 'report_document',
      title: stored.title,
      body: stored.summary || 'New report available',
      sensitiveBody: stored.summary || null,
      actionButtons: [{ id: 'open_detail', label: 'Open', style: 'primary' }],
      deeplink: `nexus://notifications/report-${id}`,
      dedupeKey: `report:${stored.type}:${id}`,
      deliveryPolicy: stored.type === 'weekly_review' ? 'digest_only' : 'auto',
      privacyPolicy: stored.type === 'coach_briefing' || stored.type === 'coach_phase' ? 'health' : 'standard',
    });
  } catch (err) {
    if (opts.requireNotificationIntent) throw err;
    logger.debug({ err, reportId: id }, 'Notification intent for report skipped (non-fatal)');
  }

  return id;
}

// ═══════════════════════════════════════════════════════════════════
// Read
// ═══════════════════════════════════════════════════════════════════

/**
 * Get recent reports for a user, optionally filtered by type.
 */
export function getRecentReports(
  userId: number,
  opts: { type?: ReportType; limit?: number; tenantId?: number } = {},
): ReportDocument[] {
  const tenantId = opts.tenantId ?? userId;
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidReportScope('get_recent_reports', userId, {
      reportType: opts.type ?? null,
      limit: opts.limit ?? null,
      tenantId,
    });
    return [];
  }

  const db = getDb();
  const clauses = ['tenant_id = ?', 'user_id = ?'];
  const params: any[] = [tenantId, userId];

  if (opts.type) {
    clauses.push('type = ?');
    params.push(opts.type);
  }

  params.push(opts.limit ?? 20);

  const rows = db.prepare(`
    SELECT * FROM report_documents_scoped
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as any[];

  return rows.map(mapReport);
}

/**
 * Get a single report by ID (with user ownership check).
 */
export function getReportById(reportId: number, userId?: number, tenantId?: number): ReportDocument | null {
  const scopedTenantId = userId === undefined ? undefined : (tenantId ?? userId);
  if (userId !== undefined && (!isValidTenantUserId(userId) || !isValidTenantUserId(scopedTenantId))) {
    reportInvalidReportScope('get_report_by_id', userId, {
      reportId,
      tenantId: scopedTenantId,
    });
    return null;
  }

  const db = getDb();
  const query = userId !== undefined
    ? 'SELECT * FROM report_documents_scoped WHERE id = ? AND tenant_id = ? AND user_id = ?'
    : 'SELECT * FROM report_documents_scoped WHERE id = ?';
  const params = userId !== undefined ? [reportId, scopedTenantId, userId] : [reportId];

  const row = db.prepare(query).get(...params) as any;
  return row ? mapReport(row) : null;
}

/**
 * Get the latest report of a given type for a user.
 * Used by the dashboard to show "today's briefing" without listing all.
 */
export function getLatestByType(
  userId: number,
  type: ReportType,
  tenantId: number = userId,
): ReportDocument | null {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidReportScope('get_latest_report_by_type', userId, {
      reportType: type,
      tenantId,
    });
    return null;
  }

  const db = getDb();
  // Tie-breaker on id: created_at uses `datetime('now')` which rounds
  // to whole seconds, so two reports written inside the same second
  // would otherwise return in undefined order. Higher id = more recent
  // insert, which matches the caller's expectation of "latest".
  const row = db.prepare(`
    SELECT * FROM report_documents_scoped
    WHERE tenant_id = ? AND user_id = ? AND type = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(tenantId, userId, type) as any;
  return row ? mapReport(row) : null;
}

/**
 * Get unread report count for badge display.
 */
export function getUnreadReportCount(userId: number, tenantId: number = userId): number {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidReportScope('get_unread_report_count', userId, { tenantId });
    return 0;
  }

  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM report_documents_scoped WHERE tenant_id = ? AND user_id = ? AND status = 'unread'",
  ).get(tenantId, userId) as any;
  return row?.cnt ?? 0;
}

/**
 * Count unread report documents while excluding reports represented by a
 * canonical Notification Center item. Reports stay queryable as domain
 * history; the center item owns notification/badge contribution.
 */
export function getUnreadReportCountExcludingIds(
  userId: number,
  excludedIds: number[],
  tenantId: number = userId,
): number {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidReportScope('get_unread_report_count_excluding_ids', userId, {
      excludedCount: excludedIds.length,
      tenantId,
    });
    return 0;
  }

  const ids = normalizePositiveIds(excludedIds);
  if (ids.length === 0) return getUnreadReportCount(userId, tenantId);

  const placeholders = ids.map(() => '?').join(',');
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt
    FROM report_documents_scoped
    WHERE tenant_id = ?
      AND user_id = ?
      AND status = 'unread'
      AND id NOT IN (${placeholders})
  `).get(tenantId, userId, ...ids) as any;
  return row?.cnt ?? 0;
}

// ═══════════════════════════════════════════════════════════════════
// Update
// ═══════════════════════════════════════════════════════════════════

/**
 * Mark a report as read.
 */
export function markReportRead(reportId: number, userId: number, tenantId: number = userId): boolean {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidReportScope('mark_report_read', userId, {
      reportId,
      tenantId,
    });
    return false;
  }

  const db = getDb();
  const result = db.prepare(
    "UPDATE report_documents_scoped SET status = 'read', read_at = datetime('now') WHERE id = ? AND tenant_id = ? AND user_id = ?",
  ).run(reportId, tenantId, userId);
  return result.changes > 0;
}

// ═══════════════════════════════════════════════════════════════════
// Admin (Portal)
// ═══════════════════════════════════════════════════════════════════

/**
 * Hard-delete every report of the given types for a user. Used by
 * the training plan-cancellation path so a stale `coach_briefing`
 * or `coach_phase` document does not keep being surfaced as the
 * "current" coach narrative after the underlying plan rows are
 * gone (production bug 2026-04-25 user 29: a cancelled plan kept
 * showing rest-day cards, week journey, and "Why the coach decided
 * this" because `getLatestByType(userId, 'coach_briefing')` still
 * returned the stored report).
 *
 * Returns the number of rows removed so callers can audit what
 * actually got cleaned. Tenant-scoped on purpose — a missing or
 * negative `userId` is rejected, not silently turned into a
 * cross-tenant wipe.
 */
export function deleteReportsByType(
  userId: number,
  types: ReportType[],
  tenantId: number = userId,
): number {
  if (!isValidTenantUserId(userId) || !isValidTenantUserId(tenantId)) {
    reportInvalidReportScope('delete_reports_by_type', userId, { types, tenantId });
    return 0;
  }
  if (types.length === 0) return 0;

  const db = getDb();
  const placeholders = types.map(() => '?').join(',');
  const result = db.transaction(() => {
    db.prepare(
      `DELETE FROM report_document_dispatch_receipts WHERE tenant_id = ? AND user_id = ? AND report_type IN (${placeholders})`,
    ).run(tenantId, userId, ...types);
    return db.prepare(
      `DELETE FROM report_documents_scoped WHERE tenant_id = ? AND user_id = ? AND type IN (${placeholders})`,
    ).run(tenantId, userId, ...types);
  }).immediate();

  if (result.changes > 0) {
    logger.info(
      { userId, tenantId, types, removed: result.changes },
      'Deleted report documents by type',
    );
  }
  return result.changes;
}

/**
 * Get all reports across all users (admin/portal view).
 */
export function getAllReports(limit = 50): ReportDocument[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM report_documents_scoped
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map(mapReport);
}

// ═══════════════════════════════════════════════════════════════════
// Push Preferences
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_CATEGORIES = [
  'morning_briefing', 'evening_summary', 'weekly_review',
  'coach_briefing', 'content_updates', 'reminders',
];

/**
 * Check if push is enabled for a user+category.
 * Default: enabled (if no row exists, treat as enabled).
 */
export function isPushEnabled(userId: number, category: string): boolean {
  if (!isValidTenantUserId(userId)) {
    reportInvalidReportScope('is_push_enabled', userId, {
      category,
    });
    return false;
  }

  const db = getDb();
  try {
    const row = db.prepare(
      'SELECT enabled FROM push_preferences WHERE user_id = ? AND category = ?',
    ).get(userId, category) as { enabled: number } | undefined;
    // No row = default enabled
    return row ? row.enabled === 1 : true;
  } catch (error) {
    logger.warn({ errorName: error instanceof Error ? error.name : typeof error }, 'Push preference read failed closed');
    return false;
  }
}

/**
 * Get all push preferences for a user.
 * Creates default rows for missing categories.
 */
export function getPushPreferences(userId: number): Array<{ category: string; enabled: boolean }> {
  if (!isValidTenantUserId(userId)) {
    reportInvalidReportScope('get_push_preferences', userId);
    return DEFAULT_CATEGORIES.map((category) => ({ category, enabled: false }));
  }

  const db = getDb();
  try {
    const rows = db.prepare(
      'SELECT category, enabled FROM push_preferences WHERE user_id = ?',
    ).all(userId) as Array<{ category: string; enabled: number }>;

    const existing = new Map(rows.map(r => [r.category, r.enabled === 1]));

    return DEFAULT_CATEGORIES.map(cat => ({
      category: cat,
      enabled: existing.get(cat) ?? true,
    }));
  } catch (error) {
    logger.warn({ errorName: error instanceof Error ? error.name : typeof error }, 'Push preferences read failed closed');
    return DEFAULT_CATEGORIES.map(cat => ({ category: cat, enabled: false }));
  }
}

/**
 * Set a push preference for a user+category.
 */
export function setPushPreference(
  userId: number,
  category: string,
  enabled: boolean,
): void {
  if (!isValidTenantUserId(userId)) {
    reportInvalidReportScope('set_push_preference', userId, {
      category,
      enabled,
    });
    return;
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO push_preferences (user_id, category, enabled, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, category) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')
  `).run(userId, category, enabled ? 1 : 0);
}

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

function mapReport(row: any): ReportDocument {
  return {
    id: row.id,
    userId: row.user_id,
    tenantId: Number(row.tenant_id),
    type: row.type,
    title: row.title,
    summary: row.summary,
    documentJson: safeParseJSON(row.document_json, {}),
    sourceJob: row.source_job,
    status: row.status,
    readAt: row.read_at,
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

function safeParseJSON(val: any, fallback: any): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function normalizeDispatchKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,180}$/.test(normalized)) {
    throw new Error('REPORT_DOCUMENT_DISPATCH_KEY_INVALID');
  }
  return normalized;
}

function mapReportTypeToSourceSkill(type: ReportType): import('./notification-orchestrator').NotificationSourceSkill {
  switch (type) {
    case 'coach_briefing':
    case 'coach_phase':
      return 'training';
    case 'decision_briefing':
    case 'morning_briefing':
    case 'evening_summary':
    case 'weekly_review':
    default:
      return 'secretary';
  }
}

function mapReportTypeToIntentType(type: ReportType): import('./notification-orchestrator').NotificationIntentType {
  switch (type) {
    case 'weekly_review':
      return 'weekly_review';
    case 'decision_briefing':
    case 'morning_briefing':
    case 'evening_summary':
      return 'daily_digest';
    case 'coach_briefing':
    case 'coach_phase':
    default:
      return 'insight';
  }
}

function mapReportTypeToPriority(type: ReportType): import('./notification-orchestrator').NotificationPriority {
  switch (type) {
    case 'coach_briefing':
    case 'coach_phase':
      return 'active';
    case 'decision_briefing':
    case 'morning_briefing':
    case 'evening_summary':
    case 'weekly_review':
    default:
      return 'passive';
  }
}
