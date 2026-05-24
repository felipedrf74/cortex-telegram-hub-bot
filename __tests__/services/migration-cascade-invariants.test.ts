/**
 * R8 P1-5 — Pin the actual FK / cascade behavior for the
 * migrations the v2.1 plan added. The prompt asked for cascade
 * coverage on migrations 156, 158, 159, 160, 161. Verifying first
 * surfaced that only 156 declares FKs; 158-161 have no FK clauses,
 * so deleting the parent row LEAVES children orphaned.
 *
 * These tests therefore PIN current behavior — they are not a
 * claim that the lack of FKs on 158-161 is correct. They surface
 * the contract so any future migration that adds FKs will fail
 * the assertion and force a conversation about cascade vs
 * orphan-prune semantics.
 *
 * Every test enables `PRAGMA foreign_keys = ON` so the assertions
 * exercise SQLite's enforcement path, not the silent-no-op default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* dep-order skip */ }
    }
  }
}

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

function seedUser(id: number): void {
  testDb.prepare(
    `INSERT INTO users (id, telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
     VALUES (?, ?, 'Test', 'pro', 'active', 200, 500000, 1)`,
  ).run(id, 100000 + id);
}

function seedPlan(planId: number, userId: number): void {
  testDb.prepare(
    `INSERT INTO fitness_training_plans
       (id, user_id, name, sport, status, start_date, end_date, duration_weeks, created_at)
     VALUES (?, ?, 'Test', 'running', 'active', '2026-05-01', '2026-07-01', 8, datetime('now'))`,
  ).run(planId, userId);
}

describe('Migration 156 — training_plan_adaptations FK declarations', () => {
  it('FK to fitness_training_plans is ON DELETE CASCADE', () => {
    seedUser(1);
    seedPlan(10, 1);
    testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, scope, trigger_type, science_policy_version, actor, created_at)
      VALUES (?, 'week', 't', '1.0.0', 'user', datetime('now'))
    `).run(10);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 10').get()).toEqual({ n: 1 });
    testDb.prepare('DELETE FROM fitness_training_plans WHERE id = 10').run();
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 10').get()).toEqual({ n: 0 });
  });

  it('FK to self (rollback_of_adaptation_id) is ON DELETE SET NULL', () => {
    seedUser(1);
    seedPlan(11, 1);
    const original = testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, scope, trigger_type, science_policy_version, actor, created_at)
      VALUES (?, 'week', 't_orig', '1.0.0', 'user', datetime('now'))
    `).run(11);
    const rollback = testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, scope, trigger_type, science_policy_version, actor, rollback_of_adaptation_id, created_at)
      VALUES (?, 'week', 't_rollback', '1.0.0', 'admin', ?, datetime('now'))
    `).run(11, original.lastInsertRowid);
    testDb.prepare('DELETE FROM training_plan_adaptations WHERE id = ?').run(original.lastInsertRowid);
    const after = testDb.prepare(
      'SELECT rollback_of_adaptation_id FROM training_plan_adaptations WHERE id = ?',
    ).get(rollback.lastInsertRowid) as { rollback_of_adaptation_id: number | null };
    expect(after.rollback_of_adaptation_id).toBeNull();
  });

  it('inserting an adaptation against a nonexistent plan id rejects (FK enforced)', () => {
    expect(() => testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, scope, trigger_type, science_policy_version, actor, created_at)
      VALUES (999, 'week', 't', '1.0.0', 'user', datetime('now'))
    `).run()).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('Migrations 158-161 — current FK state (PINS NO-FK BEHAVIOR)', () => {
  // R8 P1-5 note — the prompt assumed these tables had FKs to
  // their natural parents. Inspecting the migrations showed no
  // FK declarations. These tests pin the actual behavior so a
  // future schema migration that adds CASCADE shows up as a
  // breaking test rather than an undocumented data-loss surface.

  it('158 athlete_health_signals: deleting the user does NOT cascade rows (no FK declared)', () => {
    seedUser(50);
    testDb.prepare(`
      INSERT INTO athlete_health_signals (user_id, date, consent_scope, created_at)
      VALUES (50, '2026-05-10', 'illness', datetime('now'))
    `).run();
    testDb.prepare('DELETE FROM users WHERE id = 50').run();
    const remaining = testDb.prepare('SELECT COUNT(*) AS n FROM athlete_health_signals WHERE user_id = 50').get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it('158 athlete_readiness_events: deleting the user does NOT cascade rows (no FK declared)', () => {
    seedUser(51);
    testDb.prepare(`
      INSERT INTO athlete_readiness_events (user_id, date, consent_scope, created_at)
      VALUES (51, '2026-05-10', 'readiness_basic', datetime('now'))
    `).run();
    testDb.prepare('DELETE FROM users WHERE id = 51').run();
    const remaining = testDb.prepare('SELECT COUNT(*) AS n FROM athlete_readiness_events WHERE user_id = 51').get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it('159 coach_plan_policy is a column on fitness_training_plans → policy dies WITH the plan row (column-on-parent)', () => {
    seedUser(60);
    seedPlan(600, 60);
    testDb.prepare(
      "UPDATE fitness_training_plans SET coach_plan_policy_json = '{}' WHERE id = 600",
    ).run();
    testDb.prepare('DELETE FROM fitness_training_plans WHERE id = 600').run();
    const remaining = testDb.prepare(
      "SELECT COUNT(*) AS n FROM fitness_training_plans WHERE id = 600",
    ).get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('160 athlete_session_preferences: deleting the user does NOT cascade rows (no FK declared)', () => {
    seedUser(70);
    testDb.prepare(`
      INSERT INTO athlete_session_preferences (user_id, date, intensity_preference, created_at)
      VALUES (70, '2026-05-10', 'lower_intensity', datetime('now'))
    `).run();
    testDb.prepare('DELETE FROM users WHERE id = 70').run();
    const remaining = testDb.prepare(
      'SELECT COUNT(*) AS n FROM athlete_session_preferences WHERE user_id = 70',
    ).get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it('161 travel_windows: deleting the user does NOT cascade rows (no FK declared)', () => {
    seedUser(80);
    testDb.prepare(`
      INSERT INTO travel_windows (user_id, start_date, end_date, created_at)
      VALUES (80, '2026-05-01', '2026-05-07', datetime('now'))
    `).run();
    testDb.prepare('DELETE FROM users WHERE id = 80').run();
    const remaining = testDb.prepare('SELECT COUNT(*) AS n FROM travel_windows WHERE user_id = 80').get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it('161 week_equipment_override (column on training_weeks): CASCADE is already inherited because the column lives on training_weeks itself', () => {
    seedUser(81);
    seedPlan(810, 81);
    testDb.prepare(
      "INSERT INTO training_weeks (id, plan_id, week_number) VALUES (8100, 810, 1)",
    ).run();
    testDb.prepare(
      "UPDATE training_weeks SET equipment_override_json = ? WHERE id = 8100",
    ).run('{"fullGym":false}');
    // Deleting the plan removes the training_weeks row (training_weeks
    // already has a FK to fitness_training_plans). The override
    // column dies with it.
    testDb.prepare('DELETE FROM fitness_training_plans WHERE id = 810').run();
    const remaining = testDb.prepare('SELECT COUNT(*) AS n FROM training_weeks WHERE id = 8100').get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});
