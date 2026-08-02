// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { requireTenantIdParam } from './tenant-scope';

type TrainingPlanGenerationIdempotencyStatus = 'in_progress' | 'succeeded' | 'failed';

export type TrainingPlanGenerationIdempotencyClaim =
  | { kind: 'not_requested' }
  | { kind: 'claimed'; idempotencyKey: string; requestHash: string }
  | { kind: 'replay'; idempotencyKey: string; responseData: Record<string, unknown>; statusCode: number }
  | { kind: 'in_progress'; idempotencyKey: string }
  | { kind: 'conflict'; idempotencyKey: string };

type IdempotencyRow = {
  user_id: number;
  tenant_id: number;
  idempotency_key: string;
  request_hash: string;
  status: TrainingPlanGenerationIdempotencyStatus;
  response_json: string | null;
  status_code: number | null;
  created_at: string | null;
  updated_at: string | null;
  // F1 (Phase 1A-4) lease columns (migration 273). Optional so rows read
  // before the migration lands still type-check.
  failure_class?: 'retryable' | 'terminal' | null;
  last_error_code?: string | null;
  lease_owner?: string | null;
  fencing_token?: string | null;
  lease_expires_at?: string | null;
  heartbeat_at?: string | null;
  attempt_count?: number | null;
};

/**
 * Generous enough to exceed the worst-case generation. Calendar writes run
 * ceil(N/5) x 15s, so a 52-week plan can legitimately take ~18 minutes; a
 * lease shorter than that would reclaim live work.
 */
const LEASE_TTL_MS = 30 * 60_000;

function leaseExpiryIso(fromMs: number = Date.now()): string {
  return new Date(fromMs + LEASE_TTL_MS).toISOString();
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A claim is reclaimable only when its lease has demonstrably elapsed.
 *
 * A row with no `lease_expires_at` at all is treated as NOT expired. That is
 * deliberate: pre-migration rows are backfilled with a derived expiry, so a
 * missing value means an unexpected shape, and failing closed keeps the
 * concurrent-duplicate guarantee that the original design got right.
 */
function isLeaseExpired(row: IdempotencyRow, nowMs: number = Date.now()): boolean {
  const expiresAtMs = parseIsoMs(row.lease_expires_at);
  if (expiresAtMs === null) return false;
  return expiresAtMs <= nowMs;
}

function reclaimRow(row: IdempotencyRow, requestHash: string): TrainingPlanGenerationIdempotencyClaim {
  const db = getOptionalDb();
  const nowIso = new Date().toISOString();
  const nextAttempt = (row.attempt_count ?? 1) + 1;
  if (db) {
    db.prepare(`
      UPDATE ${IDEMPOTENCY_TABLE}
         SET status = 'in_progress',
             response_json = NULL,
             status_code = NULL,
             failure_class = NULL,
             lease_expires_at = ?,
             heartbeat_at = ?,
             attempt_count = ?,
             updated_at = ?
       WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
    `).run(
      leaseExpiryIso(), nowIso, nextAttempt, nowIso,
      row.user_id, row.tenant_id, row.idempotency_key,
    );
  } else {
    MEMORY_ROWS.set(memoryKey(row.user_id, row.tenant_id, row.idempotency_key), {
      ...row,
      status: 'in_progress',
      response_json: null,
      status_code: null,
      failure_class: null,
      lease_expires_at: leaseExpiryIso(),
      heartbeat_at: nowIso,
      attempt_count: nextAttempt,
      updated_at: nowIso,
    });
  }
  return { kind: 'claimed', idempotencyKey: row.idempotency_key, requestHash };
}

/**
 * Record a terminal outcome and immediately hand the caller a fresh claim.
 * Used when a stored `succeeded` payload is unreadable: the old result is
 * unrecoverable, so the only honest move is to let a new attempt run rather
 * than pin the user behind a permanent 409.
 */
function markTerminalAndReclaim(
  row: IdempotencyRow,
  requestHash: string,
  errorCode: string,
): TrainingPlanGenerationIdempotencyClaim {
  const db = getOptionalDb();
  if (db) {
    db.prepare(`
      UPDATE ${IDEMPOTENCY_TABLE}
         SET failure_class = 'terminal', last_error_code = ?
       WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
    `).run(errorCode, row.user_id, row.tenant_id, row.idempotency_key);
  }
  return reclaimRow({ ...row, last_error_code: errorCode }, requestHash);
}

const MEMORY_ROWS = new Map<string, IdempotencyRow>();
const AUTO_IDEMPOTENCY_WINDOW_MS = 90_000;
const IDEMPOTENCY_TABLE = 'training_plan_generation_idempotency_scoped';
const LEGACY_IDEMPOTENCY_TABLE = 'training_plan_generation_idempotency';

export function normalizeTrainingPlanGenerationIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 160);
}

