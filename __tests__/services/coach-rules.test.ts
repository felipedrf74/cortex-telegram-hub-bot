import { describe, expect, it } from 'vitest';

import { listTrainingCoachRules } from '../../src/services/coach-kernel/coach-rules';
import { lintPlan } from '../../src/services/coach-kernel/plan-linter';

describe('training coach rules registry', () => {
  it('covers the core safety, planning, hybrid, triathlon, monitoring, fueling, and communication domains', () => {
    const rules = listTrainingCoachRules();
    const categories = new Set(rules.map((rule) => rule.category));

    expect(categories).toEqual(new Set([
      'screening_safety',
      'strength_progression',
      'endurance_periodization',
      'hybrid_interference',
      'triathlon_balance',
      'load_monitoring',
      'fueling_scope',
      'coach_communication',
    ]));
    expect(rules.every((rule) => rule.userFacingPrinciple.length > 0)).toBe(true);
    expect(rules.some((rule) => rule.sourceAnchors.includes('ACSM Preparticipation Screening'))).toBe(true);
  });

  it('is consumed by runtime plan-lint guardrails as source-backed evidence', () => {
    const result = lintPlan({
      now: new Date('2026-05-13T12:00:00.000Z'),
      isRaceSpecific: true,
      raceDate: null,
      weeks: [
        {
          weekNumber: 1,
          focus: 'base',
          sessions: [
            {
              dayOfWeek: 'friday',
              sessionType: 'run',
              title: 'Easy run',
              status: 'scheduled',
              scheduledDate: '2026-05-15T09:00:00.000Z',
            },
          ],
        },
      ],
    });

    expect(result.status).toBe('fail');
    expect(result.blockers[0]?.ruleId).toBe('race_specific_plan_requires_race_date');
    expect(result.blockers[0]?.evidence).toMatchObject({
      coachRuleId: 'endurance-periodization-by-goal-horizon',
      sourceAnchors: expect.arrayContaining(['Periodization research', 'TrainingPeaks ATP']),
      userFacingPrinciple: expect.stringContaining('Base, build, peak, taper'),
    });
  });
});
