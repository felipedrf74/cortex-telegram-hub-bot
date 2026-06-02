// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { getDb } from '../database';
import type {
  AuditSensitivity,
  ChatCoreV2Domain,
  ChatV2HumanReviewRequest,
  HumanReviewDecision,
  HumanReviewReason,
  HumanReviewStatus,
} from './types';

export interface ChatV2HumanReviewRecord extends ChatV2HumanReviewRequest {
  id: number;
  metadata: Record<string, unknown>;
}

export interface DecideChatV2HumanReviewInput {
  reviewId: string;
  reviewerUserId: string;
  decision: HumanReviewDecision;
  decisionNote?: string;
  decidedAt?: string;
}

const DOMAINS: ReadonlySet<ChatCoreV2Domain> = new Set([
  'secretary',
  'tasks',
  'training',
  'content',
  'cooking',
  'finance',
  'connections',
  'notifications',
  'decision_center',
]);

const REVIEW_REASONS: ReadonlySet<HumanReviewReason> = new Set([
  'restricted_finance',
  'large_batch',
  'training_plan_rewrite',
  'external_integration_side_effect',
  'ambiguous_multi_step_plan',
  'policy_uncertainty',
]);

const REVIEW_STATUSES: ReadonlySet<HumanReviewStatus> = new Set([
  'pending',
  'approved',
  'denied',
  'changes_requested',
  'cancelled',
  'expired',
]);

const REVIEW_DECISION_TO_STATUS: Record<HumanReviewDecision, HumanReviewStatus> = {
  approve: 'approved',
  deny: 'denied',
  request_changes: 'changes_requested',
};

const AUDIT_SENSITIVITIES: ReadonlySet<AuditSensitivity> = new Set([
  'normal',
  'personal',
  'financial',
  'health_adjacent',
  'credential_adjacent',
]);

