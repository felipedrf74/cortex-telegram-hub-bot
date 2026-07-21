// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'crypto';
import { getDb } from './database';
import type { ChatActionRisk } from './chat/registry';
import { logger } from '../utils/logger';

export type ChatActionRunStatus =
  | 'planned'
  | 'needs_clarification'
  | 'needs_confirmation'
  | 'executing'
  | 'verifying'
  | 'verified_success'
  | 'verified_pending'
  | 'partial_success'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export interface ChatActionRunRow {
  id: string;
  user_id: number;
  tenant_id: number;
  account_id: string | null;
  conversation_id: string;
  message_id: string;
  normalized_action_hash: string;
  provider: string | null;
  action_type: string;
  status: ChatActionRunStatus;
  risk: ChatActionRisk;
  request_json: string;
  result_json: string | null;
  provider_object_id: string | null;
  provider_transaction_id: string | null;
  verification_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ClaimChatActionRunInput {
  userId: number;
  tenantId: number;
  accountId?: string | null;
  conversationId: string;
  messageId: string;
  normalizedActionHash: string;
  provider?: string | null;
  actionType: string;
  risk: ChatActionRisk;
  request: unknown;
  nowIso?: string;
}

export function buildNormalizedActionHash(value: unknown): string {
  return createHash('sha256')
    .update(stableJson(value))
    .digest('hex')
    .slice(0, 64);
}

export function claimChatActionRun(input: ClaimChatActionRunInput): { acquired: boolean; row: ChatActionRunRow } {
  const db = getDb();
  const now = input.nowIso ?? new Date().toISOString();
  const id = `chat-action-${randomUUID()}`;
  const requestJson = JSON.stringify(input.request ?? {});
  db.prepare(`
    INSERT OR IGNORE INTO chat_action_runs (
      id, user_id, tenant_id, account_id, conversation_id, message_id,
      normalized_action_hash, provider, action_type, status, risk, request_json,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)
  `).run(
    id,
    input.userId,
    input.tenantId,
    input.accountId ?? null,
    input.conversationId,
    input.messageId,
    input.normalizedActionHash,
    input.provider ?? null,
    input.actionType,
    input.risk,
    requestJson,
    now,
    now,
  );

  const row = db.prepare(`
    SELECT * FROM chat_action_runs
    WHERE user_id = ? AND tenant_id = ? AND conversation_id = ? AND message_id = ? AND normalized_action_hash = ?
  `).get(input.userId, input.tenantId, input.conversationId, input.messageId, input.normalizedActionHash) as ChatActionRunRow | undefined;
  if (!row) throw new Error('chat_action_run_claim_failed');
  return { acquired: row.id === id, row };
}

export function claimChatActionRunForExecution(input: ClaimChatActionRunInput): { acquired: boolean; row: ChatActionRunRow } {
  const db = getDb();
  return db.transaction(() => {
    const claim = claimChatActionRun(input);
    if (!claim.acquired) {
      if (claim.row.status !== 'needs_confirmation') return claim;
      const now = input.nowIso ?? new Date().toISOString();
      const result = db.prepare(`
        UPDATE chat_action_runs
        SET status = 'executing',
            updated_at = ?
        WHERE id = ?
          AND status = 'needs_confirmation'
      `).run(now, claim.row.id);
      const row = getChatActionRun(claim.row.id) ?? claim.row;
      return { acquired: Number(result.changes ?? 0) > 0, row };
    }
    const row = updateChatActionRun(claim.row.id, 'executing', { nowIso: input.nowIso }) ?? claim.row;
    return { acquired: true, row };
  })();
}

export function updateChatActionRun(
  id: string,
  status: ChatActionRunStatus,
  update?: {
    result?: unknown;
    providerObjectId?: string | null;
    providerTransactionId?: string | null;
    verification?: unknown;
    error?: unknown;
    nowIso?: string;
  },
): ChatActionRunRow | null {
  const db = getDb();
  const now = update?.nowIso ?? new Date().toISOString();
  const completedAt = ['verified_success', 'verified_pending', 'partial_success', 'failed', 'blocked', 'cancelled'].includes(status) ? now : null;
  const safeResult = update?.result === undefined
    ? undefined
    : sanitizeChatActionRunResult(update.result, {
      providerObjectId: update.providerObjectId ?? undefined,
      status,
    });

  const result = db.prepare(`
    UPDATE chat_action_runs
    SET status = ?,
        result_json = COALESCE(?, result_json),
        provider_object_id = COALESCE(?, provider_object_id),
        provider_transaction_id = COALESCE(?, provider_transaction_id),
        verification_json = COALESCE(?, verification_json),
        error_json = COALESCE(?, error_json),
        updated_at = ?,
        completed_at = COALESCE(?, completed_at)
    WHERE id = ?
      AND status NOT IN ('failed', 'cancelled')
  `).run(
    status,
    safeResult === undefined ? null : JSON.stringify(safeResult),
    update?.providerObjectId ?? null,
    update?.providerTransactionId ?? null,
    update?.verification === undefined ? null : JSON.stringify(update.verification),
    update?.error === undefined ? null : JSON.stringify(update.error),
    now,
    completedAt,
    id,
  );
  if (Number(result.changes ?? 0) === 0) {
    const current = getChatActionRun(id);
    if (current && (current.status === 'failed' || current.status === 'cancelled')) {
      logger.warn({
        runId: id,
        attemptedStatus: status,
        currentStatus: current.status,
      }, 'late chat action run write rejected by terminal status guard');
      return null;
    }
    logger.warn({
      runId: id,
      attemptedStatus: status,
      currentStatus: current?.status ?? 'missing',
    }, 'chat action run update did not match an active row');
  }
  return getChatActionRun(id);
}

export function getChatActionRun(id: string): ChatActionRunRow | null {
  return (getDb().prepare('SELECT * FROM chat_action_runs WHERE id = ?').get(id) as ChatActionRunRow | undefined) ?? null;
}

export function listPendingChatActionRuns(input: {
  userId: number;
  tenantId: number;
  conversationId?: string | null;
  messageId?: string | null;
  limit?: number;
}): ChatActionRunRow[] {
  const clauses = [
    'user_id = ?',
    'tenant_id = ?',
    "status IN ('planned', 'needs_confirmation', 'executing', 'verifying')",
  ];
  const params: Array<number | string> = [input.userId, input.tenantId];
  if (input.conversationId) {
    clauses.push('conversation_id = ?');
    params.push(input.conversationId);
  }
  if (input.messageId) {
    clauses.push('message_id = ?');
    params.push(input.messageId);
  }
  params.push(Math.max(1, Math.min(25, input.limit ?? 10)));
  return getDb().prepare(`
    SELECT * FROM chat_action_runs
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(...params) as ChatActionRunRow[];
}

export function cancelPendingChatActionRuns(input: {
  userId: number;
  tenantId: number;
  conversationId?: string | null;
  messageId?: string | null;
  nowIso?: string;
}): number {
  const now = input.nowIso ?? new Date().toISOString();
  const clauses = [
    'user_id = ?',
    'tenant_id = ?',
    "status IN ('planned', 'needs_confirmation', 'executing', 'verifying')",
  ];
  const params: Array<number | string> = [input.userId, input.tenantId];
  if (input.conversationId) {
    clauses.push('conversation_id = ?');
    params.push(input.conversationId);
  }
  if (input.messageId) {
    clauses.push('message_id = ?');
    params.push(input.messageId);
  }
  const result = getDb().prepare(`
    UPDATE chat_action_runs
    SET status = 'cancelled',
        error_json = COALESCE(error_json, ?),
        updated_at = ?,
        completed_at = COALESCE(completed_at, ?)
    WHERE ${clauses.join(' AND ')}
  `).run(JSON.stringify({ reason: 'user_cancelled_pending_chat_work' }), now, now, ...params);
  return Number(result.changes ?? 0);
}

export function reapZombieChatActionRuns(input: {
  olderThanIso?: string;
  nowIso?: string;
  limit?: number;
} = {}): number {
  const db = getDb();
  const now = input.nowIso ?? new Date().toISOString();
  const olderThan = input.olderThanIso ?? new Date(Date.parse(now) - 5 * 60 * 1000).toISOString();
  const limit = Math.max(1, Math.min(1000, input.limit ?? 500));
  const result = db.prepare(`
    UPDATE chat_action_runs
    SET status = 'failed',
        error_json = COALESCE(error_json, ?),
        updated_at = ?,
        completed_at = COALESCE(completed_at, ?)
    WHERE id IN (
      SELECT id
      FROM chat_action_runs
      WHERE status = 'executing'
        AND updated_at <= ?
      ORDER BY updated_at ASC
      LIMIT ?
    )
  `).run(JSON.stringify({ reason: 'orphaned_executing' }), now, now, olderThan, limit);
  return Number(result.changes ?? 0);
}

export function pruneCompletedChatActionRuns(input: {
  beforeIso?: string;
  nowIso?: string;
  limit?: number;
} = {}): number {
  const now = input.nowIso ?? new Date().toISOString();
  const before = input.beforeIso ?? new Date(Date.parse(now) - 90 * 24 * 60 * 60 * 1000).toISOString();
  const limit = Math.max(1, Math.min(1000, input.limit ?? 500));
  const result = getDb().prepare(`
    DELETE FROM chat_action_runs
    WHERE id IN (
      SELECT id
      FROM chat_action_runs
      WHERE completed_at IS NOT NULL
        AND completed_at <= ?
        AND status IN ('verified_success', 'verified_pending', 'partial_success', 'failed', 'blocked', 'cancelled')
      ORDER BY completed_at ASC
      LIMIT ?
    )
  `).run(before, limit);
  return Number(result.changes ?? 0);
}

// ─── M18: legacy tool-loop checkpoints ──────────────────────────────
//
// The legacy domain-handler tool loop persists each COMPLETED (non-blocked,
// non-failed, read-risk) tool call as a terminal `verified_success` row keyed by the
// turn's chatRequestId. On a turn timeout the route reads these back to
// build an honest partial-progress reply.
//
// Spike verdict (M18): no auto-resume for the legacy loop — the detached
// loop keeps running in-process after the Promise.race timeout, ADV-2
// provider pinning cannot be guaranteed from a later worker process, and
// sliced-history shape stability breaks open tool_use_id scope. Checkpoints
// are therefore EVIDENCE for an honest reply, never a resume payload. Being
// terminal rows, they are invisible to listPendingChatActionRuns and
// untouched by cancelPendingChatActionRuns / cancelAllPendingChatWork, so a
// timed-out turn leaves zero queued continuation work behind.

export const LEGACY_TOOL_LOOP_CHECKPOINT_ACTION_PREFIX = 'legacy_tool_loop_checkpoint';

export interface RecordLegacyToolLoopCheckpointInput {
  /** The turn's chatRequestId — scopes all checkpoints of one turn. */
  runId: string;
  userId: number;
  tenantId: number;
  domain: string;
  toolName: string;
  toolInput: unknown;
  /** Truncated JSON summary of the tool result (evidence, not replay data). */
  resultSummary?: string | null;
  /** 1-based position of this completed tool call within the turn. */
  sequence: number;
  nowIso?: string;
}

export interface LegacyToolLoopCheckpoint {
  toolName: string;
  sequence: number;
  completedAt: string;
}

/** Zero-pad so lexicographic message_id order matches numeric sequence order. */
function checkpointMessageId(sequence: number): string {
  return `checkpoint-${String(Math.max(0, Math.trunc(sequence))).padStart(6, '0')}`;
}

/**
 * Idempotently record one completed legacy tool call. Returns true when a new
 * row was inserted, false when the (run, sequence, tool) checkpoint already
 * existed. Terminal from birth: status `verified_success`, completed_at set.
 */
export function recordLegacyToolLoopCheckpoint(input: RecordLegacyToolLoopCheckpointInput): boolean {
  const db = getDb();
  const now = input.nowIso ?? new Date().toISOString();
  const id = `chat-action-${randomUUID()}`;
  const hash = buildNormalizedActionHash({
    checkpoint: LEGACY_TOOL_LOOP_CHECKPOINT_ACTION_PREFIX,
    sequence: input.sequence,
    tool: input.toolName,
    input: input.toolInput ?? null,
  });
  const result = db.prepare(`
    INSERT OR IGNORE INTO chat_action_runs (
      id, user_id, tenant_id, account_id, conversation_id, message_id,
      normalized_action_hash, provider, action_type, status, risk, request_json,
      result_json, created_at, updated_at, completed_at
    )
    VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, 'verified_success', 'read_only', ?, ?, ?, ?, ?)
  `).run(
    id,
    input.userId,
    input.tenantId,
    input.runId,
    checkpointMessageId(input.sequence),
    hash,
    `${LEGACY_TOOL_LOOP_CHECKPOINT_ACTION_PREFIX}:${input.toolName}`,
    JSON.stringify({ domain: input.domain, tool: input.toolName, input: input.toolInput ?? null }),
    JSON.stringify({
      status: 'verified_success',
      resultType: 'tool_checkpoint',
      tool: input.toolName,
      completed: true,
      summary: typeof input.resultSummary === 'string' ? input.resultSummary.slice(0, 300) : null,
      replaySafe: true,
    }),
    now,
    now,
    now,
  );
  return Number(result.changes ?? 0) > 0;
}

/** Ordered (by sequence) checkpoints for one turn, tenant-scoped. */
export function listLegacyToolLoopCheckpoints(input: {
  runId: string;
  userId: number;
  tenantId: number;
}): LegacyToolLoopCheckpoint[] {
  const rows = getDb().prepare(`
    SELECT action_type, message_id, completed_at
    FROM chat_action_runs
    WHERE user_id = ?
      AND tenant_id = ?
      AND conversation_id = ?
      AND action_type LIKE ?
    ORDER BY message_id ASC, created_at ASC
    LIMIT 100
  `).all(
    input.userId,
    input.tenantId,
    input.runId,
    `${LEGACY_TOOL_LOOP_CHECKPOINT_ACTION_PREFIX}:%`,
  ) as Array<{ action_type: string; message_id: string; completed_at: string | null }>;
  return rows.map((row) => ({
    toolName: row.action_type.slice(LEGACY_TOOL_LOOP_CHECKPOINT_ACTION_PREFIX.length + 1),
    sequence: Number.parseInt(row.message_id.replace(/^checkpoint-0*/, ''), 10) || 0,
    completedAt: row.completed_at ?? '',
  }));
}

function stableJson(value: unknown): string {
  if (value == null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sanitizeChatActionRunResult(result: unknown, context: { providerObjectId?: string | null; status: ChatActionRunStatus }): Record<string, unknown> {
  if (!result || typeof result !== 'object') {
    return { status: context.status, valueType: typeof result };
  }
  const record = result as Record<string, unknown>;
  const event = isRecord(record.event) ? record.event : null;
  const task = isRecord(record.task) ? record.task : null;
  const intentId = typeof record.intentId === 'string' ? record.intentId : null;
  const providerObjectId =
    context.providerObjectId
    ?? stringValue(record.providerObjectId)
    ?? stringValue(record.packageId)
    ?? stringValue(record.pendingActionId)
    ?? stringValue(record.eventId)
    ?? stringValue(record.taskId)
    ?? stringValue(record.topicId)
    ?? stringValue(record.weekStart)
    ?? stringValue(event?.id)
    ?? stringValue(task?.id)
    ?? intentId
    ?? null;
  const resultType = inferResultType(record);
  const listId = resultType === 'task'
    ? stringValue(record.listId) ?? stringValue(task?.listId)
    : null;
  return {
    status: context.status,
    verified: typeof record.verified === 'boolean'
      ? record.verified
      : isRecord(record.verification) && typeof record.verification.verified === 'boolean'
        ? record.verification.verified
        : undefined,
    providerObjectId,
    listId,
    source: stringValue(record.provider) ?? stringValue(record.source) ?? stringValue(event?.source),
    resultType,
    replaySafe: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function inferResultType(record: Record<string, unknown>): string {
  if ('event' in record || 'eventId' in record) return 'calendar_event';
  if ('task' in record || 'taskId' in record) return 'task';
  if ('packageId' in record || 'firstScript' in record) return 'content_package';
  if ('intentId' in record || 'notificationId' in record) return 'notification_intent';
  if ('pendingActionId' in record) return 'pending_action';
  if ('meal' in record || 'weekStart' in record) return 'cooking';
  if ('item' in record || 'decisionId' in record) return 'decision';
  return 'action_result';
}
