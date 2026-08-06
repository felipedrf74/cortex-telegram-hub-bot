import { describe, expect, it } from 'vitest';

import {
  prepareTrainingPlanForQualityGate,
} from '../../src/services/coach-kernel/training-plan-quality-gate';
import {
  EXERCISE_LIBRARY,
  findExerciseDefinitionByName,
} from '../../src/services/coach-kernel/training-taxonomy';
import {
  buildTrainingPlanSpec,
  type TrainingPlanSpec,
} from '../../src/services/training-plan-spec';

const fiveDayHypertrophySpec: TrainingPlanSpec = {
  userId: '42',
  planId: 'candidate',
  goal: 'hypertrophy',
  daysPerWeek: 5,
  startDate: '2026-06-16',
  weekModel: 'rolling_7_day_from_start',
  experienceLevel: 'intermediate',
  equipmentProfile: {
    label: 'full_gym',
    equipment: ['dumbbell', 'barbell', 'cable', 'machine'],
  },
  progressionModel: {
    type: 'double_progression',
    weekCount: 4,
    deloadPolicy: {
      enabled: true,
      everyNWeeks: 4,
      trigger: 'readiness_low',
    },
  },
  calendarPreference: {
    provider: 'outlook',
  },
};

describe('training-plan-quality-gate', () => {
  it('keeps the complete quality-gate output identical while identity mode is shadow', () => {
    const plan = {
      sport: 'gym',
      weeks: [{ weekNumber: 1, sessions: [] }],
    };
    const spec = specFor({ daysPerWeek: 3 });

    expect(prepareTrainingPlanForQualityGate(plan, spec, { exerciseIdentityMode: 'shadow' }))
      .toEqual(prepareTrainingPlanForQualityGate(plan, spec));
  });

  it.each([
    {
      daysPerWeek: 2 as const,
      splitCode: 'AB',
      slots: ['A', 'B'],
      days: ['Tuesday', 'Friday'],
      titles: ['Full Body Strength A', 'Full Body Strength B'],
    },
    {
      daysPerWeek: 3 as const,
      splitCode: 'ABC',
      slots: ['A', 'B', 'C'],
      days: ['Tuesday', 'Thursday', 'Saturday'],
      titles: ['Full Body Strength A', 'Full Body Strength B', 'Full Body Hypertrophy C'],
    },
    {
      daysPerWeek: 4 as const,
      splitCode: 'ABCD',
      slots: ['A', 'B', 'C', 'D'],
      days: ['Tuesday', 'Wednesday', 'Friday', 'Sunday'],
      titles: ['Upper Strength A', 'Lower Quad B', 'Upper Hypertrophy C', 'Lower Posterior Chain D'],
    },
    {
      daysPerWeek: 5 as const,
      splitCode: 'ABCDE',
      slots: ['A', 'B', 'C', 'D', 'E'],
      days: ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      titles: ['Push Hypertrophy A', 'Lower Quad B', 'Pull Hypertrophy C', 'Lower Posterior Chain D', 'Upper Accessories E'],
    },
    {
      daysPerWeek: 6 as const,
      splitCode: 'ABCDEF',
      slots: ['A', 'B', 'C', 'D', 'E', 'F'],
      days: ['Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
      titles: [
        'Push Strength A',
        'Pull Strength B',
        'Lower Strength C',
        'Push Hypertrophy D',
        'Pull Hypertrophy E',
        'Lower Hypertrophy F',
      ],
    },
  ])('builds a deterministic $daysPerWeek-day $splitCode split with spaced lower-body work', ({ daysPerWeek, splitCode, slots, days, titles }) => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [{ weekNumber: 1, sessions: [] }],
      },
      specFor({ daysPerWeek }),
    );

    const strengthSessions = weekOneStrengthSessions(result.planData);

    expect(result.validation.passed).toBe(true);
    expect(strengthSessions).toHaveLength(daysPerWeek);
    expect(strengthSessions.map((session: any) => session.splitCode)).toEqual(Array(daysPerWeek).fill(splitCode));
    expect(strengthSessions.map((session: any) => session.splitSlot)).toEqual(slots);
    expect(strengthSessions.map((session: any) => session.dayOfWeek)).toEqual(days);
    expect(strengthSessions.map((session: any) => session.title)).toEqual(titles);
    expect(strengthSessions.some((session: any) => /Catalog|Strength Support Session/.test(session.title))).toBe(false);
    expect(hasAdjacentLowerHeavySessions(strengthSessions)).toBe(false);
    expect(strengthSessions.every((session: any) =>
      Array.isArray(session.primaryMuscles)
      && Array.isArray(session.secondaryMuscles)
      && Array.isArray(session.movementPatterns)
      && Array.isArray(session.sections)
      && session.sections.length > 0
      && session.progression?.type
    )).toBe(true);
  });

  it('repairs a three-session generic 5-day hypertrophy plan into ABCDE split sessions', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              genericGobletSession('Tuesday', 'Catalog Hypertrophy Strength 5'),
              genericGobletSession('Wednesday', 'Catalog Hypertrophy Strength 2'),
              genericGobletSession('Thursday', 'Strength Support Session'),
            ],
          },
        ],
      },
      fiveDayHypertrophySpec,
    );

    const strengthSessions = weekOneStrengthSessions(result.planData);
    const titles = strengthSessions.map((session: any) => session.title);
    const slots = strengthSessions.map((session: any) => session.splitSlot);
    const gobletCount = strengthSessions.flatMap((session: any) => session.exercises ?? [])
      .filter((exercise: any) => String(exercise.name || '').toLowerCase() === 'goblet squat')
      .length;

    expect(result.validation.passed).toBe(true);
    expect(result.validation.warnings).toEqual([]);
    expect(strengthSessions).toHaveLength(5);
    expect(slots).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(titles).toEqual([
      'Push Hypertrophy A',
      'Lower Quad B',
      'Pull Hypertrophy C',
      'Lower Posterior Chain D',
      'Upper Accessories E',
    ]);
    expect(titles.some((title: string) => /Catalog|Strength Support Session/.test(title))).toBe(false);
    expect(gobletCount).toBeLessThanOrEqual(1);
    expect(strengthSessions.every((session: any) =>
      session.splitCode === 'ABCDE'
      && Array.isArray(session.primaryMuscles)
      && Array.isArray(session.movementPatterns)
      && Array.isArray(session.sections)
      && session.progression?.type === 'double_progression'
    )).toBe(true);
  });

  it('replaces stale ABCDE strength titles and too-short split durations before persistence', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              genericGobletSession('Tuesday', 'Upper Body Strength A', 17),
              genericGobletSession('Wednesday', 'Lower Quad B', 17),
              genericGobletSession('Thursday', 'Pull Hypertrophy C', 17),
              genericGobletSession('Friday', 'Upper Body Strength A', 17),
              genericGobletSession('Saturday', 'Upper Body Strength A', 17),
            ],
          },
        ],
      },
      fiveDayHypertrophySpec,
    );

    const strengthSessions = weekOneStrengthSessions(result.planData);

    expect(result.validation.passed).toBe(true);
    expect(strengthSessions.map((session: any) => session.splitSlot)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(strengthSessions.map((session: any) => session.title)).toEqual([
      'Push Hypertrophy A',
      'Lower Quad B',
      'Pull Hypertrophy C',
      'Lower Posterior Chain D',
      'Upper Accessories E',
    ]);
    expect(strengthSessions.every((session: any) => session.durationMinutes >= 40)).toBe(true);
    expect(strengthSessions.find((session: any) => session.splitSlot === 'D')?.primaryMuscles).toContain('hamstrings');
    expect(result.repairActions.some((action) => /stale or generic title/i.test(action))).toBe(true);
  });

  it('replaces catalog variant titles that conflict with the assigned split slot', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              genericGobletSession('Tuesday', 'Strength Technique - Speed/Trunk', 45),
              genericGobletSession('Wednesday', 'Lower Body Strength B', 45),
              genericGobletSession('Thursday', 'Lower Body Strength A', 45),
              genericGobletSession('Friday', 'Strength Support - Posterior/Carry', 45),
              genericGobletSession('Saturday', 'Upper Body Strength B', 45),
            ],
          },
        ],
      },
      fiveDayHypertrophySpec,
    );

    const strengthSessions = weekOneStrengthSessions(result.planData);

    expect(result.validation.passed).toBe(true);
    expect(strengthSessions.map((session: any) => `${session.splitSlot}:${session.title}`)).toEqual([
      'A:Push Hypertrophy A',
      'B:Lower Quad B',
      'C:Pull Hypertrophy C',
      'D:Lower Posterior Chain D',
      'E:Upper Accessories E',
    ]);
    expect(strengthSessions.find((session: any) => session.splitSlot === 'C')?.focus).toBe('Back and biceps');
    expect(strengthSessions.find((session: any) => session.splitSlot === 'C')?.title).not.toMatch(/lower body/i);
  });

  it('preserves concrete custom titles while replacing muscle-region titles that contradict the slot', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              genericGobletSession('Tuesday', 'Runner Strength', 45),
              genericGobletSession('Wednesday', 'Runner Strength Support', 45),
              genericGobletSession('Thursday', 'Mobility + Strength Support', 45),
              genericGobletSession('Friday', 'Glute Hypertrophy', 45),
              genericGobletSession('Saturday', 'Chest and Back Strength', 45),
            ],
          },
        ],
      },
      fiveDayHypertrophySpec,
    );

    const strengthSessions = weekOneStrengthSessions(result.planData);

    expect(strengthSessions.map((session: any) => `${session.splitSlot}:${session.title}`)).toEqual([
      // Sport-specific concrete titles survive — the stated goal of the fix.
      'A:Runner Strength',
      'B:Runner Strength Support',
      'C:Mobility + Strength Support',
      // Muscle-region + training-word titles are structural claims and must
      // follow the assigned slot ("Glute" on the lower slot still differs
      // from the assigned title; "Chest and Back" claims upper).
      'D:Lower Posterior Chain D',
      'E:Upper Accessories E',
    ]);
  });

  it('retitles region-only titles that contradict the assigned slot side even without a training word', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              // "Leg Day" on the Tuesday slot (Push Hypertrophy A — upper)
              // contradicts the slot's rewritten structure.
              genericGobletSession('Tuesday', 'Leg Day', 45),
              // "Back and Biceps Day" on the Wednesday slot (Lower Quad B).
              genericGobletSession('Wednesday', 'Back and Biceps Day', 45),
              genericGobletSession('Thursday', 'Lower Body Strength A', 45),
              genericGobletSession('Friday', 'Lower Body Strength B', 45),
              genericGobletSession('Saturday', 'Upper Body Strength A', 45),
            ],
          },
        ],
      },
      fiveDayHypertrophySpec,
    );

    const strengthSessions = weekOneStrengthSessions(result.planData);

    expect(strengthSessions.map((session: any) => `${session.splitSlot}:${session.title}`)).toEqual([
      'A:Push Hypertrophy A',
      'B:Lower Quad B',
      'C:Pull Hypertrophy C',
      'D:Lower Posterior Chain D',
      'E:Upper Accessories E',
    ]);
  });

  it('repairs sparse claimed-duration sessions with movement coverage and truthful timing', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              {
                dayOfWeek: 'Tuesday',
                sessionType: 'gym',
                title: 'Catalog Hypertrophy Strength 5',
                durationMinutes: 90,
                exercises: [
                  { name: 'Dead Bug', sets: 2, reps: '10-12', rpe: '6', rir: 3, restSec: 45 },
                ],
              },
            ],
          },
        ],
      },
      specFor({ daysPerWeek: 2, sessionDurationMinutes: 90 }),
    );

    const first = weekOneStrengthSessions(result.planData)[0];
    const movementPatterns = new Set((first.exercises ?? []).map((exercise: any) => exercise.movementPattern));
    const deviation = Math.abs(first.estimatedDurationMinutes - first.durationMinutes) / first.durationMinutes;

    expect(result.validation.passed).toBe(true);
    expect(first.durationMinutes).toBeLessThan(90);
    expect(deviation).toBeLessThanOrEqual(0.2);
    expect(movementPatterns.has('horizontal_push')).toBe(true);
    expect(movementPatterns.has('vertical_push')).toBe(true);
    expect(result.repairActions.some((action) => /truthful .* duration/i.test(action))).toBe(true);
  });

  it('moves lower-heavy work away from protected endurance key days when an upper slot can absorb the date', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [{ weekNumber: 1, sessions: [] }],
      },
      specFor({
        daysPerWeek: 5,
        goal: 'hybrid',
        enduranceSchedule: [{
          date: '2026-06-20',
          type: 'long_run',
          priority: 'protected',
        }],
      }),
    );

    const strengthSessions = weekOneStrengthSessions(result.planData);
    const saturday = strengthSessions.find((session: any) => session.dayOfWeek === 'Saturday');

    expect(result.validation.passed).toBe(true);
    expect(strengthSessions.some((session: any) => session.dayOfWeek === 'Friday')).toBe(false);
    expect((saturday?.primaryMuscles ?? []).some((muscle: string) => (
      muscle === 'quads' || muscle === 'hamstrings' || muscle === 'glutes'
    ))).toBe(false);
    expect(hasAdjacentLowerHeavySessions(strengthSessions)).toBe(false);
  });

  it('respects limited equipment and excluded exercises when selecting fallback movements', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [{
          weekNumber: 1,
          sessions: [
            {
              dayOfWeek: 'Tuesday',
              sessionType: 'gym',
              title: 'Catalog Hypertrophy Strength 1',
              durationMinutes: 45,
              exercises: [{ name: 'Front Squat', sets: 3, reps: '8', rpe: '7', restSec: 90 }],
            },
          ],
        }],
      },
      specFor({
        daysPerWeek: 2,
        equipmentProfile: {
          label: 'bodyweight',
          equipment: ['bodyweight'],
        },
        excludedExercises: ['Front Squat', 'Goblet Squat'],
        injuriesOrLimitations: ['low back sensitivity'],
      }),
    );

    const names = weekOneStrengthSessions(result.planData)
      .flatMap((session: any) => session.exercises ?? [])
      .map((exercise: any) => exercise.name);

    expect(result.validation.passed).toBe(true);
    expect(names).not.toContain('Front Squat');
    expect(names).not.toContain('Goblet Squat');
    expect(names).toContain('Bodyweight Squat');
    expect(result.repairActions.some((action) => /incompatible or unknown exercise/i.test(action))).toBe(true);
  });

  it('uses knee-friendlier alternatives for injury-constrained lower-body work', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [{ weekNumber: 1, sessions: [] }],
      },
      specFor({
        daysPerWeek: 4,
        injuriesOrLimitations: ['right knee irritation'],
      }),
    );

    const lowerExercises = weekOneStrengthSessions(result.planData)
      .filter((session: any) => ['B', 'D'].includes(session.splitSlot))
      .flatMap((session: any) => session.exercises ?? []);
    const names = lowerExercises.map((exercise: any) => exercise.name);

    expect(result.validation.passed).toBe(true);
    expect(names).not.toContain('Front Squat');
    expect(names).not.toContain('Goblet Squat');
    expect(names).not.toContain('Leg Press');
    expect(lowerExercises.every((exercise: any) => {
      const definition = findExerciseDefinitionByName(exercise.name);
      return definition?.jointStress.knee !== 'medium' && definition?.jointStress.knee !== 'high';
    })).toBe(true);
  });

  it('fails closed when exclusions make every curated exercise unavailable', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [{ weekNumber: 1, sessions: [] }],
      },
      specFor({
        daysPerWeek: 5,
        excludedExercises: EXERCISE_LIBRARY.map((exercise) => exercise.name),
      }),
    );

    expect(result.validation.passed).toBe(false);
    expect(result.validation.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        'split_integrity',
        'strength_prescription_completeness',
        'weekly_volume_targets',
      ]),
    );
  });

  it('preserves concrete coach-kernel title, day, and equipment-adapted exercises', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [{
          weekNumber: 1,
          focus: 'base',
          sessions: [{
            dayOfWeek: 'Wednesday',
            sessionType: 'gym',
            title: 'Runner Strength',
            durationMinutes: 40,
            exercises: [
              { name: 'DB Floor Press', sets: 3, reps: '8-10', rpe: '7', restSec: 90 },
              { name: 'Goblet Squat', sets: 3, reps: '8-10', rpe: '7', restSec: 90 },
            ],
          }],
        }],
      },
      specFor({
        daysPerWeek: 2,
        equipmentProfile: { label: 'Home gym (basic)', equipment: ['dumbbell', 'bench', 'bodyweight'] },
      }),
    );

    const first = weekOneStrengthSessions(result.planData)[0];
    expect(result.validation.passed).toBe(true);
    expect(first.title).toBe('Runner Strength');
    expect(first.dayOfWeek).toBe('Wednesday');
    expect((first.exercises ?? []).map((exercise: any) => exercise.name)).toEqual([
      'DB Floor Press',
      'Goblet Squat',
    ]);
  });

  it('trims preserved custom strength volume instead of inflating an explicit duration ceiling', () => {
    const originalSetCount = 20;
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [{
          weekNumber: 1,
          focus: 'base',
          sessions: [{
            dayOfWeek: 'Wednesday',
            sessionType: 'gym',
            title: 'Travel Strength',
            durationMinutes: 35,
            exercises: [
              { name: 'Dumbbell Floor Press', sets: 5, reps: '10', rir: 2, restSec: 90 },
              { name: 'Goblet Squat', sets: 5, reps: '10', rir: 2, restSec: 90 },
              { name: 'Seated Dumbbell Shoulder Press', sets: 5, reps: '10', rir: 2, restSec: 90 },
              { name: 'Dead Bug', sets: 5, reps: '10 each side', rir: 3, restSec: 60 },
            ],
          }],
        }],
      },
      specFor({
        daysPerWeek: 2,
        sessionDurationMinutes: 35,
      }),
    );

    const session = weekOneStrengthSessions(result.planData)
      .find((candidate: any) => candidate.title === 'Travel Strength');
    const finalSetCount = (session?.exercises ?? [])
      .reduce((total: number, exercise: any) => total + Number(exercise.sets ?? 0), 0);

    expect(session).toBeDefined();
    expect(session.durationMinutes).toBeLessThanOrEqual(35);
    expect(session.estimatedDurationMinutes).toBeLessThanOrEqual(42);
    expect(finalSetCount).toBeLessThan(originalSetCount);
    expect(result.repairActions.some((action) => /trimmed accessory volume/i.test(action))).toBe(true);
    expect(result.repairActions.some((action) => /raised Travel Strength/i.test(action))).toBe(false);
  });

  it('does not rewrite endurance sessions whose title contains strength', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'running',
        weeks: [{
          weekNumber: 1,
          focus: 'base',
          sessions: [{
            dayOfWeek: 'Tuesday',
            sessionType: 'run',
            title: 'Strength-Endurance Run',
            durationMinutes: 45,
            exercises: [],
          }],
        }],
      },
      specFor({ daysPerWeek: 2, goal: 'hybrid' }),
    );

    const sessions = (result.planData as any).weeks?.[0]?.sessions ?? [];
    const run = sessions.find((session: any) => session.title === 'Strength-Endurance Run');
    expect(result.validation.passed).toBe(true);
    expect(run).toMatchObject({
      sessionType: 'run',
      dayOfWeek: 'Tuesday',
      durationMinutes: 45,
    });
    expect(weekOneStrengthSessions(result.planData)).toHaveLength(2);
  });

  it('does not make the standalone beginner spec require its normal five-week deload cadence', () => {
    // This validator models the athlete's normal novice cadence (five weeks),
    // so a four-week spec leaves `deloadPolicy` disabled. The production REST
    // generator separately horizon-fits week 5 into week 4 to satisfy the
    // stronger creation-quality load-reduction invariant; that route behavior
    // is pinned in training-plan-create-cycle.test.ts.
    const spec = buildTrainingPlanSpec({
      userId: 12,
      objective: 'Beginner strength plan, dumbbells only',
      daysPerWeek: 3,
      startDate: '2026-06-22',
      equipmentProfileLabel: 'dumbbells',
      availableEquipment: ['dumbbells'],
      fitnessProfile: { experience_level: 'Beginner' },
      gymProfile: { equipment_access: 'Dumbbells' },
      durationWeeks: 4,
    });
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [
          { weekNumber: 1, focus: 'base', sessions: [] },
          { weekNumber: 2, focus: 'base', sessions: [] },
          { weekNumber: 3, focus: 'build', sessions: [] },
          { weekNumber: 4, focus: 'build', sessions: [] },
        ],
      },
      spec,
    );

    expect(spec.progressionModel.deloadPolicy).toMatchObject({
      enabled: false,
    });
    expect(result.validation.passed).toBe(true);
    expect(result.validation.errors.map((error) => error.code)).not.toContain('progression_model_integrity');
  });

  it('repairs four-week hypertrophy plans by marking the scheduled deload week before linting', () => {
    const spec = buildTrainingPlanSpec({
      userId: 12,
      objective: 'Muscle Building',
      daysPerWeek: 5,
      startDate: '2026-06-22',
      equipmentProfileLabel: 'full_gym',
      availableEquipment: ['dumbbell', 'barbell', 'cable', 'machine'],
      fitnessProfile: { experience_level: 'Intermediate' },
      gymProfile: { equipment_access: 'Full gym' },
      durationWeeks: 4,
    });
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [
          { weekNumber: 1, focus: 'base', sessions: [] },
          { weekNumber: 2, focus: 'base', sessions: [] },
          { weekNumber: 3, focus: 'build', sessions: [] },
          { weekNumber: 4, focus: 'build', sessions: [] },
        ],
      },
      spec,
    );

    const weeks = (result.planData as any).weeks ?? [];
    const week4 = weeks[3];

    expect(spec.progressionModel.deloadPolicy).toMatchObject({
      enabled: true,
      everyNWeeks: 4,
    });
    expect(result.validation.passed).toBe(true);
    expect(result.validation.errors.map((error) => error.message).join(' ')).not.toContain('focus="deload"');
    expect(result.repairActions).toContain('Marked week 4 as scheduled deload because the progression cadence is 4 weeks.');
    expect(week4.focus).toBe('deload');
    expect(week4.intensityPct).toBeLessThanOrEqual(58);
    expect(week4.sessions.every((session: any) => session.progression?.deload === true)).toBe(true);
  });

  it('repairs adjacent lower-heavy sessions even when the affected week is a deload', () => {
    // Stronger safety guarantee: deload relaxes volume progression, not
    // recovery spacing. The old repair loop skipped the whole week while the
    // validator still (correctly) blocked adjacent lower-heavy sessions.
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [{ weekNumber: 4, focus: 'deload', sessions: [] }],
      },
      specFor({
        daysPerWeek: 3,
        goal: 'strength',
        preferredTrainingDays: ['monday', 'tuesday', 'thursday', 'saturday'],
        progressionModel: {
          type: 'linear_load',
          weekCount: 4,
          deloadPolicy: { enabled: true, everyNWeeks: 4, trigger: 'readiness_low' },
        },
      }),
    );

    const strength = weekOneStrengthSessions(result.planData);
    expect(result.validation.passed).toBe(true);
    expect(hasAdjacentLowerHeavySessions(strength)).toBe(false);
    expect(result.repairActions.some((action) => /adjacent lower-body recovery conflict/i.test(action))).toBe(true);
  });

  it('aligns deload progression with focus=deload instead of fixed week modulo', () => {
    const result = prepareTrainingPlanForQualityGate(
      {
        sport: 'gym',
        weeks: [
          { weekNumber: 1, focus: 'base', sessions: [] },
          { weekNumber: 2, focus: 'build', sessions: [] },
          { weekNumber: 3, focus: 'deload', sessions: [] },
          { weekNumber: 4, focus: 'build', sessions: [] },
        ],
      },
      specFor({
        daysPerWeek: 2,
        progressionModel: {
          type: 'linear_load',
          weekCount: 4,
          deloadPolicy: { enabled: true, everyNWeeks: 4, trigger: 'readiness_low' },
        },
      }),
    );

    const weeks = (result.planData as any).weeks ?? [];
    const week3 = weeks[2].sessions.filter((session: any) => session.sessionType === 'gym');
    const week4 = weeks[3].sessions.filter((session: any) => session.sessionType === 'gym');
    expect(result.validation.passed).toBe(true);
    expect(week3.every((session: any) => session.progression?.deload === true)).toBe(true);
    expect(week4.every((session: any) => session.progression?.deload === false)).toBe(true);
  });

  it('keeps seeded invariant cases valid across goals, days, equipment, dates, and calendar providers', () => {
    const cases = seededInvariantCases();

    for (const input of cases) {
      const result = prepareTrainingPlanForQualityGate(
        {
          sport: 'gym',
          weeks: [{ weekNumber: 1, sessions: [] }],
        },
        specFor(input),
      );
      const strengthSessions = weekOneStrengthSessions(result.planData);
      const titles = strengthSessions.map((session: any) => session.title);
      const allExercises = strengthSessions.flatMap((session: any) => session.exercises ?? []);

      expect(result.validation.passed).toBe(true);
      expect(result.validation.warnings).toEqual([]);
      expect(strengthSessions).toHaveLength(input.daysPerWeek);
      expect(new Set(strengthSessions.map((session: any) => session.splitSlot)).size).toBe(input.daysPerWeek);
      expect(titles.some((title: string) => /Catalog|Strength Support Session/.test(title))).toBe(false);
      expect(hasAdjacentLowerHeavySessions(strengthSessions)).toBe(false);
      expect(allExercises.every((exercise: any) => exercise.exerciseId && exercise.metadataConfidence === 'curated')).toBe(true);
      expect(repeatedUniversalFallbackCount(strengthSessions)).toBeLessThanOrEqual(1);
    }
  });

  it('holds quality invariants across deterministic randomized specs', () => {
    for (const input of deterministicRandomInvariantCases(32)) {
      const result = prepareTrainingPlanForQualityGate(
        {
          sport: 'gym',
          weeks: [{ weekNumber: 1, sessions: [] }],
        },
        specFor(input),
      );
      const strengthSessions = weekOneStrengthSessions(result.planData);
      const allExercises = strengthSessions.flatMap((session: any) => session.exercises ?? []);

      expect(result.validation.passed).toBe(true);
      expect(strengthSessions).toHaveLength(input.daysPerWeek);
      expect(new Set(strengthSessions.map((session: any) => session.splitSlot)).size).toBe(input.daysPerWeek);
      expect(hasAdjacentLowerHeavySessions(strengthSessions)).toBe(false);
      expect(repeatedUniversalFallbackCount(strengthSessions)).toBeLessThanOrEqual(1);
      expect(strengthSessions.every((session: any) =>
        typeof session.title === 'string'
        && !/Catalog|Strength Support Session/.test(session.title)
        && session.splitCode
        && session.splitSlot
        && Array.isArray(session.primaryMuscles)
        && Array.isArray(session.secondaryMuscles)
        && Array.isArray(session.movementPatterns)
        && Array.isArray(session.sections)
        && session.sections.length > 0
      )).toBe(true);
      expect(allExercises.every((exercise: any) =>
        exercise.exerciseId
        && exercise.movementPattern
        && Number(exercise.sets) > 0
        && String(exercise.reps || '').trim()
        && Number(exercise.restSec) > 0
        && (exercise.rir != null || exercise.rpe != null)
      )).toBe(true);
    }
  });
});

