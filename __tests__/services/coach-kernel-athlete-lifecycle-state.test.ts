// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// training-expert-coach-knowledge-engine (2026-05-03):
// Pin tests for the AthleteLifecycleState typed derivation. These cover
// the priority-ordered branch logic — every branch must be reachable
// with realistic AthleteState shapes, and the derivation must be PURE
// (same input, same output, no I/O).

import { describe, expect, it } from 'vitest';
import {
  deriveAthleteLifecycleState,
  type AthleteLifecycleState,
} from '../../src/services/coach-kernel/athlete-lifecycle-state';
import type {
  AthleteState,
  ComplianceSummary,
  Constraint,
  Goals,
  ReadinessSnapshot,
  CurrentBlock,
  NormalizedTrainingProfile,
  TrainingProfileQuality,
} from '../../src/services/coach-kernel/types';

const NOW = new Date('2026-04-22T08:00:00.000Z');

function compliance(overrides: Partial<ComplianceSummary> = {}): ComplianceSummary {
  return {
    trailing14DayCompliance: 0.9,
    bySport: {},
    missedKeySessions: 0,
    consecutiveMisses: 0,
    ...overrides,
  };
}

function readiness(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    capturedAt: NOW.toISOString(),
    level: 'green',
    score: 80,
    painFlags: [],
    ...overrides,
  };
}

function block(overrides: Partial<CurrentBlock> = {}): CurrentBlock {
  return {
    discipline: 'running',
    phase: 'base',
    weekIndex: 1,
    totalWeeks: 12,
    volumeProgressionPct: 0,
    ...overrides,
  };
}

function goals(overrides: Partial<Goals> = {}): Goals {
  return {
    primaryFocus: 'running',
    raceCalendar: [],
    priorityOrder: ['running'],
    weeklySessionsTarget: { running: 4 },
    ...overrides,
  };
}

function profileQuality(missingCriticalKeys: string[] = []): TrainingProfileQuality {
  return {
    completenessScore: missingCriticalKeys.length === 0 ? 1 : 0.5,
    confidenceScore: 0.9,
    confidenceBand: 'high',
    planQualityLimited: missingCriticalKeys.length > 0,
    planningRiskFlags: [],
    missingCriticalData: missingCriticalKeys.map((key) => ({
      key,
      category: 'goals' as const,
      severity: 'critical' as const,
      reason: 'missing',
    })),
    followUpQuestions: [],
    sourceSummary: {},
  } as unknown as TrainingProfileQuality;
}

function state(overrides: Partial<AthleteState> = {}): AthleteState {
  // Default: a healthy progressing athlete with full profile.
  const normalized: NormalizedTrainingProfile = {
    goals: {
      primaryFocus: 'running',
      raceCalendar: [],
      priorityOrder: ['running'],
      weeklySessionsTarget: { running: 4 },
    },
    experience: { level: 'intermediate', trainingAge: 3 },
    availability: { weeklyWindows: [], maxSessionsPerDay: 1 },
    availableSessionDurations: [{ minMinutes: 45, maxMinutes: 75 }],
    equipment: { hasGym: true, hasBarbell: true, hasDumbbells: true, capabilities: [], notes: undefined },
    environment: {},
    scheduleConstraints: { travelWeek: false, sicknessFlag: false },
    discomfortFlags: [],
    recoveryBaseline: {},
    consistencyTendencies: {},
    currentMarkers: {},
    quality: profileQuality([]),
  } as unknown as NormalizedTrainingProfile;

  return {
    profile: {
      athleteId: 1,
      name: 'Test Athlete',
      experienceLevel: 'intermediate',
      primaryDiscipline: 'running',
    },
    normalizedTrainingProfile: normalized,
    profileQuality: profileQuality([]),
    goals: goals({}),
    constraints: [],
    availability: { weeklyWindows: [], maxSessionsPerDay: 1 } as any,
    equipment: { hasGym: true, hasBarbell: true, hasDumbbells: true, capabilities: [] } as any,
    trainingHistory: { lastWeekMinutesBySport: {}, trailing4WeekMinutesBySport: {} },
    currentBlock: block({}),
    recentSessions: [],
    readiness: readiness({}),
    compliance: compliance({}),
    ...overrides,
  };
}

