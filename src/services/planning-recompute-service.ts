// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { getDb } from './database';
import { composeDailyBrief, type DailyBriefResponse } from './daily-brief-orchestrator';
import { createDecisionPlanningContext } from './decision-planning-context';
import { invalidatePlanningCaches } from './cache-coherence-registry';
import {
  assertPlanningSnapshotScope,
  createPlanningSnapshotIdentity,
  type PlanningSnapshotIdentity,
} from './planning-snapshot-contract';
import { composeWeeklyPlan, type WeeklyPlanResponse } from './weekly-plan-orchestrator';

const RECOMPUTE_LEASE_MINUTES = 5;
const RECOMPUTE_LEASE_HEARTBEAT_MS = 60_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type PlanningRecomputeErrorCode =
  | 'PLANNING_RECOMPUTE_INVALID'
  | 'PLANNING_RECOMPUTE_IDEMPOTENCY_REQUIRED'
  | 'PLANNING_RECOMPUTE_IDEMPOTENCY_REUSED'
  | 'PLANNING_RECOMPUTE_IN_PROGRESS'
  | 'PLANNING_RECOMPUTE_RECEIPT_INVALID';

export class PlanningRecomputeError extends Error {
  constructor(
    public readonly code: PlanningRecomputeErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'PlanningRecomputeError';
  }
}

export interface PlanningRecomputeInput {
  userId: number;
  tenantId: number;
  timezone: string;
  locale: string;
  idempotencyKey: unknown;
  weekStart?: unknown;
  date?: unknown;
  now?: Date;
}

export interface PlanningRecomputeResult {
  snapshot: PlanningSnapshotIdentity;
  week: WeeklyPlanResponse;
  today: DailyBriefResponse;
}

interface RecomputeReceiptRow {
  requestFingerprint: string;
  status: 'processing' | 'completed' | 'failed';
  leaseExpiresAt: string | null;
  responseJson: string | null;
}

interface NormalizedRecomputeRequest {
  weekStart: string;
  date: string;
  keyHash: string;
  requestFingerprint: string;
}

interface RecomputeLeaseHeartbeat {
  renewOrThrow(): void;
  stop(): void;
}

