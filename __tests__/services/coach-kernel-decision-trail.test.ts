import { describe, expect, it } from 'vitest';

import {
  buildWeekPlan,
  buildWeeklyDecisionNotes,
  dedupeDecisionLines,
  sampleHybridAthlete,
  type AthleteState,
  type WeeklyPlan,
} from '../../src/services/coach-kernel';

describe('coach-kernel decision trail', () => {
  it('deduplicates noisy decision lines while preserving first useful wording', () => {
    const lines = dedupeDecisionLines([
      'Readiness is strained. Hard work was downgraded before prescription.',
      '  Readiness is strained. Hard work was downgraded before prescription.  ',
      '✳ Readiness is strained. Hard work was downgraded before prescription.',
      'Schedule was reflowed around a key endurance session.',
    ]);

    expect(lines).toEqual([
      'Readiness is strained. Hard work was downgraded before prescription.',
      'Schedule was reflowed around a key endurance session.',
    ]);
  });

  it('rebuilds weekly notes from current plan state and drops stale auto-summary lines', () => {
    const plan: WeeklyPlan = {
      athleteId: sampleHybridAthlete.profile.athleteId,
      weekStart: '2026-05-04',
      discipline: 'hybrid',
      phase: 'deload',
      sessions: [
        {
          id: 'strength-1',
          sport: 'strength',
          sessionType: 'strength_maintenance',
          title: 'Strength Maintenance',
          description: 'Technique work.',
          dayOfWeek: 'monday',
          durationMinutes: 35,
          intensityZone: 'aerobic',
          fatigueCost: 'low',
          keySession: false,
          plannedLoad: 35,
          tags: ['maintenance'],
        },
      ],
      notes: [
        'Weekly structure: stale base-phase text that should be replaced.',
        'Readiness decision: stale green text.',
        'Plan adjustment: stale compression text.',
        'Coach note: preserve this useful extra context.',
        'Coach note: preserve this useful extra context.',
      ],
      guardrailResults: [],
      decisionReasons: [{
        code: 'session_compressed',
        text: 'Strength Maintenance was compressed from 45 to 30 minutes because only 30 minutes were available in the selected window.',
        severity: 'warning',
        affectedEntity: { type: 'session', id: 'strength-1', title: 'Strength Maintenance', dayOfWeek: 'monday' },
        sourceConstraint: { type: 'time', id: 'short-window', label: 'short window' },
        before: { durationMinutes: 45 },
        after: { durationMinutes: 30, capacityMinutes: 30 },
      }],
    };

    const notes = buildWeeklyDecisionNotes(plan, {
      ...sampleHybridAthlete,
      readiness: { ...sampleHybridAthlete.readiness, level: 'red', score: 34 },
    });

    expect(notes[0]).toContain('deload phase');
    expect(notes).toContain('Readiness decision: red/34 requires recovery-first substitutions or a deload.');
    expect(notes).toContain('Plan adjustment: Strength Maintenance was compressed from 45 to 30 minutes because only 30 minutes were available in the selected window.');
    expect(notes.filter((note) => note.includes('stale'))).toHaveLength(0);
    expect(notes.filter((note) => note === 'Coach note: preserve this useful extra context.')).toHaveLength(1);
    expect(notes.filter((note) => note.startsWith('Plan adjustment:'))).toHaveLength(1);
  });

  it('uses reset-focused adherence wording instead of exposing 0% as a failure score', () => {
    const plan: WeeklyPlan = {
      notes: [],
      athleteId: sampleHybridAthlete.profile.athleteId,
      weekStart: '2026-05-04',
      discipline: 'hybrid',
      phase: 'base',
      sessions: [],
      guardrailResults: [],
    };
    const notes = buildWeeklyDecisionNotes(plan, {
      ...sampleHybridAthlete,
      compliance: {
        trailing14DayCompliance: 0,
        consecutiveMisses: 3,
      },
    });

    const adherenceNote = notes.find((note) => note.startsWith('Adherence decision:'));
    expect(adherenceNote).toContain('reset week');
    expect(adherenceNote).toContain('restart with one short, safe session');
    expect(adherenceNote).not.toContain('0%');
  });

  it.each([
    {
      confidence: 'stale_provider' as const,
      expected: /provider data is stale.*manual check-in/i,
    },
    {
      confidence: 'no_data' as const,
      expected: /no fresh wearable or manual readiness data.*manual check-in/i,
    },
  ])('discloses $confidence readiness confidence in durable weekly notes', ({ confidence, expected }) => {
    const notes = buildWeeklyDecisionNotes({
      notes: [],
      athleteId: sampleHybridAthlete.profile.athleteId,
      weekStart: '2026-05-04',
      discipline: 'hybrid',
      phase: 'base',
      sessions: [],
      guardrailResults: [],
    }, {
      ...sampleHybridAthlete,
      readiness: {
        ...sampleHybridAthlete.readiness,
        confidence,
      },
    });

    expect(notes.some((note) => expected.test(note))).toBe(true);
  });

  it('surfaces recovery-driven volume explanations as structured decision reasons', () => {
    const athlete: AthleteState = {
      ...sampleHybridAthlete,
      readiness: {
        ...sampleHybridAthlete.readiness,
        level: 'red',
        score: 28,
      },
    };

    const plan = buildWeekPlan(athlete, '2026-05-04');

    expect(plan.decisionReasons?.some((reason) =>
      reason.code === 'recovery_volume_reduced' || reason.code === 'recovery_intensity_reduced'
    )).toBe(true);
    expect(plan.notes.some((note) =>
      note.startsWith('Plan adjustment:')
      && /readiness|recovery|low-fatigue/i.test(note)
    )).toBe(true);
  });
});
