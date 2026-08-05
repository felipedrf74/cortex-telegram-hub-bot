// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { CoordinatedTrainingPlan, CoordinatedTrainingSession } from './training-plan-coordination';
import type { TrainingDecisionReason } from './coach-kernel/types';
import {
  resolveCanonicalEquipmentProfile,
  type ResolvedEquipmentProfile,
} from './training-equipment-vocabulary';
import {
  materializeCanonicalTrainingExercise,
  resolveTrainingExerciseIdentity,
  TrainingExerciseIdentityError,
} from './training-exercise-identity';
import {
  getTrainingExerciseIdentityV1Mode,
  type RuntimeFlagScope,
  type TrainingExerciseIdentityV1Mode,
} from './runtime-flags';

export type TrainingEquipmentProfile =
  | 'full_gym'
  | 'garage_gym'
  | 'home_basic'
  | 'bands'
  | 'bodyweight';

export interface TrainingEquipmentAdaptationInput {
  fitnessProfile?: Record<string, any> | null;
  gymProfile?: Record<string, any> | null;
  conservativeUnknown?: boolean;
  env?: NodeJS.ProcessEnv;
  scope?: RuntimeFlagScope;
}

export interface TrainingEquipmentAdaptation {
  equipmentProfile: TrainingEquipmentProfile;
  promptBlock: string;
  summary: string;
  canonicalProfile: ResolvedEquipmentProfile;
  decisionReasons: TrainingDecisionReason[];
  authority: 'legacy_route_adapter' | 'coach_kernel';
}

type ExerciseLike = {
  exerciseId?: string;
  exercise_id?: string;
  name?: string;
  equipment?: string[];
  sets?: number;
  reps?: number | string;
  rpe?: string;
  restSec?: number;
  tempo?: string;
};

function withAdaptedExerciseName(exercise: ExerciseLike, name: string): ExerciseLike {
  const previousName = String(exercise.name || '').trim();
  const adapted: ExerciseLike = { ...exercise, name };
  if (name !== previousName) {
    // A replacement name represents a different reviewed movement. Keeping
    // the source id would create an id/name contradiction in off and shadow
    // modes; active mode will materialize the replacement's canonical id.
    delete adapted.exerciseId;
    delete adapted.exercise_id;
  }
  return adapted;
}

const BODYWEIGHT_FULL_BODY_TEMPLATE: ExerciseLike[] = [
  { name: 'Tempo Split Squat', sets: 3, reps: 10, rpe: '7', restSec: 60 },
  { name: 'Push-Up', sets: 4, reps: 10, rpe: '7', restSec: 60 },
  { name: 'Single-Leg Glute Bridge', sets: 3, reps: 12, rpe: '7', restSec: 45 },
  { name: 'Side Plank', sets: 3, reps: 30, rpe: '6', restSec: 30 },
];

const BANDS_FULL_BODY_TEMPLATE: ExerciseLike[] = [
  { name: 'Banded Front Squat', sets: 4, reps: 10, rpe: '7', restSec: 60 },
  { name: 'Banded Row', sets: 4, reps: 12, rpe: '7', restSec: 60 },
  { name: 'Banded Chest Press', sets: 3, reps: 12, rpe: '7', restSec: 60 },
  { name: 'Pallof Press', sets: 3, reps: 12, rpe: '6', restSec: 45 },
];

const HOME_BASIC_FULL_BODY_TEMPLATE: ExerciseLike[] = [
  { name: 'Goblet Squat', sets: 4, reps: 10, rpe: '7', restSec: 75 },
  { name: 'DB Romanian Deadlift', sets: 3, reps: 10, rpe: '7', restSec: 75 },
  { name: 'DB Floor Press', sets: 3, reps: 10, rpe: '7', restSec: 75 },
  { name: 'One-Arm DB Row', sets: 3, reps: 10, rpe: '7', restSec: 60 },
];

const GARAGE_GYM_FULL_BODY_TEMPLATE: ExerciseLike[] = [
  { name: 'Back Squat', sets: 4, reps: 6, rpe: '7-8', restSec: 120 },
  { name: 'Romanian Deadlift', sets: 3, reps: 8, rpe: '7', restSec: 90 },
  { name: 'Bench Press', sets: 3, reps: 8, rpe: '7', restSec: 90 },
  { name: 'Barbell Row', sets: 3, reps: 8, rpe: '7', restSec: 75 },
];