function genericGobletSession(dayOfWeek: string, title: string, durationMinutes = 50) {
  return {
    dayOfWeek,
    sessionType: 'gym',
    title,
    durationMinutes,
    exercises: [
      { name: 'Goblet Squat', sets: 3, reps: '10', rpe: '7', restSec: 75 },
      { name: 'Goblet Squat', sets: 3, reps: '10', rpe: '7', restSec: 75 },
    ],
  };
}

function specFor(overrides: Partial<TrainingPlanSpec> = {}): TrainingPlanSpec {
  return {
    ...fiveDayHypertrophySpec,
    ...overrides,
    daysPerWeek: overrides.daysPerWeek ?? fiveDayHypertrophySpec.daysPerWeek,
    goal: overrides.goal ?? fiveDayHypertrophySpec.goal,
    equipmentProfile: overrides.equipmentProfile ?? fiveDayHypertrophySpec.equipmentProfile,
    calendarPreference: overrides.calendarPreference ?? fiveDayHypertrophySpec.calendarPreference,
  };
}

function weekOneStrengthSessions(planData: Record<string, unknown>): any[] {
  const repairedPlan = planData as any;
  const sessions = repairedPlan.weeks?.[0]?.sessions ?? [];
  return sessions.filter((session: any) => session.sessionType === 'gym');
}

