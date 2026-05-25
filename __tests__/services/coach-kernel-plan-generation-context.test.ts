/**
 * Slice A3 — PlanGenerationContext tests.
 *
 * Pins:
 *   - buildPlanGenerationContext stamps version + schemaVersion + timestamp
 *   - commitWeek is immutable (does not mutate input)
 *   - weekConditions append in order
 *   - validateWeekContextDelta catches bad shape (negative index, mismatch)
 *   - withReadinessSnapshot / withHealthSignal preserve other fields
 *   - getWeekConditions returns the committed entry or undefined
 */

import { describe, expect, it } from 'vitest';
import type {
  HealthSignal,
  PlanGenerationContext,
  ReadinessSnapshot,
  WeekContextDelta,
} from '../../src/services/coach-kernel/types';
import {
  buildPlanGenerationContext,
  commitWeek,
  getWeekConditions,
  validateWeekContextDelta,
  withHealthSignal,
  withReadinessSnapshot,
  withRollingAdherence,
  withRollingHrv,
} from '../../src/services/coach-kernel/plan-generation-context';

describe('buildPlanGenerationContext', () => {
  it('stamps version + schemaVersion + generatedAt', () => {
    const ctx = buildPlanGenerationContext({
      sciencePolicyVersion: '1.2.3',
      schemaVersion: 2,
      generatedAt: '2026-05-23T12:00:00Z',
    });
    expect(ctx.versionStamp.sciencePolicyVersion).toBe('1.2.3');
    expect(ctx.versionStamp.schemaVersion).toBe(2);
    expect(ctx.versionStamp.generatedAt).toBe('2026-05-23T12:00:00Z');
    expect(ctx.weekConditions).toEqual([]);
  });

  it('defaults schemaVersion to 1 when missing', () => {
    const ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    expect(ctx.versionStamp.schemaVersion).toBe(1);
  });

  it('defaults generatedAt to current timestamp when missing', () => {
    const before = Date.now();
    const ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    const after = Date.now();
    const stamped = Date.parse(ctx.versionStamp.generatedAt);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(after + 1000);
  });
});

describe('commitWeek — immutability + append semantics', () => {
  it('does not mutate the input context', () => {
    const ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    const snapshotBefore = JSON.stringify(ctx);
    commitWeek(ctx, { weekIndex: 0, weekConditions: { weekIndex: 0 } });
    expect(JSON.stringify(ctx)).toBe(snapshotBefore);
  });

  it('appends weekConditions in order', () => {
    let ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    ctx = commitWeek(ctx, { weekIndex: 0, weekConditions: { weekIndex: 0, deloadDue: false } });
    ctx = commitWeek(ctx, { weekIndex: 1, weekConditions: { weekIndex: 1, deloadDue: false } });
    ctx = commitWeek(ctx, { weekIndex: 2, weekConditions: { weekIndex: 2, deloadDue: true } });
    expect(ctx.weekConditions.length).toBe(3);
    expect(ctx.weekConditions[2].deloadDue).toBe(true);
  });

  it('updates loadModel wholesale (not merged)', () => {
    let ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    ctx = commitWeek(ctx, {
      weekIndex: 0,
      loadModel: { ctl: 50, atl: 60, loadModelStatus: 'warming', completionCount: 20, confidence: 'medium' },
    });
    ctx = commitWeek(ctx, {
      weekIndex: 1,
      loadModel: { ctl: 55, atl: 50, loadModelStatus: 'warming', completionCount: 25, confidence: 'medium' },
    });
    expect(ctx.loadModel?.ctl).toBe(55);
    expect(ctx.loadModel?.atl).toBe(50);
  });

  it('preserves prior loadModel when delta omits it', () => {
    let ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    ctx = commitWeek(ctx, {
      weekIndex: 0,
      loadModel: { ctl: 50, atl: 60, loadModelStatus: 'warming', completionCount: 20, confidence: 'medium' },
    });
    ctx = commitWeek(ctx, {
      weekIndex: 1,
      weekConditions: { weekIndex: 1 },
    });
    expect(ctx.loadModel?.ctl).toBe(50); // preserved
  });

  it('preserves version stamp across commits', () => {
    let ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    const orig = ctx.versionStamp;
    ctx = commitWeek(ctx, { weekIndex: 0, weekConditions: { weekIndex: 0 } });
    expect(ctx.versionStamp).toEqual(orig);
  });
});

