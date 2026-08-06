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
import { sanitizePrivacyObject } from '../utils/privacy-sanitizer';

export type EventOutboxStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'dead_letter' | 'canceled';

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
  /** Present on claimed rows; optional so older/manual record fixtures remain source-compatible. */
  fencingToken?: string | null;
  /** Present on claimed rows; optional so older/manual record fixtures remain source-compatible. */
  leaseExpiresAt?: string | null;
  createdAt: string;
  processedAt: string | null;
  lastError: string | null;
}

export interface EventHandler {
  eventType: string;
  handle(event: EventOutboxRecord, db: Database.Database): Promise<void> | void;
}

const MAX_EVENT_ATTEMPTS = 3;
const EVENT_LEASE_SECONDS = 15 * 60;
const EVENT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

type EventLeaseIdentity = Pick<EventOutboxRecord, 'eventId' | 'lockOwner' | 'fencingToken'>;

export class EventOutboxLeaseLostError extends Error {
  readonly code = 'EVENT_OUTBOX_LEASE_LOST';

  constructor() {
    super('EVENT_OUTBOX_LEASE_LOST: event lease is expired, missing, or owned by another worker');
    this.name = 'EventOutboxLeaseLostError';
  }
}

export function runOutboxTransaction<T>(operation: (emit: typeof emitDomainEvent) => T): T {
  const db = getDb();
  return db.transaction(() => operation(emitDomainEvent))();
}

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
        CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter', 'canceled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      not_before TEXT NOT NULL DEFAULT (datetime('now')),
      locked_at TEXT,
      lock_owner TEXT,
      fencing_token TEXT,
      lease_expires_at TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_event_outbox_lease_expiry
      ON event_outbox(status, lease_expires_at);
    -- Mixed-version safety: predecessor claim SQL cannot rotate the fencing
    -- token or install a lease. Abort that claim before its handler executes.
    -- Tokenless processing rows migrated in flight can still complete; this
    -- guard applies only when a worker attempts another claim.
    CREATE TRIGGER IF NOT EXISTS trg_event_outbox_fenced_claim_transition
    BEFORE UPDATE OF status ON event_outbox
    FOR EACH ROW
    WHEN NEW.status = 'processing'
      AND NOT (
        NEW.fencing_token IS NOT NULL
        AND NEW.fencing_token IS NOT OLD.fencing_token
        AND NEW.lock_owner IS NOT NULL
        AND length(trim(NEW.lock_owner)) > 0
        AND NEW.locked_at IS NOT NULL
        AND NEW.lease_expires_at IS NOT NULL
        AND NEW.lease_expires_at > datetime('now')
      )
    BEGIN
      SELECT RAISE(ABORT, 'EVENT_OUTBOX_FENCING_VIOLATION');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_event_outbox_fenced_terminal_transition
    BEFORE UPDATE OF status ON event_outbox
    FOR EACH ROW
    WHEN OLD.status = 'processing'
      AND OLD.fencing_token IS NOT NULL
      AND NEW.status IN ('processed', 'failed', 'dead_letter')
      AND NOT (
        OLD.lease_expires_at IS NOT NULL
        AND NEW.lease_expires_at IS NULL
        AND NEW.fencing_token IS OLD.fencing_token
      )
    BEGIN
      SELECT RAISE(ABORT, 'EVENT_OUTBOX_FENCING_VIOLATION');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_event_outbox_terminal_tombstone
    BEFORE UPDATE OF status ON event_outbox
    FOR EACH ROW
    WHEN NEW.status IN ('processed', 'failed', 'dead_letter')
      AND OLD.status != 'processing'
    BEGIN
      SELECT RAISE(ABORT, 'EVENT_OUTBOX_FENCING_VIOLATION');
    END;
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

const STALE_EVENT_LEASE_MINUTES = 15;