export function ensureChatCoreV2HumanReviewTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_human_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      command_id TEXT,
      workflow_id TEXT,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      domain TEXT NOT NULL CHECK (domain IN ('secretary', 'tasks', 'training', 'content', 'cooking', 'finance', 'connections', 'notifications', 'decision_center')),
      reason TEXT NOT NULL CHECK (reason IN ('restricted_finance', 'large_batch', 'training_plan_rewrite', 'external_integration_side_effect', 'ambiguous_multi_step_plan', 'policy_uncertainty')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'changes_requested', 'cancelled', 'expired')),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'financial', 'health_adjacent', 'credential_adjacent')),
      redacted_summary TEXT NOT NULL,
      reviewer_user_id TEXT,
      decision_note TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      requested_at TEXT NOT NULL,
      decided_at TEXT,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_human_reviews_pending
      ON chat_v2_human_reviews(status, requested_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_human_reviews_scope
      ON chat_v2_human_reviews(tenant_id, user_id, requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_human_reviews_turn
      ON chat_v2_human_reviews(turn_id, requested_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_human_reviews_command
      ON chat_v2_human_reviews(command_id, requested_at ASC, id ASC);
  `);
}

export function enqueueChatV2HumanReview(
  request: ChatV2HumanReviewRequest,
  db: Database.Database = getDb(),
): ChatV2HumanReviewRecord {
  ensureChatCoreV2HumanReviewTables(db);
  validateHumanReviewRequest(request);
  if (request.status !== 'pending') throw new Error('Human review requests must be enqueued as pending');

  db.prepare(`
    INSERT INTO chat_v2_human_reviews (
      review_id, turn_id, command_id, workflow_id, tenant_id, user_id, domain,
      reason, status, sensitivity, redacted_summary, reviewer_user_id,
      decision_note, metadata_json, requested_at, decided_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(review_id) DO UPDATE SET
      turn_id = excluded.turn_id,
      command_id = excluded.command_id,
      workflow_id = excluded.workflow_id,
      tenant_id = excluded.tenant_id,
      user_id = excluded.user_id,
      domain = excluded.domain,
      reason = excluded.reason,
      status = excluded.status,
      sensitivity = excluded.sensitivity,
      redacted_summary = excluded.redacted_summary,
      reviewer_user_id = excluded.reviewer_user_id,
      decision_note = excluded.decision_note,
      metadata_json = excluded.metadata_json,
      requested_at = excluded.requested_at,
      decided_at = excluded.decided_at,
      expires_at = excluded.expires_at
  `).run(
    request.reviewId,
    request.turnId,
    request.commandId ?? null,
    request.workflowId ?? null,
    request.tenantId,
    request.userId,
    request.domain,
    request.reason,
    request.status,
    request.sensitivity,
    truncateSummary(request.redactedSummary),
    request.reviewerUserId ?? null,
    request.decisionNote ?? null,
    JSON.stringify(request.metadata ?? {}),
    request.requestedAt,
    request.decidedAt ?? null,
    request.expiresAt ?? null,
  );

  return getChatV2HumanReviewById(request.reviewId, db)!;
}

export function decideChatV2HumanReview(
  input: DecideChatV2HumanReviewInput,
  db: Database.Database = getDb(),
): ChatV2HumanReviewRecord {
  ensureChatCoreV2HumanReviewTables(db);
  requireNonEmpty(input.reviewId, 'reviewId');
  requireNonEmpty(input.reviewerUserId, 'reviewerUserId');
  const nextStatus = REVIEW_DECISION_TO_STATUS[input.decision];
  if (!nextStatus) throw new Error(`Invalid human review decision: ${input.decision}`);

  const existing = getChatV2HumanReviewById(input.reviewId, db);
  if (!existing) throw new Error(`Human review not found: ${input.reviewId}`);
  if (existing.status !== 'pending') {
    throw new Error(`Human review is not pending: ${input.reviewId}`);
  }

  const decidedAt = input.decidedAt ?? new Date().toISOString();
  db.prepare(`
    UPDATE chat_v2_human_reviews
    SET status = ?, reviewer_user_id = ?, decision_note = ?, decided_at = ?
    WHERE review_id = ?
  `).run(
    nextStatus,
    input.reviewerUserId,
    input.decisionNote ?? null,
    decidedAt,
    input.reviewId,
  );

  return getChatV2HumanReviewById(input.reviewId, db)!;
}

export function expireChatV2HumanReviews(
  nowIso: string,
  db: Database.Database = getDb(),
): number {
  ensureChatCoreV2HumanReviewTables(db);
  requireNonEmpty(nowIso, 'nowIso');
  const result = db.prepare(`
    UPDATE chat_v2_human_reviews
    SET status = 'expired'
    WHERE status = 'pending'
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `).run(nowIso);
  return Number(result.changes);
}

export function getChatV2HumanReviewById(
  reviewId: string,
  db: Database.Database = getDb(),
): ChatV2HumanReviewRecord | null {
  ensureChatCoreV2HumanReviewTables(db);
  const row = db.prepare('SELECT * FROM chat_v2_human_reviews WHERE review_id = ?').get(reviewId);
  return row ? mapHumanReviewRow(row) : null;
}

export function listPendingChatV2HumanReviews(
  db: Database.Database = getDb(),
  options: { tenantId?: string; limit?: number } = {},
): ChatV2HumanReviewRecord[] {
  ensureChatCoreV2HumanReviewTables(db);
  const limit = boundedLimit(options.limit);
  const rows = options.tenantId
    ? db.prepare(`
      SELECT * FROM chat_v2_human_reviews
      WHERE status = 'pending' AND tenant_id = ?
      ORDER BY requested_at ASC, id ASC
      LIMIT ?
    `).all(options.tenantId, limit)
    : db.prepare(`
      SELECT * FROM chat_v2_human_reviews
      WHERE status = 'pending'
      ORDER BY requested_at ASC, id ASC
      LIMIT ?
    `).all(limit);
  return rows.map(mapHumanReviewRow);
}

function validateHumanReviewRequest(request: ChatV2HumanReviewRequest): void {
  requireNonEmpty(request.reviewId, 'reviewId');
  requireNonEmpty(request.turnId, 'turnId');
  requireNonEmpty(request.tenantId, 'tenantId');
  requireNonEmpty(request.userId, 'userId');
  requireNonEmpty(request.redactedSummary, 'redactedSummary');
  requireNonEmpty(request.requestedAt, 'requestedAt');
  if (!DOMAINS.has(request.domain)) throw new Error(`Invalid human review domain: ${request.domain}`);
  if (!REVIEW_REASONS.has(request.reason)) throw new Error(`Invalid human review reason: ${request.reason}`);
  if (!REVIEW_STATUSES.has(request.status)) throw new Error(`Invalid human review status: ${request.status}`);
  if (!AUDIT_SENSITIVITIES.has(request.sensitivity)) throw new Error(`Invalid audit sensitivity: ${request.sensitivity}`);
  if (request.commandId !== undefined) requireNonEmpty(request.commandId, 'commandId');
  if (request.workflowId !== undefined) requireNonEmpty(request.workflowId, 'workflowId');
  if (request.metadata !== undefined) JSON.stringify(request.metadata);
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 50), 1), 250);
}

function requireNonEmpty(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function truncateSummary(value: string): string {
  return value.length > 1000 ? value.slice(0, 1000) : value;
}

function mapHumanReviewRow(raw: unknown): ChatV2HumanReviewRecord {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    reviewId: String(row.review_id),
    turnId: String(row.turn_id),
    commandId: stringOrUndefined(row.command_id),
    workflowId: stringOrUndefined(row.workflow_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    domain: row.domain as ChatCoreV2Domain,
    reason: row.reason as HumanReviewReason,
    status: row.status as HumanReviewStatus,
    sensitivity: row.sensitivity as AuditSensitivity,
    redactedSummary: String(row.redacted_summary),
    reviewerUserId: stringOrUndefined(row.reviewer_user_id),
    decisionNote: stringOrUndefined(row.decision_note),
    metadata: parseMetadata(row.metadata_json),
    requestedAt: String(row.requested_at),
    decidedAt: stringOrUndefined(row.decided_at),
    expiresAt: stringOrUndefined(row.expires_at),
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
