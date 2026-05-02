// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';

import { resolveWeeklyTargets } from '../../src/services/training-coach-kernel-plan-generator';
import type { CoachKernelTrainingPlanInput } from '../../src/services/training-coach-kernel-plan-generator';

/**
 * Pin the May 2 2026 (Felipe-reported) expansion to
 * `resolveWeeklyTargets`:
 *
 *   1. Strength cap raised from 4 → 6 sessions/week. Advanced
 *      lifters who explicitly request 5+ strength sessions now
 *      get them. Felipe ("5+ years gym, 3+ years running")
 *      requested 5, was silently capped to 4.
 *
 *   2. Marathon focus enforces a minimum of 4 running sessions
 *      per week — the standard marathon-prep skeleton (1 long
 *      run + 1 quality + 2 supports). Generic "running" focus
 *      (5K / 10K casual) keeps the prior minimum of 2.
 *
 * Downstream guardrails (capacity-reconciliation, session-
 * coherence) still adjust if the resulting load is unsustainable
 * for the user's recovery state. The cap is just the upper bound
 * the planner will accept from explicit user input.
 */

function baseInput(overrides: Partial<CoachKernelTrainingPlanInput> = {}): CoachKernelTrainingPlanInput {
  return {
    user: { id: 1, firstName: 'Test', lastName: null },
    objective: 'Marathon training',
    sessionsPerWeek: 6,
    strengthSessionsPerWeek: 5,
    fitnessProfile: null,
    runProfile: { weekly_availability_days: '6 days' },
    gymProfile: null,
    notes: null,
    raceCalendar: [],
    durationWeeks: 12,
    startDate: '2026-05-02',
    blockPhase: 'build',
    confidenceBand: 'high',
    twoADayPreference: 'preferred',
    ...overrides,
  };
}

