// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EnduranceKeyDay, TrainingPlanSpec } from '../training-plan-spec';
import type {
  PlanLintAffectedSession,
  PlanLintFinding,
  PlanLintResult,
  PlanLintRuleId,
} from './plan-linter';
import {
  DEFAULT_COHERENCE_TOLERANCE_PCT,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_TRANSITION_SEC,
  DEFAULT_WARMUP_MINUTES,
  MIN_CREDIBLE_STRENGTH_MINUTES,
  parseRepsForTimeEstimate,
} from './session-coherence';
import {
  formatSplitSessionTitle,
  selectSplitTemplate,
  type SplitSlotDefinition,
  type SplitTemplate,
} from './split-template-library';
import {
  MAJOR_MUSCLE_GROUPS,
  UNIVERSAL_FALLBACK_EXERCISES,
  directSetContribution,
  EXERCISE_LIBRARY,
  findExerciseDefinitionByName,
  type ExerciseDefinition,
  type MovementPattern,
  type MuscleGroup,
  type WeeklyVolumeTarget,
} from './training-taxonomy';

export type TrainingSessionSectionType =
  | 'warmup'
  | 'activation'
  | 'main_lift'
  | 'secondary_lift'
  | 'accessory'
  | 'core'
  | 'conditioning'
  | 'cooldown';

export interface PrescribedExercise {
  exerciseId?: string;
  name: string;
  sets: number;
  reps: string;
  rir?: number;
  rpe?: string;
  restSec: number;
  tempo?: string;
  note?: string;
  equipment?: string;
  primaryMuscles?: MuscleGroup[];
  secondaryMuscles?: MuscleGroup[];
  movementPattern?: MovementPattern;
  candidateTier?: ExerciseCandidateTier;
  metadataConfidence?: 'curated' | 'inferred';
}

export interface TrainingSessionSection {
  type: TrainingSessionSectionType;
  exercises: PrescribedExercise[];
}

export interface TrainingPlanValidationIssue {
  code: PlanLintRuleId;
  severity: 'blocker' | 'warning';
  message: string;
  affectedSessions: PlanLintAffectedSession[];
  evidence?: Record<string, unknown>;
}

export interface TrainingPlanRepairHint {
  issueCode: PlanLintRuleId;
  action: string;
}

export interface TrainingPlanValidationResult {
  passed: boolean;
  score: number;
  errors: TrainingPlanValidationIssue[];
  warnings: TrainingPlanValidationIssue[];
  repairHints: TrainingPlanRepairHint[];
}

export interface TrainingPlanQualityPreparation {
  planData: Record<string, unknown>;
  selectedSplit: SplitTemplate;
  validation: TrainingPlanValidationResult;
  repairActions: string[];
}

type MutablePlan = Record<string, unknown> & {
  weeks?: MutableWeek[];
  trainingPlanQuality?: Record<string, unknown>;
};

type MutableWeek = Record<string, unknown> & {
  weekNumber?: number;
  sessions?: MutableSession[];
};

type MutableSession = Record<string, unknown> & {
  dayOfWeek?: string;
  sessionType?: string;
  title?: string;
  description?: string;
  durationMinutes?: number;
  preferredStartTime?: string | null;
  exercises?: Array<Record<string, unknown>>;
  splitCode?: string;
  splitSlot?: string;
  focus?: string;
  primaryMuscles?: MuscleGroup[];
  secondaryMuscles?: MuscleGroup[];
  movementPatterns?: MovementPattern[];
  estimatedDurationMinutes?: number;
  sections?: TrainingSessionSection[];
  scheduleState?: string;
  progression?: Record<string, unknown>;
};

type ExerciseCandidateTier = 'preferred' | 'standard' | 'acceptable_alternative' | 'last_resort';

interface ExerciseCandidateSelection {
  definition: ExerciseDefinition;
  tier: ExerciseCandidateTier;
}

const CANDIDATE_TIERS: Record<MovementPattern, string[][]> = {
  horizontal_push: [
    ['Dumbbell Bench Press', 'Incline Dumbbell Press'],
    ['Dumbbell Floor Press'],
    ['Push-Up'],
  ],
  vertical_push: [
    ['Seated Dumbbell Shoulder Press'],
    ['Pike Push-Up'],
  ],
  horizontal_pull: [
    ['Chest-Supported Row', 'One-Arm Dumbbell Row'],
    ['Cable Row', 'Band Row'],
    ['Inverted Row'],
  ],
  vertical_pull: [
    ['Lat Pulldown'],
    ['Band Pulldown', 'Prone Lat Pulldown'],
  ],
  squat: [
    ['Front Squat', 'Leg Press'],
    ['Goblet Squat'],
    ['Bodyweight Squat', 'Step-Up'],
  ],
  hinge: [
    ['Romanian Deadlift'],
    ['Kettlebell Romanian Deadlift'],
    ['Single-Leg Hip Hinge'],
    ['Glute Bridge', 'Bird Dog'],
  ],
  lunge_split_squat: [
    ['Bulgarian Split Squat', 'Walking Lunge'],
    ['Step-Up'],
  ],
  knee_flexion: [
    ['Seated Leg Curl'],
    ['Slider Leg Curl'],
  ],
  hip_thrust_bridge: [
    ['Hip Thrust'],
    ['Glute Bridge'],
  ],
  calf_raise: [
    ['Standing Calf Raise'],
    ['Calf Raise'],
  ],
  elbow_flexion: [
    ['Dumbbell Curl'],
    ['Hammer Curl'],
    ['Towel Curl'],
  ],
  elbow_extension: [
    ['Cable Triceps Pressdown'],
    ['Overhead Triceps Extension', 'Dumbbell Triceps Extension'],
    ['Close-Grip Push-Up'],
  ],
  lateral_raise: [
    ['Dumbbell Lateral Raise'],
    ['Side-Lying Y Raise'],
  ],
  rear_delt: [
    ['Face Pull', 'Rear Delt Fly'],
    ['Prone Y Raise'],
  ],
  loaded_carry: [
    ['Pallof Press'],
  ],
  anti_extension_core: [
    ['Dead Bug'],
    ['Bird Dog'],
  ],
  anti_rotation_core: [
    ['Pallof Press'],
    ['Side Plank'],
  ],
};

const CANDIDATE_TIER_LABELS: ExerciseCandidateTier[] = [
  'preferred',
  'standard',
  'acceptable_alternative',
  'last_resort',
];

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_LABEL: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};
const SPACED_DAY_OFFSETS: Record<number, number[]> = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 5],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
};

const GENERIC_TITLE_RE = /\bCatalog\s+\w+\s+Strength\s+\d+\b|\bStrength Support Session\b/i;

export function prepareTrainingPlanForQualityGate(
  planData: Record<string, unknown>,
  spec: TrainingPlanSpec,
): TrainingPlanQualityPreparation {
  let plan = clonePlan(planData);
  const split = selectSplitTemplate(spec.daysPerWeek, spec.goal);
  const repairActions: string[] = [];
  const previousRepairActions = Array.isArray(plan.trainingPlanQuality?.repairActions)
    ? plan.trainingPlanQuality.repairActions.filter((action): action is string => typeof action === 'string')
    : [];

  plan = enrichStrengthPlan(plan, spec, split, repairActions);
  let validation = validateTrainingPlanQuality(plan, spec, split);
  for (let repairAttempt = 0; repairAttempt < 2 && !validation.passed; repairAttempt += 1) {
    const repairCountBefore = repairActions.length;
    repairTrainingPlanAfterValidation(plan, spec, split, validation, repairActions);
    const nextValidation = validateTrainingPlanQuality(plan, spec, split);
    validation = nextValidation;
    if (repairActions.length === repairCountBefore) break;
  }

  plan.trainingPlanQuality = {
    schemaVersion: 1,
    spec,
    progressionModel: spec.progressionModel,
    selectedSplit: {
      code: split.code,
      daysPerWeek: split.daysPerWeek,
      slots: split.slots.map((slot) => ({
        slot: slot.slot,
        title: formatSplitSessionTitle(slot, spec.goal),
        focus: slot.focus,
        primaryMuscles: slot.primaryMuscles,
        secondaryMuscles: slot.secondaryMuscles,
        movementPatterns: slot.movementPatterns,
      })),
    },
    whyThisPlan: buildWhyThisPlan(split, spec),
    weeklyVolumeByMuscle: buildWeeklyVolumeDebug(plan),
    validation,
    repairActions: repairActions.length > 0 ? repairActions : previousRepairActions,
  };

  return {
    planData: plan,
    selectedSplit: split,
    validation,
    repairActions,
  };
}

export function mergeTrainingQualityIntoPlanLint(
  lint: PlanLintResult,
  validation: TrainingPlanValidationResult,
): PlanLintResult {
  if (validation.errors.length === 0 && validation.warnings.length === 0) return lint;
  const blockers = [
    ...lint.blockers,
    ...validation.errors.map(validationIssueToFinding),
  ];
  const warnings = [
    ...lint.warnings,
    ...validation.warnings.map(validationIssueToFinding),
  ];
  const suggestedFixes = [
    ...lint.suggestedFixes,
    ...validation.repairHints.map((hint) => ({
      findingRuleId: hint.issueCode,
      action: hint.action,
    })),
  ];
  return {
    status: blockers.length > 0 ? 'fail' : warnings.length > 0 ? 'pass_with_warnings' : 'pass',
    blockers,
    warnings,
    suggestedFixes,
  };
}

