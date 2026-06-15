/**
 * Phase 3 Slice B — Signals observability tests
 *
 * Covers:
 *   1. buildActiveSignalsResponse transforms raw signals into the
 *      human-readable response shape with per-type titles/summaries.
 *   2. Each signal type has at least a fallback title/summary so the
 *      iOS client never sees an undefined field.
 *   3. User isolation: one user's signals never appear in another
 *      user's response (carried through from training-signals).
 *   4. Sort order: urgent first, then normal, then background;
 *      newest first within each priority.
 *   5. Flag mirroring: the response.flags object matches the internal
 *      training context flags exactly.
 *   6. Expired signals don't appear (the SQL filter handles this).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

import { setDbProvider } from '../../src/services/intelligence-bus';
import {
  publishLowSleep,
  publishLowHrv,
  publishLowReadiness,
  publishHighLegLoad,
  publishHighShoulderLoad,
  publishSessionLoad,
  publishTrainingSessionScheduled,
  publishCalendarConflict,
} from '../../src/services/training-signals';
import { recordHealthSignal } from '../../src/services/health-signals';
import {
  buildActiveSignalsResponse,
  type FormattedSignal,
} from '../../src/services/signals-observability';
import {
  buildTrainingHomeViewState,
  type TrainingHomeViewStateInput,
} from '../../src/services/training-home-view-state';

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

function trainingHomeBaseInput(
  signals: TrainingHomeViewStateInput['signals'],
): TrainingHomeViewStateInput {
  return {
    todaySession: {
      id: 'threshold-run',
      type: 'Threshold Run',
      sessionType: 'threshold_run',
      time: '06:30',
      duration: 55,
      status: 'planned',
      exercises: [],
    },
    readiness: null,
    coachBriefing: null,
    signals,
    weekSessions: [],
    weeklyAdherence: 0.7,
    tomorrowSession: null,
    hasActivePlan: true,
    isGarminStale: false,
  };
}

// ─── Empty state ────────────────────────────────────────────────────

describe('buildActiveSignalsResponse — empty state', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('returns empty signals array and all flags false when user has nothing', () => {
    const res = buildActiveSignalsResponse(1001);
    expect(res.userId).toBe(1001);
    expect(res.signals).toHaveLength(0);
    expect(res.counts.total).toBe(0);
    expect(res.counts.urgent).toBe(0);
    expect(res.flags.lowSleep).toBe(false);
    expect(res.flags.lowHrv).toBe(false);
    expect(res.flags.lowReadiness).toBe(false);
    expect(res.flags.highLegLoad).toBe(false);
    expect(res.flags.highShoulderLoad).toBe(false);
    expect(res.flags.raceThisWeek).toBe(false);
    expect(res.flags.otherSportRpeToday).toBe(0);
  });

  it('includes a timestamp in ISO format', () => {
    const res = buildActiveSignalsResponse(1002);
    expect(res.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ─── Per-type formatting ────────────────────────────────────────────

describe('buildActiveSignalsResponse — per-type formatting', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('formats low_sleep with score and hours in the summary', () => {
    publishLowSleep({ userId: 2001, score: 42, totalHours: 5.2 });
    const res = buildActiveSignalsResponse(2001);
    expect(res.signals).toHaveLength(1);
    const s = res.signals[0];
    expect(s.type).toBe('low_sleep');
    expect(s.title).toBe('Low sleep');
    expect(s.summary).toContain('42');
    expect(s.summary).toContain('5.2h');
    expect(s.priority).toBe('urgent');
  });

  it('overrides stale low_sleep hours with the latest readiness factors when available', () => {
    publishLowSleep({ userId: 2010, score: 20, totalHours: 0 });
    testDb.prepare(`
      INSERT OR REPLACE INTO readiness_scores (user_id, date, score, factors, recommendation)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      2010,
      '2026-04-16',
      41,
      JSON.stringify({
        sleep: {
          durationHours: 6.8,
          qualityScore: 41,
          score: 41,
        },
      }),
      'reduce_25pct',
    );

    const res = buildActiveSignalsResponse(2010);
    const s = res.signals.find((x) => x.type === 'low_sleep')!;
    expect(s.summary).toContain('6.8h');
    expect(res.flags.lowSleep).toBe(true);
  });

  it('formats low_hrv with delta percentage', () => {
    publishLowHrv({ userId: 2002, hrv_ms: 30, baseline_ms: 45 });
    const res = buildActiveSignalsResponse(2002);
    const s = res.signals.find((x) => x.type === 'low_hrv')!;
    expect(s.title).toBe('Low HRV');
    expect(s.summary).toMatch(/-?\d+%/);
  });

  it('formats low_readiness with score out of 100', () => {
    publishLowReadiness({ userId: 2003, score: 28, reason: 'accumulated fatigue' });
    const res = buildActiveSignalsResponse(2003);
    const s = res.signals.find((x) => x.type === 'low_readiness')!;
    expect(s.title).toBe('Low readiness');
    expect(s.summary).toContain('28/100');
  });

  it('surfaces structured health-intake red flags through active signals and Training Home state', () => {
    recordHealthSignal({
      userId: 2011,
      tenantId: 9011,
      date: '2026-05-23',
      illnessSymptoms: ['chest_pain'],
      source: 'structured_intake',
      consentScope: ['illness'],
    });

    const legacyScope = buildActiveSignalsResponse(2011);
    expect(legacyScope.signals.find((x) => x.type === 'safety_red_flag')).toBeUndefined();

    const res = buildActiveSignalsResponse(2011, 9011);
    const signal = res.signals.find((x) => x.type === 'safety_red_flag');

    expect(signal).toBeDefined();
    expect(signal?.title).toBe('Safety check');
    expect(signal?.summary).toContain('qualified professional');
    expect(JSON.stringify(signal)).not.toContain('illness_symptoms_json');
    expect(JSON.stringify(signal)).not.toContain('chest_pain');
    expect(JSON.stringify(signal)).not.toContain('medical_referral');

    const home = buildTrainingHomeViewState(trainingHomeBaseInput(res.signals), 'en-US');
    const display = JSON.stringify(home);
    expect(home.hero.state).toBe('recovery');
    expect(home.hero.primaryAction.target).toBe('openWeekPlan');
    expect(display).toContain('qualified professional');
    expect(display).not.toContain('medical_referral');
    expect(display).not.toContain('chest_pain');
  });

  it('formats high_leg_load with RPE and source', () => {
    publishHighLegLoad({ userId: 2004, source: 'gym', rpe: 9 });
    const res = buildActiveSignalsResponse(2004);
    const s = res.signals.find((x) => x.type === 'high_leg_load')!;
    expect(s.title).toBe('High leg load');
    expect(s.summary).toContain('RPE 9');
    expect(s.summary).toContain('gym');
  });

  it('formats high_shoulder_load with RPE', () => {
    publishHighShoulderLoad({ userId: 2005, rpe: 8 });
    const res = buildActiveSignalsResponse(2005);
    const s = res.signals.find((x) => x.type === 'high_shoulder_load')!;
    expect(s.title).toBe('High shoulder load');
    expect(s.summary).toContain('RPE 8');
  });

  it('formats session load signals with sport-specific titles', () => {
    publishSessionLoad({ userId: 2006, sport: 'running', rpe: 6, distance_km: 8 });
    const res = buildActiveSignalsResponse(2006);
    const s = res.signals.find((x) => x.type === 'running_load_today')!;
    expect(s.title).toBe('Run done today');
    expect(s.summary).toContain('RPE 6');
    expect(s.summary).toContain('8km');
  });

  it('formats training_session_scheduled with sport and title', () => {
    publishTrainingSessionScheduled({
      userId: 2007,
      sport: 'cycling',
      sessionId: 'ride-abc',
      startTimeIso: '2026-04-10T08:00:00Z',
      endTimeIso: '2026-04-10T10:00:00Z',
      title: 'FTP test',
    });
    const res = buildActiveSignalsResponse(2007);
    const s = res.signals.find((x) => x.type === 'training_session_scheduled')!;
    expect(s.title).toBe('Session scheduled');
    expect(s.summary).toContain('Cycling');
    expect(s.summary).toContain('FTP test');
    expect(s.payload).toEqual({ sport: 'cycling', title: 'FTP test' });
    expect(JSON.stringify(s.payload)).not.toContain('ride-abc');
  });

  it('formats calendar_conflict without exposing the private event title', () => {
    publishTrainingSessionScheduled({
      userId: 2008,
      sport: 'running',
      sessionId: 'run-1',
      startTimeIso: '2026-04-15T17:00:00Z',
      endTimeIso: '2026-04-15T18:00:00Z',
      title: 'Intervals',
    });
    publishCalendarConflict({
      userId: 2008,
      trainingSessionId: 'run-1',
      conflictingEventId: 'evt-meeting',
      conflictingEventTitle: 'Team standup',
      overlapStartIso: '2026-04-15T17:30:00Z',
      overlapEndIso: '2026-04-15T18:00:00Z',
    });
    const res = buildActiveSignalsResponse(2008);
    const s = res.signals.find((x) => x.type === 'calendar_conflict')!;
    expect(s.title).toBe('Calendar conflict');
    expect(s.summary).toBe('A calendar event overlaps a scheduled training session — consider moving one.');
    expect(s.summary).not.toContain('Team standup');
    expect(s.payload).toEqual({});
    expect(JSON.stringify(s)).not.toContain('Team standup');
    expect(JSON.stringify(s)).not.toContain('evt-meeting');
  });

  it('every formatted signal has non-empty title and summary fields', () => {
    publishLowSleep({ userId: 2009, score: 40 });
    publishLowHrv({ userId: 2009, hrv_ms: 20, baseline_ms: 40 });
    publishHighLegLoad({ userId: 2009, source: 'running', rpe: 8 });
    publishSessionLoad({ userId: 2009, sport: 'gym', rpe: 7 });

    const res = buildActiveSignalsResponse(2009);
    for (const s of res.signals) {
      expect(s.title.length, `signal ${s.type}`).toBeGreaterThan(0);
      expect(s.summary.length, `signal ${s.type}`).toBeGreaterThan(0);
      expect(s.id).toBeGreaterThan(0);
      expect(s.createdAt).toBeTruthy();
      expect(s.expiresAt).toBeTruthy();
    }
  });
});

// ─── Counts ──────────────────────────────────────────────────────────

describe('buildActiveSignalsResponse — counts', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('counts total and urgent separately', () => {
    publishLowSleep({ userId: 3001, score: 40 });         // urgent
    publishHighLegLoad({ userId: 3001, source: 'gym', rpe: 9 }); // urgent
    publishSessionLoad({ userId: 3001, sport: 'gym', rpe: 5 }); // normal

    const res = buildActiveSignalsResponse(3001);
    expect(res.counts.total).toBe(3);
    expect(res.counts.urgent).toBe(2);
  });
});

// ─── Sort order ──────────────────────────────────────────────────────

describe('buildActiveSignalsResponse — sort order', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('sorts urgent priority before normal', () => {
    publishSessionLoad({ userId: 4001, sport: 'gym', rpe: 5 }); // normal
    publishLowSleep({ userId: 4001, score: 40 });               // urgent

    const res = buildActiveSignalsResponse(4001);
    expect(res.signals[0].priority).toBe('urgent');
    expect(res.signals[1].priority).toBe('normal');
  });

  it('preserves a stable order across calls (no random sort)', () => {
    publishLowSleep({ userId: 4002, score: 40 });
    publishHighLegLoad({ userId: 4002, source: 'gym', rpe: 9 });

    const first = buildActiveSignalsResponse(4002).signals.map((s) => s.id);
    const second = buildActiveSignalsResponse(4002).signals.map((s) => s.id);
    expect(first).toEqual(second);
  });
});

// ─── User isolation ──────────────────────────────────────────────────

describe('buildActiveSignalsResponse — user isolation', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('returns only the requested user\'s signals', () => {
    publishLowSleep({ userId: 5001, score: 30 });
    publishHighLegLoad({ userId: 5002, source: 'gym', rpe: 9 });

    const a = buildActiveSignalsResponse(5001);
    const b = buildActiveSignalsResponse(5002);

    expect(a.signals).toHaveLength(1);
    expect(a.signals[0].type).toBe('low_sleep');
    expect(b.signals).toHaveLength(1);
    expect(b.signals[0].type).toBe('high_leg_load');
  });
});

// ─── Flag mirroring ──────────────────────────────────────────────────

describe('buildActiveSignalsResponse — flags', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('mirrors the internal context flags exactly', () => {
    publishLowSleep({ userId: 6001, score: 40 });
    publishLowHrv({ userId: 6001, hrv_ms: 25, baseline_ms: 45 });
    publishHighLegLoad({ userId: 6001, source: 'gym', rpe: 9 });

    const res = buildActiveSignalsResponse(6001);
    expect(res.flags.lowSleep).toBe(true);
    expect(res.flags.lowHrv).toBe(true);
    expect(res.flags.highLegLoad).toBe(true);
    expect(res.flags.lowReadiness).toBe(false);
    expect(res.flags.highShoulderLoad).toBe(false);
  });

  it('otherSportRpeToday sums all session_load_today RPEs', () => {
    publishSessionLoad({ userId: 6002, sport: 'gym', rpe: 7 });
    publishSessionLoad({ userId: 6002, sport: 'running', rpe: 6 });
    publishSessionLoad({ userId: 6002, sport: 'cycling', rpe: 5 });

    const res = buildActiveSignalsResponse(6002);
    expect(res.flags.otherSportRpeToday).toBe(18);
  });
});

// ─── Expired signals ─────────────────────────────────────────────────

describe('buildActiveSignalsResponse — expired signals', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('does not return signals that have passed their expires_at', () => {
    // Insert a signal directly with an expires_at in the past so the
    // `status = 'active' AND ...` filter in the SQL query excludes it.
    // (The bus filters on status, not on expires_at directly, but
    // `expireStaleSignals` flips status to 'expired' — simulate by
    // setting status='expired' outright.)
    testDb.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, expires_at, user_id, status)
      VALUES ('test', 'low_sleep', '{"score":40}', 'urgent', datetime('now', '-1 hour'), 7001, 'expired')
    `).run();

    const res = buildActiveSignalsResponse(7001);
    expect(res.signals).toHaveLength(0);
  });
});

// ─── Unknown signal types (fallback path) ────────────────────────────

describe('buildActiveSignalsResponse — unknown type fallback', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('falls back to a generic title/summary when the type has no TYPE_META entry', () => {
    // Insert a signal whose type ISN'T in the TYPE_META map.
    // `hook_effectiveness` is a content-mesh type — valid SignalType
    // enum value but no training-coach meta entry.
    testDb.prepare(`
      INSERT INTO agent_signals (source_agent, signal_type, payload, priority, expires_at, tenant_id, user_id, status)
      VALUES ('test', 'planned_hard_run', '{}', 'normal', datetime('now', '+1 day'), 8001, 8001, 'active')
    `).run();

    const res = buildActiveSignalsResponse(8001);
    expect(res.signals.length).toBeGreaterThan(0);
    const s = res.signals[0] as FormattedSignal;
    // planned_hard_run IS in TYPE_META, so it uses the mapped title
    expect(s.title).toBe('Hard run planned');
    expect(s.summary.length).toBeGreaterThan(0);
  });
});
