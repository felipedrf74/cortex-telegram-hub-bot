import { describe, expect, it } from 'vitest';

import {
  adaptTrainingPlanToAvailableEquipment,
  buildTrainingEquipmentAdaptation,
} from '../../src/services/training-plan-equipment-adaptation';
import type { CoordinatedTrainingPlan } from '../../src/services/training-plan-coordination';

describe('training-plan-equipment-adaptation', () => {
  it('builds home-gym substitution rules from onboarding profiles', () => {
    const adaptation = buildTrainingEquipmentAdaptation({
      fitnessProfile: { available_equipment: 'Home gym (basic)' },
      gymProfile: { equipment_access: 'Home gym (basic)' },
    });

    expect(adaptation.equipmentProfile).toBe('home_basic');
    expect(adaptation.summary).toBe('Home gym (basic)');
    expect(adaptation.promptBlock).toContain('dumbbells, bench, kettlebells, and simple accessories only');
    expect(adaptation.promptBlock).toContain('Avoid barbell-only, cable-only, and machine-only prescriptions');
  });

  it('substitutes full-gym lifts for home-basic equipment', () => {
    const adaptation = buildTrainingEquipmentAdaptation({
      gymProfile: { equipment_access: 'Home gym (basic)' },
    });

    const plan: CoordinatedTrainingPlan = {
      weeks: [
        {
          weekNumber: 1,
          sessions: [
            {
              dayOfWeek: 'monday',
              sessionType: 'gym',
              title: 'Upper Body A',
              durationMinutes: 60,
              description: 'Lift.',
              exercises: [
                { name: 'Bench Press', sets: 4, reps: 8, rpe: '7-8', restSec: 90 },
                { name: 'Lat Pulldown / Pull-Up', sets: 4, reps: 8, rpe: '7', restSec: 75 },
                { name: 'Leg Press', sets: 3, reps: 10, rpe: '7', restSec: 90 },
                { name: 'Romanian Deadlift', sets: 3, reps: 8, rpe: '7', restSec: 75 },
              ],
            },
          ],
        },
      ],
    };

    const result = adaptTrainingPlanToAvailableEquipment(plan, adaptation);
    const exercises = result.weeks?.[0].sessions?.[0].exercises ?? [];
    const names = exercises.map((exercise: any) => exercise.name);

    expect(names).toEqual([
      'DB Floor Press',
      'One-Arm DB Row',
      'Goblet Squat',
      'DB Romanian Deadlift',
    ]);
    expect(result.weeks?.[0].sessions?.[0].description).toContain('Adapted for a basic home gym');
  });

  it('rebuilds gym sessions for bodyweight-only athletes', () => {
    const adaptation = buildTrainingEquipmentAdaptation({
      fitnessProfile: { available_equipment: 'Bodyweight only' },
    });

    const plan: CoordinatedTrainingPlan = {
      weeks: [
        {
          weekNumber: 1,
          sessions: [
            {
              dayOfWeek: 'friday',
              sessionType: 'gym',
              title: 'Lower Body B',
              durationMinutes: 55,
              description: 'Lift.',
              exercises: [
                { name: 'Back Squat', sets: 4, reps: 6, rpe: '7-8', restSec: 120 },
                { name: 'Romanian Deadlift', sets: 3, reps: 8, rpe: '7', restSec: 90 },
              ],
            },
          ],
        },
      ],
    };

    const result = adaptTrainingPlanToAvailableEquipment(plan, adaptation);
    const exercises = result.weeks?.[0].sessions?.[0].exercises ?? [];
    const names = exercises.map((exercise: any) => exercise.name);

    expect(names).toEqual(['Tempo Air Squat', 'Single-Leg Hip Hinge']);
    expect(result.weeks?.[0].sessions?.[0].description).toContain('Adapted for bodyweight-only execution');
  });
});
