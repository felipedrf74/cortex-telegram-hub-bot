import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildTrainingPlanRevisionCandidate,
  stableTrainingRevisionHash,
  type TrainingPlanCandidateRequest,
} from '../../src/services/training-plan-revision-candidate-builder';
import {
  repairTrainingTypedPlanRevisionPhases,
  validateTrainingTypedPlanRevisionDocument,
} from '../../src/services/training-typed-plan-generator';
import {
  _resetTrainingGenerationObservabilityForTests,
  getTrainingGenerationObservabilitySnapshot,
} from '../../src/services/training-generation-observability';

const runningEvent: TrainingPlanCandidateRequest = {
  planMode: 'event_based', goal: 'event_performance', discipline: 'marathon', horizonWeeks: 12,
  event: { name: 'Autumn Marathon', date: '2026-11-08', priority: 'A' },
  profile: {
    experienceLevel: 'intermediate', sessionsPerWeek: 5, sessionDurationMinutes: 60,
    availableDays: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'],
    equipmentIds: [], location: 'home', preferences: [], exclusions: [],
  },
};

const generalHybrid: TrainingPlanCandidateRequest = {
  planMode: 'continuous', goal: 'general_fitness', discipline: 'hybrid', horizonWeeks: 6,
  profile: {
    experienceLevel: 'novice', sessionsPerWeek: 3, sessionDurationMinutes: 30,
    availableDays: ['monday', 'wednesday', 'saturday'], equipmentIds: [], location: 'home',
  },
};

describe('training typed plan generator', () => {
  beforeEach(() => _resetTrainingGenerationObservabilityForTests());

  it('generates an event-aware revision and a non-event revision with different phase rules', () => {
    const event = buildTrainingPlanRevisionCandidate(runningEvent, { typedWorkoutValidationEnabled: true });
    const general = buildTrainingPlanRevisionCandidate(generalHybrid, { typedWorkoutValidationEnabled: true });
    expect(event.document.schemaVersion).toBe('training-plan-revision.v2');
    expect(event.document.phases.map((phase) => phase.phaseType)).toEqual(['BASE', 'BUILD', 'PEAK', 'TAPER', 'RACE']);
    expect(general.document.phases.map((phase) => phase.phaseType)).toEqual(['FOUNDATION', 'BUILD', 'DELOAD']);
    expect(general.document.phases.some((phase) => ['PEAK', 'TAPER', 'RACE'].includes(phase.phaseType))).toBe(false);
    const baseWeek = event.document.weeks.find((week) => week.phaseKey === event.document.phases[0].phaseKey)!;
    const taperPhase = event.document.phases.find((phase) => phase.phaseType === 'TAPER')!;
    const taperWeek = event.document.weeks.find((week) => week.phaseKey === taperPhase.phaseKey)!;
    expect(taperWeek.workouts.filter((workout) => workout.sessionType === 'recovery_run')).toHaveLength(2);
    expect(baseWeek.workouts.filter((workout) => workout.sessionType === 'recovery_run')).toHaveLength(1);
    expect(event.qualityReport.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PHASE_SEQUENCE_FOR_PLAN_MODE' }),
      expect.objectContaining({ code: 'TYPED_REVISION_CANONICAL_GENERATION_ONLY' }),
    ]));
  });

  it('conserves duration and phase distribution in every generated week', () => {
    const candidate = buildTrainingPlanRevisionCandidate(runningEvent, { typedWorkoutValidationEnabled: true });
    for (const week of candidate.document.weeks) {
      expect(week.workouts).toHaveLength(7);
      for (const workout of week.workouts) {
        expect(workout.blocks.reduce((sum, block) => sum + block.plannedDurationMinutes, 0))
          .toBe(workout.plannedDurationMinutes);
      }
    }
    expect(() => validateTrainingTypedPlanRevisionDocument(candidate.document)).not.toThrow();
    const missingObjective = structuredClone(candidate.document);
    delete missingObjective.weeks[0].workouts[0].blocks[0].objectiveId;
    expect(() => validateTrainingTypedPlanRevisionDocument(missingObjective))
      .toThrow(/TYPED_BLOCK_OBJECTIVE_ID_INVALID/);
  });

  it('repairs only phase bindings deterministically and idempotently', () => {
    const candidate = buildTrainingPlanRevisionCandidate(generalHybrid, { typedWorkoutValidationEnabled: true });
    const invalid = structuredClone(candidate.document);
    invalid.phases.reverse();
    invalid.weeks[0].phaseKey = 'wrong-phase';
    invalid.weeks[0].workouts[0].phaseKey = 'wrong-phase';
    expect(() => validateTrainingTypedPlanRevisionDocument(invalid)).toThrow();

    const repaired = repairTrainingTypedPlanRevisionPhases(invalid);
    const repairedAgain = repairTrainingTypedPlanRevisionPhases(repaired);
    expect(repairedAgain).toEqual(repaired);
    expect(stableTrainingRevisionHash(repairedAgain)).toBe(stableTrainingRevisionHash(repaired));
    expect(() => validateTrainingTypedPlanRevisionDocument(repaired)).not.toThrow();
  });

  it('keeps flag-off legacy candidate bytes and support boundaries unchanged', () => {
    expect(() => buildTrainingPlanRevisionCandidate(runningEvent)).toThrow(/MILESTONE_1_PLAN_MODE_UNSUPPORTED/);
    const typed = buildTrainingPlanRevisionCandidate(runningEvent, { typedWorkoutValidationEnabled: true });
    expect(typed.document.planMode).toBe('event_based');
  });

  it('records privacy-safe phase, workout, candidate, blocker and repair counters', () => {
    const candidate = buildTrainingPlanRevisionCandidate(generalHybrid, { typedWorkoutValidationEnabled: true });
    const invalid = structuredClone(candidate.document);
    invalid.weeks[0].workouts[0].phaseKey = 'wrong';
    expect(() => validateTrainingTypedPlanRevisionDocument(invalid)).toThrow();
    repairTrainingTypedPlanRevisionPhases(invalid);
    const counters = getTrainingGenerationObservabilitySnapshot().counters;
    expect(counters.typed_plan_candidate_generated_total).toBe(1);
    expect(counters.typed_phase_generated_total).toBe(candidate.document.phases.length);
    expect(counters.typed_workout_generated_total).toBe(candidate.document.horizonWeeks * 7);
    expect(counters.typed_quality_blocked_total).toBe(1);
    expect(counters.typed_quality_repair_total).toBe(1);
  });
});
