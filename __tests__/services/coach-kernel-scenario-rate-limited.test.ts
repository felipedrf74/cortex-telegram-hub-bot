/**
 * R6 P2 — rate-limited classifier preserves the would-have
 * modifiers + suppressed actions so the UI can render
 * "we'd suggest X but waiting."
 *
 * Codex caught (R6 P2 #2): the prior early-return at rate-limit
 * dropped the modifier list entirely. The contract comment promised
 * "warning-only mode — still surface an assessment so the UI can
 * show 'we'd suggest X but waiting'", but the code returned
 * `modifiers: []`. These tests pin the new shape: modifiers stay
 * populated, actions get suppressed, `rateLimited: true` flags
 * the case.
 */
import { describe, expect, it } from 'vitest';
import { classifyTrainingScenario } from '../../src/services/coach-kernel/scenario-classifier';
import type { Session } from '../../src/services/coach-kernel/types';

// Minimal stub principles — only the bits the classifier reads in
// the modifier branches we're testing. We don't need real A1b data
// for the rate-limit gate; the classifier's modifier code reads
// weekConditions/weekIntent flags.
const PRINCIPLES = {
  sciencePolicyVersion: '1.0.0',
  missedSessionPolicyDefaults: {
    easy_aerobic: 'drop',
    strength_accessory: 'drop',
    key_interval_tempo: 'reschedule_if_recovery_window',
    long_run_ride: 'reschedule_if_recovery_window',
    taper_session: 'drop',
  },
} as any;

const SESSION: Session = {
  id: 's1',
  sport: 'strength',
  sessionType: 'strength',
  title: 'Test',
  dayOfWeek: 'monday',
  durationMinutes: 60,
  intensityZone: 'aerobic',
  fatigueCost: 'low',
  keySession: false,
} as Session;

const TRAVEL_WEEK_INTENT = {
  kind: 'accumulation' as const,
  volumeMultiplier: 1,
  intensityFloor: 'aerobic',
  intensityCeiling: 'threshold',
  primaryQuality: 'volume',
};

