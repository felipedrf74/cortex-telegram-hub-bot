// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import {
  DEFAULT_CHAT_VISIBILITY_SCOPE,
  resolveChatTenantScope,
  type ChatVisibilityScope,
} from './chat-tenant-scope';

export type ChatMessageLifecycleState =
  | 'draft'
  | 'sent'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'retried'
  | 'edited'
  | 'deleted';

export interface ChatHistoryWrite {
  tenantId?: number;
  userId: number;
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  domain?: string | null;
  routeMethod?: string | null;
  confidence?: number | null;
  buttons?: unknown;
  metadata?: unknown;
  visibilityScope?: ChatVisibilityScope;
  timestamp?: string;
  lifecycleState?: ChatMessageLifecycleState;
  clientMessageId?: string | null;
  requestId?: string | null;
  retryOfMessageId?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  canceledAt?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

interface ChatHistoryRow {
  message_uuid: string;
  role: 'user' | 'assistant';
  text: string;
  domain: string | null;
  route_method: string | null;
  confidence: number | null;
  buttons_json: string | null;
  metadata_json: string | null;
  created_at: string;
  lifecycle_state?: ChatMessageLifecycleState | null;
  client_message_id?: string | null;
  request_id?: string | null;
  retry_of_message_uuid?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  canceled_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

function serializeJSON(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJSON<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function hasColumn(table: string, column: string): boolean {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function hasMessageLifecycleColumns(): boolean {
  return hasColumn('messages', 'lifecycle_state') && hasColumn('messages', 'client_message_id');
}

function normalizeLifecycleState(entry: ChatHistoryWrite): ChatMessageLifecycleState {
  if (entry.lifecycleState) return entry.lifecycleState;
  if (entry.role === 'user') return 'sent';
  return 'completed';
}

function getExistingMessage(scope: { tenantId: number }, userId: number, messageId: string): ChatHistoryRow | null {
  const db = getDb();
  const lifecycleColumns = hasMessageLifecycleColumns()
    ? `,
           lifecycle_state, client_message_id, request_id, retry_of_message_uuid,
           completed_at, failed_at, canceled_at, error_code, error_message`
    : '';
  const row = db.prepare(`
    SELECT message_uuid, role, text, domain, route_method, confidence, buttons_json, metadata_json, created_at
           ${lifecycleColumns}
    FROM messages
    WHERE tenant_id = ? AND user_id = ? AND message_uuid = ? AND scope_status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get(scope.tenantId, userId, messageId) as ChatHistoryRow | undefined;
  return row ?? null;
}

export function storeChatMessage(entry: ChatHistoryWrite): void {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId: entry.userId,
    tenantId: entry.tenantId,
    visibilityScope: entry.visibilityScope,
    operation: 'chat_history_store_message',
    layer: 'delivery',
  });
  if (!scope) {
    throw new Error('CHAT_SCOPE_INVALID: refusing to store chat message without valid tenant/user scope');
  }

  if (getExistingMessage(scope, entry.userId, entry.messageId)) {
    return;
  }

  const timestamp = entry.timestamp ?? new Date().toISOString();
  if (hasMessageLifecycleColumns()) {
    const lifecycleState = normalizeLifecycleState(entry);
    db.prepare(`
      INSERT INTO messages (
        tenant_id,
        user_id,
        visibility_scope,
        scope_status,
        created_by,
        message_uuid,
        role,
        text,
        domain,
        route_method,
        confidence,
        buttons_json,
        metadata_json,
        lifecycle_state,
        client_message_id,
        request_id,
        retry_of_message_uuid,
        completed_at,
        failed_at,
        canceled_at,
        error_code,
        error_message,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.tenantId,
      entry.userId,
      scope.visibilityScope,
      scope.scopeStatus,
      scope.createdBy,
      entry.messageId,
      entry.role,
      entry.text,
      entry.domain ?? null,
      entry.routeMethod ?? null,
      entry.confidence ?? null,
      serializeJSON(entry.buttons),
      serializeJSON(entry.metadata),
      lifecycleState,
      entry.clientMessageId ?? null,
      entry.requestId ?? null,
      entry.retryOfMessageId ?? null,
      entry.completedAt ?? (lifecycleState === 'completed' ? timestamp : null),
      entry.failedAt ?? (lifecycleState === 'failed' ? timestamp : null),
      entry.canceledAt ?? (lifecycleState === 'canceled' ? timestamp : null),
      entry.errorCode ?? null,
      entry.errorMessage ?? null,
      timestamp,
    );
    return;
  }

  db.prepare(`
      INSERT INTO messages (
        tenant_id,
        user_id,
        visibility_scope,
        scope_status,
        created_by,
        message_uuid,
        role,
        text,
        domain,
        route_method,
        confidence,
        buttons_json,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.tenantId,
      entry.userId,
      scope.visibilityScope,
      scope.scopeStatus,
      scope.createdBy,
      entry.messageId,
      entry.role,
      entry.text,
      entry.domain ?? null,
      entry.routeMethod ?? null,
      entry.confidence ?? null,
      serializeJSON(entry.buttons),
      serializeJSON(entry.metadata),
      timestamp,
    );
}

export function updateAssistantMessage(
  userId: number,
  messageId: string,
  patch: Omit<ChatHistoryWrite, 'userId' | 'messageId' | 'role'> & { text: string },
  tenantId?: number,
): boolean {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId: tenantId ?? patch.tenantId,
    visibilityScope: patch.visibilityScope,
    operation: 'chat_history_update_assistant',
    layer: 'delivery',
  });
  if (!scope) return false;
  const lifecyclePatch = hasMessageLifecycleColumns()
    ? `,
      lifecycle_state = ?,
      completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
      failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END,
      error_code = ?,
      error_message = ?`
    : '';
  const values: unknown[] = [
    patch.text,
    patch.domain ?? null,
    patch.routeMethod ?? null,
    patch.confidence ?? null,
    serializeJSON(patch.buttons),
    serializeJSON(patch.metadata),
    patch.timestamp ?? new Date().toISOString(),
  ];
  if (hasMessageLifecycleColumns()) {
    const state = patch.lifecycleState ?? 'completed';
    const timestamp = patch.timestamp ?? new Date().toISOString();
    values.push(
      state,
      state,
      timestamp,
      state,
      timestamp,
      patch.errorCode ?? null,
      patch.errorMessage ?? null,
    );
  }
  values.push(scope.tenantId, userId, messageId);

  const result = db.prepare(`
    UPDATE messages
    SET
      text = ?,
      domain = COALESCE(?, domain),
      route_method = COALESCE(?, route_method),
      confidence = COALESCE(?, confidence),
      buttons_json = ?,
      metadata_json = ?,
      created_at = ?
      ${lifecyclePatch}
    WHERE tenant_id = ? AND user_id = ? AND message_uuid = ? AND role = 'assistant' AND scope_status = 'active'
  `).run(...values);
  return result.changes > 0;
}

export function listChatMessages(userId: number, limit: number, before?: string, tenantId?: number) {
  const db = getDb();
  const hasLifecycle = hasMessageLifecycleColumns();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'chat_history_list_messages',
    layer: 'delivery',
  });
  if (!scope) {
    return { messages: [], cursor: null, hasMore: false };
  }

  const lifecycleColumns = hasLifecycle
    ? `,
      lifecycle_state,
      client_message_id,
      request_id,
      retry_of_message_uuid,
      completed_at,
      failed_at,
      canceled_at,
      error_code,
      error_message`
    : '';

  let query = `
    SELECT message_uuid, role, text, domain, route_method, confidence, buttons_json, metadata_json, created_at
           ${lifecycleColumns}
    FROM messages
    WHERE tenant_id = ? AND user_id = ? AND scope_status = 'active'
      ${hasLifecycle ? "AND COALESCE(lifecycle_state, 'completed') != 'deleted'" : ''}
  `;
  const params: Array<string | number> = [scope.tenantId, userId];

  if (before) {
    query += ' AND created_at < ?';
    params.push(before);
  }

  query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(limit + 1);

  const rows = db.prepare(query).all(...params) as ChatHistoryRow[];
  const hasMore = rows.length > limit;
  const visibleRows = rows.slice(0, limit).reverse();

  return {
    messages: visibleRows.map((row) => ({
      id: row.message_uuid,
      text: row.text,
      role: row.role,
      domain: row.domain,
      routeMethod: row.route_method,
      confidence: row.confidence,
      timestamp: row.created_at,
      buttons: parseJSON(row.buttons_json),
      metadata: parseJSON(row.metadata_json),
      lifecycleState: row.lifecycle_state ?? 'completed',
      clientMessageId: row.client_message_id ?? null,
      requestId: row.request_id ?? null,
      retryOfMessageId: row.retry_of_message_uuid ?? null,
      completedAt: row.completed_at ?? null,
      failedAt: row.failed_at ?? null,
      canceledAt: row.canceled_at ?? null,
      errorCode: row.error_code ?? null,
      errorMessage: row.error_message ?? null,
    })),
    cursor: hasMore ? rows[limit]?.created_at ?? null : null,
    hasMore,
  };
}

export function findCompletedAssistantForClientMessage(
  userId: number,
  clientMessageId: string | null | undefined,
  tenantId?: number,
): {
  userMessageId: string;
  userText: string;
  assistantMessage: ReturnType<typeof listChatMessages>['messages'][number];
} | null {
  if (!clientMessageId || !hasMessageLifecycleColumns()) return null;
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'chat_history_find_idempotent_exchange',
    layer: 'delivery',
  });
  if (!scope) return null;

  const userRow = db.prepare(`
    SELECT message_uuid, text, created_at
    FROM messages
    WHERE tenant_id = ? AND user_id = ? AND client_message_id = ? AND role = 'user' AND scope_status = 'active'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(scope.tenantId, userId, clientMessageId) as { message_uuid: string; text: string; created_at: string } | undefined;
  if (!userRow) return null;

  const assistant = db.prepare(`
    SELECT message_uuid, role, text, domain, route_method, confidence, buttons_json, metadata_json, created_at,
           lifecycle_state, client_message_id, request_id, retry_of_message_uuid,
           completed_at, failed_at, canceled_at, error_code, error_message
    FROM messages
    WHERE tenant_id = ? AND user_id = ? AND role = 'assistant' AND scope_status = 'active'
      AND COALESCE(lifecycle_state, 'completed') = 'completed'
      AND retry_of_message_uuid = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(scope.tenantId, userId, userRow.message_uuid) as ChatHistoryRow | undefined;
  if (!assistant) return null;

  return {
    userMessageId: userRow.message_uuid,
    userText: userRow.text,
    assistantMessage: {
      id: assistant.message_uuid,
      text: assistant.text,
      role: assistant.role,
      domain: assistant.domain,
      routeMethod: assistant.route_method,
      confidence: assistant.confidence,
      timestamp: assistant.created_at,
      buttons: parseJSON(assistant.buttons_json),
      metadata: parseJSON(assistant.metadata_json),
      lifecycleState: assistant.lifecycle_state ?? 'completed',
      clientMessageId: assistant.client_message_id ?? null,
      requestId: assistant.request_id ?? null,
      retryOfMessageId: assistant.retry_of_message_uuid ?? null,
      completedAt: assistant.completed_at ?? null,
      failedAt: assistant.failed_at ?? null,
      canceledAt: assistant.canceled_at ?? null,
      errorCode: assistant.error_code ?? null,
      errorMessage: assistant.error_message ?? null,
    },
  };
}

export function claimUserChatMessage(input: {
  userId: number;
  tenantId?: number;
  messageId: string;
  text: string;
  clientMessageId: string;
  requestId?: string | null;
  timestamp?: string;
}): { status: 'claimed' | 'duplicate' | 'conflict'; messageId: string; existingLifecycleState?: ChatMessageLifecycleState | null } {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId: input.userId,
    tenantId: input.tenantId,
    operation: 'chat_history_claim_user_message',
    layer: 'delivery',
  });
  if (!scope) {
    throw new Error('CHAT_SCOPE_INVALID: refusing to claim chat message without valid tenant/user scope');
  }

  const maybeReclaimRetry = (messageId: string, text: string, state?: ChatMessageLifecycleState | null) => {
    if (text !== input.text) {
      return { status: 'conflict' as const, messageId, existingLifecycleState: state ?? null };
    }
    if (state === 'failed' || state === 'canceled') {
      db.prepare(`
        UPDATE messages
        SET lifecycle_state = 'retried',
            request_id = COALESCE(?, request_id),
            error_code = NULL,
            error_message = NULL
        WHERE tenant_id = ? AND user_id = ? AND message_uuid = ? AND role = 'user' AND scope_status = 'active'
      `).run(input.requestId ?? null, scope.tenantId, input.userId, messageId);
      return { status: 'claimed' as const, messageId, existingLifecycleState: state ?? null };
    }
    return { status: 'duplicate' as const, messageId, existingLifecycleState: state ?? null };
  };

  const existing = getExistingMessage(scope, input.userId, input.messageId);
  if (existing) {
    return maybeReclaimRetry(existing.message_uuid, existing.text, existing.lifecycle_state ?? null);
  }

  const byClientId = hasMessageLifecycleColumns()
    ? db.prepare(`
      SELECT message_uuid, text, lifecycle_state
      FROM messages
      WHERE tenant_id = ? AND user_id = ? AND client_message_id = ? AND role = 'user' AND scope_status = 'active'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(scope.tenantId, input.userId, input.clientMessageId) as { message_uuid: string; text: string; lifecycle_state: ChatMessageLifecycleState | null } | undefined
    : undefined;
  if (byClientId) {
    return maybeReclaimRetry(byClientId.message_uuid, byClientId.text, byClientId.lifecycle_state ?? null);
  }

  storeChatMessage({
    tenantId: scope.tenantId,
    userId: input.userId,
    messageId: input.messageId,
    role: 'user',
    text: input.text,
    lifecycleState: 'sent',
    clientMessageId: input.clientMessageId,
    requestId: input.requestId ?? null,
    timestamp: input.timestamp,
  });
  return { status: 'claimed', messageId: input.messageId, existingLifecycleState: 'sent' };
}

export function markMessageLifecycle(
  userId: number,
  messageId: string,
  state: ChatMessageLifecycleState,
  tenantId?: number,
  details?: { errorCode?: string | null; errorMessage?: string | null; timestamp?: string },
): boolean {
  if (!hasMessageLifecycleColumns()) return false;
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'chat_history_mark_lifecycle',
    layer: 'delivery',
  });
  if (!scope) return false;
  const timestamp = details?.timestamp ?? new Date().toISOString();
  const result = db.prepare(`
    UPDATE messages
    SET lifecycle_state = ?,
        completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
        failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END,
        canceled_at = CASE WHEN ? = 'canceled' THEN ? ELSE canceled_at END,
        error_code = COALESCE(?, error_code),
        error_message = COALESCE(?, error_message)
    WHERE tenant_id = ? AND user_id = ? AND message_uuid = ? AND scope_status = 'active'
  `).run(
    state,
    state,
    timestamp,
    state,
    timestamp,
    state,
    timestamp,
    details?.errorCode ?? null,
    details?.errorMessage ?? null,
    scope.tenantId,
    userId,
    messageId,
  );
  return result.changes > 0;
}

export function repairStuckChatMessages(
  userId: number,
  tenantId?: number,
  opts: { olderThanMs?: number; now?: Date } = {},
): { failedMessages: number; canceledMessages: number } {
  if (!hasMessageLifecycleColumns()) return { failedMessages: 0, canceledMessages: 0 };
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'chat_history_repair_stuck_messages',
    layer: 'delivery',
  });
  if (!scope) return { failedMessages: 0, canceledMessages: 0 };
  const olderThanMs = opts.olderThanMs ?? 5 * 60 * 1000;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  const repairedAt = now.toISOString();

  const failed = db.prepare(`
    UPDATE messages
    SET lifecycle_state = 'failed',
        failed_at = COALESCE(failed_at, ?),
        error_code = COALESCE(error_code, 'STREAM_INTERRUPTED'),
        error_message = COALESCE(error_message, 'Message was left streaming and was repaired as failed.')
    WHERE tenant_id = ? AND user_id = ? AND role = 'assistant' AND scope_status = 'active'
      AND lifecycle_state IN ('streaming', 'sent')
      AND created_at < ?
  `).run(repairedAt, scope.tenantId, userId, cutoff);

  const canceled = db.prepare(`
    UPDATE messages
    SET lifecycle_state = 'canceled',
        canceled_at = COALESCE(canceled_at, ?),
        error_code = COALESCE(error_code, 'UNANSWERED_DRAFT_REPAIRED'),
        error_message = COALESCE(error_message, 'User message had no assistant response after the repair window.')
    WHERE tenant_id = ? AND user_id = ? AND role = 'user' AND scope_status = 'active'
      AND lifecycle_state IN ('draft', 'sent', 'streaming')
      AND created_at < ?
      AND message_uuid NOT IN (
        SELECT retry_of_message_uuid FROM messages
        WHERE tenant_id = ? AND user_id = ? AND role = 'assistant' AND retry_of_message_uuid IS NOT NULL
      )
  `).run(repairedAt, scope.tenantId, userId, cutoff, scope.tenantId, userId);

  return { failedMessages: failed.changes, canceledMessages: canceled.changes };
}

export function clearChatHistory(userId: number, tenantId?: number): void {
  const db = getDb();
  const scope = resolveChatTenantScope({
    userId,
    tenantId,
    operation: 'chat_history_clear_messages',
    layer: 'delivery',
  });
  if (!scope) return;
  db.prepare('DELETE FROM messages WHERE tenant_id = ? AND user_id = ? AND scope_status = ?')
    .run(scope.tenantId, userId, 'active');
}

export { DEFAULT_CHAT_VISIBILITY_SCOPE };
