// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Durable, privacy-bounded receipt for an authenticated client's explicit
 * receipt-analysis consent assertion and the one exact transfer it approved.
 *
 * This does not prove a physical tap. It records that the authenticated
 * tenant/user client asserted the current disclosure and scope with a fresh
 * client-generated UUID. The route computes the transfer digest independently,
 * verifies the client digest, and commits an HMAC-bound execution
 * claim before it parses OCR text, reserves AI budget, or calls a provider.
 * Raw UUIDs, image bytes, OCR text, and provider responses never enter the
 * audit row. A successful response is cached only as tenant-scoped encrypted
 * finance data so an uncertain network retry cannot spend twice.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { decryptValue, encryptValue } from '../utils/encryption';

export const RECEIPT_AI_TRANSFER_DISCLOSURE_VERSION = 'receipt-ai-transfer-v1' as const;
export const RECEIPT_AI_TRANSFER_SCOPE = 'receipt_image_and_ocr_to_configured_ai_providers' as const;
export const RECEIPT_AI_TRANSFER_DIGEST_VERSION = 'receipt-ai-transfer-payload-v1' as const;

const RECEIPT_AI_TRANSFER_AUDIT_ACTION = 'privacy_consent';
const RECEIPT_AI_TRANSFER_AUDIT_RESOURCE = 'finance.receipt_ai_transfer';
const RECEIPT_AI_TRANSFER_AUDIT_SCHEMA = 'receipt-ai-transfer-consent-audit-v2';
const RECEIPT_AI_TRANSFER_RESPONSE_TTL_HOURS = 24;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface ReceiptAiTransferConsent {
  granted: true;
  disclosureVersion: typeof RECEIPT_AI_TRANSFER_DISCLOSURE_VERSION;
  scope: typeof RECEIPT_AI_TRANSFER_SCOPE;
  consentReceiptId: string;
  transferDigest: string;
}

export interface ReceiptAiTransferPayload {
  imageBytes?: Uint8Array;
  mimeType?: string;
  ocrHint?: string;
}

export type ReceiptAiTransferExecutionClaim =
  | { state: 'claimed'; acceptedAt: string }
  | { state: 'in_progress'; acceptedAt: string }
  | { state: 'completed'; acceptedAt: string; responseData: unknown }
  | { state: 'completed_expired'; acceptedAt: string }
  | {
    state: 'failed';
    acceptedAt: string;
    error: { code: string; message: string; status: number };
  };

interface StoredConsentDetails {
  schemaVersion: typeof RECEIPT_AI_TRANSFER_AUDIT_SCHEMA;
  consentReceiptKeyHash: string;
  transferBindingHash: string;
  transferDigestVersion: typeof RECEIPT_AI_TRANSFER_DIGEST_VERSION;
  assertion: 'authenticated_client_asserted';
  disclosureVersion: typeof RECEIPT_AI_TRANSFER_DISCLOSURE_VERSION;
  scope: typeof RECEIPT_AI_TRANSFER_SCOPE;
  source: 'finance_parse_receipt_api';
}

interface StoredAuditRow {
  id: number;
  ts: string;
  details: string | null;
}

interface StoredExecutionRow {
  status: 'in_progress' | 'completed' | 'failed';
  transfer_binding_hash: string;
  response_ciphertext: string | null;
  response_expires_at: string | null;
  error_code: string | null;
  error_message: string | null;
  error_status: number | null;
}

export class ReceiptAiTransferReplayConflictError extends Error {
  readonly code = 'AI_TRANSFER_CONSENT_REPLAY_CONFLICT';

  constructor() {
    super('The consent receipt is already bound to a different receipt transfer.');
    this.name = 'ReceiptAiTransferReplayConflictError';
  }
}

export function parseReceiptAiTransferConsent(value: unknown): ReceiptAiTransferConsent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const consent = value as Record<string, unknown>;
  const consentReceiptId = typeof consent.consentReceiptId === 'string'
    ? consent.consentReceiptId.trim().toLowerCase()
    : '';
  const transferDigest = typeof consent.transferDigest === 'string'
    ? consent.transferDigest.trim().toLowerCase()
    : '';
  if (!UUID_RE.test(consentReceiptId) || !SHA256_RE.test(transferDigest)) return null;
  if (consent.granted !== true
    || consent.disclosureVersion !== RECEIPT_AI_TRANSFER_DISCLOSURE_VERSION
    || consent.scope !== RECEIPT_AI_TRANSFER_SCOPE) {
    return null;
  }
  return {
    granted: true,
    disclosureVersion: RECEIPT_AI_TRANSFER_DISCLOSURE_VERSION,
    scope: RECEIPT_AI_TRANSFER_SCOPE,
    consentReceiptId,
    transferDigest,
  };
}