describe('validateWeekContextDelta', () => {
  it('throws on negative weekIndex', () => {
    expect(() => validateWeekContextDelta({ weekIndex: -1 } as WeekContextDelta)).toThrow(/non-negative/);
  });

  it('throws on non-integer weekIndex', () => {
    expect(() => validateWeekContextDelta({ weekIndex: 1.5 } as WeekContextDelta)).toThrow(/non-negative integer/);
  });

  it('throws when weekConditions.weekIndex differs from delta.weekIndex', () => {
    expect(() => validateWeekContextDelta({
      weekIndex: 3,
      weekConditions: { weekIndex: 4 },
    })).toThrow(/does not match/);
  });

  it('passes on valid delta', () => {
    expect(() => validateWeekContextDelta({
      weekIndex: 2,
      weekConditions: { weekIndex: 2 },
    })).not.toThrow();
  });
});

describe('withReadinessSnapshot / withHealthSignal / rolling state', () => {
  const snapshot: ReadinessSnapshot = {
    capturedAt: '2026-05-23T08:00:00Z',
    level: 'green',
    score: 80,
    painFlags: [],
  };
  const health: HealthSignal = {
    capturedAt: '2026-05-23T08:00:00Z',
    painScore: 3,
    consentScope: ['pain'],
  };

  it('withReadinessSnapshot preserves other fields', () => {
    const ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    const next = withReadinessSnapshot(ctx, snapshot);
    expect(next.readinessSnapshot).toBe(snapshot);
    expect(next.versionStamp).toBe(ctx.versionStamp);
    expect(ctx.readinessSnapshot).toBeUndefined(); // input unchanged
  });

  it('withHealthSignal preserves other fields', () => {
    let ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    ctx = withReadinessSnapshot(ctx, snapshot);
    ctx = withHealthSignal(ctx, health);
    expect(ctx.readinessSnapshot).toBe(snapshot);
    expect(ctx.healthSignal).toBe(health);
  });

  it('withRollingHrv sets HRV state', () => {
    let ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    ctx = withRollingHrv(ctx, {
      statusLast7d: ['low', 'low', 'balanced', 'low', 'balanced', 'low', 'low'],
      dropPersisted: true,
    });
    expect(ctx.rollingHrv?.dropPersisted).toBe(true);
  });

  it('withRollingAdherence sets adherence state', () => {
    let ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    ctx = withRollingAdherence(ctx, { fraction: 0.6, weeksBelow70Pct: 2 });
    expect(ctx.rollingAdherence?.fraction).toBe(0.6);
  });
});

describe('getWeekConditions', () => {
  it('returns committed conditions by week index', () => {
    let ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    ctx = commitWeek(ctx, {
      weekIndex: 0,
      weekConditions: { weekIndex: 0, deloadDue: false },
    });
    ctx = commitWeek(ctx, {
      weekIndex: 1,
      weekConditions: { weekIndex: 1, isTravelWeek: true },
    });
    expect(getWeekConditions(ctx, 1)?.isTravelWeek).toBe(true);
    expect(getWeekConditions(ctx, 0)?.deloadDue).toBe(false);
  });

  it('returns undefined for uncommitted weeks', () => {
    const ctx = buildPlanGenerationContext({ sciencePolicyVersion: '1.0.0' });
    expect(getWeekConditions(ctx, 5)).toBeUndefined();
  });
});
