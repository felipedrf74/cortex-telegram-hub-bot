// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// training-expert-coach-knowledge-engine (2026-05-03):
// Pin tests for the deterministic plan-linter. The linter runs AFTER
// per-session coherence + per-week guardrails to catch cross-session +
// cross-week invariants no earlier pass can see (mid-week past sessions,
// equipment mismatches, lower-body density safety, fake taper without
// race date, race-specific plan with no race date, consecutive identical
// strength sessions).

import { describe, expect, it } from 'vitest';
import {
  lintPlan,
  type PlanLintInput,
  type PlanLintSession,
  type PlanLintWeek,
} from '../../src/services/coach-kernel/plan-linter';

const NOW = new Date('2026-04-22T08:00:00.000Z'); // Wednesday

function session(overrides: Partial<PlanLintSession>): PlanLintSession {
  return {
    dayOfWeek: 'monday',
    sessionType: 'run',
    title: 'Easy Run',
    description: 'Warm-up, steady aerobic main set, and cooldown.',
    durationMinutes: 45,
    status: 'scheduled',
    ...overrides,
  };
}

function week(weekNumber: number, sessions: PlanLintSession[], focus?: string): PlanLintWeek {
  return { weekNumber, focus, sessions };
}

function input(overrides: Partial<PlanLintInput> = {}): PlanLintInput {
  return {
    now: NOW,
    weeks: [week(1, [session({})])],
    ...overrides,
  };
}

