// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// training-expert-coach-knowledge-engine (2026-05-03):
// Pin tests for the deterministic plan-linter. The linter runs AFTER
// per-session coherence + per-week guardrails to catch cross-session +
// cross-week invariants no earlier pass can see (mid-week past sessions,
// equipment mismatches, lower-body density safety, fake taper without
// race date, race-specific plan with no race date, consecutive identical
// strength sessions).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lintPlan,
  type PlanLintInput,
  type PlanLintSession,
  type PlanLintWeek,
} from '../../src/services/coach-kernel/plan-linter';
import { logger } from '../../src/utils/logger';

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

    it('compares scheduled timestamps against the plan-local calendar day', () => {
      const now = new Date('2026-04-22T00:30:00.000Z');
      const scheduledDate = '2026-04-21T08:00:00.000Z';

      // Stronger guarantee: linting the same absolute timestamps must honor
      // the immutable plan zone instead of whichever timezone runs the process.
      const losAngeles = lintPlan(input({
        now,
        timezone: 'America/Los_Angeles',
        weeks: [week(1, [session({ scheduledDate })])],
      }));
      const tokyo = lintPlan(input({
        now,
        timezone: 'Asia/Tokyo',
        weeks: [week(1, [session({ scheduledDate })])],
      }));

      expect(losAngeles.blockers.some((finding) => (
        finding.ruleId === 'no_past_active_sessions'
      ))).toBe(false);
      expect(tokyo.blockers.some((finding) => (
        finding.ruleId === 'no_past_active_sessions'
      ))).toBe(true);
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

  // F3 (Phase 1A-1): whole-plan volume floor.
  //
  // `week_one_has_active_training` deliberately exits clean when the WHOLE
  // plan is empty (`totalActiveTraining === 0`) — it only fires when week 1
  // is empty *relative to* populated later weeks. Nothing else in the rule
  // set is a whole-plan floor, so a plan with zero active sessions anywhere
  // passed the strict preflight and was persisted as "created", after the
  // cancellation saga had already removed the previous plan.
  //
  // All three production shapes collapse to the same zero count:
  //   - every session `unscheduled` (calendar capacity exhausted),
  //   - every session rest/deferred (safety pause rewrite),
  //   - genuinely empty weeks.
  describe('rule: plan_has_active_training', () => {
    it('blocks a plan whose sessions are all unscheduled', () => {
      const result = lintPlan(input({
        weeks: [
          week(1, [
            session({ dayOfWeek: 'monday', title: 'Could Not Place', status: 'unscheduled' }),
            session({ dayOfWeek: 'wednesday', title: 'Could Not Place', status: 'unscheduled' }),
          ]),
          week(2, [
            session({ dayOfWeek: 'tuesday', title: 'Could Not Place', status: 'unscheduled' }),
          ]),
        ],
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers.map((blocker) => blocker.ruleId)).toContain('plan_has_active_training');
    });

    it('blocks a plan whose sessions are all rest-like and deferred', () => {
      const result = lintPlan(input({
        weeks: [
          week(1, [
            session({ dayOfWeek: 'monday', sessionType: 'rest', title: 'Safety pause', status: 'deferred' }),
            session({ dayOfWeek: 'tuesday', sessionType: 'rest', title: 'Safety pause', status: 'deferred' }),
          ]),
        ],
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers.map((blocker) => blocker.ruleId)).toContain('plan_has_active_training');
    });

    it('blocks a plan whose weeks contain no sessions at all', () => {
      const result = lintPlan(input({ weeks: [week(1, []), week(2, [])] }));

      expect(result.status).toBe('fail');
      expect(result.blockers.map((blocker) => blocker.ruleId)).toContain('plan_has_active_training');
    });

    it('passes when the plan has at least one active training session', () => {
      const result = lintPlan(input({
        weeks: [
          week(1, [session({ dayOfWeek: 'monday', title: 'Easy Run' })]),
          week(2, [session({ dayOfWeek: 'tuesday', sessionType: 'rest', title: 'Rest', status: 'deferred' })]),
        ],
      }));

      expect(result.blockers.map((blocker) => blocker.ruleId)).not.toContain('plan_has_active_training');
    });

    it('does not double-report with week_one_has_active_training', () => {
      // Week 1 empty + later weeks populated is the week-one rule's case, not
      // the floor's — the floor must stay silent so the operator sees one
      // actionable blocker rather than two.
      const result = lintPlan(input({
        weeks: [
          week(1, [session({ dayOfWeek: 'monday', title: 'Could Not Place', status: 'unscheduled' })]),
          week(2, [session({ dayOfWeek: 'tuesday', title: 'Real Run', scheduledDate: '2026-04-28T07:00:00.000Z' })]),
        ],
      }));

      const ruleIds = result.blockers.map((blocker) => blocker.ruleId);
      expect(ruleIds).toContain('week_one_has_active_training');
      expect(ruleIds).not.toContain('plan_has_active_training');
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

    it('counts coded recovery_run session types as active training', () => {
      const result = lintPlan(input({
        weeks: [
          week(1, [
            session({
              sessionType: 'recovery_run',
              title: 'Easy Reset',
              scheduledDate: '2026-04-24T07:00:00.000Z',
            }),
          ]),
          week(2, [
            session({
              title: 'Week 2 Easy Run',
              scheduledDate: '2026-04-28T07:00:00.000Z',
            }),
          ]),
        ],
      }));

      expect(result.status).toBe('pass');
      expect(result.blockers.some((finding) => finding.ruleId === 'week_one_has_active_training')).toBe(false);
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

    it('logs when the window check is skipped because durationWeeks is missing or invalid', () => {
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

      const result = lintPlan(input({
        durationWeeks: 0,
        startDate: '2026-04-22',
        weeks: [
          week(1, [session({ scheduledDate: '2026-04-22T07:00:00.000Z' })]),
          week(5, [
            session({
              title: 'Potentially Hidden Week',
              scheduledDate: '2026-05-19T07:00:00.000Z',
            }),
          ]),
        ],
      }));

      expect(result.blockers.some((finding) => finding.ruleId === 'no_sessions_outside_plan_window')).toBe(false);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ruleId: 'no_sessions_outside_plan_window',
          durationWeeks: 0,
          startDate: '2026-04-22',
          weekNumbers: [1, 5],
        }),
        expect.stringContaining('skipped window check'),
      );
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

    it('does not false-positive equipment tokens embedded inside unrelated words', () => {
      const result = lintPlan(input({
        equipmentProfile: 'bodyweight',
        weeks: [week(1, [
          session({
            sessionType: 'gym',
            title: 'Bodyweight Tempo',
            exerciseTokens: ['template tempo squat', 'track stance lunge', 'pushup'],
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

    it('does not treat strength-plan aerobic support as a long-run blocker', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({ dayOfWeek: 'friday', sessionType: 'gym', isLowerHeavy: true, title: 'Lower Strength Support' }),
          session({ dayOfWeek: 'saturday', sessionType: 'run', isLongRun: false, title: 'Recovery Run' }),
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
    it('blocks when an event-based week is labeled "taper" but no race date is set', () => {
      const result = lintPlan(input({
        goalMode: 'event_based',
        weeks: [
          week(1, [session({})], 'taper'),
          week(2, [session({})], 'race week'),
        ],
        raceDate: undefined,
      }));
      expect(result.status).toBe('fail');
      expect(result.blockers.some((blocker) => blocker.ruleId === 'no_fake_taper_without_event')).toBe(true);
      expect(result.blockers.find((blocker) => blocker.ruleId === 'no_fake_taper_without_event')?.affectedSessions.length).toBe(2);
    });

    it('does not block peak or taper labels for non-event hypertrophy plans', () => {
      const result = lintPlan(input({
        goalMode: 'hypertrophy',
        weeks: [
          week(1, [session({ sessionType: 'gym', title: 'Hypertrophy A' })], 'peak hypertrophy volume'),
          week(2, [session({ sessionType: 'gym', title: 'Hypertrophy B' })], 'taper fatigue through deload'),
        ],
        raceDate: undefined,
      }));

      expect(result.status).toBe('pass');
      expect(result.blockers.some((blocker) => blocker.ruleId === 'no_fake_taper_without_event')).toBe(false);
      expect(result.warnings.some((warning) => warning.ruleId === 'no_fake_taper_without_event')).toBe(false);
    });

    it('passes a taper-labeled week when raceDate is set', () => {
      const result = lintPlan(input({
        goalMode: 'event_based',
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
    it('blocks an event-based plan with no race date', () => {
      const result = lintPlan(input({
        goalMode: 'event_based',
        raceDate: null,
      }));
      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('race_specific_plan_requires_race_date');
    });

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

  describe('rule: event-based race-date validity', () => {
    it('blocks an event-based plan with a past race date', () => {
      const result = lintPlan(input({
        goalMode: 'event_based',
        raceDate: '2026-04-20',
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers.some((blocker) => blocker.ruleId === 'race_date_must_be_future')).toBe(true);
    });

    it('blocks a same-day race date even when goalMode says continuous', () => {
      const result = lintPlan(input({
        goalMode: 'continuous',
        raceDate: '2026-04-22',
      }));

      // F12 stronger guarantee: "future" is strict in the plan-local day;
      // an internal caller cannot bypass the public boundary with today.
      expect(result.status).toBe('fail');
      expect(result.blockers.some((blocker) => blocker.ruleId === 'race_date_must_be_future')).toBe(true);
    });

    it('blocks a plan duration that overshoots the race date', () => {
      const result = lintPlan(input({
        goalMode: 'event_based',
        startDate: '2026-04-22',
        raceDate: '2026-05-05',
        durationWeeks: 6,
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers.some((blocker) => blocker.ruleId === 'plan_duration_overshoots_race_date')).toBe(true);
    });

    it('blocks a strictly-future race date that precedes the resolved plan start', () => {
      const result = lintPlan(input({
        goalMode: 'continuous',
        startDate: '2026-04-27',
        raceDate: '2026-04-25',
        durationWeeks: 4,
      }));

      // F12 policy (a) still makes this event-based: the date is future
      // relative to NOW, but no generated week can build toward an event that
      // occurs before week 1. Internal callers must fail closed too.
      expect(result.status).toBe('fail');
      const blocker = result.blockers.find((candidate) => (
        String(candidate.ruleId) === 'race_date_precedes_plan_start'
      ));
      expect(blocker).toMatchObject({
        severity: 'blocker',
        evidence: {
          raceDateIso: '2026-04-25',
          startDateIso: '2026-04-27',
        },
      });
    });

    it('treats a future race date as event-based even when goalMode says continuous', () => {
      const result = lintPlan(input({
        goalMode: 'continuous',
        startDate: '2026-04-22',
        raceDate: '2026-05-05',
        durationWeeks: 6,
        weeks: [week(1, [session({})], 'taper')],
      }));

      // Stronger guarantee: a valid future race date activates the same
      // duration and taper rules as an explicit event_based request. The
      // taper is legitimate because the event exists; the overshoot is not.
      expect(result.blockers.some((blocker) => blocker.ruleId === 'plan_duration_overshoots_race_date')).toBe(true);
      expect(result.blockers.some((blocker) => blocker.ruleId === 'no_fake_taper_without_event')).toBe(false);
      expect(result.status).toBe('fail');
    });

    it('fails closed on a supplied malformed race date even in continuous mode', () => {
      const result = lintPlan(input({
        goalMode: 'continuous',
        raceDate: 'not-a-date',
      }));

      // F12 stronger guarantee: internal callers cannot evade event-date
      // validation by pairing malformed data with continuous mode. Public
      // routes reject this earlier; the linter remains the defense in depth.
      expect(result.status).toBe('fail');
      expect(result.blockers.some((blocker) => (
        blocker.ruleId === 'race_date_invalid'
      ))).toBe(true);
      expect(result.blockers.some((blocker) => (
        blocker.ruleId === 'race_specific_plan_requires_race_date'
      ))).toBe(false);
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

  describe('rules: endurance and triathlon quality gates', () => {
    it('blocks when hard endurance work dominates the week', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({ dayOfWeek: 'monday', sessionType: 'threshold_run', title: 'Threshold Run', isKey: true }),
          session({ dayOfWeek: 'tuesday', sessionType: 'interval_ride', title: 'VO2 Bike Intervals', sport: 'cycling', isKey: true }),
          session({ dayOfWeek: 'thursday', sessionType: 'tempo_run', title: 'Tempo Run', isKey: true }),
          session({ dayOfWeek: 'saturday', sessionType: 'easy_run', title: 'Easy Run' }),
        ])],
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers.map((blocker) => blocker.ruleId)).toContain('endurance_hard_easy_balance');
    });

    it('blocks when hard endurance sessions are back-to-back', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({ dayOfWeek: 'tuesday', sessionType: 'threshold_run', title: 'Threshold Run', isKey: true }),
          session({ dayOfWeek: 'wednesday', sessionType: 'interval_ride', title: 'Bike Intervals', sport: 'cycling', isKey: true }),
          session({ dayOfWeek: 'saturday', sessionType: 'easy_run', title: 'Easy Run' }),
        ])],
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers.map((blocker) => blocker.ruleId)).toContain('endurance_interval_density');
    });

    it('does not equate a controlled key long session with hard intensity', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({ dayOfWeek: 'monday', sessionType: 'threshold_run', title: 'Threshold Run', isKey: true }),
          session({ dayOfWeek: 'wednesday', sessionType: 'easy_run', title: 'Easy Run' }),
          session({ dayOfWeek: 'thursday', sessionType: 'threshold_swim', title: 'Threshold Swim', sport: 'swimming', isKey: true }),
          session({ dayOfWeek: 'saturday', sessionType: 'long_run', title: 'Long Run', isKey: true, isLongRun: true }),
          session({ dayOfWeek: 'sunday', sessionType: 'technique_swim', title: 'Technique Swim', sport: 'swimming' }),
        ])],
      }));

      const blockerIds = result.blockers.map((blocker) => blocker.ruleId);
      expect(blockerIds).not.toContain('endurance_hard_easy_balance');
      expect(blockerIds).not.toContain('endurance_interval_density');
    });

    it('blocks a large long-session jump across weeks', () => {
      const result = lintPlan(input({
        weeks: [
          week(1, [session({ title: 'Long Run', sessionType: 'long_run', durationMinutes: 60, isLongRun: true })]),
          week(2, [session({ title: 'Long Run', sessionType: 'long_run', durationMinutes: 90, isLongRun: true })]),
        ],
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers.map((blocker) => blocker.ruleId)).toContain('long_session_progression');
    });

    it('blocks swim prescriptions when intake says pool access is unavailable', () => {
      const result = lintPlan(input({
        hasPoolAccess: false,
        weeks: [week(1, [
          session({ title: 'Technique Swim', sessionType: 'technique_swim', sport: 'swimming' }),
        ])],
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('swim_pool_access_required');
    });

    it('blocks swim prescriptions when pool access is unknown', () => {
      const result = lintPlan(input({
        weeks: [week(1, [
          session({ title: 'Technique Swim', sessionType: 'technique_swim', sport: 'swimming' }),
        ])],
      }));

      expect(result.status).toBe('fail');
      expect(result.blockers[0]?.ruleId).toBe('swim_pool_access_required');
    });

    it('warns when cycling power zones are prescribed without a benchmark', () => {
      const result = lintPlan(input({
        cyclingBenchmarkAvailable: false,
        weeks: [week(1, [
          session({
            title: 'FTP Bike Intervals',
            sessionType: 'threshold_ride',
            sport: 'cycling',
            description: '5 x 4 min at 105% FTP / Zone 5 power.',
          }),
        ])],
      }));

      expect(result.warnings[0]?.ruleId).toBe('cycling_power_requires_benchmark');
    });

    it('warns when a four-week triathlon plan has no transition practice', () => {
      const result = lintPlan(input({
        triathlonMode: true,
        hasPoolAccess: true,
        durationWeeks: 4,
        weeks: [week(1, [
          session({ dayOfWeek: 'monday', sessionType: 'technique_swim', title: 'Technique Swim', sport: 'swimming' }),
          session({ dayOfWeek: 'wednesday', sessionType: 'endurance_ride', title: 'Endurance Ride', sport: 'cycling' }),
          session({ dayOfWeek: 'saturday', sessionType: 'long_run', title: 'Long Run', sport: 'running', isLongRun: true }),
        ])],
      }));

      expect(result.warnings[0]?.ruleId).toBe('triathlon_brick_placement');
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
          ], 'taper'), // non-event taper copy is allowed; equipment remains the blocker.
        ],
      }));
      expect(result.status).toBe('fail');
      expect(result.blockers.length).toBe(1);
      expect(result.warnings.length).toBe(0);
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
  // F7 (Phase 3): defense-in-depth for the explicit 'never' two-a-day
  // stance. The volume enforcer relocates or defers doubles; this rule
  // guarantees a violating plan can never pass the strict preflight even if
  // an upstream pass regresses.
  describe('rule: two_a_day_cap', () => {
    it("blocks a doubled day when twoADayPreference is 'never'", () => {
      const result = lintPlan(input({
        twoADayPreference: 'never',
        weeks: [week(1, [
          session({ dayOfWeek: 'friday', sessionType: 'run', title: 'Tempo Run' }),
          session({ dayOfWeek: 'friday', sessionType: 'gym', title: 'Lift A' }),
          session({ dayOfWeek: 'saturday', title: 'Long Run' }),
        ])],
      }));

      expect(result.status).toBe('fail');
      const finding = result.blockers.find((blocker) => blocker.ruleId === 'two_a_day_cap');
      expect(finding).toBeTruthy();
      expect(finding?.affectedSessions).toHaveLength(2);
      expect(finding?.affectedSessions.every((affected) => affected.dayOfWeek === 'friday')).toBe(true);
    });

    it('ignores doubled days for every other preference value', () => {
      for (const preference of [undefined, null, 'preferred', 'optional', 'auto']) {
        const result = lintPlan(input({
          twoADayPreference: preference as never,
          weeks: [week(1, [
            session({ dayOfWeek: 'friday', sessionType: 'run', title: 'Tempo Run' }),
            session({ dayOfWeek: 'friday', sessionType: 'gym', title: 'Lift A' }),
          ])],
        }));
        expect(result.blockers.some((blocker) => blocker.ruleId === 'two_a_day_cap')).toBe(false);
      }
    });

    it('does not count inactive sessions toward the cap', () => {
      const result = lintPlan(input({
        twoADayPreference: 'never',
        weeks: [week(1, [
          session({ dayOfWeek: 'friday', sessionType: 'run', title: 'Tempo Run' }),
          session({ dayOfWeek: 'friday', sessionType: 'gym', title: 'Lift A', status: 'deferred' }),
        ])],
      }));
      expect(result.blockers.some((blocker) => blocker.ruleId === 'two_a_day_cap')).toBe(false);
    });
  });
});