function enrichStrengthPlan(
  planData: MutablePlan,
  spec: TrainingPlanSpec,
  split: SplitTemplate,
  repairActions: string[],
): MutablePlan {
  const weeks = Array.isArray(planData.weeks) ? planData.weeks : [];
  const rollingDays = rollingTrainingDays(
    spec.startDate,
    spec.daysPerWeek,
    spec.preferredTrainingDays,
    spec.blockedDays,
    spec.enduranceSchedule,
  );
  for (const week of weeks) {
    const weekNumber = typeof week.weekNumber === 'number' ? week.weekNumber : 1;
    const sessions = Array.isArray(week.sessions) ? week.sessions : [];
    let strengthSessions = sessions.filter(isStrengthSession);
    const synthesizedSessions = new Set<MutableSession>();
    while (strengthSessions.length < spec.daysPerWeek) {
      const slot = split.slots[strengthSessions.length % split.slots.length];
      const newSession = buildFallbackSplitSession({
        slot,
        split,
        spec,
        dayOfWeek: rollingDays[strengthSessions.length % rollingDays.length],
      });
      sessions.push(newSession);
      strengthSessions.push(newSession);
      synthesizedSessions.add(newSession);
      repairActions.push(`Added missing ${slot.slot} slot (${formatSplitSessionTitle(slot, spec.goal)}) to week ${weekNumber}.`);
    }

    if (strengthSessions.every((session) => typeof session.splitSlot === 'string' && session.splitSlot.trim())) {
      strengthSessions = sortStrengthSessionsForSlotAssignment(strengthSessions, split);
    }

    const fallbackUse = new Map<string, number>();
    const slotAssignments = assignSplitSlotsForWeek(strengthSessions, split, spec);
    for (let index = 0; index < strengthSessions.length; index += 1) {
      const session = strengthSessions[index];
      const slot = slotAssignments.get(session) ?? split.slots[index % split.slots.length];
      const intendedDay = rollingDays[index % rollingDays.length];
      const previousTitle = String(session.title || '');
      const nextTitle = formatSplitSessionTitle(slot, spec.goal);
      const wasSynthesized = synthesizedSessions.has(session);
      const hasConcreteDay = Boolean(normalizeWeekdayKey(session.dayOfWeek));
      const shouldReplaceTitle = !previousTitle.trim() || GENERIC_TITLE_RE.test(previousTitle);
      const alreadyPreparedSession = session.splitCode === split.code
        && session.splitSlot === slot.slot
        && Array.isArray(session.sections)
        && session.sections.length > 0;
      const preserveIncomingExercises = !wasSynthesized
        && !shouldReplaceTitle
        && hasSpecCompatibleExercises(session.exercises, spec);
      if (wasSynthesized || !hasConcreteDay) {
        session.dayOfWeek = DAY_LABEL[intendedDay] ?? session.dayOfWeek;
      }
      session.sessionType = 'gym';
      session.title = shouldReplaceTitle ? nextTitle : previousTitle;
      session.focus = slot.focus;
      session.splitCode = split.code;
      session.splitSlot = slot.slot;
      session.durationMinutes = normalizeDuration(session.durationMinutes, spec.sessionDurationMinutes);
      session.estimatedDurationMinutes = session.durationMinutes;
      session.exercises = normalizeExercisesForSlot(session.exercises, slot, spec, fallbackUse, repairActions, {
        preserveExisting: preserveIncomingExercises,
        preservePrepared: alreadyPreparedSession,
      });
      const actualMetadata = deriveExerciseMetadata(session.exercises);
      session.primaryMuscles = alreadyPreparedSession && session.primaryMuscles?.length
        ? session.primaryMuscles
        : preserveIncomingExercises && actualMetadata.primaryMuscles.length > 0
        ? actualMetadata.primaryMuscles
        : slot.primaryMuscles;
      session.secondaryMuscles = alreadyPreparedSession && session.secondaryMuscles?.length
        ? session.secondaryMuscles
        : preserveIncomingExercises && actualMetadata.secondaryMuscles.length > 0
        ? actualMetadata.secondaryMuscles
        : slot.secondaryMuscles;
      session.movementPatterns = alreadyPreparedSession && session.movementPatterns?.length
        ? session.movementPatterns
        : preserveIncomingExercises && actualMetadata.movementPatterns.length > 0
        ? actualMetadata.movementPatterns
        : slot.movementPatterns;
      applyProgressionToExercises(session.exercises, spec, weekNumber, week.focus);
      session.progression = progressionForWeek(spec, weekNumber, week.focus);
      session.sections = buildSessionSections(session.exercises, slot);
      repairSessionDurationCoherence(session, slot, spec, repairActions, {
        preserveExercises: preserveIncomingExercises,
      });
      session.sections = buildSessionSections(session.exercises, slot);
      session.description = enrichDescriptionWithSplit(session.description, split, slot, spec);
      if (shouldReplaceTitle && previousTitle !== nextTitle) {
        repairActions.push(`Replaced generic title "${previousTitle}" with "${nextTitle}".`);
      }
    }
    repairProtectedEndurancePlacement(strengthSessions, spec, repairActions);
    week.sessions = sortSessions(sessions);
  }
  return planData;
}

function assignSplitSlotsForWeek(
  strengthSessions: MutableSession[],
  split: SplitTemplate,
  spec: TrainingPlanSpec,
): Map<MutableSession, SplitSlotDefinition> {
  const assignments = new Map<MutableSession, SplitSlotDefinition>();
  const sessions = [...strengthSessions].sort((left, right) => daySortIndex(left.dayOfWeek) - daySortIndex(right.dayOfWeek));
  const availableSlots = split.slots.slice(0, sessions.length);
  const unsafeLowerDays = protectedEnduranceUnsafeLowerDayIndexes(spec.enduranceSchedule);
  if (unsafeLowerDays.size === 0) {
    for (let index = 0; index < sessions.length; index += 1) {
      const slot = availableSlots[index];
      if (slot) assignments.set(sessions[index], slot);
    }
    return assignments;
  }
  const lowerSlots = availableSlots.filter(isLowerSplitSlot);
  const nonLowerSlots = availableSlots.filter((slot) => !isLowerSplitSlot(slot));
  const assignedLowerDays: number[] = [];

  for (const slot of lowerSlots) {
    const candidate = chooseLowerSlotSession(sessions, assignments, unsafeLowerDays, assignedLowerDays);
    if (!candidate) continue;
    assignments.set(candidate, slot);
    assignedLowerDays.push(daySortIndex(candidate.dayOfWeek));
  }

  const remainingSlots = [
    ...nonLowerSlots,
    ...lowerSlots.filter((slot) => !Array.from(assignments.values()).includes(slot)),
  ];
  for (const session of sessions) {
    if (assignments.has(session)) continue;
    const slot = remainingSlots.shift();
    if (!slot) break;
    assignments.set(session, slot);
  }
  return assignments;
}

function chooseLowerSlotSession(
  sessions: MutableSession[],
  assignments: Map<MutableSession, SplitSlotDefinition>,
  unsafeLowerDays: Set<number>,
  assignedLowerDays: number[],
): MutableSession | null {
  const candidates = sessions.filter((session) =>
    !assignments.has(session)
    && !unsafeLowerDays.has(daySortIndex(session.dayOfWeek))
  );
  const spaced = candidates.filter((session) => {
    const day = daySortIndex(session.dayOfWeek);
    return assignedLowerDays.every((assignedDay) => Math.abs(day - assignedDay) > 1);
  });
  return (spaced.length > 0 ? spaced : candidates)[0] ?? null;
}

function isLowerSplitSlot(slot: SplitSlotDefinition): boolean {
  return slot.lowerHeavy === true
    || slot.primaryMuscles.some(isLowerMuscle)
    || slot.movementPatterns.some((pattern) =>
      pattern === 'squat'
      || pattern === 'hinge'
      || pattern === 'lunge_split_squat'
      || pattern === 'knee_flexion'
      || pattern === 'hip_thrust_bridge'
      || pattern === 'calf_raise'
    );
}

function repairTrainingPlanAfterValidation(
  planData: MutablePlan,
  spec: TrainingPlanSpec,
  split: SplitTemplate,
  validation: TrainingPlanValidationResult,
  repairActions: string[],
): void {
  const needsVolumeRepair = validation.errors.some((error) => error.code === 'weekly_volume_targets');
  const needsLowerConflictRepair = validation.errors.some((error) =>
    error.code === 'no_three_consecutive_leg_heavy_days'
    || error.code === 'no_heavy_lower_before_long_run'
  );
  if (!needsVolumeRepair && !needsLowerConflictRepair) return;

  for (const week of planData.weeks ?? []) {
    if (isDeloadFocus(week.focus)) continue;
    const strength = (week.sessions ?? []).filter(isStrengthSession);
    const lowerRepaired = needsLowerConflictRepair
      ? repairLowerHeavyConflicts(strength, split, spec, week.weekNumber ?? 1, week.focus, repairActions)
      : 0;
    const repaired = needsVolumeRepair ? reconcileWeeklyVolume(strength, spec) : 0;
    const totalRepaired = lowerRepaired + repaired;
    if (repaired > 0) {
      repairActions.push(`Adjusted ${repaired} strength prescription${repaired === 1 ? '' : 's'} to reconcile weekly direct-set targets.`);
    }
    if (totalRepaired > 0) {
      for (const session of strength) {
        const slot = split.slots.find((candidate) => candidate.slot === session.splitSlot);
        const renderSlot = slot ?? upperBodyRepairSlot(session, spec.goal);
        const metadata = deriveExerciseMetadata(session.exercises);
        session.primaryMuscles = mergeUnique(session.primaryMuscles ?? [], metadata.primaryMuscles);
        session.secondaryMuscles = mergeUnique(session.secondaryMuscles ?? [], metadata.secondaryMuscles);
        session.movementPatterns = mergeUnique(session.movementPatterns ?? [], metadata.movementPatterns);
        session.sections = buildSessionSections(session.exercises, renderSlot);
        repairSessionDurationCoherence(session, renderSlot, spec, repairActions, {
          preserveExercises: true,
        });
        session.sections = buildSessionSections(session.exercises, renderSlot);
      }
    }
  }
}

function repairLowerHeavyConflicts(
  strength: MutableSession[],
  split: SplitTemplate,
  spec: TrainingPlanSpec,
  weekNumber: number,
  weekFocus: unknown,
  repairActions: string[],
): number {
  let changes = 0;
  const unsafeDays = protectedEnduranceUnsafeLowerDayIndexes(spec.enduranceSchedule);
  for (const session of strength) {
    if (!isLowerHeavySession(session) || !unsafeDays.has(daySortIndex(session.dayOfWeek))) continue;
    convertToUpperBodyRepairSession(session, split, spec, weekNumber, weekFocus, repairActions, 'protected endurance day');
    changes += 1;
  }

  for (let pass = 0; pass < strength.length; pass += 1) {
    const sorted = strength
      .filter(isLowerHeavySession)
      .sort((left, right) => daySortIndex(left.dayOfWeek) - daySortIndex(right.dayOfWeek));
    const adjacent = sorted.find((session, index) =>
      index > 0 && daySortIndex(session.dayOfWeek) - daySortIndex(sorted[index - 1].dayOfWeek) <= 1
    );
    if (!adjacent) break;
    convertToUpperBodyRepairSession(adjacent, split, spec, weekNumber, weekFocus, repairActions, 'adjacent lower-body recovery conflict');
    changes += 1;
  }
  return changes;
}

function convertToUpperBodyRepairSession(
  session: MutableSession,
  split: SplitTemplate,
  spec: TrainingPlanSpec,
  weekNumber: number,
  weekFocus: unknown,
  repairActions: string[],
  reason: string,
): void {
  const slot = split.slots.find((candidate) => !isLowerSplitSlot(candidate))
    ?? upperBodyRepairSlot(session, spec.goal);
  session.title = upperRepairTitle(session.title);
  session.focus = slot.focus;
  session.primaryMuscles = slot.primaryMuscles;
  session.secondaryMuscles = slot.secondaryMuscles;
  session.movementPatterns = slot.movementPatterns;
  session.exercises = defaultExercisesForSlot(slot, spec).slice(0, 5);
  applyProgressionToExercises(session.exercises, spec, weekNumber, weekFocus);
  session.sections = buildSessionSections(session.exercises, slot);
  repairActions.push(`Converted ${session.title || 'strength session'} to upper-body work because of ${reason}.`);
}

function upperRepairTitle(value: unknown): string {
  const title = String(value || '').trim();
  if (!title) return 'Upper Body Strength';
  if (/\bupper\b/i.test(title)) return title;
  return title
    .replace(/\bLower Body\b/gi, 'Upper Body')
    .replace(/\bLower\b/gi, 'Upper');
}

function upperBodyRepairSlot(session: MutableSession, goal: TrainingPlanSpec['goal']): SplitSlotDefinition {
  const suffix = typeof session.splitSlot === 'string' && session.splitSlot.trim()
    ? session.splitSlot.trim()
    : 'Upper';
  return {
    slot: suffix,
    title: goal === 'strength' ? 'Upper Body Strength' : 'Upper Body Hypertrophy',
    focus: 'Upper push/pull and core',
    primaryMuscles: ['chest', 'lats', 'upper_back'],
    secondaryMuscles: ['front_delts', 'triceps', 'biceps', 'abs'],
    movementPatterns: ['horizontal_push', 'horizontal_pull', 'vertical_pull', 'anti_rotation_core'],
    lowerHeavy: false,
    sectionBlueprint: ['warmup', 'main_lift', 'secondary_lift', 'accessory', 'core', 'cooldown'],
  };
}