/**
 * Cross-platform transfer digest shared with iOS. MIME is canonicalized,
 * image data is hashed as decoded bytes (never its base64 representation), and
 * OCR is Unicode/newline normalized without trimming user-visible content.
 * Each optional field is length framed so absent and empty remain distinct.
 */
export function computeReceiptAiTransferDigest(payload: ReceiptAiTransferPayload): string {
  const hash = createHash('sha256');
  hash.update(RECEIPT_AI_TRANSFER_DIGEST_VERSION, 'utf8');
  updateDigestField(hash, utf8Bytes(normalizeReceiptAiTransferMimeType(payload.mimeType)));
  updateDigestField(hash, payload.imageBytes);
  updateDigestField(hash, utf8Bytes(normalizeReceiptAiTransferOcrHint(payload.ocrHint)));
  return hash.digest('hex');
}

export function normalizeReceiptAiTransferMimeType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

export function normalizeReceiptAiTransferOcrHint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

export function receiptAiTransferDigestMatches(
  assertedDigest: string,
  computedDigest: string,
): boolean {
  if (!SHA256_RE.test(assertedDigest) || !SHA256_RE.test(computedDigest)) return false;
  return timingSafeEqual(Buffer.from(assertedDigest, 'hex'), Buffer.from(computedDigest, 'hex'));
}