describe('coach-kernel/plan-linter', () => {
  describe('rule: no_past_active_sessions', () => {
    it('passes when every active session is dated today or later', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({ dayOfWeek: 'wednesday', scheduledDate: '2026-04-22T09:00:00.000Z' }),
          session({ dayOfWeek: 'friday', scheduledDate: '2026-04-24T09:00:00.000Z' }),
        ])],
      }));
      expect(result.status).toBe('pass');
      expect(result.blockers).toHaveLength(0);
    });

    it('flags an active session dated in the past as a blocker', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({
            dayOfWeek: 'monday',
            title: 'Slipped Mon Run',
            status: 'scheduled',
            scheduledDate: '2026-04-20T09:00:00.000Z', // 2 days before NOW
          }),
        ])],
      }));
      expect(result.status).toBe('fail');
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]?.ruleId).toBe('no_past_active_sessions');
      expect(result.blockers[0]?.affectedSessions[0]?.title).toBe('Slipped Mon Run');
      // suggestedFix produced.
      expect(
        result.suggestedFixes.some((f) => f.findingRuleId === 'no_past_active_sessions'),
      ).toBe(true);
    });

    it('does NOT flag past-dated UNSCHEDULED sessions (those are correctly marked)', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({
            dayOfWeek: 'monday',
            status: 'unscheduled',
            scheduledDate: '2026-04-20T09:00:00.000Z',
          }),
          session({
            dayOfWeek: 'friday',
            status: 'scheduled',
            scheduledDate: '2026-04-24T09:00:00.000Z',
          }),
        ])],
      }));
      expect(result.status).toBe('pass');
    });
  });

  describe('rule: week_one_has_active_training', () => {
    it('blocks a plan whose first week is empty while later weeks have active sessions', () => {
      const result = lintPlan(input({
        weeks: [
          week(1, [
            session({
              dayOfWeek: 'monday',
              title: 'Could Not Place',
              status: 'unscheduled',
            }),
          ]),
          week(2, [
            session({
              dayOfWeek: 'tuesday',
              title: 'First Scheduled Run',
              scheduledDate: '2026-04-28T07:00:00.000Z',
            }),
          ]),
        ],
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('week_one_has_active_training');
      expect(result.blockers[0]?.message).toContain('Week 1 has zero active training sessions');
    });

    it('passes when week one has at least one active training session', () => {
      const result = lintPlan(input({
        weeks: [
          week(1, [
            session({
              dayOfWeek: 'friday',
              title: 'Week 1 Easy Run',
              scheduledDate: '2026-04-24T07:00:00.000Z',
            }),
          ]),
          week(2, [
            session({
              dayOfWeek: 'tuesday',
              title: 'Week 2 Easy Run',
              scheduledDate: '2026-04-28T07:00:00.000Z',
            }),
          ]),
        ],
      }));

      expect(result.status).toBe('pass');
    });
  });

  describe('rule: no_sessions_outside_plan_window', () => {
    it('blocks hidden week leakage beyond the requested duration', () => {
      const result = lintPlan(input({
        durationWeeks: 4,
        startDate: '2026-04-22',
        weeks: [
          week(1, [session({ dayOfWeek: 'wednesday', scheduledDate: '2026-04-22T07:00:00.000Z' })]),
          week(5, [
            session({
              dayOfWeek: 'tuesday',
              title: 'Leaked Week 5 Move Suggestion',
              scheduledDate: '2026-05-19T07:00:00.000Z',
            }),
          ]),
        ],
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('no_sessions_outside_plan_window');
      expect(result.blockers[0]?.evidence).toMatchObject({
        durationWeeks: 4,
        offendingWeeks: [5],
      });
    });

    it('blocks active scheduled dates after the plan end even when week numbers look valid', () => {
      const result = lintPlan(input({
        durationWeeks: 4,
        startDate: '2026-04-22',
        weeks: [
          week(1, [session({ dayOfWeek: 'wednesday', scheduledDate: '2026-04-22T07:00:00.000Z' })]),
          week(4, [
            session({
              dayOfWeek: 'sunday',
              title: 'Out Of Window',
              scheduledDate: '2026-05-21T07:00:00.000Z',
            }),
          ]),
        ],
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('no_sessions_outside_plan_window');
    });

    it('treats the plan end as an exclusive boundary', () => {
      const insideWindow = lintPlan(input({
        durationWeeks: 4,
        startDate: '2026-04-22',
        weeks: [
          week(1, [session({ dayOfWeek: 'wednesday', scheduledDate: '2026-04-22T07:00:00.000Z' })]),
          week(4, [
            session({
              dayOfWeek: 'tuesday',
              title: 'Last Safe Evening Run',
              scheduledDate: '2026-05-19T12:00:00.000Z',
            }),
          ]),
        ],
      }));

      expect(insideWindow.status).toBe('pass');

      const outsideWindow = lintPlan(input({
        durationWeeks: 4,
        startDate: '2026-04-22',
        weeks: [
          week(1, [session({ dayOfWeek: 'wednesday', scheduledDate: '2026-04-22T07:00:00.000Z' })]),
          week(4, [
            session({
              dayOfWeek: 'wednesday',
              title: 'Hidden Week 5 Boundary Leak',
              scheduledDate: '2026-05-20T00:00:00.000Z',
            }),
          ]),
        ],
      }));

      expect(outsideWindow.status).toBe('fail');
      expect(outsideWindow.blockers[0]?.ruleId).toBe('no_sessions_outside_plan_window');
    });
  });

  describe('rule: equipment_compatibility', () => {
    it('flags barbell exercises in a bodyweight-only profile', () => {
      const result = lintPlan(input({
        equipmentProfile: 'bodyweight',
        weeks: [week(1, [
          session({
            sessionType: 'gym',
            title: 'Lift A',
            exerciseTokens: ['barbell back squat', 'pushup', 'plank'],
          }),
        ])],
      }));
      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('equipment_compatibility');
      expect(result.blockers[0]?.evidence).toMatchObject({
        equipmentProfile: 'bodyweight',
      });
    });

    it('passes a bodyweight profile with band/bodyweight-only exercises', () => {
      const result = lintPlan(input({
        equipmentProfile: 'bodyweight',
        weeks: [week(1, [
          session({
            sessionType: 'gym',
            title: 'Lift A',
            exerciseTokens: ['split squat', 'pushup', 'plank', 'band row'],
          }),
        ])],
      }));
      expect(result.status).toBe('pass');
    });

    it('does not flag a full_gym profile with barbell exercises', () => {
      const result = lintPlan(input({
        equipmentProfile: 'full_gym',
        weeks: [week(1, [
          session({
            sessionType: 'gym',
            title: 'Lift A',
            exerciseTokens: ['barbell back squat'],
          }),
        ])],
      }));
      expect(result.status).toBe('pass');
    });

    it('treats no_equipment as bodyweight-equivalent', () => {
      const result = lintPlan(input({
        equipmentProfile: 'no_equipment',
        weeks: [week(1, [
          session({
            sessionType: 'gym',
            title: 'Lift A',
            exerciseTokens: ['leg press machine'],
          }),
        ])],
      }));
      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('equipment_compatibility');
    });
  });

  describe('rule: no_three_consecutive_leg_heavy_days', () => {
    it('warns when three consecutive days are all leg-heavy', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({ dayOfWeek: 'monday', sessionType: 'gym', isLowerHeavy: true, title: 'Sq A' }),
          session({ dayOfWeek: 'tuesday', sessionType: 'gym', isLowerHeavy: true, title: 'Sq B' }),
          session({ dayOfWeek: 'wednesday', sessionType: 'gym', isLowerHeavy: true, title: 'Sq C' }),
        ])],
      }));
      expect(result.status).toBe('pass_with_warnings');
      expect(result.warnings[0]?.ruleId).toBe('no_three_consecutive_leg_heavy_days');
      expect(result.warnings[0]?.affectedSessions.length).toBeGreaterThanOrEqual(3);
    });

    it('passes when leg-heavy days are spaced (Mon/Wed/Fri)', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({ dayOfWeek: 'monday', sessionType: 'gym', isLowerHeavy: true }),
          session({ dayOfWeek: 'tuesday', sessionType: 'run', title: 'Easy Run' }),
          session({ dayOfWeek: 'wednesday', sessionType: 'gym', isLowerHeavy: true }),
          session({ dayOfWeek: 'thursday', sessionType: 'run', title: 'Tempo' }),
          session({ dayOfWeek: 'friday', sessionType: 'gym', isLowerHeavy: true }),
        ])],
      }));
      expect(result.status).toBe('pass');
    });
  });

  describe('rule: no_heavy_lower_before_long_run', () => {
    it('blocks heavy lower-body the day before a long run', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({ dayOfWeek: 'friday', sessionType: 'gym', isLowerHeavy: true, title: 'Heavy Sq' }),
          session({ dayOfWeek: 'saturday', sessionType: 'run', isLongRun: true, title: 'Long Run' }),
        ])],
      }));
      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('no_heavy_lower_before_long_run');
      expect(result.blockers[0]?.affectedSessions[0]?.title).toBe('Heavy Sq');
    });

    it('passes when the day before the long run is upper-body or recovery', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({ dayOfWeek: 'friday', sessionType: 'gym', title: 'Upper Push', isLowerHeavy: false }),
          session({ dayOfWeek: 'saturday', sessionType: 'run', isLongRun: true, title: 'Long Run' }),
        ])],
      }));
      expect(result.status).toBe('pass');
    });

    it('blocks heavy lower-body across a week boundary when scheduled dates are present', () => {
      const result = lintPlan(input({
        weeks: [
          week(1, [
            session({
              dayOfWeek: 'sunday',
              sessionType: 'gym',
              isLowerHeavy: true,
              title: 'Heavy Lower',
              scheduledDate: '2026-04-26T18:00:00.000Z',
            }),
          ]),
          week(2, [
            session({
              dayOfWeek: 'monday',
              sessionType: 'run',
              isLongRun: true,
              title: 'Long Run',
              scheduledDate: '2026-04-27T08:00:00.000Z',
            }),
          ]),
        ],
      }));
      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('no_heavy_lower_before_long_run');
      expect(result.blockers[0]?.affectedSessions[0]?.title).toBe('Heavy Lower');
    });
  });

  describe('rule: no_fake_taper_without_event', () => {
    it('warns when a week is labeled "taper" but no race date is set', () => {
      const result = lintPlan(input({
        weeks: [
          week(1, [session({})], 'taper'),
          week(2, [session({})], 'race week'),
        ],
        raceDate: undefined,
      }));
      expect(result.status).toBe('pass_with_warnings');
      expect(result.warnings[0]?.ruleId).toBe('no_fake_taper_without_event');
      expect(result.warnings[0]?.affectedSessions.length).toBe(2);
    });

    it('passes a taper-labeled week when raceDate is set', () => {
      const result = lintPlan(input({
        weeks: [week(1, [session({})], 'taper')],
        raceDate: '2026-05-15',
      }));
      expect(result.status).toBe('pass');
    });

    it('passes neutral focus labels (deload/review)', () => {
      const result = lintPlan(input({
        weeks: [week(1, [session({})], 'deload week'), week(2, [session({})], 'review')],
      }));
      expect(result.status).toBe('pass');
    });
  });

  describe('rule: race_specific_plan_requires_race_date', () => {
    it('blocks a race-specific plan with no race date', () => {
      const result = lintPlan(input({
        isRaceSpecific: true,
        raceDate: null,
      }));
      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('race_specific_plan_requires_race_date');
    });

    it('passes a race-specific plan with a race date', () => {
      const result = lintPlan(input({
        isRaceSpecific: true,
        raceDate: '2026-06-01',
      }));
      expect(result.status).toBe('pass');
    });

    it('does not require a race date for non-race-specific plans', () => {
      const result = lintPlan(input({
        isRaceSpecific: false,
        raceDate: null,
      }));
      expect(result.status).toBe('pass');
    });
  });

  describe('rule: no_consecutive_identical_strength_sessions', () => {
    it('warns when two adjacent strength sessions have identical first 6 tokens', () => {
      const sameTokens = ['squat', 'bench', 'row', 'curl', 'tricep', 'plank'];
      const result = lintPlan(input({
        weeks: [week(1, [
          session({
            dayOfWeek: 'monday',
            sessionType: 'gym',
            title: 'Lift A',
            exerciseTokens: sameTokens,
          }),
          session({
            dayOfWeek: 'tuesday',
            sessionType: 'gym',
            title: 'Lift B',
            exerciseTokens: sameTokens,
          }),
        ])],
      }));
      expect(result.status).toBe('pass_with_warnings');
      expect(result.warnings[0]?.ruleId).toBe('no_consecutive_identical_strength_sessions');
    });

    it('passes when adjacent strength sessions differ', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({
            dayOfWeek: 'monday',
            sessionType: 'gym',
            title: 'Lower Day',
            exerciseTokens: ['squat', 'rdl', 'lunge', 'calf', 'plank'],
          }),
          session({
            dayOfWeek: 'tuesday',
            sessionType: 'gym',
            title: 'Upper Day',
            exerciseTokens: ['bench', 'pullup', 'row', 'curl', 'tricep'],
          }),
        ])],
      }));
      expect(result.status).toBe('pass');
    });

    it('does not warn when strength sessions are non-adjacent', () => {
      const sameTokens = ['squat', 'bench', 'row', 'curl'];
      const result = lintPlan(input({
        weeks: [week(1, [
          session({
            dayOfWeek: 'monday',
            sessionType: 'gym',
            title: 'A',
            exerciseTokens: sameTokens,
          }),
          session({ dayOfWeek: 'tuesday', sessionType: 'run', title: 'Run' }),
          session({
            dayOfWeek: 'wednesday',
            sessionType: 'gym',
            title: 'B',
            exerciseTokens: sameTokens,
          }),
        ])],
      }));
      expect(result.status).toBe('pass');
    });
  });

  describe('rule: session_prescription_completeness', () => {
    it('warns when an active workout only has a label and no executable detail', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({
            title: 'Run',
            description: '',
            exerciseTokens: [],
            durationMinutes: undefined,
          }),
        ])],
      }));

      expect(result.status).toBe('pass_with_warnings');
      expect(result.warnings[0]?.ruleId).toBe('session_prescription_completeness');
    });

    it('passes a simple run prescription with duration and description', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({
            title: 'Easy Run',
            durationMinutes: 40,
            description: '10 min warm-up, 25 min easy aerobic, 5 min cooldown.',
          }),
        ])],
      }));

      expect(result.status).toBe('pass');
    });
  });

  describe('overall', () => {
    it('produces a fail status when ANY blocker fires (regardless of warnings)', () => {
      const result = lintPlan(input({
        equipmentProfile: 'bodyweight',
        weeks: [
          week(1, [
            session({
              sessionType: 'gym',
              title: 'Lift A',
              exerciseTokens: ['barbell back squat'],
            }),
          ], 'taper'), // also fires the warning rule
        ],
      }));
      expect(result.status).toBe('fail');
      expect(result.blockers.length).toBe(1);
      expect(result.warnings.length).toBe(1);
    });

    it('always returns the same shape (blockers + warnings + suggestedFixes arrays)', () => {
      const result = lintPlan(input());
      expect(result).toMatchObject({
        status: 'pass',
        blockers: [],
        warnings: [],
        suggestedFixes: [],
      });
    });
  });
});
