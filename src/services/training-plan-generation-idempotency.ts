// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { requireTenantIdParam } from './tenant-scope';
import * as trainingPlans from './training-plans';

type TrainingPlanGenerationIdempotencyStatus = 'in_progress' | 'succeeded' | 'failed';

export type TrainingPlanGenerationIdempotencyClaim =
  | { kind: 'not_requested' }
  | TrainingPlanGenerationLeaseIdentity
  | { kind: 'replay'; idempotencyKey: string; responseData: Record<string, unknown>; statusCode: number }
  | { kind: 'in_progress'; idempotencyKey: string }
  | { kind: 'reconciliation_required'; idempotencyKey: string }
  | { kind: 'conflict'; idempotencyKey: string };

export interface TrainingPlanGenerationLeaseIdentity {
  kind: 'claimed';
  idempotencyKey: string;
  requestHash: string;
  leaseOwner: string;
  fencingToken: string;
}

export const TRAINING_PLAN_GENERATION_ATTEMPT_STATUS_SCHEMA_VERSION =
  'training_plan_generation_attempt_status.v1' as const;

type TrainingPlanGenerationAttemptStatusBase = {
  schemaVersion: typeof TRAINING_PLAN_GENERATION_ATTEMPT_STATUS_SCHEMA_VERSION;
  canStartNew: boolean;
};

/**
 * Scope-safe, presentation-ready recovery contract for a compatibility-plan
 * create whose HTTP outcome was not observed by the client.
 *
 * Deliberately absent: request hashes, lease owners, fencing tokens, failure
 * codes, and timestamps. The only Start New authority is the narrow
 * `known_no_creation` branch.
 */
export type TrainingPlanGenerationAttemptStatus =
  | (TrainingPlanGenerationAttemptStatusBase & {
      state: 'created';
      recovery: 'use_created_plan';
      canStartNew: false;
      planId: number;
    })
  | (TrainingPlanGenerationAttemptStatusBase & {
      state: 'created_inactive';
      recovery: 'refresh_active_plan';
      canStartNew: false;
      planId: number;
    })
  | (TrainingPlanGenerationAttemptStatusBase & {
      state: 'in_progress';
      recovery: 'retry_same_attempt';
      canStartNew: false;
    })
  | (TrainingPlanGenerationAttemptStatusBase & {
      state: 'expired';
      recovery: 'retry_same_attempt' | 'repreview_same_attempt';
      canStartNew: false;
    })
  | (TrainingPlanGenerationAttemptStatusBase & {
      state: 'unknown' | 'not_found';
      recovery: 'check_status_again';
      canStartNew: false;
    })
  | (TrainingPlanGenerationAttemptStatusBase & {
      state: 'known_no_creation';
      recovery: 'start_new_allowed';
      canStartNew: true;
    });

export class TrainingPlanGenerationLeaseLostError extends Error {
  readonly code = 'TRAINING_PLAN_GENERATION_LEASE_LOST';

  constructor() {
    super('Training plan generation idempotency lease is no longer owned by this attempt');
    this.name = 'TrainingPlanGenerationLeaseLostError';
  }
}

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
const LEASE_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