export function claimReceiptAiTransferExecution(
  input: {
    tenantId: number;
    userId: number;
    actorId: number;
    consent: ReceiptAiTransferConsent;
    computedTransferDigest: string;
    protectionSecret: string;
  },
  db: Database.Database = getDb(),
): ReceiptAiTransferExecutionClaim {
  const consent = parseReceiptAiTransferConsent(input.consent);
  const protectionSecret = input.protectionSecret.trim();
  if (!Number.isSafeInteger(input.tenantId) || input.tenantId <= 0
    || !Number.isSafeInteger(input.userId) || input.userId <= 0
    || input.actorId !== input.userId
    || !consent
    || !SHA256_RE.test(input.computedTransferDigest)
    || protectionSecret.length < 32) {
    throw new Error('Receipt AI transfer consent requires authenticated scope and durable protection');
  }

  const consentReceiptKeyHash = scopedReceiptKeyHash(
    input.tenantId,
    input.userId,
    consent.consentReceiptId,
  );
  const transferBindingHash = scopedTransferBindingHash(
    protectionSecret,
    input.tenantId,
    input.userId,
    input.computedTransferDigest,
  );
  const details: StoredConsentDetails = {
    schemaVersion: RECEIPT_AI_TRANSFER_AUDIT_SCHEMA,
    consentReceiptKeyHash,
    transferBindingHash,
    transferDigestVersion: RECEIPT_AI_TRANSFER_DIGEST_VERSION,
    assertion: 'authenticated_client_asserted',
    disclosureVersion: consent.disclosureVersion,
    scope: consent.scope,
    source: 'finance_parse_receipt_api',
  };

  return db.transaction((): ReceiptAiTransferExecutionClaim => {
    let auditRow = findStoredConsentReceipt(
      db,
      input.tenantId,
      input.userId,
      input.actorId,
      consentReceiptKeyHash,
    );
    if (auditRow) {
      if (storedReceiptKeyMatches(auditRow.details, consentReceiptKeyHash)
        && !storedDetailsMatch(auditRow.details, details)) {
        throw new ReceiptAiTransferReplayConflictError();
      }
      if (!storedDetailsMatch(auditRow.details, details)) {
        throw new Error('Receipt AI transfer consent receipt integrity mismatch');
      }
    } else {
      const inserted = db.prepare(`
        INSERT INTO audit_trail (
          tenant_id, user_id, actor_id, action, resource, details
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.tenantId,
        input.userId,
        input.actorId,
        RECEIPT_AI_TRANSFER_AUDIT_ACTION,
        RECEIPT_AI_TRANSFER_AUDIT_RESOURCE,
        JSON.stringify(details),
      );
      auditRow = db.prepare(`
        SELECT id, ts, details
          FROM audit_trail
         WHERE id = ?
           AND tenant_id = ?
           AND user_id = ?
           AND actor_id = ?
      `).get(inserted.lastInsertRowid, input.tenantId, input.userId, input.actorId) as StoredAuditRow | undefined;
      if (!auditRow || !storedDetailsMatch(auditRow.details, details)) {
        throw new Error('Receipt AI transfer consent receipt could not be verified');
      }
    }

    // Request-time housekeeping covers every expired response in the active
    // tenant/user scope, not only a replay of the same consent UUID.
    pruneExpiredReceiptAiTransferResponses(
      { tenantId: input.tenantId, userId: input.userId },
      db,
    );

    const existingExecution = findStoredExecution(
      db,
      input.tenantId,
      input.userId,
      consentReceiptKeyHash,
    );
    if (existingExecution) {
      if (existingExecution.transfer_binding_hash !== transferBindingHash) {
        throw new ReceiptAiTransferReplayConflictError();
      }
      return replayStoredExecution(existingExecution, auditRow.ts, protectionSecret, input.userId);
    }

    db.prepare(`
      INSERT INTO receipt_ai_transfer_executions (
        tenant_id, user_id, consent_receipt_key_hash, transfer_binding_hash, status
      ) VALUES (?, ?, ?, ?, 'in_progress')
    `).run(input.tenantId, input.userId, consentReceiptKeyHash, transferBindingHash);

    return { state: 'claimed', acceptedAt: auditRow.ts };
  }).immediate();
}

export function completeReceiptAiTransferExecution(
  input: {
    tenantId: number;
    userId: number;
    consentReceiptId: string;
    computedTransferDigest: string;
    responseData: unknown;
    protectionSecret: string;
  },
  db: Database.Database = getDb(),
): void {
  const scope = executionScope(input);
  const encoded = JSON.stringify(input.responseData);
  if (encoded === undefined) throw new Error('Receipt AI response is not JSON serializable');
  const encrypted = encryptValue(encoded, scope.protectionSecret, input.userId);
  const result = db.prepare(`
    UPDATE receipt_ai_transfer_executions
       SET status = 'completed',
           response_ciphertext = ?,
           response_expires_at = datetime('now', ?),
           error_code = NULL,
           error_message = NULL,
           error_status = NULL,
           updated_at = datetime('now')
     WHERE tenant_id = ?
       AND user_id = ?
       AND consent_receipt_key_hash = ?
       AND transfer_binding_hash = ?
       AND status = 'in_progress'
  `).run(
    encrypted,
    `+${RECEIPT_AI_TRANSFER_RESPONSE_TTL_HOURS} hours`,
    input.tenantId,
    input.userId,
    scope.consentReceiptKeyHash,
    scope.transferBindingHash,
  );
  if (result.changes !== 1) {
    throw new Error('Receipt AI transfer completion could not be committed');
  }
}

export function failReceiptAiTransferExecution(
  input: {
    tenantId: number;
    userId: number;
    consentReceiptId: string;
    computedTransferDigest: string;
    protectionSecret: string;
    error: { code: string; message: string; status: number };
  },
  db: Database.Database = getDb(),
): void {
  const scope = executionScope(input);
  const error = normalizeStoredError(input.error);
  const result = db.prepare(`
    UPDATE receipt_ai_transfer_executions
       SET status = 'failed',
           response_ciphertext = NULL,
           response_expires_at = NULL,
           error_code = ?,
           error_message = ?,
           error_status = ?,
           updated_at = datetime('now')
     WHERE tenant_id = ?
       AND user_id = ?
       AND consent_receipt_key_hash = ?
       AND transfer_binding_hash = ?
       AND status = 'in_progress'
  `).run(
    error.code,
    error.message,
    error.status,
    input.tenantId,
    input.userId,
    scope.consentReceiptKeyHash,
    scope.transferBindingHash,
  );
  if (result.changes !== 1) {
    throw new Error('Receipt AI transfer failure could not be committed');
  }
}

/** Remove only an unspent claim (for example, a budget rejection). */
export function releaseReceiptAiTransferExecutionClaim(
  input: {
    tenantId: number;
    userId: number;
    consentReceiptId: string;
    computedTransferDigest: string;
    protectionSecret: string;
  },
  db: Database.Database = getDb(),
): void {
  const scope = executionScope(input);
  db.prepare(`
    DELETE FROM receipt_ai_transfer_executions
     WHERE tenant_id = ?
       AND user_id = ?
       AND consent_receipt_key_hash = ?
       AND transfer_binding_hash = ?
       AND status = 'in_progress'
  `).run(
    input.tenantId,
    input.userId,
    scope.consentReceiptKeyHash,
    scope.transferBindingHash,
  );
}

/**
 * Erase expired encrypted replay payloads while preserving terminal rows as
 * the no-double-spend guard. With no scope this is safe startup housekeeping;
 * with tenant/user scope it is also run before every eligible request claim.
 */
export function pruneExpiredReceiptAiTransferResponses(
  scope: { tenantId?: number; userId?: number } = {},
  db: Database.Database = getDb(),
): number {
  if (scope.tenantId !== undefined
    && (!Number.isSafeInteger(scope.tenantId) || scope.tenantId <= 0)) {
    throw new Error('Invalid receipt AI transfer retention tenant scope');
  }
  if (scope.userId !== undefined
    && (!Number.isSafeInteger(scope.userId) || scope.userId <= 0)) {
    throw new Error('Invalid receipt AI transfer retention user scope');
  }
  if (scope.userId !== undefined && scope.tenantId === undefined) {
    throw new Error('Receipt AI transfer user retention scope requires tenant scope');
  }

  const clauses = [
    "status = 'completed'",
    'response_ciphertext IS NOT NULL',
    'response_expires_at IS NOT NULL',
    "datetime(response_expires_at) <= datetime('now')",
  ];
  const params: number[] = [];
  if (scope.tenantId !== undefined) {
    clauses.push('tenant_id = ?');
    params.push(scope.tenantId);
  }
  if (scope.userId !== undefined) {
    clauses.push('user_id = ?');
    params.push(scope.userId);
  }

  const result = db.prepare(`
    UPDATE receipt_ai_transfer_executions
       SET response_ciphertext = NULL,
           updated_at = datetime('now')
     WHERE ${clauses.join('\n       AND ')}
  `).run(...params);
  return result.changes;
}

function updateDigestField(hash: ReturnType<typeof createHash>, value: Uint8Array | undefined): void {
  if (value === undefined) {
    hash.update(Buffer.from([0]));
    return;
  }
  const bytes = Buffer.from(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(Buffer.from([1]));
  hash.update(length);
  hash.update(bytes);
}

function utf8Bytes(value: string | undefined): Uint8Array | undefined {
  return value === undefined ? undefined : Buffer.from(value, 'utf8');
}

function replayStoredExecution(
  row: StoredExecutionRow,
  acceptedAt: string,
  protectionSecret: string,
  userId: number,
): ReceiptAiTransferExecutionClaim {
  if (row.status === 'in_progress') return { state: 'in_progress', acceptedAt };
  if (row.status === 'failed') {
    return {
      state: 'failed',
      acceptedAt,
      error: normalizeStoredError({
        code: row.error_code ?? 'RECEIPT_AI_ANALYSIS_FAILED',
        message: row.error_message ?? 'Receipt analysis failed.',
        status: row.error_status ?? 500,
      }),
    };
  }
  if (!row.response_ciphertext
    || !row.response_expires_at
    || Date.parse(`${row.response_expires_at.replace(' ', 'T')}Z`) <= Date.now()) {
    return { state: 'completed_expired', acceptedAt };
  }
  const decoded = decryptValue(row.response_ciphertext, protectionSecret, userId);
  return { state: 'completed', acceptedAt, responseData: JSON.parse(decoded) };
}

function executionScope(input: {
  tenantId: number;
  userId: number;
  consentReceiptId: string;
  computedTransferDigest: string;
  protectionSecret: string;
}): {
  consentReceiptKeyHash: string;
  transferBindingHash: string;
  protectionSecret: string;
} {
  const protectionSecret = input.protectionSecret.trim();
  if (!Number.isSafeInteger(input.tenantId) || input.tenantId <= 0
    || !Number.isSafeInteger(input.userId) || input.userId <= 0
    || !UUID_RE.test(input.consentReceiptId)
    || !SHA256_RE.test(input.computedTransferDigest)
    || protectionSecret.length < 32) {
    throw new Error('Invalid receipt AI transfer execution scope');
  }
  return {
    consentReceiptKeyHash: scopedReceiptKeyHash(input.tenantId, input.userId, input.consentReceiptId),
    transferBindingHash: scopedTransferBindingHash(
      protectionSecret,
      input.tenantId,
      input.userId,
      input.computedTransferDigest,
    ),
    protectionSecret,
  };
}

function findStoredConsentReceipt(
  db: Database.Database,
  tenantId: number,
  userId: number,
  actorId: number,
  consentReceiptKeyHash: string,
): StoredAuditRow | undefined {
  return db.prepare(`
    SELECT id, ts, details
      FROM audit_trail
     WHERE tenant_id = ?
       AND user_id = ?
       AND actor_id = ?
       AND action = ?
       AND resource = ?
       AND json_extract(
         CASE WHEN json_valid(details) THEN details ELSE '{}' END,
         '$.consentReceiptKeyHash'
       ) = ?
     ORDER BY id ASC
     LIMIT 1
  `).get(
    tenantId,
    userId,
    actorId,
    RECEIPT_AI_TRANSFER_AUDIT_ACTION,
    RECEIPT_AI_TRANSFER_AUDIT_RESOURCE,
    consentReceiptKeyHash,
  ) as StoredAuditRow | undefined;
}

function findStoredExecution(
  db: Database.Database,
  tenantId: number,
  userId: number,
  consentReceiptKeyHash: string,
): StoredExecutionRow | undefined {
  return db.prepare(`
    SELECT status, transfer_binding_hash, response_ciphertext, response_expires_at,
           error_code, error_message, error_status
      FROM receipt_ai_transfer_executions
     WHERE tenant_id = ?
       AND user_id = ?
       AND consent_receipt_key_hash = ?
     LIMIT 1
  `).get(tenantId, userId, consentReceiptKeyHash) as StoredExecutionRow | undefined;
}

function storedReceiptKeyMatches(raw: string | null, expectedKeyHash: string): boolean {
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as Record<string, unknown>).consentReceiptKeyHash === expectedKeyHash;
  } catch {
    return false;
  }
}

function storedDetailsMatch(raw: string | null, expected: StoredConsentDetails): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.schemaVersion === expected.schemaVersion
      && parsed.consentReceiptKeyHash === expected.consentReceiptKeyHash
      && parsed.transferBindingHash === expected.transferBindingHash
      && parsed.transferDigestVersion === expected.transferDigestVersion
      && parsed.assertion === expected.assertion
      && parsed.disclosureVersion === expected.disclosureVersion
      && parsed.scope === expected.scope
      && parsed.source === expected.source;
  } catch {
    return false;
  }
}

function scopedReceiptKeyHash(tenantId: number, userId: number, consentReceiptId: string): string {
  return createHash('sha256')
    .update(`receipt-ai-transfer:${tenantId}:${userId}:${consentReceiptId}`)
    .digest('hex');
}

function scopedTransferBindingHash(
  secret: string,
  tenantId: number,
  userId: number,
  transferDigest: string,
): string {
  return createHmac('sha256', secret)
    .update(`receipt-ai-transfer-binding:v1:${tenantId}:${userId}:${transferDigest}`)
    .digest('hex');
}

function normalizeStoredError(error: { code: string; message: string; status: number }): {
  code: string;
  message: string;
  status: number;
} {
  const allowlisted: Record<string, { code: string; message: string; status: number }> = {
    INTERNAL: {
      code: 'INTERNAL',
      message: 'Receipt parsing failed',
      status: 500,
    },
    BAD_REQUEST: {
      code: 'BAD_REQUEST',
      message: 'Receipt data could not be analyzed.',
      status: 400,
    },
    RECEIPT_AI_ANALYSIS_FAILED: {
      code: 'RECEIPT_AI_ANALYSIS_FAILED',
      message: 'Receipt analysis failed.',
      status: 500,
    },
  };
  return allowlisted[error.code] ?? allowlisted.RECEIPT_AI_ANALYSIS_FAILED;
}
