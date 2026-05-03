// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// TR-EC-QA-O3 (2026-05-03 hostile QA closeout):
// `Goals.priorityOrder` was widened in the goal-mode pass to accept
// `'maintenance' | 'return'` tokens prefixed before the modality
// list. Without the safety filter in `firstModalityPriority`, the
// hybrid engine read `priorityOrder[0]` as a Sport-like string and
// silently mishandled the new tokens — `endurancePriority` would
// only be recognised via `primaryFocus === 'marathon' | 'triathlon'`
// even when the user clearly had `'running'` further down the list.
// These pin tests verify the hardening:
//   1. Maintenance + running modality → endurance branch fires
//      (leading non-Sport token is skipped).
//   2. Return + cycling modality → endurance branch fires.
//   3. Pure-modality priorityOrder still works (regression).
//   4. Maintenance only (modality empty) still works (no crash).

import { describe, expect, it } from 'vitest';
import { resolveHybridPriority } from '../../src/services/coach-kernel/engines/hybrid-engine';
import type { AthleteState } from '../../src/services/coach-kernel/types';

function athleteWith(overrides: Partial<AthleteState['goals']> = {}): AthleteState {
  // Minimal AthleteState for the resolver.
  return {
    profile: { athleteId: 1, name: 'Test', experienceLevel: 'intermediate', primaryDiscipline: 'hybrid' },
    goals: {
      primaryFocus: 'hybrid',
      raceCalendar: [],
      priorityOrder: ['running', 'strength'],
      weeklySessionsTarget: { running: 4, strength: 3 },
      ...overrides,
    },
    constraints: [],
    availability: { weeklyWindows: [], maxSessionsPerDay: 1 } as any,
    equipment: { hasGym: true, hasBarbell: true, hasDumbbells: true, capabilities: [] } as any,
    trainingHistory: { lastWeekMinutesBySport: {}, trailing4WeekMinutesBySport: {} },
    currentBlock: { discipline: 'hybrid', phase: 'base', weekIndex: 1, totalWeeks: 4, volumeProgressionPct: 0 },
    recentSessions: [],
    readiness: { capturedAt: '2026-05-03T08:00:00Z', level: 'green', score: 80, painFlags: [] },
    compliance: { trailing14DayCompliance: 0.9, bySport: {}, missedKeySessions: 0, consecutiveMisses: 0 },
  } as unknown as AthleteState;
}

describe('hybrid-engine priorityOrder safety (TR-EC-QA-O3)', () => {
  it('skips maintenance prefix and recognizes running as the leading modality', () => {
    const athlete = athleteWith({
      priorityOrder: ['maintenance', 'running', 'strength'],
      weeklySessionsTarget: { running: 4, strength: 3 },
    });
    const result = resolveHybridPriority(athlete, 'base');
    // Endurance branch: strength capped to 2, run preserved
    expect(result.notes[0]).toMatch(/Endurance priority is active/);
    expect(result.adjustedStrengthSessions).toBeLessThanOrEqual(2);
  });

  it('skips return prefix and recognizes cycling as the leading modality', () => {
    const athlete = athleteWith({
      primaryFocus: 'cycling',
      priorityOrder: ['return', 'cycling', 'strength'],
      weeklySessionsTarget: { cycling: 3, strength: 2 },
    });
    const result = resolveHybridPriority(athlete, 'base');
    expect(result.notes[0]).toMatch(/Endurance priority is active/);
  });

  it('preserves legacy behavior when priorityOrder has only modality tokens', () => {
    // Regression check — pre-existing pure-modality input still works.
    const athlete = athleteWith({
      priorityOrder: ['running', 'strength'],
      weeklySessionsTarget: { running: 5, strength: 3 },
    });
    const result = resolveHybridPriority(athlete, 'base');
    expect(result.notes[0]).toMatch(/Endurance priority is active/);
    expect(result.adjustedRunSessions).toBe(5);
  });

  it('does not crash when priorityOrder is purely lifecycle tokens (no modality entry)', () => {
    // Edge case — extremely unlikely but possible if the resolver
    // emits ['maintenance'] alone. Should fall back to primaryFocus
    // for endurance detection without throwing.
    const athlete = athleteWith({
      primaryFocus: 'hybrid',
      priorityOrder: ['maintenance'],
      weeklySessionsTarget: { strength: 2 },
    });
    expect(() => resolveHybridPriority(athlete, 'base')).not.toThrow();
    const result = resolveHybridPriority(athlete, 'base');
    // No modality leading priority + hybrid primaryFocus → falls through
    // to neutral hybrid balance (or strength-priority via strengthGoal).
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('marathon primaryFocus still triggers endurance priority even with maintenance prefix', () => {
    const athlete = athleteWith({
      primaryFocus: 'marathon',
      priorityOrder: ['maintenance', 'running'],
      weeklySessionsTarget: { running: 4, strength: 2 },
    });
    const result = resolveHybridPriority(athlete, 'base');
    expect(result.notes[0]).toMatch(/Endurance priority is active/);
  });
});
