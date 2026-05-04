// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import {
  contentScopeForInsert,
  ensureContentTenantScopeColumns,
  resolveContentTenantId,
} from '../services/content-tenant-scope';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────
// CONTENT-UI-O2 (2026-05-04): per-signal Radar feedback.
//
// Append-only feedback log. iOS posts one row per accept/reject/save/
// create_brief action. The radar ranker can later weigh recent feedback
// to rerank similar signals (out of scope for THIS slice — we just
// persist the feedback so future scoring rounds can consume it).
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

  ensureContentTenantScopeColumns();
  const db = getDb();
  const scope = contentScopeForInsert(userId, tenantId, 'user_private', 'active');
  const reason = input.reason ? String(input.reason).slice(0, 600) : null;
  const topic = input.signalTopic ? String(input.signalTopic).slice(0, 240) : null;
  const summary = input.signalSummary ? String(input.signalSummary).slice(0, 600) : null;

  const result = db.prepare(`
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
    signal_id: input.signalId.trim().slice(0, 120),
    action: input.action,
    reason,
    signal_topic: topic,
    signal_summary: summary,
  });

  const row = db.prepare(`
    SELECT id, signal_id, action, reason, signal_topic, signal_summary, created_at
    FROM content_radar_feedback WHERE id = ?
  `).get(result.lastInsertRowid) as Record<string, unknown>;
  return rowToRecord(row);
}

export function listRadarFeedback(
  userId: number,
  tenantId?: number | null,
  options: { signalId?: string; action?: ContentRadarFeedbackAction; limit?: number } = {},
): ContentRadarFeedbackRecord[] {
  if (!Number.isFinite(userId) || userId <= 0) return [];
  ensureContentTenantScopeColumns();
  const db = getDb();
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
    logger.warn({ err, userId, tenantId: resolvedTenantId, options },
      'content-radar-feedback.list failed');
    return [];
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
