// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// F5 (Phase 1C): repair for compatibility states the Phase 1A/1B fixes stop
// creating but cannot retroactively clean up.

import { describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { runTrainingPlanRepair, scanTrainingPlanRepairs } from '../../src/services/training-plan-repair';

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

describe('training plan repair (F5)', () => {
  it('finds and clears a stale idempotency claim whose lease elapsed', () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    db.prepare(`
      INSERT INTO training_plan_generation_idempotency_scoped
        (user_id, tenant_id, idempotency_key, request_hash, status, lease_expires_at, updated_at)
      VALUES (?, ?, 'auto:stale', 'hash', 'in_progress', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    `).run(userId, userId);

    const dryRun = runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(dryRun.findings.map((f) => f.kind)).toContain('stale_idempotency_claim');
    expect(dryRun.repaired).toBe(0);

    // Dry run must not mutate.
    const stillInProgress = db.prepare(
      "SELECT status FROM training_plan_generation_idempotency_scoped WHERE idempotency_key = 'auto:stale'",
    ).get() as { status: string };
    expect(stillInProgress.status).toBe('in_progress');

    const applied = runTrainingPlanRepair(db, { mode: 'apply' });
    expect(applied.repaired).toBe(1);
    const after = db.prepare(
      "SELECT status, failure_class, last_error_code FROM training_plan_generation_idempotency_scoped WHERE idempotency_key = 'auto:stale'",
    ).get() as { status: string; failure_class: string; last_error_code: string };
    expect(after.status).toBe('failed');
    expect(after.failure_class).toBe('terminal');
    expect(after.last_error_code).toBe('REPAIR_STALE_CLAIM');

    // Idempotent: a second apply finds nothing left.
    expect(runTrainingPlanRepair(db, { mode: 'apply' }).repaired).toBe(0);
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

  it('removes an orphaned pending_activation plan but leaves active plans alone', () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    const orphanId = seedPlan(db, userId, 'pending_activation', "datetime('now', '-2 hours')");
    const activeId = seedPlan(db, userId, 'active');

    const applied = runTrainingPlanRepair(db, { mode: 'apply' });
    expect(applied.repaired).toBeGreaterThanOrEqual(1);

    const orphan = db.prepare('SELECT id FROM fitness_training_plans WHERE id = ?').get(orphanId);
    const active = db.prepare('SELECT id FROM fitness_training_plans WHERE id = ?').get(activeId);
    expect(orphan).toBeUndefined();
    expect(active).toBeTruthy();
    db.close();
  });

  it('reports duplicate active plans and empty plans without mutating them', () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    const first = seedPlan(db, userId, 'active');
    const second = seedPlan(db, userId, 'active');

    const findings = scanTrainingPlanRepairs(db);
    const duplicate = findings.find((f) => f.kind === 'duplicate_active_plan');
    expect(duplicate?.repairable).toBe(false);
    // Both empty, so both are reported as partial — also non-repairable.
    expect(findings.filter((f) => f.kind === 'partial_plan')).toHaveLength(2);

    runTrainingPlanRepair(db, { mode: 'apply' });
    // Which of two active plans is authoritative is not inferable from rows
    // alone, so apply must leave them both in place for an operator.
    for (const id of [first, second]) {
      expect(db.prepare('SELECT id FROM fitness_training_plans WHERE id = ?').get(id)).toBeTruthy();
    }
    db.close();
  });

  it('produces an order-independent digest so apply can be pinned to a dry-run', () => {
    const db = createMigratedTestDatabase();
    const userId = seedUser(db);
    seedPlan(db, userId, 'pending_activation', "datetime('now', '-2 hours')");

    const a = runTrainingPlanRepair(db, { mode: 'dry_run' });
    const b = runTrainingPlanRepair(db, { mode: 'dry_run' });
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toHaveLength(64);
    db.close();
  });
});