function leaseExpiryIso(fromMs: number = Date.now()): string {
  return new Date(fromMs + LEASE_TTL_MS).toISOString();
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function newLeaseIdentity(idempotencyKey: string, requestHash: string): TrainingPlanGenerationLeaseIdentity {
  return {
    kind: 'claimed',
    idempotencyKey,
    requestHash,
    leaseOwner: `training-plan-generation:${process.pid}:${randomUUID()}`,
    fencingToken: randomUUID(),
  };
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

function isCurrentAtomicProtocolRow(row: IdempotencyRow): boolean {
  return typeof row.lease_owner === 'string'
    && row.lease_owner.length > 0
    && typeof row.fencing_token === 'string'
    && row.fencing_token.length > 0;
}

function reclaimRow(
  row: IdempotencyRow,
  requestHash: string,
  mode: 'expired' | 'failed',
  recoveryErrorCode: string | null = null,
): TrainingPlanGenerationIdempotencyClaim {
  const db = getOptionalDb();
  const nowIso = new Date().toISOString();
  const nextAttempt = (row.attempt_count ?? 1) + 1;
  const identity = newLeaseIdentity(row.idempotency_key, requestHash);
  if (db) {
    const statusPredicate = mode === 'expired'
      ? `status = 'in_progress'
         AND lease_expires_at IS NOT NULL
         AND datetime(lease_expires_at) <= datetime(?)
         AND fencing_token IS ?`
      : `status = 'failed'
         AND (failure_class IS NULL OR failure_class = 'retryable')
         AND fencing_token IS ?`;
    const predicateArgs = mode === 'expired'
      ? [nowIso, row.fencing_token ?? null]
      : [row.fencing_token ?? null];
    const result = db.prepare(`
      UPDATE ${IDEMPOTENCY_TABLE}
         SET status = 'in_progress',
             response_json = NULL,
             status_code = NULL,
             failure_class = NULL,
             last_error_code = ?,
             lease_owner = ?,
             fencing_token = ?,
             lease_expires_at = ?,
             heartbeat_at = ?,
             attempt_count = ?,
             updated_at = ?
       WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
         AND request_hash = ?
         AND ${statusPredicate}
    `).run(
      recoveryErrorCode,
      identity.leaseOwner, identity.fencingToken, leaseExpiryIso(), nowIso, nextAttempt, nowIso,
      row.user_id, row.tenant_id, row.idempotency_key, requestHash,
      ...predicateArgs,
    );
    if (result.changes !== 1) {
      const current = getRow(db, row.user_id, row.tenant_id, row.idempotency_key);
      return current
        ? classifyExistingWithoutMutation(current, requestHash)
        : { kind: 'in_progress', idempotencyKey: row.idempotency_key };
    }
  } else {
    const key = memoryKey(row.user_id, row.tenant_id, row.idempotency_key);
    const current = MEMORY_ROWS.get(key);
    const stillOwned = current?.request_hash === requestHash
      && current.status === row.status
      && current.fencing_token === row.fencing_token;
    if (!stillOwned) {
      return current
        ? classifyExistingWithoutMutation(current, requestHash)
        : { kind: 'in_progress', idempotencyKey: row.idempotency_key };
    }
    MEMORY_ROWS.set(memoryKey(row.user_id, row.tenant_id, row.idempotency_key), {
      ...row,
      status: 'in_progress',
      response_json: null,
      status_code: null,
      failure_class: null,
      last_error_code: recoveryErrorCode,
      lease_owner: identity.leaseOwner,
      fencing_token: identity.fencingToken,
      lease_expires_at: leaseExpiryIso(),
      heartbeat_at: nowIso,
      attempt_count: nextAttempt,
      updated_at: nowIso,
    });
  }
  return identity;
}

function rebindExpiredFencedRow(
  row: IdempotencyRow,
  requestHash: string,
): TrainingPlanGenerationIdempotencyClaim {
  const db = getOptionalDb();
  const nowIso = new Date().toISOString();
  const nextAttempt = (row.attempt_count ?? 1) + 1;
  const identity = newLeaseIdentity(row.idempotency_key, requestHash);

  if (db) {
    const result = db.prepare(`
      UPDATE ${IDEMPOTENCY_TABLE}
         SET request_hash = ?,
             status = 'in_progress',
             response_json = NULL,
             status_code = NULL,
             failure_class = NULL,
             last_error_code = NULL,
             lease_owner = ?,
             fencing_token = ?,
             lease_expires_at = ?,
             heartbeat_at = ?,
             attempt_count = ?,
             updated_at = ?
       WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
         AND request_hash = ?
         AND status = 'in_progress'
         AND lease_expires_at IS NOT NULL
         AND datetime(lease_expires_at) <= datetime(?)
         AND lease_owner IS ?
         AND fencing_token IS ?
    `).run(
      requestHash,
      identity.leaseOwner,
      identity.fencingToken,
      leaseExpiryIso(),
      nowIso,
      nextAttempt,
      nowIso,
      row.user_id,
      row.tenant_id,
      row.idempotency_key,
      row.request_hash,
      nowIso,
      row.lease_owner ?? null,
      row.fencing_token ?? null,
    );
    if (result.changes !== 1) {
      const current = getRow(db, row.user_id, row.tenant_id, row.idempotency_key);
      return current
        ? classifyExistingWithoutMutation(current, requestHash)
        : { kind: 'in_progress', idempotencyKey: row.idempotency_key };
    }
  } else {
    const key = memoryKey(row.user_id, row.tenant_id, row.idempotency_key);
    const current = MEMORY_ROWS.get(key);
    const stillOwned = current?.request_hash === row.request_hash
      && current.status === 'in_progress'
      && current.lease_owner === row.lease_owner
      && current.fencing_token === row.fencing_token
      && isLeaseExpired(current);
    if (!stillOwned) {
      return current
        ? classifyExistingWithoutMutation(current, requestHash)
        : { kind: 'in_progress', idempotencyKey: row.idempotency_key };
    }
    MEMORY_ROWS.set(key, {
      ...current,
      request_hash: requestHash,
      status: 'in_progress',
      response_json: null,
      status_code: null,
      failure_class: null,
      last_error_code: null,
      lease_owner: identity.leaseOwner,
      fencing_token: identity.fencingToken,
      lease_expires_at: leaseExpiryIso(),
      heartbeat_at: nowIso,
      attempt_count: nextAttempt,
      updated_at: nowIso,
    });
  }

  return identity;
}

const MEMORY_ROWS = new Map<string, IdempotencyRow>();
const AUTO_IDEMPOTENCY_WINDOW_MS = 90_000;
const IDEMPOTENCY_TABLE = 'training_plan_generation_idempotency_scoped';
const LEGACY_IDEMPOTENCY_TABLE = 'training_plan_generation_idempotency';
const MAX_IDEMPOTENCY_KEY_LENGTH = 160;

// These codes are written only on branches that return before the atomic
// compatibility-plan persistence transaction begins. Adding a code here is a
// security/recovery decision: it grants the client permission to abandon the
// old key and start a different attempt.
const KNOWN_PRE_PERSIST_NO_CREATION_CODES = new Set<string>([
  'TRAINING_PLAN_NEEDS_PROFILE',
  'TRAINING_PLAN_NEEDS_CLARIFICATION',
  'TRAINING_PLAN_QUALITY_BLOCKED',
  'TRAINING_PLAN_REPLACEMENT_FAILED',
  'TRAINING_PLAN_PREVIEW_STALE',
  'INVALID_PLAN_GENERATION_STATE',
]);

export function normalizeTrainingPlanGenerationIdempotencyKey(value: unknown): string | null {
  return normalizeTrainingPlanGenerationAttemptLookupKey(value);
}

/** Strict lookup variant: never truncate a client key into another attempt. */
export function normalizeTrainingPlanGenerationAttemptLookupKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) return null;
  return trimmed;
}

