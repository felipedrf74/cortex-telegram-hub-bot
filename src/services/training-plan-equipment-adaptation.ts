// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { CoordinatedTrainingPlan, CoordinatedTrainingSession } from './training-plan-coordination';

export type TrainingEquipmentProfile =
  | 'full_gym'
  | 'garage_gym'
  | 'home_basic'
  | 'bands'
  | 'bodyweight';

export interface TrainingEquipmentAdaptationInput {
  fitnessProfile?: Record<string, any> | null;
  gymProfile?: Record<string, any> | null;
}

export interface TrainingEquipmentAdaptation {
  equipmentProfile: TrainingEquipmentProfile;
  promptBlock: string;
  summary: string;
}

type ExerciseLike = {
  name?: string;
  sets?: number;
  reps?: number | string;
  rpe?: string;
  restSec?: number;
};

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

export function buildTrainingEquipmentAdaptation(input: TrainingEquipmentAdaptationInput): TrainingEquipmentAdaptation {
  const equipmentProfile = normalizeEquipmentProfile(input);
  return {
    equipmentProfile,
    summary: equipmentSummary(equipmentProfile),
    promptBlock: equipmentPromptBlock(equipmentProfile),
  };
}

export function adaptTrainingPlanToAvailableEquipment(
  plan: CoordinatedTrainingPlan,
  adaptation: TrainingEquipmentAdaptation,
): CoordinatedTrainingPlan {
  const cloned: CoordinatedTrainingPlan = JSON.parse(JSON.stringify(plan ?? {}));
  if (!Array.isArray(cloned.weeks)) return cloned;
  if (adaptation.equipmentProfile === 'full_gym') return cloned;

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
    ? exercises.map((exercise) => adaptExercise(exercise, adaptation.equipmentProfile))
    : fallbackTemplateForEquipment(adaptation.equipmentProfile, session);

  const descriptionNote = equipmentDescriptionNote(adaptation.equipmentProfile);
  return {
    ...session,
    exercises: adaptedExercises,
    description: [session.description, descriptionNote].filter(Boolean).join(' '),
  };
}

function adaptExercise(exercise: ExerciseLike, equipmentProfile: TrainingEquipmentProfile): ExerciseLike {
  if (equipmentProfile === 'full_gym') return exercise;
  const name = String(exercise.name || '').trim();
  if (!name) return exercise;

  for (const rule of SUBSTITUTION_RULES) {
    if (rule.match.test(name)) {
      const replacement = rule.replacements[equipmentProfile];
      if (replacement) {
        return { ...exercise, name: replacement };
      }
    }
  }

  if (equipmentProfile === 'bodyweight') {
    return {
      ...exercise,
      name: bodyweightFallbackName(name),
    };
  }

  if (equipmentProfile === 'bands') {
    return {
      ...exercise,
      name: bandsFallbackName(name),
    };
  }

  if (equipmentProfile === 'home_basic') {
    return {
      ...exercise,
      name: homeBasicFallbackName(name),
    };
  }

  return exercise;
}

function normalizeEquipmentProfile(input: TrainingEquipmentAdaptationInput): TrainingEquipmentProfile {
  const raw = [
    input.gymProfile?.equipment_access,
    input.fitnessProfile?.available_equipment,
    input.fitnessProfile?.equipment,
  ]
    .find((value) => typeof value === 'string' && value.trim().length > 0);

  const normalized = String(raw || '').trim().toLowerCase();
  if (normalized.includes('garage')) return 'garage_gym';
  if (normalized.includes('full commercial') || normalized.includes('full gym') || normalized === 'full_gym') return 'full_gym';
  if (normalized.includes('home gym') || normalized.includes('home_gym') || normalized.includes('basic')) return 'home_basic';
  if (normalized.includes('resistance band') || normalized === 'bands' || normalized.includes('band')) return 'bands';
  if (
    normalized.includes('bodyweight') ||
    normalized.includes('no equipment') ||
    normalized.includes('no-equipment') ||
    normalized.includes('without equipment') ||
    normalized.includes('sem equipamento') ||
    normalized.includes('peso corporal') ||
    normalized === 'none'
  ) {
    return 'bodyweight';
  }
  return 'full_gym';
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

function bandsFallbackName(name: string): string {
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