describe('coach-kernel/athlete-lifecycle-state', () => {
  it('returns "onboarding" when no normalizedTrainingProfile is present', () => {
    const verdict = deriveAthleteLifecycleState(
      { ...state(), normalizedTrainingProfile: undefined },
      NOW,
    );
    expect(verdict.state).toBe('onboarding');
    expect(verdict.signals.hasProfile).toBe(false);
  });

  it('returns "profile_incomplete" when missingCriticalData has entries', () => {
    const verdict = deriveAthleteLifecycleState(
      state({ profileQuality: profileQuality(['race_date', 'experience_level']) }),
      NOW,
    );
    expect(verdict.state).toBe('profile_incomplete');
    expect(verdict.signals.hasMissingCriticalData).toBe(true);
  });

  it('returns "recovering" when illness flag is set', () => {
    const verdict = deriveAthleteLifecycleState(
      state({ readiness: readiness({ illness: true, level: 'orange' }) }),
      NOW,
    );
    expect(verdict.state).toBe('recovering');
    expect(verdict.reason).toMatch(/illness/i);
  });

  it('returns "recovering" on high-severity injury constraint', () => {
    const injury: Constraint = {
      type: 'injury',
      severity: 'high',
      affectedSport: 'running',
      area: 'left_knee',
    } as unknown as Constraint;
    const verdict = deriveAthleteLifecycleState(
      state({ constraints: [injury] }),
      NOW,
    );
    expect(verdict.state).toBe('recovering');
    expect(verdict.signals.highSeverityInjury).toBe(true);
  });

  it('returns "recovering" on red readiness', () => {
    const verdict = deriveAthleteLifecycleState(
      state({ readiness: readiness({ level: 'red', score: 35 }) }),
      NOW,
    );
    expect(verdict.state).toBe('recovering');
  });

  it('returns "returning_from_break" after 4+ consecutive misses', () => {
    const verdict = deriveAthleteLifecycleState(
      state({ compliance: compliance({ consecutiveMisses: 5 }) }),
      NOW,
    );
    expect(verdict.state).toBe('returning_from_break');
    expect(verdict.signals.consecutiveMisses).toBe(5);
  });

  it('returns "overloaded" on orange readiness + low adherence + recent misses', () => {
    const verdict = deriveAthleteLifecycleState(
      state({
        readiness: readiness({ level: 'orange', score: 50 }),
        compliance: compliance({ trailing14DayCompliance: 0.4, consecutiveMisses: 2 }),
      }),
      NOW,
    );
    expect(verdict.state).toBe('overloaded');
  });

  it('returns "deloading" on a deload-phase block', () => {
    const verdict = deriveAthleteLifecycleState(
      state({ currentBlock: block({ phase: 'deload' }) }),
      NOW,
    );
    expect(verdict.state).toBe('deloading');
  });

  it('returns "tapering" when race date is within 14 days', () => {
    const raceDate = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000); // +7 days
    const verdict = deriveAthleteLifecycleState(
      state({
        goals: goals({
          raceCalendar: [{ id: 'r1', sport: 'running', date: raceDate.toISOString(), priority: 'a' }],
        }),
      }),
      NOW,
    );
    expect(verdict.state).toBe('tapering');
    expect(verdict.signals.daysToRace).toBe(7);
  });

  it('returns "maintenance" on explicit maintenance strengthGoal without race', () => {
    const verdict = deriveAthleteLifecycleState(
      state({
        goals: goals({ strengthGoal: 'maintenance', raceCalendar: [] }),
      }),
      NOW,
    );
    expect(verdict.state).toBe('maintenance');
  });

  it('returns "base_building" early in block + healthy adherence', () => {
    const verdict = deriveAthleteLifecycleState(
      state({
        currentBlock: block({ weekIndex: 1, phase: 'base' }),
        compliance: compliance({ trailing14DayCompliance: 0.95 }),
      }),
      NOW,
    );
    expect(verdict.state).toBe('base_building');
  });

  it('returns "progressing" on the happy mid-block path', () => {
    const verdict = deriveAthleteLifecycleState(
      state({
        currentBlock: block({ weekIndex: 5, phase: 'build' }),
        compliance: compliance({ trailing14DayCompliance: 0.85 }),
      }),
      NOW,
    );
    expect(verdict.state).toBe('progressing');
  });

  it('priority order: profile_incomplete beats overloaded', () => {
    // Even if other signals would flag overloaded, missing profile is a
    // higher-priority block (we can't trust readiness math without a
    // profile).
    const verdict = deriveAthleteLifecycleState(
      state({
        profileQuality: profileQuality(['race_date']),
        readiness: readiness({ level: 'orange' }),
        compliance: compliance({ trailing14DayCompliance: 0.4, consecutiveMisses: 2 }),
      }),
      NOW,
    );
    expect(verdict.state).toBe('profile_incomplete');
  });

  it('priority order: recovering (red readiness) beats deloading', () => {
    const verdict = deriveAthleteLifecycleState(
      state({
        readiness: readiness({ level: 'red' }),
        currentBlock: block({ phase: 'deload' }),
      }),
      NOW,
    );
    expect(verdict.state).toBe('recovering');
  });

  it('is pure: same input → same verdict', () => {
    const s = state({});
    const a = deriveAthleteLifecycleState(s, NOW);
    const b = deriveAthleteLifecycleState(s, NOW);
    expect(a).toEqual(b);
  });
});