export function getTrainingPlanGenerationAttemptStatus(
  userId: number,
  tenantId: number,
  idempotencyKey: string,
): TrainingPlanGenerationAttemptStatus {
  const scopedTenantId = requireTenantIdParam(tenantId, 'getTrainingPlanGenerationAttemptStatus');
  const normalizedKey = normalizeTrainingPlanGenerationAttemptLookupKey(idempotencyKey);
  if (!normalizedKey) return blockedAttemptStatus('not_found');

  // This endpoint is intentionally read-only. In particular, do not call
  // ensureTrainingPlanGenerationIdempotencyTable(): that helper can create or
  // backfill schema. A durable-store read failure must propagate to the route
  // and become a safe 503; an in-memory fallback would falsely report absence.
  const row = getRow(getDb(), userId, scopedTenantId, normalizedKey);

  if (!row) return blockedAttemptStatus('not_found');

  if (row.status === 'in_progress') {
    const expiresAtMs = parseIsoMs(row.lease_expires_at);
    if (expiresAtMs === null) return blockedAttemptStatus('unknown');
    if (expiresAtMs > Date.now()) return blockedAttemptStatus('in_progress');
    return {
      schemaVersion: TRAINING_PLAN_GENERATION_ATTEMPT_STATUS_SCHEMA_VERSION,
      state: 'expired',
      recovery: isCurrentAtomicProtocolRow(row) ? 'repreview_same_attempt' : 'retry_same_attempt',
      canStartNew: false,
    };
  }

  if (row.status === 'failed') {
    return isCurrentAtomicProtocolRow(row)
      || (row.last_error_code != null && KNOWN_PRE_PERSIST_NO_CREATION_CODES.has(row.last_error_code))
      ? {
          schemaVersion: TRAINING_PLAN_GENERATION_ATTEMPT_STATUS_SCHEMA_VERSION,
          state: 'known_no_creation',
          recovery: 'start_new_allowed',
          canStartNew: true,
        }
      : blockedAttemptStatus('unknown');
  }

  if (row.status !== 'succeeded' || !row.response_json) {
    return blockedAttemptStatus('unknown');
  }

  const proof = proveScopedPlanReplay({
    userId,
    tenantId: scopedTenantId,
    responseJson: row.response_json,
  });
  return proof == null
    ? blockedAttemptStatus('unknown')
    : proof.kind === 'active'
      ? {
        schemaVersion: TRAINING_PLAN_GENERATION_ATTEMPT_STATUS_SCHEMA_VERSION,
        state: 'created',
        recovery: 'use_created_plan',
        canStartNew: false,
        planId: proof.planId,
      }
      : {
        schemaVersion: TRAINING_PLAN_GENERATION_ATTEMPT_STATUS_SCHEMA_VERSION,
        state: 'created_inactive',
        recovery: 'refresh_active_plan',
        canStartNew: false,
        planId: proof.planId,
      };
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
  options: { allowExpiredFencedRequestHashRebind?: boolean } = {},
): TrainingPlanGenerationIdempotencyClaim {
  if (!idempotencyKey) return { kind: 'not_requested' };
  const scopedTenantId = requireTenantIdParam(tenantId, 'claimTrainingPlanGenerationIdempotency');

  const db = getOptionalDb();
  if (!db) {
    return claimMemory(userId, scopedTenantId, idempotencyKey, requestHash, options);
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  const existing = getRow(db, userId, scopedTenantId, idempotencyKey);
  if (existing) {
    if (!shouldReplaceExistingAutoRow(existing)) {
      return claimFromExisting(existing, requestHash, options);
    }
    return replaceExistingAutoRow(db, existing, requestHash);
  }

  const nowIso = new Date().toISOString();
  const identity = newLeaseIdentity(idempotencyKey, requestHash);
  // F1 (Phase 1A-4): every new claim carries a lease from the moment it is
  // written, so a claim orphaned by a process death becomes reclaimable
  // instead of pinning the deterministic key behind a permanent 409.
  try {
    db.prepare(`
      INSERT INTO ${IDEMPOTENCY_TABLE} (
        user_id, tenant_id, idempotency_key, request_hash, status, created_at, updated_at,
        lease_owner, fencing_token, lease_expires_at, heartbeat_at, attempt_count
      ) VALUES (?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, 1)
    `).run(
      userId, scopedTenantId, idempotencyKey, requestHash, nowIso, nowIso,
      identity.leaseOwner, identity.fencingToken, leaseExpiryIso(), nowIso,
    );
    return identity;
  } catch (err) {
    // Two processes can both observe "no row" before either INSERT. The PK
    // is the arbiter: the loser re-reads and classifies the winner instead of
    // leaking SQLITE_CONSTRAINT or pretending it owns the attempt.
    const raced = getRow(db, userId, scopedTenantId, idempotencyKey);
    if (raced) return claimFromExisting(raced, requestHash, options);
    throw err;
  }
}

export function completeTrainingPlanGenerationIdempotency(
  userId: number,
  tenantId: number,
  claim: TrainingPlanGenerationLeaseIdentity,
  responseData: Record<string, unknown>,
  statusCode: number,
  database?: Database.Database,
): boolean {
  const scopedTenantId = requireTenantIdParam(tenantId, 'completeTrainingPlanGenerationIdempotency');
  const responseJson = JSON.stringify(responseData);
  const nowIso = new Date().toISOString();

  const db = database ?? getOptionalDb();
  if (!db) {
    const key = memoryKey(userId, scopedTenantId, claim.idempotencyKey);
    const existing = MEMORY_ROWS.get(key);
    if (
      existing?.status === 'succeeded'
      && existing.request_hash === claim.requestHash
      && existing.lease_owner === claim.leaseOwner
      && existing.fencing_token === claim.fencingToken
      && existing.response_json === responseJson
      && existing.status_code === statusCode
    ) return true;
    if (!isOwnedLiveRow(existing, claim, Date.now())) return false;
    MEMORY_ROWS.set(key, {
      ...existing,
      status: 'succeeded',
      response_json: responseJson,
      status_code: statusCode,
      failure_class: null,
      lease_expires_at: null,
      heartbeat_at: nowIso,
      updated_at: nowIso,
    });
    return true;
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  const result = db.prepare(`
    UPDATE ${IDEMPOTENCY_TABLE}
       SET status = 'succeeded',
           response_json = ?,
           status_code = ?,
           failure_class = NULL,
           lease_expires_at = NULL,
           heartbeat_at = ?,
           updated_at = ?
     WHERE user_id = ?
       AND tenant_id = ?
       AND idempotency_key = ?
       AND request_hash = ?
       AND status = 'in_progress'
       AND lease_owner = ?
       AND fencing_token = ?
       AND datetime(lease_expires_at) > datetime(?)
  `).run(
    responseJson, statusCode, nowIso, nowIso,
    userId, scopedTenantId, claim.idempotencyKey, claim.requestHash,
    claim.leaseOwner, claim.fencingToken, nowIso,
  );
  if (result.changes === 1) return true;
  const replay = db.prepare(`
    SELECT 1 AS completed
      FROM ${IDEMPOTENCY_TABLE}
     WHERE user_id = ? AND tenant_id = ?
       AND idempotency_key = ? AND request_hash = ?
       AND status = 'succeeded'
       AND lease_owner = ? AND fencing_token = ?
       AND response_json = ? AND status_code = ?
  `).get(
    userId, scopedTenantId, claim.idempotencyKey, claim.requestHash,
    claim.leaseOwner, claim.fencingToken, responseJson, statusCode,
  );
  return Boolean(replay);
}

export function failTrainingPlanGenerationIdempotency(
  userId: number,
  tenantId: number,
  claim: TrainingPlanGenerationLeaseIdentity,
  errorCode: string = 'TRAINING_PLAN_GENERATION_FAILED',
  failureClass: 'retryable' | 'terminal' = 'retryable',
): boolean {
  const scopedTenantId = requireTenantIdParam(tenantId, 'failTrainingPlanGenerationIdempotency');
  const nowIso = new Date().toISOString();
  const db = getOptionalDb();
  if (!db) {
    const key = memoryKey(userId, scopedTenantId, claim.idempotencyKey);
    const row = MEMORY_ROWS.get(key);
    if (!isOwnedLiveRow(row, claim, Date.now())) return false;
    MEMORY_ROWS.set(key, {
      ...row,
      status: 'failed',
      failure_class: failureClass,
      last_error_code: errorCode,
      lease_expires_at: null,
      heartbeat_at: nowIso,
      updated_at: nowIso,
    });
    return true;
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  const result = db.prepare(`
    UPDATE ${IDEMPOTENCY_TABLE}
       SET status = 'failed',
           failure_class = ?,
           last_error_code = ?,
           lease_expires_at = NULL,
           heartbeat_at = ?,
           updated_at = ?
     WHERE user_id = ?
       AND tenant_id = ?
       AND idempotency_key = ?
       AND request_hash = ?
       AND status = 'in_progress'
       AND lease_owner = ?
       AND fencing_token = ?
       AND datetime(lease_expires_at) > datetime(?)
  `).run(
    failureClass, errorCode, nowIso, nowIso,
    userId, scopedTenantId, claim.idempotencyKey, claim.requestHash,
    claim.leaseOwner, claim.fencingToken, nowIso,
  );
  return result.changes === 1;
}

export function renewTrainingPlanGenerationIdempotencyLease(
  userId: number,
  tenantId: number,
  claim: TrainingPlanGenerationLeaseIdentity,
): boolean {
  const scopedTenantId = requireTenantIdParam(tenantId, 'renewTrainingPlanGenerationIdempotencyLease');
  const nowIso = new Date().toISOString();
  const expiresAt = leaseExpiryIso();
  const db = getOptionalDb();
  if (!db) {
    const key = memoryKey(userId, scopedTenantId, claim.idempotencyKey);
    const row = MEMORY_ROWS.get(key);
    if (!isOwnedLiveRow(row, claim, Date.now())) return false;
    MEMORY_ROWS.set(key, {
      ...row,
      heartbeat_at: nowIso,
      lease_expires_at: expiresAt,
      updated_at: nowIso,
    });
    return true;
  }

  ensureTrainingPlanGenerationIdempotencyTable(db);
  const result = db.prepare(`
    UPDATE ${IDEMPOTENCY_TABLE}
       SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
     WHERE user_id = ? AND tenant_id = ?
       AND idempotency_key = ? AND request_hash = ?
       AND status = 'in_progress'
       AND lease_owner = ? AND fencing_token = ?
       AND datetime(lease_expires_at) > datetime(?)
  `).run(
    nowIso, expiresAt, nowIso,
    userId, scopedTenantId, claim.idempotencyKey, claim.requestHash,
    claim.leaseOwner, claim.fencingToken, nowIso,
  );
  return result.changes === 1;
}

export function assertTrainingPlanGenerationIdempotencyLease(
  userId: number,
  tenantId: number,
  claim: TrainingPlanGenerationLeaseIdentity,
  database?: Database.Database,
): void {
  const scopedTenantId = requireTenantIdParam(tenantId, 'assertTrainingPlanGenerationIdempotencyLease');
  const nowIso = new Date().toISOString();
  const db = database ?? getOptionalDb();
  if (!db) {
    const row = MEMORY_ROWS.get(memoryKey(userId, scopedTenantId, claim.idempotencyKey));
    if (!isOwnedLiveRow(row, claim, Date.now())) throw new TrainingPlanGenerationLeaseLostError();
    return;
  }
  ensureTrainingPlanGenerationIdempotencyTable(db);
  const owned = db.prepare(`
    SELECT 1 AS owned
      FROM ${IDEMPOTENCY_TABLE}
     WHERE user_id = ? AND tenant_id = ?
       AND idempotency_key = ? AND request_hash = ?
       AND status = 'in_progress'
       AND lease_owner = ? AND fencing_token = ?
       AND datetime(lease_expires_at) > datetime(?)
  `).get(
    userId, scopedTenantId, claim.idempotencyKey, claim.requestHash,
    claim.leaseOwner, claim.fencingToken, nowIso,
  );
  if (!owned) throw new TrainingPlanGenerationLeaseLostError();
}

export function startTrainingPlanGenerationIdempotencyHeartbeat(
  userId: number,
  tenantId: number,
  claim: TrainingPlanGenerationLeaseIdentity,
): { stop(): void; ownershipLost(): boolean } {
  let stopped = false;
  let lost = false;
  const timer = setInterval(() => {
    if (stopped || lost) return;
    try {
      lost = !renewTrainingPlanGenerationIdempotencyLease(userId, tenantId, claim);
    } catch (err) {
      lost = true;
      logger.warn(
        { err, userId, tenantId, idempotencyKey: claim.idempotencyKey },
        'Training plan generation lease heartbeat failed; attempt surrendered',
      );
    }
    if (lost) clearInterval(timer);
  }, LEASE_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    ownershipLost() {
      return lost;
    },
  };
}

export function _resetTrainingPlanGenerationIdempotencyForTests(): void {
  MEMORY_ROWS.clear();
}

function claimFromExisting(
  row: IdempotencyRow,
  requestHash: string,
  options: { allowExpiredFencedRequestHashRebind?: boolean } = {},
): TrainingPlanGenerationIdempotencyClaim {
  if (row.request_hash !== requestHash) {
    if (
      options.allowExpiredFencedRequestHashRebind === true
      && row.status === 'in_progress'
      && isCurrentAtomicProtocolRow(row)
      && isLeaseExpired(row)
    ) {
      return rebindExpiredFencedRow(row, requestHash);
    }
    return { kind: 'conflict', idempotencyKey: row.idempotency_key };
  }

  if (row.status === 'succeeded') {
    if (!row.response_json) {
      return { kind: 'reconciliation_required', idempotencyKey: row.idempotency_key };
    }
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
        'Training plan idempotency replay payload is unreadable; preserving the succeeded receipt for reconciliation',
      );
      // A corrupt replay payload is an integrity incident, not evidence that
      // persistence never happened. Never reclaim or mutate a succeeded row.
      return { kind: 'reconciliation_required', idempotencyKey: row.idempotency_key };
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
    return reclaimRow(row, requestHash, 'expired');
  }

  if (row.status === 'failed') {
    if (row.failure_class === 'terminal') {
      return { kind: 'conflict', idempotencyKey: row.idempotency_key };
    }
    return reclaimRow(row, requestHash, 'failed');
  }

  return { kind: 'in_progress', idempotencyKey: row.idempotency_key };
}

function claimMemory(
  userId: number,
  tenantId: number,
  idempotencyKey: string,
  requestHash: string,
  options: { allowExpiredFencedRequestHashRebind?: boolean } = {},
): TrainingPlanGenerationIdempotencyClaim {
  const key = memoryKey(userId, tenantId, idempotencyKey);
  const existing = MEMORY_ROWS.get(key);
  if (existing) {
    if (!shouldReplaceExistingAutoRow(existing)) {
      return claimFromExisting(existing, requestHash, options);
    }
    const nowIso = new Date().toISOString();
    const identity = newLeaseIdentity(idempotencyKey, requestHash);
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
      lease_owner: identity.leaseOwner,
      fencing_token: identity.fencingToken,
      lease_expires_at: leaseExpiryIso(),
      heartbeat_at: nowIso,
      attempt_count: 1,
    });
    return identity;
  }

  const nowIso = new Date().toISOString();
  const identity = newLeaseIdentity(idempotencyKey, requestHash);
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
    lease_owner: identity.leaseOwner,
    fencing_token: identity.fencingToken,
    lease_expires_at: leaseExpiryIso(),
    heartbeat_at: nowIso,
    attempt_count: 1,
  });
  return identity;
}

