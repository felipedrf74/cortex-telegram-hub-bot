// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * SQLite-backed transactional event outbox.
 *
 * Events mirror durable business writes and project app-safe state. They are
 * not the source of truth; REST writes and domain tables remain canonical.
 * Payloads must stay privacy-bounded because delta sync reads from this table.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { getCurrentContext, getCurrentRequestId } from '../utils/request-context';
import { logger } from '../utils/logger';

export type EventOutboxStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'dead_letter';

export type EventSourceSkill =
  | 'auth'
  | 'chat'
  | 'secretary'
  | 'training'
  | 'content'
  | 'cooking'
  | 'finance'
  | 'notification'
  | 'system';

export interface DomainEventInput {
  eventId?: string;
  tenantId: number;
  userId?: number | null;
  sourceSkill: EventSourceSkill;
  eventType: string;
  entityType: string;
  entityId: string | number;
  entityVersion?: number;
  eventVersion?: number;
  schemaVersion?: string;
  payload?: Record<string, unknown>;
  privacyClassification?: 'public' | 'internal' | 'sensitive' | 'financial' | 'health' | 'private_content';
  idempotencyKey: string;
  correlationId?: string | null;
  causationId?: string | null;
  requestId?: string | null;
  notBefore?: string | null;
}

export interface EventOutboxRecord {
  sequence: number;
  eventId: string;
  tenantId: number;
  userId: number | null;
  sourceSkill: EventSourceSkill;
  eventType: string;
  entityType: string;
  entityId: string;
  entityVersion: number;
  eventVersion: number;
  schemaVersion: string;
  payload: Record<string, unknown>;
  privacyClassification: string;
  idempotencyKey: string;
  correlationId: string | null;
  causationId: string | null;
  requestId: string | null;
  status: EventOutboxStatus;
  attempts: number;
  notBefore: string;
  lockedAt: string | null;
  lockOwner: string | null;
  createdAt: string;
  processedAt: string | null;
  lastError: string | null;
}

export interface EventHandler {
  eventType: string;
  handle(event: EventOutboxRecord): Promise<void> | void;
}

const MAX_EVENT_ATTEMPTS = 3;

