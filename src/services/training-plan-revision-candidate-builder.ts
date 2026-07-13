// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { loadCoachKnowledge } from './coach-kernel/knowledge-loader';
import {
  selectStrengthExercisesFromCatalog,
  STRENGTH_SELECTOR_POLICY_VERSION,
  type StrengthSelectorProfile,
} from './coach-kernel/strength-selector';
import type {
  AthleteState,
  CoachingDiscipline,
  DayOfWeek,
  Exercise,
  SessionType,
} from './coach-kernel/types';
import { buildRepoTrainingCatalogSnapshot } from './coach-kernel/training-catalog';
import type { TrainingPlanMode } from './training-workout-capability-registry';
import {
  TRAINING_TYPED_WORKOUT_VALIDATOR_VERSION,
  validateTrainingTypedPlanDocument,
  type TrainingTypedPhaseType,
  type TrainingTypedPlanValidationDocument,
  type TrainingTypedStrengthExercisePrescription,
  type TrainingTypedWorkoutBlock,
  type TrainingTypedWorkoutBlockPriority,
  type TrainingTypedWorkoutPrescription,
} from './training-typed-workout-v1';
import {
  buildTrainingTypedPlanRevision,
  validateTrainingTypedPlanRevisionDocument,
} from './training-typed-plan-generator';

export const TRAINING_PLAN_REVISION_DOCUMENT_SCHEMA = 'training-plan-revision.v1' as const;
export const TRAINING_TYPED_PLAN_REVISION_DOCUMENT_SCHEMA = 'training-plan-revision.v2' as const;
export const TRAINING_PLAN_REVISION_POLICY_VERSION = 'training-plan-revision-m1-policy.v1' as const;
export const TRAINING_TYPED_PLAN_REVISION_POLICY_VERSION = 'training-plan-revision-m2-policy.v1' as const;
export const TRAINING_WORKOUT_CAPABILITY_REGISTRY_VERSION = 'training-workout-capabilities.v1' as const;

export type TrainingExperienceLevel = 'novice' | 'intermediate' | 'advanced';
export type TrainingLocation = 'home' | 'gym';
export type TrainingWorkoutBlockPriority = TrainingTypedWorkoutBlockPriority;
export type TrainingPhaseType = TrainingTypedPhaseType;
export type TrainingWorkoutPrescription = TrainingTypedWorkoutPrescription;
export type TrainingPlanExercisePrescription = TrainingTypedStrengthExercisePrescription;
export type TrainingPlanWorkoutBlock = TrainingTypedWorkoutBlock;

export interface TrainingPlanCandidateRequest {
  planMode: TrainingPlanMode;
  goal: 'general_fitness' | 'event_performance' | 'maintenance' | 'return_to_training';
  discipline: CoachingDiscipline;
  horizonWeeks?: number;
  event?: {
    name: string;
    date?: string;
    priority?: 'A' | 'B' | 'C';
  };
  profile: {
    experienceLevel: TrainingExperienceLevel;
    sessionsPerWeek: number;
    sessionDurationMinutes: number;
    availableDays: DayOfWeek[];
    equipmentIds: string[];
    location: TrainingLocation;
    preferences?: string[];
    exclusions?: string[];
  };
}

export interface TrainingPlanRevisionWorkout {
  workoutKey: string;
  dayOfWeek: DayOfWeek;
  title: string;
  sessionType: SessionType | string;
  sessionTypeClassification?: 'CANONICAL' | 'UNKNOWN';
  objective: string;
  plannedDurationMinutes: number;
  isStandalone?: boolean;
  phaseKey?: string | null;
  blocks: TrainingPlanWorkoutBlock[];
}

export interface TrainingPlanRevisionDocument {
  schemaVersion: typeof TRAINING_PLAN_REVISION_DOCUMENT_SCHEMA | typeof TRAINING_TYPED_PLAN_REVISION_DOCUMENT_SCHEMA;
  planMode: TrainingPlanMode;
  goal: TrainingPlanCandidateRequest['goal'];
  discipline: CoachingDiscipline;
  periodization?: 'PERIODIZED' | 'NON_PERIODIZED';
  profileSummary?: {
    experienceLevel: TrainingExperienceLevel;
    sessionsPerWeek: number;
  };
  event?: TrainingPlanCandidateRequest['event'];
  title: string;
  horizonWeeks: number;
  weeklyStructure: {
    targetSessionsPerWeek: number;
    sessionDurationMinutes: number;
    availableDays: DayOfWeek[];
    targetWorkoutTypeDistribution: Array<{ sessionType: SessionType; targetPerWeek: number }>;
  };
  phases: Array<{
    phaseKey: string;
    phaseType: TrainingPhaseType;
    position: number;
    startWeek: number;
    endWeek: number;
    durationWeeks: number;
    purpose: string;
    progressionDirection: string;
    recoveryOrLighterPeriod: boolean;
    transitionExplanation: string;
    profileFitExplanation: string;
    targetWorkoutTypeDistribution?: Array<{ sessionType: SessionType; targetPerWeek: number }>;
    profileFitInputs?: string[];
  }>;
  progression: { direction: string; rule: string };
  recovery: { strategy: string; placement: string };
  weeks: Array<{
    weekKey: string;
    weekNumber: number;
    phaseKey: string;
    loadDirection: 'BASELINE' | 'INCREASE' | 'REDUCE';
    workouts: TrainingPlanRevisionWorkout[];
  }>;
  assumptions: string[];
  missingInputs: string[];
}