function shouldReplaceExistingAutoRow(row: IdempotencyRow): boolean {
  if (!isAutomaticIdempotencyKey(row.idempotency_key)) return false;
  if (row.status === 'in_progress' || row.status === 'succeeded') return false;
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
  const identity = newLeaseIdentity(row.idempotency_key, requestHash);
  const result = db.prepare(`
    UPDATE ${IDEMPOTENCY_TABLE}
       SET request_hash = ?,
           status = 'in_progress',
           response_json = NULL,
           status_code = NULL,
           failure_class = NULL,
           last_error_code = NULL,
           lease_owner = ?,
           fencing_token = ?,
           lease_expires_at = ?,
           heartbeat_at = ?,
           attempt_count = 1,
           created_at = ?,
           updated_at = ?
     WHERE user_id = ?
       AND tenant_id = ?
       AND idempotency_key = ?
       AND request_hash = ?
       AND status = ?
       AND updated_at IS ?
  `).run(
    requestHash,
    identity.leaseOwner,
    identity.fencingToken,
    leaseExpiryIso(),
    nowIso,
    nowIso,
    nowIso,
    row.user_id,
    row.tenant_id,
    row.idempotency_key,
    row.request_hash,
    row.status,
    row.updated_at,
  );
  if (result.changes !== 1) {
    const current = getRow(db, row.user_id, row.tenant_id, row.idempotency_key);
    return current
      ? classifyExistingWithoutMutation(current, requestHash)
      : { kind: 'in_progress', idempotencyKey: row.idempotency_key };
  }
  return identity;
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

function isOwnedLiveRow(
  row: IdempotencyRow | undefined,
  claim: TrainingPlanGenerationLeaseIdentity,
  nowMs: number,
): row is IdempotencyRow {
  if (!row) return false;
  return row.status === 'in_progress'
    && row.idempotency_key === claim.idempotencyKey
    && row.request_hash === claim.requestHash
    && row.lease_owner === claim.leaseOwner
    && row.fencing_token === claim.fencingToken
    && !isLeaseExpired(row, nowMs);
}

function classifyExistingWithoutMutation(
  row: IdempotencyRow,
  requestHash: string,
): TrainingPlanGenerationIdempotencyClaim {
  if (row.request_hash !== requestHash) {
    return { kind: 'conflict', idempotencyKey: row.idempotency_key };
  }
  if (row.status === 'succeeded') {
    if (!row.response_json) {
      return { kind: 'reconciliation_required', idempotencyKey: row.idempotency_key };
    }
    try {
      return {
        kind: 'replay',
        idempotencyKey: row.idempotency_key,
        responseData: JSON.parse(row.response_json),
        statusCode: row.status_code || 200,
      };
    } catch {
      return { kind: 'reconciliation_required', idempotencyKey: row.idempotency_key };
    }
  }
  if (row.status === 'failed' && row.failure_class === 'terminal') {
    return { kind: 'conflict', idempotencyKey: row.idempotency_key };
  }
  return { kind: 'in_progress', idempotencyKey: row.idempotency_key };
}

function blockedAttemptStatus(
  state: 'in_progress' | 'expired' | 'unknown' | 'not_found',
): TrainingPlanGenerationAttemptStatus {
  if (state === 'unknown' || state === 'not_found') {
    return {
      schemaVersion: TRAINING_PLAN_GENERATION_ATTEMPT_STATUS_SCHEMA_VERSION,
      state,
      recovery: 'check_status_again',
      canStartNew: false,
    };
  }
  return {
    schemaVersion: TRAINING_PLAN_GENERATION_ATTEMPT_STATUS_SCHEMA_VERSION,
    state,
    recovery: 'retry_same_attempt',
    canStartNew: false,
  };
}

function proveScopedPlanReplay(input: {
  userId: number;
  tenantId: number;
  responseJson: string;
}): { kind: 'active' | 'inactive'; planId: number } | null {
  let responseData: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.responseJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    responseData = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const planId = parseAttemptReplayPlanId(responseData);
  const responseStatus = typeof responseData.status === 'string'
    ? responseData.status.trim().toLowerCase()
    : '';
  if (planId == null || (responseStatus && responseStatus !== 'created')) return null;

  const plan = trainingPlans.getPlanById(planId);
  if (!plan || plan.user_id !== input.userId || plan.tenant_id !== input.tenantId) return null;

  const lifecycleStatus = String(plan.status || '').trim().toLowerCase();
  if (!['active', 'canceled', 'superseded'].includes(lifecycleStatus)) return null;

  const weeks = trainingPlans.getWeeksForPlan(planId);
  if (!Array.isArray(weeks) || weeks.length === 0) return null;
  const hasSession = weeks.some((week) => {
    const weekId = Number(week?.id);
    return Number.isFinite(weekId)
      && weekId > 0
      && trainingPlans.getSessionsForWeek(weekId).length > 0;
  });
  if (!hasSession) return null;
  return { kind: lifecycleStatus === 'active' ? 'active' : 'inactive', planId };
}

function parseAttemptReplayPlanId(responseData: Record<string, unknown>): number | null {
  const raw = responseData.planId ?? responseData.plan_id;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