function validateTrainingPlanQuality(
  planData: MutablePlan,
  spec: TrainingPlanSpec,
  split: SplitTemplate,
): TrainingPlanValidationResult {
  const errors: TrainingPlanValidationIssue[] = [];
  const warnings: TrainingPlanValidationIssue[] = [];
  const repairHints: TrainingPlanRepairHint[] = [];
  const weeks = planData.weeks ?? [];
  const progressionIssues = progressionStructureIssues(weeks, spec);
  errors.push(...progressionIssues.errors);
  warnings.push(...progressionIssues.warnings);
  for (const week of weeks) {
    const weekNumber = week.weekNumber ?? 1;
    const strength = (week.sessions ?? []).filter(isStrengthSession);
    if (strength.length !== spec.daysPerWeek) {
      errors.push(issue(
        'requested_strength_session_count',
        'blocker',
        `Week ${weekNumber} has ${strength.length} strength sessions; requested ${spec.daysPerWeek}.`,
        strength.map((session) => affected(weekNumber, session)),
        { requested: spec.daysPerWeek, actual: strength.length },
      ));
      repairHints.push({
        issueCode: 'requested_strength_session_count',
        action: 'Generate missing deterministic split slots before persistence.',
      });
    }

    const seenSlots = new Set<string>();
    if (!spec.progressionModel?.type || !spec.progressionModel.weekCount) {
      errors.push(issue(
        'progression_model_integrity',
        'blocker',
        'TrainingPlanSpec is missing deterministic progression metadata.',
        strength.map((session) => affected(weekNumber, session)),
      ));
    }
    for (const session of strength) {
      if (!session.splitCode || !session.splitSlot || !session.primaryMuscles?.length || !session.movementPatterns?.length || !session.sections?.length) {
        errors.push(issue('split_integrity', 'blocker', 'Strength session is missing split metadata or structured sections.', [affected(weekNumber, session)]));
      }
      if (!Array.isArray(session.exercises) || session.exercises.length === 0) {
        errors.push(issue('split_integrity', 'blocker', 'Strength session has no feasible curated exercises for its split slot.', [affected(weekNumber, session)]));
      }
      if (session.splitSlot) seenSlots.add(session.splitSlot);
      if (GENERIC_TITLE_RE.test(String(session.title || ''))) {
        errors.push(issue('no_generic_strength_titles', 'blocker', 'Generic catalog/support title reached a user-facing strength plan.', [affected(weekNumber, session)]));
      }
      if (!hasCompleteStrengthPrescription(session)) {
        errors.push(issue('strength_prescription_completeness', 'blocker', 'Strength session has exercises without sets/reps/RIR/RPE/rest.', [affected(weekNumber, session)]));
      }
      if (!session.progression) {
        errors.push(issue('progression_model_integrity', 'blocker', 'Strength session is missing week-level progression metadata.', [affected(weekNumber, session)]));
      }
      const durationVerdict = sessionDurationCoherenceVerdict(session);
      if (!durationVerdict.ok) {
        errors.push(issue(
          'strength_duration_coherence',
          'blocker',
          `Strength session duration is ${durationVerdict.reason}: ${durationVerdict.estimatedMinutes} min estimated vs ${durationVerdict.claimedMinutes} min claimed.`,
          [affected(weekNumber, session)],
          {
            reason: durationVerdict.reason,
            estimatedMinutes: durationVerdict.estimatedMinutes,
            claimedMinutes: durationVerdict.claimedMinutes,
            deviationPct: durationVerdict.deviationPct,
          },
        ));
      }
      const missingMovementPatterns = missingRequiredMovementPatterns(session, spec);
      if (missingMovementPatterns.length > 0) {
        errors.push(issue(
          'split_integrity',
          'blocker',
          `Strength session does not prescribe required movement pattern coverage: ${missingMovementPatterns.join(', ')}.`,
          [affected(weekNumber, session)],
          { missingMovementPatterns },
        ));
      }
      const constraintViolations = exerciseConstraintViolations(session, spec);
      if (constraintViolations.length > 0) {
        errors.push(issue(
          'exercise_constraint_compatibility',
          'blocker',
          `Strength session contains exercises that conflict with equipment, exclusions, or limitations: ${constraintViolations.join(', ')}.`,
          [affected(weekNumber, session)],
          { constraintViolations },
        ));
      }
    }
    if (spec.daysPerWeek >= 5 && seenSlots.size < Math.min(spec.daysPerWeek, split.slots.length)) {
      errors.push(issue(
        'split_integrity',
        'blocker',
        `Week ${weekNumber} does not contain unique ${split.code} split slots.`,
        strength.map((session) => affected(weekNumber, session)),
        { expectedSlots: split.slots.map((slot) => slot.slot), actualSlots: Array.from(seenSlots) },
      ));
    }

    const repeatedFallbacks = repeatedUniversalFallbacks(strength);
    if (repeatedFallbacks.length > 0) {
      errors.push(issue(
        'no_repeated_universal_fallback',
        'blocker',
        `Universal fallback movement repeated across the week: ${repeatedFallbacks.join(', ')}.`,
        strength.map((session) => affected(weekNumber, session)),
        { repeatedFallbacks },
      ));
    }

    const lowerHeavyAdjacent = adjacentLowerHeavySessions(strength);
    if (lowerHeavyAdjacent.length > 0) {
      errors.push(issue(
        'no_three_consecutive_leg_heavy_days',
        'blocker',
        'Lower-heavy strength sessions are too close together for the selected split.',
        lowerHeavyAdjacent.map((session) => affected(weekNumber, session)),
      ));
    }

    const protectedEnduranceConflicts = lowerHeavyBeforeProtectedEndurance(strength, spec);
    if (protectedEnduranceConflicts.length > 0) {
      errors.push(issue(
        'no_heavy_lower_before_long_run',
        'blocker',
        'Heavy lower-body strength is scheduled on or within 24h before a protected endurance key day.',
        protectedEnduranceConflicts.map((session) => affected(weekNumber, session)),
      ));
    }

    if (!isDeloadFocus(week.focus)) {
      const volumeResult = weeklyVolumeTargetIssues(strength, weekNumber, spec);
      errors.push(...volumeResult.errors);
      warnings.push(...volumeResult.warnings);
    }
  }

  for (const error of errors) {
    repairHints.push({
      issueCode: error.code,
      action: defaultRepairHint(error.code),
    });
  }

  const score = Math.max(0, 100 - errors.length * 18 - warnings.length * 4);
  return {
    passed: errors.length === 0,
    score,
    errors,
    warnings,
    repairHints: dedupeRepairHints(repairHints),
  };
}

function normalizeExercisesForSlot(
  exercises: Array<Record<string, unknown>> | undefined,
  slot: SplitSlotDefinition,
  spec: TrainingPlanSpec,
  fallbackUse: Map<string, number>,
  repairActions: string[],
  options: { preserveExisting?: boolean; preservePrepared?: boolean } = {},
): Array<Record<string, unknown>> {
  const defaultExercises = defaultExercisesForSlot(slot, spec);
  const compatibleIncoming = options.preservePrepared
    ? preparedCompatibleExercises(exercises, spec)
    : compatibleIncomingExercises(exercises, slot, spec, repairActions);
  const source = (options.preserveExisting || options.preservePrepared) && compatibleIncoming.length > 0
    ? compatibleIncoming
    : slotCompatibleExerciseSource(compatibleIncoming, defaultExercises);
  const normalized = source.slice(0, 7).map((exercise, index) => {
    const next = { ...exercise };
    const fallbackExercises = defaultExercises;
    const fallback = fallbackExercises[index % fallbackExercises.length];
    const fallbackName = String(fallback.name || 'Exercise');
    const rawName = String(next.name || '').trim();
    const name = rawName || fallbackName;
    let finalName = name;
    let definition = findExerciseDefinitionByName(name);
    if (!definition || !exerciseFitsSpec(definition, spec)) {
      finalName = fallbackName;
      definition = findExerciseDefinitionByName(finalName);
      if (!definition || !exerciseFitsSpec(definition, spec)) {
        const replacement = fallbackReplacementForSlot(slot, index + 1, spec);
        if (replacement) {
          finalName = replacement;
          definition = findExerciseDefinitionByName(finalName);
        }
      }
      if (rawName && rawName !== finalName) {
        repairActions.push(`Replaced incompatible or unknown exercise "${rawName}" with "${finalName}" for ${slot.slot}.`);
      }
    }
    const key = name.toLowerCase();
    if (UNIVERSAL_FALLBACK_EXERCISES.has(key)) {
      const count = (fallbackUse.get(key) ?? 0) + 1;
      fallbackUse.set(key, count);
      if (count > 1 || !slot.primaryMuscles.includes('quads')) {
        const replacement = fallbackReplacementForSlot(slot, count, spec);
        if (replacement) {
          finalName = replacement;
          definition = findExerciseDefinitionByName(finalName);
          repairActions.push(`Replaced repeated fallback "${name}" with "${finalName}" for ${slot.slot}.`);
        }
      }
    }
    const prescription = prescriptionFor(spec.goal, index);
    next.name = finalName;
    if (definition) {
      next.exerciseId = definition.id;
      next.equipment = definition.equipment.join(', ');
      next.primaryMuscles = definition.primaryMuscles;
      next.secondaryMuscles = definition.secondaryMuscles;
      next.movementPattern = definition.movementPattern;
      next.metadataConfidence = 'curated';
    } else {
      next.metadataConfidence = 'inferred';
    }
    next.sets = normalizePositiveInt(next.sets, prescription.sets);
    next.reps = String(next.reps || prescription.reps);
    next.rir = normalizePositiveInt(next.rir, prescription.rir);
    next.rpe = String(next.rpe || prescription.rpe);
    next.restSec = normalizePositiveInt(next.restSec ?? next.rest_sec, prescription.restSec);
    next.rest_sec = next.restSec;
    next.note = String(next.note || slot.focus);
    return next;
  });
  if (!options.preserveExisting) {
    for (const fallback of defaultExercises) {
      if (normalized.length >= Math.min(5, defaultExercises.length)) break;
      const fallbackName = normalizeTextToken(fallback.name);
      const alreadyUsed = normalized.some((exercise) => normalizeTextToken(exercise.name) === fallbackName);
      if (alreadyUsed) continue;
      normalized.push(fallback);
    }
    ensureRequiredMovementCoverage(normalized, slot, spec, repairActions);
  }
  return normalized;
}

function preparedCompatibleExercises(
  exercises: Array<Record<string, unknown>> | undefined,
  spec: TrainingPlanSpec,
): Array<Record<string, unknown>> {
  return (exercises ?? []).filter((exercise) => {
    const definition = findExerciseDefinitionByName(exercise.name);
    return Boolean(definition && exerciseFitsSpec(definition, spec));
  });
}

function compatibleIncomingExercises(
  exercises: Array<Record<string, unknown>> | undefined,
  slot: SplitSlotDefinition,
  spec: TrainingPlanSpec,
  repairActions: string[],
): Array<Record<string, unknown>> {
  const source: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const exercise of exercises ?? []) {
    const rawName = String(exercise.name || '').trim();
    let nextExercise = { ...exercise };
    let definition = findExerciseDefinitionByName(nextExercise.name);
    if (!definition || !exerciseFitsSpec(definition, spec)) {
      const replacement = equipmentAwareReplacementForIncomingExercise(nextExercise, spec);
      if (replacement) {
        nextExercise = replacement;
        definition = findExerciseDefinitionByName(nextExercise.name);
        if (rawName && rawName !== String(nextExercise.name || '')) {
          repairActions.push(`Replaced incompatible or unknown exercise "${rawName}" with "${String(nextExercise.name)}" for ${slot.slot}.`);
        }
      }
    }
    if (!definition || !exerciseFitsSpec(definition, spec)) {
      if (rawName) {
        repairActions.push(`Replaced incompatible or unknown exercise "${rawName}" with split-aware defaults for ${slot.slot}.`);
      }
      continue;
    }
    const fitsSlot = slot.movementPatterns.some((pattern) =>
      movementPatternSatisfies(pattern, definition.movementPattern, spec)
    );
    if (!fitsSlot) {
      if (rawName) {
        repairActions.push(`Replaced incompatible or unknown exercise "${rawName}" with split-aware defaults for ${slot.slot}.`);
      }
      continue;
    }
    const key = normalizeTextToken(definition.name);
    if (seen.has(key)) continue;
    source.push(nextExercise);
    seen.add(key);
  }
  return source;
}