export async function recomputePlanningSnapshot(
  input: PlanningRecomputeInput,
): Promise<PlanningRecomputeResult> {
  const context = createDecisionPlanningContext({
    userId: input.userId,
    tenantId: input.tenantId,
    timezone: input.timezone,
    locale: input.locale,
    ...(input.now ? { now: input.now } : {}),
  });
  const normalized = normalizeRequest(input, context.localDate, context.timezone, context.locale);
  const db = getDb();
  const existing = readReceipt(db, input.userId, input.tenantId, normalized.keyHash);
  const replay = resolveExistingReceipt(existing, normalized.requestFingerprint, context.nowUtc);
  if (replay) return replay;

  const leaseToken = randomUUID();
  const leaseExpiresAt = DateTime.fromISO(context.nowUtc, { zone: 'utc' })
    .plus({ minutes: RECOMPUTE_LEASE_MINUTES })
    .toISO()!;
  const receiptId = `plan-recompute:${normalized.keyHash}`;
  const claimed = claimReceipt({
    receiptId,
    userId: input.userId,
    tenantId: input.tenantId,
    requestFingerprint: normalized.requestFingerprint,
    keyHash: normalized.keyHash,
    leaseToken,
    leaseExpiresAt,
    nowUtc: context.nowUtc,
  });
  if (!claimed) {
    const winner = readReceipt(db, input.userId, input.tenantId, normalized.keyHash);
    const winnerReplay = resolveExistingReceipt(winner, normalized.requestFingerprint, context.nowUtc);
    if (winnerReplay) return winnerReplay;
    throw new PlanningRecomputeError(
      'PLANNING_RECOMPUTE_IN_PROGRESS',
      'A recompute with this idempotency key is already in progress.',
      409,
    );
  }

  const leaseHeartbeat = startRecomputeLeaseHeartbeat({
    receiptId,
    userId: input.userId,
    tenantId: input.tenantId,
    leaseToken,
    baseNowUtc: context.nowUtc,
  });
  try {
    leaseHeartbeat.renewOrThrow();
    invalidatePlanningCaches(input.userId);
    const snapshot = createPlanningSnapshotIdentity(context, normalized.weekStart);
    assertPlanningSnapshotScope(snapshot, {
      userId: input.userId,
      tenantId: input.tenantId,
      timezone: context.timezone,
      weekStart: normalized.weekStart,
    });
    const week = await composeWeeklyPlan({
      userId: input.userId,
      tenantId: input.tenantId,
      weekStart: normalized.weekStart,
      timezone: context.timezone,
      forceRefresh: true,
      syncSignals: true,
      cacheMode: 'bypass',
      planningContext: context,
      planningSnapshot: snapshot,
    });
    leaseHeartbeat.renewOrThrow();
    const today = await composeDailyBrief({
      userId: input.userId,
      tenantId: input.tenantId,
      date: normalized.date,
      language: context.locale,
      timezone: context.timezone,
      forceRefresh: true,
      cacheMode: 'bypass',
      weekPlan: week,
      planningSnapshot: snapshot,
      planningContext: context,
    });
    leaseHeartbeat.renewOrThrow();
    assertCoherentResult({ snapshot, week, today }, normalized);
    const result = { snapshot, week, today };
    const completed = db.prepare(`
      UPDATE planning_recompute_receipts
         SET status = 'completed',
             lease_token = NULL,
             lease_expires_at = NULL,
             snapshot_id = ?,
             response_json = ?,
             last_error_code = NULL,
             updated_at = ?
       WHERE receipt_id = ?
         AND user_id = ?
         AND tenant_id = ?
         AND status = 'processing'
         AND lease_token = ?
    `).run(
      snapshot.snapshotId,
      JSON.stringify(result),
      context.nowUtc,
      receiptId,
      input.userId,
      input.tenantId,
      leaseToken,
    );
    if (completed.changes !== 1) {
      const winner = readReceipt(db, input.userId, input.tenantId, normalized.keyHash);
      const winnerReplay = resolveExistingReceipt(winner, normalized.requestFingerprint, context.nowUtc);
      if (winnerReplay) return winnerReplay;
      throw new PlanningRecomputeError(
        'PLANNING_RECOMPUTE_IN_PROGRESS',
        'The recompute lease changed before the result could be recorded.',
        409,
      );
    }
    return result;
  } catch (error) {
    db.prepare(`
      UPDATE planning_recompute_receipts
         SET status = 'failed',
             lease_token = NULL,
             lease_expires_at = NULL,
             last_error_code = ?,
             updated_at = ?
       WHERE receipt_id = ?
         AND user_id = ?
         AND tenant_id = ?
         AND status = 'processing'
         AND lease_token = ?
    `).run(
      error instanceof PlanningRecomputeError ? error.code : 'PLANNING_RECOMPUTE_FAILED',
      context.nowUtc,
      receiptId,
      input.userId,
      input.tenantId,
      leaseToken,
    );
    throw error;
  } finally {
    leaseHeartbeat.stop();
  }
}

