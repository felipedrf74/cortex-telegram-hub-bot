// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase 1B backfill: already-processed activation events never replay for the
 * new calendar-sync consumer, so existing active plans need an explicit,
 * dry-run-first, digest-locked path onto the outbox. The backfill itself must
 * never touch providers — it only emits or replays request events.
 */

import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { withDatabaseForTest } from '../../src/services/database';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import * as trainingPlans from '../../src/services/training-plans';
import { claimPendingEvents, emitDomainEvent, markEventProcessed } from '../../src/services/event-outbox';
import { runTrainingPlanCalendarSyncBackfill } from '../../src/services/training-plan-calendar-sync-backfill';
import { TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE } from '../../src/services/training-plan-calendar-sync-worker';

const USER_ID = 7;
const TENANT_ID = 7;

function futureIso(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

function seedLegacyPlan(options: {
  preferencesJson?: string;
  sessions?: Array<{
    withWindow?: boolean;
    calendarEventId?: string;
    calendarSource?: string;
  }>;
} = {}): { planId: number; sessionIds: number[] } {
  const plan = trainingPlans.createPlan({
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    name: 'Legacy Plan',
    sport: 'running',
    goal: 'Base build',
    duration_weeks: 1,
    periodization: 'block',
    start_date: '2026-08-03',
    end_date: '2026-08-10',
    preferences_json: options.preferencesJson ?? '{}',
    status: 'active',
  });
  const week = trainingPlans.createWeek({
    plan_id: plan.id,
    week_number: 1,
    focus: 'base',
    intensity_pct: 70,
    volume_sessions: options.sessions?.length ?? 2,
  });
  const sessionIds: number[] = [];
  const sessionSpecs = options.sessions ?? [{ withWindow: true }, { withWindow: true }];
  sessionSpecs.forEach((spec, index) => {
    const session = trainingPlans.createSession({
      week_id: week.id,
      plan_id: plan.id,
      day_of_week: 'Monday',
      session_type: 'run',
      title: `Legacy Session ${index + 1}`,
      duration_minutes: 45,
      status: 'scheduled',
      ...(spec.calendarEventId
        ? { calendar_event_id: spec.calendarEventId, calendar_source: spec.calendarSource ?? 'google' }
        : {}),
      ...(spec.withWindow === false
        ? {}
        : { scheduled_start_at: futureIso(3 + index), scheduled_end_at: futureIso(4 + index) }),
    });
    sessionIds.push(session.id);
  });
  return { planId: plan.id, sessionIds };
}

/**
 * Drive an outbox row to `failed` the way a real worker does.
 *
 * Migration 279's `trg_event_outbox_terminal_tombstone` forbids any terminal
 * transition (`processed` / `failed` / `dead_letter`) from a state other than
 * `processing`: a row can only reach a terminal state by being claimed first.
 * A bare `pending -> failed` UPDATE is therefore not a legal transition, and
 * the abort this test used to hit was the fence working, not a defect.
 *
 * The legal path is claim-then-fail:
 *   1. `pending -> processing` with a full fence (fresh token, owner,
 *      locked_at, unexpired lease), per `trg_event_outbox_fenced_claim_transition`.
 *   2. `processing -> failed` RETAINING the same token and clearing
 *      `lease_expires_at`, per `trg_event_outbox_fenced_terminal_transition`.
 *      Keeping the token is what leaves the tombstone that rejects a later
 *      predecessor overwrite.
 */
function failOutboxEventLikeWorker(db: Database.Database, eventId: string): void {
  const token = `fence-backfill-${eventId}`;
  db.prepare(`
    UPDATE event_outbox
       SET status = 'processing', lock_owner = 'backfill-test-worker',
           locked_at = datetime('now'), fencing_token = ?,
           lease_expires_at = datetime('now', '+15 minutes')
     WHERE event_id = ?
  `).run(token, eventId);
  db.prepare(`
    UPDATE event_outbox
       SET status = 'failed', lease_expires_at = NULL, fencing_token = ?,
           lock_owner = NULL, locked_at = NULL
     WHERE event_id = ?
  `).run(token, eventId);
}

function outboxRows(db: Database.Database) {
  return db.prepare(
    'SELECT * FROM event_outbox WHERE event_type = ? ORDER BY sequence ASC',
  ).all(TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE) as Array<Record<string, any>>;
}

describe('training-plan-calendar-sync-backfill', () => {
  it('dry-run reports eligible plans with a deterministic digest and writes nothing', () => {
    const db = createMigratedTestDatabase();
    withDatabaseForTest(db, () => {
      const { planId, sessionIds } = seedLegacyPlan();
      const first = runTrainingPlanCalendarSyncBackfill({ mode: 'dry_run', db });
      const second = runTrainingPlanCalendarSyncBackfill({ mode: 'dry_run', db });

      expect(first.candidates).toHaveLength(1);
      expect(first.candidates[0]).toMatchObject({
        planId,
        planVersion: 1,
        action: 'emit',
        syncTarget: 'auto',
        syncableSessionIds: sessionIds,
        sessionsMissingScheduleWindow: 0,
      });
      expect(first.totals).toMatchObject({ plansEligible: 1, sessionsSyncable: 2 });
      expect(first.digest).toBe(second.digest);
      expect(first.applied).toBeNull();
      expect(outboxRows(db)).toHaveLength(0);
    });
    db.close();
  });

  it('refuses apply when the digest does not match a fresh dry-run', () => {
    const db = createMigratedTestDatabase();
    withDatabaseForTest(db, () => {
      seedLegacyPlan();
      expect(() => runTrainingPlanCalendarSyncBackfill({
        mode: 'apply',
        expectedDigest: 'a'.repeat(64),
        db,
      })).toThrow(/DIGEST_MISMATCH/);
      expect(outboxRows(db)).toHaveLength(0);
    });
    db.close();
  });

  it('apply emits one request per eligible plan and a re-run reports already_queued', () => {
    const db = createMigratedTestDatabase();
    withDatabaseForTest(db, () => {
      const { planId, sessionIds } = seedLegacyPlan();
      const dryRun = runTrainingPlanCalendarSyncBackfill({ mode: 'dry_run', db });
      const applied = runTrainingPlanCalendarSyncBackfill({
        mode: 'apply',
        expectedDigest: dryRun.digest,
        db,
      });
      expect(applied.applied).toEqual({ emitted: 1, skipped: 0 });
      const rows = outboxRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('pending');
      expect(JSON.parse(rows[0].payload_json)).toMatchObject({
        planId,
        planVersion: 1,
        syncTarget: 'auto',
        sessionIds,
        backfill: true,
      });

      // Idempotent: the pending request is detected, not duplicated.
      const secondDryRun = runTrainingPlanCalendarSyncBackfill({ mode: 'dry_run', db });
      expect(secondDryRun.candidates[0].action).toBe('already_queued');
      const reApplied = runTrainingPlanCalendarSyncBackfill({
        mode: 'apply',
        expectedDigest: secondDryRun.digest,
        db,
      });
      expect(reApplied.applied).toEqual({ emitted: 0, skipped: 1 });
      expect(outboxRows(db)).toHaveLength(1);
    });
    db.close();
  });

  it('treats a failed (still-retrying) canonical request as already queued', () => {
    // Review finding: outbox status 'failed' is a LIVE state — the outbox
    // retries it with backoff, and its job may still be retrying too.
    // Emitting a parallel suffixed request would race the canonical one.
    const db = createMigratedTestDatabase();
    withDatabaseForTest(db, () => {
      const { planId, sessionIds } = seedLegacyPlan();
      const event = emitDomainEvent({
        tenantId: TENANT_ID,
        userId: USER_ID,
        sourceSkill: 'training',
        eventType: TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE,
        entityType: 'training_plan',
        entityId: planId,
        payload: { planId, planVersion: 1, sessionIds, syncTarget: 'google' },
        idempotencyKey: `training.plan_calendar_sync.requested:${planId}:1`,
      }, db);
      failOutboxEventLikeWorker(db, event.eventId);

      const dryRun = runTrainingPlanCalendarSyncBackfill({ mode: 'dry_run', db });
      expect(dryRun.candidates[0]).toMatchObject({
        action: 'already_queued',
        existingEventId: event.eventId,
      });
      const applied = runTrainingPlanCalendarSyncBackfill({
        mode: 'apply',
        expectedDigest: dryRun.digest,
        db,
      });
      expect(applied.applied).toEqual({ emitted: 0, skipped: 1 });
      expect(outboxRows(db)).toHaveLength(1);
    });
    db.close();
  });

  it('emits a fresh suffixed request when the canonical one already ran to a terminal state', () => {
    const db = createMigratedTestDatabase();
    withDatabaseForTest(db, () => {
      const { planId, sessionIds } = seedLegacyPlan();
      const event = emitDomainEvent({
        tenantId: TENANT_ID,
        userId: USER_ID,
        sourceSkill: 'training',
        eventType: TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE,
        entityType: 'training_plan',
        entityId: planId,
        payload: { planId, planVersion: 1, sessionIds, syncTarget: 'google' },
        idempotencyKey: `training.plan_calendar_sync.requested:${planId}:1`,
      }, db);
      // Stronger guarantee: even fixture terminalization must carry the exact
      // lease owner/token instead of using the predecessor id-only shortcut.
      markEventProcessed(claimPendingEvents(1, 'backfill-canonical-fixture', db)[0], db);

      // Replaying the processed event would be neutralized by the router's
      // job idempotency key against the completed job row, so the backfill
      // must emit a FRESH event under a deterministic suffixed key instead.
      const dryRun = runTrainingPlanCalendarSyncBackfill({ mode: 'dry_run', db });
      expect(dryRun.candidates[0]).toMatchObject({ action: 'emit' });
      expect(dryRun.candidates[0].emitIdempotencyKey).toMatch(
        new RegExp(`^training\\.plan_calendar_sync\\.requested:${planId}:1:bf-[a-f0-9]{16}$`),
      );
      const applied = runTrainingPlanCalendarSyncBackfill({
        mode: 'apply',
        expectedDigest: dryRun.digest,
        db,
      });
      expect(applied.applied).toEqual({ emitted: 1, skipped: 0 });
      const rows = outboxRows(db);
      expect(rows).toHaveLength(2);
      expect(rows[1].status).toBe('pending');
      expect(rows[1].event_id).not.toBe(event.eventId);

      // Once the suffixed request also terminates with the same unlinked
      // set, the backfill refuses to loop and reports it for the operator.
      markEventProcessed(claimPendingEvents(1, 'backfill-suffixed-fixture', db)[0], db);
      const third = runTrainingPlanCalendarSyncBackfill({ mode: 'dry_run', db });
      expect(third.candidates[0]).toMatchObject({
        action: 'backfill_already_attempted',
        existingEventId: rows[1].event_id,
      });
    });
    db.close();
  });

  it('reports window-less pre-Phase-1B sessions instead of silently dropping them', () => {
    const db = createMigratedTestDatabase();
    withDatabaseForTest(db, () => {
      seedLegacyPlan({ sessions: [{ withWindow: true }, { withWindow: false }] });
      const mixed = runTrainingPlanCalendarSyncBackfill({ mode: 'dry_run', db });
      expect(mixed.candidates[0]).toMatchObject({
        action: 'emit',
        sessionsMissingScheduleWindow: 1,
      });
      expect(mixed.candidates[0].syncableSessionIds).toHaveLength(1);
      expect(mixed.totals.sessionsMissingScheduleWindow).toBe(1);
    });
    db.close();
  });

  it('classifies window-less-only plans and provider opt-outs as skips', () => {
    const db = createMigratedTestDatabase();
    withDatabaseForTest(db, () => {
      seedLegacyPlan({ sessions: [{ withWindow: false }] });
      seedLegacyPlan({
        preferencesJson: JSON.stringify({
          trainingPlanSpec: { calendarPreference: { provider: 'none' } },
        }),
      });
      const dryRun = runTrainingPlanCalendarSyncBackfill({ mode: 'dry_run', db });
      expect(dryRun.candidates.map((candidate) => candidate.action).sort()).toEqual([
        'skip_no_syncable_window',
        'skip_provider_opt_out',
      ]);
      const applied = runTrainingPlanCalendarSyncBackfill({
        mode: 'apply',
        expectedDigest: dryRun.digest,
        db,
      });
      expect(applied.applied).toEqual({ emitted: 0, skipped: 2 });
      expect(outboxRows(db)).toHaveLength(0);
    });
    db.close();
  });

  it('resolves the sync target from preferences and then from linked sessions', () => {
    const db = createMigratedTestDatabase();
    withDatabaseForTest(db, () => {
      const fromPreferences = seedLegacyPlan({
        preferencesJson: JSON.stringify({ trainingCalendarSource: 'outlook' }),
      });
      const fromLinkedSession = seedLegacyPlan({
        sessions: [
          { withWindow: true },
          // Already linked → excluded from the syncable set, but its provider
          // is the best evidence of where this plan's events live.
          { withWindow: true, calendarEventId: 'evt-old', calendarSource: 'google' },
        ],
      });
      const dryRun = runTrainingPlanCalendarSyncBackfill({ mode: 'dry_run', db });
      const byPlan = new Map(dryRun.candidates.map((candidate) => [candidate.planId, candidate]));
      expect(byPlan.get(fromPreferences.planId)).toMatchObject({ syncTarget: 'outlook' });
      expect(byPlan.get(fromLinkedSession.planId)).toMatchObject({
        syncTarget: 'google',
        syncableSessionIds: [fromLinkedSession.sessionIds[0]],
      });
    });
    db.close();
  });
});