export interface TrainingPlanCausalFactor {
  inputKey: string;
  inputValue: string | number | string[];
  materialEffects: string[];
}

export interface BuiltTrainingPlanRevisionCandidate {
  document: TrainingPlanRevisionDocument;
  contentHash: string;
  creationContextVersion: string;
  catalogVersion: string;
  catalogSourceHash: string;
  selectorPolicyVersion: string;
  policyVersion: typeof TRAINING_PLAN_REVISION_POLICY_VERSION | typeof TRAINING_TYPED_PLAN_REVISION_POLICY_VERSION;
  capabilityRegistryVersion: typeof TRAINING_WORKOUT_CAPABILITY_REGISTRY_VERSION;
  causalFactors: TrainingPlanCausalFactor[];
  qualityReport: {
    status: 'PASS';
    checks: Array<{ code: string; status: 'PASS'; evidence: string }>;
  };
}

export interface TrainingPlanRevisionQualityCheck {
  code: string;
  status: 'PASS';
  evidence: string;
}

export interface TrainingPlanCandidateBuildOptions {
  typedWorkoutValidationEnabled?: boolean;
}

const DAY_ORDER: DayOfWeek[] = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

export function buildTrainingPlanRevisionCandidate(
  request: TrainingPlanCandidateRequest,
  options: TrainingPlanCandidateBuildOptions = {},
): BuiltTrainingPlanRevisionCandidate {
  const knowledge = loadCoachKnowledge();
  const catalog = buildRepoTrainingCatalogSnapshot(knowledge);
  const normalized = validateAndNormalizeRequest(
    request,
    catalog,
    options.typedWorkoutValidationEnabled === true,
  );
  if (options.typedWorkoutValidationEnabled) {
    const typed = buildTrainingTypedPlanRevision(normalized);
    const contentHash = stableTrainingRevisionHash(typed.document);
    return {
      document: typed.document,
      contentHash,
      creationContextVersion: `ctx_${stableTrainingRevisionHash({
        request: normalized,
        catalogVersion: catalog.catalogVersion,
        catalogSourceHash: catalog.sourceHash,
        policyVersion: TRAINING_TYPED_PLAN_REVISION_POLICY_VERSION,
        typedWorkoutValidatorVersion: TRAINING_TYPED_WORKOUT_VALIDATOR_VERSION,
        typedPlanGeneratorVersion: 'training-typed-plan-generator.v1',
      }).slice(0, 32)}`,
      catalogVersion: catalog.catalogVersion,
      catalogSourceHash: catalog.sourceHash,
      selectorPolicyVersion: typed.selectorPolicyVersion,
      policyVersion: TRAINING_TYPED_PLAN_REVISION_POLICY_VERSION,
      capabilityRegistryVersion: TRAINING_WORKOUT_CAPABILITY_REGISTRY_VERSION,
      causalFactors: typed.causalFactors,
      qualityReport: {
        status: 'PASS',
        checks: [
          ...typed.qualityChecks,
          { code: 'CAUSAL_PERSONALIZATION', status: 'PASS', evidence: `${typed.causalFactors.length} explicit input-to-output mappings` },
        ],
      },
    };
  }
  const horizonWeeks = normalized.horizonWeeks;
  const phaseSpecs = buildPhases(horizonWeeks, normalized.profile.experienceLevel);
  const causalFactors = buildCausalFactors(normalized);
  const weeks = Array.from({ length: horizonWeeks }, (_, index) => {
    const weekNumber = index + 1;
    const phase = phaseSpecs.find((entry) => weekNumber >= entry.startWeek && weekNumber <= entry.endWeek)!;
    return {
      weekKey: `week-${weekNumber}`,
      weekNumber,
      phaseKey: phase.phaseKey,
      loadDirection: phase.phaseType === 'DELOAD'
        ? 'REDUCE' as const
        : weekNumber === 1 ? 'BASELINE' as const : 'INCREASE' as const,
      workouts: buildWeekWorkouts({
        request: normalized,
        weekIndex: index,
        phaseType: phase.phaseType,
        library: knowledge.exercises,
      }),
    };
  });

  const strengthPerWeek = Math.max(1, normalized.profile.sessionsPerWeek - 1);
  const document: TrainingPlanRevisionDocument = {
    schemaVersion: TRAINING_PLAN_REVISION_DOCUMENT_SCHEMA,
    planMode: 'continuous',
    goal: 'general_fitness',
    discipline: 'strength',
    title: normalized.profile.experienceLevel === 'novice'
      ? 'General Fitness Foundations'
      : 'General Fitness Build',
    horizonWeeks,
    weeklyStructure: {
      targetSessionsPerWeek: normalized.profile.sessionsPerWeek,
      sessionDurationMinutes: normalized.profile.sessionDurationMinutes,
      availableDays: normalized.profile.availableDays,
      targetWorkoutTypeDistribution: [
        { sessionType: 'strength_hypertrophy', targetPerWeek: Math.max(1, strengthPerWeek - 1) },
        { sessionType: 'strength_maintenance', targetPerWeek: 1 },
        { sessionType: 'mobility', targetPerWeek: 1 },
        { sessionType: 'rest', targetPerWeek: 7 - normalized.profile.sessionsPerWeek },
      ],
    },
    phases: phaseSpecs,
    progression: normalized.profile.experienceLevel === 'novice'
      ? {
        direction: 'Technique consistency, then gradual repetition volume',
        rule: 'Hold load guidance stable until prescribed repetitions remain controlled.',
      }
      : {
        direction: 'Load and set-volume progression with exercise-complexity continuity',
        rule: 'Increase one bounded variable per build week; preserve movement families.',
      },
    recovery: normalized.profile.sessionsPerWeek <= 3
      ? {
        strategy: 'Recovery between every training day',
        placement: 'Training days remain non-consecutive where availability allows; final week deloads.',
      }
      : {
        strategy: 'Midweek recovery plus end-of-cycle deload',
        placement: 'Higher-frequency pairs are separated by mobility or rest; final week deloads.',
      },
    weeks,
    assumptions: [
      'No acute health condition is inferred from the supplied profile.',
      'Only explicitly supplied equipment is considered available.',
    ],
    missingInputs: [],
  };
  const qualityChecks = validateTrainingPlanRevisionDocument(document, options);
  const contentHash = stableTrainingRevisionHash(document);
  return {
    document,
    contentHash,
    creationContextVersion: `ctx_${stableTrainingRevisionHash({
      request: normalized,
      catalogVersion: catalog.catalogVersion,
      catalogSourceHash: catalog.sourceHash,
      policyVersion: TRAINING_PLAN_REVISION_POLICY_VERSION,
      ...(options.typedWorkoutValidationEnabled
        ? { typedWorkoutValidatorVersion: TRAINING_TYPED_WORKOUT_VALIDATOR_VERSION }
        : {}),
    }).slice(0, 32)}`,
    catalogVersion: catalog.catalogVersion,
    catalogSourceHash: catalog.sourceHash,
    selectorPolicyVersion: STRENGTH_SELECTOR_POLICY_VERSION,
    policyVersion: TRAINING_PLAN_REVISION_POLICY_VERSION,
    capabilityRegistryVersion: TRAINING_WORKOUT_CAPABILITY_REGISTRY_VERSION,
    causalFactors,
    qualityReport: {
      status: 'PASS',
      checks: [
        ...qualityChecks,
        { code: 'CAUSAL_PERSONALIZATION', status: 'PASS', evidence: `${causalFactors.length} explicit input-to-output mappings` },
      ],
    },
  };
}

