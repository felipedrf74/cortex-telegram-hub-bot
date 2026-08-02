// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase 1B backfill: request calendar sync for active plans that predate the
 * outbox routing (their activation events were already processed and will
 * never replay for the new consumer).
 *
 * Dry-run by default and idempotent: for each active plan with syncable
 * unlinked sessions it emits a `training.plan_calendar_sync.requested.v1`
 * event (fresh eventId — replaying a processed event would be neutralized by
 * the router's per-eventId job idempotency key against the completed job
 * row), or reports that a request is already queued / already attempted. It
 * never calls providers itself — the training_plan_calendar_sync worker
 * performs all provider work under its own active-plan validation.
 *
 * Sessions persisted before Phase 1B have no `scheduled_start_at` window and
 * are reported (not silently dropped) as `sessionsMissingScheduleWindow`;
 * those need the F5 repair path, not this backfill.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { emitDomainEvent } from './event-outbox';
import { TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE } from './training-plan-calendar-sync-worker';

const SYNCABLE_SESSION_STATUSES = ['scheduled', 'reflowed', 'compressed', 'capped'] as const;

/** Outbox statuses that will still be delivered/retried without our help. */
const LIVE_EVENT_STATUSES = new Set(['pending', 'processing', 'failed']);

export type TrainingPlanCalendarSyncBackfillAction =
  | 'emit'
  | 'already_queued'
  | 'backfill_already_attempted'
  | 'skip_provider_opt_out'
  | 'skip_no_syncable_window';

export interface TrainingPlanCalendarSyncBackfillCandidate {
  planId: number;
  planVersion: number;
  tenantId: number;
  userId: number;
  syncTarget: 'google' | 'outlook' | 'auto' | null;
  syncableSessionIds: number[];
  sessionsMissingScheduleWindow: number;
  action: TrainingPlanCalendarSyncBackfillAction;
  existingEventId: string | null;
  /** Idempotency key the apply step will emit under (null for skips). */
  emitIdempotencyKey: string | null;
}

export interface TrainingPlanCalendarSyncBackfillResult {
  mode: 'dry_run' | 'apply';
  digest: string;
  totals: {
    plansScanned: number;
    plansEligible: number;
    sessionsSyncable: number;
    sessionsMissingScheduleWindow: number;
  };
  candidates: TrainingPlanCalendarSyncBackfillCandidate[];
  applied: { emitted: number; skipped: number } | null;
}

export interface TrainingPlanCalendarSyncBackfillInput {
  mode: 'dry_run' | 'apply';
  scope?: { userId: number; tenantId: number };
  planId?: number;
  expectedDigest?: string;
  db?: Database.Database;
}

interface PlanRow {
  planId: number;
  userId: number;
  tenantId: number;
  planVersion: number;
  preferencesJson: string | null;
}

interface SessionRow {
  id: number;
  status: string;
  calendar_event_id: string | null;
  calendar_source: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
}

function resolveSyncTarget(
  preferencesJson: string | null,
  sessions: SessionRow[],
): TrainingPlanCalendarSyncBackfillCandidate['syncTarget'] {
  let preferences: Record<string, unknown> = {};
  try {
    const parsed = preferencesJson ? JSON.parse(preferencesJson) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      preferences = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed preferences fall through to session-derived / auto targets.
  }
  const spec = preferences.trainingPlanSpec as Record<string, unknown> | undefined;
  const calendarPreference = spec?.calendarPreference as Record<string, unknown> | undefined;
  const specProvider = calendarPreference?.provider;
  if (specProvider === 'google' || specProvider === 'outlook') return specProvider;
  if (specProvider === 'none' || specProvider === 'apple') return null;
  const resolvedSource = preferences.trainingCalendarSource;
  if (resolvedSource === 'google' || resolvedSource === 'outlook') return resolvedSource;
  const linkedSource = sessions.find(
    (session) => session.calendar_source === 'google' || session.calendar_source === 'outlook',
  )?.calendar_source;
  if (linkedSource === 'google' || linkedSource === 'outlook') return linkedSource;
  // Same fallback the persist-time emit uses when no explicit provider is
  // configured: the worker lets unified-calendar resolve the user's provider.
  return 'auto';
}

