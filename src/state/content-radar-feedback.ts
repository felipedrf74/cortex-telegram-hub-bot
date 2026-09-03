// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from '../services/database';
import {
  contentScopeForInsert,
  ensureContentTenantScopeColumns,
  resolveContentTenantId,
} from '../services/content-tenant-scope';
import { safeContentLogErrorFields } from '../services/content-log-safety';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────
// CONTENT-UI-O2 (2026-05-04): per-signal Radar feedback.
//
// Active feedback is idempotent per signal/action. Repeated taps update
// the same active row instead of inflating ranker input. Revoke archives
// active rows so later taps can recreate them while preserving history.
// ─────────────────────────────────────────────────────────────────────

export type ContentRadarFeedbackAction = 'accept' | 'reject' | 'save' | 'create_brief';

export interface ContentRadarFeedbackRecord {
  id: number;
  signalId: string;
  action: ContentRadarFeedbackAction;
  reason: string | null;
  signalTopic: string | null;
  signalSummary: string | null;
  createdAt: string;
}

export interface ContentRadarFeedbackInput {
  signalId: string;
  action: ContentRadarFeedbackAction;
  reason?: string | null;
  signalTopic?: string | null;
  signalSummary?: string | null;
}

export interface RevokeRadarFeedbackInput {
  signalId: string;
  action?: ContentRadarFeedbackAction | null;
}

const VALID_ACTIONS: readonly ContentRadarFeedbackAction[] = [
  'accept', 'reject', 'save', 'create_brief',
];

export function isValidRadarFeedbackAction(value: unknown): value is ContentRadarFeedbackAction {
  return typeof value === 'string'
    && (VALID_ACTIONS as readonly string[]).includes(value);
}

function rowToRecord(row: Record<string, unknown>): ContentRadarFeedbackRecord {
  return {
    id: Number(row.id),
    signalId: String(row.signal_id ?? ''),
    action: (isValidRadarFeedbackAction(row.action) ? row.action : 'save'),
    reason: typeof row.reason === 'string' ? row.reason : null,
    signalTopic: typeof row.signal_topic === 'string' ? row.signal_topic : null,
    signalSummary: typeof row.signal_summary === 'string' ? row.signal_summary : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
  };
}

export function recordRadarFeedback(
  userId: number,
  tenantId: number | null | undefined,
  input: ContentRadarFeedbackInput,
  db: Database.Database = getDb(),
): ContentRadarFeedbackRecord {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('recordRadarFeedback requires a positive userId');
  }
  if (typeof input.signalId !== 'string' || !input.signalId.trim()) {
    throw new Error('signalId is required');
  }
  if (!isValidRadarFeedbackAction(input.action)) {
    throw new Error(`Invalid action: ${String(input.action)}`);
  }

  ensureContentTenantScopeColumns(db);
  ensureRadarFeedbackIdempotencyIndex(db);
  const scope = contentScopeForInsert(userId, tenantId, 'user_private', 'active');
  const reason = input.reason ? String(input.reason).slice(0, 600) : null;
  const topic = input.signalTopic ? String(input.signalTopic).slice(0, 240) : null;
  const summary = input.signalSummary ? String(input.signalSummary).slice(0, 600) : null;
  const signalId = input.signalId.trim().slice(0, 120);

  db.prepare(`
    INSERT INTO content_radar_feedback (
      user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
      scope_status, created_by, updated_by, audit_metadata_json,
      signal_id, action, reason, signal_topic, signal_summary,
      created_at, updated_at
    ) VALUES (
      @user_id, @tenant_id, @owner_user_id, @visibility_scope, @lifecycle_state,
      @scope_status, @created_by, @updated_by, @audit_metadata_json,
      @signal_id, @action, @reason, @signal_topic, @signal_summary,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(tenant_id, owner_user_id, signal_id, action)
    WHERE scope_status = 'active'
    DO UPDATE SET
      reason = excluded.reason,
      signal_topic = excluded.signal_topic,
      signal_summary = excluded.signal_summary,
      updated_by = excluded.updated_by,
      updated_at = datetime('now')
  `).run({
    user_id: userId,
    tenant_id: scope.tenantId,
    owner_user_id: scope.ownerUserId,
    visibility_scope: scope.visibilityScope,
    lifecycle_state: scope.lifecycleState,
    scope_status: scope.scopeStatus,
    created_by: scope.createdBy,
    updated_by: scope.updatedBy,
    audit_metadata_json: scope.auditMetadataJson,
    signal_id: signalId,
    action: input.action,
    reason,
    signal_topic: topic,
    signal_summary: summary,
  });

  const row = db.prepare(`
    SELECT id, signal_id, action, reason, signal_topic, signal_summary, created_at
    FROM content_radar_feedback
    WHERE tenant_id = ?
      AND owner_user_id = ?
      AND signal_id = ?
      AND action = ?
      AND scope_status = 'active'
    LIMIT 1
  `).get(scope.tenantId, scope.ownerUserId, signalId, input.action) as Record<string, unknown>;
  return rowToRecord(row);
}