function equipmentAwareReplacementForIncomingExercise(
  exercise: Record<string, unknown>,
  spec: TrainingPlanSpec,
): Record<string, unknown> | null {
  const rawName = normalizeTextToken(exercise.name);
  const replacementNames = rawName.includes('bench press')
    ? ['DB Floor Press', 'Dumbbell Floor Press', 'Push-Up']
    : rawName.includes('leg press') || rawName.includes('back squat') || rawName.includes('barbell squat')
      ? ['Goblet Squat', 'Bodyweight Squat', 'Step-Up']
      : [];
  for (const replacementName of replacementNames) {
    const definition = findExerciseDefinitionByName(replacementName);
    if (definition && exerciseFitsSpec(definition, spec)) {
      return { ...exercise, name: replacementName };
    }
  }
  return null;
}

function slotCompatibleExerciseSource(
  compatibleIncoming: Array<Record<string, unknown>>,
  defaultExercises: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const source: Array<Record<string, unknown>> = defaultExercises.map((exercise) => ({ ...exercise }));
  const seen = new Set(source.map((exercise) => normalizeTextToken(exercise.name)));
  for (const exercise of compatibleIncoming) {
    const definition = findExerciseDefinitionByName(exercise.name);
    const key = normalizeTextToken(definition?.name ?? exercise.name);
    if (seen.has(key)) continue;
    source.push({ ...exercise });
    seen.add(key);
  }
  return source;
}

function hasSpecCompatibleExercises(
  exercises: Array<Record<string, unknown>> | undefined,
  spec: TrainingPlanSpec,
): boolean {
  return (exercises ?? []).some((exercise) => {
    const definition = findExerciseDefinitionByName(exercise.name);
    return Boolean(definition && exerciseFitsSpec(definition, spec));
  });
}

function deriveExerciseMetadata(
  exercises: Array<Record<string, unknown>> | undefined,
): {
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
  movementPatterns: MovementPattern[];
} {
  const primary = new Set<MuscleGroup>();
  const secondary = new Set<MuscleGroup>();
  const patterns = new Set<MovementPattern>();
  for (const exercise of exercises ?? []) {
    for (const muscle of primaryMusclesForExercise(exercise)) primary.add(muscle);
    const secondaryMuscles = Array.isArray(exercise.secondaryMuscles)
      ? exercise.secondaryMuscles
      : findExerciseDefinitionByName(exercise.name)?.secondaryMuscles ?? [];
    for (const muscle of secondaryMuscles) {
      if (typeof muscle === 'string') secondary.add(muscle as MuscleGroup);
    }
    const pattern = movementPatternForExercise(exercise);
    if (pattern) patterns.add(pattern);
  }
  return {
    primaryMuscles: Array.from(primary),
    secondaryMuscles: Array.from(secondary),
    movementPatterns: Array.from(patterns),
  };
}

function ensureRequiredMovementCoverage(
  exercises: Array<Record<string, unknown>>,
  slot: SplitSlotDefinition,
  spec: TrainingPlanSpec,
  repairActions: string[],
): void {
  const covered = exercises.map(movementPatternForExercise).filter(Boolean) as MovementPattern[];
  const usedIds = new Set(exercises.map((exercise) => String(exercise.exerciseId || '')).filter(Boolean));
  const required = slot.movementPatterns.filter((pattern) =>
    !covered.some((coveredPattern) => movementPatternSatisfies(pattern, coveredPattern, spec))
    && movementPatternFeasible(pattern, spec)
  );
  for (const pattern of required) {
    const candidate = selectExerciseForPattern(pattern, spec, usedIds);
    if (!candidate) continue;
    const next = prescribedFromDefinition(candidate, spec, exercises.length, slot.focus);
    const replaceIndex = replaceableAccessoryIndex(exercises, slot);
    if (exercises.length < 6) {
      exercises.push(next);
    } else if (replaceIndex >= 0) {
      exercises[replaceIndex] = next;
    } else {
      exercises[exercises.length - 1] = next;
    }
    covered.push(candidate.definition.movementPattern);
    usedIds.add(candidate.definition.id);
    repairActions.push(`Added ${candidate.definition.name} so ${slot.slot} covers ${pattern}.`);
  }
}

function replaceableAccessoryIndex(
  exercises: Array<Record<string, unknown>>,
  slot: SplitSlotDefinition,
): number {
  for (let index = exercises.length - 1; index >= 0; index -= 1) {
    const pattern = movementPatternForExercise(exercises[index]);
    if (!pattern || !slot.movementPatterns.includes(pattern)) return index;
  }
  return -1;
}

function defaultExercisesForSlot(slot: SplitSlotDefinition, spec: TrainingPlanSpec): Array<Record<string, unknown>> {
  const used = new Set<string>();
  const selected: Array<Record<string, unknown>> = [];
  const patterns = [...slot.movementPatterns];
  for (const pattern of patterns) {
    const candidate = selectExerciseForPattern(pattern, spec, used);
    if (!candidate) continue;
    selected.push(prescribedFromDefinition(candidate, spec, selected.length, slot.focus));
    used.add(candidate.definition.id);
  }
  const accessoryPatterns: MovementPattern[] = ['anti_extension_core', 'anti_rotation_core', 'elbow_flexion', 'elbow_extension', 'lateral_raise', 'rear_delt'];
  for (const pattern of accessoryPatterns) {
    if (selected.length >= 5) break;
    const candidate = selectExerciseForPattern(pattern, spec, used);
    if (!candidate) continue;
    selected.push(prescribedFromDefinition(candidate, spec, selected.length, slot.focus));
    used.add(candidate.definition.id);
  }
  return selected.slice(0, 6);
}

function selectExerciseForPattern(
  pattern: MovementPattern,
  spec: TrainingPlanSpec,
  used: Set<string>,
): ExerciseCandidateSelection | null {
  const tiers = CANDIDATE_TIERS[pattern] ?? [];
  for (let tierIndex = 0; tierIndex < tiers.length; tierIndex += 1) {
    const tier = CANDIDATE_TIER_LABELS[tierIndex] ?? 'last_resort';
    for (const name of tiers[tierIndex]) {
      const definition = findExerciseDefinitionByName(name);
      if (!definition || used.has(definition.id)) continue;
      if (exerciseFitsSpec(definition, spec)) return { definition, tier };
    }
  }
  for (let tierIndex = 0; tierIndex < tiers.length; tierIndex += 1) {
    const tier = CANDIDATE_TIER_LABELS[tierIndex] ?? 'last_resort';
    for (const name of tiers[tierIndex]) {
      const definition = findExerciseDefinitionByName(name);
      if (definition && exerciseFitsSpec(definition, spec)) return { definition, tier };
    }
  }
  return null;
}

function prescribedFromDefinition(
  candidate: ExerciseCandidateSelection,
  spec: TrainingPlanSpec,
  index: number,
  focus: string,
): Record<string, unknown> {
  const prescription = prescriptionFor(spec.goal, index);
  return {
    exerciseId: candidate.definition.id,
    name: candidate.definition.name,
    sets: prescription.sets,
    reps: prescription.reps,
    rir: prescription.rir,
    rpe: prescription.rpe,
    restSec: prescription.restSec,
    rest_sec: prescription.restSec,
    note: focus,
    equipment: candidate.definition.equipment.join(', '),
    primaryMuscles: candidate.definition.primaryMuscles,
    secondaryMuscles: candidate.definition.secondaryMuscles,
    movementPattern: candidate.definition.movementPattern,
    candidateTier: candidate.tier,
    metadataConfidence: 'curated',
  };
}

function exerciseFitsSpec(definition: ExerciseDefinition, spec: TrainingPlanSpec): boolean {
  return !violatesExcludedExercise(definition, spec)
    && equipmentFits(definition, spec)
    && !violatesInjuryLimitations(definition, spec)
    && goalFits(definition, spec);
}

function goalFits(definition: ExerciseDefinition, spec: TrainingPlanSpec): boolean {
  if (spec.goal === 'strength') {
    return definition.suitableGoals.some((goal) =>
      goal === 'strength' || goal === 'hypertrophy' || goal === 'general_fitness'
    );
  }
  const goal = spec.goal === 'hybrid' || spec.goal === 'endurance_support'
    ? 'general_fitness'
    : spec.goal;
  return definition.suitableGoals.includes(goal);
}

function violatesExcludedExercise(definition: ExerciseDefinition, spec: TrainingPlanSpec): boolean {
  const excluded = (spec.excludedExercises ?? []).map(normalizeTextToken).filter(Boolean);
  if (excluded.length === 0) return false;
  const name = normalizeTextToken(definition.name);
  return excluded.some((value) => name.includes(value) || value.includes(name));
}

function equipmentFits(definition: ExerciseDefinition, spec: TrainingPlanSpec): boolean {
  const label = normalizeTextToken(spec.equipmentProfile.label);
  if (label === 'full_gym' || label === 'garage_gym') return true;
  const allowed = new Set((spec.equipmentProfile.equipment ?? []).map(normalizeTextToken).filter(Boolean));
  if (label === 'home_basic' || (label.includes('home') && label.includes('basic'))) {
    ['bodyweight', 'dumbbell', 'band', 'bench', 'kettlebell'].forEach((item) => allowed.add(item));
  }
  if (label === 'bodyweight' || label === 'no_equipment') {
    allowed.add('bodyweight');
  }
  if (allowed.size === 0) {
    return definition.equipment.every((item) => item === 'bodyweight');
  }
  return definition.equipment.some((item) => item === 'bodyweight' || allowed.has(normalizeTextToken(item)));
}

function violatesInjuryLimitations(definition: ExerciseDefinition, spec: TrainingPlanSpec): boolean {
  const text = normalizeTextToken((spec.injuriesOrLimitations ?? []).join(' '));
  if (!text || /\bnone\b/.test(text)) return false;
  if (/\bknee|patellar|meniscus|acl\b/.test(text) && ['medium', 'high'].includes(definition.jointStress.knee ?? 'low')) return true;
  if (/\bshoulder|rotator|ac\b/.test(text) && definition.jointStress.shoulder === 'high') return true;
  if (/\blower back|low back|lumbar|disc|spine\b/.test(text) && (definition.jointStress.lowerBack === 'high' || definition.axialLoad === 'high')) return true;
  return false;
}

function exerciseConstraintViolations(session: MutableSession, spec: TrainingPlanSpec): string[] {
  const violations: string[] = [];
  for (const exercise of session.exercises ?? []) {
    const definition = findExerciseDefinitionByName(exercise.name);
    if (!definition) {
      violations.push(`${String(exercise.name || 'Exercise')} has no curated metadata`);
      continue;
    }
    if (violatesExcludedExercise(definition, spec)) violations.push(`${definition.name} is excluded`);
    if (!equipmentFits(definition, spec)) violations.push(`${definition.name} does not fit equipment profile ${spec.equipmentProfile.label}`);
    if (violatesInjuryLimitations(definition, spec)) violations.push(`${definition.name} conflicts with injury/limitation notes`);
    if (!goalFits(definition, spec)) violations.push(`${definition.name} is not tagged for ${spec.goal}`);
  }
  return violations;
}

function applyProgressionToExercises(
  exercises: Array<Record<string, unknown>> | undefined,
  spec: TrainingPlanSpec,
  weekNumber: number,
  weekFocus: unknown,
): void {
  if (!Array.isArray(exercises)) return;
  const progression = progressionForWeek(spec, weekNumber, weekFocus);
  for (const [index, exercise] of exercises.entries()) {
    const currentNote = String(exercise.note || '').trim();
    const progressionNote = String(progression.exerciseNote || '');
    const alreadyApplied = exercise.progressionWeek === weekNumber
      && exercise.progressionType === spec.progressionModel.type;
    exercise.progressionWeek = weekNumber;
    exercise.progressionType = spec.progressionModel.type;
    if (!alreadyApplied && progression.deload) {
      exercise.sets = Math.max(2, normalizePositiveInt(exercise.sets, 3) - 1);
      exercise.rir = Math.max(normalizePositiveInt(exercise.rir, 2), 3);
      exercise.rpe = '6-7';
    } else if (!alreadyApplied && spec.progressionModel.type === 'volume_progression' && index >= 2 && weekNumber >= 3) {
      exercise.sets = Math.min(4, normalizePositiveInt(exercise.sets, 3) + 1);
    } else if (!alreadyApplied && spec.progressionModel.type === 'rir_progression') {
      exercise.rir = Math.max(1, 4 - Math.min(weekNumber, 3));
    }
    exercise.note = currentNote.includes(progressionNote)
      ? currentNote
      : [currentNote, progressionNote].filter(Boolean).join(' ');
  }
}