export function validateTrainingPlanRevisionDocument(
  document: TrainingPlanRevisionDocument,
  options: TrainingPlanCandidateBuildOptions = {},
): TrainingPlanRevisionQualityCheck[] {
  if (document.schemaVersion === TRAINING_TYPED_PLAN_REVISION_DOCUMENT_SCHEMA) {
    return validateTrainingTypedPlanRevisionDocument(document);
  }
  const failures: string[] = [];
  const allowedSessionTypes = new Set<SessionType>([
    'strength_hypertrophy', 'strength_maintenance', 'mobility', 'rest',
  ]);
  if (document.schemaVersion !== TRAINING_PLAN_REVISION_DOCUMENT_SCHEMA
      || document.planMode !== 'continuous'
      || document.goal !== 'general_fitness'
      || document.discipline !== 'strength') failures.push('SUPPORTED_M1_DOCUMENT');
  if (document.weeks.length !== document.horizonWeeks
      || document.weeks.some((week, index) => week.weekNumber !== index + 1)) {
    failures.push('CONTIGUOUS_WEEK_HORIZON');
  }
  let expectedStartWeek = 1;
  for (const [index, phase] of document.phases.entries()) {
    if (phase.position !== index + 1
        || phase.startWeek !== expectedStartWeek
        || phase.endWeek < phase.startWeek
        || phase.durationWeeks !== phase.endWeek - phase.startWeek + 1) {
      failures.push('CONTIGUOUS_PHASE_SEQUENCE');
      break;
    }
    expectedStartWeek = phase.endWeek + 1;
  }
  if (expectedStartWeek !== document.horizonWeeks + 1
      || document.phases.at(-1)?.phaseType !== 'DELOAD'
      || document.phases.at(-1)?.recoveryOrLighterPeriod !== true) {
    failures.push('RECOVERY_PHASE_COVERAGE');
  }
  const workoutKeys = new Set<string>();
  const targetDistribution = new Map<SessionType, number>();
  for (const target of document.weeklyStructure.targetWorkoutTypeDistribution) {
    if (targetDistribution.has(target.sessionType)
        || !allowedSessionTypes.has(target.sessionType)
        || !Number.isSafeInteger(target.targetPerWeek)
        || target.targetPerWeek < 0) {
      failures.push('TARGET_WORKOUT_DISTRIBUTION_VALID');
      continue;
    }
    targetDistribution.set(target.sessionType, target.targetPerWeek);
  }
  if ([...allowedSessionTypes].some((sessionType) => !targetDistribution.has(sessionType))) {
    failures.push('TARGET_WORKOUT_DISTRIBUTION_VALID');
  }
  for (const week of document.weeks) {
    const phase = document.phases.find((entry) => entry.phaseKey === week.phaseKey);
    if (!phase || week.weekNumber < phase.startWeek || week.weekNumber > phase.endWeek) {
      failures.push('WEEK_PHASE_BINDING');
    }
    const trainingWorkouts = week.workouts.filter((workout) => workout.sessionType !== 'rest');
    if (trainingWorkouts.length !== document.weeklyStructure.targetSessionsPerWeek) {
      failures.push('WEEKLY_FREQUENCY_MATCH');
    }
    const actualDistribution = week.workouts.reduce<Map<SessionType, number>>((counts, workout) => {
      const sessionType = workout.sessionType as SessionType;
      counts.set(sessionType, (counts.get(sessionType) ?? 0) + 1);
      return counts;
    }, new Map());
    if ([...allowedSessionTypes].some((sessionType) =>
      (actualDistribution.get(sessionType) ?? 0) !== (targetDistribution.get(sessionType) ?? -1))) {
      failures.push('TARGET_WORKOUT_DISTRIBUTION_MATCH');
    }
    for (const workout of week.workouts) {
      if (workoutKeys.has(workout.workoutKey)) failures.push('UNIQUE_WORKOUT_KEYS');
      workoutKeys.add(workout.workoutKey);
      if (!allowedSessionTypes.has(workout.sessionType as SessionType)) failures.push('SUPPORTED_SESSION_TYPES');
      if (!workout.blocks.some((block) => block.priority === 'ESSENTIAL')) {
        failures.push('ESSENTIAL_BLOCK_REQUIRED');
      }
      if (workout.blocks.some((block, index) =>
        block.position !== index + 1
        || block.plannedDurationMinutes < block.minimumDurationMinutes
        || block.minimumDurationMinutes < 0)) {
        failures.push('ORDERED_PRIORITY_BLOCKS');
      }
      const blockDuration = workout.blocks.reduce((total, block) => total + block.plannedDurationMinutes, 0);
      if (blockDuration !== workout.plannedDurationMinutes) failures.push('WORKOUT_DURATION_CONSERVATION');
      for (const block of workout.blocks) {
        if (block.prescription.kind === 'strength'
            && (block.prescription.sets <= 0
              || block.prescription.targetRpe < 1 || block.prescription.targetRpe > 10
              || block.prescription.targetRir < 0
              || block.prescription.restSeconds < 0)) failures.push('TYPED_PRESCRIPTION_BOUNDS');
        if (block.prescription.kind === 'mobility'
            && (block.prescription.sequenceRounds <= 0 || block.prescription.durationSecondsPerSide <= 0)) {
          failures.push('TYPED_PRESCRIPTION_BOUNDS');
        }
        if (block.prescription.kind === 'recovery' && block.prescription.durationMinutes < 0) {
          failures.push('TYPED_PRESCRIPTION_BOUNDS');
        }
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`TRAINING_REVISION_QUALITY_FAILED:${[...new Set(failures)].sort().join(',')}`);
  }
  const checks: TrainingPlanRevisionQualityCheck[] = [
    { code: 'SUPPORTED_M1_DOCUMENT', status: 'PASS', evidence: 'Continuous general-fitness strength slice only' },
    { code: 'PHASE_AND_WEEK_CONTIGUITY', status: 'PASS', evidence: `${document.phases.length} phases cover ${document.horizonWeeks} ordered weeks` },
    { code: 'SUPPORTED_SESSION_TYPES', status: 'PASS', evidence: 'M1 four-type generation allowlist only' },
    { code: 'TARGET_WORKOUT_DISTRIBUTION', status: 'PASS', evidence: 'Every generated week exactly matches the declared per-type targets, including all rest days' },
    { code: 'ORDERED_PRIORITY_BLOCKS', status: 'PASS', evidence: 'Every workout has ordered blocks, priorities and protected minimums' },
    { code: 'DURATION_AND_PRESCRIPTION_BOUNDS', status: 'PASS', evidence: 'Block durations conserve workout duration and typed prescriptions are bounded' },
  ];
  if (options.typedWorkoutValidationEnabled) {
    checks.push(...validateTrainingTypedPlanDocument(asTypedValidationDocument(document)));
  }
  return checks;
}

function asTypedValidationDocument(
  document: TrainingPlanRevisionDocument,
): TrainingTypedPlanValidationDocument {
  return {
    sourceDocumentSchemaVersion: document.schemaVersion,
    periodization: 'PERIODIZED',
    horizonWeeks: document.horizonWeeks,
    phases: document.phases,
    weeks: document.weeks.map((week) => ({
      weekNumber: week.weekNumber,
      phaseKey: week.phaseKey,
      workouts: week.workouts.map((workout) => ({
        ...workout,
        sessionTypeClassification: 'CANONICAL' as const,
        isStandalone: false,
        phaseKey: week.phaseKey,
      })),
    })),
  };
}

function validateAndNormalizeRequest(
  request: TrainingPlanCandidateRequest,
  catalog: ReturnType<typeof buildRepoTrainingCatalogSnapshot>,
  typedWorkoutValidationEnabled: boolean,
): TrainingPlanCandidateRequest & { horizonWeeks: number } {
  if (!request || typeof request !== 'object' || !request.profile || typeof request.profile !== 'object') {
    throw new Error('TRAINING_REVISION_PROFILE_REQUIRED');
  }
  if (!typedWorkoutValidationEnabled && request.planMode !== 'continuous') {
    throw new Error('MILESTONE_1_PLAN_MODE_UNSUPPORTED');
  }
  if (!typedWorkoutValidationEnabled
      && (request.goal !== 'general_fitness' || request.discipline !== 'strength')) {
    throw new Error('MILESTONE_1_GOAL_OR_DISCIPLINE_UNSUPPORTED');
  }
  if (typedWorkoutValidationEnabled) {
    if (!['event_based', 'continuous', 'maintenance', 'return_to_training'].includes(request.planMode)) {
      throw new Error('TRAINING_TYPED_PLAN_MODE_UNSUPPORTED');
    }
    if (!['general_fitness', 'event_performance', 'maintenance', 'return_to_training'].includes(request.goal)) {
      throw new Error('TRAINING_TYPED_GOAL_UNSUPPORTED');
    }
    if (!['running', 'cycling', 'swimming', 'strength', 'triathlon', 'hybrid', 'marathon'].includes(request.discipline)) {
      throw new Error('TRAINING_TYPED_DISCIPLINE_UNSUPPORTED');
    }
    if (request.planMode === 'event_based' && request.goal !== 'event_performance') {
      throw new Error('TRAINING_EVENT_PLAN_GOAL_MISMATCH');
    }
    if (request.planMode === 'maintenance' && request.goal !== 'maintenance') {
      throw new Error('TRAINING_MAINTENANCE_PLAN_GOAL_MISMATCH');
    }
    if (request.planMode === 'return_to_training' && request.goal !== 'return_to_training') {
      throw new Error('TRAINING_RETURN_PLAN_GOAL_MISMATCH');
    }
    validateEventInput(request);
  }
  if (!['novice', 'intermediate', 'advanced'].includes(request.profile.experienceLevel)) {
    throw new Error('TRAINING_REVISION_EXPERIENCE_LEVEL_INVALID');
  }
  if (request.profile.location !== 'home' && request.profile.location !== 'gym') {
    throw new Error('TRAINING_REVISION_LOCATION_INVALID');
  }
  if (!Array.isArray(request.profile.availableDays)
      || !request.profile.availableDays.every((day) => typeof day === 'string')) {
    throw new Error('TRAINING_REVISION_AVAILABILITY_INVALID');
  }
  if (!Array.isArray(request.profile.equipmentIds)
      || request.profile.equipmentIds.length > 40
      || !request.profile.equipmentIds.every((equipmentId) =>
        typeof equipmentId === 'string' && equipmentId.length > 0 && equipmentId.length <= 80)) {
    throw new Error('TRAINING_REVISION_EQUIPMENT_INVALID');
  }
  if (request.profile.preferences != null
      && (!Array.isArray(request.profile.preferences)
        || request.profile.preferences.length > 40
        || !request.profile.preferences.every((preference) =>
          typeof preference === 'string' && preference.length <= 200))) {
    throw new Error('TRAINING_REVISION_PREFERENCES_INVALID');
  }
  if (request.profile.exclusions != null
      && (!Array.isArray(request.profile.exclusions)
        || request.profile.exclusions.length > 100
        || !request.profile.exclusions.every((exclusion) =>
          typeof exclusion === 'string' && exclusion.length > 0 && exclusion.length <= 100))) {
    throw new Error('TRAINING_REVISION_EXCLUSIONS_INVALID');
  }
  const sessions = integerInRange(
    request.profile.sessionsPerWeek,
    typedWorkoutValidationEnabled ? 1 : 3,
    typedWorkoutValidationEnabled ? 7 : 5,
    'sessionsPerWeek',
  );
  const duration = integerInRange(
    request.profile.sessionDurationMinutes,
    typedWorkoutValidationEnabled ? 15 : 30,
    typedWorkoutValidationEnabled ? 240 : 90,
    'sessionDurationMinutes',
  );
  const minimumHorizon = typedWorkoutValidationEnabled
    ? request.planMode === 'event_based' ? 5 : request.planMode === 'maintenance' ? 2 : 3
    : 4;
  const horizonWeeks = integerInRange(
    request.horizonWeeks ?? Math.max(4, minimumHorizon),
    minimumHorizon,
    typedWorkoutValidationEnabled ? 52 : 12,
    'horizonWeeks',
  );
  const availableDays = [...new Set(request.profile.availableDays)]
    .filter((day): day is DayOfWeek => DAY_ORDER.includes(day))
    .sort((left, right) => DAY_ORDER.indexOf(left) - DAY_ORDER.indexOf(right));
  if (availableDays.length < sessions) throw new Error('TRAINING_AVAILABILITY_DOES_NOT_MATCH_FREQUENCY');
  const equipmentAliases = new Map<string, string>();
  for (const item of catalog.equipment) {
    equipmentAliases.set(normalizeCatalogToken(item.id), item.id);
    for (const alias of item.aliases) equipmentAliases.set(normalizeCatalogToken(alias), item.id);
  }
  const resolvedEquipment = request.profile.equipmentIds.map((value) =>
    equipmentAliases.get(normalizeCatalogToken(value)));
  if (resolvedEquipment.some((value) => value == null)) throw new Error('TRAINING_REVISION_EQUIPMENT_UNKNOWN');
  const equipmentIds = [...new Set(['bodyweight', ...(resolvedEquipment as string[])])].sort();
  const activeExerciseIds = new Set(catalog.exercises.filter((exercise) => exercise.active).map((exercise) => exercise.id));
  const exclusions = normalizeStringList(request.profile.exclusions);
  if (exclusions.some((exerciseId) => !activeExerciseIds.has(exerciseId))) {
    throw new Error('TRAINING_REVISION_EXCLUSION_UNKNOWN');
  }
  return {
    ...request,
    horizonWeeks,
    profile: {
      ...request.profile,
      sessionsPerWeek: sessions,
      sessionDurationMinutes: duration,
      availableDays,
      equipmentIds,
      preferences: normalizeStringList(request.profile.preferences),
      exclusions,
    },
  };
}

function buildPhases(horizonWeeks: number, experience: TrainingExperienceLevel): TrainingPlanRevisionDocument['phases'] {
  const deloadWeeks = 1;
  const foundationWeeks = Math.max(1, Math.ceil((horizonWeeks - deloadWeeks) * (experience === 'novice' ? 0.6 : 0.4)));
  const buildWeeks = horizonWeeks - foundationWeeks - deloadWeeks;
  return [
    {
      phaseKey: 'phase-foundation',
      phaseType: 'FOUNDATION',
      position: 1,
      startWeek: 1,
      endWeek: foundationWeeks,
      durationWeeks: foundationWeeks,
      purpose: experience === 'novice' ? 'Establish repeatable technique and schedule consistency.' : 'Establish baseline volume and movement-family continuity.',
      progressionDirection: 'Stable exercise selection with controlled volume accumulation.',
      recoveryOrLighterPeriod: false,
      transitionExplanation: 'Move to Build after the foundation volume is completed without changing the approved profile.',
      profileFitExplanation: experience === 'novice' ? 'Longer foundation exposure matches novice experience.' : 'A shorter foundation respects existing training experience.',
    },
    {
      phaseKey: 'phase-build',
      phaseType: 'BUILD',
      position: 2,
      startWeek: foundationWeeks + 1,
      endWeek: foundationWeeks + buildWeeks,
      durationWeeks: buildWeeks,
      purpose: 'Progress the primary strength stimulus while preserving exercise roles.',
      progressionDirection: experience === 'novice' ? 'Add controlled repetitions before load.' : 'Add bounded load or one set, never both at once.',
      recoveryOrLighterPeriod: false,
      transitionExplanation: 'Move to Deload after the planned build exposure to dissipate fatigue.',
      profileFitExplanation: 'The build length is bounded by the selected horizon and weekly frequency.',
    },
    {
      phaseKey: 'phase-deload',
      phaseType: 'DELOAD',
      position: 3,
      startWeek: horizonWeeks,
      endWeek: horizonWeeks,
      durationWeeks: 1,
      purpose: 'Reduce accumulated fatigue while retaining movement familiarity.',
      progressionDirection: 'Reduce volume; retain controlled technique and submaximal effort.',
      recoveryOrLighterPeriod: true,
      transitionExplanation: 'The next approved revision may rebuild from the reviewed outcome; no automatic full-plan regeneration occurs.',
      profileFitExplanation: 'A lighter closing week protects continuity for the selected multiweek horizon.',
    },
  ];
}

function buildWeekWorkouts(input: {
  request: TrainingPlanCandidateRequest & { horizonWeeks: number };
  weekIndex: number;
  phaseType: TrainingPhaseType;
  library: Exercise[];
}): TrainingPlanRevisionWorkout[] {
  const { request } = input;
  const activeDays = request.profile.availableDays.slice(0, request.profile.sessionsPerWeek);
  const strengthCount = Math.max(1, request.profile.sessionsPerWeek - 1);
  const activeWorkouts = activeDays.map((day, sessionIndex) => {
    if (sessionIndex === activeDays.length - 1) {
      return mobilityWorkout(day, input.weekIndex, request.profile.sessionDurationMinutes);
    }
    const sessionType = sessionIndex === strengthCount - 1
      ? 'strength_maintenance' as const
      : 'strength_hypertrophy' as const;
    return strengthWorkout({
      day,
      sessionIndex,
      weekIndex: input.weekIndex,
      phaseType: input.phaseType,
      durationMinutes: request.profile.sessionDurationMinutes,
      experience: request.profile.experienceLevel,
      availableEquipment: new Set(request.profile.equipmentIds),
      exclusions: new Set(request.profile.exclusions),
      library: input.library,
      sessionType,
      targetSessions: strengthCount,
    });
  });
  const restWorkouts = DAY_ORDER
    .filter((day) => !activeDays.includes(day))
    .map((day) => restWorkout(day, input.weekIndex));
  return [...activeWorkouts, ...restWorkouts]
    .sort((left, right) => DAY_ORDER.indexOf(left.dayOfWeek) - DAY_ORDER.indexOf(right.dayOfWeek));
}

function strengthWorkout(input: {
  day: DayOfWeek;
  sessionIndex: number;
  weekIndex: number;
  phaseType: TrainingPhaseType;
  durationMinutes: number;
  experience: TrainingExperienceLevel;
  availableEquipment: Set<string>;
  exclusions: Set<string>;
  library: Exercise[];
  sessionType: 'strength_hypertrophy' | 'strength_maintenance';
  targetSessions: number;
}): TrainingPlanRevisionWorkout {
  const targetCount = input.durationMinutes >= 60 ? 5 : input.durationMinutes >= 45 ? 4 : 3;
  const profile: StrengthSelectorProfile = input.sessionType === 'strength_maintenance' ? 'maintenance' : 'hypertrophy';
  const library = input.library.filter((exercise) => !input.exclusions.has(exercise.id));
  const selected = selectStrengthExercisesFromCatalog({
    library,
    athlete: selectorAthlete(input.experience),
    availableEquipment: input.availableEquipment,
    profile,
    durationMinutes: input.durationMinutes,
    targetCount,
    targetSessions: input.targetSessions,
    sessionIndex: input.sessionIndex,
    weekIndex: input.weekIndex,
  });
  if (selected.variant.exerciseIds.length < Math.min(2, targetCount)) {
    throw new Error('TRAINING_CATALOG_INSUFFICIENT_FOR_PROFILE');
  }
  const byId = new Map(library.map((exercise) => [exercise.id, exercise]));
  const exercises = selected.variant.exerciseIds.map((exerciseId) => {
    const exercise = byId.get(exerciseId)!;
    const baseSets = input.sessionType === 'strength_maintenance' ? 2 : 3;
    const sets = input.phaseType === 'DELOAD' ? Math.max(1, baseSets - 1) : baseSets;
    return {
      exerciseId,
      name: exercise.name,
      prescription: {
        kind: 'strength' as const,
        sets,
        repetitions: input.experience === 'novice' ? '8–10' : '6–12',
        loadGuidance: input.experience === 'novice' ? 'Choose a controllable load with repeatable form.' : 'Use the approved load that preserves the target RIR.',
        targetRpe: input.phaseType === 'DELOAD' ? 6 : input.sessionType === 'strength_maintenance' ? 7 : 8,
        targetRir: input.phaseType === 'DELOAD' ? 4 : input.sessionType === 'strength_maintenance' ? 3 : 2,
        tempo: input.experience === 'novice' ? '3-1-1-0' : '2-0-1-0',
        restSeconds: input.durationMinutes >= 60 ? 120 : 75,
      },
      selectionReasons: selected.selectionReasons.get(exerciseId)?.pickedBecause ?? ['fits the requested movement role'],
    };
  });
  const primaryCount = Math.min(2, exercises.length);
  const duration = input.durationMinutes;
  const preparationDuration = Math.max(5, Math.round(duration * 0.15));
  const primaryDuration = Math.max(15, Math.round(duration * 0.5));
  const secondaryDuration = Math.max(5, Math.round(duration * 0.25));
  const cooldownDuration = Math.max(0, duration - preparationDuration - primaryDuration - secondaryDuration);
  return {
    workoutKey: `week-${input.weekIndex + 1}-${input.day}-${input.sessionType}`,
    dayOfWeek: input.day,
    title: selected.variant.title,
    sessionType: input.sessionType,
    objective: input.sessionType === 'strength_maintenance'
      ? 'Retain movement quality and strength exposure with bounded fatigue.'
      : 'Build general strength and muscle capacity across balanced movement patterns.',
    plannedDurationMinutes: duration,
    blocks: [
      {
        blockId: 'preparation', position: 1, blockType: 'PREPARATION',
        purpose: 'Prepare joints and rehearse the primary movement patterns.', priority: 'ESSENTIAL',
        minimumDurationMinutes: 5, plannedDurationMinutes: preparationDuration,
        prescription: { kind: 'mobility', sequenceRounds: 1, durationSecondsPerSide: 30, rangeGuidance: 'Controlled, comfortable range only.' },
      },
      {
        blockId: 'primary-work', position: 2, blockType: 'PRIMARY_WORK',
        purpose: 'Deliver the session primary strength objective.', priority: 'ESSENTIAL',
        minimumDurationMinutes: Math.max(12, Math.round(duration * 0.4)), plannedDurationMinutes: primaryDuration,
        prescription: exercises[0].prescription, exercises: exercises.slice(0, primaryCount),
      },
      {
        blockId: 'secondary-work', position: 3, blockType: 'SECONDARY_WORK',
        purpose: 'Add balanced accessory work without displacing the primary objective.', priority: 'RECOMMENDED',
        minimumDurationMinutes: 5, plannedDurationMinutes: secondaryDuration,
        prescription: (exercises[primaryCount] ?? exercises[0]).prescription, exercises: exercises.slice(primaryCount),
      },
      {
        blockId: 'cooldown', position: 4, blockType: 'COOLDOWN_RECOVERY',
        purpose: 'Downshift after the loaded work.', priority: 'OPTIONAL',
        minimumDurationMinutes: 0, plannedDurationMinutes: cooldownDuration,
        prescription: { kind: 'recovery', durationMinutes: cooldownDuration, effortGuidance: 'Easy breathing and relaxed walking.' },
      },
    ],
  };
}

function mobilityWorkout(day: DayOfWeek, weekIndex: number, sessionDurationMinutes: number): TrainingPlanRevisionWorkout {
  const duration = Math.min(30, sessionDurationMinutes);
  return {
    workoutKey: `week-${weekIndex + 1}-${day}-mobility`,
    dayOfWeek: day,
    title: 'Mobility and movement quality',
    sessionType: 'mobility',
    objective: 'Restore comfortable range and reinforce controlled movement quality.',
    plannedDurationMinutes: duration,
    blocks: [
      {
        blockId: 'mobility-preparation', position: 1, blockType: 'PREPARATION',
        purpose: 'Settle breathing and assess comfortable range.', priority: 'ESSENTIAL',
        minimumDurationMinutes: 3, plannedDurationMinutes: 5,
        prescription: { kind: 'mobility', sequenceRounds: 1, durationSecondsPerSide: 20, rangeGuidance: 'Pain-free controlled range.' },
      },
      {
        blockId: 'mobility-primary', position: 2, blockType: 'PRIMARY_WORK',
        purpose: 'Complete the primary mobility sequence.', priority: 'ESSENTIAL',
        minimumDurationMinutes: 10, plannedDurationMinutes: Math.max(10, duration - 8),
        prescription: { kind: 'mobility', sequenceRounds: 2, durationSecondsPerSide: 40, rangeGuidance: 'Slow transitions; no forced end range.' },
      },
      {
        blockId: 'mobility-recovery', position: 3, blockType: 'COOLDOWN_RECOVERY',
        purpose: 'Return to relaxed breathing.', priority: 'OPTIONAL',
        minimumDurationMinutes: 0, plannedDurationMinutes: 3,
        prescription: { kind: 'recovery', durationMinutes: 3, effortGuidance: 'Quiet nasal breathing.' },
      },
    ],
  };
}

function restWorkout(day: DayOfWeek, weekIndex: number): TrainingPlanRevisionWorkout {
  return {
    workoutKey: `week-${weekIndex + 1}-${day}-rest`,
    dayOfWeek: day,
    title: 'Rest and recovery',
    sessionType: 'rest',
    objective: 'Protect recovery without adding training load.',
    plannedDurationMinutes: 0,
    blocks: [
      {
        blockId: 'rest-recovery', position: 1, blockType: 'COOLDOWN_RECOVERY',
        purpose: 'No prescribed training work.', priority: 'ESSENTIAL',
        minimumDurationMinutes: 0, plannedDurationMinutes: 0,
        prescription: { kind: 'recovery', durationMinutes: 0, effortGuidance: 'Rest; optional normal daily movement only.' },
      },
    ],
  };
}

function selectorAthlete(experienceLevel: TrainingExperienceLevel): AthleteState {
  return {
    profile: {
      athleteId: 1,
      name: 'Revision candidate profile',
      experienceLevel,
      primaryDiscipline: 'strength',
    },
    readiness: { painFlags: [] },
  } as unknown as AthleteState;
}

function buildCausalFactors(request: TrainingPlanCandidateRequest & { horizonWeeks: number }): TrainingPlanCausalFactor[] {
  return [
    {
      inputKey: 'profile.experienceLevel',
      inputValue: request.profile.experienceLevel,
      materialEffects: request.profile.experienceLevel === 'novice'
        ? ['Longer foundation phase', 'Beginner-complexity exercise filter', 'Repetition-before-load progression']
        : ['Shorter foundation phase', 'Advanced-complexity exercises eligible', 'Load-or-set progression'],
    },
    {
      inputKey: 'profile.sessionsPerWeek',
      inputValue: request.profile.sessionsPerWeek,
      materialEffects: ['Weekly workout frequency', 'Strength-to-mobility distribution', 'Recovery placement'],
    },
    {
      inputKey: 'profile.sessionDurationMinutes',
      inputValue: request.profile.sessionDurationMinutes,
      materialEffects: ['Exercise count', 'Block duration', 'Rest prescription'],
    },
    {
      inputKey: 'profile.availableDays',
      inputValue: request.profile.availableDays,
      materialEffects: ['Day assignment', 'Consecutive-session exposure'],
    },
    {
      inputKey: 'profile.equipmentIds',
      inputValue: request.profile.equipmentIds,
      materialEffects: ['Exercise eligibility', 'Substitution space'],
    },
    {
      inputKey: 'profile.location',
      inputValue: request.profile.location,
      materialEffects: ['Equipment interpretation', 'Workout-complexity explanation'],
    },
    ...(request.profile.exclusions?.length ? [{
      inputKey: 'profile.exclusions',
      inputValue: request.profile.exclusions.length,
      materialEffects: [`${request.profile.exclusions.length} catalog exercise exclusion(s) removed before selection`],
    }] : []),
  ];
}

function normalizeCatalogToken(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_');
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function validateEventInput(request: TrainingPlanCandidateRequest): void {
  if (request.event == null) {
    if (request.planMode === 'event_based') throw new Error('TRAINING_EVENT_CONTEXT_REQUIRED');
    return;
  }
  if (request.planMode !== 'event_based'
      || typeof request.event.name !== 'string'
      || request.event.name.trim().length < 1
      || request.event.name.trim().length > 120
      || (request.event.priority != null && !['A', 'B', 'C'].includes(request.event.priority))) {
    throw new Error('TRAINING_EVENT_CONTEXT_INVALID');
  }
  if (request.planMode === 'event_based' && request.event.date == null) {
    throw new Error('TRAINING_EVENT_DATE_REQUIRED');
  }
  if (request.event.date != null
      && (!/^\d{4}-\d{2}-\d{2}$/.test(request.event.date)
        || Number.isNaN(Date.parse(`${request.event.date}T00:00:00.000Z`)))) {
    throw new Error('TRAINING_EVENT_DATE_INVALID');
  }
}

function integerInRange(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`TRAINING_INVALID_${field.toUpperCase()}`);
  }
  return value;
}

export function stableTrainingRevisionHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}
