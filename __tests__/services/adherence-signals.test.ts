/**
 * Phase 4 Slice C — Adherence signals tests
 *
 * Three layers:
 *
 *   1. computeWeeklyAdherence — reads the user's active plan + current
 *      week from SQLite and computes the ratio. Covers no-plan, no-
 *      sessions, partial, complete, and multi-plan cases.
 *
 *   2. publishAdherenceSignalsForUser orchestrator — exercises every
 *      branch of the `action` enum (skipped_no_plan, skipped_no_sessions,
 *      skipped_neutral, skipped_existing, published_low, published_high)
 *      and verifies the idempotency gate prevents duplicate rows.
 *
 *   3. Signal formatting — the new TYPE_META entries render the
 *      expected titles / summaries for the iOS signals card.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DateTime } from 'luxon';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

// Wire the same DB into both getDb (used by session-analytics) and
// the intelligence-bus provider (used by training-signals + the
// orchestrator's idempotency check).
vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));
import { setDbProvider } from '../../src/services/intelligence-bus';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

function freshDb(): void {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  applyMigrations(testDb);
  setDbProvider(() => testDb as any);
}

import { computeWeeklyAdherence } from '../../src/services/session-analytics';
import {
  publishAdherenceSignalsForUser,
  publishPlanDriftSignalForUser,
  LOW_ADHERENCE_THRESHOLD,
  HIGH_ADHERENCE_MIN_PLANNED,
  PLAN_DRIFT_SINGLE_PCT,
  PLAN_DRIFT_HYBRID_PCT,
  PLAN_DRIFT_MIN_SESSIONS,
  PLAN_DRIFT_WINDOW_WEEKS,
} from '../../src/services/adherence-signals';
import { buildActiveSignalsResponse } from '../../src/services/signals-observability';

// ─── Fixture helpers ────────────────────────────────────────────

/**
 * Seed an active plan + one week + N sessions with the given status
 * distribution. Returns the plan id so tests can reference it.
 *
 * Plan `start_date` is always 7 days before `referenceDate` so the
 * current reference falls inside week 1 (days 0-6 → week_number 1).
 */
function seedPlanWithWeek(opts: {
  userId: number;
  tenantId?: number;
  sport?: string;
  referenceDate?: DateTime;
  sessionStatuses: string[];
  baseId?: number;
}): number {
  const base = opts.baseId ?? Math.floor(Math.random() * 1_000_000);
  const tenantId = opts.tenantId ?? opts.userId;
  const ref = opts.referenceDate ?? DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
  // Plan starts at the beginning of the current week so week 1 = current week
  const planStart = ref.startOf('week').toISODate()!;
  const planEnd = ref.plus({ weeks: 12 }).toISODate()!;

  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, ?, 'Test plan', ?, 12, ?, ?, 'active')
  `).run(base, opts.userId, tenantId, opts.sport ?? 'hybrid', planStart, planEnd);

  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number, volume_sessions)
    VALUES (?, ?, 1, ?)
  `).run(base, base, opts.sessionStatuses.length);

  for (let i = 0; i < opts.sessionStatuses.length; i++) {
    testDb.prepare(`
      INSERT INTO training_sessions
        (id, week_id, plan_id, day_of_week, session_type, title, status)
      VALUES (?, ?, ?, 'Monday', 'strength', 'Test session', ?)
    `).run(base * 100 + i, base, base, opts.sessionStatuses[i]);
  }

  return base;
}

// ─── Layer 1: computeWeeklyAdherence ────────────────────────────