type SubstitutionRule = {
  match: RegExp;
  replacements: Partial<Record<TrainingEquipmentProfile, string>>;
};

const SUBSTITUTION_RULES: SubstitutionRule[] = [
  {
    match: /\bbench press\b/i,
    replacements: {
      garage_gym: 'Bench Press',
      home_basic: 'DB Floor Press',
      bands: 'Banded Push-Up',
      bodyweight: 'Push-Up',
    },
  },
  {
    match: /\bback squat\b/i,
    replacements: {
      garage_gym: 'Back Squat',
      home_basic: 'Goblet Squat',
      bands: 'Banded Squat',
      bodyweight: 'Tempo Air Squat',
    },
  },
  {
    match: /\bromanian deadlift\b|\brdl\b/i,
    replacements: {
      garage_gym: 'Romanian Deadlift',
      home_basic: 'DB Romanian Deadlift',
      bands: 'Banded Romanian Deadlift',
      bodyweight: 'Single-Leg Hip Hinge',
    },
  },
  {
    match: /\bleg press\b/i,
    replacements: {
      garage_gym: 'Front Squat',
      home_basic: 'Goblet Squat',
      bands: 'Banded Front Squat',
      bodyweight: 'Tempo Split Squat',
    },
  },
  {
    match: /\bleg curl\b/i,
    replacements: {
      garage_gym: 'Slider Hamstring Curl',
      home_basic: 'Slider Hamstring Curl',
      bands: 'Banded Hamstring Curl',
      bodyweight: 'Single-Leg Glute Bridge',
    },
  },
  {
    match: /\blat pulldown\b|\bpull-?up\b/i,
    replacements: {
      garage_gym: 'Pull-Up / Inverted Row',
      home_basic: 'One-Arm DB Row',
      bands: 'Band Lat Pulldown',
      bodyweight: 'Prone Snow Angel',
    },
  },
  {
    match: /\bseated cable row\b|\bchest-supported row\b/i,
    replacements: {
      garage_gym: 'Barbell Row',
      home_basic: 'One-Arm DB Row',
      bands: 'Banded Row',
      bodyweight: 'Table Row',
    },
  },
  {
    match: /\bcable\b|\bpressdown\b|\btriceps pressdown\b/i,
    replacements: {
      garage_gym: 'Close-Grip Push-Up',
      home_basic: 'DB Overhead Triceps Extension',
      bands: 'Banded Triceps Pressdown',
      bodyweight: 'Diamond Push-Up',
    },
  },
  {
    match: /\bface pull\b/i,
    replacements: {
      garage_gym: 'Band Face Pull',
      home_basic: 'Band Face Pull',
      bands: 'Band Face Pull',
      bodyweight: 'Prone Y-T-W Raise',
    },
  },
  {
    match: /\bhanging knee raise\b/i,
    replacements: {
      garage_gym: 'Dead Bug',
      home_basic: 'Dead Bug',
      bands: 'Dead Bug',
      bodyweight: 'Dead Bug',
    },
  },
  {
    match: /\bseated calf raise\b|\bcalf raise\b/i,
    replacements: {
      garage_gym: 'Standing Calf Raise',
      home_basic: 'Single-Leg Calf Raise',
      bands: 'Banded Calf Raise',
      bodyweight: 'Single-Leg Calf Raise',
    },
  },
];

/**
 * Emitter-local choices for legacy labels that are intentionally not global
 * aliases. Each choice is specific to this equipment-adaptation context; the
 * shared resolver therefore remains exact and does not guess between variants.
 */
