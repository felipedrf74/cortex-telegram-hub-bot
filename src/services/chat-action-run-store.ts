// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'crypto';
import { getDb } from './database';
import type { ChatActionRisk } from './chat-action-registry';

export type ChatActionRunStatus =
  | 'planned'
  | 'needs_clarification'
  | 'needs_confirmation'
  | 'executing'
  | 'verifying'
  | 'verified_success'
  | 'partial_success'
  | 'failed'
  | 'blocked';

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
  const completedAt = ['verified_success', 'partial_success', 'failed', 'blocked'].includes(status) ? now : null;
  db.prepare(`
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
  `).run(
    status,
    update?.result === undefined ? null : JSON.stringify(update.result),
    update?.providerObjectId ?? null,
    update?.providerTransactionId ?? null,
    update?.verification === undefined ? null : JSON.stringify(update.verification),
    update?.error === undefined ? null : JSON.stringify(update.error),
    now,
    completedAt,
    id,
  );
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
  const clauses = ['user_id = ?', 'tenant_id = ?', "status = 'needs_confirmation'"];
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

function stableJson(value: unknown): string {
  if (value == null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