describe('computeWeeklyAdherence', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('returns hasActivePlan:false when no plan exists', () => {
    const result = computeWeeklyAdherence(100, 100);
    expect(result.hasActivePlan).toBe(false);
    expect(result.planned).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it('computes 100% adherence when every session is completed', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 200,
      referenceDate: ref,
      sessionStatuses: ['completed', 'completed', 'completed', 'completed'],
      baseId: 1,
    });

    const result = computeWeeklyAdherence(200, 200, ref);
    expect(result.hasActivePlan).toBe(true);
    expect(result.planned).toBe(4);
    expect(result.completed).toBe(4);
    expect(result.ratio).toBe(1.0);
    expect(result.percentage).toBe(100);
  });

  it('computes partial adherence when some sessions are completed', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 201,
      referenceDate: ref,
      sessionStatuses: ['completed', 'completed', 'pending', 'pending', 'pending'],
      baseId: 2,
    });

    const result = computeWeeklyAdherence(201, 201, ref);
    expect(result.planned).toBe(5);
    expect(result.completed).toBe(2);
    expect(result.ratio).toBe(0.4);
    expect(result.percentage).toBe(40);
  });

  it('counts explicitly skipped sessions separately', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 202,
      referenceDate: ref,
      sessionStatuses: ['completed', 'skipped', 'skipped', 'pending'],
      baseId: 3,
    });

    const result = computeWeeklyAdherence(202, 202, ref);
    expect(result.planned).toBe(4);
    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.ratio).toBe(0.25);
  });

  it('returns the plan name and sport for observability', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    const base = Math.floor(Math.random() * 1_000_000);
    const planStart = ref.startOf('week').toISODate()!;

    testDb.prepare(`
      INSERT INTO fitness_training_plans
        (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
      VALUES (?, ?, ?, 'Marathon Build', 'running', 12, ?, '2027-01-01', 'active')
    `).run(base, 203, 203, planStart);
    testDb.prepare(`
      INSERT INTO training_weeks (id, plan_id, week_number, volume_sessions)
      VALUES (?, ?, 1, 4)
    `).run(base, base);

    const result = computeWeeklyAdherence(203, 203, ref);
    expect(result.planName).toBe('Marathon Build');
    expect(result.planSport).toBe('running');
  });

  it('keeps users isolated — plans from user A never count for user B', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 300,
      referenceDate: ref,
      sessionStatuses: ['completed', 'completed', 'completed'],
      baseId: 10,
    });
    seedPlanWithWeek({
      userId: 301,
      referenceDate: ref,
      sessionStatuses: ['pending', 'pending', 'pending'],
      baseId: 11,
    });

    const a = computeWeeklyAdherence(300, 300, ref);
    const b = computeWeeklyAdherence(301, 301, ref);

    expect(a.completed).toBe(3);
    expect(b.completed).toBe(0);
  });

  it('keeps same-user adherence isolated by tenant', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 303,
      tenantId: 30,
      referenceDate: ref,
      sessionStatuses: ['completed', 'completed', 'completed'],
      baseId: 30330,
    });
    seedPlanWithWeek({
      userId: 303,
      tenantId: 40,
      referenceDate: ref,
      sessionStatuses: ['pending', 'pending', 'pending'],
      baseId: 30340,
    });

    const tenantA = computeWeeklyAdherence(303, 30, ref);
    const tenantB = computeWeeklyAdherence(303, 40, ref);

    expect(tenantA.completed).toBe(3);
    expect(tenantA.planned).toBe(3);
    expect(tenantB.completed).toBe(0);
    expect(tenantB.planned).toBe(3);
  });
});

// ─── Layer 2: publishAdherenceSignalsForUser orchestrator ──────