const EQUIPMENT_EMITTER_CANONICAL_IDS: Readonly<Record<string, string>> = Object.freeze({
  'Banded Front Squat': 'bodyweight_squat',
  'Banded Chest Press': 'push_up',
  'DB Floor Press': 'dumbbell_floor_press',
  'Banded Push-Up': 'push_up',
  'Banded Squat': 'bodyweight_squat',
  'Banded Romanian Deadlift': 'hip_hinge_band',
  'Banded Hamstring Curl': 'slider_leg_curl',
  'Pull-Up / Inverted Row': 'pull_up',
  'Prone Snow Angel': 'prone_lat_pulldown',
  'Banded Triceps Pressdown': 'close_grip_push_up',
  'Diamond Push-Up': 'close_grip_push_up',
  'Hip Hinge with Band': 'hip_hinge_band',
  'Prone Y-T-W Raise': 'prone_y_raise',
  'Banded Calf Raise': 'single_leg_calf_raise',
  'One-Arm Row': 'one_arm_dumbbell_row',
  'Hip Thrust': 'barbell_hip_thrust',
  'Leg Curl': 'seated_leg_curl',
  'Lateral Raise': 'dumbbell_lateral_raise',
  'Push-Up / DB Floor Press': 'push_up',
  'Push-Up / DB Press': 'push_up',
  'Lat Pulldown / Pull-Up': 'lat_pulldown',
  'Cable / Band Triceps Pressdown': 'cable_triceps_pressdown',
});

/**
 * Exact, reviewed movement-role substitutions for active band-only output.
 * This deliberately does not use broad `press`/`pull` regexes: an overhead
 * press must remain a vertical push, and an unspecified pull must not be
 * silently converted into a horizontal row. Names outside this finite table
 * fail closed in active mode.
 */
const ACTIVE_BAND_SUBSTITUTIONS: Readonly<Record<string, string>> = Object.freeze({
  'Band Face Pull': 'Band Face Pull',
  'Band Lat Pulldown': 'Band Lat Pulldown',
  'Band Pulldown': 'Band Lat Pulldown',
  'Band Row': 'Banded Row',
  'Banded Calf Raise': 'Banded Calf Raise',
  'Banded Chest Press': 'Banded Chest Press',
  'Banded Front Squat': 'Banded Front Squat',
  'Banded Hamstring Curl': 'Banded Hamstring Curl',
  'Banded Push-Up': 'Banded Push-Up',
  'Banded Romanian Deadlift': 'Banded Romanian Deadlift',
  'Banded Row': 'Banded Row',
  'Banded Squat': 'Banded Squat',
  'Banded Triceps Pressdown': 'Banded Triceps Pressdown',
  'Back Squat': 'Banded Squat',
  'Barbell Bench Press': 'Banded Push-Up',
  'Barbell Overhead Press': 'Pike Push-Up',
  'Barbell Row': 'Banded Row',
  'Bench Press': 'Banded Push-Up',
  'Bodyweight Squat': 'Bodyweight Squat',
  'Bulgarian Split Squat': 'Tempo Split Squat',
  'Cable / Band Triceps Pressdown': 'Banded Triceps Pressdown',
  'Cable Row': 'Banded Row',
  'Cable Triceps Pressdown': 'Banded Triceps Pressdown',
  'Calf Raise': 'Banded Calf Raise',
  'Chest Press': 'Banded Chest Press',
  'Chest-Supported Row': 'Banded Row',
  'Close-Grip Push-Up': 'Close-Grip Push-Up',
  'DB Floor Press': 'Banded Push-Up',
  'DB Romanian Deadlift': 'Banded Romanian Deadlift',
  'Dead Bug': 'Dead Bug',
  'Dumbbell Bench Press': 'Banded Push-Up',
  'Dumbbell Curl': 'Towel Curl',
  'Dumbbell Floor Press': 'Banded Push-Up',
  'Dumbbell Lateral Raise': 'Side-Lying Y Raise',
  'Dumbbell Overhead Press': 'Pike Push-Up',
  'Face Pull': 'Band Face Pull',
  'Front Plank': 'Front Plank',
  'Front Squat': 'Banded Front Squat',
  'Glute Bridge': 'Glute Bridge',
  'Goblet Squat': 'Banded Squat',
  'Hip Hinge with Band': 'Hip Hinge with Band',
  'Hip Thrust': 'Glute Bridge',
  'Incline DB Press': 'Banded Push-Up',
  'Incline Dumbbell Press': 'Banded Push-Up',
  'Incline Curl': 'Towel Curl',
  'Inverted Row': 'Banded Row',
  'Lat Pulldown': 'Band Lat Pulldown',
  'Lat Pulldown / Pull-Up': 'Band Lat Pulldown',
  'Lateral Raise': 'Side-Lying Y Raise',
  'Leg Curl': 'Banded Hamstring Curl',
  'Leg Press': 'Banded Front Squat',
  'Machine Chest Press': 'Banded Chest Press',
  'One-Arm DB Row': 'Banded Row',
  'One-Arm Dumbbell Row': 'Banded Row',
  'One-Arm Row': 'Banded Row',
  'Overhead Press': 'Pike Push-Up',
  'Pallof Press': 'Pallof Press',
  'Pike Push-Up': 'Pike Push-Up',
  'Plank': 'Plank',
  'Pull-Up': 'Band Lat Pulldown',
  'Push-Up': 'Push-Up',
  'Push-Up / DB Floor Press': 'Banded Push-Up',
  'Push-Up / DB Press': 'Banded Push-Up',
  'Romanian Deadlift': 'Banded Romanian Deadlift',
  'Seated Cable Row': 'Banded Row',
  'Seated Calf Raise': 'Banded Calf Raise',
  'Seated Dumbbell Shoulder Press': 'Pike Push-Up',
  'Seated Leg Curl': 'Banded Hamstring Curl',
  'Shoulder Press': 'Pike Push-Up',
  'Side Plank': 'Side Plank',
  'Single-Leg Calf Raise': 'Single-Leg Calf Raise',
  'Single-Leg Glute Bridge': 'Single-Leg Glute Bridge',
  'Single-Leg Hip Hinge': 'Single-Leg Hip Hinge',
  'Single-Leg RDL': 'Single-Leg Hip Hinge',
  'Slider Hamstring Curl': 'Banded Hamstring Curl',
  'Split Squat': 'Tempo Split Squat',
  'Standing Calf Raise': 'Banded Calf Raise',
  'Table Row': 'Banded Row',
  'Tempo Air Squat': 'Tempo Air Squat',
  'Tempo Split Squat': 'Tempo Split Squat',
  'Triceps Pressdown': 'Banded Triceps Pressdown',
  'Walking Lunge': 'Tempo Split Squat',
  'Weighted Pull-Up': 'Band Lat Pulldown',
});