export function revokeRadarFeedback(
  userId: number,
  tenantId: number | null | undefined,
  input: RevokeRadarFeedbackInput,
): number {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('revokeRadarFeedback requires a positive userId');
  }
  if (typeof input.signalId !== 'string' || !input.signalId.trim()) {
    throw new Error('signalId is required');
  }
  if (input.action != null && !isValidRadarFeedbackAction(input.action)) {
    throw new Error(`Invalid action: ${String(input.action)}`);
  }

  ensureContentTenantScopeColumns();
  const db = getDb();
  ensureRadarFeedbackIdempotencyIndex(db);
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);
  const signalId = input.signalId.trim().slice(0, 120);
  const where = [
    `tenant_id = ?`,
    `owner_user_id = ?`,
    `signal_id = ?`,
    `scope_status = 'active'`,
  ];
  const params: Array<number | string> = [resolvedTenantId, userId, signalId];
  if (input.action) {
    where.push('action = ?');
    params.push(input.action);
  }

  const result = db.prepare(`
    UPDATE content_radar_feedback
       SET scope_status = 'archived',
           lifecycle_state = 'revoked',
           updated_by = ?,
           updated_at = datetime('now')
     WHERE ${where.join(' AND ')}
  `).run(userId, ...params);
  return Number(result.changes) || 0;
}

export function listRadarFeedback(
  userId: number,
  tenantId?: number | null,
  options: { signalId?: string; action?: ContentRadarFeedbackAction; limit?: number } = {},
): ContentRadarFeedbackRecord[] {
  if (!Number.isFinite(userId) || userId <= 0) return [];
  ensureContentTenantScopeColumns();
  const db = getDb();
  ensureRadarFeedbackIdempotencyIndex(db);
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);
  const limit = Math.max(1, Math.min(500, options.limit ?? 200));

  const where: string[] = [
    `tenant_id = ?`,
    `owner_user_id = ?`,
    `scope_status = 'active'`,
  ];
  const params: Array<number | string> = [resolvedTenantId, userId];
  if (options.signalId) {
    where.push('signal_id = ?');
    params.push(options.signalId);
  }
  if (options.action) {
    where.push('action = ?');
    params.push(options.action);
  }

  try {
    const rows = db.prepare(`
      SELECT id, signal_id, action, reason, signal_topic, signal_summary, created_at
      FROM content_radar_feedback
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  } catch (err) {
    logger.warn({ ...safeContentLogErrorFields(err), userId, tenantId: resolvedTenantId },
      'content-radar-feedback.list failed');
    throw err;
  }
}

/**
 * Returns a per-signal aggregate (count by action) for the given user.
 * Useful for the radar ranker to suppress a rejected signal across
 * multiple devices/sessions.
 */
export function radarFeedbackAggregateBySignal(
  userId: number,
  tenantId?: number | null,
): Record<string, Partial<Record<ContentRadarFeedbackAction, number>>> {
  if (!Number.isFinite(userId) || userId <= 0) return {};
  ensureContentTenantScopeColumns();
  const db = getDb();
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);
  const rows = db.prepare(`
    SELECT signal_id, action, COUNT(*) AS count
    FROM content_radar_feedback
    WHERE tenant_id = ? AND owner_user_id = ? AND scope_status = 'active'
    GROUP BY signal_id, action
  `).all(resolvedTenantId, userId) as Array<Record<string, unknown>>;

  const out: Record<string, Partial<Record<ContentRadarFeedbackAction, number>>> = {};
  for (const r of rows) {
    const sid = String(r.signal_id ?? '');
    const act = isValidRadarFeedbackAction(r.action) ? r.action : null;
    if (!sid || !act) continue;
    if (!out[sid]) out[sid] = {};
    out[sid][act] = Number(r.count) || 0;
  }
  return out;
}

function ensureRadarFeedbackIdempotencyIndex(db: any): void {
  try {
    db.exec(`
      DELETE FROM content_radar_feedback
       WHERE COALESCE(scope_status, 'active') = 'active'
         AND id NOT IN (
           SELECT MAX(id)
             FROM content_radar_feedback
            WHERE COALESCE(scope_status, 'active') = 'active'
            GROUP BY tenant_id, owner_user_id, signal_id, action
         );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_content_radar_feedback_active_unique_action
        ON content_radar_feedback(tenant_id, owner_user_id, signal_id, action)
        WHERE scope_status = 'active';
    `);
  } catch (err) {
    logger.debug(safeContentLogErrorFields(err), 'content-radar-feedback.idempotency-index ensure failed');
  }
}
