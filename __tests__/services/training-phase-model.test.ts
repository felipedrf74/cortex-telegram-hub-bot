import { describe, expect, it } from 'vitest';
import {
  buildTrainingPhaseModel,
  blockPhaseFromTrainingPhaseType,
  repairTrainingPhaseModel,
  trainingPhaseTypeFromWeekIntent,
  validateTrainingPhaseModel,
  type TrainingPhaseModelInput,
} from '../../src/services/training-phase-model';

const distribution = [
  { sessionType: 'easy_run' as const, targetPerWeek: 2 },
  { sessionType: 'long_run' as const, targetPerWeek: 1 },
  { sessionType: 'threshold_run' as const, targetPerWeek: 1 },
  { sessionType: 'rest' as const, targetPerWeek: 3 },
];

describe('training phase model', () => {
  it('builds the event sequence with contiguous base, build, peak, taper and race phases', () => {
    const input: TrainingPhaseModelInput = {
      planMode: 'event_based', discipline: 'marathon', experienceLevel: 'intermediate',
      sessionsPerWeek: 4, horizonWeeks: 12, targetWorkoutTypeDistribution: distribution,
    };
    const phases = buildTrainingPhaseModel(input);
    expect(phases.map((phase) => phase.phaseType)).toEqual(['BASE', 'BUILD', 'PEAK', 'TAPER', 'RACE']);
    expect(phases[0].startWeek).toBe(1);
    expect(phases.at(-1)?.endWeek).toBe(12);
    expect(phases.filter((phase) => phase.recoveryOrLighterPeriod).map((phase) => phase.phaseType))
      .toEqual(['TAPER', 'RACE']);
    const count = (phaseIndex: number, sessionType: string) => phases[phaseIndex]
      .targetWorkoutTypeDistribution?.find((target) => target.sessionType === sessionType)?.targetPerWeek ?? 0;
    expect(count(0, 'recovery_run')).toBe(0);
    expect(count(3, 'recovery_run')).toBe(1);
    expect(count(4, 'recovery_run')).toBe(2);
    expect(count(4, 'threshold_run')).toBe(0);
    expect(validateTrainingPhaseModel(input, phases)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PHASE_SEQUENCE_FOR_PLAN_MODE' }),
      expect.objectContaining({ code: 'PHASE_PURPOSE_TRANSITION_PROFILE_FIT' }),
    ]));
  });

  it('keeps non-event plans free of peak, taper and race phases', () => {
    const input: TrainingPhaseModelInput = {
      planMode: 'continuous', discipline: 'hybrid', experienceLevel: 'novice',
      sessionsPerWeek: 3, horizonWeeks: 6, targetWorkoutTypeDistribution: distribution,
    };
    const phases = buildTrainingPhaseModel(input);
    expect(phases.map((phase) => phase.phaseType)).toEqual(['FOUNDATION', 'BUILD', 'DELOAD']);
    const invalid = structuredClone(phases);
    invalid[1].phaseType = 'RACE';
    expect(() => validateTrainingPhaseModel(input, invalid))
      .toThrow(/PHASE_SEQUENCE_FOR_PLAN_MODE|NON_EVENT_RACE_PHASE_FORBIDDEN/);
  });

  it('repairs deterministically and idempotently from normalized inputs', () => {
    const input: TrainingPhaseModelInput = {
      planMode: 'return_to_training', discipline: 'cycling', experienceLevel: 'novice',
      sessionsPerWeek: 3, horizonWeeks: 5, targetWorkoutTypeDistribution: distribution,
    };
    const first = repairTrainingPhaseModel(input);
    const second = repairTrainingPhaseModel(input);
    expect(second).toEqual(first);
    expect(validateTrainingPhaseModel(input, second)).toBeTruthy();
  });

  it('uses an explicit maintenance and recovery sequence for maintenance plans', () => {
    const input: TrainingPhaseModelInput = {
      planMode: 'maintenance', discipline: 'swimming', experienceLevel: 'advanced',
      sessionsPerWeek: 4, horizonWeeks: 4, targetWorkoutTypeDistribution: distribution,
    };
    expect(buildTrainingPhaseModel(input).map((phase) => phase.phaseType))
      .toEqual(['MAINTENANCE', 'RECOVERY']);
  });

  it('consolidates legacy WeekIntent and BlockPhase semantics through one canonical bridge', () => {
    expect(trainingPhaseTypeFromWeekIntent('accumulation')).toBe('BASE');
    expect(trainingPhaseTypeFromWeekIntent('intensification')).toBe('BUILD');
    expect(trainingPhaseTypeFromWeekIntent('realization')).toBe('PEAK');
    expect(trainingPhaseTypeFromWeekIntent('post_race_recovery')).toBe('RECOVERY');
    expect(blockPhaseFromTrainingPhaseType('RECOVERY')).toBe('deload');
    expect(blockPhaseFromTrainingPhaseType('MAINTENANCE')).toBe('maintenance');
  });
});