function progressionForWeek(spec: TrainingPlanSpec, weekNumber: number, weekFocus: unknown): Record<string, unknown> {
  const deload = isDeloadFocus(weekFocus);
  const exerciseNote = deload
    ? 'Deload week: reduce load or sets and leave extra reps in reserve.'
    : spec.progressionModel.type === 'linear_load'
      ? 'Progression: add load only if all work sets meet the target reps with clean form.'
      : spec.progressionModel.type === 'double_progression'
        ? 'Progression: add reps within the range before increasing load.'
        : spec.progressionModel.type === 'volume_progression'
          ? 'Progression: add volume only when readiness and endurance key days stay protected.'
          : 'Progression: gradually lower RIR as technique stays consistent.';
  return {
    type: spec.progressionModel.type,
    weekNumber,
    deload,
    exerciseNote,
    targetRir: deload ? 3 : spec.progressionModel.type === 'rir_progression' ? Math.max(1, 4 - Math.min(weekNumber, 3)) : 2,
  };
}

function isDeloadFocus(value: unknown): boolean {
  return /\bdeload\b/i.test(String(value || ''));
}

function progressionStructureIssues(
  weeks: MutableWeek[],
  spec: TrainingPlanSpec,
): { errors: TrainingPlanValidationIssue[]; warnings: TrainingPlanValidationIssue[] } {
  const errors: TrainingPlanValidationIssue[] = [];
  const warnings: TrainingPlanValidationIssue[] = [];
  const weekCount = spec.progressionModel?.weekCount ?? 0;
  const deloadEnabled = Boolean(spec.progressionModel?.deloadPolicy?.enabled);
  if (!deloadEnabled || weekCount < 4 || weeks.length < weekCount) {
    return { errors, warnings };
  }

  const weekNumbers = weeks.map((week) => week.weekNumber).filter((value): value is number => typeof value === 'number');
  const uniqueWeekNumbers = new Set(weekNumbers);
  if (weekNumbers.length !== weeks.length || uniqueWeekNumbers.size !== weekNumbers.length) {
    errors.push(issue(
      'progression_model_integrity',
      'blocker',
      'Training plan weeks must have unique weekNumber values before deload validation.',
      [],
      { weekNumbers },
    ));
  }

  const deloadWeeks = weeks.filter((week) => isDeloadFocus(week.focus));
  if (deloadWeeks.length === 0) {
    errors.push(issue(
      'progression_model_integrity',
      'blocker',
      'Progression model enables deloads but no week has focus="deload".',
      [],
      { weekCount, focusValues: weeks.map((week) => week.focus ?? null) },
    ));
  }
  return { errors, warnings };
}

function buildFallbackSplitSession(input: {
  slot: SplitSlotDefinition;
  split: SplitTemplate;
  spec: TrainingPlanSpec;
  dayOfWeek: string;
}): MutableSession {
  const title = formatSplitSessionTitle(input.slot, input.spec.goal);
  const exercises = defaultExercisesForSlot(input.slot, input.spec);
  return {
    dayOfWeek: DAY_LABEL[input.dayOfWeek] ?? input.dayOfWeek,
    sessionType: 'gym',
    title,
    durationMinutes: input.spec.sessionDurationMinutes ?? 50,
    preferredStartTime: null,
    description: `Deterministic ${input.split.code} slot: ${input.slot.focus}.`,
    exercises,
    splitCode: input.split.code,
    splitSlot: input.slot.slot,
    focus: input.slot.focus,
    primaryMuscles: input.slot.primaryMuscles,
    secondaryMuscles: input.slot.secondaryMuscles,
    movementPatterns: input.slot.movementPatterns,
    estimatedDurationMinutes: input.spec.sessionDurationMinutes ?? 50,
    sections: buildSessionSections(exercises, input.slot),
  };
}

function buildSessionSections(
  exercises: Array<Record<string, unknown>> | undefined,
  slot: SplitSlotDefinition,
): TrainingSessionSection[] {
  const prescribed = (exercises ?? []).map((exercise): PrescribedExercise => ({
    exerciseId: typeof exercise.exerciseId === 'string' ? exercise.exerciseId : undefined,
    name: String(exercise.name || 'Exercise'),
    sets: normalizePositiveInt(exercise.sets, 3),
    reps: String(exercise.reps || '8-12'),
    rir: normalizePositiveInt(exercise.rir, 2),
    rpe: String(exercise.rpe || '7-8'),
    restSec: normalizePositiveInt(exercise.restSec ?? exercise.rest_sec, 90),
    tempo: typeof exercise.tempo === 'string' ? exercise.tempo : undefined,
    note: typeof exercise.note === 'string' ? exercise.note : slot.focus,
    equipment: typeof exercise.equipment === 'string' ? exercise.equipment : undefined,
  }));
  const sections: TrainingSessionSection[] = [
    { type: 'warmup', exercises: [{ name: 'Ramp-up mobility and warm-up sets', sets: 1, reps: '5-8 min', rir: 4, rpe: 'easy', restSec: 30, note: `Prepare for ${slot.focus}.` }] },
    { type: 'main_lift', exercises: prescribed.slice(0, 1) },
    { type: 'secondary_lift', exercises: prescribed.slice(1, 2) },
    { type: 'accessory', exercises: prescribed.slice(2, -1) },
    { type: 'core', exercises: prescribed.slice(-1) },
    { type: 'cooldown', exercises: [{ name: 'Cool-down walk and breathing', sets: 1, reps: '3-5 min', rir: 4, rpe: 'easy', restSec: 30, note: 'Downshift before leaving the gym.' }] },
  ];
  return sections.filter((section) => section.exercises.length > 0);
}

function weeklyVolumeTargetIssues(
  strengthSessions: MutableSession[],
  weekNumber: number,
  spec: TrainingPlanSpec,
): { errors: TrainingPlanValidationIssue[]; warnings: TrainingPlanValidationIssue[] } {
  const directSets: Partial<Record<MuscleGroup, number>> = {};
  const directFrequency: Partial<Record<MuscleGroup, number>> = {};
  for (const session of strengthSessions) {
    const sessionMuscles = new Set<MuscleGroup>();
    for (const exercise of session.exercises ?? []) {
      const sets = normalizePositiveInt(exercise.sets, 0);
      const muscles = primaryMusclesForExercise(exercise);
      if (sets <= 0 || muscles.length === 0) continue;
      const contribution = directSetContribution(muscles, sets);
      for (const [muscle, value] of Object.entries(contribution.direct) as Array<[MuscleGroup, number]>) {
        directSets[muscle] = (directSets[muscle] ?? 0) + value;
        sessionMuscles.add(muscle);
      }
    }
    for (const muscle of sessionMuscles) {
      directFrequency[muscle] = (directFrequency[muscle] ?? 0) + 1;
    }
  }
  const targets = weeklyVolumeTargetsForSpec(spec);
  const undertrained = targets
    .filter((target) => (directSets[target.muscle] ?? 0) < target.minDirectSets)
    .map((target) => target.muscle);
  const overtrained = targets
    .filter((target) => (directSets[target.muscle] ?? 0) > target.maxDirectSets)
    .map((target) => target.muscle);
  const lowFrequency = targets
    .filter((target) => (directFrequency[target.muscle] ?? 0) < target.targetFrequency)
    .map((target) => target.muscle);

  const evidence = { directSets, directFrequency, targets };
  const errors: TrainingPlanValidationIssue[] = [];
  const warnings: TrainingPlanValidationIssue[] = [];
  if (undertrained.length > 0 || overtrained.length > 0) {
    errors.push(issue(
      'weekly_volume_targets',
      'blocker',
      `Week ${weekNumber} misses direct weekly set targets. Undertrained: ${undertrained.join(', ') || 'none'}. Overtrained: ${overtrained.join(', ') || 'none'}.`,
      strengthSessions.map((session) => affected(weekNumber, session)),
      { ...evidence, undertrained, overtrained },
    ));
  }
  if (lowFrequency.length > 0) {
    warnings.push(issue(
      'weekly_volume_targets',
      'warning',
      `Week ${weekNumber} has low direct training frequency for: ${lowFrequency.join(', ')}.`,
      strengthSessions.map((session) => affected(weekNumber, session)),
      { ...evidence, lowFrequency },
    ));
  }
  return { errors, warnings };
}

function weeklyVolumeTargetsForSpec(spec: TrainingPlanSpec): WeeklyVolumeTarget[] {
  const beginner = spec.experienceLevel === 'beginner' || spec.experienceLevel === 'novice';
  const strengthBias = spec.goal === 'strength';
  const supportBias = spec.goal === 'general_fitness' || spec.goal === 'endurance_support';
  const highFrequency = spec.daysPerWeek >= 5;
  const baseMinDirectSets = spec.daysPerWeek <= 2
    ? 3
    : spec.daysPerWeek === 3
      ? 3
      : beginner
        ? 4
        : 5;
  const minDirectSets = supportBias
    ? Math.max(2, baseMinDirectSets - 2)
    : baseMinDirectSets;
  const targetDirectSets = strengthBias
    ? Math.max(minDirectSets + 1, highFrequency ? 7 : 6)
    : supportBias
      ? Math.max(minDirectSets + 1, highFrequency ? 6 : 4)
      : Math.max(minDirectSets + 2, highFrequency ? 8 : 6);
  const maxDirectSets = beginner
    ? supportBias ? 12 : 14
    : strengthBias
      ? spec.daysPerWeek >= 6 ? 24 : 16
      : 18;
  const targetFrequency = spec.daysPerWeek >= 4 && !supportBias ? 2 : 1;
  return MAJOR_MUSCLE_GROUPS
    .filter((muscle) =>
      hasCompatibleDirectExerciseForMuscle(muscle, spec)
      || !shouldRelaxSafetyLimitedVolumeTarget(muscle, spec)
    )
    .map((muscle) => ({
      muscle,
      minDirectSets,
      targetDirectSets,
      maxDirectSets,
      targetFrequency,
    }));
}

function hasCompatibleDirectExerciseForMuscle(muscle: MuscleGroup, spec: TrainingPlanSpec): boolean {
  return EXERCISE_LIBRARY.some((definition) =>
    definition.primaryMuscles.includes(muscle) && exerciseFitsSpec(definition, spec)
  );
}

function shouldRelaxSafetyLimitedVolumeTarget(muscle: MuscleGroup, spec: TrainingPlanSpec): boolean {
  const injuryText = normalizeTextToken((spec.injuriesOrLimitations ?? []).join(' '));
  if (!injuryText || /\bnone\b/.test(injuryText)) return false;
  return EXERCISE_LIBRARY.some((definition) =>
    definition.primaryMuscles.includes(muscle)
    && !violatesExcludedExercise(definition, spec)
    && equipmentFits(definition, spec)
    && goalFits(definition, spec)
    && violatesInjuryLimitations(definition, spec)
  );
}

