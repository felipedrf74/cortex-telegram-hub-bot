// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { requireTenantIdParam } from './tenant-scope';

export type TrainingOperationName =
  | 'calendar_generate'
  | 'calendar_sync'
  | 'calendar_reflow'
  | 'calendar_cancel'
  | 'calendar_cleanup'
  | 'plan_activate'
  | 'plan_repair'
  | 'adapt'
  | 'coach_apply';

export interface TrainingOperationLockInput {
  userId: number;
  tenantId: number;
  planId?: number | null;
  operation: TrainingOperationName;
  /**
   * Standalone operator tools already own an explicit database handle. Using
   * it here keeps the advisory lock and the guarded mutation on the same
   * store without initializing the process-global application database.
   */
  db?: Database.Database;
}

/**
 * Callable release handle plus an explicit ownership fence. Existing callers
 * can keep invoking the handle as a function; mutation/provider boundaries
 * that need stronger fencing call `assertActive()` immediately before the
 * effect. The signal is aborted when the lease expires, is stolen, cannot be
 * renewed, or is released.
 */
export interface TrainingOperationLockLease {
  (): void;
  readonly signal: AbortSignal;
  assertActive(): void;
}

/**
 * F35 (Phase 1A-5) — the operation/resource conflict matrix.
 *
 * Every Training operation currently contends on ONE key per user+tenant
 * (`training-calendar:user:<id>:tenant:<id>`), so an unrelated calendar sync
 * blocks plan generation. The obvious reaction — split the key per operation —
 * is wrong without first stating which pairs actually conflict, because most
 * of these operations contend over the same two resources rather than over
 * each other.
 *
 * Two resources are at stake:
 *   - `plan`     — the athlete's active plan row and its projection
 *                  (weeks/sessions, the active pointer).
 *   - `calendar` — provider events owned by Training for that athlete.
 *
 * Coach apply writes both resources synchronously: it patches the scoped
 * provider event and then records the matching Training-session change.
 *
 * Two operations conflict iff they write a resource in common. Read-only
 * operations do not take this lock at all.
 *
 *                 generate  activate  adapt  reflow  sync  cancel  repair  calendar_delivery
 *   generate         X         X        X      X      X      X       X            X
 *   activate         X         X        X      X      X      X       X            X
 *   adapt            X         X        X      X      X      X       X            X
 *   reflow           X         X        X      X      X      X       X            X
 *   sync             X         X        X      X      X      X       X            X
 *   cancel           X         X        X      X      X      X       X            X
 *   repair           X         X        X      X      X      X       X            X
 *   delivery         X         X        X      X      X      X       X            X
 *
 * The matrix is currently total: every operation writes `plan`, `calendar`, or
 * both, and the two resources are coupled (a plan mutation implies calendar
 * follow-up). So the single key is CORRECT today and must not be split — the
 * defect is not the key, it is that contention surfaces as an untyped 500.
 *
 * Splitting becomes safe only once calendar effects move behind the outbox
 * (Phase 1B/§5), at which point `calendar_delivery` stops sharing the `plan`
 * resource with the rest and earns its own key. This constant exists so that
 * change is a deliberate edit to a stated model rather than an inference.
 */
export const TRAINING_OPERATION_RESOURCES: Record<TrainingOperationName, ReadonlyArray<'plan' | 'calendar'>> = {
  calendar_generate: ['plan', 'calendar'],
  calendar_sync: ['calendar'],
  calendar_reflow: ['plan', 'calendar'],
  calendar_cancel: ['plan', 'calendar'],
  calendar_cleanup: ['calendar'],
  plan_activate: ['plan', 'calendar'],
  plan_repair: ['plan', 'calendar'],
  adapt: ['plan', 'calendar'],
  coach_apply: ['plan', 'calendar'],
};

/** True when two operations write at least one resource in common. */
export function trainingOperationsConflict(
  left: TrainingOperationName,
  right: TrainingOperationName,
): boolean {
  const rightResources = TRAINING_OPERATION_RESOURCES[right];
  return TRAINING_OPERATION_RESOURCES[left].some((resource) => rightResources.includes(resource));
}

/**
 * Typed lock-contention failure (F35).
 *
 * Previously this was a bare `Error`, uncaught and unmapped, so a contended
 * or stale lock surfaced as a generic 500 — violating the contract standard's
 * "never 500 for a known case" rule and telling the caller nothing about
 * whether retrying would help.
 *
 * `retryAfterSeconds` is derived from the caller's WAIT budget, NOT from the
 * lock TTL. The TTL bounds how long a *holder* may keep the lock; the wait is
 * how long this caller already blocked. Advertising the TTL would tell a
 * client to wait up to 20 minutes for a lock that is usually free in seconds.
 */