describe('R6 P2 — rate-limited classifier preserves modifiers', () => {
  it('rate-limited travel week → modifiers includes travel_adjustment + rateLimited: true', () => {
    const result = classifyTrainingScenario({
      sessions: [SESSION],
      weekConditions: {
        weekIndex: 0,
        isTravelWeek: true,
        missedSessionsThisWeek: 0,
        missedSessionIds: [],
        lowAdherenceTrend: false,
        deloadDue: false,
        equipmentOverride: null,
      } as any,
      weekIntent: TRAVEL_WEEK_INTENT as any,
      // Trip the 24h limit.
      recentReflowCount24h: 5,
      adaptationRateLimitPerDay: 1,
      adaptationRateLimitPerWeek: 2,
      principles: PRINCIPLES,
    });
    expect(result.rateLimited).toBe(true);
    expect(result.modifiers).toContain('travel_adjustment');
    expect(result.actions).toEqual([]);
    expect((result.suppressedActions ?? []).length).toBeGreaterThan(0);
    // The primary scenario reflects what WOULD have been done.
    expect(result.primaryScenario).toBe('travel_adjustment');
  });

  it('rate-limited deload-due week → deload_apply modifier + suppressedActions populated', () => {
    const result = classifyTrainingScenario({
      sessions: [SESSION],
      weekConditions: {
        weekIndex: 0,
        isTravelWeek: false,
        missedSessionsThisWeek: 0,
        missedSessionIds: [],
        lowAdherenceTrend: false,
        deloadDue: true,
        equipmentOverride: null,
      } as any,
      weekIntent: TRAVEL_WEEK_INTENT as any,
      recentReflowCount24h: 5,
      adaptationRateLimitPerDay: 1,
      adaptationRateLimitPerWeek: 2,
      principles: PRINCIPLES,
    });
    expect(result.rateLimited).toBe(true);
    expect(result.modifiers).toContain('deload_apply');
    expect(result.actions).toEqual([]);
    expect((result.suppressedActions ?? []).length).toBeGreaterThan(0);
    expect(result.suppressedActions?.[0]?.type).toBe('scale_volume');
  });

  it('NOT rate-limited → actions populated, suppressedActions undefined', () => {
    const result = classifyTrainingScenario({
      sessions: [SESSION],
      weekConditions: {
        weekIndex: 0,
        isTravelWeek: true,
        missedSessionsThisWeek: 0,
        missedSessionIds: [],
        lowAdherenceTrend: false,
        deloadDue: false,
        equipmentOverride: null,
      } as any,
      weekIntent: TRAVEL_WEEK_INTENT as any,
      recentReflowCount24h: 0,
      adaptationRateLimitPerDay: 1,
      adaptationRateLimitPerWeek: 2,
      principles: PRINCIPLES,
    });
    expect(result.rateLimited).toBeFalsy();
    expect(result.suppressedActions).toBeUndefined();
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.modifiers).toContain('travel_adjustment');
  });

  it('safety override bypasses rate limit (hard pause fires regardless)', () => {
    const result = classifyTrainingScenario({
      sessions: [SESSION],
      weekConditions: {
        weekIndex: 0,
        isTravelWeek: true,
        missedSessionsThisWeek: 0,
        missedSessionIds: [],
        lowAdherenceTrend: false,
        deloadDue: false,
        equipmentOverride: null,
      } as any,
      weekIntent: TRAVEL_WEEK_INTENT as any,
      safetyOutput: {
        effectiveSeverity: 'block',
        findings: [],
        source: 'structured_intake',
        triggerType: 'chest_pain',
      } as any,
      recentReflowCount24h: 99,
      adaptationRateLimitPerDay: 1,
      principles: PRINCIPLES,
    });
    // Safety branch returns early — no rateLimited flag, hard
    // pause action fires.
    expect(result.rateLimited).toBeFalsy();
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions[0]?.type).toBe('pause_training');
  });

  // R8 P2-10 — `kind` discriminator. Every return path must set it
  // so a switch over `assessment.kind` is exhaustiveness-checked
  // by the compiler. These tests pin the three values.
  it('R8 P2-10 — rate-limited assessment has kind === "rate_limited"', () => {
    const result = classifyTrainingScenario({
      sessions: [SESSION],
      weekConditions: {
        weekIndex: 0,
        isTravelWeek: true,
        missedSessionsThisWeek: 0,
        missedSessionIds: [],
        lowAdherenceTrend: false,
        deloadDue: false,
        equipmentOverride: null,
      } as any,
      weekIntent: TRAVEL_WEEK_INTENT as any,
      recentReflowCount24h: 5,
      adaptationRateLimitPerDay: 1,
      adaptationRateLimitPerWeek: 2,
      principles: PRINCIPLES,
    });
    expect(result.kind).toBe('rate_limited');
  });

  it('R8 P2-10 — normal (non-rate-limited, non-safety) assessment has kind === "normal"', () => {
    const result = classifyTrainingScenario({
      sessions: [SESSION],
      weekConditions: {
        weekIndex: 0,
        isTravelWeek: true,
        missedSessionsThisWeek: 0,
        missedSessionIds: [],
        lowAdherenceTrend: false,
        deloadDue: false,
        equipmentOverride: null,
      } as any,
      weekIntent: TRAVEL_WEEK_INTENT as any,
      recentReflowCount24h: 0,
      adaptationRateLimitPerDay: 1,
      principles: PRINCIPLES,
    });
    expect(result.kind).toBe('normal');
  });

  it('R8 P2-10 — safety-pause assessment has kind === "safety"', () => {
    const result = classifyTrainingScenario({
      sessions: [SESSION],
      weekConditions: {
        weekIndex: 0,
        isTravelWeek: false,
        missedSessionsThisWeek: 0,
        missedSessionIds: [],
        lowAdherenceTrend: false,
        deloadDue: false,
        equipmentOverride: null,
      } as any,
      weekIntent: TRAVEL_WEEK_INTENT as any,
      safetyOutput: {
        effectiveSeverity: 'block',
        findings: [],
        source: 'structured_intake',
        triggerType: 'chest_pain',
      } as any,
      principles: PRINCIPLES,
    });
    expect(result.kind).toBe('safety');
  });

  it('boundary: count === limit trips the gate (≥, not >)', () => {
    const result = classifyTrainingScenario({
      sessions: [SESSION],
      weekConditions: {
        weekIndex: 0,
        isTravelWeek: true,
        missedSessionsThisWeek: 0,
        missedSessionIds: [],
        lowAdherenceTrend: false,
        deloadDue: false,
        equipmentOverride: null,
      } as any,
      weekIntent: TRAVEL_WEEK_INTENT as any,
      recentReflowCount24h: 1,
      adaptationRateLimitPerDay: 1,
      principles: PRINCIPLES,
    });
    expect(result.rateLimited).toBe(true);
  });
});