function hasAdjacentLowerHeavySessions(sessions: any[]): boolean {
  const lowerDays = sessions
    .filter((session) => (session.primaryMuscles ?? []).some((muscle: string) => (
      muscle === 'quads' || muscle === 'hamstrings' || muscle === 'glutes'
    )))
    .map((session) => dayIndex(session.dayOfWeek))
    .sort((left, right) => left - right);
  return lowerDays.some((day, index) => index > 0 && day - lowerDays[index - 1] <= 1);
}

function dayIndex(dayOfWeek: string): number {
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].indexOf(dayOfWeek);
}

function repeatedUniversalFallbackCount(sessions: any[]): number {
  return sessions
    .flatMap((session) => session.exercises ?? [])
    .filter((exercise) => ['goblet squat', 'bodyweight squat'].includes(String(exercise.name || '').toLowerCase()))
    .length;
}

function seededInvariantCases(): Array<Partial<TrainingPlanSpec> & { daysPerWeek: TrainingPlanSpec['daysPerWeek'] }> {
  return [
    { daysPerWeek: 2, goal: 'strength', startDate: '2026-06-16', calendarPreference: { provider: 'google' } },
    { daysPerWeek: 3, goal: 'general_fitness', startDate: '2026-06-17', equipmentProfile: { label: 'home_basic', equipment: ['dumbbell', 'band', 'bench'] } },
    { daysPerWeek: 4, goal: 'hypertrophy', startDate: '2026-06-18', preferredTrainingDays: ['thursday', 'saturday'], blockedDays: ['monday'] },
    { daysPerWeek: 5, goal: 'hybrid', startDate: '2026-06-19', calendarPreference: { provider: 'outlook' }, enduranceSchedule: [{ date: '2026-06-21', type: 'long_run', priority: 'protected' }] },
    { daysPerWeek: 6, goal: 'strength', startDate: '2026-06-20', sessionDurationMinutes: 45, excludedExercises: ['Goblet Squat'] },
    { daysPerWeek: 3, goal: 'endurance_support', startDate: '2026-06-21', equipmentProfile: { label: 'bodyweight', equipment: ['bodyweight'] } },
    { daysPerWeek: 5, goal: 'hypertrophy', startDate: '2026-06-22', injuriesOrLimitations: ['low back sensitivity'], calendarPreference: { provider: 'none' } },
    { daysPerWeek: 4, goal: 'hybrid', startDate: '2026-06-23', blockedDays: ['friday'], enduranceSchedule: [{ date: '2026-06-27', type: 'race', priority: 'protected' }] },
  ];
}