// Rollout context is runtime-only; do not add it to the enumerable legacy
// adaptation contract that callers serialize and compare.
const EQUIPMENT_IDENTITY_MODES = new WeakMap<TrainingEquipmentAdaptation, TrainingExerciseIdentityV1Mode>();

export function buildTrainingEquipmentAdaptation(input: TrainingEquipmentAdaptationInput): TrainingEquipmentAdaptation {
  const canonicalProfile = resolveCanonicalEquipmentProfile({
    ...input,
    recordConservativeDefaultMetric: input.conservativeUnknown !== false,
  });
  const equipmentProfile = normalizeEquipmentProfile(input, canonicalProfile);
  const adaptation: TrainingEquipmentAdaptation = {
    equipmentProfile,
    canonicalProfile,
    decisionReasons: canonicalProfile.decisionReasons,
    summary: canonicalProfile.confidence === 'unknown'
      ? canonicalProfile.summary
      : equipmentSummary(equipmentProfile),
    promptBlock: equipmentPromptBlock(equipmentProfile),
    authority: input.conservativeUnknown ? 'coach_kernel' : 'legacy_route_adapter',
  };
  const exerciseIdentityMode = getTrainingExerciseIdentityV1Mode(input.env ?? process.env, input.scope);
  if (exerciseIdentityMode !== 'off') EQUIPMENT_IDENTITY_MODES.set(adaptation, exerciseIdentityMode);
  return adaptation;
}

export function adaptTrainingPlanToAvailableEquipment(
  plan: CoordinatedTrainingPlan,
  adaptation: TrainingEquipmentAdaptation,
): CoordinatedTrainingPlan {
  const cloned: CoordinatedTrainingPlan = JSON.parse(JSON.stringify(plan ?? {}));
  if (!Array.isArray(cloned.weeks)) return cloned;
  const exerciseIdentityMode = equipmentIdentityMode(adaptation);
  if (adaptation.equipmentProfile === 'full_gym') {
    return exerciseIdentityMode === 'off'
      ? cloned
      : normalizePlanExerciseIdentities(cloned, adaptation);
  }

  cloned.weeks = cloned.weeks.map((week) => ({
    ...week,
    sessions: Array.isArray(week.sessions)
      ? week.sessions.map((session) => adaptSession(session, adaptation))
      : week.sessions,
  }));

  return cloned;
}

