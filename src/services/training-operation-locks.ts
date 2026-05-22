// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import { logger } from '../utils/logger';

export type TrainingOperationName =
  | 'calendar_generate'
  | 'calendar_sync'
  | 'calendar_reflow'
  | 'calendar_cancel';

export interface TrainingOperationLockInput {
  userId: number;
  tenantId?: number | null;
  planId?: number | null;
  operation: TrainingOperationName;
}

const TRAINING_OPERATION_LOCK_WAIT_MS = 30_000;
const TRAINING_OPERATION_LOCK_POLL_MS = 25;
const TRAINING_OPERATION_LOCK_TTL_MS_BY_OPERATION: Record<TrainingOperationName, number> = {
  calendar_generate: 20 * 60_000,
  calendar_sync: 15 * 60_000,
  calendar_reflow: 10 * 60_000,
  calendar_cancel: 15 * 60_000,
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_operation_locks (
      lock_key TEXT PRIMARY KEY,
      owner_token TEXT NOT NULL,
      operation TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER,
      plan_id INTEGER,
      acquired_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_training_operation_locks_expires
      ON training_operation_locks(expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_training_operation_locks_user
      ON training_operation_locks(user_id, operation);
  `);
}

function ttlMsForTrainingOperation(operation: TrainingOperationName): number {
  return TRAINING_OPERATION_LOCK_TTL_MS_BY_OPERATION[operation] ?? 10 * 60_000;
}

export function trainingCalendarOperationLockKey(input: Pick<TrainingOperationLockInput, 'userId' | 'tenantId'>): string {
  const tenantId = Number(input.tenantId ?? input.userId);
  const resolvedTenantId = Number.isFinite(tenantId) && tenantId > 0 ? Math.trunc(tenantId) : Math.trunc(input.userId);
  return `training-calendar:user:${Math.trunc(input.userId)}:tenant:${resolvedTenantId}`;
}

async function acquireMemoryTrainingOperationLock(lockKey: string): Promise<() => void> {
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

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (memoryLocks.get(lockKey) === current) {
      memoryLocks.delete(lockKey);
    }
  };
}

export async function acquireTrainingCalendarOperationLock(input: TrainingOperationLockInput): Promise<() => void> {
  if (!Number.isFinite(input.userId) || input.userId <= 0) {
    return () => { /* invalid user scope: caller will fail auth/ownership elsewhere */ };
  }

  const lockKey = trainingCalendarOperationLockKey(input);
  const db = tryGetLockDb();
  if (!db) {
    if (isTestRuntime()) return acquireMemoryTrainingOperationLock(lockKey);
    throw new Error('TRAINING_OPERATION_LOCK_UNAVAILABLE');
  }

  ensureTrainingOperationLockTable(db);
  const ownerToken = crypto.randomUUID();
  const startedAt = Date.now();
  const tenantId = Number.isFinite(Number(input.tenantId)) && Number(input.tenantId) > 0
    ? Math.trunc(Number(input.tenantId))
    : null;
  const planId = Number.isFinite(Number(input.planId)) && Number(input.planId) > 0
    ? Math.trunc(Number(input.planId))
    : null;

  while (Date.now() - startedAt < TRAINING_OPERATION_LOCK_WAIT_MS) {
    const nowMs = Date.now();
    db.prepare('DELETE FROM training_operation_locks WHERE lock_key = ? AND expires_at_ms <= ?')
      .run(lockKey, nowMs);
    const result = db.prepare(`
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
      Math.trunc(input.userId),
      tenantId,
      planId,
      nowMs,
      nowMs + ttlMsForTrainingOperation(input.operation),
    );
    if (result.changes > 0) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          db.prepare('DELETE FROM training_operation_locks WHERE lock_key = ? AND owner_token = ?')
            .run(lockKey, ownerToken);
        } catch (err) {
          logger.warn({ err, lockKey, operation: input.operation, userId: input.userId }, 'Training operation SQLite lock release failed');
        }
      };
    }
    await sleep(TRAINING_OPERATION_LOCK_POLL_MS);
  }

  throw new Error(`TRAINING_OPERATION_LOCK_TIMEOUT: ${lockKey}`);
}

export async function withTrainingCalendarOperationLock<T>(
  input: TrainingOperationLockInput,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireTrainingCalendarOperationLock(input);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function _resetTrainingOperationLocksForTests(): void {
  memoryLocks.clear();
}
