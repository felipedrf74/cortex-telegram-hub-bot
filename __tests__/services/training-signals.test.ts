/**
 * Training Signals Service — Phase 1 Slice B tests
 *
 * Covers:
 *  - Migration 046 adds user_id column + index
 *  - writeSignal with user_id isolates per-user signals
 *  - readSignals with userId returns global + that user's signals only
 *  - publishHighLegLoad threshold (RPE < 8 is a no-op)
 *  - Signal A e2e: gym publish → running reader sees it
 *  - Signal B e2e: wellness publish → all 4 sport coaches see it
 *  - User isolation: user A's signals never leak to user B
 *  - Consumer deduplication: once marked consumed, signal stops appearing
 *  - formatTrainingContextForPrompt renders scan-friendly block
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { withDatabaseForTest } from '../../src/services/database';

let testDb: Database.Database;

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

// intelligence-bus uses a lazy DB provider (setDbProvider) instead of
// importing the database module, so we wire it explicitly in beforeEach.
import {
  setDbProvider,
  readSignals as busReadSignals,
  writeSignal,
} from '../../src/services/intelligence-bus';

import {
  publishSessionLoad,
  publishHighLegLoad,
  publishHighShoulderLoad,
  publishLowSleep,
  publishLowHrv,
  publishLowReadiness,
  publishFuelingGapRisk,
  publishTrainingBudgetConstraint,
  readTrainingContext as readTrainingContextScoped,
  readTrainingContextAll,
  consumeSignal,
  formatTrainingContextForPrompt,
  TRAINING_SOURCE,
} from '../../src/services/training-signals';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  getContentWorkspaceItem,
  transitionContentWorkspaceItem,
} from '../../src/services/content-workspace';
import {
  cancelContentSchedule,
  confirmContentSchedulePreview,
  createContentSchedulePreview,
} from '../../src/services/content-workspace-scheduling';

function resetTrainingOperationalEnvForTests(): void {
  delete process.env.TRAINING_ENGINE_ENABLED;
  delete process.env.TRAINING_ENGINE_DISABLED;
  delete process.env.TRAINING_CROSS_SKILL_SIGNALS_ENABLED;
  delete process.env.TRAINING_CROSS_SKILL_SIGNALS_DISABLED;
}

beforeEach(() => {
  resetTrainingOperationalEnvForTests();
});

function freshDb(): void {
  testDb = createMigratedTestDatabase();
  setDbProvider(() => testDb as any);
}

function readTrainingContext(
  opts: Omit<Parameters<typeof readTrainingContextScoped>[0], 'tenantId'> & { tenantId?: number },
) {
  return readTrainingContextScoped({ ...opts, tenantId: opts.tenantId ?? opts.userId });
}

// ─── Migration 046 shape ────────────────────────────────────────────

describe('migration 046: agent_signals.user_id column', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('agent_signals has user_id column', () => {
    const cols = testDb.prepare('PRAGMA table_info(agent_signals)').all() as any[];
    const userIdCol = cols.find(c => c.name === 'user_id');
    expect(userIdCol).toBeDefined();
    expect(userIdCol.notnull).toBe(0); // nullable — global signals have NULL
  });

  it('idx_signals_user_type partial index exists', () => {
    const idx = testDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_signals_user_type'").get();
    expect(idx).toBeDefined();
  });
});

// ─── writeSignal / readSignals user_id isolation ────────────────────

describe('per-user signal isolation', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('publishSessionLoad writes with user_id', () => {
    const id = publishSessionLoad({ userId: 101, sport: 'running', rpe: 7, distance_km: 10 });
    expect(id).toBeGreaterThan(0);
    const row = testDb.prepare('SELECT user_id, signal_type FROM agent_signals WHERE id = ?').get(id) as any;
    expect(row.user_id).toBe(101);
    expect(row.signal_type).toBe('running_load_today');
  });

  it('publishSessionLoad honors the cross-skill signal kill switch', () => {
    process.env.TRAINING_CROSS_SKILL_SIGNALS_ENABLED = 'false';

    const id = publishSessionLoad({ userId: 101, sport: 'running', rpe: 7, distance_km: 10 });

    expect(id).toBe(-1);
    const count = testDb.prepare('SELECT COUNT(*) AS count FROM agent_signals').get() as { count: number };
    expect(count.count).toBe(0);
  });

  it('user A signals do not leak to user B', () => {
    publishSessionLoad({ userId: 201, sport: 'gym', rpe: 9 });
    publishSessionLoad({ userId: 202, sport: 'gym', rpe: 4 });

    const ctxA = readTrainingContext({ userId: 201, sport: 'running' });
    const ctxB = readTrainingContext({ userId: 202, sport: 'running' });

    const aLoads = ctxA.signals.filter(s => s.signal_type === 'gym_load_today');
    const bLoads = ctxB.signals.filter(s => s.signal_type === 'gym_load_today');
    expect(aLoads).toHaveLength(1);
    expect(bLoads).toHaveLength(1);
    expect(aLoads[0].payload.rpe).toBe(9);
    expect(bLoads[0].payload.rpe).toBe(4);
  });

  it('reader without user filter returns only global signals', () => {
    publishSessionLoad({ userId: 301, sport: 'cycling', rpe: 8 });
    // Direct bus read with no userId should NOT see this user's signal
    // (the `user_id IS NULL` branch excludes per-user rows).
    const result = busReadSignals('test.consumer', ['cycling_load_today'], 50);
    expect(result).toHaveLength(0);
  });

  it('readTrainingContextAll honors optional tenant scope', () => {
    publishHighLegLoad({ userId: 306, tenantId: 901, source: 'gym', rpe: 9 });
    publishHighLegLoad({ userId: 306, tenantId: 902, source: 'gym', rpe: 9, details: { notes: 'tenant b' } });

    const tenantA = readTrainingContextAll({ userId: 306, tenantId: 901 });
    const tenantB = readTrainingContextAll({ userId: 306, tenantId: 902 });

    expect(tenantA.flags.highLegLoad).toBe(true);
    expect(tenantA.signals).toHaveLength(1);
    expect(tenantA.signals[0].tenant_id).toBe(901);
    expect(tenantB.flags.highLegLoad).toBe(true);
    expect(tenantB.signals).toHaveLength(1);
    expect(tenantB.signals[0].tenant_id).toBe(902);

    const sportTenantA = readTrainingContext({ userId: 306, tenantId: 901, sport: 'running' });
    const sportTenantB = readTrainingContext({ userId: 306, tenantId: 902, sport: 'running' });
    expect(sportTenantA.signals).toHaveLength(1);
    expect(sportTenantA.signals[0].tenant_id).toBe(901);
    expect(sportTenantB.signals).toHaveLength(1);
    expect(sportTenantB.signals[0].tenant_id).toBe(902);
  });
});

// ─── Signal A: high_leg_load (RPE threshold) ────────────────────────

describe('signal A — high_leg_load threshold and flow', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('does NOT publish when RPE < 8', () => {
    const id = publishHighLegLoad({ userId: 401, source: 'gym', rpe: 7 });
    expect(id).toBe(-1);
  });

  it('publishes with urgent priority at RPE >= 8', () => {
    const id = publishHighLegLoad({ userId: 402, source: 'gym', rpe: 9, details: { lifts: ['squat', 'deadlift'] } });
    expect(id).toBeGreaterThan(0);
    const row = testDb.prepare('SELECT priority, payload, user_id FROM agent_signals WHERE id = ?').get(id) as any;
    expect(row.priority).toBe('urgent');
    expect(row.user_id).toBe(402);
    const payload = JSON.parse(row.payload);
    expect(payload.lifts).toEqual(['squat', 'deadlift']);
  });

  it('running coach reads high_leg_load flag from gym', () => {
    publishHighLegLoad({ userId: 403, source: 'gym', rpe: 9 });
    const ctx = readTrainingContext({ userId: 403, sport: 'running' });
    expect(ctx.flags.highLegLoad).toBe(true);
    expect(ctx.signals.some(s => s.signal_type === 'high_leg_load')).toBe(true);
  });

  it('cycle coach also reads high_leg_load', () => {
    publishHighLegLoad({ userId: 404, source: 'running', rpe: 8 });
    const ctx = readTrainingContext({ userId: 404, sport: 'cycling' });
    expect(ctx.flags.highLegLoad).toBe(true);
  });

  it('swim coach does NOT subscribe to high_leg_load', () => {
    publishHighLegLoad({ userId: 405, source: 'gym', rpe: 9 });
    const ctx = readTrainingContext({ userId: 405, sport: 'swim' });
    expect(ctx.flags.highLegLoad).toBe(false);
    expect(ctx.signals.some(s => s.signal_type === 'high_leg_load')).toBe(false);
  });
});

// ─── Signal B: wellness signals reach all sport coaches ─────────────

describe('signal B — wellness signals fan out to all sports', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('low_sleep is visible to all 4 sport coaches', () => {
    publishLowSleep({ userId: 501, tenantId: 501, score: 45, totalHours: 5.2 });

    for (const sport of ['gym', 'running', 'cycling', 'swim'] as const) {
      const ctx = readTrainingContext({ userId: 501, sport });
      expect(ctx.flags.lowSleep, `${sport} should see low_sleep`).toBe(true);
    }
  });

  it('low_hrv is visible to all 4 sport coaches', () => {
    publishLowHrv({ userId: 502, tenantId: 502, hrv_ms: 28, baseline_ms: 45 });
    for (const sport of ['gym', 'running', 'cycling', 'swim'] as const) {
      const ctx = readTrainingContext({ userId: 502, sport });
      expect(ctx.flags.lowHrv).toBe(true);
    }
  });

  it('low_readiness propagates to all sports', () => {
    const signalId = publishLowReadiness({
      userId: 503,
      tenantId: 503,
      score: 25,
      reason: 'accumulated fatigue',
    });
    for (const sport of ['gym', 'running', 'cycling', 'swim'] as const) {
      const ctx = readTrainingContext({ userId: 503, sport });
      expect(ctx.flags.lowReadiness).toBe(true);
    }

    const row = testDb.prepare(`
      SELECT tenant_id, priority, payload
        FROM agent_signals
       WHERE id = ?
    `).get(signalId) as { tenant_id: number; priority: string; payload: string };
    expect(row.tenant_id).toBe(503);
    expect(row.priority).toBe('urgent');
    expect(JSON.parse(row.payload)).toMatchObject({ score: 25, reason: 'accumulated fatigue' });

    expect(() => publishLowReadiness({
      userId: 503,
      tenantId: 0,
      score: 25,
    })).toThrow('publishLowReadiness requires a validated tenantId');
  });

  it('high_shoulder_load only reaches gym and swim', () => {
    publishHighShoulderLoad({ userId: 504, rpe: 9, details: { lifts: ['ohp'] } });
    expect(readTrainingContext({ userId: 504, sport: 'swim' }).flags.highShoulderLoad).toBe(true);
    // Gym coach does NOT read its own high_shoulder_load (it's the producer),
    // but running/cycling shouldn't see it either.
    expect(readTrainingContext({ userId: 504, sport: 'running' }).flags.highShoulderLoad).toBe(false);
    expect(readTrainingContext({ userId: 504, sport: 'cycling' }).flags.highShoulderLoad).toBe(false);
  });

  it('keeps wellness safety signals inside the authenticated tenant when tenant and user differ', () => {
    publishLowSleep({ userId: 510, tenantId: 9_101, score: 38, totalHours: 4.8 });
    publishLowHrv({ userId: 510, tenantId: 9_101, hrv_ms: 24, baseline_ms: 46 });
    publishLowReadiness({ userId: 510, tenantId: 9_102, score: 22, reason: 'tenant-b fatigue' });

    const tenantA = readTrainingContext({ userId: 510, tenantId: 9_101, sport: 'running' });
    const tenantB = readTrainingContext({ userId: 510, tenantId: 9_102, sport: 'running' });

    expect(tenantA.flags).toMatchObject({ lowSleep: true, lowHrv: true, lowReadiness: false });
    expect(tenantB.flags).toMatchObject({ lowSleep: false, lowHrv: false, lowReadiness: true });
  });
});

// ─── Canonical cross-skill consumers ────────────────────────────────

describe('canonical cross-skill consumers', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('cooking fueling gap risk is consumed as one deduped Training input', () => {
    publishFuelingGapRisk({
      userId: 605,
      hardDatesMissingMeals: ['2026-04-17'],
      trainingDatesMissingMeals: ['2026-04-17', '2026-04-18'],
      status: 'at_risk',
    });
    const ctx = readTrainingContext({ userId: 605, sport: 'running' });

    expect(ctx.flags.fuelingGap).toBe(true);
    const block = formatTrainingContextForPrompt(ctx, 'running');
    expect(block).toContain('FUELING GAP');
    expect(block).toContain('2026-04-17');
    expect(block).toContain('do not repeat generic fueling warnings');
    expect(block.match(/FUELING GAP/g)).toHaveLength(1);
  });

  it('finance budget constraints steer Training away from paid gear/subscription asks', () => {
    publishTrainingBudgetConstraint({
      userId: 606,
      month: '2026-04',
      budgetMode: 'tight',
      trainingSpendMode: 'minimum_effective_dose',
      supplementMode: 'pause',
      remainingRatio: 0.06,
    });
    const ctx = readTrainingContext({ userId: 606, sport: 'gym' });

    expect(ctx.flags.budgetConstraint).toBe(true);
    const block = formatTrainingContextForPrompt(ctx, 'gym');
    expect(block).toContain('FINANCE CONSTRAINT');
    expect(block).toContain('minimum_effective_dose');
    expect(block).toContain('Avoid paid gear');
  });
});

// ─── Consumer marking ───────────────────────────────────────────────

describe('consumer deduplication', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('consumed signals stop appearing to that consumer', () => {
    const id = publishHighLegLoad({ userId: 700, source: 'gym', rpe: 9 });
    expect(id).toBeGreaterThan(0);

    // First read — running coach sees it
    const ctx1 = readTrainingContext({ userId: 700, sport: 'running' });
    expect(ctx1.flags.highLegLoad).toBe(true);

    // Mark as consumed
    consumeSignal(id, 'triathlon.running');

    // Second read — running coach does NOT see it
    const ctx2 = readTrainingContext({ userId: 700, sport: 'running' });
    expect(ctx2.flags.highLegLoad).toBe(false);

    // But cycle coach (different consumer) still sees it
    const ctxCycle = readTrainingContext({ userId: 700, sport: 'cycling' });
    expect(ctxCycle.flags.highLegLoad).toBe(true);
  });
});

// ─── otherSportRpeToday aggregation ─────────────────────────────────

describe('otherSportRpeToday aggregation', () => {
  beforeEach(() => freshDb());
  afterEach(() => testDb?.close());

  it('sums RPE from sibling sports for a coach', () => {
    publishSessionLoad({ userId: 800, sport: 'gym', rpe: 7 });
    publishSessionLoad({ userId: 800, sport: 'cycling', rpe: 6 });
    // Running coach reads its inputs — gym_load_today + cycling_load_today
    const ctx = readTrainingContext({ userId: 800, sport: 'running' });
    expect(ctx.flags.otherSportRpeToday).toBe(13);
  });
});

// ─── Prompt formatter ───────────────────────────────────────────────

describe('formatTrainingContextForPrompt', () => {
  beforeEach(() => freshDb());
  afterEach(() => {
    vi.useRealTimers();
    testDb?.close();
  });

  it('returns no-op message when nothing is active', () => {
    const ctx = readTrainingContext({ userId: 900, sport: 'running' });
    const block = formatTrainingContextForPrompt(ctx, 'running');
    expect(block).toContain('No cross-skill signals active');
  });

  it('renders scan-friendly tagged block when signals are active', () => {
    publishLowSleep({ userId: 901, tenantId: 901, score: 40 });
    publishHighLegLoad({ userId: 901, source: 'gym', rpe: 9 });
    const ctx = readTrainingContext({ userId: 901, sport: 'running' });
    const block = formatTrainingContextForPrompt(ctx, 'running');
    expect(block).toContain('<cross_skill_state sport="running">');
    expect(block).toContain('LOW SLEEP');
    expect(block).toContain('HIGH LEG LOAD');
    expect(block).toContain('</cross_skill_state>');
  });

  it('uses only a confirmed filming block for Content workload and ignores legacy publication signals', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
    const created = createContentWorkspaceItem({
      scope: { tenantId: 902, userId: 902 },
      itemType: 'content_item',
      title: 'Training-aware filming block',
      idempotencyKey: 'training-content-item-001',
    }, testDb).value;
    createContentArtifact({
      scope: { tenantId: 902, userId: 902 },
      itemId: created.id,
      expectedWorkflowVersion: created.workflowVersion,
      artifactType: 'script',
      initialContent: { format: 'markdown', text: '# Filming draft\nOwner-authored.' },
      idempotencyKey: 'training-content-artifact-001',
    }, testDb);
    let item = getContentWorkspaceItem({ tenantId: 902, userId: 902 }, created.id, testDb)!;
    item = transitionContentWorkspaceItem({
      scope: { tenantId: 902, userId: 902 },
      itemId: item.id,
      targetState: 'review',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'training-content-review-001',
    }, testDb).value;
    item = transitionContentWorkspaceItem({
      scope: { tenantId: 902, userId: 902 },
      itemId: item.id,
      targetState: 'approved',
      expectedWorkflowVersion: item.workflowVersion,
      idempotencyKey: 'training-content-approve-001',
    }, testDb).value;
    const preview = withDatabaseForTest(testDb, () => createContentSchedulePreview({
      scope: { tenantId: 902, userId: 902 },
      itemId: item.id,
      workKind: 'record',
      durationMinutes: 120,
      preferredWindows: [{
        start: '2026-05-08T10:00:00.000Z',
        end: '2026-05-08T12:00:00.000Z',
      }],
      idempotencyKey: 'training-content-preview-001',
      now: '2026-05-01T10:00:00.000Z',
    }, testDb));
    withDatabaseForTest(testDb, () => confirmContentSchedulePreview({
      scope: { tenantId: 902, userId: 902 },
      previewKey: preview.value.previewKey,
      idempotencyKey: 'training-content-confirm-001',
      now: '2026-05-01T10:00:00.000Z',
    }, testDb));
    writeSignal({
      source_agent: 'legacy.content',
      signal_type: 'publishing_commitment',
      payload: { nextDate: '2026-05-07' },
      priority: 'urgent',
      user_id: 902,
      tenant_id: 902,
    });
    writeSignal({
      source_agent: 'legacy.content',
      signal_type: 'shoot_day_locked',
      payload: {
        itemId: 55,
        date: '2026-05-06',
        blockStart: '2026-05-06T10:00:00.000Z',
        blockEnd: '2026-05-06T12:00:00.000Z',
        planStatus: 'confirmed',
        scheduleAuthority: 'secretary',
        scheduleAuthorityStatus: 'current',
        semantics: 'private_work_session',
        workKind: 'filming',
        sourceWorkKind: 'record',
        sourceState: 'scheduled',
        providerAttention: false,
      },
      priority: 'urgent',
      user_id: 902,
      tenant_id: 902,
    });
    writeSignal({
      source_agent: 'mesh.editorial-coordinator',
      signal_type: 'shoot_day_locked',
      payload: {
        date: '2026-05-07',
        planStatus: 'confirmed',
        scheduleAuthority: 'secretary',
        scheduleAuthorityStatus: 'current',
        semantics: 'private_work_session',
        workKind: 'filming',
      },
      priority: 'urgent',
      user_id: 902,
      tenant_id: 902,
    });
    const currentFilmingSignalId = writeSignal({
      source_agent: 'mesh.editorial-coordinator',
      signal_type: 'shoot_day_locked',
      payload: {
        itemId: item.id,
        date: '2026-05-08',
        blockStart: '2026-05-08T10:00:00.000Z',
        blockEnd: '2026-05-08T12:00:00.000Z',
        planStatus: 'confirmed',
        scheduleAuthority: 'secretary',
        scheduleAuthorityStatus: 'current',
        semantics: 'private_work_session',
        workKind: 'filming',
        sourceWorkKind: 'record',
        sourceState: 'scheduled',
        providerAttention: false,
      },
      priority: 'normal',
      user_id: 902,
      tenant_id: 902,
    });

    const ctx = withDatabaseForTest(testDb, () => readTrainingContext({
      userId: 902,
      tenantId: 902,
      sport: 'running',
    }));
    const block = formatTrainingContextForPrompt(ctx, 'running');

    expect(ctx.signals.map((signal) => signal.signal_type)).toEqual(['shoot_day_locked']);
    expect(ctx.flags.confirmedContentWorkBlock).toBe(true);
    expect(block).toContain('CONFIRMED PRIVATE CONTENT WORK on 2026-05-08');
    expect(block).toContain('not publication evidence');
    expect(block).not.toContain('CONTENT COMMITMENT');

    withDatabaseForTest(testDb, () => cancelContentSchedule({
      scope: { tenantId: 902, userId: 902 },
      itemId: item.id,
      idempotencyKey: 'training-content-cancel-001',
      now: '2026-05-02T10:00:00.000Z',
    }, testDb));
    const afterCancellation = withDatabaseForTest(testDb, () => readTrainingContext({
      userId: 902,
      tenantId: 902,
      sport: 'running',
    }));
    expect(testDb.prepare('SELECT status FROM agent_signals WHERE id = ?').get(currentFilmingSignalId))
      .toEqual({ status: 'active' });
    expect(afterCancellation.signals.map((signal) => signal.signal_type)).not.toContain('shoot_day_locked');
    expect(afterCancellation.flags.confirmedContentWorkBlock).toBe(false);
  });
});

// ─── Source attribution constants ───────────────────────────────────

describe('TRAINING_SOURCE constants', () => {
  it('covers all sport coaches and wellness + secretary', () => {
    expect(TRAINING_SOURCE.GYM_COACH).toBe('triathlon.gym');
    expect(TRAINING_SOURCE.RUNNING_COACH).toBe('triathlon.running');
    expect(TRAINING_SOURCE.CYCLE_COACH).toBe('triathlon.cycle');
    expect(TRAINING_SOURCE.SWIM_COACH).toBe('triathlon.swim');
    expect(TRAINING_SOURCE.WELLNESS_SYNC).toBe('garmin.sync');
    expect(TRAINING_SOURCE.SECRETARY_CALENDAR).toBe('secretary.calendar');
    expect(TRAINING_SOURCE.COOKING_FUELING).toBe('cooking.fueling');
    expect(TRAINING_SOURCE.FINANCE_PLANNING).toBe('finance.training');
  });
});