export function claimPendingEvents(limit = 25, lockOwner = `worker-${process.pid}`, db: Database.Database = getDb()): EventOutboxRecord[] {
  ensureEventOutboxTables(db);
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
  const effectiveLockOwner = typeof lockOwner === 'string' && lockOwner.trim()
    ? lockOwner.trim().slice(0, 128)
    : `worker-${process.pid}`;
  const rows = db.prepare(`
    UPDATE event_outbox
    SET status = 'processing',
        attempts = attempts + 1,
        locked_at = datetime('now'),
        lock_owner = ?,
        fencing_token = lower(hex(randomblob(16))),
        lease_expires_at = datetime('now', ?)
    WHERE sequence IN (
      SELECT sequence
      FROM event_outbox
      WHERE (
          status IN ('pending', 'failed')
          AND not_before <= datetime('now')
        )
        OR (
          status = 'processing'
          AND (
            lease_expires_at <= datetime('now')
            OR (
              lease_expires_at IS NULL
              AND locked_at IS NOT NULL
              AND locked_at <= datetime('now', ?)
            )
          )
        )
      ORDER BY CASE WHEN status = 'processing' THEN 1 ELSE 0 END, created_at ASC, sequence ASC
      LIMIT ?
    )
    RETURNING *
  `);
  return (rows.all(
    effectiveLockOwner,
    `+${EVENT_LEASE_SECONDS} seconds`,
    `-${STALE_EVENT_LEASE_MINUTES} minutes`,
    boundedLimit,
  ) as any[]).map(mapEvent);
}

export async function processPendingEvents(
  handlers: EventHandler[],
  opts: { limit?: number; lockOwner?: string; db?: Database.Database; heartbeatIntervalMs?: number } = {},
): Promise<{ processed: number; failed: number; deadLetter: number }> {
  const db = opts.db ?? getDb();
  const startedAt = Date.now();
  const claimed = claimPendingEvents(opts.limit ?? 25, opts.lockOwner ?? `worker-${process.pid}`, db);
  const handlersByType = new Map(handlers.map((handler) => [handler.eventType, handler]));
  let processed = 0;
  let failed = 0;
  let deadLetter = 0;
  let leaseLost = 0;
  // Start every heartbeat immediately: later rows in a claimed batch must not
  // expire while an earlier async handler is still running.
  const heartbeats = new Map(claimed.map((event) => [
    event.eventId,
    startEventLeaseHeartbeat(event, db, opts.heartbeatIntervalMs),
  ]));

  try {
    for (const event of claimed) {
      const handler = handlersByType.get(event.eventType) ?? handlersByType.get('*');
      const heartbeat = heartbeats.get(event.eventId)!;
      try {
        heartbeat.assertActive();
        if (handler) await handler.handle(event, db);
        heartbeat.assertActive();
        if (markEventProcessed(event, db)) processed += 1;
      } catch (err) {
        if (err instanceof EventOutboxLeaseLostError) {
          leaseLost += 1;
        } else {
          try {
            const status = markEventFailed(event, err, db);
            if (status === 'dead_letter') deadLetter += 1;
            else if (status === 'failed') failed += 1;
          } catch (markErr) {
            if (markErr instanceof EventOutboxLeaseLostError) leaseLost += 1;
            else throw markErr;
          }
        }
      } finally {
        heartbeat.stop();
      }
    }
  } finally {
    for (const heartbeat of heartbeats.values()) heartbeat.stop();
  }

  logger.info(
    {
      scope: 'event_outbox',
      claimed: claimed.length,
      processed,
      failed,
      deadLetter,
      leaseLost,
      durationMs: Date.now() - startedAt,
    },
    'event_outbox_batch',
  );
  return { processed, failed, deadLetter };
}

export function renewEventLease(
  event: EventLeaseIdentity,
  db: Database.Database = getDb(),
): string {
  const lease = requireEventLeaseIdentity(event, db);
  if (!lease) throw new EventOutboxLeaseLostError();
  const renewed = db.prepare(`
    UPDATE event_outbox
       SET locked_at = datetime('now'),
           lease_expires_at = datetime('now', ?)
     WHERE event_id = ?
       AND status = 'processing'
       AND lock_owner = ?
       AND fencing_token = ?
       AND lease_expires_at > datetime('now')
    RETURNING lease_expires_at AS leaseExpiresAt
  `).get(
    `+${EVENT_LEASE_SECONDS} seconds`,
    lease.eventId,
    lease.lockOwner,
    lease.fencingToken,
  ) as { leaseExpiresAt: string } | undefined;
  if (!renewed) throw new EventOutboxLeaseLostError();
  return renewed.leaseExpiresAt;
}

