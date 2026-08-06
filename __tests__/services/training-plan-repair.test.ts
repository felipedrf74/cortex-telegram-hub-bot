// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// F5 (Phase 1C): repair for compatibility states the Phase 1A/1B fixes stop
// creating but cannot retroactively clean up.

import { describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { runTrainingPlanRepair, scanTrainingPlanRepairs } from '../../src/services/training-plan-repair';
import { withDatabaseForTest } from '../../src/services/database';
import { runLegacyActivePlanBackfill } from '../../src/services/training-plan-revision-legacy-backfill';
import { acquireTrainingCalendarOperationLock } from '../../src/services/training-operation-locks';

function seedUser(db: ReturnType<typeof createMigratedTestDatabase>): number {
  const row = db.prepare(`
    INSERT INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
    VALUES (900900, 'Repair', 'pro', 'active', 200, 500000, 1)
  `).run();
  return Number(row.lastInsertRowid);
}

function seedPlan(
  db: ReturnType<typeof createMigratedTestDatabase>,
  userId: number,
  status: string,
  createdAt = "datetime('now')",
): number {
  const row = db.prepare(`
    INSERT INTO fitness_training_plans
      (user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status, created_at)
    VALUES (?, ?, 'Plan', 'strength', 4, '2026-04-01', '2026-04-29', ?, ${createdAt})
  `).run(userId, userId, status);
  return Number(row.lastInsertRowid);
}

function seedPlanWeekWithSession(
  db: ReturnType<typeof createMigratedTestDatabase>,
  planId: number,
  tenantId: number,
  weekNumber: number,
): void {
  const week = db.prepare(`
    INSERT INTO training_weeks (plan_id, week_number, focus, volume_sessions)
    VALUES (?, ?, 'base', 1)
  `).run(planId, weekNumber);
  db.prepare(`
    INSERT INTO training_sessions (
      week_id, plan_id, tenant_id, day_of_week, session_type, title,
      exercises_json, duration_minutes, status
    ) VALUES (?, ?, ?, 'Monday', 'strength', ?, '[]', 30, 'pending')
  `).run(week.lastInsertRowid, planId, tenantId, `Week ${weekNumber}`);
}

function seedCompletePlan(
  db: ReturnType<typeof createMigratedTestDatabase>,
  userId: number,
  status = 'active',
): number {
  const planId = seedPlan(db, userId, status);
  for (let weekNumber = 1; weekNumber <= 4; weekNumber += 1) {
    seedPlanWeekWithSession(db, planId, userId, weekNumber);
  }
  return planId;
}

function seedActivePointer(
  db: ReturnType<typeof createMigratedTestDatabase>,
  userId: number,
): void {
  withDatabaseForTest(db, () => {
    const rehearsal = runLegacyActivePlanBackfill({
      mode: 'dry_run',
      scope: { userId, tenantId: userId },
    });
    runLegacyActivePlanBackfill({
      mode: 'apply',
      scope: { userId, tenantId: userId },
      expectedDigest: rehearsal.digest,
      env: {
        TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY:
          'training-repair-test-encryption-key-0001',
      },
    });
  });
}

describe('training plan repair (F5)', () => {
  it('finds and clears a stale idempotency claim whose lease elapsed', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    db.prepare(`
      INSERT INTO training_plan_generation_idempotency_scoped
        (user_id, tenant_id, idempotency_key, request_hash, status, lease_expires_at, updated_at)
      VALUES (?, ?, 'auto:stale', 'hash', 'in_progress', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    `).run(userId, userId);

    const dryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(dryRun.findings.map((f) => f.kind)).toContain('stale_idempotency_claim');
    expect(dryRun.repaired).toBe(0);

    // Dry run must not mutate.
    const stillInProgress = db.prepare(
      "SELECT status FROM training_plan_generation_idempotency_scoped WHERE idempotency_key = 'auto:stale'",
    ).get() as { status: string };
    expect(stillInProgress.status).toBe('in_progress');

    await expect(runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: '0'.repeat(64),
    })).rejects.toThrow(/digest/i);
    expect((db.prepare(
      "SELECT status FROM training_plan_generation_idempotency_scoped WHERE idempotency_key = 'auto:stale'",
    ).get() as { status: string }).status).toBe('in_progress');

    const applied = await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: dryRun.digest,
    });
    expect(applied.repaired).toBe(1);
    const after = db.prepare(
      "SELECT status, failure_class, last_error_code FROM training_plan_generation_idempotency_scoped WHERE idempotency_key = 'auto:stale'",
    ).get() as { status: string; failure_class: string; last_error_code: string };
    expect(after.status).toBe('failed');
    // F1 only reclaims failed rows whose class is retryable. The older
    // terminal expectation preserved the 409 forever and contradicted the
    // repair's purpose.
    expect(after.failure_class).toBe('retryable');
    expect(after.last_error_code).toBe('REPAIR_STALE_CLAIM');

    // Operator idempotency is scan-pinned: after the first repair, a fresh
    // dry-run produces the empty-state digest and the second apply is a no-op.
    const secondDryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: secondDryRun.digest,
    })).toMatchObject({ repaired: 0, findings: [] });
    db.close();
  });

  it('never reclaims a claim whose lease is still live', () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    db.prepare(`
      INSERT INTO training_plan_generation_idempotency_scoped
        (user_id, tenant_id, idempotency_key, request_hash, status, lease_expires_at, updated_at)
      VALUES (?, ?, 'auto:live', 'hash', 'in_progress', datetime('now', '+20 minutes'), datetime('now'))
    `).run(userId, userId);

    expect(scanTrainingPlanRepairs(db).map((f) => f.subject)).not.toContain('auto:live');
    db.close();
  });

  it('repairs an unreadable succeeded replay payload into a retryable claim', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    db.prepare(`
      INSERT INTO training_plan_generation_idempotency_scoped (
        user_id, tenant_id, idempotency_key, request_hash, status,
        response_json, status_code, updated_at
      ) VALUES (?, ?, 'manual:corrupt-response', 'hash', 'succeeded',
        '{not-json', 201, datetime('now'))
    `).run(userId, userId);

    const dryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(dryRun.findings).toContainEqual(expect.objectContaining({
      kind: 'corrupt_idempotency_payload',
      subject: 'manual:corrupt-response',
      repairable: true,
    }));
    expect(db.prepare(`
      SELECT status, response_json FROM training_plan_generation_idempotency_scoped
       WHERE idempotency_key = 'manual:corrupt-response'
    `).get()).toEqual({ status: 'succeeded', response_json: '{not-json' });

    expect(await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: dryRun.digest,
    })).toMatchObject({ repaired: 1 });
    expect(db.prepare(`
      SELECT status, response_json, status_code, failure_class, last_error_code
        FROM training_plan_generation_idempotency_scoped
       WHERE idempotency_key = 'manual:corrupt-response'
    `).get()).toEqual({
      status: 'failed',
      response_json: null,
      status_code: null,
      failure_class: 'retryable',
      last_error_code: 'REPAIR_CORRUPT_RESPONSE',
    });

    const secondDryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: secondDryRun.digest,
    })).toMatchObject({ findings: [], repaired: 0 });
    db.close();
  });

  it('removes an orphaned pending_activation plan but leaves active plans alone', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    const orphanId = seedPlan(db, userId, 'pending_activation', "datetime('now', '-2 hours')");
    const activeId = seedCompletePlan(db, userId);

    const dryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    const applied = await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: dryRun.digest,
    });
    expect(applied.repaired).toBeGreaterThanOrEqual(1);

    const orphan = db.prepare('SELECT id FROM fitness_training_plans WHERE id = ?').get(orphanId);
    const active = db.prepare('SELECT id FROM fitness_training_plans WHERE id = ?').get(activeId);
    expect(orphan).toBeUndefined();
    expect(active).toBeTruthy();
    db.close();
  });

  it('repairs a truly partial graph and a fresh second run is a no-op', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    const partialPlanId = seedPlan(db, userId, 'active');
    seedPlanWeekWithSession(db, partialPlanId, userId, 1);
    seedPlanWeekWithSession(db, partialPlanId, userId, 3);

    const dryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(dryRun.findings).toContainEqual(expect.objectContaining({
      kind: 'partial_plan',
      subject: String(partialPlanId),
      repairable: true,
      detail: expect.stringMatching(/missing weeks 2, 4/i),
    }));

    const applied = await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: dryRun.digest,
    });
    expect(applied.repaired).toBe(1);
    expect(db.prepare('SELECT status FROM fitness_training_plans WHERE id = ?')
      .get(partialPlanId)).toEqual({ status: 'superseded' });

    const secondDryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: secondDryRun.digest,
    })).toMatchObject({ findings: [], repaired: 0 });
    db.close();
  });

  it('uses a verified active pointer to supersede only duplicate same-sport losers', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    const authoritativePlanId = seedCompletePlan(db, userId);
    seedActivePointer(db, userId);
    const duplicatePlanId = seedCompletePlan(db, userId);

    // A different sport is intentionally allowed by getActivePlans and must
    // never be mistaken for a duplicate of the pointer-backed strength plan.
    const runningPlanId = seedCompletePlan(db, userId);
    db.prepare("UPDATE fitness_training_plans SET sport = 'running' WHERE id = ?")
      .run(runningPlanId);

    const dryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(dryRun.findings.filter((finding) => finding.kind === 'duplicate_active_plan'))
      .toEqual([expect.objectContaining({
        subject: String(duplicatePlanId),
        repairable: true,
        detail: expect.stringContaining(String(authoritativePlanId)),
      })]);

    const applied = await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: dryRun.digest,
    });
    expect(applied.repaired).toBe(1);
    expect(db.prepare('SELECT id, status FROM fitness_training_plans ORDER BY id').all())
      .toEqual([
        { id: authoritativePlanId, status: 'active' },
        { id: duplicatePlanId, status: 'superseded' },
        { id: runningPlanId, status: 'active' },
      ]);
    expect(db.prepare(`
      SELECT projection_plan_id FROM training_active_plan_references
    `).get()).toEqual({ projection_plan_id: authoritativePlanId });

    const secondDryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: secondDryRun.digest,
    })).toMatchObject({ findings: [], repaired: 0 });
    db.close();
  });

  it('leaves same-sport duplicates report-only when no pointer proves authority', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    const first = seedCompletePlan(db, userId);
    const second = seedCompletePlan(db, userId);

    const dryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(dryRun.findings).toContainEqual(expect.objectContaining({
      kind: 'duplicate_active_plan',
      repairable: false,
    }));
    expect((await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: dryRun.digest,
    })).repaired).toBe(0);
    for (const id of [first, second]) {
      expect(db.prepare('SELECT status FROM fitness_training_plans WHERE id = ?').get(id))
        .toEqual({ status: 'active' });
    }
    db.close();
  });

  it('produces an order-independent digest so apply can be pinned to a dry-run', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    seedPlan(db, userId, 'pending_activation', "datetime('now', '-2 hours')");

    const a = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    const b = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toHaveLength(64);
    db.close();
  });

  it('deletes only an ownership-verified orphan through the injected provider boundary', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    const planId = seedCompletePlan(db, userId);
    db.prepare(`
      INSERT INTO training_agenda_event_ownership (
        plan_id, plan_version, session_id, user_id, tenant_id,
        calendar_event_id, calendar_source, status
      ) VALUES (?, 1, NULL, ?, ?, 'provider-event-redacted-by-test', 'google', 'orphaned')
    `).run(planId, userId, userId);

    const dryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    const orphan = dryRun.findings.find((finding) => finding.kind === 'orphaned_provider_event');
    expect(orphan).toMatchObject({
      userId,
      tenantId: userId,
      repairable: true,
    });
    expect(orphan?.subject).not.toContain('provider-event-redacted-by-test');
    expect(JSON.stringify(dryRun)).not.toContain('provider-event-redacted-by-test');

    const deleteOwnedProviderEvent = vi.fn().mockResolvedValue({ alreadyGone: false });
    const applied = await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: dryRun.digest,
    }, { deleteOwnedProviderEvent });
    expect(applied.repaired).toBe(1);
    expect(deleteOwnedProviderEvent).toHaveBeenCalledOnce();
    expect(deleteOwnedProviderEvent).toHaveBeenCalledWith(expect.objectContaining({
      ownershipId: Number(orphan?.subject.replace('ownership:', '')),
      planId,
      userId,
      tenantId: userId,
      source: 'google',
      eventId: 'provider-event-redacted-by-test',
    }));
    expect(db.prepare(
      "SELECT status FROM training_agenda_event_ownership WHERE calendar_event_id = 'provider-event-redacted-by-test'",
    ).get()).toEqual({ status: 'deleted' });

    const secondDryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(await runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: secondDryRun.digest,
    }, { deleteOwnedProviderEvent })).toMatchObject({ findings: [], repaired: 0 });
    expect(deleteOwnedProviderEvent).toHaveBeenCalledOnce();
    db.close();
  });

  it('refuses apply when the provider event behind an ownership id drifted after rehearsal', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    const planId = seedCompletePlan(db, userId);
    db.prepare(`
      INSERT INTO training_agenda_event_ownership (
        plan_id, plan_version, session_id, user_id, tenant_id,
        calendar_event_id, calendar_source, status
      ) VALUES (?, 1, NULL, ?, ?, 'provider-before-rehearsal', 'google', 'orphaned')
    `).run(planId, userId, userId);
    const dryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    db.prepare(`
      UPDATE training_agenda_event_ownership
         SET calendar_event_id = 'provider-after-rehearsal'
       WHERE plan_id = ?
    `).run(planId);
    const deleteOwnedProviderEvent = vi.fn();

    await expect(runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: dryRun.digest,
    }, { deleteOwnedProviderEvent })).rejects.toThrow(/digest mismatch/i);
    expect(deleteOwnedProviderEvent).not.toHaveBeenCalled();
    expect(db.prepare(`
      SELECT status FROM training_agenda_event_ownership WHERE plan_id = ?
    `).get(planId)).toEqual({ status: 'orphaned' });
    db.close();
  });

  it('does not mark an orphan deleted when the provider boundary fails', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    const planId = seedCompletePlan(db, userId);
    db.prepare(`
      INSERT INTO training_agenda_event_ownership (
        plan_id, plan_version, session_id, user_id, tenant_id,
        calendar_event_id, calendar_source, status
      ) VALUES (?, 1, NULL, ?, ?, 'provider-delete-fails', 'google', 'orphaned')
    `).run(planId, userId, userId);
    const dryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });

    await expect(runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: dryRun.digest,
    }, {
      deleteOwnedProviderEvent: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    })).rejects.toThrow('provider unavailable');
    expect(db.prepare(`
      SELECT status FROM training_agenda_event_ownership
       WHERE calendar_event_id = 'provider-delete-fails'
    `).get()).toEqual({ status: 'orphaned' });
    db.close();
  });

  it('serializes apply behind the shared training operation lock', async () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    db.prepare(`
      INSERT INTO training_plan_generation_idempotency_scoped
        (user_id, tenant_id, idempotency_key, request_hash, status, lease_expires_at, updated_at)
      VALUES (?, ?, 'auto:serialized', 'hash', 'in_progress',
        '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    `).run(userId, userId);
    const dryRun = await runTrainingPlanRepair(db, { mode: 'dry_run' });
    const release = await acquireTrainingCalendarOperationLock({
      userId,
      tenantId: userId,
      operation: 'plan_repair',
      db,
    });

    let settled = false;
    const applying = runTrainingPlanRepair(db, {
      mode: 'apply',
      expectedDigest: dryRun.digest,
      scope: { userId, tenantId: userId },
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    release();
    await expect(applying).resolves.toMatchObject({ repaired: 1 });
    db.close();
  });
});
