/**
 * R5 P2 #7 — strength load model hydrates V2 sets/reps/load JSON.
 *
 * Codex caught that the prior coach-analysis SQL didn't pull the
 * V2 strength columns (`completed_sets_json`, `completed_reps_json`,
 * `completed_load_json`), so even when an athlete had logged real
 * tonnage, the load model collapsed to the duration*RPE proxy.
 *
 * The fix extracted `computeStrengthTonnageKg(...)` in the load
 * helper. These tests pin the canonical parsing behavior across
 * the two accepted JSON shapes + edge cases.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import {
  computeLoadModelAndDeload,
  computeStrengthTonnageKg,
} from '../../src/api/routes/training-coach-v2-load-helper';
import type { Principles } from '../../src/services/coach-kernel/training-principles';

describe('R5 P2 — computeStrengthTonnageKg', () => {
  it('returns undefined when no JSON is supplied', () => {
    expect(computeStrengthTonnageKg(null, null, null)).toBeUndefined();
    expect(computeStrengthTonnageKg('', '', '')).toBeUndefined();
  });

  it('Shape A — completedSetsJson with {reps, load} entries sums to tonnage', () => {
    const sets = JSON.stringify([
      { reps: 5, load: 100 }, // 500
      { reps: 5, load: 100 }, // 500
      { reps: 3, load: 110 }, // 330
    ]);
    expect(computeStrengthTonnageKg(sets, null, null)).toBe(1330);
  });

  it('Shape A — invalid entries are skipped (negative reps, NaN load)', () => {
    const sets = JSON.stringify([
      { reps: 5, load: 100 }, // 500
      { reps: -1, load: 100 }, // skipped (negative reps)
      { reps: 5, load: Number.NaN }, // skipped (NaN — not valid JSON, but defensive)
      { reps: 3, load: 110 }, // 330
    ]);
    // The NaN entry can't even survive JSON.stringify (becomes null);
    // the defensive path still skips it.
    expect(computeStrengthTonnageKg(sets, null, null)).toBe(830);
  });

  it('Shape A — empty array → undefined (no signal)', () => {
    expect(computeStrengthTonnageKg('[]', null, null)).toBeUndefined();
  });

  it('Shape B — parallel reps[]/load[] arrays sum to tonnage', () => {
    const reps = JSON.stringify([8, 8, 6]);
    const load = JSON.stringify([80, 80, 90]);
    // 8*80 + 8*80 + 6*90 = 640 + 640 + 540 = 1820
    expect(computeStrengthTonnageKg(null, reps, load)).toBe(1820);
  });

  it('Shape B — mismatched array lengths → undefined (refuse ambiguous data)', () => {
    expect(computeStrengthTonnageKg(null, '[5,5]', '[100,100,100]')).toBeUndefined();
  });

  it('Shape B — empty parallel arrays → undefined', () => {
    expect(computeStrengthTonnageKg(null, '[]', '[]')).toBeUndefined();
  });

  it('Shape A takes precedence over Shape B (canonical-form preference)', () => {
    const setsA = JSON.stringify([{ reps: 1, load: 1 }]);
    const reps = JSON.stringify([5]);
    const load = JSON.stringify([100]);
    // Shape A returns 1; Shape B would return 500. Pin that the
    // canonical form wins.
    expect(computeStrengthTonnageKg(setsA, reps, load)).toBe(1);
  });

  it('malformed JSON in shape A falls back gracefully to undefined (no throw)', () => {
    expect(computeStrengthTonnageKg('{not-json}', null, null)).toBeUndefined();
  });

  it('malformed JSON in shape B falls back gracefully to undefined (no throw)', () => {
    expect(computeStrengthTonnageKg(null, 'oops', 'oops')).toBeUndefined();
  });

  it('zero-load entries (bodyweight) → 0 tonnage but still "saw" → not undefined', () => {
    // Bodyweight squat × 10 reps × 0 kg load.
    const sets = JSON.stringify([{ reps: 10, load: 0 }, { reps: 10, load: 0 }]);
    expect(computeStrengthTonnageKg(sets, null, null)).toBe(0);
  });
});

/**
 * Tenant scoping — computeLoadModelAndDeload.
 *
 * The completions hydration query filtered on `s.user_id` only.
 * `user_id` is not unique across tenants (migration 140 backfills
 * tenant_id = user_id but new tenants can collide), so one tenant's
 * completions could hydrate another tenant's load model — feeding
 * cross-tenant data into ACWR/deload decisions. These tests pin the
 * fail-closed behavior, mirroring the tenant cases in
 * training-analytics-routes.test.ts.
 */