function deterministicRandomInvariantCases(
  count: number,
): Array<Partial<TrainingPlanSpec> & { daysPerWeek: TrainingPlanSpec['daysPerWeek'] }> {
  const goals: TrainingPlanSpec['goal'][] = ['strength', 'hypertrophy', 'general_fitness', 'hybrid', 'endurance_support'];
  const days: TrainingPlanSpec['daysPerWeek'][] = [2, 3, 4, 5, 6];
  const equipmentProfiles: TrainingPlanSpec['equipmentProfile'][] = [
    { label: 'full_gym', equipment: ['dumbbell', 'barbell', 'cable', 'machine'] },
    { label: 'home_basic', equipment: ['dumbbell', 'band', 'bench'] },
    { label: 'bodyweight', equipment: ['bodyweight'] },
  ];
  const providers: TrainingPlanSpec['calendarPreference']['provider'][] = ['google', 'outlook', 'none'];
  const startDates = [
    '2026-06-16',
    '2026-06-17',
    '2026-06-18',
    '2026-06-19',
    '2026-06-20',
    '2026-06-21',
    '2026-06-22',
  ];
  let seed = 20260616;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  const pick = <T>(values: T[]): T => values[next() % values.length];

  return Array.from({ length: count }, (_, index) => {
    const goal = pick(goals);
    const daysPerWeek = pick(days);
    const startDate = pick(startDates);
    const provider = pick(providers);
    const equipmentProfile = pick(equipmentProfiles);
    const hybridOrEndurance = goal === 'hybrid' || goal === 'endurance_support';
    const includeProtectedEndurance = hybridOrEndurance && daysPerWeek >= 4 && index % 3 === 0;
    return {
      daysPerWeek,
      goal,
      startDate,
      equipmentProfile,
      calendarPreference: { provider },
      ...(index % 4 === 0 ? { sessionDurationMinutes: pick([40, 45, 50, 60]) } : {}),
      ...(index % 5 === 0 ? { blockedDays: [pick(['monday', 'wednesday', 'friday', 'sunday'])] } : {}),
      ...(index % 6 === 0 ? { injuriesOrLimitations: [pick(['low back sensitivity', 'right knee irritation'])] } : {}),
      ...(index % 7 === 0 ? { excludedExercises: ['Goblet Squat'] } : {}),
      ...(includeProtectedEndurance
        ? { enduranceSchedule: [{ date: '2026-06-20', type: 'long_run' as const, priority: 'protected' as const }] }
        : {}),
    };
  });
}
