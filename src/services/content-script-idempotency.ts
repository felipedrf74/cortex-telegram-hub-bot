// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { ContentWorkspaceError, type ContentWorkspaceScope } from './content-workspace';

const CONTENT_SCRIPT_SAVE_OPERATION = 'content_script_generation_request_v1';
const CONTENT_SCRIPT_SAVE_LEASE_MS = 15 * 60_000;
const CONTENT_SCRIPT_SAVE_RESPONSE_MAX_CHARS = 2_000_000;

interface ContentScriptSaveReceiptRow {
  request_hash: string;
  resource_id: string;
  result_metadata_json: string;
}

interface ContentScriptSaveReceiptMetadata {
  status?: 'in_progress' | 'dispatched' | 'succeeded';
  leaseExpiresAt?: string;
  response?: Record<string, unknown>;
}

export type ContentScriptSaveReservation =
  | { kind: 'started'; leaseToken: string }
  | { kind: 'replay'; response: Record<string, unknown> };

export function fingerprintContentScriptSaveRequest(
  semanticRequest: Record<string, unknown>,
): string {
  return createHash('sha256').update(stableJson(semanticRequest)).digest('hex');
}

export function reserveContentScriptSaveRequest(input: {
  scope: ContentWorkspaceScope;
  idempotencyKey: string;
  requestFingerprint: string;
  nowMs?: number;
}, db: Database.Database = getDb()): ContentScriptSaveReservation {
  const nowMs = input.nowMs ?? Date.now();
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(nowMs + CONTENT_SCRIPT_SAVE_LEASE_MS).toISOString();

  return db.transaction((): ContentScriptSaveReservation => {
    const row = db.prepare(`
      SELECT request_hash, resource_id, result_metadata_json
        FROM content_mutation_receipts
       WHERE tenant_id = ? AND owner_user_id = ?
         AND operation = ? AND idempotency_key = ?
       LIMIT 1
    `).get(
      input.scope.tenantId,
      input.scope.userId,
      CONTENT_SCRIPT_SAVE_OPERATION,
      input.idempotencyKey,
    ) as ContentScriptSaveReceiptRow | undefined;

    if (row) {
      if (row.request_hash !== input.requestFingerprint) {
        throw new ContentWorkspaceError(
          'CONTENT_IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used for a different script request.',
          409,
          { operation: CONTENT_SCRIPT_SAVE_OPERATION },
        );
      }
      const metadata = parseMetadata(row.result_metadata_json);
      if (metadata.status === 'succeeded') {
        if (!isRecord(metadata.response)) {
          throw new ContentWorkspaceError(
            'CONTENT_IDEMPOTENCY_RECEIPT_INVALID',
            'The prior script response receipt is unavailable.',
            500,
          );
        }
        return { kind: 'replay', response: metadata.response };
      }
      if (metadata.status === 'dispatched') {
        throw new ContentWorkspaceError(
          'CONTENT_IDEMPOTENCY_RESULT_UNAVAILABLE',
          'The prior script request crossed the generation boundary without storing a replayable response. Use a new idempotency key to retry.',
          409,
          { requiresNewKey: true },
        );
      }
      const existingLeaseEnd = Date.parse(metadata.leaseExpiresAt ?? '');
      if (metadata.status === 'in_progress' && Number.isFinite(existingLeaseEnd) && existingLeaseEnd > nowMs) {
        throw new ContentWorkspaceError(
          'CONTENT_IDEMPOTENCY_IN_PROGRESS',
          'This script request is already in progress.',
          409,
          { retryAfterSeconds: Math.max(1, Math.ceil((existingLeaseEnd - nowMs) / 1_000)) },
        );
      }
      const updated = db.prepare(`
        UPDATE content_mutation_receipts
           SET resource_id = ?, result_metadata_json = ?
         WHERE tenant_id = ? AND owner_user_id = ?
           AND operation = ? AND idempotency_key = ? AND request_hash = ?
      `).run(
        leaseToken,
        JSON.stringify({ status: 'in_progress', leaseExpiresAt }),
        input.scope.tenantId,
        input.scope.userId,
        CONTENT_SCRIPT_SAVE_OPERATION,
        input.idempotencyKey,
        input.requestFingerprint,
      );
      if (updated.changes !== 1) throw receiptIntegrityError();
      return { kind: 'started', leaseToken };
    }

    db.prepare(`
      INSERT INTO content_mutation_receipts (
        tenant_id, owner_user_id, operation, idempotency_key,
        request_hash, resource_type, resource_id, result_metadata_json
      ) VALUES (?, ?, ?, ?, ?, 'content_script_request', ?, ?)
    `).run(
      input.scope.tenantId,
      input.scope.userId,
      CONTENT_SCRIPT_SAVE_OPERATION,
      input.idempotencyKey,
      input.requestFingerprint,
      leaseToken,
      JSON.stringify({ status: 'in_progress', leaseExpiresAt }),
    );
    return { kind: 'started', leaseToken };
  }).immediate();
}

