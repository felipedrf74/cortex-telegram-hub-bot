// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { attachTrainingLearningPathToPlan } from '../../src/services/training-learning-path';

describe('training-learning-path', () => {
  it('adds phase goals, weekly focus, technique cards, benchmarks, and outcomes to generated plans', () => {
    const plan = attachTrainingLearningPathToPlan({
      planName: 'Hybrid Build',
      weeks: [
        {
          weekNumber: 1,
          focus: 'Build',
          sessions: [
            {
              sport: 'running',
              sessionType: 'threshold_run',
              title: 'Threshold Run Benchmark',
              description: 'Controlled threshold benchmark with RPE notes.',
            },
            {
              sport: 'strength',
              sessionType: 'gym',
              title: 'Lower Strength',
              description: 'Main lift and accessories.',
            },
          ],
        },
      ],
    }, {
      objective: 'Hybrid running and strength',
      goalMode: 'continuous',
      trainingPriority: 'hybrid',
      durationWeeks: 4,
    });

    expect(plan.trainingLearningPath).toMatchObject({
      schemaVersion: 1,
      objective: 'Hybrid running and strength',
    });
    expect(plan.trainingLearningPath.weeklyPath[0]).toMatchObject({
      weekNumber: 1,
      phaseGoal: 'Establish baseline and rhythm',
    });
    expect(plan.trainingLearningPath.weeklyPath[0].benchmarkSessionTitles).toContain('Threshold Run Benchmark');
    expect(plan.trainingLearningPath.weeklyPath[0].techniqueCards.join(' ')).toContain('Strength');
    expect(plan.weeks[0].learningFocus.weeklyLearningFocus).toContain('lower-body lifting');
    expect(plan.trainingLearningPath.measurableOutcomes).toEqual(expect.arrayContaining([
      'Session completion and skip rate',
      'Post-session RPE, soreness, and pain feedback',
      'Strength exercise progression and clean-rep consistency',
    ]));
  });

  it('prioritizes triathlon learning rationale when swim, bike, run, and strength are present', () => {
    const plan = attachTrainingLearningPathToPlan({
      planName: 'Triathlon Build',
      weeks: [
        {
          weekNumber: 1,
          focus: 'Build',
          sessions: [
            { sport: 'swim', title: 'Technique Swim' },
            { sport: 'bike', title: 'Bike Cadence' },
            { sport: 'run', title: 'Easy Run' },
            { sport: 'strength', title: 'Strength Support' },
          ],
        },
      ],
    }, {
      objective: 'Sprint triathlon with strength support',
      goalMode: 'event_based',
      trainingPriority: 'hybrid',
      durationWeeks: 6,
    });

    expect(plan.weeks[0].learningFocus.weeklyLearningFocus).toContain('swim, bike, run');
    expect(plan.weeks[0].learningFocus.whyThisMatters).toContain('Triathlon fitness');
  });
});
