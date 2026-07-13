// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import type { SessionType } from '../../src/services/coach-kernel/types';
import {
  CANONICAL_TRAINING_SESSION_TYPES,
  resolveTrainingWorkoutCapability,
} from '../../src/services/training-workout-capability-registry';
import {
  TRAINING_TYPED_PRIMARY_PRESCRIPTIONS_BY_SESSION_TYPE,
  TRAINING_TYPED_WORKOUT_VALIDATOR_VERSION,
  validateTrainingTypedPlanDocument,
  validateTrainingTypedWorkout,
  type TrainingTypedPhase,
  type TrainingTypedPlanValidationDocument,
  type TrainingTypedPrescriptionKind,
  type TrainingTypedWorkout,
  type TrainingTypedWorkoutPrescription,
} from '../../src/services/training-typed-workout-v1';

describe('training typed workout v1', () => {
  it('maps every canonical session type exactly once to an explicit primary prescription contract', () => {
    expect(TRAINING_TYPED_WORKOUT_VALIDATOR_VERSION).toBe('training-typed-workout-validator.v1');
    expect(Object.keys(TRAINING_TYPED_PRIMARY_PRESCRIPTIONS_BY_SESSION_TYPE)).toEqual(
      CANONICAL_TRAINING_SESSION_TYPES,
    );
    expect(new Set(Object.keys(TRAINING_TYPED_PRIMARY_PRESCRIPTIONS_BY_SESSION_TYPE))).toHaveLength(21);
  });

  it('validates modality-appropriate fixtures for all 21 canonical session types', () => {
    for (const sessionType of CANONICAL_TRAINING_SESSION_TYPES) {
      const workout = workoutFor(sessionType);
      expect(() => validateTrainingTypedWorkout(workout), sessionType).not.toThrow();
      expect(resolveTrainingWorkoutCapability(sessionType).canonical).toBe(true);
    }
  });

  it('preserves unknown identifiers without assigning a canonical modality', () => {
    const unknown = workoutFor('future_modal_xyz');
    expect(validateTrainingTypedWorkout(unknown)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TYPED_PRESCRIPTION_COMPATIBILITY' }),
    ]));
    expect(resolveTrainingWorkoutCapability(unknown.sessionType)).toMatchObject({
      canonical: false,
      presentationFamily: 'unknown',
      presentationLabel: 'Unknown workout type',
      milestone1GenerationEnabled: false,
    });

    const mislabeled = structuredClone(unknown);
    mislabeled.blocks[0].prescription = prescriptionFor('strength', 'strength_hypertrophy');
    expect(() => validateTrainingTypedWorkout(mislabeled))
      .toThrow(/TYPED_UNKNOWN_PRESCRIPTION_REQUIRED/);

    const canonicalWithUnknown = workoutFor('easy_run');
    canonicalWithUnknown.blocks[0].prescription = prescriptionFor('unknown', 'easy_run');
    expect(() => validateTrainingTypedWorkout(canonicalWithUnknown))
      .toThrow(/TYPED_CANONICAL_UNKNOWN_PRESCRIPTION_FORBIDDEN|TYPED_SESSION_PRESCRIPTION_MISMATCH/);
  });

  it('rejects a canonical session whose primary prescription belongs to another modality', () => {
    const run = workoutFor('easy_run');
    run.blocks[0].prescription = prescriptionFor('strength', 'strength_hypertrophy');
    expect(() => validateTrainingTypedWorkout(run)).toThrow(/TYPED_SESSION_PRESCRIPTION_MISMATCH/);

    const brick = workoutFor('brick');
    const mixed = brick.blocks[0].prescription;
    if (mixed.kind !== 'mixed_session') throw new Error('Brick fixture must be mixed.');
    mixed.segments[0].prescription = prescriptionFor('strength', 'strength_hypertrophy');
    expect(() => validateTrainingTypedWorkout(brick))
      .toThrow(/TYPED_MIXED_SEGMENT_MODALITY_MISMATCH/);
  });

  it('enforces ordered blocks, duration conservation and protected primary work', () => {
    const workout = workoutFor('threshold_run');
    workout.blocks[0].position = 2;
    workout.blocks[0].plannedDurationMinutes = 29;
    expect(() => validateTrainingTypedWorkout(workout)).toThrow(
      /TYPED_BLOCK_ORDERING_OR_BOUNDS|TYPED_WORKOUT_DURATION_CONSERVATION/,
    );

    const optionalPrimary = workoutFor('strength_max');
    optionalPrimary.blocks[0].priority = 'OPTIONAL';
    expect(() => validateTrainingTypedWorkout(optionalPrimary))
      .toThrow(/TYPED_ESSENTIAL_BLOCK_REQUIRED|TYPED_PRIMARY_OBJECTIVE_BLOCK_REQUIRED/);
  });

  it('fails closed on invalid bounds for every prescription family', () => {
    const cases: Array<{
      sessionType: SessionType | string;
      prescription: TrainingTypedWorkoutPrescription;
      code: string;
    }> = [
      {
        sessionType: 'strength_hypertrophy',
        prescription: { ...prescriptionFor('strength', 'strength_hypertrophy'), sets: 0 } as TrainingTypedWorkoutPrescription,
        code: 'TYPED_STRENGTH_PRESCRIPTION_INVALID',
      },
      {
        sessionType: 'easy_run',
        prescription: { kind: 'steady_endurance', effortZone: 'Zone 2' },
        code: 'TYPED_ENDURANCE_PRESCRIPTION_INVALID',
      },
      {
        sessionType: 'interval_run',
        prescription: { kind: 'intervals', repetitions: 6, workDurationSeconds: 60, targetIntensity: 'VO2' },
        code: 'TYPED_INTERVAL_PRESCRIPTION_INVALID',
      },
      {
        sessionType: 'mobility',
        prescription: { kind: 'mobility', sequenceRounds: 0, durationSecondsPerSide: 30, rangeGuidance: 'Controlled' },
        code: 'TYPED_MOBILITY_PRESCRIPTION_INVALID',
      },
      {
        sessionType: 'technique_swim',
        prescription: { kind: 'swimming', totalDistanceMeters: 0, stroke: 'Freestyle', repetitions: 4, targetIntensity: 'Easy' },
        code: 'TYPED_SWIMMING_PRESCRIPTION_INVALID',
      },
      {
        sessionType: 'endurance_ride',
        prescription: { kind: 'cycling', effortZone: 'Zone 2' },
        code: 'TYPED_CYCLING_PRESCRIPTION_INVALID',
      },
      {
        sessionType: 'brick',
        prescription: {
          kind: 'mixed_session',
          segments: [{
            position: 1, modality: 'RUNNING', transitionAfterSeconds: 0,
            prescription: { kind: 'steady_endurance', durationMinutes: 20, effortZone: 'Zone 2' },
          }],
        },
        code: 'TYPED_MIXED_PRESCRIPTION_INVALID',
      },
      {
        sessionType: 'rest',
        prescription: { kind: 'recovery', durationMinutes: -1, effortGuidance: 'Rest' },
        code: 'TYPED_RECOVERY_PRESCRIPTION_INVALID',
      },
      {
        sessionType: 'future_modal_xyz',
        prescription: {
          kind: 'unknown', rawPrescriptionType: 'future_modal_xyz', summary: '', newlyPrescribable: false,
        },
        code: 'TYPED_UNKNOWN_PRESCRIPTION_INVALID',
      },
    ];

    for (const item of cases) {
      const workout = workoutFor(item.sessionType);
      workout.blocks[0].prescription = item.prescription;
      expect(() => validateTrainingTypedWorkout(workout), item.code).toThrow(item.code);
    }
  });

  it('enforces phase ordering, week contiguity and exact workout phase binding', () => {
    const document = periodizedDocument();
    expect(validateTrainingTypedPlanDocument(document)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TYPED_PHASE_AND_WEEK_CONTIGUITY' }),
      expect.objectContaining({ code: 'TYPED_CANONICAL_SESSION_COVERAGE' }),
    ]));

    const phaseGap = structuredClone(document);
    phaseGap.phases[1].startWeek = 3;
    expect(() => validateTrainingTypedPlanDocument(phaseGap))
      .toThrow(/TYPED_PHASE_ORDER_AND_CONTIGUITY|TYPED_PHASE_HORIZON_COVERAGE/);

    const wrongBinding = structuredClone(document);
    wrongBinding.weeks[1].workouts[0].phaseKey = 'phase-base';
    expect(() => validateTrainingTypedPlanDocument(wrongBinding))
      .toThrow(/TYPED_WORKOUT_PHASE_BINDING/);

    const duplicateWorkout = structuredClone(document);
    duplicateWorkout.weeks[1].workouts[0].workoutKey = duplicateWorkout.weeks[0].workouts[0].workoutKey;
    expect(() => validateTrainingTypedPlanDocument(duplicateWorkout))
      .toThrow(/TYPED_UNIQUE_WORKOUT_KEYS/);
  });

  it('omits phase UI semantics for standalone and non-periodized workouts', () => {
    const standalone = workoutFor('mobility');
    expect(() => validateTrainingTypedWorkout(standalone)).not.toThrow();
    standalone.phaseKey = 'fabricated-recovery-phase';
    expect(() => validateTrainingTypedWorkout(standalone))
      .toThrow(/TYPED_STANDALONE_PHASE_FORBIDDEN/);

    const nonPeriodized: TrainingTypedPlanValidationDocument = {
      sourceDocumentSchemaVersion: 'standalone-plan.v1',
      periodization: 'NON_PERIODIZED',
      horizonWeeks: 1,
      phases: [],
      weeks: [{
        weekNumber: 1,
        phaseKey: null,
        workouts: [{ ...workoutFor('mobility'), isStandalone: false }],
      }],
    };
    expect(() => validateTrainingTypedPlanDocument(nonPeriodized)).not.toThrow();
    nonPeriodized.phases = [phase('phase-invented', 'RECOVERY', 1, 1, 1)];
    expect(() => validateTrainingTypedPlanDocument(nonPeriodized))
      .toThrow(/TYPED_NON_PERIODIZED_PHASE_OMISSION/);
  });
});

