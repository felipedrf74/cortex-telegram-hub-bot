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
  | 'coach_phase'; // persistent training coach narrative state across weeks

export interface ReportDocument {
  id: number;
  userId: number;
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
  type: ReportType;
  title: string;
  summary?: string;
  documentJson: Record<string, any>;
  sourceJob?: string;
}): number {
  if (!isValidTenantUserId(opts.userId)) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation: 'store_report',
      reason: opts.userId == null ? 'missing_user_scope' : 'invalid_user_scope',
      userId: opts.userId ?? null,
      details: {
        reportType: opts.type,
        sourceJob: opts.sourceJob ?? null,
      },
    });
    return -1;
  }

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO report_documents (user_id, type, title, summary, document_json, source_job)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.userId,
    opts.type,
    opts.title,
    opts.summary ?? null,
    JSON.stringify(opts.documentJson),
    opts.sourceJob ?? null,
  );
  const id = Number(result.lastInsertRowid);
  logger.info({ reportId: id, type: opts.type, userId: opts.userId }, 'Report document stored');
  return id;
}

/**
 * Store a report AND emit a central NotificationIntent referencing it.
 * The orchestrator decides push/digest/in-app timing and privacy handling.
 */
export async function storeAndPushReport(opts: {
  userId: number;
  type: ReportType;
  title: string;
  summary?: string;
  documentJson: Record<string, any>;
  sourceJob?: string;
  pushCategory?: string;
}): Promise<number> {
  const id = storeReport(opts);
  if (id <= 0) {
    return -1;
  }

  // Check push preferences before sending
  if (!isPushEnabled(opts.userId, opts.pushCategory || opts.type)) {
    logger.debug({ userId: opts.userId, type: opts.type }, 'Push suppressed by user preference');
    return id;
  }

  try {
    const { createNotificationIntent } = await import('./notification-orchestrator');
    await createNotificationIntent({
      userId: opts.userId,
      tenantId: opts.userId,
      sourceSkill: mapReportTypeToSourceSkill(opts.type),
      type: mapReportTypeToIntentType(opts.type),
      priority: mapReportTypeToPriority(opts.type),
      relatedEntityId: id,
      relatedEntityType: 'report_document',
      title: opts.title,
      body: opts.summary || 'New report available',
      sensitiveBody: opts.summary || null,
      actionButtons: [{ id: 'open_detail', label: 'Open', style: 'primary' }],
      deeplink: `nexus://notifications/report-${id}`,
      dedupeKey: `report:${opts.type}:${id}`,
      deliveryPolicy: opts.type === 'weekly_review' ? 'digest_only' : 'auto',
      privacyPolicy: opts.type === 'coach_briefing' || opts.type === 'coach_phase' ? 'health' : 'standard',
    });
  } catch (err) {
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
  opts: { type?: ReportType; limit?: number } = {},
): ReportDocument[] {
  if (!isValidTenantUserId(userId)) {
    reportInvalidReportScope('get_recent_reports', userId, {
      reportType: opts.type ?? null,
      limit: opts.limit ?? null,
    });
    return [];
  }

  const db = getDb();
  const clauses = ['user_id = ?'];
  const params: any[] = [userId];

  if (opts.type) {
    clauses.push('type = ?');
    params.push(opts.type);
  }

  params.push(opts.limit ?? 20);

  const rows = db.prepare(`
    SELECT * FROM report_documents
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as any[];

  return rows.map(mapReport);
}

/**
 * Get a single report by ID (with user ownership check).
 */
export function getReportById(reportId: number, userId?: number): ReportDocument | null {
  if (userId !== undefined && !isValidTenantUserId(userId)) {
    reportInvalidReportScope('get_report_by_id', userId, {
      reportId,
    });
    return null;
  }

  const db = getDb();
  const query = userId !== undefined
    ? 'SELECT * FROM report_documents WHERE id = ? AND user_id = ?'
    : 'SELECT * FROM report_documents WHERE id = ?';
  const params = userId !== undefined ? [reportId, userId] : [reportId];

  const row = db.prepare(query).get(...params) as any;
  return row ? mapReport(row) : null;
}

/**
 * Get the latest report of a given type for a user.
 * Used by the dashboard to show "today's briefing" without listing all.
 */
export function getLatestByType(userId: number, type: ReportType): ReportDocument | null {
  if (!isValidTenantUserId(userId)) {
    reportInvalidReportScope('get_latest_report_by_type', userId, {
      reportType: type,
    });
    return null;
  }

  const db = getDb();
  // Tie-breaker on id: created_at uses `datetime('now')` which rounds
  // to whole seconds, so two reports written inside the same second
  // would otherwise return in undefined order. Higher id = more recent
  // insert, which matches the caller's expectation of "latest".
  const row = db.prepare(`
    SELECT * FROM report_documents
    WHERE user_id = ? AND type = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(userId, type) as any;
  return row ? mapReport(row) : null;
}

/**
 * Get unread report count for badge display.
 */
export function getUnreadReportCount(userId: number): number {
  if (!isValidTenantUserId(userId)) {
    reportInvalidReportScope('get_unread_report_count', userId);
    return 0;
  }

  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM report_documents WHERE user_id = ? AND status = 'unread'",
  ).get(userId) as any;
  return row?.cnt ?? 0;
}

// ═══════════════════════════════════════════════════════════════════
// Update
// ═══════════════════════════════════════════════════════════════════

/**
 * Mark a report as read.
 */
export function markReportRead(reportId: number, userId: number): boolean {
  if (!isValidTenantUserId(userId)) {
    reportInvalidReportScope('mark_report_read', userId, {
      reportId,
    });
    return false;
  }

  const db = getDb();
  const result = db.prepare(
    "UPDATE report_documents SET status = 'read', read_at = datetime('now') WHERE id = ? AND user_id = ?",
  ).run(reportId, userId);
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
export function deleteReportsByType(userId: number, types: ReportType[]): number {
  if (!isValidTenantUserId(userId)) {
    reportInvalidReportScope('delete_reports_by_type', userId, { types });
    return 0;
  }
  if (types.length === 0) return 0;

  const db = getDb();
  const placeholders = types.map(() => '?').join(',');
  const result = db.prepare(
    `DELETE FROM report_documents WHERE user_id = ? AND type IN (${placeholders})`,
  ).run(userId, ...types);

  if (result.changes > 0) {
    logger.info(
      { userId, types, removed: result.changes },
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
    SELECT * FROM report_documents
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

function ensurePushPreferencesTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_preferences (
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, category)
    )
  `);
}

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
    ensurePushPreferencesTable();
    const row = db.prepare(
      'SELECT enabled FROM push_preferences WHERE user_id = ? AND category = ?',
    ).get(userId, category) as { enabled: number } | undefined;
    // No row = default enabled
    return row ? row.enabled === 1 : true;
  } catch {
    return true; // Default enabled on table-not-found
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
    ensurePushPreferencesTable();
    const rows = db.prepare(
      'SELECT category, enabled FROM push_preferences WHERE user_id = ?',
    ).all(userId) as Array<{ category: string; enabled: number }>;

    const existing = new Map(rows.map(r => [r.category, r.enabled === 1]));

    return DEFAULT_CATEGORIES.map(cat => ({
      category: cat,
      enabled: existing.get(cat) ?? true,
    }));
  } catch {
    return DEFAULT_CATEGORIES.map(cat => ({ category: cat, enabled: true }));
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
  ensurePushPreferencesTable();
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

function safeParseJSON(val: any, fallback: any): any {
  if (val === null || val === undefined) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

function mapReportTypeToSourceSkill(type: ReportType): import('./notification-orchestrator').NotificationSourceSkill {
  switch (type) {
    case 'coach_briefing':
    case 'coach_phase':
      return 'training';
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
    case 'morning_briefing':
    case 'evening_summary':
    case 'weekly_review':
    default:
      return 'passive';
  }
}
