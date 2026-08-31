// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { isConnected } from './oauth-store';
import {
  trainingOperationLockPublicError,
  withTrainingCalendarOperationLock,
  type TrainingOperationLockLease,
} from './training-operation-locks';

export const TRAINING_CALENDAR_CLEANUP_SCHEMA = 'training_calendar_cleanup.v2' as const;
export const TRAINING_CALENDAR_CLEANUP_DEAD_LETTER_THRESHOLD = 5;
const MAX_REARM_ROWS = 50;
const NEXT_CHECK_AFTER_SECONDS = 30;

export type TrainingCalendarCleanupProvider = 'google' | 'outlook';
export type TrainingCalendarCleanupRetryState =
  | 'retrying'
  | 'action_required'
  | 'resolved'
  | 'unavailable';

export interface TrainingCalendarCleanupProviderBucket {
  provider: TrainingCalendarCleanupProvider;
  deadLetteredCount: number;
  retryingCount: number;
  actionRequiredCount: number;
}

export interface TrainingCalendarCleanupSnapshot {
  schemaVersion: typeof TRAINING_CALENDAR_CLEANUP_SCHEMA;
  deadLetteredCount: number;
  retryingCount: number;
  providers: TrainingCalendarCleanupProviderBucket[];
}

export interface TrainingCalendarCleanupRetryResult {
  schemaVersion: typeof TRAINING_CALENDAR_CLEANUP_SCHEMA;
  provider: TrainingCalendarCleanupProvider;
  state: TrainingCalendarCleanupRetryState;
  acceptedCount: number;
  deadLetteredCount: number;
  retryingCount: number;
  nextCheckAfterSeconds: number | null;
}

interface CleanupCountsRow {
  deadLetteredCount?: number | null;
  retryingCount?: number | null;
  actionRequiredCount?: number | null;
}

export function getTrainingCalendarCleanupSnapshot(
  userId: number,
  tenantId: number,
  db?: Database.Database,
): TrainingCalendarCleanupSnapshot | null {
  try {
    const database = db ?? getDb();
    if (!calendarCleanupSchemaReady(database)) return null;
    const providers = (['google', 'outlook'] as const).map((provider) => ({
      provider,
      ...readProviderCounts(database, userId, tenantId, provider),
    }));
    const deadLetteredCount = providers.reduce((total, bucket) => total + bucket.deadLetteredCount, 0);
    const retryingCount = providers.reduce((total, bucket) => total + bucket.retryingCount, 0);
    if (deadLetteredCount === 0 && retryingCount === 0) return null;
    return {
      schemaVersion: TRAINING_CALENDAR_CLEANUP_SCHEMA,
      deadLetteredCount,
      retryingCount,
      providers,
    };
  } catch {
    // This read model is advisory. A pre-migration or temporarily unavailable
    // database must not make the Training plan itself unavailable.
    return null;
  }
}

export async function retryTrainingCalendarCleanup(input: {
  userId: number;
  tenantId: number;
  provider: TrainingCalendarCleanupProvider;
  db?: Database.Database;
  providerConnected?: boolean;
}): Promise<TrainingCalendarCleanupRetryResult> {
  const db = input.db ?? getDb();
  if (!calendarCleanupSchemaReady(db)) {
    return emptyResult(input.provider, 'unavailable');
  }
  const connected = input.providerConnected ?? isConnected(input.userId, input.provider);
  if (!connected) {
    const counts = readProviderCounts(db, input.userId, input.tenantId, input.provider);
    return resultFromCounts(input.provider, 'unavailable', 0, counts);
  }

  try {
    return await withTrainingCalendarOperationLock(
      {
        userId: input.userId,
        tenantId: input.tenantId,
        operation: 'calendar_cleanup',
        db,
      },
      async (lease) => rearmEligibleCleanupRows(db, input, lease),
    );
  } catch (error) {
    if (!trainingOperationLockPublicError(error)) throw error;
    const counts = readProviderCounts(db, input.userId, input.tenantId, input.provider);
    return resultFromCounts(input.provider, 'unavailable', 0, counts);
  }
}