function startRecomputeLeaseHeartbeat(input: {
  receiptId: string;
  userId: number;
  tenantId: number;
  leaseToken: string;
  baseNowUtc: string;
}): RecomputeLeaseHeartbeat {
  const db = getDb();
  const baseMillis = DateTime.fromISO(input.baseNowUtc, { zone: 'utc' }).toMillis();
  const startedAtMillis = Date.now();
  let ownershipLost = false;
  let stopped = false;

  const renew = (): void => {
    if (stopped || ownershipLost) return;
    const elapsedMillis = Math.max(Date.now() - startedAtMillis, 0);
    const now = DateTime.fromMillis(baseMillis + elapsedMillis, { zone: 'utc' });
    const leaseExpiresAt = now.plus({ minutes: RECOMPUTE_LEASE_MINUTES }).toISO()!;
    try {
      const renewed = db.prepare(`
        UPDATE planning_recompute_receipts
           SET lease_expires_at = ?, updated_at = ?
         WHERE receipt_id = ?
           AND user_id = ?
           AND tenant_id = ?
           AND status = 'processing'
           AND lease_token = ?
      `).run(
        leaseExpiresAt,
        now.toISO()!,
        input.receiptId,
        input.userId,
        input.tenantId,
        input.leaseToken,
      );
      ownershipLost = renewed.changes !== 1;
    } catch {
      ownershipLost = true;
    }
  };

  const assertOwned = (): void => {
    if (!ownershipLost) return;
    throw new PlanningRecomputeError(
      'PLANNING_RECOMPUTE_IN_PROGRESS',
      'The recompute lease changed before orchestration completed.',
      409,
    );
  };

  const timer = setInterval(renew, RECOMPUTE_LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return {
    renewOrThrow(): void {
      assertOwned();
      renew();
      assertOwned();
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function normalizeRequest(
  input: PlanningRecomputeInput,
  localDate: string,
  timezone: string,
  locale: string,
): NormalizedRecomputeRequest {
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const explicitDate = normalizeIsoDate(input.date, 'date', timezone);
  const explicitWeek = normalizeIsoDate(input.weekStart, 'weekStart', timezone);
  if (explicitWeek && DateTime.fromISO(explicitWeek, { zone: timezone }).weekday !== 1) {
    throw new PlanningRecomputeError(
      'PLANNING_RECOMPUTE_INVALID',
      'weekStart must be an ISO date for a Monday.',
      400,
    );
  }
  const date = explicitDate ?? explicitWeek ?? localDate;
  const weekStart = explicitWeek
    ?? DateTime.fromISO(date, { zone: timezone }).startOf('week').toISODate()!;
  const parsedDate = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  const parsedWeek = DateTime.fromISO(weekStart, { zone: timezone }).startOf('day');
  if (
    parsedDate.toMillis() < parsedWeek.toMillis()
    || parsedDate.toMillis() >= parsedWeek.plus({ days: 7 }).toMillis()
  ) {
    throw new PlanningRecomputeError(
      'PLANNING_RECOMPUTE_INVALID',
      'date must fall within the requested weekStart.',
      400,
    );
  }
  const keyHash = createHash('sha256')
    .update(`${input.tenantId}:${input.userId}:plan-recompute:${idempotencyKey}`)
    .digest('hex');
  const requestFingerprint = createHash('sha256').update(JSON.stringify({
    date,
    locale,
    tenantId: input.tenantId,
    timezone,
    userId: input.userId,
    weekStart,
  })).digest('hex');
  return { date, weekStart, keyHash, requestFingerprint };
}

function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PlanningRecomputeError(
      'PLANNING_RECOMPUTE_IDEMPOTENCY_REQUIRED',
      'idempotencyKey is required.',
      400,
    );
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new PlanningRecomputeError(
      'PLANNING_RECOMPUTE_IDEMPOTENCY_REQUIRED',
      'idempotencyKey must contain 1 to 200 characters.',
      400,
    );
  }
  return normalized;
}

function normalizeIsoDate(value: unknown, field: 'date' | 'weekStart', timezone: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw invalidDate(field);
  }
  const parsed = DateTime.fromISO(value, { zone: timezone });
  if (!parsed.isValid || parsed.toISODate() !== value) throw invalidDate(field);
  return value;
}

function invalidDate(field: 'date' | 'weekStart'): PlanningRecomputeError {
  return new PlanningRecomputeError(
    'PLANNING_RECOMPUTE_INVALID',
    `${field} must be an exact ISO calendar date (YYYY-MM-DD).`,
    400,
  );
}

function readReceipt(
  db: ReturnType<typeof getDb>,
  userId: number,
  tenantId: number,
  keyHash: string,
): RecomputeReceiptRow | null {
  const row = db.prepare(`
    SELECT request_fingerprint AS requestFingerprint,
           status,
           lease_expires_at AS leaseExpiresAt,
           response_json AS responseJson
      FROM planning_recompute_receipts
     WHERE user_id = ? AND tenant_id = ? AND idempotency_key_hash = ?
     LIMIT 1
  `).get(userId, tenantId, keyHash) as RecomputeReceiptRow | undefined;
  return row ?? null;
}

function resolveExistingReceipt(
  receipt: RecomputeReceiptRow | null,
  requestFingerprint: string,
  nowUtc: string,
): PlanningRecomputeResult | null {
  if (!receipt) return null;
  if (receipt.requestFingerprint !== requestFingerprint) {
    throw new PlanningRecomputeError(
      'PLANNING_RECOMPUTE_IDEMPOTENCY_REUSED',
      'This idempotency key was already used for a different recompute request.',
      409,
    );
  }
  if (receipt.status === 'completed') return parseReceipt(receipt.responseJson);
  if (
    receipt.status === 'processing'
    && receipt.leaseExpiresAt
    && DateTime.fromISO(receipt.leaseExpiresAt, { zone: 'utc' }).toMillis()
      > DateTime.fromISO(nowUtc, { zone: 'utc' }).toMillis()
  ) {
    throw new PlanningRecomputeError(
      'PLANNING_RECOMPUTE_IN_PROGRESS',
      'A recompute with this idempotency key is already in progress.',
      409,
    );
  }
  return null;
}

function claimReceipt(input: {
  receiptId: string;
  userId: number;
  tenantId: number;
  keyHash: string;
  requestFingerprint: string;
  leaseToken: string;
  leaseExpiresAt: string;
  nowUtc: string;
}): boolean {
  const db = getDb();
  const claim = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO planning_recompute_receipts (
        receipt_id, user_id, tenant_id, idempotency_key_hash, request_fingerprint,
        status, lease_token, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)
    `).run(
      input.receiptId,
      input.userId,
      input.tenantId,
      input.keyHash,
      input.requestFingerprint,
      input.leaseToken,
      input.leaseExpiresAt,
      input.nowUtc,
      input.nowUtc,
    );
    if (inserted.changes === 1) return true;
    return db.prepare(`
      UPDATE planning_recompute_receipts
         SET status = 'processing',
             lease_token = ?,
             lease_expires_at = ?,
             response_json = NULL,
             snapshot_id = NULL,
             last_error_code = NULL,
             updated_at = ?
       WHERE receipt_id = ?
         AND user_id = ?
         AND tenant_id = ?
         AND request_fingerprint = ?
         AND (
           status = 'failed'
           OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
         )
    `).run(
      input.leaseToken,
      input.leaseExpiresAt,
      input.nowUtc,
      input.receiptId,
      input.userId,
      input.tenantId,
      input.requestFingerprint,
      input.nowUtc,
    ).changes === 1;
  });
  return claim();
}

function parseReceipt(responseJson: string | null): PlanningRecomputeResult {
  if (!responseJson) throw invalidReceipt();
  try {
    const parsed = JSON.parse(responseJson) as Partial<PlanningRecomputeResult>;
    if (
      !parsed.snapshot?.snapshotId
      || parsed.week?.planningSnapshot?.snapshotId !== parsed.snapshot.snapshotId
      || parsed.today?.planningSnapshot?.snapshotId !== parsed.snapshot.snapshotId
      || parsed.week.generatedAt !== parsed.snapshot.generatedAt
      || parsed.today.generatedAt !== parsed.snapshot.generatedAt
    ) throw invalidReceipt();
    return parsed as PlanningRecomputeResult;
  } catch (error) {
    if (error instanceof PlanningRecomputeError) throw error;
    throw invalidReceipt();
  }
}

function invalidReceipt(): PlanningRecomputeError {
  return new PlanningRecomputeError(
    'PLANNING_RECOMPUTE_RECEIPT_INVALID',
    'The stored recompute receipt is invalid.',
    500,
  );
}

function assertCoherentResult(
  result: PlanningRecomputeResult,
  request: Pick<NormalizedRecomputeRequest, 'date' | 'weekStart'>,
): void {
  if (
    result.week.weekStart !== request.weekStart
    || result.today.date !== request.date
    || result.week.planningSnapshot?.snapshotId !== result.snapshot.snapshotId
    || result.today.planningSnapshot?.snapshotId !== result.snapshot.snapshotId
    || result.week.generatedAt !== result.snapshot.generatedAt
    || result.today.generatedAt !== result.snapshot.generatedAt
  ) throw invalidReceipt();
}
