import { describe, expect, it } from 'vitest';
import { buildTrainingPlanRevisionReviewReadModel } from '../../src/services/training-plan-revision-read-model';

describe('training plan revision review read model', () => {
  it('maps typed phase and block snapshots for review', () => {
    const model = buildTrainingPlanRevisionReviewReadModel({
      revisionId: 'trpr_typed',
      documentSchemaVersion: 'training-plan-revision.v2',
      document: {
        horizonWeeks: 1,
        phases: [{
          phaseKey: 'phase-foundation', phaseType: 'FOUNDATION', position: 1,
          startWeek: 1, endWeek: 1, durationWeeks: 1, purpose: 'Establish capacity.',
          progressionDirection: 'Progress consistency.', recoveryOrLighterPeriod: false,
          transitionExplanation: 'Review before the next phase.', profileFitExplanation: 'Fits the profile.',
          targetWorkoutTypeDistribution: [{ sessionType: 'easy_run', targetPerWeek: 1 }],
        }],
        weeks: [{
          weekNumber: 1, phaseKey: 'phase-foundation', workouts: [{
            workoutKey: 'w1', sessionType: 'easy_run', plannedDurationMinutes: 30,
            phaseKey: 'phase-foundation', blocks: [{ blockId: 'primary' }],
          }],
        }],
      },
    });
    expect(model).toMatchObject({
      presentationMode: 'TYPED', horizonWeeks: 1,
      phases: [{ purpose: 'Establish capacity.', targetWorkoutTypeDistribution: [{ sessionType: 'easy_run', targetPerWeek: 1 }] }],
      weeks: [{ workouts: [{ sessionTypeClassification: 'CANONICAL', presentationFamily: 'running', fallbackUsed: false }] }],
    });
  });

  it('does not invent purpose or transition data for legacy rows and keeps unknown identifiers honest', () => {
    const model = buildTrainingPlanRevisionReviewReadModel({
      revisionId: 'trpr_legacy',
      documentSchemaVersion: 'legacy-training-plan.v1',
      document: {
        horizonWeeks: 1,
        phases: [{
          phaseKey: 'legacy-phase', phaseType: 'base', position: 1,
          startWeek: 1, endWeek: 1, durationWeeks: 1,
        }],
        weeks: [{ weekNumber: 1, phaseKey: 'legacy-phase', workouts: [{ sessionType: 'future_modal_xyz' }] }],
      },
    });
    expect(model.presentationMode).toBe('UNKNOWN_FALLBACK');
    expect(model.phases[0]).toMatchObject({
      purpose: null, progressionDirection: null, transitionExplanation: null, profileFitExplanation: null,
    });
    expect(model.weeks[0].workouts[0]).toMatchObject({
      sessionType: 'future_modal_xyz', sessionTypeClassification: 'UNKNOWN',
      presentationFamily: 'unknown', presentationLabel: 'Unknown workout type',
      fallbackUsed: true, newlyPrescribable: false,
    });
  });

  it('exposes an additive dropped disposition for reviewed immutable reflows', () => {
    const model = buildTrainingPlanRevisionReviewReadModel({
      revisionId: 'trpr_dropped',
      documentSchemaVersion: 'training-plan-revision.v2',
      document: {
        weeks: [{
          weekNumber: 1,
          workouts: [{
            workoutKey: 'w-drop',
            sessionType: 'strength_maintenance',
            executionDisposition: { state: 'DROPPED', reasonCode: 'minimum_viable_week' },
            executionAdaptations: [{ actionType: 'drop_session', reasonCode: 'minimum_viable_week' }],
            blocks: [{ blockId: 'primary' }],
          }],
        }],
      },
    });

    expect(model.weeks[0].workouts[0].executionDisposition).toEqual({
      state: 'DROPPED',
      reasonCode: 'minimum_viable_week',
    });
    expect(model.weeks[0].workouts[0].executionAdaptations).toEqual([{
      actionType: 'drop_session',
      reasonCode: 'minimum_viable_week',
    }]);
  });
});
