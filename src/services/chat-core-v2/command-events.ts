// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { getDb } from '../database';
import type {
  ChatCoreV2Domain,
  ChatV2CommandEvent,
  ChatV2CommandEventName,
  CommandOrigin,
  CommandStatus,
} from './types';

export interface ChatV2CommandEventRecord extends ChatV2CommandEvent {
  id: number;
  metadata: Record<string, unknown>;
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

const COMMAND_STATUSES: ReadonlySet<CommandStatus> = new Set([
  'proposed',
  'previewed',
  'confirmation_required',
  'confirmed',
  'queued',
  'executing',
  'retrying',
  'executed',
  'verification_pending',
  'verified',
  'verification_failed',
  'partially_failed',
  'failed',
  'timed_out',
  'stale',
  'expired',
  'cancelled',
  'undone',
  'undo_failed',
  'rejected_by_policy',
  'approval_denied',
  'awaiting_human_review',
]);

const COMMAND_ORIGINS: ReadonlySet<CommandOrigin> = new Set([
  'chat',
  'decision_center',
  'notification',
  'automation',
  'manual_user',
]);

const COMMAND_EVENT_NAMES: ReadonlySet<ChatV2CommandEventName> = new Set([
  'command_proposed',
  'preview_rendered',
  'confirmation_requested',
  'confirmation_received',
  'queued',
  'execution_started',
  'retrying',
  'execution_completed',
  'verification_started',
  'verification_completed',
  'verification_failed',
  'command_partially_failed',
  'command_failed',
  'timed_out',
  'stale_rejected',
  'command_expired',
  'command_cancelled',
  'command_undone',
  'undo_failed',
  'command_rejected',
  'approval_denied',
  'human_review_requested',
]);

export function ensureChatCoreV2CommandEventTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_command_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_event_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      domain TEXT NOT NULL CHECK (domain IN ('secretary', 'tasks', 'training', 'content', 'cooking', 'finance', 'connections', 'notifications', 'decision_center')),
      command_type TEXT NOT NULL,
      event_name TEXT NOT NULL CHECK (event_name IN (
        'command_proposed', 'preview_rendered', 'confirmation_requested', 'confirmation_received',
        'queued', 'execution_started', 'retrying', 'execution_completed',
        'verification_started', 'verification_completed', 'verification_failed',
        'command_partially_failed', 'command_failed', 'timed_out', 'stale_rejected',
        'command_expired', 'command_cancelled', 'command_undone', 'undo_failed',
        'command_rejected', 'approval_denied', 'human_review_requested'
      )),
      status TEXT NOT NULL CHECK (status IN (
        'proposed', 'previewed', 'confirmation_required', 'confirmed', 'queued',
        'executing', 'retrying', 'executed', 'verification_pending', 'verified',
        'verification_failed', 'partially_failed', 'failed', 'timed_out', 'stale',
        'expired', 'cancelled', 'undone', 'undo_failed', 'rejected_by_policy',
        'approval_denied', 'awaiting_human_review'
      )),
      origin TEXT NOT NULL CHECK (origin IN ('chat', 'decision_center', 'notification', 'automation', 'manual_user')),
      capability_id TEXT,
      idempotency_key TEXT,
      reason TEXT,
      redacted_summary TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_command_events_turn
      ON chat_v2_command_events(turn_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_command_events_command
      ON chat_v2_command_events(command_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_command_events_scope
      ON chat_v2_command_events(tenant_id, user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_command_events_status
      ON chat_v2_command_events(status, created_at DESC);
  `);
}

export function recordChatV2CommandEvent(
  event: ChatV2CommandEvent,
  db: Database.Database = getDb(),
): ChatV2CommandEventRecord {
  ensureChatCoreV2CommandEventTables(db);
  validateCommandEvent(event);

  db.prepare(`
    INSERT INTO chat_v2_command_events (
      command_event_id, turn_id, command_id, tenant_id, user_id, domain,
      command_type, event_name, status, origin, capability_id, idempotency_key,
      reason, redacted_summary, metadata_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(command_event_id) DO UPDATE SET
      turn_id = excluded.turn_id,
      command_id = excluded.command_id,
      tenant_id = excluded.tenant_id,
      user_id = excluded.user_id,
      domain = excluded.domain,
      command_type = excluded.command_type,
      event_name = excluded.event_name,
      status = excluded.status,
      origin = excluded.origin,
      capability_id = excluded.capability_id,
      idempotency_key = excluded.idempotency_key,
      reason = excluded.reason,
      redacted_summary = excluded.redacted_summary,
      metadata_json = excluded.metadata_json,
      created_at = excluded.created_at
  `).run(
    event.commandEventId,
    event.turnId,
    event.commandId,
    event.tenantId,
    event.userId,
    event.domain,
    event.commandType,
    event.eventName,
    event.status,
    event.origin,
    event.capabilityId ?? null,
    event.idempotencyKey ?? null,
    event.reason ?? null,
    truncateSummary(event.redactedSummary),
    JSON.stringify(event.metadata ?? {}),
    event.createdAt,
  );

  return getChatV2CommandEventById(event.commandEventId, db)!;
}

export function getChatV2CommandEventById(
  commandEventId: string,
  db: Database.Database = getDb(),
): ChatV2CommandEventRecord | null {
  ensureChatCoreV2CommandEventTables(db);
  const row = db.prepare('SELECT * FROM chat_v2_command_events WHERE command_event_id = ?').get(commandEventId);
  return row ? mapCommandEventRow(row) : null;
}

export function listChatV2CommandEventsForTurn(
  turnId: string,
  db: Database.Database = getDb(),
  options: { limit?: number } = {},
): ChatV2CommandEventRecord[] {
  ensureChatCoreV2CommandEventTables(db);
  const rows = db.prepare(`
    SELECT * FROM chat_v2_command_events
    WHERE turn_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(turnId, boundedLimit(options.limit));
  return rows.map(mapCommandEventRow);
}

export function listChatV2CommandEventsForCommand(
  commandId: string,
  db: Database.Database = getDb(),
  options: { limit?: number } = {},
): ChatV2CommandEventRecord[] {
  ensureChatCoreV2CommandEventTables(db);
  const rows = db.prepare(`
    SELECT * FROM chat_v2_command_events
    WHERE command_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(commandId, boundedLimit(options.limit));
  return rows.map(mapCommandEventRow);
}

function validateCommandEvent(event: ChatV2CommandEvent): void {
  requireNonEmpty(event.commandEventId, 'commandEventId');
  requireNonEmpty(event.turnId, 'turnId');
  requireNonEmpty(event.commandId, 'commandId');
  requireNonEmpty(event.tenantId, 'tenantId');
  requireNonEmpty(event.userId, 'userId');
  requireNonEmpty(event.commandType, 'commandType');
  requireNonEmpty(event.redactedSummary, 'redactedSummary');
  requireNonEmpty(event.createdAt, 'createdAt');
  if (!DOMAINS.has(event.domain)) throw new Error(`Invalid Chat Core v2 command event domain: ${event.domain}`);
  if (!COMMAND_EVENT_NAMES.has(event.eventName)) throw new Error(`Invalid Chat Core v2 command event name: ${event.eventName}`);
  if (!COMMAND_STATUSES.has(event.status)) throw new Error(`Invalid Chat Core v2 command event status: ${event.status}`);
  if (!COMMAND_ORIGINS.has(event.origin)) throw new Error(`Invalid Chat Core v2 command event origin: ${event.origin}`);
  if (event.metadata !== undefined) JSON.stringify(event.metadata);
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

function mapCommandEventRow(raw: unknown): ChatV2CommandEventRecord {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    commandEventId: String(row.command_event_id),
    turnId: String(row.turn_id),
    commandId: String(row.command_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    domain: row.domain as ChatCoreV2Domain,
    commandType: String(row.command_type),
    eventName: row.event_name as ChatV2CommandEventName,
    status: row.status as CommandStatus,
    origin: row.origin as CommandOrigin,
    capabilityId: stringOrUndefined(row.capability_id),
    idempotencyKey: stringOrUndefined(row.idempotency_key),
    reason: stringOrUndefined(row.reason),
    redactedSummary: String(row.redacted_summary),
    metadata: parseMetadata(row.metadata_json),
    createdAt: String(row.created_at),
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