describe('tenant scoping — computeLoadModelAndDeload', () => {
  let db: Database.Database;
  const USER_ID = 12;
  const TENANT_A = 34;
  const TENANT_B = 99;
  const principles = {} as Principles;

  function seedPlan(planId: number, tenantId: number): void {
    db.prepare(`
      INSERT INTO fitness_training_plans
        (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (?, ?, ?, 'p', 'running', 12, '2026-01-05', '2026-12-31', 'active')
    `).run(planId, USER_ID, tenantId);
    db.prepare(
      'INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, 1)',
    ).run(planId * 100, planId);
    db.prepare(`
      INSERT INTO training_sessions
        (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
      VALUES (?, ?, ?, 'monday', 'easy_run', 'run', 60, 'completed')
    `).run(planId * 100, planId * 100, planId);
  }

  /** Seed one completion per day for the last `days` days. */
  function seedCompletions(planId: number, days: number): void {
    const dayMs = 24 * 3600 * 1000;
    for (let i = 1; i <= days; i++) {
      const date = new Date(Date.now() - i * dayMs).toISOString().slice(0, 10);
      db.prepare(`
        INSERT INTO training_completions
          (session_id, plan_id, completed_at, rpe_overall, duration_minutes)
        VALUES (?, ?, ?, 6, 60)
      `).run(planId * 100, planId, `${date} 10:00:00`);
    }
  }

  function computeFor(tenantId: number) {
    return computeLoadModelAndDeload({
      db,
      userId: USER_ID,
      tenantId,
      planSport: 'running',
      weeksSinceDeload: 2,
      scheduledDeloadCadenceWeeks: 4,
      principles,
    });
  }

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('fails closed — another tenant\'s completions for the same user_id do not hydrate the load model', () => {
    seedPlan(1, TENANT_B);
    seedCompletions(1, 20);

    const result = computeFor(TENANT_A);

    for (const dim of ['external', 'internal', 'strength', 'impact'] as const) {
      expect(result.loadModelByDimension[dim].ctl).toBe(0);
      expect(result.loadModelByDimension[dim].atl).toBe(0);
      expect(result.loadModelByDimension[dim].loadModelStatus).toBe('cold_start');
    }
    expect(result.deload.triggered).toBe(false);
  });

  it('still counts completions in the caller\'s own tenant (no over-filtering)', () => {
    seedPlan(1, TENANT_B);
    seedCompletions(1, 20);

    const result = computeFor(TENANT_B);

    // 20 days of RPE×duration completions → internal (sRPE) load is
    // hydrated and past the 14-day cold-start threshold.
    expect(result.loadModelByDimension.internal.ctl).toBeGreaterThan(0);
    expect(result.loadModelByDimension.internal.loadModelStatus).not.toBe('cold_start');
  });

  it('two tenants with the same user_id stay independent', () => {
    seedPlan(1, TENANT_A);
    seedCompletions(1, 3);
    seedPlan(2, TENANT_B);
    seedCompletions(2, 20);

    const a = computeFor(TENANT_A);
    const b = computeFor(TENANT_B);

    // Tenant A has only 3 days of data → cold_start; if tenant B's 20
    // days leaked in, status would be warming/stable.
    expect(a.loadModelByDimension.internal.loadModelStatus).toBe('cold_start');
    expect(b.loadModelByDimension.internal.loadModelStatus).not.toBe('cold_start');
    expect(b.loadModelByDimension.internal.ctl).toBeGreaterThan(
      a.loadModelByDimension.internal.ctl,
    );
  });
});