function workoutFor(sessionType: SessionType | string): TrainingTypedWorkout {
  const capability = resolveTrainingWorkoutCapability(sessionType);
  const canonical = capability.canonical;
  const kind = canonical
    ? TRAINING_TYPED_PRIMARY_PRESCRIPTIONS_BY_SESSION_TYPE[sessionType as SessionType][0]
    : 'unknown';
  const rest = sessionType === 'rest';
  const duration = rest ? 0 : 30;
  return {
    workoutKey: `fixture-${sessionType}`,
    dayOfWeek: 'monday',
    title: canonical ? capability.presentationLabel : 'Unknown workout type',
    sessionType,
    sessionTypeClassification: canonical ? 'CANONICAL' : 'UNKNOWN',
    objective: canonical ? 'Deliver the declared session objective.' : 'Preserve the supplied workout without inventing a modality.',
    plannedDurationMinutes: duration,
    isStandalone: true,
    phaseKey: null,
    blocks: [{
      blockId: rest ? 'recovery' : 'primary',
      position: 1,
      blockType: rest ? 'COOLDOWN_RECOVERY' : 'PRIMARY_WORK',
      purpose: rest ? 'No prescribed training work.' : 'Deliver the primary objective.',
      priority: 'ESSENTIAL',
      minimumDurationMinutes: duration,
      plannedDurationMinutes: duration,
      prescription: prescriptionFor(kind, sessionType),
    }],
  };
}

