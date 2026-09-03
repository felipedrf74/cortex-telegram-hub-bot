// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';
import { getDb } from './database';
import type { CalendarSource } from './unified-calendar';

const PROCESSING_LEASE_MS = 5 * 60 * 1_000;

export type SecretaryCalendarCommandState =
  | 'prechecking'
  | 'conflict_unknown'
  | 'review_required'
  | 'sync_pending'
  | 'succeeded';

export interface SecretaryCalendarCommandPayload {
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  categories?: string[];
  recurrence?: unknown;
  timezone: string;
  channel: 'rest' | 'ios' | 'chat';
}

export interface SecretaryCalendarCommandReceipt {
  userId: number;
  tenantId: string;
  idempotencyKey: string;
  commandInstanceId: string;
  requestHash: string;
  providerSource: CalendarSource;
  command: SecretaryCalendarCommandPayload;
  state: SecretaryCalendarCommandState;
  agendaItemId: string | null;
  decisionItemId: string | null;
  response: Record<string, unknown> | null;
  processingLeaseToken: string | null;
  processingLeaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export function claimSecretaryCalendarCommand(input: {
  userId: number;
  tenantId: string | number;
  idempotencyKey: string;
  requestHash: string;
  providerSource: CalendarSource;
  command: SecretaryCalendarCommandPayload;
  nowIso: string;
  expiresAt: string;
}): {
  receipt: SecretaryCalendarCommandReceipt;
  created: boolean;
  acquired: boolean;
  leaseToken: string | null;
} {
  const db = getDb();
  const tenantId = String(input.tenantId);
  return db.transaction(() => {
    db.prepare(`
      DELETE FROM secretary_calendar_command_receipts
       WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
         AND expires_at <= ?
    `).run(input.userId, tenantId, input.idempotencyKey, input.nowIso);

    const existing = getSecretaryCalendarCommandReceipt({
      userId: input.userId,
      tenantId,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) {
      // A conflicting caller must never acquire or extend the processing
      // lease owned by the original command. The service will translate the
      // unchanged receipt into the public 409 key-reuse response.
      if (existing.requestHash !== input.requestHash) {
        return { receipt: existing, created: false, acquired: false, leaseToken: null };
      }
      const terminal = existing.state === 'succeeded' || existing.state === 'review_required';
      const leaseActive = existing.processingLeaseToken != null
        && existing.processingLeaseExpiresAt != null
        && Date.parse(existing.processingLeaseExpiresAt) > Date.parse(input.nowIso);
      if (terminal || leaseActive) {
        return { receipt: existing, created: false, acquired: false, leaseToken: null };
      }
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(Date.parse(input.nowIso) + PROCESSING_LEASE_MS).toISOString();
      const acquired = db.prepare(`
        UPDATE secretary_calendar_command_receipts
           SET processing_lease_token = ?, processing_lease_expires_at = ?, updated_at = ?
         WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
           AND (processing_lease_expires_at IS NULL OR processing_lease_expires_at <= ?)
      `).run(
        leaseToken,
        leaseExpiresAt,
        input.nowIso,
        input.userId,
        tenantId,
        input.idempotencyKey,
        input.nowIso,
      );
      const receipt = getSecretaryCalendarCommandReceipt({
        userId: input.userId,
        tenantId,
        idempotencyKey: input.idempotencyKey,
      });
      if (!receipt) throw new Error('SECRETARY_CALENDAR_COMMAND_RECEIPT_MISSING');
      return {
        receipt,
        created: false,
        acquired: acquired.changes === 1,
        leaseToken: acquired.changes === 1 ? leaseToken : null,
      };
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(input.nowIso) + PROCESSING_LEASE_MS).toISOString();
    db.prepare(`
      INSERT INTO secretary_calendar_command_receipts (
        user_id, tenant_id, idempotency_key, command_instance_id, request_hash, provider_source,
        command_json, state, agenda_item_id, decision_item_id, response_json,
        processing_lease_token, processing_lease_expires_at,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prechecking', NULL, NULL, NULL, ?, ?, ?, ?, ?)
    `).run(
      input.userId,
      tenantId,
      input.idempotencyKey,
      randomUUID(),
      input.requestHash,
      input.providerSource,
      JSON.stringify(input.command),
      leaseToken,
      leaseExpiresAt,
      input.nowIso,
      input.nowIso,
      input.expiresAt,
    );
    const inserted = getSecretaryCalendarCommandReceipt({
      userId: input.userId,
      tenantId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!inserted) throw new Error('SECRETARY_CALENDAR_COMMAND_RECEIPT_INSERT_FAILED');
    return { receipt: inserted, created: true, acquired: true, leaseToken };
  }).immediate();
}

export function releaseSecretaryCalendarCommandProcessingLease(scope: {
  userId: number;
  tenantId: string | number;
  idempotencyKey: string;
  leaseToken: string;
}): void {
  getDb().prepare(`
    UPDATE secretary_calendar_command_receipts
       SET processing_lease_token = NULL, processing_lease_expires_at = NULL
     WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
       AND processing_lease_token = ?
  `).run(scope.userId, String(scope.tenantId), scope.idempotencyKey, scope.leaseToken);
}

export function getSecretaryCalendarCommandReceipt(scope: {
  userId: number;
  tenantId: string | number;
  idempotencyKey: string;
}): SecretaryCalendarCommandReceipt | null {
  const row = getDb().prepare(`
    SELECT *
      FROM secretary_calendar_command_receipts
     WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
  `).get(scope.userId, String(scope.tenantId), scope.idempotencyKey) as any;
  return row ? rowToReceipt(row) : null;
}

export function getSecretaryCalendarCommandPayloadForAgendaItem(
  agendaItemId: string,
): SecretaryCalendarCommandPayload | null {
  const db = getDb();
  if (!secretaryCalendarCommandTableExists(db)) return null;
  if (secretaryCalendarCommandPayloadTableExists(db)) {
    const durable = db.prepare(`
      SELECT command_json
        FROM secretary_calendar_command_payloads
       WHERE agenda_item_id = ?
       LIMIT 1
    `).get(agendaItemId) as { command_json?: string } | undefined;
    if (durable?.command_json) return parseCommand(durable.command_json);
  }
  // One-release fallback for rows created before the payload companion table.
  const row = db.prepare(`
    SELECT command_json
      FROM secretary_calendar_command_receipts
     WHERE agenda_item_id = ?
     LIMIT 1
  `).get(agendaItemId) as { command_json?: string } | undefined;
  return row?.command_json ? parseCommand(row.command_json) : null;
}

export function updateSecretaryCalendarCommandReceipt(scope: {
  userId: number;
  tenantId: string | number;
  idempotencyKey: string;
  requestHash: string;
  leaseToken: string;
}, patch: {
  state: SecretaryCalendarCommandState;
  agendaItemId?: string | null;
  decisionItemId?: string | null;
  response?: Record<string, unknown> | null;
  updatedAt: string;
}): SecretaryCalendarCommandReceipt {
  const db = getDb();
  return db.transaction(() => {
    const result = db.prepare(`
      UPDATE secretary_calendar_command_receipts
         SET state = ?,
             agenda_item_id = COALESCE(?, agenda_item_id),
             decision_item_id = COALESCE(?, decision_item_id),
             response_json = CASE WHEN ? IS NULL THEN response_json ELSE ? END,
             updated_at = ?
       WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
         AND request_hash = ?
         AND processing_lease_token = ?
    `).run(
      patch.state,
      patch.agendaItemId ?? null,
      patch.decisionItemId ?? null,
      patch.response == null ? null : 1,
      patch.response == null ? null : JSON.stringify(patch.response),
      patch.updatedAt,
      scope.userId,
      String(scope.tenantId),
      scope.idempotencyKey,
      scope.requestHash,
      scope.leaseToken,
    );
    if (result.changes !== 1) throw new Error('SECRETARY_CALENDAR_COMMAND_RECEIPT_STALE');
    const receipt = getSecretaryCalendarCommandReceipt(scope);
    if (!receipt) throw new Error('SECRETARY_CALENDAR_COMMAND_RECEIPT_MISSING');
    if (receipt.agendaItemId && secretaryCalendarCommandPayloadTableExists(db)) {
      const payloadWrite = db.prepare(`
        INSERT INTO secretary_calendar_command_payloads (
          agenda_item_id, user_id, tenant_id, command_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agenda_item_id) DO UPDATE SET
          command_json = excluded.command_json,
          updated_at = excluded.updated_at
        WHERE secretary_calendar_command_payloads.user_id = excluded.user_id
          AND secretary_calendar_command_payloads.tenant_id = excluded.tenant_id
      `).run(
        receipt.agendaItemId,
        receipt.userId,
        receipt.tenantId,
        JSON.stringify(receipt.command),
        receipt.createdAt,
        patch.updatedAt,
      );
      if (payloadWrite.changes !== 1) {
        throw new Error('SECRETARY_CALENDAR_COMMAND_PAYLOAD_SCOPE_CONFLICT');
      }
    }
    return receipt;
  })();
}

export function pruneExpiredSecretaryCalendarCommandReceipts(input: {
  nowIso?: string;
  limit?: number;
} = {}): { deleted: number; remaining: number } {
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(nowIso))) throw new Error('SECRETARY_CALENDAR_RECEIPT_RETENTION_NOW_INVALID');
  const requestedLimit = input.limit ?? 5_000;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error('SECRETARY_CALENDAR_RECEIPT_RETENTION_LIMIT_INVALID');
  }
  const limit = Math.min(requestedLimit, 5_000);
  const db = getDb();
  const deleted = db.prepare(`
    DELETE FROM secretary_calendar_command_receipts
     WHERE rowid IN (
       SELECT rowid
         FROM secretary_calendar_command_receipts
        WHERE expires_at <= ?
        ORDER BY expires_at, rowid
        LIMIT ?
     )
  `).run(nowIso, limit).changes;
  const remaining = (db.prepare(`
    SELECT COUNT(*) AS count
      FROM secretary_calendar_command_receipts
     WHERE expires_at <= ?
  `).get(nowIso) as { count: number }).count;
  return { deleted, remaining };
}

function rowToReceipt(row: any): SecretaryCalendarCommandReceipt {
  return {
    userId: Number(row.user_id),
    tenantId: String(row.tenant_id),
    idempotencyKey: String(row.idempotency_key),
    commandInstanceId: String(row.command_instance_id),
    requestHash: String(row.request_hash),
    providerSource: row.provider_source,
    command: parseCommand(row.command_json),
    state: row.state,
    agendaItemId: row.agenda_item_id ?? null,
    decisionItemId: row.decision_item_id ?? null,
    response: parseObject(row.response_json),
    processingLeaseToken: row.processing_lease_token ?? null,
    processingLeaseExpiresAt: row.processing_lease_expires_at ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at),
  };
}

function parseCommand(value: unknown): SecretaryCalendarCommandPayload {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SECRETARY_CALENDAR_COMMAND_PAYLOAD_INVALID');
  }
  return parsed as SecretaryCalendarCommandPayload;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function secretaryCalendarCommandTableExists(db = getDb()): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = 'secretary_calendar_command_receipts'
  `).get());
}

function secretaryCalendarCommandPayloadTableExists(db = getDb()): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master
     WHERE type = 'table' AND name = 'secretary_calendar_command_payloads'
  `).get());
}