export function markEventProcessed(
  event: EventLeaseIdentity | string,
  db: Database.Database = getDb(),
): boolean {
  const lease = requireEventLeaseIdentity(event, db);
  if (!lease) return false;
  const result = db.prepare(`
    UPDATE event_outbox
    SET status = 'processed',
        processed_at = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        lease_expires_at = NULL,
        last_error = NULL
    WHERE event_id = ?
      AND status = 'processing'
      AND lock_owner = ?
      AND fencing_token = ?
      AND lease_expires_at > datetime('now')
  `).run(lease.eventId, lease.lockOwner, lease.fencingToken);
  if (result.changes === 0) {
    if (readEventStatus(lease.eventId, db) === 'canceled') return false;
    throw new EventOutboxLeaseLostError();
  }
  return true;
}

export function markEventFailed(
  event: EventLeaseIdentity | string,
  err: unknown,
  db: Database.Database = getDb(),
): EventOutboxStatus {
  const lease = requireEventLeaseIdentity(event, db);
  if (!lease) return 'canceled';
  const row = db.prepare('SELECT attempts, status FROM event_outbox WHERE event_id = ?').get(lease.eventId) as { attempts: number; status: EventOutboxStatus } | undefined;
  if (row?.status === 'canceled') return 'canceled';
  const attempts = row?.attempts ?? 1;
  const dead = attempts >= MAX_EVENT_ATTEMPTS;
  const delaySeconds = Math.min(3600, 2 ** Math.max(0, attempts - 1) * 30);
  const result = db.prepare(`
    UPDATE event_outbox
    SET status = ?,
        not_before = datetime('now', ?),
        locked_at = NULL,
        lock_owner = NULL,
        lease_expires_at = NULL,
        last_error = ?
    WHERE event_id = ?
      AND status = 'processing'
      AND lock_owner = ?
      AND fencing_token = ?
      AND lease_expires_at > datetime('now')
  `).run(
    dead ? 'dead_letter' : 'failed',
    dead ? '+0 seconds' : `+${delaySeconds} seconds`,
    safeError(err),
    lease.eventId,
    lease.lockOwner,
    lease.fencingToken,
  );
  if (result.changes === 0) {
    if (readEventStatus(lease.eventId, db) === 'canceled') return 'canceled';
    throw new EventOutboxLeaseLostError();
  }
  if (dead) {
    logger.warn(
      { scope: 'event_outbox', eventId: lease.eventId, attempts, lastError: safeError(err) },
      'event_dead_lettered',
    );
  }
  return dead ? 'dead_letter' : 'failed';
}

export function replayEventsForType(
  eventType: string,
  input: { tenantId: number; userId?: number | null },
  db: Database.Database = getDb(),
): number {
  if (!isValidTenantUserId(input.tenantId)) throw new Error('tenantId required: must be a positive integer');
  ensureEventOutboxTables(db);
  const params: unknown[] = [eventType, input.tenantId];
  let userPredicate = '';
  if (input.userId != null) {
    if (!isValidTenantUserId(input.userId)) throw new Error('userId required: must be a positive integer when provided');
    userPredicate = 'AND user_id = ?';
    params.push(input.userId);
  }
  const result = db.prepare(`
    UPDATE event_outbox
    SET status = 'pending',
        attempts = 0,
        not_before = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        fencing_token = NULL,
        lease_expires_at = NULL,
        processed_at = NULL,
        last_error = NULL
    WHERE event_type = ?
      AND tenant_id = ?
      ${userPredicate}
      AND status IN ('processed', 'failed', 'dead_letter')
  `).run(...params);
  return result.changes;
}