function reconcileWeeklyVolume(strengthSessions: MutableSession[], spec: TrainingPlanSpec): number {
  const targets = weeklyVolumeTargetsForSpec(spec);
  const targetByMuscle = new Map(targets.map((target) => [target.muscle, target]));
  const directSets = directSetsForSessions(strengthSessions);
  let changes = 0;

  for (const [muscle, target] of targetByMuscle) {
    let current = directSets[muscle] ?? 0;
    while (current > target.maxDirectSets) {
      const exercise = findHighestSetExerciseForMuscle(strengthSessions, muscle);
      if (!exercise || normalizePositiveInt(exercise.sets, 0) <= 1) break;
      exercise.sets = normalizePositiveInt(exercise.sets, 3) - 1;
      current -= 1;
      changes += 1;
    }
  }

  for (const [muscle, target] of targetByMuscle) {
    let current = directSetsForSessions(strengthSessions)[muscle] ?? 0;
    while (current < target.minDirectSets) {
      const exercise = findLowestSetExerciseForMuscle(strengthSessions, muscle);
      if (exercise && normalizePositiveInt(exercise.sets, 0) < 4) {
        exercise.sets = normalizePositiveInt(exercise.sets, 3) + 1;
        current += 1;
        changes += 1;
        continue;
      }
      const addedSets = addExerciseForUndertrainedMuscle(strengthSessions, muscle, spec);
      if (addedSets <= 0) break;
      current += addedSets;
      changes += 1;
    }
  }

  return changes;
}

function directSetsForSessions(strengthSessions: MutableSession[]): Partial<Record<MuscleGroup, number>> {
  const directSets: Partial<Record<MuscleGroup, number>> = {};
  for (const session of strengthSessions) {
    for (const exercise of session.exercises ?? []) {
      const sets = normalizePositiveInt(exercise.sets, 0);
      for (const muscle of primaryMusclesForExercise(exercise)) {
        directSets[muscle] = (directSets[muscle] ?? 0) + sets;
      }
    }
  }
  return directSets;
}

function findHighestSetExerciseForMuscle(
  strengthSessions: MutableSession[],
  muscle: MuscleGroup,
): Record<string, unknown> | null {
  return strengthSessions
    .flatMap((session) => session.exercises ?? [])
    .filter((exercise) => primaryMusclesForExercise(exercise).includes(muscle))
    .sort((left, right) => normalizePositiveInt(right.sets, 0) - normalizePositiveInt(left.sets, 0))[0] ?? null;
}

function findLowestSetExerciseForMuscle(
  strengthSessions: MutableSession[],
  muscle: MuscleGroup,
): Record<string, unknown> | null {
  return strengthSessions
    .flatMap((session) => session.exercises ?? [])
    .filter((exercise) => primaryMusclesForExercise(exercise).includes(muscle))
    .sort((left, right) => normalizePositiveInt(left.sets, 0) - normalizePositiveInt(right.sets, 0))[0] ?? null;
}

function addExerciseForUndertrainedMuscle(
  strengthSessions: MutableSession[],
  muscle: MuscleGroup,
  spec: TrainingPlanSpec,
): number {
  const targetSession = bestSessionForMuscleRepair(strengthSessions, muscle, spec);
  if (!targetSession) return 0;

  const exercises = targetSession.exercises ?? [];
  const used = new Set(
    strengthSessions
      .flatMap((session) => session.exercises ?? [])
      .map((exercise) => String(exercise.exerciseId || findExerciseDefinitionByName(exercise.name)?.id || ''))
      .filter(Boolean),
  );
  for (const pattern of repairPatternsForMuscle(muscle)) {
    const candidate = selectExerciseForPattern(pattern, spec, used);
    if (!candidate) continue;
    const next = prescribedFromDefinition(
      candidate,
      spec,
      exercises.length,
      String(targetSession.focus || targetSession.title || 'Strength support'),
    );
    exercises.push(next);
    targetSession.exercises = exercises;
    targetSession.primaryMuscles = mergeUnique(targetSession.primaryMuscles ?? [], candidate.definition.primaryMuscles);
    targetSession.secondaryMuscles = mergeUnique(targetSession.secondaryMuscles ?? [], candidate.definition.secondaryMuscles);
    targetSession.movementPatterns = mergeUnique(targetSession.movementPatterns ?? [], [candidate.definition.movementPattern]);
    return normalizePositiveInt(next.sets, 0);
  }
  return 0;
}

function bestSessionForMuscleRepair(
  strengthSessions: MutableSession[],
  muscle: MuscleGroup,
  spec: TrainingPlanSpec,
): MutableSession | null {
  if (strengthSessions.length === 0) return null;
  const desiredPatterns = new Set(repairPatternsForMuscle(muscle));
  const legalSessions = strengthSessions.filter((session) =>
    !isUnsafeLowerMuscleRepairSession(session, muscle, spec)
  );
  const candidates = legalSessions.length > 0 ? legalSessions : strengthSessions;
  const lowerCapable = isLowerMuscle(muscle)
    ? candidates.filter((session) => sessionCanAcceptLowerMuscleRepair(session))
    : [];
  const pool = lowerCapable.length > 0 ? lowerCapable : candidates;
  return [...pool].sort((left, right) =>
    muscleRepairScore(right, muscle, desiredPatterns) - muscleRepairScore(left, muscle, desiredPatterns)
  )[0] ?? null;
}

function isUnsafeLowerMuscleRepairSession(
  session: MutableSession,
  muscle: MuscleGroup,
  spec: TrainingPlanSpec,
): boolean {
  return isLowerMuscle(muscle)
    && protectedEnduranceUnsafeLowerDayIndexes(spec.enduranceSchedule).has(daySortIndex(session.dayOfWeek));
}

function sessionCanAcceptLowerMuscleRepair(session: MutableSession): boolean {
  return (session.primaryMuscles ?? []).some(isLowerMuscle)
    || (session.movementPatterns ?? []).some((pattern) =>
      pattern === 'squat'
      || pattern === 'hinge'
      || pattern === 'lunge_split_squat'
      || pattern === 'knee_flexion'
      || pattern === 'hip_thrust_bridge'
      || pattern === 'calf_raise'
    );
}

function isLowerMuscle(muscle: MuscleGroup): boolean {
  return muscle === 'quads'
    || muscle === 'hamstrings'
    || muscle === 'glutes'
    || muscle === 'calves'
    || muscle === 'spinal_erectors';
}

function muscleRepairScore(
  session: MutableSession,
  muscle: MuscleGroup,
  desiredPatterns: Set<MovementPattern>,
): number {
  const exercises = session.exercises ?? [];
  let score = Math.max(0, 8 - exercises.length);
  if ((session.primaryMuscles ?? []).includes(muscle)) score += 8;
  if ((session.secondaryMuscles ?? []).includes(muscle)) score += 4;
  if ((session.movementPatterns ?? []).some((pattern) => desiredPatterns.has(pattern))) score += 6;
  if (isLowerMuscle(muscle)) {
    const hasLowerPattern = (session.movementPatterns ?? []).some((pattern) =>
      pattern === 'squat'
      || pattern === 'hinge'
      || pattern === 'lunge_split_squat'
      || pattern === 'knee_flexion'
      || pattern === 'hip_thrust_bridge'
      || pattern === 'calf_raise'
    );
    if (hasLowerPattern) score += 5;
  }
  return score;
}

function repairPatternsForMuscle(muscle: MuscleGroup): MovementPattern[] {
  switch (muscle) {
    case 'chest':
    case 'front_delts':
      return ['horizontal_push', 'vertical_push'];
    case 'side_delts':
      return ['lateral_raise', 'vertical_push'];
    case 'rear_delts':
      return ['rear_delt', 'horizontal_pull'];
    case 'lats':
      return ['vertical_pull', 'horizontal_pull'];
    case 'upper_back':
    case 'traps':
      return ['horizontal_pull', 'vertical_pull'];
    case 'biceps':
    case 'forearms':
      return ['elbow_flexion', 'horizontal_pull'];
    case 'triceps':
      return ['elbow_extension', 'horizontal_push'];
    case 'quads':
      return ['squat', 'lunge_split_squat'];
    case 'hamstrings':
    case 'spinal_erectors':
      return ['hinge', 'knee_flexion'];
    case 'glutes':
      return ['hip_thrust_bridge', 'hinge', 'squat'];
    case 'calves':
      return ['calf_raise'];
    case 'abs':
      return ['anti_extension_core'];
    case 'obliques':
      return ['anti_rotation_core'];
  }
}

function primaryMusclesForExercise(exercise: Record<string, unknown>): MuscleGroup[] {
  if (Array.isArray(exercise.primaryMuscles)) {
    return exercise.primaryMuscles.filter((muscle): muscle is MuscleGroup => typeof muscle === 'string');
  }
  return findExerciseDefinitionByName(exercise.name)?.primaryMuscles ?? [];
}

function rollingTrainingDays(
  startDate: string,
  daysPerWeek: number,
  preferred?: string[],
  blocked?: string[],
  enduranceSchedule?: EnduranceKeyDay[],
): string[] {
  const blockedSet = new Set((blocked ?? []).map(normalizeWeekdayKey).filter(Boolean));
  for (const previousDay of protectedEndurancePreviousDays(enduranceSchedule)) {
    blockedSet.add(previousDay);
  }
  const preferredDays = (preferred ?? [])
    .map(normalizeWeekdayKey)
    .filter((day): day is string => Boolean(day) && !blockedSet.has(day));
  if (preferredDays.length >= daysPerWeek) return preferredDays.slice(0, daysPerWeek);
  const startIndex = dayIndexFromIsoDate(startDate);
  const rolling = startIndex >= 0
    ? [...DAY_ORDER.slice(startIndex), ...DAY_ORDER.slice(0, startIndex)]
    : [...DAY_ORDER];
  const merged = [...preferredDays];
  const spacedCandidates = (SPACED_DAY_OFFSETS[daysPerWeek] ?? rolling.map((_, index) => index))
    .map((offset) => rolling[offset % rolling.length]);
  for (const day of spacedCandidates) {
    if (merged.length >= daysPerWeek) break;
    if (blockedSet.has(day) || merged.includes(day)) continue;
    merged.push(day);
  }
  for (const day of rolling) {
    if (merged.length >= daysPerWeek) break;
    if (blockedSet.has(day) || merged.includes(day)) continue;
    merged.push(day);
  }
  return merged
    .sort((left, right) => rolling.indexOf(left as typeof DAY_ORDER[number]) - rolling.indexOf(right as typeof DAY_ORDER[number]))
    .slice(0, daysPerWeek);
}

function repeatedUniversalFallbacks(sessions: MutableSession[]): string[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    for (const exercise of session.exercises ?? []) {
      const name = String(exercise.name || '').trim().toLowerCase();
      if (!UNIVERSAL_FALLBACK_EXERCISES.has(name)) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).filter(([, count]) => count > 1).map(([name]) => name);
}

function adjacentLowerHeavySessions(sessions: MutableSession[]): MutableSession[] {
  const sorted = sessions
    .filter(isLowerHeavySession)
    .sort((left, right) => daySortIndex(left.dayOfWeek) - daySortIndex(right.dayOfWeek));
  const offenders: MutableSession[] = [];
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const left = daySortIndex(sorted[index].dayOfWeek);
    const right = daySortIndex(sorted[index + 1].dayOfWeek);
    if (right - left <= 1) {
      offenders.push(sorted[index], sorted[index + 1]);
    }
  }
  return Array.from(new Set(offenders));
}

function lowerHeavyBeforeProtectedEndurance(
  sessions: MutableSession[],
  spec: TrainingPlanSpec,
): MutableSession[] {
  const unsafeDays = protectedEnduranceUnsafeLowerDayIndexes(spec.enduranceSchedule);
  if (unsafeDays.size === 0) return [];
  return sessions.filter((session) =>
    isLowerHeavySession(session)
    && unsafeDays.has(daySortIndex(session.dayOfWeek))
  );
}