describe('publishAdherenceSignalsForUser', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('skipped_no_plan when the user has no active plan', () => {
    const result = publishAdherenceSignalsForUser(1001, 1001);
    expect(result.action).toBe('skipped_no_plan');
  });

  it('skipped_no_sessions when the current week has no planned sessions', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 1002,
      referenceDate: ref,
      sessionStatuses: [],
      baseId: 20,
    });
    const result = publishAdherenceSignalsForUser(1002, 1002, ref);
    expect(result.action).toBe('skipped_no_sessions');
  });

  it('skipped_neutral when adherence is between 60% and 100%', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 1003,
      referenceDate: ref,
      sessionStatuses: ['completed', 'completed', 'completed', 'pending'], // 75%
      baseId: 21,
    });
    const result = publishAdherenceSignalsForUser(1003, 1003, ref);
    expect(result.action).toBe('skipped_neutral');
    expect(result.adherence.ratio).toBe(0.75);
  });

  it('published_low when adherence falls below 60%', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 1004,
      referenceDate: ref,
      sessionStatuses: ['completed', 'pending', 'pending', 'pending', 'pending'], // 20%
      baseId: 22,
    });
    const result = publishAdherenceSignalsForUser(1004, 1004, ref);
    expect(result.action).toBe('published_low');
    expect(result.adherence.ratio).toBeLessThan(LOW_ADHERENCE_THRESHOLD);

    // Verify the signal actually landed on the bus
    const row = testDb.prepare(
      "SELECT signal_type, priority, user_id FROM agent_signals WHERE signal_type = 'low_adherence'"
    ).get() as any;
    expect(row).toBeDefined();
    expect(row.user_id).toBe(1004);
    expect(row.priority).toBe('urgent');
  });

  it('published_high when adherence is 100% AND planned >= HIGH_ADHERENCE_MIN_PLANNED', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    const sessions = Array(HIGH_ADHERENCE_MIN_PLANNED).fill('completed');
    seedPlanWithWeek({
      userId: 1005,
      referenceDate: ref,
      sessionStatuses: sessions,
      baseId: 23,
    });
    const result = publishAdherenceSignalsForUser(1005, 1005, ref);
    expect(result.action).toBe('published_high');

    const row = testDb.prepare(
      "SELECT signal_type, priority FROM agent_signals WHERE signal_type = 'high_adherence'"
    ).get() as any;
    expect(row).toBeDefined();
    expect(row.priority).toBe('normal');
  });

  it('does NOT publish high_adherence when planned < HIGH_ADHERENCE_MIN_PLANNED', () => {
    // 100% of 2 sessions completed — below the 3-session gate
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 1006,
      referenceDate: ref,
      sessionStatuses: ['completed', 'completed'],
      baseId: 24,
    });
    const result = publishAdherenceSignalsForUser(1006, 1006, ref);
    // 100% adherence but only 2 planned → neither threshold fires
    // (not low, not high with the min-planned gate). Result is neutral.
    expect(result.action).toBe('skipped_neutral');
  });

  it('skipped_existing when a matching signal is already on the bus', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 1007,
      referenceDate: ref,
      sessionStatuses: ['completed', 'pending', 'pending', 'pending', 'pending'],
      baseId: 25,
    });

    const first = publishAdherenceSignalsForUser(1007, 1007, ref);
    expect(first.action).toBe('published_low');

    // Second call should detect the existing signal and skip
    const second = publishAdherenceSignalsForUser(1007, 1007, ref);
    expect(second.action).toBe('skipped_existing');

    // Only ONE row on the bus
    const count = testDb.prepare(
      "SELECT COUNT(*) as c FROM agent_signals WHERE signal_type = 'low_adherence' AND user_id = ?"
    ).get(1007) as any;
    expect(count.c).toBe(1);
  });

  it('replaces stale low_adherence when the active plan snapshot changes', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 1010,
      referenceDate: ref,
      sessionStatuses: ['pending', 'pending', 'pending', 'pending', 'pending'],
      baseId: 28,
    });

    testDb.prepare(`
      INSERT INTO agent_signals
        (source_agent, signal_type, payload, priority, expires_at, tenant_id, user_id)
      VALUES
        ('session.analytics', 'low_adherence', ?, 'urgent', datetime('now', '+1 day'), ?, ?)
    `).run(JSON.stringify({
      completed: 0,
      planned: 7,
      adherence_pct: 0,
      week_start: ref.minus({ weeks: 1 }).startOf('week').toISO(),
      week_end: ref.minus({ weeks: 1 }).endOf('week').toISO(),
    }), 1010, 1010);

    const result = publishAdherenceSignalsForUser(1010, 1010, ref);
    expect(result.action).toBe('published_low');
    expect(result.adherence.planned).toBe(5);

    const rows = testDb.prepare(`
      SELECT status, payload
      FROM agent_signals
      WHERE signal_type = 'low_adherence' AND user_id = ?
      ORDER BY id
    `).all(1010) as Array<{ status: string; payload: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('dismissed');
    expect(rows[1].status).toBe('active');
    expect(JSON.parse(rows[1].payload).planned).toBe(5);
  });

  it('dismisses stale adherence signals when the user returns to the neutral band', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 1011,
      referenceDate: ref,
      sessionStatuses: ['completed', 'completed', 'completed', 'pending', 'pending'],
      baseId: 29,
    });

    testDb.prepare(`
      INSERT INTO agent_signals
        (source_agent, signal_type, payload, priority, expires_at, tenant_id, user_id)
      VALUES
        ('session.analytics', 'low_adherence', ?, 'urgent', datetime('now', '+1 day'), ?, ?)
    `).run(JSON.stringify({
      completed: 0,
      planned: 5,
      adherence_pct: 0,
      week_start: ref.startOf('week').toISO(),
      week_end: ref.endOf('week').toISO(),
    }), 1011, 1011);

    const result = publishAdherenceSignalsForUser(1011, 1011, ref);
    expect(result.action).toBe('skipped_neutral');

    const active = testDb.prepare(`
      SELECT COUNT(*) as count
      FROM agent_signals
      WHERE signal_type IN ('low_adherence', 'high_adherence')
        AND user_id = ?
        AND status = 'active'
    `).get(1011) as { count: number };
    expect(active.count).toBe(0);
  });

  it('dismisses stale adherence signals when there is no longer an active plan', () => {
    testDb.prepare(`
      INSERT INTO agent_signals
        (source_agent, signal_type, payload, priority, expires_at, tenant_id, user_id)
      VALUES
        ('session.analytics', 'low_adherence', ?, 'urgent', datetime('now', '+1 day'), ?, ?)
    `).run(JSON.stringify({
      completed: 0,
      planned: 7,
      adherence_pct: 0,
      week_start: '2026-04-06T00:00:00.000+01:00',
      week_end: '2026-04-12T23:59:59.999+01:00',
    }), 1012, 1012);

    const result = publishAdherenceSignalsForUser(1012, 1012);
    expect(result.action).toBe('skipped_no_plan');

    const row = testDb.prepare(`
      SELECT status
      FROM agent_signals
      WHERE signal_type = 'low_adherence' AND user_id = ?
    `).get(1012) as { status: string };
    expect(row.status).toBe('dismissed');
  });

  it('does not cross-poison: user A published does not block user B publishing', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 1008,
      referenceDate: ref,
      sessionStatuses: ['pending', 'pending', 'pending', 'pending', 'pending'],
      baseId: 26,
    });
    seedPlanWithWeek({
      userId: 1009,
      referenceDate: ref,
      sessionStatuses: ['pending', 'pending', 'pending', 'pending', 'pending'],
      baseId: 27,
    });

    const a = publishAdherenceSignalsForUser(1008, 1008, ref);
    const b = publishAdherenceSignalsForUser(1009, 1009, ref);

    expect(a.action).toBe('published_low');
    expect(b.action).toBe('published_low');

    // Two distinct rows, one per user
    const rows = testDb.prepare(
      "SELECT user_id FROM agent_signals WHERE signal_type = 'low_adherence' ORDER BY user_id"
    ).all() as any[];
    expect(rows.map((r) => r.user_id)).toEqual([1008, 1009]);
  });
});