/**
 * Permanently close lease reclamation before entering the model-backed
 * generation boundary. A process crash or cancelled request after this point
 * may have consumed provider work without producing a durable public response;
 * silently reclaiming the same key would repeat that work.
 */
export function markContentScriptSaveRequestDispatched(input: {
  scope: ContentWorkspaceScope;
  idempotencyKey: string;
  requestFingerprint: string;
  leaseToken: string;
}, db: Database.Database = getDb()): void {
  const result = db.prepare(`
    UPDATE content_mutation_receipts
       SET result_metadata_json = ?
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = ? AND idempotency_key = ?
       AND request_hash = ? AND resource_id = ?
       AND json_extract(result_metadata_json, '$.status') = 'in_progress'
  `).run(
    JSON.stringify({ status: 'dispatched' }),
    input.scope.tenantId,
    input.scope.userId,
    CONTENT_SCRIPT_SAVE_OPERATION,
    input.idempotencyKey,
    input.requestFingerprint,
    input.leaseToken,
  );
  if (result.changes !== 1) throw receiptIntegrityError();
}

export function completeContentScriptSaveRequest(input: {
  scope: ContentWorkspaceScope;
  idempotencyKey: string;
  requestFingerprint: string;
  leaseToken: string;
  response: Record<string, unknown>;
}, db: Database.Database = getDb()): void {
  const responseJson = JSON.stringify(input.response);
  if (responseJson.length > CONTENT_SCRIPT_SAVE_RESPONSE_MAX_CHARS) {
    throw new ContentWorkspaceError(
      'CONTENT_IDEMPOTENCY_RESPONSE_TOO_LARGE',
      'The script response exceeded the durable replay limit.',
      500,
    );
  }
  const result = db.prepare(`
    UPDATE content_mutation_receipts
       SET resource_type = 'content_script_response',
           result_metadata_json = ?
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = ? AND idempotency_key = ?
       AND request_hash = ? AND resource_id = ?
       AND json_extract(result_metadata_json, '$.status') = 'dispatched'
  `).run(
    JSON.stringify({ status: 'succeeded', response: JSON.parse(responseJson) }),
    input.scope.tenantId,
    input.scope.userId,
    CONTENT_SCRIPT_SAVE_OPERATION,
    input.idempotencyKey,
    input.requestFingerprint,
    input.leaseToken,
  );
  if (result.changes !== 1) throw receiptIntegrityError();
}

/**
 * Build the durable public response and settle its idempotency receipt in one
 * SQLite transaction. Callers that persist the canonical workspace from the
 * callback must pass the supplied database handle into that persistence
 * boundary. If either the workspace mutation or receipt update fails, both are
 * rolled back so a retry can never observe an orphaned revision.
 */
export function completeContentScriptSaveRequestAtomically(input: {
  scope: ContentWorkspaceScope;
  idempotencyKey: string;
  requestFingerprint: string;
  leaseToken: string;
  buildResponse: (db: Database.Database) => Record<string, unknown>;
}, db: Database.Database = getDb()): Record<string, unknown> {
  return db.transaction(() => {
    const response = input.buildResponse(db);
    completeContentScriptSaveRequest({
      scope: input.scope,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      leaseToken: input.leaseToken,
      response,
    }, db);
    return response;
  }).immediate();
}

export function releaseContentScriptSaveRequest(input: {
  scope: ContentWorkspaceScope;
  idempotencyKey: string;
  requestFingerprint: string;
  leaseToken: string;
}, db: Database.Database = getDb()): void {
  db.prepare(`
    DELETE FROM content_mutation_receipts
     WHERE tenant_id = ? AND owner_user_id = ?
       AND operation = ? AND idempotency_key = ?
       AND request_hash = ? AND resource_id = ?
       AND json_extract(result_metadata_json, '$.status') = 'in_progress'
  `).run(
    input.scope.tenantId,
    input.scope.userId,
    CONTENT_SCRIPT_SAVE_OPERATION,
    input.idempotencyKey,
    input.requestFingerprint,
    input.leaseToken,
  );
}

function parseMetadata(raw: string): ContentScriptSaveReceiptMetadata {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed as ContentScriptSaveReceiptMetadata : {};
  } catch {
    return {};
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return 'null';
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function receiptIntegrityError(): ContentWorkspaceError {
  return new ContentWorkspaceError(
    'CONTENT_IDEMPOTENCY_RECEIPT_INVALID',
    'The script idempotency receipt changed unexpectedly.',
    500,
  );
}