function prescriptionFor(
  kind: TrainingTypedPrescriptionKind,
  rawSessionType: string,
): TrainingTypedWorkoutPrescription {
  switch (kind) {
    case 'strength':
      return {
        kind, sets: 3, repetitions: '6–10', loadGuidance: 'Use a controllable load.',
        targetRpe: 8, targetRir: 2, tempo: '2-0-1-0', restSeconds: 120,
      };
    case 'steady_endurance':
      return { kind, durationMinutes: 30, paceGuidance: 'Controlled pace', effortZone: 'Zone 2', terrain: 'Flat' };
    case 'intervals':
      return {
        kind, repetitions: 6, workDurationSeconds: 180, recoveryDurationSeconds: 90,
        targetIntensity: 'Threshold',
      };
    case 'mobility':
      return {
        kind, sequenceRounds: 2, sequenceName: 'Controlled mobility sequence', side: 'BOTH',
        durationSecondsPerSide: 30, rangeGuidance: 'Pain-free controlled range.',
      };
    case 'swimming':
      return {
        kind, totalDistanceMeters: 1_200, stroke: 'Freestyle', drill: 'Catch-up drill',
        repetitions: 6, restSeconds: 30, targetIntensity: 'Aerobic',
      };
    case 'cycling':
      return {
        kind, durationMinutes: 45, powerGuidance: '65–75% FTP', effortZone: 'Zone 2',
        cadenceRpm: 90, terrain: 'Trainer or flat road',
      };
    case 'mixed_session':
      return {
        kind,
        segments: [
          {
            position: 1, modality: 'CYCLING', transitionAfterSeconds: 120,
            prescription: { kind: 'cycling', durationMinutes: 40, effortZone: 'Zone 2' },
          },
          {
            position: 2, modality: 'RUNNING', transitionAfterSeconds: 0,
            prescription: { kind: 'steady_endurance', durationMinutes: 20, effortZone: 'Zone 2' },
          },
        ],
      };
    case 'recovery':
      return { kind, durationMinutes: 0, effortGuidance: 'Rest with normal daily movement only.' };
    case 'unknown':
      return {
        kind, rawPrescriptionType: rawSessionType,
        summary: 'Generic prescription retained without assigning a known modality.',
        newlyPrescribable: false,
      };
  }
}