// ─── Layer 3: Signal observability formatting ─────────────────

describe('adherence signals — observability formatting', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('low_adherence surfaces in buildActiveSignalsResponse with a humanized summary', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 2001,
      referenceDate: ref,
      sessionStatuses: ['completed', 'pending', 'pending', 'pending', 'pending'],
      baseId: 40,
    });
    publishAdherenceSignalsForUser(2001, 2001, ref);

    const response = buildActiveSignalsResponse(2001);
    const low = response.signals.find((s) => s.type === 'low_adherence');
    expect(low).toBeDefined();
    expect(low!.title).toBe('Low adherence');
    expect(low!.summary).toMatch(/1\/5 sessions/);
    expect(low!.summary).toMatch(/20%/);
    expect(low!.priority).toBe('urgent');
    expect(response.flags.lowAdherence).toBe(true);
  });

  it('high_adherence surfaces with a "Crushing it" title', () => {
    const ref = DateTime.fromISO('2026-04-08T12:00:00', { zone: 'Europe/Lisbon' });
    seedPlanWithWeek({
      userId: 2002,
      referenceDate: ref,
      sessionStatuses: ['completed', 'completed', 'completed', 'completed'],
      baseId: 41,
    });
    publishAdherenceSignalsForUser(2002, 2002, ref);

    const response = buildActiveSignalsResponse(2002);
    const high = response.signals.find((s) => s.type === 'high_adherence');
    expect(high).toBeDefined();
    expect(high!.title).toBe('Crushing it');
    expect(high!.summary).toMatch(/4\/4 sessions/);
    expect(high!.priority).toBe('normal');
    expect(response.flags.highAdherence).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// Phase 4 Slice G — Plan drift detector
// ════════════════════════════════════════════════════════════════
//
// The drift detector reads recent training_completions (not planned
// sessions) and compares the user's ACTUAL sport distribution to
// their plan's declared sport. It does not take a referenceDate
// parameter — it uses now() internally via session-analytics — so
// the tests seed completions at dates relative to now() rather than
// a hardcoded 2026-04-08. That keeps the suite stable across wall-
// clock drift.

/**
 * Seed a plan + a series of session+completion pairs with the given
 * session_types and `completed_at` timestamps. Each tuple
 * `[daysAgo, sessionType]` produces one row pair. Returns the base
 * plan id so individual tests can reference it.
 */
function seedPlanAndCompletions(opts: {
  userId: number;
  tenantId?: number;
  planSport: string;
  sessions: Array<[number, string]>; // [daysAgo, sessionType]
  baseId?: number;
}): number {
  const base = opts.baseId ?? Math.floor(Math.random() * 1_000_000);
  const tenantId = opts.tenantId ?? opts.userId;
  const ref = DateTime.now();
  const planStart = ref.minus({ weeks: 8 }).toISODate()!;
  const planEnd = ref.plus({ weeks: 12 }).toISODate()!;

  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, ?, 'Drift test plan', ?, 20, ?, ?, 'active')
  `).run(base, opts.userId, tenantId, opts.planSport, planStart, planEnd);

  testDb.prepare(`
    INSERT INTO training_weeks (id, plan_id, week_number)
    VALUES (?, ?, 1)
  `).run(base, base);

  for (let i = 0; i < opts.sessions.length; i++) {
    const [daysAgo, sessionType] = opts.sessions[i];
    const sid = base * 100 + i;
    const completedAt = ref.minus({ days: daysAgo }).toISO()!;

    testDb.prepare(`
      INSERT INTO training_sessions
        (id, week_id, plan_id, day_of_week, session_type, title, status, duration_minutes)
      VALUES (?, ?, ?, 'Monday', ?, 'Drift test session', 'completed', 60)
    `).run(sid, base, base, sessionType);

    testDb.prepare(`
      INSERT INTO training_completions
        (session_id, plan_id, completed_at, duration_minutes)
      VALUES (?, ?, ?, 60)
    `).run(sid, base, completedAt);
  }

  return base;
}

describe('publishPlanDriftSignalForUser', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('skipped_no_plan when the user has no active plan', () => {
    const result = publishPlanDriftSignalForUser(5000, 5000);
    expect(result.action).toBe('skipped_no_plan');
  });

  it('skipped_unknown_sport when the plan sport does not normalize', () => {
    seedPlanAndCompletions({
      userId: 5001,
      planSport: 'breakdancing', // unknown
      sessions: [
        [1, 'running'], [2, 'running'], [3, 'running'], [4, 'running'],
      ],
      baseId: 50,
    });
    const result = publishPlanDriftSignalForUser(5001, 5001);
    expect(result.action).toBe('skipped_unknown_sport');
    expect(result.planSport).toBe('breakdancing');
  });

  it('skipped_not_enough_sessions when fewer than the minimum are logged', () => {
    // Only 3 sessions — below PLAN_DRIFT_MIN_SESSIONS (4)
    seedPlanAndCompletions({
      userId: 5002,
      planSport: 'strength',
      sessions: [
        [1, 'running'], [2, 'running'], [3, 'running'],
      ],
      baseId: 51,
    });
    const result = publishPlanDriftSignalForUser(5002, 5002);
    expect(result.action).toBe('skipped_not_enough_sessions');
    expect(result.sessionsInWindow).toBe(3);
    expect(PLAN_DRIFT_MIN_SESSIONS).toBe(4);
  });

  it('skipped_not_enough_sessions when the only logged sessions are in the "other" bucket', () => {
    // 5 recovery sessions total > MIN_SESSIONS gate (4), but they all
    // land in the "other" bucket and should not count as signal for
    // drift detection. Four stretching sessions don't tell us
    // anything about sport preference.
    seedPlanAndCompletions({
      userId: 5012,
      planSport: 'strength',
      sessions: [
        [1, 'recovery'], [2, 'recovery'], [3, 'recovery'],
        [4, 'recovery'], [5, 'mobility'],
      ],
      baseId: 61,
    });
    const result = publishPlanDriftSignalForUser(5012, 5012);
    expect(result.action).toBe('skipped_not_enough_sessions');
    expect(result.sessionsInWindow).toBe(5);
  });

  it('skipped_not_enough_sessions when active sessions are below minimum even though total passes gate', () => {
    // Total 6 sessions (passes naive 4-session gate), but only 2 are
    // in real sport buckets. The active-session gate should catch
    // this and skip drift.
    seedPlanAndCompletions({
      userId: 5013,
      planSport: 'strength',
      sessions: [
        [1, 'recovery'], [2, 'recovery'], [3, 'recovery'], [4, 'recovery'],
        [5, 'running'], [6, 'running'],
      ],
      baseId: 62,
    });
    const result = publishPlanDriftSignalForUser(5013, 5013);
    expect(result.action).toBe('skipped_not_enough_sessions');
  });

  it('skipped_in_band when the user is following a single-sport plan', () => {
    // Strength plan, 5 gym sessions, 1 run = 83% gym, no drift
    seedPlanAndCompletions({
      userId: 5003,
      planSport: 'strength',
      sessions: [
        [1, 'strength'], [2, 'strength'], [3, 'strength'],
        [4, 'strength'], [5, 'strength'], [6, 'running'],
      ],
      baseId: 52,
    });
    const result = publishPlanDriftSignalForUser(5003, 5003);
    expect(result.action).toBe('skipped_in_band');
    expect(result.dominantSport).toBe('gym');
  });

  it('skipped_in_band when a single-sport plan has balanced drift below threshold', () => {
    // Strength plan: 3 gym + 2 running = gym dominates but running
    // is 40% of sessions — below single-sport 60% threshold
    seedPlanAndCompletions({
      userId: 5004,
      planSport: 'strength',
      sessions: [
        [1, 'strength'], [2, 'strength'], [3, 'strength'],
        [4, 'running'], [5, 'running'],
      ],
      baseId: 53,
    });
    const result = publishPlanDriftSignalForUser(5004, 5004);
    // Dominant is gym (strength), matches plan → skipped_in_band
    expect(result.action).toBe('skipped_in_band');
    expect(result.dominantSport).toBe('gym');
  });

  it('published_drift when a single-sport plan is overrun by a different sport', () => {
    // Strength plan: 1 gym + 5 runs = 83% running → clear drift
    seedPlanAndCompletions({
      userId: 5005,
      planSport: 'strength',
      sessions: [
        [1, 'running'], [2, 'running'], [3, 'running'],
        [4, 'running'], [5, 'running'], [6, 'strength'],
      ],
      baseId: 54,
    });
    const result = publishPlanDriftSignalForUser(5005, 5005);
    expect(result.action).toBe('published_drift');
    expect(result.dominantSport).toBe('running');
    expect(result.planSport).toBe('strength');
    expect(result.driftPct).toBeGreaterThanOrEqual(PLAN_DRIFT_SINGLE_PCT * 100);

    // Verify the signal landed on the bus
    const row = testDb.prepare(
      "SELECT signal_type, priority, user_id, payload FROM agent_signals WHERE signal_type = 'plan_drift'"
    ).get() as any;
    expect(row).toBeDefined();
    expect(row.user_id).toBe(5005);
    expect(row.priority).toBe('normal');
    const payload = JSON.parse(row.payload);
    expect(payload.plan_sport).toBe('strength');
    expect(payload.dominant_sport).toBe('running');
    expect(payload.window_weeks).toBe(PLAN_DRIFT_WINDOW_WEEKS);
  });

  it('skipped_in_band for hybrid plans with balanced distribution', () => {
    // Hybrid plan: 3 gym + 3 running = 50/50 balance, no drift
    seedPlanAndCompletions({
      userId: 5006,
      planSport: 'hybrid',
      sessions: [
        [1, 'strength'], [2, 'strength'], [3, 'strength'],
        [4, 'running'], [5, 'running'], [6, 'running'],
      ],
      baseId: 55,
    });
    const result = publishPlanDriftSignalForUser(5006, 5006);
    expect(result.action).toBe('skipped_in_band');
  });

  it('published_drift for hybrid plans when one sport dominates above 80%', () => {
    // Hybrid plan: 1 gym + 9 running = 90% running → drift
    seedPlanAndCompletions({
      userId: 5007,
      planSport: 'hybrid',
      sessions: [
        [1, 'running'], [2, 'running'], [3, 'running'],
        [4, 'running'], [5, 'running'], [6, 'running'],
        [7, 'running'], [8, 'running'], [9, 'running'],
        [10, 'strength'],
      ],
      baseId: 56,
    });
    const result = publishPlanDriftSignalForUser(5007, 5007);
    expect(result.action).toBe('published_drift');
    expect(result.dominantSport).toBe('running');
    expect(result.planSport).toBe('hybrid');
    expect(result.driftPct).toBeGreaterThanOrEqual(PLAN_DRIFT_HYBRID_PCT * 100);
  });

  it('skipped_existing is idempotent on a second call', () => {
    seedPlanAndCompletions({
      userId: 5008,
      planSport: 'strength',
      sessions: [
        [1, 'running'], [2, 'running'], [3, 'running'],
        [4, 'running'], [5, 'running'],
      ],
      baseId: 57,
    });
    const first = publishPlanDriftSignalForUser(5008, 5008);
    expect(first.action).toBe('published_drift');

    const second = publishPlanDriftSignalForUser(5008, 5008);
    expect(second.action).toBe('skipped_existing');

    // Only one row on the bus
    const rows = testDb.prepare(
      "SELECT COUNT(*) as count FROM agent_signals WHERE signal_type = 'plan_drift' AND user_id = 5008"
    ).get() as any;
    expect(rows.count).toBe(1);
  });

  it('keeps users isolated — drift for user A does not affect user B', () => {
    seedPlanAndCompletions({
      userId: 5009,
      planSport: 'strength',
      sessions: [
        [1, 'running'], [2, 'running'], [3, 'running'],
        [4, 'running'], [5, 'running'],
      ],
      baseId: 58,
    });
    seedPlanAndCompletions({
      userId: 5010,
      planSport: 'strength',
      sessions: [
        [1, 'strength'], [2, 'strength'], [3, 'strength'],
        [4, 'strength'], [5, 'strength'],
      ],
      baseId: 59,
    });

    const a = publishPlanDriftSignalForUser(5009, 5009);
    const b = publishPlanDriftSignalForUser(5010, 5010);

    expect(a.action).toBe('published_drift');
    expect(b.action).toBe('skipped_in_band');
  });

  it('ignores the "other" sport bucket when picking the dominant sport', () => {
    // Strength plan: 3 recovery sessions + 5 running sessions
    // "other" should not be counted as dominant even though it has
    // non-trivial count. The filter in the detector should pick
    // running as dominant.
    seedPlanAndCompletions({
      userId: 5011,
      planSport: 'strength',
      sessions: [
        [1, 'recovery'], [2, 'recovery'], [3, 'recovery'],
        [4, 'running'], [5, 'running'], [6, 'running'],
        [7, 'running'], [8, 'running'],
      ],
      baseId: 60,
    });
    const result = publishPlanDriftSignalForUser(5011, 5011);
    expect(result.dominantSport).toBe('running');
    expect(result.action).toBe('published_drift');
  });
});

// ─── Layer 4: signal formatting for plan drift ──────────────────

describe('signal formatting — plan_drift', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('plan_drift surfaces with a "Plan drift" title and descriptive summary', () => {
    seedPlanAndCompletions({
      userId: 6001,
      planSport: 'strength',
      sessions: [
        [1, 'running'], [2, 'running'], [3, 'running'],
        [4, 'running'], [5, 'running'],
      ],
      baseId: 70,
    });
    publishPlanDriftSignalForUser(6001, 6001);

    const response = buildActiveSignalsResponse(6001);
    const drift = response.signals.find((s) => s.type === 'plan_drift');
    expect(drift).toBeDefined();
    expect(drift!.title).toBe('Plan drift');
    expect(drift!.summary).toMatch(/running/);
    expect(drift!.summary).toMatch(/strength/);
    expect(drift!.priority).toBe('normal');
    expect(response.flags.planDrift).toBe(true);
  });
});