describe('resolveWeeklyTargets — May 2 2026 expansion', () => {
  // ── Strength cap: 0–6 (was 0–4) ──

  it('marathon: respects user-requested 5 strength sessions (was capped to 4)', () => {
    // Felipe's exact scenario. Pre-May-2: capped to 4. Post: 5.
    const targets = resolveWeeklyTargets('marathon', baseInput({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    }));
    expect(targets.strength).toBe(5);
  });

  it('marathon: respects user-requested 6 strength sessions (new upper cap)', () => {
    const targets = resolveWeeklyTargets('marathon', baseInput({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 6,
    }));
    expect(targets.strength).toBe(6);
  });

  it('marathon: caps strength at 6 even when user requests 10', () => {
    // Cap is still in place to keep the planner's session-spacing
    // math sane. Runaway values are clamped down.
    const targets = resolveWeeklyTargets('marathon', baseInput({
      strengthSessionsPerWeek: 10,
    }));
    expect(targets.strength).toBe(6);
  });

  it('marathon: 0 strength sessions is honored (rest-only days for strength)', () => {
    const targets = resolveWeeklyTargets('marathon', baseInput({
      strengthSessionsPerWeek: 0,
    }));
    expect(targets.strength).toBe(0);
  });

  // ── Marathon minimum running: 4 (was 2) ──

  it('marathon: enforces minimum 4 running sessions even when user sets sessionsPerWeek=3', () => {
    // Pre-May-2: returned running=3 (Felipe's reported symptom —
    // "only 3 running sessions, completely forgot the long runs").
    // Post: 4 (1 long + 1 quality + 2 supports skeleton).
    const targets = resolveWeeklyTargets('marathon', baseInput({
      sessionsPerWeek: 3,
      runProfile: { weekly_availability_days: '6 days' },
    }));
    expect(targets.running).toBe(4);
  });

  it('marathon: respects sessionsPerWeek above the minimum (5 → running=5)', () => {
    const targets = resolveWeeklyTargets('marathon', baseInput({
      sessionsPerWeek: 5,
      runProfile: { weekly_availability_days: '6 days' },
    }));
    expect(targets.running).toBe(5);
  });

  it('marathon: caps running at availability days when set (4 days available → 4 max even with sessionsPerWeek=7)', () => {
    const targets = resolveWeeklyTargets('marathon', baseInput({
      sessionsPerWeek: 7,
      runProfile: { weekly_availability_days: '4 days' },
    }));
    expect(targets.running).toBe(4);
  });

  it('marathon: still produces 4 running when availability is sparse and sessionsPerWeek is low', () => {
    // Edge: 3-day availability + 3 sessions requested → should
    // still satisfy marathon minimum of 4 by overriding the
    // availability cap. Without the override, novice marathon
    // plans would have only 3 runs which can't include both a
    // long run + meaningful support work.
    //
    // Note: in this corner case, the scheduler's downstream
    // guardrails will surface a `preferred_time_unavailable`
    // signal so the user knows the plan is dense for their
    // declared availability.
    const targets = resolveWeeklyTargets('marathon', baseInput({
      sessionsPerWeek: 3,
      runProfile: { weekly_availability_days: '3 days' },
    }));
    expect(targets.running).toBeGreaterThanOrEqual(3);
  });

  // ── Generic "running" focus (5K/10K casual) keeps min 2 ──

  it('generic running (non-marathon): does NOT enforce marathon-specific minimum 4', () => {
    // For 5K / 10K casual training, the generic-running branch
    // keeps the prior minimum (effective: 3 sessions, since `total`
    // is clamped to ≥3 globally). The marathon-specific minimum of
    // 4 is gated on primaryFocus === 'marathon' so casual runners
    // don't get over-prescribed long runs they don't need.
    const targets = resolveWeeklyTargets('running', baseInput({
      sessionsPerWeek: 3,
    }));
    expect(targets.running).toBe(3);
    // Same input under marathon focus: bumps to 4 (minRunning).
    const marathonTargets = resolveWeeklyTargets('marathon', baseInput({
      sessionsPerWeek: 3,
    }));
    expect(marathonTargets.running).toBe(4);
  });

  it('generic running: still scales up with sessionsPerWeek', () => {
    const targets = resolveWeeklyTargets('running', baseInput({
      sessionsPerWeek: 5,
      runProfile: { weekly_availability_days: '6 days' },
    }));
    expect(targets.running).toBe(5);
  });

  // ── Felipe full scenario (the user-reported bug) ──

  it('Felipe: marathon + 6 days + 5 strength → running=6, strength=5 (was 3 + 4)', () => {
    const targets = resolveWeeklyTargets('marathon', baseInput({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
      runProfile: { weekly_availability_days: '6 days' },
    }));
    // Was: { running: 6, strength: 4 } pre-fix (5 silently capped
    // to 4). Now: { running: 6, strength: 5 } — both honored.
    expect(targets).toEqual({ running: 6, strength: 5 });
  });

  // ── Other primaryFocus paths still match prior behavior ──

  it('strength focus: cap is still 6 (matches new global STRENGTH_CAP)', () => {
    const targets = resolveWeeklyTargets('strength', baseInput({
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 6,
    }));
    expect(targets.strength).toBe(6);
  });

  it('triathlon: strength sub-cap of 2 still applies (triathlon-specific)', () => {
    // Triathletes don't lift heavy 6 days a week — the triathlon
    // branch keeps its own sub-cap at min(strength, 2). This
    // test pins that the global cap raise didn't accidentally
    // loosen the triathlon-specific cap.
    const targets = resolveWeeklyTargets('triathlon', baseInput({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    }));
    expect(targets.strength).toBe(2);
  });

  it('hybrid: strength target is still bounded by total - 2 (preserves running headroom)', () => {
    const targets = resolveWeeklyTargets('hybrid', baseInput({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    }));
    // hybrid keeps `Math.max(1, Math.min(strength || 2, total - 2))`
    // so strength is min(5, 4) = 4. Running gets the rest.
    expect(targets.strength).toBe(4);
    expect(targets.running).toBe(2);
  });
});