function adaptSession(session: CoordinatedTrainingSession, adaptation: TrainingEquipmentAdaptation): CoordinatedTrainingSession {
  if (session.sessionType !== 'gym') return session;

  const exercises = Array.isArray(session.exercises) ? session.exercises : [];
  const adaptedExercises = exercises.length > 0
    ? exercises.map((exercise) => adaptExercise(exercise, adaptation))
    : fallbackTemplateForEquipment(adaptation.equipmentProfile, session);
  const identityClosedExercises = adaptedExercises.map((exercise) =>
    materializeEquipmentExercise(exercise, adaptation));

  const descriptionNote = equipmentDescriptionNote(adaptation.equipmentProfile);
  return {
    ...session,
    exercises: identityClosedExercises,
    description: [session.description, descriptionNote].filter(Boolean).join(' '),
  };
}

function adaptExercise(exercise: ExerciseLike, adaptation: TrainingEquipmentAdaptation): ExerciseLike {
  const equipmentProfile = adaptation.equipmentProfile;
  if (equipmentProfile === 'full_gym') return exercise;
  const name = String(exercise.name || '').trim();
  if (!name) return exercise;

  if (equipmentProfile === 'bands' && equipmentIdentityMode(adaptation) === 'active') {
    const replacement = reviewedActiveBandSubstitutionName(name);
    if (!replacement) {
      throw new TrainingExerciseIdentityError(
        'TRAINING_EXERCISE_IDENTITY_UNKNOWN',
        'No reviewed movement-role-preserving resistance-band substitution exists for this exercise.',
      );
    }
    return withAdaptedExerciseName(exercise, replacement);
  }

  for (const rule of SUBSTITUTION_RULES) {
    if (rule.match.test(name)) {
      const replacement = rule.replacements[equipmentProfile];
      if (replacement) {
        return withAdaptedExerciseName(exercise, replacement);
      }
    }
  }

  if (equipmentProfile === 'bodyweight') {
    return withAdaptedExerciseName(exercise, bodyweightFallbackName(name));
  }

  if (equipmentProfile === 'bands') {
    return withAdaptedExerciseName(exercise, legacyBandsFallbackName(name));
  }

  if (equipmentProfile === 'home_basic') {
    return withAdaptedExerciseName(exercise, homeBasicFallbackName(name));
  }

  return exercise;
}

function normalizeEquipmentProfile(
  input: TrainingEquipmentAdaptationInput,
  canonicalProfile: ResolvedEquipmentProfile,
): TrainingEquipmentProfile {
  if (canonicalProfile.confidence === 'unknown') {
    return input.conservativeUnknown ? 'bodyweight' : 'full_gym';
  }

  switch (canonicalProfile.bucket) {
    case 'garage_gym':
      return 'garage_gym';
    case 'home_basic':
    case 'hotel_gym':
      return 'home_basic';
    case 'bands':
      return 'bands';
    case 'bodyweight':
      return 'bodyweight';
    case 'full_gym':
    default:
      return 'full_gym';
  }
}

function equipmentPromptBlock(profile: TrainingEquipmentProfile): string {
  switch (profile) {
    case 'garage_gym':
      return [
        '- Assume a garage gym with barbell, rack, bench, and basic accessories only.',
        '- Avoid machine-only or cable-only prescriptions; substitute with barbell, dumbbell, band, or bodyweight options.',
      ].join('\n');
    case 'home_basic':
      return [
        '- Assume a basic home gym with dumbbells, bench, kettlebells, and simple accessories only.',
        '- Avoid barbell-only, cable-only, and machine-only prescriptions; prefer dumbbell, split-stance, band, or bodyweight substitutions.',
      ].join('\n');
    case 'bands':
      return [
        '- Assume resistance bands plus bodyweight only.',
        '- Replace barbell, dumbbell, cable, and machine work with banded, tempo, unilateral, or isometric alternatives.',
      ].join('\n');
    case 'bodyweight':
      return [
        '- Assume bodyweight-only training with no barbell, dumbbell, machine, or cable access.',
        '- Use bodyweight, tempo, unilateral, mobility, and core variations instead of equipment-dependent lifts.',
      ].join('\n');
    default:
      return [
        '- Full gym access is available.',
        '- Use substitutions only when they improve fit for the athlete profile or injury history.',
      ].join('\n');
  }
}

