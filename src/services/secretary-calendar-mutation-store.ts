// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';
import { getDb } from './database';
import type { CalendarSource } from './unified-calendar';

const PROCESSING_LEASE_MS = 5 * 60 * 1_000;

export type SecretaryCalendarMutationState =
  | 'prechecking'
  | 'write_pending'
  | 'review_required'
  | 'succeeded';

export interface SecretaryCalendarMutationReceipt {
  userId: number;
  tenantId: string;
  idempotencyKey: string;
  requestHash: string;
  operation: 'update' | 'delete';
  providerSource: CalendarSource;
  providerEventId: string;
  command: Record<string, unknown>;
  state: SecretaryCalendarMutationState;
  response: Record<string, unknown> | null;
  processingLeaseToken: string | null;
  processingLeaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export function claimSecretaryCalendarMutation(input: {
  userId: number;
  tenantId: string | number;
  idempotencyKey: string;
  requestHash: string;
  operation: 'update' | 'delete';
  providerSource: CalendarSource;
  providerEventId: string;
  command: Record<string, unknown>;
  nowIso: string;
  expiresAt: string;
}): {
  receipt: SecretaryCalendarMutationReceipt;
  created: boolean;
  acquired: boolean;
  leaseToken: string | null;
} {
  const db = getDb();
  const tenantId = String(input.tenantId);
  return db.transaction(() => {
    db.prepare(`
      DELETE FROM secretary_calendar_mutation_receipts
       WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
         AND expires_at <= ?
    `).run(input.userId, tenantId, input.idempotencyKey, input.nowIso);
    const existing = getSecretaryCalendarMutationReceipt({
      userId: input.userId,
      tenantId,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) {
      // Do not let a different payload hijack or postpone the original
      // command's processing lease. The service maps this unchanged receipt
      // to IDEMPOTENCY_KEY_REUSED without mutating provider or cache state.
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
        UPDATE secretary_calendar_mutation_receipts
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
      const receipt = getSecretaryCalendarMutationReceipt({
        userId: input.userId,
        tenantId,
        idempotencyKey: input.idempotencyKey,
      });
      if (!receipt) throw new Error('SECRETARY_CALENDAR_MUTATION_RECEIPT_MISSING');
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
      INSERT INTO secretary_calendar_mutation_receipts (
        user_id, tenant_id, idempotency_key, request_hash, operation,
        provider_source, provider_event_id, command_json, state,
        response_json, processing_lease_token, processing_lease_expires_at,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prechecking', NULL, ?, ?, ?, ?, ?)
    `).run(
      input.userId,
      tenantId,
      input.idempotencyKey,
      input.requestHash,
      input.operation,
      input.providerSource,
      input.providerEventId,
      JSON.stringify(input.command),
      leaseToken,
      leaseExpiresAt,
      input.nowIso,
      input.nowIso,
      input.expiresAt,
    );
    const inserted = getSecretaryCalendarMutationReceipt({
      userId: input.userId,
      tenantId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!inserted) throw new Error('SECRETARY_CALENDAR_MUTATION_RECEIPT_INSERT_FAILED');
    return { receipt: inserted, created: true, acquired: true, leaseToken };
  }).immediate();
}

export function releaseSecretaryCalendarMutationProcessingLease(scope: {
  userId: number;
  tenantId: string | number;
  idempotencyKey: string;
  leaseToken: string;
}): void {
  getDb().prepare(`
    UPDATE secretary_calendar_mutation_receipts
       SET processing_lease_token = NULL, processing_lease_expires_at = NULL
     WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
       AND processing_lease_token = ?
  `).run(scope.userId, String(scope.tenantId), scope.idempotencyKey, scope.leaseToken);
}

export function getSecretaryCalendarMutationReceipt(scope: {
  userId: number;
  tenantId: string | number;
  idempotencyKey: string;
}): SecretaryCalendarMutationReceipt | null {
  const row = getDb().prepare(`
    SELECT * FROM secretary_calendar_mutation_receipts
     WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
  `).get(scope.userId, String(scope.tenantId), scope.idempotencyKey) as any;
  return row ? rowToReceipt(row) : null;
}

export function updateSecretaryCalendarMutationReceipt(scope: {
  userId: number;
  tenantId: string | number;
  idempotencyKey: string;
  requestHash: string;
  leaseToken: string;
}, patch: {
  state: SecretaryCalendarMutationState;
  response?: Record<string, unknown> | null;
  updatedAt: string;
}): SecretaryCalendarMutationReceipt {
  const result = getDb().prepare(`
    UPDATE secretary_calendar_mutation_receipts
       SET state = ?,
           response_json = CASE WHEN ? IS NULL THEN response_json ELSE ? END,
           updated_at = ?
     WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
       AND request_hash = ?
       AND processing_lease_token = ?
  `).run(
    patch.state,
    patch.response == null ? null : 1,
    patch.response == null ? null : JSON.stringify(patch.response),
    patch.updatedAt,
    scope.userId,
    String(scope.tenantId),
    scope.idempotencyKey,
    scope.requestHash,
    scope.leaseToken,
  );
  if (result.changes !== 1) throw new Error('SECRETARY_CALENDAR_MUTATION_RECEIPT_STALE');
  const receipt = getSecretaryCalendarMutationReceipt(scope);
  if (!receipt) throw new Error('SECRETARY_CALENDAR_MUTATION_RECEIPT_MISSING');
  return receipt;
}

export function pruneExpiredSecretaryCalendarMutationReceipts(input: {
  nowIso?: string;
  limit?: number;
} = {}): { deleted: number; remaining: number } {
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(nowIso))) throw new Error('SECRETARY_CALENDAR_MUTATION_RETENTION_NOW_INVALID');
  const requestedLimit = input.limit ?? 5_000;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error('SECRETARY_CALENDAR_MUTATION_RETENTION_LIMIT_INVALID');
  }
  const limit = Math.min(requestedLimit, 5_000);
  const db = getDb();
  const deleted = db.prepare(`
    DELETE FROM secretary_calendar_mutation_receipts
     WHERE rowid IN (
       SELECT rowid FROM secretary_calendar_mutation_receipts
        WHERE expires_at <= ?
        ORDER BY expires_at, rowid
        LIMIT ?
     )
  `).run(nowIso, limit).changes;
  const remaining = (db.prepare(`
    SELECT COUNT(*) AS count FROM secretary_calendar_mutation_receipts
     WHERE expires_at <= ?
  `).get(nowIso) as { count: number }).count;
  return { deleted, remaining };
}

function rowToReceipt(row: any): SecretaryCalendarMutationReceipt {
  return {
    userId: Number(row.user_id),
    tenantId: String(row.tenant_id),
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    operation: row.operation,
    providerSource: row.provider_source,
    providerEventId: String(row.provider_event_id),
    command: parseObject(row.command_json) ?? {},
    state: row.state,
    response: parseObject(row.response_json),
    processingLeaseToken: row.processing_lease_token ?? null,
    processingLeaseExpiresAt: row.processing_lease_expires_at ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at),
  };
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}