export function listDeadLetterEvents(input: {
  tenantId: number;
  userId?: number | null;
  limit?: number;
}, db: Database.Database = getDb()): EventOutboxRecord[] {
  if (!isValidTenantUserId(input.tenantId)) throw new Error('tenantId required: must be a positive integer');
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 50), 200));
  const params: unknown[] = [input.tenantId];
  let userPredicate = '';
  if (input.userId != null) {
    if (!isValidTenantUserId(input.userId)) throw new Error('userId required: must be a positive integer when provided');
    userPredicate = 'AND user_id = ?';
    params.push(input.userId);
  }
  params.push(limit);
  ensureEventOutboxTables(db);
  return (db.prepare(`
    SELECT * FROM event_outbox
    WHERE tenant_id = ?
      ${userPredicate}
      AND status = 'dead_letter'
    ORDER BY created_at ASC, sequence ASC
    LIMIT ?
  `).all(...params) as any[]).map(mapEvent);
}

export function replayEvent(eventId: string, tenantId: number, db: Database.Database = getDb()): boolean {
  if (!isValidTenantUserId(tenantId)) throw new Error('tenantId required: must be a positive integer');
  ensureEventOutboxTables(db);
  const result = db.prepare(`
    UPDATE event_outbox
    SET status = 'pending',
        attempts = 0,
        not_before = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        fencing_token = NULL,
        lease_expires_at = NULL,
        processed_at = NULL,
        last_error = NULL
    WHERE event_id = ?
      AND tenant_id = ?
      AND status IN ('failed', 'dead_letter', 'canceled')
  `).run(eventId, tenantId);
  return result.changes > 0;
}

export function cancelEvent(eventId: string, tenantId: number, db: Database.Database = getDb()): boolean {
  if (!isValidTenantUserId(tenantId)) throw new Error('tenantId required: must be a positive integer');
  ensureEventOutboxTables(db);
  const result = db.prepare(`
    UPDATE event_outbox
    SET status = 'canceled',
        processed_at = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        fencing_token = NULL,
        lease_expires_at = NULL
    WHERE event_id = ?
      AND tenant_id = ?
      AND status IN ('pending', 'failed', 'processing', 'dead_letter')
  `).run(eventId, tenantId);
  return result.changes > 0;
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

export function sanitizeEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizePrivacyObject(payload, { maxDepth: 4, maxStringLength: 500 });
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function safeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

function requireEventLeaseIdentity(
  event: EventLeaseIdentity | string,
  db: Database.Database,
): { eventId: string; lockOwner: string; fencingToken: string } | null {
  const eventId = typeof event === 'string' ? event : event.eventId;
  if (typeof event !== 'string' && event.lockOwner && event.fencingToken) {
    return { eventId, lockOwner: event.lockOwner, fencingToken: event.fencingToken };
  }
  // Keep the predecessor id-only signature source-compatible, but never let it
  // bypass fencing. A cancellation remains an idempotent no-op for late work.
  if (readEventStatus(eventId, db) === 'canceled') return null;
  throw new EventOutboxLeaseLostError();
}

function readEventStatus(eventId: string, db: Database.Database): EventOutboxStatus | null {
  const row = db.prepare('SELECT status FROM event_outbox WHERE event_id = ?').get(eventId) as { status: EventOutboxStatus } | undefined;
  return row?.status ?? null;
}

function startEventLeaseHeartbeat(
  event: EventLeaseIdentity,
  db: Database.Database,
  requestedIntervalMs?: number,
): { assertActive(): void; stop(): void } {
  const intervalMs = Number.isFinite(requestedIntervalMs)
    ? Math.max(25, Math.min(Math.floor(requestedIntervalMs as number), EVENT_HEARTBEAT_INTERVAL_MS))
    : EVENT_HEARTBEAT_INTERVAL_MS;
  let renewalError: unknown = null;
  const timer = setInterval(() => {
    try {
      renewEventLease(event, db);
    } catch (err) {
      renewalError = err;
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref();
  return {
    assertActive() {
      if (renewalError) throw renewalError;
    },
    stop() {
      clearInterval(timer);
    },
  };
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
    ...(row.status === 'processing' && row.fencing_token != null ? { fencingToken: row.fencing_token as string } : {}),
    ...(row.status === 'processing' && row.lease_expires_at != null ? { leaseExpiresAt: row.lease_expires_at as string } : {}),
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