export function fingerprintTrainingPlanGenerationRequest(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableStringify(payload))
    .digest('hex');
}

export function claimTrainingPlanGenerationIdempotency(
  userId: number,
  tenantId: number,
  idempotencyKey: string | null,
  requestHash: string,
): TrainingPlanGenerationIdempotencyClaim {
  if (!idempotencyKey) return { kind: 'not_requested' };
  const scopedTenantId = requireTenantIdParam(tenantId, 'claimTrainingPlanGenerationIdempotency');

  const db = getOptionalDb();
  if (!db) {
    return claimMemory(userId, scopedTenantId, idempotencyKey, requestHash);
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  const existing = getRow(db, userId, scopedTenantId, idempotencyKey);
  if (existing) {
    if (!shouldReplaceExistingAutoRow(existing)) {
      return claimFromExisting(existing, requestHash);
    }
    return replaceExistingAutoRow(db, existing, requestHash);
  }

  const nowIso = new Date().toISOString();
  // F1 (Phase 1A-4): every new claim carries a lease from the moment it is
  // written, so a claim orphaned by a process death becomes reclaimable
  // instead of pinning the deterministic key behind a permanent 409.
  db.prepare(`
    INSERT INTO ${IDEMPOTENCY_TABLE} (
      user_id, tenant_id, idempotency_key, request_hash, status, created_at, updated_at,
      lease_expires_at, heartbeat_at, attempt_count
    ) VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, 1)
  `).run(
    userId, scopedTenantId, idempotencyKey, requestHash, nowIso, nowIso,
    leaseExpiryIso(), nowIso,
  );

  return { kind: 'claimed', idempotencyKey, requestHash };
}

export function completeTrainingPlanGenerationIdempotency(
  userId: number,
  tenantId: number,
  idempotencyKey: string | null,
  requestHash: string,
  responseData: Record<string, unknown>,
  statusCode: number,
): void {
  if (!idempotencyKey) return;
  const scopedTenantId = requireTenantIdParam(tenantId, 'completeTrainingPlanGenerationIdempotency');
  const responseJson = JSON.stringify(responseData);

  const db = getOptionalDb();
  if (!db) {
    const key = memoryKey(userId, scopedTenantId, idempotencyKey);
    const existing = MEMORY_ROWS.get(key);
    MEMORY_ROWS.set(key, {
      user_id: userId,
      tenant_id: scopedTenantId,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      status: 'succeeded',
      response_json: responseJson,
      status_code: statusCode,
      created_at: existing?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return;
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE ${IDEMPOTENCY_TABLE}
       SET status = 'succeeded',
           response_json = ?,
           status_code = ?,
           updated_at = ?
     WHERE user_id = ?
       AND tenant_id = ?
       AND idempotency_key = ?
       AND request_hash = ?
  `).run(responseJson, statusCode, nowIso, userId, scopedTenantId, idempotencyKey, requestHash);
}

export function failTrainingPlanGenerationIdempotency(
  userId: number,
  tenantId: number,
  idempotencyKey: string | null,
  requestHash: string,
): void {
  if (!idempotencyKey) return;
  const scopedTenantId = requireTenantIdParam(tenantId, 'failTrainingPlanGenerationIdempotency');
  const db = getOptionalDb();
  if (!db) {
    const key = memoryKey(userId, scopedTenantId, idempotencyKey);
    const row = MEMORY_ROWS.get(key);
    if (row?.request_hash === requestHash) {
      MEMORY_ROWS.set(key, { ...row, status: 'failed', updated_at: new Date().toISOString() });
    }
    return;
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE ${IDEMPOTENCY_TABLE}
       SET status = 'failed',
           updated_at = ?
     WHERE user_id = ?
       AND tenant_id = ?
       AND idempotency_key = ?
       AND request_hash = ?
       AND status = 'in_progress'
  `).run(nowIso, userId, scopedTenantId, idempotencyKey, requestHash);
}

export function clearTrainingPlanGenerationIdempotency(
  userId: number,
  tenantId: number,
  idempotencyKey: string | null,
  requestHash?: string,
): number {
  if (!idempotencyKey) return 0;
  const scopedTenantId = requireTenantIdParam(tenantId, 'clearTrainingPlanGenerationIdempotency');

  const db = getOptionalDb();
  if (!db) {
    const key = memoryKey(userId, scopedTenantId, idempotencyKey);
    const row = MEMORY_ROWS.get(key);
    if (!row) return 0;
    if (requestHash && row.request_hash !== requestHash) return 0;
    MEMORY_ROWS.delete(key);
    return 1;
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  if (requestHash) {
    return db.prepare(`
      DELETE FROM ${IDEMPOTENCY_TABLE}
       WHERE user_id = ?
         AND tenant_id = ?
         AND idempotency_key = ?
         AND request_hash = ?
    `).run(userId, scopedTenantId, idempotencyKey, requestHash).changes;
  }

  return db.prepare(`
    DELETE FROM ${IDEMPOTENCY_TABLE}
     WHERE user_id = ?
       AND tenant_id = ?
       AND idempotency_key = ?
  `).run(userId, scopedTenantId, idempotencyKey).changes;
}

export function _resetTrainingPlanGenerationIdempotencyForTests(): void {
  MEMORY_ROWS.clear();
}

function claimFromExisting(row: IdempotencyRow, requestHash: string): TrainingPlanGenerationIdempotencyClaim {
  if (row.request_hash !== requestHash) {
    return { kind: 'conflict', idempotencyKey: row.idempotency_key };
  }

  if (row.status === 'succeeded' && row.response_json) {
    try {
      return {
        kind: 'replay',
        idempotencyKey: row.idempotency_key,
        responseData: JSON.parse(row.response_json),
        statusCode: row.status_code || 200,
      };
    } catch (err) {
      logger.warn(
        { err, userId: row.user_id, tenantId: row.tenant_id, idempotencyKey: row.idempotency_key },
        'Training plan idempotency replay payload is unreadable; marking terminal so a fresh attempt can proceed',
      );
      // F1 (Phase 1A-4): this used to fall through to `in_progress`, which is
      // permanent — a `succeeded` row whose payload cannot be parsed can never
      // reach the `failed` branch below, so every retry of the identical
      // request 409'd forever. It is terminal, not in-flight: mark it so and
      // let the caller start a new attempt.
      return markTerminalAndReclaim(row, requestHash, 'IDEMPOTENCY_RESPONSE_UNREADABLE');
    }
  }

  // F1 (Phase 1A-4): an `in_progress` claim whose lease has expired is not
  // in flight — the process that owned it died before it could record an
  // outcome. Without this, the deterministic key (iOS SHA-256, or the server
  // `auto:<requestHash>` fallback) makes the 409 permanent for that exact
  // request payload.
  //
  // Rows written before the lease existed inherit a derived expiry from
  // migration 273 rather than being reclaimable immediately, so a generation
  // still running on an older process cannot be reclaimed out from under
  // itself.
  if (row.status === 'in_progress' && isLeaseExpired(row)) {
    logger.warn(
      {
        userId: row.user_id,
        tenantId: row.tenant_id,
        idempotencyKey: row.idempotency_key,
        leaseExpiresAt: row.lease_expires_at,
        attemptCount: row.attempt_count,
      },
      'Reclaiming Training plan generation claim whose lease expired without an outcome',
    );
    return reclaimRow(row, requestHash);
  }

  if (row.status === 'failed') {
    const db = getOptionalDb();
    const nowIso = new Date().toISOString();
    if (db) {
      db.prepare(`
        UPDATE ${IDEMPOTENCY_TABLE}
           SET status = 'in_progress',
               response_json = NULL,
               status_code = NULL,
               updated_at = ?
         WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
      `).run(nowIso, row.user_id, row.tenant_id, row.idempotency_key);
    } else {
      MEMORY_ROWS.set(memoryKey(row.user_id, row.tenant_id, row.idempotency_key), {
        ...row,
        status: 'in_progress',
        response_json: null,
        status_code: null,
        updated_at: nowIso,
      });
    }
    return { kind: 'claimed', idempotencyKey: row.idempotency_key, requestHash };
  }

  return { kind: 'in_progress', idempotencyKey: row.idempotency_key };
}

function claimMemory(userId: number, tenantId: number, idempotencyKey: string, requestHash: string): TrainingPlanGenerationIdempotencyClaim {
  const key = memoryKey(userId, tenantId, idempotencyKey);
  const existing = MEMORY_ROWS.get(key);
  if (existing) {
    if (!shouldReplaceExistingAutoRow(existing)) {
      return claimFromExisting(existing, requestHash);
    }
    const nowIso = new Date().toISOString();
    MEMORY_ROWS.set(key, {
      user_id: userId,
      tenant_id: tenantId,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      status: 'in_progress',
      response_json: null,
      status_code: null,
      created_at: nowIso,
      updated_at: nowIso,
    });
    return { kind: 'claimed', idempotencyKey, requestHash };
  }

  const nowIso = new Date().toISOString();
  MEMORY_ROWS.set(key, {
    user_id: userId,
    tenant_id: tenantId,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    status: 'in_progress',
    response_json: null,
    status_code: null,
    created_at: nowIso,
    updated_at: nowIso,
  });
  return { kind: 'claimed', idempotencyKey, requestHash };
}

function shouldReplaceExistingAutoRow(row: IdempotencyRow): boolean {
  if (!isAutomaticIdempotencyKey(row.idempotency_key)) return false;
  if (row.status === 'in_progress') return false;
  if (isAutoRowFresh(row)) return false;
  // Auto keys are intentionally short-lived. After the window expires,
  // the same draft may be submitted again as a fresh user action, and a
  // rare hash-prefix collision should not keep returning conflict forever.
  return true;
}

function replaceExistingAutoRow(
  db: Database.Database,
  row: IdempotencyRow,
  requestHash: string,
): TrainingPlanGenerationIdempotencyClaim {
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE ${IDEMPOTENCY_TABLE}
       SET request_hash = ?,
           status = 'in_progress',
           response_json = NULL,
           status_code = NULL,
           created_at = ?,
           updated_at = ?
     WHERE user_id = ?
       AND tenant_id = ?
       AND idempotency_key = ?
  `).run(requestHash, nowIso, nowIso, row.user_id, row.tenant_id, row.idempotency_key);
  return { kind: 'claimed', idempotencyKey: row.idempotency_key, requestHash };
}

function isAutomaticIdempotencyKey(idempotencyKey: string): boolean {
  return idempotencyKey.startsWith('auto:');
}

function isAutoRowFresh(row: IdempotencyRow): boolean {
  const source = row.status === 'succeeded' || row.status === 'failed'
    ? row.updated_at || row.created_at
    : row.created_at || row.updated_at;
  if (!source) return false;
  const parsed = Date.parse(source.includes('T') ? source : `${source.replace(' ', 'T')}Z`);
  if (!Number.isFinite(parsed)) return false;
  return Date.now() - parsed <= AUTO_IDEMPOTENCY_WINDOW_MS;
}

function ensureTrainingPlanGenerationIdempotencyTable(db: Database.Database): void {
  const existing = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
  `).get(IDEMPOTENCY_TABLE);
  if (!existing) {
    createTrainingPlanGenerationIdempotencyTable(db);
    backfillTrainingPlanGenerationIdempotencyScopedTable(db);
  }
  ensureTrainingPlanGenerationIdempotencyIndexes(db);
}

function createTrainingPlanGenerationIdempotencyTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${IDEMPOTENCY_TABLE} (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress', 'succeeded', 'failed')),
      response_json TEXT,
      status_code INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      -- F1 (Phase 1A-4) lease columns. These MUST stay in lockstep with
      -- migration 273: this DDL bootstraps fresh databases that never run the
      -- ALTER TABLE path, so a divergence here means the lease silently does
      -- not exist on new installs while working everywhere else.
      -- status deliberately keeps its lowercase 207 vocabulary; the terminal
      -- distinction lives in failure_class.
      failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN ('retryable', 'terminal')),
      last_error_code TEXT,
      lease_owner TEXT,
      fencing_token TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, tenant_id, idempotency_key)
    );
  `);
  ensureTrainingPlanGenerationIdempotencyIndexes(db);
}

function backfillTrainingPlanGenerationIdempotencyScopedTable(db: Database.Database): void {
  const legacyTable = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
  `).get(LEGACY_IDEMPOTENCY_TABLE);
  if (!legacyTable) return;
  const legacyColumns = db.prepare(`PRAGMA table_info(${LEGACY_IDEMPOTENCY_TABLE})`).all() as Array<{ name: string }>;
  const tenantExpression = legacyColumns.some((column) => column.name === 'tenant_id')
    ? 'COALESCE(tenant_id, user_id)'
    : 'user_id';

  db.exec(`
    INSERT OR IGNORE INTO ${IDEMPOTENCY_TABLE} (
      user_id,
      tenant_id,
      idempotency_key,
      request_hash,
      status,
      response_json,
      status_code,
      created_at,
      updated_at
    )
    SELECT
      user_id,
      ${tenantExpression},
      idempotency_key,
      request_hash,
      status,
      response_json,
      status_code,
      created_at,
      updated_at
    FROM ${LEGACY_IDEMPOTENCY_TABLE};
  `);
}

function ensureTrainingPlanGenerationIdempotencyIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_training_plan_generation_idempotency_scoped_tenant_status
      ON ${IDEMPOTENCY_TABLE}(tenant_id, user_id, status);
  `);
}

function getRow(db: Database.Database, userId: number, tenantId: number, idempotencyKey: string): IdempotencyRow | null {
  return db.prepare(`
    SELECT user_id, tenant_id, idempotency_key, request_hash, status, response_json, status_code, created_at, updated_at,
           failure_class, last_error_code, lease_owner, fencing_token, lease_expires_at, heartbeat_at, attempt_count
      FROM ${IDEMPOTENCY_TABLE}
     WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
  `).get(userId, tenantId, idempotencyKey) as IdempotencyRow | undefined ?? null;
}

function getOptionalDb(): Database.Database | null {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function memoryKey(userId: number, tenantId: number, idempotencyKey: string): string {
  return `${userId}:${tenantId}:${idempotencyKey}`;
}

function stableStringify(value: unknown): string {
  if (typeof value === 'undefined') return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