function periodizedDocument(): TrainingTypedPlanValidationDocument {
  const baseWorkout = {
    ...workoutFor('easy_run'),
    workoutKey: 'week-1-easy-run',
    isStandalone: false,
    phaseKey: 'phase-base',
  };
  const buildWorkout = {
    ...workoutFor('interval_run'),
    workoutKey: 'week-2-interval-run',
    isStandalone: false,
    phaseKey: 'phase-build',
  };
  return {
    sourceDocumentSchemaVersion: 'training-plan-revision.v1',
    periodization: 'PERIODIZED',
    horizonWeeks: 2,
    phases: [
      phase('phase-base', 'BASE', 1, 1, 1),
      phase('phase-build', 'BUILD', 2, 2, 2),
    ],
    weeks: [
      { weekNumber: 1, phaseKey: 'phase-base', workouts: [baseWorkout] },
      { weekNumber: 2, phaseKey: 'phase-build', workouts: [buildWorkout] },
    ],
  };
}

function phase(
  phaseKey: string,
  phaseType: TrainingTypedPhase['phaseType'],
  position: number,
  startWeek: number,
  endWeek: number,
): TrainingTypedPhase {
  return {
    phaseKey,
    phaseType,
    position,
    startWeek,
    endWeek,
    durationWeeks: endWeek - startWeek + 1,
    purpose: 'Deliver this phase objective.',
    progressionDirection: 'Progress one bounded variable.',
    recoveryOrLighterPeriod: phaseType === 'RECOVERY' || phaseType === 'DELOAD',
    transitionExplanation: 'Advance after the reviewed phase exposure.',
    profileFitExplanation: 'The duration matches the selected horizon.',
  };
}