function rearmEligibleCleanupRows(
  db: Database.Database,
  input: {
    userId: number;
    tenantId: number;
    provider: TrainingCalendarCleanupProvider;
  },
  lease: TrainingOperationLockLease,
): TrainingCalendarCleanupRetryResult {
  lease.assertActive();
  const before = readProviderCounts(db, input.userId, input.tenantId, input.provider);
  if (before.deadLetteredCount === 0) {
    return resultFromCounts(
      input.provider,
      before.retryingCount > 0 ? 'retrying' : 'resolved',
      0,
      before,
    );
  }

  const update = db.transaction(() => {
    lease.assertActive();
    return db.prepare(`
      UPDATE secretary_agenda_items
         SET provider_sync_failure_count = ?,
             provider_sync_failure_disposition = 'retryable',
             provider_sync_retry_after_at = NULL,
             updated_at = datetime('now')
       WHERE agenda_item_id IN (
         SELECT agenda_item_id
           FROM secretary_agenda_items
          WHERE owner_user_id = ?
            AND tenant_id = ?
            AND source_skill = 'training'
            AND provider_sync_state = 'delete_failed'
            AND provider_sync_failure_count >= ?
            AND provider_target = ?
            AND (provider_source IS NULL OR provider_source = ?)
            AND provider_event_id IS NOT NULL
            AND COALESCE(provider_sync_failure_disposition, '') <> 'terminal'
          ORDER BY datetime(updated_at) ASC, agenda_item_id ASC
          LIMIT ?
       )
    `).run(
      TRAINING_CALENDAR_CLEANUP_DEAD_LETTER_THRESHOLD - 1,
      input.userId,
      String(input.tenantId),
      TRAINING_CALENDAR_CLEANUP_DEAD_LETTER_THRESHOLD,
      input.provider,
      input.provider,
      MAX_REARM_ROWS,
    ).changes;
  })();
  lease.assertActive();
  const after = readProviderCounts(db, input.userId, input.tenantId, input.provider);
  const state: TrainingCalendarCleanupRetryState = update > 0
    ? 'retrying'
    : after.deadLetteredCount > 0
      ? 'action_required'
      : after.retryingCount > 0
        ? 'retrying'
        : 'resolved';
  return resultFromCounts(input.provider, state, update, after);
}

function readProviderCounts(
  db: Database.Database,
  userId: number,
  tenantId: number,
  provider: TrainingCalendarCleanupProvider,
): Omit<TrainingCalendarCleanupProviderBucket, 'provider'> {
  const row = db.prepare(`
    SELECT
      SUM(CASE
        WHEN provider_sync_failure_count >= ? THEN 1 ELSE 0
      END) AS deadLetteredCount,
      SUM(CASE
        WHEN provider_sync_failure_count < ? THEN 1 ELSE 0
      END) AS retryingCount,
      SUM(CASE
        WHEN provider_sync_failure_count >= ?
         AND (
           COALESCE(provider_sync_failure_disposition, '') = 'terminal'
           OR provider_event_id IS NULL
           OR provider_target IS NULL
         )
        THEN 1 ELSE 0
      END) AS actionRequiredCount
    FROM secretary_agenda_items
    WHERE owner_user_id = ?
      AND tenant_id = ?
      AND source_skill = 'training'
      AND provider_sync_state = 'delete_failed'
      AND COALESCE(provider_target, provider_source) = ?
  `).get(
    TRAINING_CALENDAR_CLEANUP_DEAD_LETTER_THRESHOLD,
    TRAINING_CALENDAR_CLEANUP_DEAD_LETTER_THRESHOLD,
    TRAINING_CALENDAR_CLEANUP_DEAD_LETTER_THRESHOLD,
    userId,
    String(tenantId),
    provider,
  ) as CleanupCountsRow | undefined;
  return {
    deadLetteredCount: safeCount(row?.deadLetteredCount),
    retryingCount: safeCount(row?.retryingCount),
    actionRequiredCount: safeCount(row?.actionRequiredCount),
  };
}

function resultFromCounts(
  provider: TrainingCalendarCleanupProvider,
  state: TrainingCalendarCleanupRetryState,
  acceptedCount: number,
  counts: Omit<TrainingCalendarCleanupProviderBucket, 'provider'>,
): TrainingCalendarCleanupRetryResult {
  return {
    schemaVersion: TRAINING_CALENDAR_CLEANUP_SCHEMA,
    provider,
    state,
    acceptedCount,
    deadLetteredCount: counts.deadLetteredCount,
    retryingCount: counts.retryingCount,
    nextCheckAfterSeconds: state === 'retrying' ? NEXT_CHECK_AFTER_SECONDS : null,
  };
}

function emptyResult(
  provider: TrainingCalendarCleanupProvider,
  state: TrainingCalendarCleanupRetryState,
): TrainingCalendarCleanupRetryResult {
  return resultFromCounts(provider, state, 0, {
    deadLetteredCount: 0,
    retryingCount: 0,
    actionRequiredCount: 0,
  });
}

function safeCount(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

function calendarCleanupSchemaReady(db: Database.Database): boolean {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'secretary_agenda_items'",
  ).get();
  if (!table) return false;
  const columns = new Set(
    (db.prepare('PRAGMA table_info(secretary_agenda_items)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
      .filter((name): name is string => Boolean(name)),
  );
  return [
    'provider_sync_failure_count',
    'provider_sync_failure_disposition',
    'provider_sync_retry_after_at',
    'provider_target',
  ].every((column) => columns.has(column));
}