function equipmentSummary(profile: TrainingEquipmentProfile): string {
  switch (profile) {
    case 'garage_gym':
      return 'Garage gym (barbell + rack)';
    case 'home_basic':
      return 'Home gym (basic)';
    case 'bands':
      return 'Resistance bands';
    case 'bodyweight':
      return 'Bodyweight only';
    default:
      return 'Full gym';
  }
}

function equipmentDescriptionNote(profile: TrainingEquipmentProfile): string {
  switch (profile) {
    case 'garage_gym':
      return 'Adapted for garage-gym equipment so you can execute this session without machine-only stations.';
    case 'home_basic':
      return 'Adapted for a basic home gym so the session works with simple equipment only.';
    case 'bands':
      return 'Adapted for resistance-band access so the session stays executable without a full gym.';
    case 'bodyweight':
      return 'Adapted for bodyweight-only execution so you can complete the session without gym equipment.';
    default:
      return '';
  }
}

function fallbackTemplateForEquipment(
  equipmentProfile: TrainingEquipmentProfile,
  session: CoordinatedTrainingSession,
): ExerciseLike[] {
  switch (equipmentProfile) {
    case 'garage_gym':
      return GARAGE_GYM_FULL_BODY_TEMPLATE.map((exercise) => ({ ...exercise }));
    case 'home_basic':
      return HOME_BASIC_FULL_BODY_TEMPLATE.map((exercise) => ({ ...exercise }));
    case 'bands':
      return bandTemplateForSession(session);
    case 'bodyweight':
      return bodyweightTemplateForSession(session);
    default:
      return Array.isArray(session.exercises) ? session.exercises : [];
  }
}

function bandTemplateForSession(session: CoordinatedTrainingSession): ExerciseLike[] {
  if (/upper/i.test(session.title)) {
    return [
      { name: 'Banded Chest Press', sets: 4, reps: 12, rpe: '7', restSec: 60 },
      { name: 'Banded Row', sets: 4, reps: 12, rpe: '7', restSec: 60 },
      { name: 'Band Face Pull', sets: 3, reps: 15, rpe: '7', restSec: 45 },
      { name: 'Banded Triceps Pressdown', sets: 3, reps: 12, rpe: '7', restSec: 45 },
    ];
  }

  if (/lower/i.test(session.title)) {
    return [
      { name: 'Banded Front Squat', sets: 4, reps: 10, rpe: '7', restSec: 60 },
      { name: 'Banded Romanian Deadlift', sets: 3, reps: 10, rpe: '7', restSec: 60 },
      { name: 'Banded Hamstring Curl', sets: 3, reps: 12, rpe: '7', restSec: 45 },
      { name: 'Banded Calf Raise', sets: 3, reps: 15, rpe: '7', restSec: 30 },
    ];
  }

  return BANDS_FULL_BODY_TEMPLATE.map((exercise) => ({ ...exercise }));
}

function bodyweightTemplateForSession(session: CoordinatedTrainingSession): ExerciseLike[] {
  if (/upper/i.test(session.title)) {
    return [
      { name: 'Push-Up', sets: 4, reps: 10, rpe: '7', restSec: 60 },
      { name: 'Pike Push-Up', sets: 3, reps: 8, rpe: '7', restSec: 60 },
      { name: 'Prone Y-T-W Raise', sets: 3, reps: 12, rpe: '6', restSec: 45 },
      { name: 'Side Plank', sets: 3, reps: 30, rpe: '6', restSec: 30 },
    ];
  }

  if (/lower/i.test(session.title)) {
    return [
      { name: 'Tempo Split Squat', sets: 4, reps: 10, rpe: '7', restSec: 60 },
      { name: 'Single-Leg Hip Hinge', sets: 3, reps: 10, rpe: '7', restSec: 45 },
      { name: 'Single-Leg Glute Bridge', sets: 3, reps: 12, rpe: '7', restSec: 45 },
      { name: 'Single-Leg Calf Raise', sets: 3, reps: 15, rpe: '7', restSec: 30 },
    ];
  }

  return BODYWEIGHT_FULL_BODY_TEMPLATE.map((exercise) => ({ ...exercise }));
}