function repairProtectedEndurancePlacement(
  sessions: MutableSession[],
  spec: TrainingPlanSpec,
  repairActions: string[],
): void {
  const unsafeDays = protectedEnduranceUnsafeLowerDayIndexes(spec.enduranceSchedule);
  if (unsafeDays.size === 0) return;
  for (const lower of sessions) {
    if (!isLowerHeavySession(lower) || !unsafeDays.has(daySortIndex(lower.dayOfWeek))) continue;
    const lowerDayIndex = daySortIndex(lower.dayOfWeek);
    const swap = sessions
      .filter((candidate) =>
        candidate !== lower
        && !isLowerHeavySession(candidate)
        && !unsafeDays.has(daySortIndex(candidate.dayOfWeek))
        && !wouldCreateLowerAdjacencyAfterSwap(sessions, lower, candidate)
      )
      .sort((left, right) =>
        forwardDayDistance(lowerDayIndex, daySortIndex(left.dayOfWeek))
        - forwardDayDistance(lowerDayIndex, daySortIndex(right.dayOfWeek))
      )[0];
    if (!swap) continue;
    const originalLowerDay = lower.dayOfWeek;
    lower.dayOfWeek = swap.dayOfWeek;
    swap.dayOfWeek = originalLowerDay;
    repairActions.push(`Moved ${lower.title || 'lower-body strength'} away from protected endurance day ${originalLowerDay}.`);
  }
}

function isLowerHeavySession(session: MutableSession): boolean {
  return Boolean(session.primaryMuscles?.some((muscle) => (
    muscle === 'quads' || muscle === 'hamstrings' || muscle === 'glutes'
  )));
}

function wouldCreateLowerAdjacencyAfterSwap(
  sessions: MutableSession[],
  lower: MutableSession,
  candidate: MutableSession,
): boolean {
  const candidateDay = daySortIndex(candidate.dayOfWeek);
  const lowerDays = sessions
    .filter((session) => isLowerHeavySession(session))
    .map((session) => session === lower ? candidateDay : daySortIndex(session.dayOfWeek))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  return lowerDays.some((day, index) => index > 0 && day - lowerDays[index - 1] <= 1);
}

function forwardDayDistance(from: number, to: number): number {
  if (from < 0 || to < 0) return Number.MAX_SAFE_INTEGER;
  return (to - from + DAY_ORDER.length) % DAY_ORDER.length;
}

function hasCompleteStrengthPrescription(session: MutableSession): boolean {
  const exercises = session.exercises ?? [];
  return exercises.length > 0 && exercises.every((exercise) =>
    normalizePositiveInt(exercise.sets, 0) > 0
    && String(exercise.reps || '').trim().length > 0
    && (normalizePositiveInt(exercise.rir, 0) > 0 || String(exercise.rpe || '').trim().length > 0)
    && normalizePositiveInt(exercise.restSec ?? exercise.rest_sec, 0) > 0
  );
}

type DurationCoherenceVerdict =
  | { ok: true; estimatedMinutes: number; claimedMinutes: number }
  | {
      ok: false;
      reason: 'underfilled' | 'overstuffed';
      estimatedMinutes: number;
      claimedMinutes: number;
      deviationPct: number;
    };

function repairSessionDurationCoherence(
  session: MutableSession,
  slot: SplitSlotDefinition,
  spec: TrainingPlanSpec,
  repairActions: string[],
  options: { preserveExercises?: boolean } = {},
): void {
  let verdict = sessionDurationCoherenceVerdict(session);
  session.estimatedDurationMinutes = verdict.estimatedMinutes;
  if (verdict.ok) return;

  if (verdict.reason === 'underfilled') {
    const added = options.preserveExercises ? 0 : addExercisesForUnderfilledSession(session, slot, spec);
    if (added > 0) {
      repairActions.push(`Added ${added} exercise${added === 1 ? '' : 's'} to make ${session.title || slot.slot} match its claimed duration.`);
      verdict = sessionDurationCoherenceVerdict(session);
    }
    if (!verdict.ok && verdict.reason === 'underfilled' && (options.preserveExercises || verdict.estimatedMinutes >= MIN_CREDIBLE_STRENGTH_MINUTES)) {
      const previous = normalizeDuration(session.durationMinutes, spec.sessionDurationMinutes);
      session.durationMinutes = options.preserveExercises
        ? Math.max(1, verdict.estimatedMinutes)
        : normalizeDuration(verdict.estimatedMinutes, previous);
      repairActions.push(`Adjusted ${session.title || slot.slot} from ${previous} min to a truthful ${session.durationMinutes} min duration.`);
      verdict = sessionDurationCoherenceVerdict(session);
    }
  }

  if (!verdict.ok && verdict.reason === 'overstuffed') {
    if (options.preserveExercises && verdict.estimatedMinutes <= 90) {
      const previous = normalizeDuration(session.durationMinutes, spec.sessionDurationMinutes);
      session.durationMinutes = Math.max(1, Math.round(verdict.estimatedMinutes));
      repairActions.push(`Raised ${session.title || slot.slot} from ${previous} min to ${session.durationMinutes} min to preserve quality-gate volume truthfully.`);
      verdict = sessionDurationCoherenceVerdict(session);
    }
    const changed = trimSessionToClaimedDuration(session);
    if (changed) {
      repairActions.push(`Trimmed accessory volume in ${session.title || slot.slot} so work fits the claimed duration.`);
      verdict = sessionDurationCoherenceVerdict(session);
    }
    if (!verdict.ok && verdict.reason === 'overstuffed' && !spec.sessionDurationMinutes && verdict.estimatedMinutes <= 90) {
      const previous = normalizeDuration(session.durationMinutes, spec.sessionDurationMinutes);
      session.durationMinutes = normalizeDuration(verdict.estimatedMinutes, previous);
      repairActions.push(`Raised ${session.title || slot.slot} from ${previous} min to ${session.durationMinutes} min to keep duration truthful.`);
      verdict = sessionDurationCoherenceVerdict(session);
    }
  }

  session.estimatedDurationMinutes = verdict.estimatedMinutes;
}

function addExercisesForUnderfilledSession(
  session: MutableSession,
  slot: SplitSlotDefinition,
  spec: TrainingPlanSpec,
): number {
  const exercises = session.exercises ?? [];
  const used = new Set(exercises.map((exercise) => String(exercise.exerciseId || '')).filter(Boolean));
  const patterns: MovementPattern[] = [
    ...slot.movementPatterns,
    'anti_extension_core',
    'anti_rotation_core',
    'elbow_flexion',
    'elbow_extension',
    'lateral_raise',
    'rear_delt',
  ];
  let added = 0;
  for (const pattern of patterns) {
    if (exercises.length >= 6) break;
    const verdict = sessionDurationCoherenceVerdict(session);
    if (verdict.ok || verdict.estimatedMinutes >= MIN_CREDIBLE_STRENGTH_MINUTES) break;
    const candidate = selectExerciseForPattern(pattern, spec, used);
    if (!candidate) continue;
    exercises.push(prescribedFromDefinition(candidate, spec, exercises.length, slot.focus));
    used.add(candidate.definition.id);
    added += 1;
  }
  session.exercises = exercises;
  return added;
}

function trimSessionToClaimedDuration(session: MutableSession): boolean {
  const exercises = session.exercises ?? [];
  const claimed = normalizeDuration(session.durationMinutes);
  const minimumExerciseCount = claimed <= 30 ? 2 : claimed <= 45 ? 3 : 4;
  let changed = false;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const verdict = sessionDurationCoherenceVerdict(session);
    if (verdict.ok || verdict.reason !== 'overstuffed') break;

    const reduceIndex = lastReducibleExerciseIndex(exercises);
    if (reduceIndex >= 0) {
      const current = exercises[reduceIndex];
      current.sets = Math.max(1, normalizePositiveInt(current.sets, 3) - 1);
      current.restSec = Math.min(normalizePositiveInt(current.restSec ?? current.rest_sec, 90), 75);
      current.rest_sec = current.restSec;
      current.rir = Math.max(normalizePositiveInt(current.rir, 2), 3);
      changed = true;
      continue;
    }

    if (exercises.length > minimumExerciseCount) {
      exercises.pop();
      changed = true;
      continue;
    }

    break;
  }
  session.exercises = exercises;
  return changed;
}

function lastReducibleExerciseIndex(exercises: Array<Record<string, unknown>>): number {
  for (let index = exercises.length - 1; index >= 0; index -= 1) {
    if (normalizePositiveInt(exercises[index].sets, 0) > 1) return index;
  }
  return -1;
}

function sessionDurationCoherenceVerdict(session: MutableSession): DurationCoherenceVerdict {
  const estimatedMinutes = estimateQualityGateSessionMinutes(session);
  const claimedMinutes = typeof session.durationMinutes === 'number' && Number.isFinite(session.durationMinutes)
    ? Math.max(1, Math.round(session.durationMinutes))
    : normalizeDuration(session.durationMinutes);
  if (claimedMinutes <= 0) return { ok: true, estimatedMinutes, claimedMinutes };
  const deviationPct = Math.abs(estimatedMinutes - claimedMinutes) / claimedMinutes;
  if (deviationPct <= DEFAULT_COHERENCE_TOLERANCE_PCT) {
    return { ok: true, estimatedMinutes, claimedMinutes };
  }
  return {
    ok: false,
    reason: estimatedMinutes < claimedMinutes ? 'underfilled' : 'overstuffed',
    estimatedMinutes,
    claimedMinutes,
    deviationPct: Number(deviationPct.toFixed(3)),
  };
}

function estimateQualityGateSessionMinutes(session: MutableSession): number {
  const exercises = session.exercises ?? [];
  if (exercises.length === 0) {
    return DEFAULT_WARMUP_MINUTES + DEFAULT_COOLDOWN_MINUTES;
  }

  let totalSeconds = (DEFAULT_WARMUP_MINUTES + DEFAULT_COOLDOWN_MINUTES) * 60;
  for (let index = 0; index < exercises.length; index += 1) {
    totalSeconds += estimateExerciseSeconds(exercises[index]);
    if (index < exercises.length - 1) totalSeconds += DEFAULT_TRANSITION_SEC;
  }
  return Math.round(totalSeconds / 60);
}

function estimateExerciseSeconds(exercise: Record<string, unknown>): number {
  const sets = normalizePositiveInt(exercise.sets, 3);
  const repsText = String(exercise.reps || '8-12');
  const restSec = normalizePositiveInt(exercise.restSec ?? exercise.rest_sec, 90);
  const { numReps, isUnilateral } = parseRepsForTimeEstimate(repsText);
  const pattern = movementPatternForExercise(exercise);
  const secPerRep = pattern === 'anti_extension_core' || pattern === 'anti_rotation_core'
    ? 2.5
    : numReps <= 5
      ? 4
      : numReps >= 15
        ? 2
        : 3;
  const setupSec = 5;
  const setSeconds = (setupSec + numReps * secPerRep) * (isUnilateral ? 2 : 1);
  return sets * setSeconds + Math.max(0, sets - 1) * restSec;
}

function missingRequiredMovementPatterns(session: MutableSession, spec: TrainingPlanSpec): MovementPattern[] {
  const covered = (session.exercises ?? []).map(movementPatternForExercise).filter(Boolean) as MovementPattern[];
  return (session.movementPatterns ?? []).filter((pattern) =>
    movementPatternFeasible(pattern, spec)
    && !covered.some((coveredPattern) => movementPatternSatisfies(pattern, coveredPattern, spec))
  );
}

function movementPatternForExercise(exercise: Record<string, unknown>): MovementPattern | null {
  const direct = typeof exercise.movementPattern === 'string' ? exercise.movementPattern : '';
  if (direct) return direct as MovementPattern;
  return findExerciseDefinitionByName(exercise.name)?.movementPattern ?? null;
}

function mergeUnique<T extends string>(existing: T[], incoming: T[]): T[] {
  return Array.from(new Set([...existing, ...incoming]));
}

