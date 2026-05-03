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

  it('treats no-equipment profile text as bodyweight-only', () => {
    const adaptation = buildTrainingEquipmentAdaptation({
      fitnessProfile: { available_equipment: 'No equipment' },
      gymProfile: { equipment_access: 'No equipment' },
    });

    expect(adaptation.equipmentProfile).toBe('bodyweight');
    expect(adaptation.summary).toBe('Bodyweight only');
    expect(adaptation.promptBlock).toContain('no barbell, dumbbell, machine, or cable access');
  });

  it('removes equipment-dependent support lifts for no-equipment athletes', () => {
    const adaptation = buildTrainingEquipmentAdaptation({
      gymProfile: { equipment_access: 'No equipment' },
    });

    const plan: CoordinatedTrainingPlan = {
      weeks: [
        {
          weekNumber: 1,
          sessions: [
            {
              dayOfWeek: 'monday',
              sessionType: 'gym',
              title: 'Strength + Core Support',
              durationMinutes: 40,
              description: 'Support strength.',
              exercises: [
                { name: 'Goblet Squat', sets: 3, reps: 8, rpe: '7', restSec: 75 },
                { name: 'Romanian Deadlift', sets: 3, reps: 8, rpe: '7', restSec: 75 },
                { name: 'One-Arm Row', sets: 3, reps: 10, rpe: '7', restSec: 60 },
                { name: 'Single-Leg RDL', sets: 3, reps: 8, rpe: '7', restSec: 60 },
                { name: 'Banded Hip Hinge', sets: 3, reps: 12, rpe: '7', restSec: 45 },
                { name: 'Front Plank', sets: 3, reps: 40, rpe: '6', restSec: 30 },
              ],
            },
          ],
        },
      ],
    };

    const result = adaptTrainingPlanToAvailableEquipment(plan, adaptation);
    const names = (result.weeks?.[0].sessions?.[0].exercises ?? []).map((exercise: any) => exercise.name);

    expect(names).toEqual([
      'Tempo Air Squat',
      'Single-Leg Hip Hinge',
      'Prone Snow Angel',
      'Single-Leg Hip Hinge',
      'Single-Leg Hip Hinge',
      'Front Plank',
    ]);
    expect(names.join(' ')).not.toMatch(/\b(goblet|dumbbell|db|barbell|machine|cable|banded|band|rdl)\b/i);
  });
});