function hasValidScheduleWindow(session: SessionRow): boolean {
  const startMs = Date.parse(String(session.scheduled_start_at || ''));
  const endMs = Date.parse(String(session.scheduled_end_at || ''));
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
}

function computeBackfillDigest(candidates: TrainingPlanCalendarSyncBackfillCandidate[]): string {
  // Order-independent: candidates are sorted on a stable key before hashing
  // so two scans of the same state always agree regardless of scan order.
  const material = [...candidates]
    .sort((left, right) => left.planId - right.planId)
    .map((candidate) => [
      candidate.tenantId,
      candidate.userId,
      candidate.planId,
      candidate.planVersion,
      candidate.syncTarget ?? 'null',
      candidate.action,
      candidate.emitIdempotencyKey ?? 'null',
      [...candidate.syncableSessionIds].sort((a, b) => a - b).join(','),
    ].join('|'))
    .join('\n');
  return createHash('sha256').update(material).digest('hex');
}

export function runTrainingPlanCalendarSyncBackfill(
  input: TrainingPlanCalendarSyncBackfillInput,
): TrainingPlanCalendarSyncBackfillResult {
  const db = input.db ?? getDb();
  const planPredicates: string[] = ["p.status = 'active'"];
  const planParams: unknown[] = [];
  if (input.scope) {
    planPredicates.push('p.user_id = ?', 'COALESCE(p.tenant_id, p.user_id) = ?');
    planParams.push(input.scope.userId, input.scope.tenantId);
  }
  if (input.planId != null) {
    planPredicates.push('p.id = ?');
    planParams.push(input.planId);
  }
  const plans = db.prepare(`
    SELECT p.id AS planId,
           p.user_id AS userId,
           COALESCE(p.tenant_id, p.user_id) AS tenantId,
           COALESCE(p.plan_version, 1) AS planVersion,
           p.preferences_json AS preferencesJson
      FROM fitness_training_plans p
     WHERE ${planPredicates.join(' AND ')}
     ORDER BY p.id ASC
  `).all(...planParams) as PlanRow[];

  const sessionStatement = db.prepare(`
    SELECT id, status, calendar_event_id, calendar_source, scheduled_start_at, scheduled_end_at
      FROM training_sessions
     WHERE plan_id = ?
     ORDER BY id ASC
  `);
  const existingEventStatement = db.prepare(`
    SELECT event_id AS eventId, status
      FROM event_outbox
     WHERE tenant_id = ?
       AND COALESCE(user_id, 0) = COALESCE(?, 0)
       AND idempotency_key = ?
     LIMIT 1
  `);

  const candidates: TrainingPlanCalendarSyncBackfillCandidate[] = [];
  let sessionsSyncable = 0;
  let sessionsMissingScheduleWindow = 0;

  for (const plan of plans) {
    const sessions = sessionStatement.all(plan.planId) as SessionRow[];
    const unlinkedActive = sessions.filter(
      (session) => (SYNCABLE_SESSION_STATUSES as readonly string[]).includes(session.status)
        && session.calendar_event_id == null,
    );
    const syncable = unlinkedActive.filter(hasValidScheduleWindow);
    const missingWindow = unlinkedActive.length - syncable.length;
    if (syncable.length === 0 && missingWindow === 0) continue;

    const syncTarget = resolveSyncTarget(plan.preferencesJson, sessions);
    let action: TrainingPlanCalendarSyncBackfillAction;
    let existingEventId: string | null = null;
    let emitIdempotencyKey: string | null = null;
    if (syncTarget === null) {
      action = 'skip_provider_opt_out';
    } else if (syncable.length === 0) {
      // Only window-less sessions remain — nothing this backfill can queue;
      // reported (not hidden) so the operator routes them to the F5 repair.
      action = 'skip_no_syncable_window';
    } else {
      const canonicalKey = `training.plan_calendar_sync.requested:${plan.planId}:${plan.planVersion}`;
      const canonical = existingEventStatement.get(plan.tenantId, plan.userId, canonicalKey) as
        | { eventId: string; status: string }
        | undefined;
      if (!canonical) {
        action = 'emit';
        emitIdempotencyKey = canonicalKey;
      } else if (LIVE_EVENT_STATUSES.has(canonical.status)) {
        // 'failed' is live too: the outbox retries failed events with
        // backoff, and the enqueued job may itself still be retrying —
        // emitting a parallel request here would race the canonical one.
        action = 'already_queued';
        existingEventId = canonical.eventId;
      } else {
        // The canonical request already ran to a terminal state but sessions
        // remain unlinked. Replaying that event would be neutralized by the
        // router's job idempotency key (`training_plan_calendar_sync:<eventId>`
        // against a completed job row), so the backfill emits a FRESH event
        // instead — a new eventId yields a fresh job. The suffix is derived
        // from the unlinked session set, so re-running against unchanged
        // state is idempotent while a changed set is allowed through.
        const backfillKey = `${canonicalKey}:bf-${createHash('sha256')
          .update(syncable.map((session) => session.id).sort((a, b) => a - b).join(','))
          .digest('hex')
          .slice(0, 16)}`;
        const backfillEvent = existingEventStatement.get(plan.tenantId, plan.userId, backfillKey) as
          | { eventId: string; status: string }
          | undefined;
        if (!backfillEvent) {
          action = 'emit';
          emitIdempotencyKey = backfillKey;
        } else if (LIVE_EVENT_STATUSES.has(backfillEvent.status)) {
          action = 'already_queued';
          existingEventId = backfillEvent.eventId;
        } else {
          // A backfill for this exact unlinked set already ran terminally —
          // refusing to loop distinguishes "needs operator attention" from
          // "just run it again".
          action = 'backfill_already_attempted';
          existingEventId = backfillEvent.eventId;
        }
      }
    }

    sessionsSyncable += syncable.length;
    sessionsMissingScheduleWindow += missingWindow;
    candidates.push({
      planId: plan.planId,
      planVersion: plan.planVersion,
      tenantId: plan.tenantId,
      userId: plan.userId,
      syncTarget,
      syncableSessionIds: syncable.map((session) => session.id),
      sessionsMissingScheduleWindow: missingWindow,
      action,
      existingEventId,
      emitIdempotencyKey,
    });
  }

  const digest = computeBackfillDigest(candidates);
  const result: TrainingPlanCalendarSyncBackfillResult = {
    mode: input.mode,
    digest,
    totals: {
      plansScanned: plans.length,
      plansEligible: candidates.length,
      sessionsSyncable,
      sessionsMissingScheduleWindow,
    },
    candidates,
    applied: null,
  };
  if (input.mode === 'dry_run') return result;

  if (!input.expectedDigest || input.expectedDigest !== digest) {
    throw new Error(
      'TRAINING_PLAN_CALENDAR_SYNC_BACKFILL_DIGEST_MISMATCH: run a fresh dry-run and pass its digest',
    );
  }

  let emitted = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (candidate.action === 'emit' && candidate.emitIdempotencyKey) {
      emitDomainEvent({
        tenantId: candidate.tenantId,
        userId: candidate.userId,
        sourceSkill: 'training',
        eventType: TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE,
        entityType: 'training_plan',
        entityId: candidate.planId,
        entityVersion: candidate.planVersion,
        schemaVersion: 'training-plan-calendar-sync.v1',
        payload: {
          planId: candidate.planId,
          planVersion: candidate.planVersion,
          sessionIds: candidate.syncableSessionIds,
          syncTarget: candidate.syncTarget,
          requestedSessions: candidate.syncableSessionIds.length,
          backfill: true,
        },
        privacyClassification: 'health',
        idempotencyKey: candidate.emitIdempotencyKey,
      }, db);
      emitted += 1;
    } else {
      skipped += 1;
    }
  }
  return { ...result, applied: { emitted, skipped } };
}