export class TrainingOperationLockError extends Error {
  readonly code = 'TRAINING_OPERATION_LOCKED';
  readonly status = 409;
  readonly operation: TrainingOperationName;
  readonly retryAfterSeconds: number;

  constructor(operation: TrainingOperationName, retryAfterSeconds: number) {
    super(`TRAINING_OPERATION_LOCKED: ${operation}`);
    this.name = 'TrainingOperationLockError';
    this.operation = operation;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isTrainingOperationLockError(err: unknown): err is TrainingOperationLockError {
  return err instanceof TrainingOperationLockError;
}

/**
 * The lock store itself could not be reached, so mutual exclusion cannot be
 * proven. This is distinct from contention: callers should retry it as a
 * temporary 503, never continue the write without the shared resource lock.
 */
export class TrainingOperationLockUnavailableError extends Error {
  readonly code = 'TRAINING_OPERATION_LOCK_UNAVAILABLE';
  readonly status = 503;
  readonly operation: TrainingOperationName;
  readonly retryAfterSeconds: number;

  constructor(operation: TrainingOperationName, retryAfterSeconds = 5) {
    super(`TRAINING_OPERATION_LOCK_UNAVAILABLE: ${operation}`);
    this.name = 'TrainingOperationLockUnavailableError';
    this.operation = operation;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isTrainingOperationLockUnavailableError(
  err: unknown,
): err is TrainingOperationLockUnavailableError {
  return err instanceof TrainingOperationLockUnavailableError;
}

export interface TrainingOperationLockPublicError {
  code: 'TRAINING_OPERATION_LOCKED' | 'TRAINING_OPERATION_LOCK_UNAVAILABLE';
  status: 409 | 503;
  message: string;
  operation: TrainingOperationName;
  retryAfterSeconds: number;
  details: {
    operation: TrainingOperationName;
    retryAfterSeconds: number;
  };
}

/**
 * Convert only known lock failures into the scope-safe transport contract.
 * The returned details are constructed from an explicit allowlist; raw error
 * properties and messages can contain database, owner, user, or tenant data
 * and must never be spread into an API/Decision payload.
 */
export function trainingOperationLockPublicError(
  err: unknown,
): TrainingOperationLockPublicError | null {
  if (isTrainingOperationLockError(err)) {
    return buildTrainingOperationLockPublicError(
      err.code,
      err.status,
      'Another training operation is in progress. Please try again shortly.',
      err.operation,
      err.retryAfterSeconds,
    );
  }
  if (isTrainingOperationLockUnavailableError(err)) {
    return buildTrainingOperationLockPublicError(
      err.code,
      err.status,
      'Training operations are temporarily unavailable. Please try again shortly.',
      err.operation,
      err.retryAfterSeconds,
    );
  }
  return null;
}

function buildTrainingOperationLockPublicError(
  code: TrainingOperationLockPublicError['code'],
  status: TrainingOperationLockPublicError['status'],
  message: string,
  operation: TrainingOperationName,
  retryAfterSeconds: number,
): TrainingOperationLockPublicError {
  return {
    code,
    status,
    message,
    operation,
    retryAfterSeconds,
    details: { operation, retryAfterSeconds },
  };
}

const TRAINING_OPERATION_LOCK_WAIT_MS = 30_000;
const TRAINING_OPERATION_LOCK_POLL_MS = 25;
const TRAINING_OPERATION_LOCK_TTL_MS_BY_OPERATION: Record<TrainingOperationName, number> = {
  calendar_generate: 20 * 60_000,
  calendar_sync: 15 * 60_000,
  calendar_reflow: 10 * 60_000,
  calendar_cancel: 15 * 60_000,
  calendar_cleanup: 10 * 60_000,
  plan_activate: 10 * 60_000,
  plan_repair: 15 * 60_000,
  adapt: 10 * 60_000,
  coach_apply: 10 * 60_000,
};

const memoryLocks = new Map<string, Promise<void>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTestRuntime(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' || Boolean(process.env.VITEST_WORKER_ID);
}

function tryGetLockDb(): ReturnType<typeof getDb> | null {
  try {
    return getDb() ?? null;
  } catch {
    return null;
  }
}

function ensureTrainingOperationLockTable(db: ReturnType<typeof getDb>): void {
  const existing = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name = 'training_operation_locks'
  `).get();
  if (!existing) {
    createTrainingOperationLockTable(db);
    return;
  }

  const columns = db.prepare('PRAGMA table_info(training_operation_locks)').all() as Array<{ name: string; notnull: number }>;
  const tenantColumn = columns.find((column) => column.name === 'tenant_id');
  if (!tenantColumn) {
    migrateTrainingOperationLocksTenantScope(db);
  } else {
    backfillTrainingOperationLockTenantScope(db);
  }
  ensureTrainingOperationLockIndexes(db);
}

function createTrainingOperationLockTable(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_operation_locks (
      lock_key TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      operation TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      plan_id INTEGER,
      acquired_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
  `);
  ensureTrainingOperationLockIndexes(db);
}

function migrateTrainingOperationLocksTenantScope(db: ReturnType<typeof getDb>): void {
  db.exec(`
    ALTER TABLE training_operation_locks
      ADD COLUMN tenant_id INTEGER;
  `);
  backfillTrainingOperationLockTenantScope(db);
}

function backfillTrainingOperationLockTenantScope(db: ReturnType<typeof getDb>): void {
  db.exec(`
    UPDATE training_operation_locks
       SET tenant_id = user_id
     WHERE tenant_id IS NULL;
  `);
}

function ensureTrainingOperationLockIndexes(db: ReturnType<typeof getDb>): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_training_operation_locks_expires
      ON training_operation_locks(expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_training_operation_locks_user_tenant_operation
      ON training_operation_locks(user_id, tenant_id, operation);
  `);
}

function runTrainingOperationLockStoreStep<T>(
  operation: TrainingOperationName,
  step: () => T,
): T {
  try {
    return step();
  } catch (err) {
    // Keep the raw SQLite failure in server-only logs. The typed exception is
    // deliberately scope-free because route and Decision surfaces serialize it.
    logger.warn(
      { err, operation },
      'Training operation lock store unavailable during acquisition',
    );
    throw new TrainingOperationLockUnavailableError(operation);
  }
}

function ttlMsForTrainingOperation(operation: TrainingOperationName): number {
  return TRAINING_OPERATION_LOCK_TTL_MS_BY_OPERATION[operation] ?? 10 * 60_000;
}

export function trainingCalendarOperationLockKey(input: Pick<TrainingOperationLockInput, 'userId' | 'tenantId'>): string {
  const userId = requireTrainingOperationUserId(input.userId);
  const tenantId = requireTenantIdParam(input.tenantId, 'trainingCalendarOperationLockKey');
  return `training-calendar:user:${userId}:tenant:${tenantId}`;
}

async function acquireMemoryTrainingOperationLock(
  lockKey: string,
  operation: TrainingOperationName,
): Promise<TrainingOperationLockLease> {
  const prior = memoryLocks.get(lockKey);
  if (prior) {
    try {
      await prior;
    } catch {
      // A failed previous operation should not poison later attempts.
    }
  }

  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  memoryLocks.set(lockKey, current);

  const abortController = new AbortController();
  let released = false;
  const release = (() => {
    if (released) return;
    released = true;
    abortController.abort();
    releaseCurrent();
    if (memoryLocks.get(lockKey) === current) {
      memoryLocks.delete(lockKey);
    }
  }) as TrainingOperationLockLease;
  Object.defineProperties(release, {
    signal: { value: abortController.signal, enumerable: true },
    assertActive: {
      value: () => {
        if (released || memoryLocks.get(lockKey) !== current) {
          throw new TrainingOperationLockError(operation, 1);
        }
      },
      enumerable: true,
    },
  });
  return release;
}

export async function acquireTrainingCalendarOperationLock(
  input: TrainingOperationLockInput,
): Promise<TrainingOperationLockLease> {
  const userId = requireTrainingOperationUserId(input.userId);
  const tenantId = requireTenantIdParam(input.tenantId, 'acquireTrainingCalendarOperationLock');
  const lockKey = trainingCalendarOperationLockKey(input);
  const db = input.db ?? tryGetLockDb();
  if (!db) {
    if (isTestRuntime()) return acquireMemoryTrainingOperationLock(lockKey, input.operation);
    throw new TrainingOperationLockUnavailableError(input.operation);
  }

  runTrainingOperationLockStoreStep(
    input.operation,
    () => ensureTrainingOperationLockTable(db),
  );
  const ownerToken = crypto.randomUUID();
  const startedAt = Date.now();
  const planId = Number.isFinite(Number(input.planId)) && Number(input.planId) > 0
    ? Math.trunc(Number(input.planId))
    : null;

  while (Date.now() - startedAt < TRAINING_OPERATION_LOCK_WAIT_MS) {
    const nowMs = Date.now();
    const result = runTrainingOperationLockStoreStep(input.operation, () => {
      db.prepare('DELETE FROM training_operation_locks WHERE lock_key = ? AND expires_at_ms <= ?')
        .run(lockKey, nowMs);
      return db.prepare(`
        INSERT OR IGNORE INTO training_operation_locks (
          lock_key,
          owner_token,
          operation,
          user_id,
          tenant_id,
          plan_id,
          acquired_at_ms,
          expires_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lockKey,
        ownerToken,
        input.operation,
        userId,
        tenantId,
        planId,
        nowMs,
        nowMs + ttlMsForTrainingOperation(input.operation),
      );
    });
    if (result.changes > 0) {
      let released = false;
      let lost = false;
      const ttlMs = ttlMsForTrainingOperation(input.operation);
      const abortController = new AbortController();
      let renewalInterval: ReturnType<typeof setInterval> | null = null;
      const markLost = (): void => {
        if (lost || released) return;
        lost = true;
        abortController.abort();
        if (renewalInterval) clearInterval(renewalInterval);
      };
      const assertActive = (): void => {
        if (released || lost) {
          throw new TrainingOperationLockError(input.operation, 1);
        }
        const checkedAtMs = Date.now();
        let active: { active: number } | undefined;
        try {
          active = db.prepare(`
            SELECT 1 AS active
              FROM training_operation_locks
             WHERE lock_key = ?
               AND owner_token = ?
               AND expires_at_ms > ?
          `).get(lockKey, ownerToken, checkedAtMs) as { active: number } | undefined;
        } catch (err) {
          markLost();
          logger.warn(
            { err, operation: input.operation },
            'Training operation SQLite lock lease validation failed',
          );
          throw new TrainingOperationLockUnavailableError(input.operation);
        }
        if (!active) {
          markLost();
          throw new TrainingOperationLockError(input.operation, 1);
        }
      };
      renewalInterval = setInterval(() => {
        try {
          const renewedAtMs = Date.now();
          const renewed = db.prepare(`
            UPDATE training_operation_locks
               SET expires_at_ms = ?
             WHERE lock_key = ?
               AND owner_token = ?
               AND expires_at_ms > ?
          `).run(renewedAtMs + ttlMs, lockKey, ownerToken, renewedAtMs);
          if (renewed.changes !== 1) {
            markLost();
            logger.warn(
              { operation: input.operation },
              'Training operation SQLite lock lease ownership was lost',
            );
          }
        } catch (err) {
          markLost();
          logger.warn(
            { err, operation: input.operation },
            'Training operation SQLite lock lease renewal failed',
          );
        }
      }, Math.max(1_000, Math.floor(ttlMs / 3)));
      if (typeof renewalInterval.unref === 'function') renewalInterval.unref();
      const release = (() => {
        if (released) return;
        released = true;
        abortController.abort();
        if (renewalInterval) clearInterval(renewalInterval);
        try {
          db.prepare('DELETE FROM training_operation_locks WHERE lock_key = ? AND owner_token = ?')
            .run(lockKey, ownerToken);
        } catch (err) {
          logger.warn({ err, operation: input.operation }, 'Training operation SQLite lock release failed');
        }
      }) as TrainingOperationLockLease;
      Object.defineProperties(release, {
        signal: { value: abortController.signal, enumerable: true },
        assertActive: { value: assertActive, enumerable: true },
      });
      return release;
    }
    await sleep(TRAINING_OPERATION_LOCK_POLL_MS);
  }

  // F35 (Phase 1A-5): typed, not a bare Error. The lock key is deliberately
  // NOT in the message — it embeds user and tenant ids, and this value reaches
  // the client error envelope.
  throw new TrainingOperationLockError(
    input.operation,
    Math.ceil(TRAINING_OPERATION_LOCK_WAIT_MS / 1000),
  );
}

export async function withTrainingCalendarOperationLock<T>(
  input: TrainingOperationLockInput,
  fn: (lease: TrainingOperationLockLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireTrainingCalendarOperationLock(input);
  try {
    lease.assertActive();
    const result = await fn(lease);
    lease.assertActive();
    return result;
  } finally {
    lease();
  }
}

export function _resetTrainingOperationLocksForTests(): void {
  memoryLocks.clear();
}

function requireTrainingOperationUserId(userId: number): number {
  if (!Number.isFinite(userId) || userId <= 0 || !Number.isSafeInteger(userId)) {
    throw new Error(`TRAINING_OPERATION_LOCK_USER_SCOPE_REQUIRED: ${String(userId)}`);
  }
  return Math.trunc(userId);
}