export function ensureEventOutboxTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER,
      source_skill TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_version INTEGER NOT NULL DEFAULT 1,
      event_version INTEGER NOT NULL DEFAULT 1,
      schema_version TEXT NOT NULL DEFAULT 'event-v1',
      payload_json TEXT NOT NULL DEFAULT '{}',
      privacy_classification TEXT NOT NULL DEFAULT 'internal',
      idempotency_key TEXT NOT NULL,
      correlation_id TEXT,
      causation_id TEXT,
      request_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter')),
      attempts INTEGER NOT NULL DEFAULT 0,
      not_before TEXT NOT NULL DEFAULT (datetime('now')),
      locked_at TEXT,
      lock_owner TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_outbox_idempotency
      ON event_outbox(tenant_id, COALESCE(user_id, 0), idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_scope_created
      ON event_outbox(tenant_id, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_status_due
      ON event_outbox(status, not_before, created_at);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_entity
      ON event_outbox(event_type, entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_correlation
      ON event_outbox(correlation_id);
  `);
}

export function emitDomainEvent(input: DomainEventInput, db: Database.Database = getDb()): EventOutboxRecord {
  assertEventScope(input);
  ensureEventOutboxTables(db);
  const userScope = input.userId ?? null;
  const existing = db.prepare(`
    SELECT * FROM event_outbox
    WHERE tenant_id = ?
      AND COALESCE(user_id, 0) = COALESCE(?, 0)
      AND idempotency_key = ?
  `).get(input.tenantId, userScope, input.idempotencyKey) as any | undefined;
  if (existing) return mapEvent(existing);

  const context = getCurrentContext();
  const eventId = input.eventId ?? randomUUID();
  const payloadJson = JSON.stringify(sanitizeEventPayload(input.payload ?? {}));
  const requestId = input.requestId ?? getCurrentRequestId() ?? null;
  const correlationId = input.correlationId ?? context?.requestId ?? requestId;
  db.prepare(`
    INSERT INTO event_outbox (
      event_id, tenant_id, user_id, source_skill, event_type, entity_type, entity_id,
      entity_version, event_version, schema_version, payload_json, privacy_classification,
      idempotency_key, correlation_id, causation_id, request_id, not_before
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    eventId,
    input.tenantId,
    userScope,
    input.sourceSkill,
    input.eventType,
    input.entityType,
    String(input.entityId),
    positiveInt(input.entityVersion, 1),
    positiveInt(input.eventVersion, 1),
    input.schemaVersion || 'event-v1',
    payloadJson,
    input.privacyClassification || 'internal',
    input.idempotencyKey,
    correlationId,
    input.causationId ?? null,
    requestId,
    input.notBefore ?? null,
  );

  return mapEvent(db.prepare('SELECT * FROM event_outbox WHERE event_id = ?').get(eventId) as any);
}

export function emitDomainEventSafely(input: DomainEventInput): EventOutboxRecord | null {
  try {
    return emitDomainEvent(input);
  } catch (err) {
    logger.warn(
      {
        err,
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        eventType: input.eventType,
        entityType: input.entityType,
      },
      'Event outbox emit failed; business write already succeeded',
    );
    return null;
  }
}

export function claimPendingEvents(limit = 25, lockOwner = `worker-${process.pid}`, db: Database.Database = getDb()): EventOutboxRecord[] {
  ensureEventOutboxTables(db);
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT sequence FROM event_outbox
      WHERE status IN ('pending', 'failed')
        AND not_before <= datetime('now')
      ORDER BY created_at ASC, sequence ASC
      LIMIT ?
    `).all(boundedLimit) as { sequence: number }[];
    if (rows.length === 0) return [];
    const sequences = rows.map((row) => row.sequence);
    const placeholders = sequences.map(() => '?').join(',');
    db.prepare(`
      UPDATE event_outbox
      SET status = 'processing',
          attempts = attempts + 1,
          locked_at = datetime('now'),
          lock_owner = ?
      WHERE sequence IN (${placeholders})
    `).run(lockOwner, ...sequences);
    return db.prepare(`
      SELECT * FROM event_outbox
      WHERE sequence IN (${placeholders})
      ORDER BY created_at ASC, sequence ASC
    `).all(...sequences) as any[];
  });
  return tx().map(mapEvent);
}

export async function processPendingEvents(
  handlers: EventHandler[],
  opts: { limit?: number; lockOwner?: string; db?: Database.Database } = {},
): Promise<{ processed: number; failed: number; deadLetter: number }> {
  const db = opts.db ?? getDb();
  const claimed = claimPendingEvents(opts.limit ?? 25, opts.lockOwner ?? `worker-${process.pid}`, db);
  const handlersByType = new Map(handlers.map((handler) => [handler.eventType, handler]));
  let processed = 0;
  let failed = 0;
  let deadLetter = 0;

  for (const event of claimed) {
    const handler = handlersByType.get(event.eventType) ?? handlersByType.get('*');
    try {
      if (handler) await handler.handle(event);
      markEventProcessed(event.eventId, db);
      processed += 1;
    } catch (err) {
      const status = markEventFailed(event.eventId, err, db);
      if (status === 'dead_letter') deadLetter += 1;
      else failed += 1;
    }
  }

  return { processed, failed, deadLetter };
}

export function markEventProcessed(eventId: string, db: Database.Database = getDb()): void {
  db.prepare(`
    UPDATE event_outbox
    SET status = 'processed',
        processed_at = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        last_error = NULL
    WHERE event_id = ?
  `).run(eventId);
}

export function markEventFailed(eventId: string, err: unknown, db: Database.Database = getDb()): EventOutboxStatus {
  const row = db.prepare('SELECT attempts FROM event_outbox WHERE event_id = ?').get(eventId) as { attempts: number } | undefined;
  const attempts = row?.attempts ?? 1;
  const dead = attempts >= MAX_EVENT_ATTEMPTS;
  const delaySeconds = Math.min(3600, 2 ** Math.max(0, attempts - 1) * 30);
  db.prepare(`
    UPDATE event_outbox
    SET status = ?,
        not_before = datetime('now', ?),
        locked_at = NULL,
        lock_owner = NULL,
        last_error = ?
    WHERE event_id = ?
  `).run(
    dead ? 'dead_letter' : 'failed',
    dead ? '+0 seconds' : `+${delaySeconds} seconds`,
    safeError(err),
    eventId,
  );
  return dead ? 'dead_letter' : 'failed';
}

export function replayEventsForType(eventType: string, db: Database.Database = getDb()): number {
  ensureEventOutboxTables(db);
  const result = db.prepare(`
    UPDATE event_outbox
    SET status = 'pending',
        not_before = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        processed_at = NULL,
        last_error = NULL
    WHERE event_type = ?
      AND status IN ('processed', 'failed', 'dead_letter')
  `).run(eventType);
  return result.changes;
}

export function listEventsForScope(input: {
  tenantId: number;
  userId: number;
  sinceSequence?: number;
  limit?: number;
  skill?: string | null;
  includeTenantEvents?: boolean;
}, db: Database.Database = getDb()): EventOutboxRecord[] {
  ensureEventOutboxTables(db);
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), 500));
  const since = Number.isFinite(input.sinceSequence) ? Math.max(0, Math.floor(input.sinceSequence ?? 0)) : 0;
  const params: unknown[] = [input.tenantId, input.userId, since];
  let scopePredicate = 'tenant_id = ? AND user_id = ? AND sequence > ?';
  if (input.includeTenantEvents) {
    scopePredicate = 'tenant_id = ? AND (user_id = ? OR user_id IS NULL) AND sequence > ?';
  }
  let skillPredicate = '';
  if (input.skill) {
    skillPredicate = ' AND source_skill = ?';
    params.push(input.skill);
  }
  params.push(limit);
  return (db.prepare(`
    SELECT * FROM event_outbox
    WHERE ${scopePredicate}${skillPredicate}
    ORDER BY sequence ASC
    LIMIT ?
  `).all(...params) as any[]).map(mapEvent);
}

export function getEventSequenceBounds(db: Database.Database = getDb()): { min: number; max: number } {
  ensureEventOutboxTables(db);
  const row = db.prepare('SELECT MIN(sequence) AS min, MAX(sequence) AS max FROM event_outbox').get() as { min: number | null; max: number | null };
  return { min: row.min ?? 0, max: row.max ?? 0 };
}

function assertEventScope(input: DomainEventInput): void {
  if (!isValidTenantUserId(input.tenantId)) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'event_outbox_emit',
      reason: 'invalid_user_scope',
      userId: typeof input.tenantId === 'number' ? input.tenantId : null,
      details: { eventType: input.eventType },
    });
    throw new Error('tenantId required: must be a positive integer');
  }
  if (input.userId != null && !isValidTenantUserId(input.userId)) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'event_outbox_emit',
      reason: 'invalid_user_scope',
      userId: typeof input.userId === 'number' ? input.userId : null,
      details: { eventType: input.eventType },
    });
    throw new Error('userId required: must be a positive integer when provided');
  }
}

function sanitizeEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (/token|secret|password|prompt|raw|draft|script|calendarTitle|merchant|amount/i.test(key)) {
      clone[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string' && value.length > 500) {
      clone[key] = `${value.slice(0, 500)}…`;
      continue;
    }
    clone[key] = value;
  }
  return clone;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function safeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

function mapEvent(row: any): EventOutboxRecord {
  return {
    sequence: Number(row.sequence),
    eventId: row.event_id,
    tenantId: Number(row.tenant_id),
    userId: row.user_id == null ? null : Number(row.user_id),
    sourceSkill: row.source_skill,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityVersion: Number(row.entity_version ?? 1),
    eventVersion: Number(row.event_version ?? 1),
    schemaVersion: row.schema_version ?? 'event-v1',
    payload: parseJsonObject(row.payload_json),
    privacyClassification: row.privacy_classification ?? 'internal',
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id ?? null,
    causationId: row.causation_id ?? null,
    requestId: row.request_id ?? null,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    notBefore: row.not_before,
    lockedAt: row.locked_at ?? null,
    lockOwner: row.lock_owner ?? null,
    createdAt: row.created_at,
    processedAt: row.processed_at ?? null,
    lastError: row.last_error ?? null,
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