function movementPatternFeasible(pattern: MovementPattern, spec: TrainingPlanSpec): boolean {
  return EXERCISE_LIBRARY.some((definition) =>
    definition.movementPattern === pattern && exerciseFitsSpec(definition, spec)
  );
}

function movementPatternSatisfies(
  required: MovementPattern,
  actual: MovementPattern,
  spec: TrainingPlanSpec,
): boolean {
  if (required === actual) return true;
  if (required === 'squat' && actual === 'lunge_split_squat' && !movementPatternFeasible('squat', spec)) {
    return true;
  }
  return false;
}

function prescriptionFor(goal: TrainingPlanSpec['goal'], index: number): { sets: number; reps: string; rir: number; rpe: string; restSec: number } {
  if (goal === 'strength') {
    return index === 0
      ? { sets: 4, reps: '3-6', rir: 2, rpe: '8', restSec: 180 }
      : { sets: 3, reps: '6-10', rir: 2, rpe: '7-8', restSec: 120 };
  }
  if (goal === 'general_fitness' || goal === 'endurance_support') {
    return { sets: 2, reps: '8-12', rir: 3, rpe: '6-7', restSec: 75 };
  }
  return index <= 1
    ? { sets: 3, reps: '6-12', rir: 2, rpe: '7-8', restSec: 120 }
    : { sets: 3, reps: '10-20', rir: 2, rpe: '7-8', restSec: 75 };
}

function firstCompatibleExerciseName(names: string[], spec: TrainingPlanSpec): string | null {
  for (const name of names) {
    const definition = findExerciseDefinitionByName(name);
    if (definition && exerciseFitsSpec(definition, spec)) return definition.name;
  }
  return null;
}

function fallbackReplacementForSlot(slot: SplitSlotDefinition, occurrence: number, spec: TrainingPlanSpec): string | null {
  const used = new Set<string>();
  for (const pattern of slot.movementPatterns) {
    const candidate = selectExerciseForPattern(pattern, spec, used);
    if (!candidate) continue;
    used.add(candidate.definition.id);
    if (occurrence <= used.size + 1) return candidate.definition.name;
  }
  if (slot.primaryMuscles.includes('hamstrings')) {
    return firstCompatibleExerciseName(['Romanian Deadlift', 'Glute Bridge', 'Single-Leg Hip Hinge', 'Bird Dog'], spec);
  }
  if (slot.primaryMuscles.includes('quads')) {
    return firstCompatibleExerciseName(['Step-Up', 'Bodyweight Squat', 'Leg Press'], spec);
  }
  if (slot.primaryMuscles.includes('chest')) {
    return firstCompatibleExerciseName(['Dumbbell Bench Press', 'DB Floor Press', 'Dumbbell Floor Press', 'Push-Up'], spec);
  }
  if (slot.primaryMuscles.includes('lats') || slot.primaryMuscles.includes('upper_back')) {
    return firstCompatibleExerciseName(['Lat Pulldown', 'Band Pulldown', 'Band Row', 'Inverted Row'], spec);
  }
  if (slot.primaryMuscles.includes('side_delts')) {
    return firstCompatibleExerciseName(['Dumbbell Lateral Raise', 'Side-Lying Y Raise'], spec);
  }
  return firstCompatibleExerciseName(['Cable Row', 'Band Row', 'Inverted Row', 'Dead Bug', 'Bird Dog'], spec);
}

function buildWhyThisPlan(split: SplitTemplate, spec: TrainingPlanSpec): string[] {
  return [
    `Your ${spec.daysPerWeek}-day split uses ${split.code}: ${split.slots.map((slot) => `${slot.slot} ${formatSplitSessionTitle(slot, spec.goal)}`).join(', ')}.`,
    'It trains major upper and lower muscle groups across the week instead of repeating one generic gym day.',
    'Lower-body sessions are separated by upper or accessory work to protect recovery.',
    `Progression uses ${spec.progressionModel.type.replace(/_/g, ' ')} across ${spec.progressionModel.weekCount} week${spec.progressionModel.weekCount === 1 ? '' : 's'} with deload rules when needed.`,
    `Exercise selection respects the ${spec.equipmentProfile.label || 'current'} equipment profile, excluded exercises, and injury notes before saving.`,
    spec.calendarPreference.provider === 'none'
      ? 'Calendar sync is optional for this plan.'
      : `Calendar sync is scoped to your preferred ${spec.calendarPreference.provider} calendar.`,
  ];
}

function buildWeeklyVolumeDebug(planData: MutablePlan): Array<Record<string, unknown>> {
  return (planData.weeks ?? []).map((week) => {
    const directSets: Partial<Record<MuscleGroup, number>> = {};
    for (const session of (week.sessions ?? []).filter(isStrengthSession)) {
      for (const exercise of session.exercises ?? []) {
        const sets = normalizePositiveInt(exercise.sets, 0);
        const muscles = Array.isArray(exercise.primaryMuscles)
          ? exercise.primaryMuscles.filter((muscle): muscle is MuscleGroup => typeof muscle === 'string')
          : [];
        for (const muscle of muscles) {
          directSets[muscle] = (directSets[muscle] ?? 0) + sets;
        }
      }
    }
    return {
      weekNumber: week.weekNumber ?? 1,
      directSets,
    };
  });
}

function enrichDescriptionWithSplit(
  existing: unknown,
  split: SplitTemplate,
  slot: SplitSlotDefinition,
  spec: TrainingPlanSpec,
): string {
  const existingText = String(existing || '').trim();
  const prefix = `${split.code} ${slot.slot}: ${formatSplitSessionTitle(slot, spec.goal)}. Focus: ${slot.focus}.`;
  if (existingText.includes(`${split.code} ${slot.slot}:`)) return existingText;
  return existingText ? `${prefix}\n\n${existingText}` : prefix;
}

function validationIssueToFinding(issue: TrainingPlanValidationIssue): PlanLintFinding {
  return {
    ruleId: issue.code,
    severity: issue.severity === 'blocker' ? 'blocker' : 'warning',
    message: issue.message,
    affectedSessions: issue.affectedSessions,
    evidence: issue.evidence,
  };
}

function issue(
  code: PlanLintRuleId,
  severity: 'blocker' | 'warning',
  message: string,
  affectedSessions: PlanLintAffectedSession[],
  evidence?: Record<string, unknown>,
): TrainingPlanValidationIssue {
  return {
    code,
    severity,
    message,
    affectedSessions,
    ...(evidence ? { evidence } : {}),
  };
}

function affected(weekNumber: number, session: MutableSession): PlanLintAffectedSession {
  return {
    weekNumber,
    dayOfWeek: String(session.dayOfWeek || '').toLowerCase(),
    title: session.title,
  };
}

function defaultRepairHint(code: PlanLintRuleId): string {
  switch (code) {
    case 'requested_strength_session_count':
      return 'Generate missing split slots before persistence.';
    case 'split_integrity':
      return 'Apply deterministic split template metadata and structured sections.';
    case 'no_generic_strength_titles':
      return 'Replace generic titles with split-aware titles.';
    case 'no_repeated_universal_fallback':
      return 'Replace repeated fallback movement with slot-specific alternatives.';
    case 'strength_prescription_completeness':
      return 'Fill sets, reps, RIR/RPE, and rest for every strength exercise.';
    case 'strength_duration_coherence':
      return 'Rebuild, trim, or truthfully resize strength work so sets and rests match the duration.';
    case 'weekly_volume_targets':
      return 'Adjust split slots and accessories so direct weekly set volume stays inside target ranges.';
    case 'exercise_constraint_compatibility':
      return 'Replace exercises that do not fit equipment, exclusions, or injury limitations.';
    case 'progression_model_integrity':
      return 'Attach deterministic progression metadata before persistence.';
    default:
      return 'Regenerate and revalidate the plan before saving.';
  }
}

function dedupeRepairHints(hints: TrainingPlanRepairHint[]): TrainingPlanRepairHint[] {
  const seen = new Set<string>();
  return hints.filter((hint) => {
    const key = `${hint.issueCode}:${hint.action}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isStrengthSession(session: MutableSession): boolean {
  const sessionType = String(session.sessionType || '').trim().toLowerCase();
  if (/\b(run|running|cardio|bike|cycling|ride|swim|walk|rest|mobility|recovery|long_run)\b/.test(sessionType)) {
    return false;
  }
  if (/\b(gym|strength|lift|hypertrophy)\b/.test(sessionType)) return true;
  if (sessionType) return false;
  const title = String(session.title || '').toLowerCase();
  return /\b(gym|strength|lift|hypertrophy)\b/.test(title) && !/\b(rest|mobility|recovery run)\b/.test(title);
}

function sortSessions(sessions: MutableSession[]): MutableSession[] {
  return [...sessions].sort((left, right) => {
    const dayDelta = daySortIndex(left.dayOfWeek) - daySortIndex(right.dayOfWeek);
    if (dayDelta !== 0) return dayDelta;
    return String(left.title || '').localeCompare(String(right.title || ''));
  });
}

function sortStrengthSessionsForSlotAssignment(
  sessions: MutableSession[],
  split: SplitTemplate,
): MutableSession[] {
  const slotOrder = new Map(split.slots.map((slot, index) => [slot.slot, index]));
  return [...sessions].sort((left, right) => {
    const leftSlot = typeof left.splitSlot === 'string' ? slotOrder.get(left.splitSlot) : undefined;
    const rightSlot = typeof right.splitSlot === 'string' ? slotOrder.get(right.splitSlot) : undefined;
    if (leftSlot != null && rightSlot != null && leftSlot !== rightSlot) {
      return leftSlot - rightSlot;
    }
    if (leftSlot != null && rightSlot == null) return -1;
    if (leftSlot == null && rightSlot != null) return 1;
    const dayDelta = daySortIndex(left.dayOfWeek) - daySortIndex(right.dayOfWeek);
    if (dayDelta !== 0) return dayDelta;
    return String(left.title || '').localeCompare(String(right.title || ''));
  });
}

function daySortIndex(value: unknown): number {
  const normalized = String(value || '').trim().toLowerCase();
  const index = DAY_ORDER.indexOf(normalized as typeof DAY_ORDER[number]);
  return index >= 0 ? index : 99;
}

function dayIndexFromIsoDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return -1;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return -1;
  const mondayIndex = (parsed.getUTCDay() + 6) % 7;
  return mondayIndex >= 0 && mondayIndex < DAY_ORDER.length ? mondayIndex : -1;
}

function normalizeWeekdayKey(value: unknown): string {
  const normalized = String(value || '').trim().toLowerCase();
  return DAY_ORDER.includes(normalized as typeof DAY_ORDER[number]) ? normalized : '';
}

function normalizeTextToken(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function protectedEndurancePreviousDays(enduranceSchedule?: EnduranceKeyDay[]): string[] {
  return protectedEnduranceDayIndexes(enduranceSchedule)
    .map((index) => DAY_ORDER[(index + DAY_ORDER.length - 1) % DAY_ORDER.length]);
}

function protectedEnduranceUnsafeLowerDayIndexes(enduranceSchedule?: EnduranceKeyDay[]): Set<number> {
  const unsafe = new Set<number>();
  for (const index of protectedEnduranceDayIndexes(enduranceSchedule)) {
    unsafe.add(index);
    unsafe.add((index + DAY_ORDER.length - 1) % DAY_ORDER.length);
  }
  return unsafe;
}

function protectedEnduranceDayIndexes(enduranceSchedule?: EnduranceKeyDay[]): number[] {
  return (enduranceSchedule ?? [])
    .filter((day) => day.priority === 'protected')
    .map((day) => dayIndexFromIsoDate(day.date))
    .filter((index) => index >= 0);
}

function normalizeDuration(value: unknown, fallback?: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback ?? 50;
  return Math.min(Math.max(Math.round(numeric), 30), 90);
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : fallback;
}

function clonePlan(planData: Record<string, unknown>): MutablePlan {
  return JSON.parse(JSON.stringify(planData ?? {})) as MutablePlan;
}