function homeBasicFallbackName(name: string): string {
  if (/\bpress\b/i.test(name)) return 'DB Floor Press';
  if (/\brow\b/i.test(name) || /\bpull\b/i.test(name)) return 'One-Arm DB Row';
  if (/\bsquat\b/i.test(name) || /\bleg press\b/i.test(name)) return 'Goblet Squat';
  if (/\bdeadlift\b|\brdl\b|\bhinge\b/i.test(name)) return 'DB Romanian Deadlift';
  return name;
}

function reviewedActiveBandSubstitutionName(name: string): string | null {
  const normalized = name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  for (const [reviewedName, replacement] of Object.entries(ACTIVE_BAND_SUBSTITUTIONS)) {
    if (reviewedName.toLocaleLowerCase('en-US') === normalized) return replacement;
  }
  return null;
}

/** Legacy-only rollback behavior. Active identity mode never calls this
 * dynamic free-text path. */
function legacyBandsFallbackName(name: string): string {
  if (/\bpress\b/i.test(name)) return 'Banded Chest Press';
  if (/\brow\b|\bpull\b/i.test(name)) return 'Banded Row';
  if (/\bsquat\b|\bleg press\b/i.test(name)) return 'Banded Squat';
  if (/\bdeadlift\b|\brdl\b|\bhinge\b/i.test(name)) return 'Banded Romanian Deadlift';
  return `Banded ${name}`.replace(/\bBanded Banded\b/i, 'Banded');
}

function bodyweightFallbackName(name: string): string {
  if (/\bpress\b/i.test(name)) return 'Push-Up';
  if (/\brow\b|\bpull\b/i.test(name)) return 'Prone Snow Angel';
  if (/\bsquat\b|\bleg press\b/i.test(name)) return 'Tempo Air Squat';
  if (/\bdeadlift\b|\brdl\b|\bhinge\b/i.test(name)) return 'Single-Leg Hip Hinge';
  if (/\bcalf\b/i.test(name)) return 'Single-Leg Calf Raise';
  return name;
}

function materializeEquipmentExercise(
  exercise: ExerciseLike,
  adaptation: TrainingEquipmentAdaptation,
): ExerciseLike {
  const name = String(exercise.name || '').trim();
  let canonicalId = EQUIPMENT_EMITTER_CANONICAL_IDS[name];
  const exerciseIdentityMode = equipmentIdentityMode(adaptation);
  if (!canonicalId && exerciseIdentityMode === 'active') {
    const resolution = resolveTrainingExerciseIdentity({ name });
    if (resolution.kind === 'canonical') canonicalId = resolution.canonicalId;
  }
  const exerciseWithEquipmentEvidence = adaptation.equipmentProfile === 'bodyweight'
    ? { ...exercise, equipment: ['bodyweight'] }
    : exercise;
  return materializeCanonicalTrainingExercise(exerciseWithEquipmentEvidence as Record<string, unknown>, {
    canonicalId,
    env: { TRAINING_EXERCISE_IDENTITY_V1_MODE: exerciseIdentityMode },
    source: 'training-plan-equipment-adaptation',
  }) as ExerciseLike;
}

function normalizePlanExerciseIdentities(
  plan: CoordinatedTrainingPlan,
  adaptation: TrainingEquipmentAdaptation,
): CoordinatedTrainingPlan {
  if (!Array.isArray(plan.weeks)) return plan;
  plan.weeks = plan.weeks.map((week) => ({
    ...week,
    sessions: Array.isArray(week.sessions)
      ? week.sessions.map((session) => ({
          ...session,
          exercises: Array.isArray(session.exercises)
            ? session.exercises.map((exercise) =>
                materializeEquipmentExercise(exercise as ExerciseLike, adaptation))
            : session.exercises,
        }))
      : week.sessions,
  }));
  return plan;
}

function equipmentIdentityMode(adaptation: TrainingEquipmentAdaptation): TrainingExerciseIdentityV1Mode {
  return EQUIPMENT_IDENTITY_MODES.get(adaptation)
    ?? getTrainingExerciseIdentityV1Mode(process.env);
}
