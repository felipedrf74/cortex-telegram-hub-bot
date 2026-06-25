// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { buildRepoTrainingCatalogSnapshot, type ExerciseCatalogEntry } from './training-catalog';

export type MuscleGroup =
  | 'chest'
  | 'front_delts'
  | 'side_delts'
  | 'rear_delts'
  | 'lats'
  | 'upper_back'
  | 'traps'
  | 'biceps'
  | 'triceps'
  | 'forearms'
  | 'quads'
  | 'hamstrings'
  | 'glutes'
  | 'calves'
  | 'abs'
  | 'obliques'
  | 'spinal_erectors';

export type MovementPattern =
  | 'horizontal_push'
  | 'vertical_push'
  | 'horizontal_pull'
  | 'vertical_pull'
  | 'squat'
  | 'hinge'
  | 'lunge_split_squat'
  | 'knee_flexion'
  | 'hip_thrust_bridge'
  | 'calf_raise'
  | 'elbow_flexion'
  | 'elbow_extension'
  | 'lateral_raise'
  | 'rear_delt'
  | 'loaded_carry'
  | 'anti_extension_core'
  | 'anti_rotation_core';

export interface ExerciseDefinition {
  id: string;
  name: string;
  equipment: string[];
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
  movementPattern: MovementPattern;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  axialLoad: 'low' | 'medium' | 'high';
  jointStress: {
    shoulder?: 'low' | 'medium' | 'high';
    knee?: 'low' | 'medium' | 'high';
    lowerBack?: 'low' | 'medium' | 'high';
  };
  suitableGoals: Array<'strength' | 'hypertrophy' | 'general_fitness'>;
}

export interface SetContribution {
  direct: Partial<Record<MuscleGroup, number>>;
  indirect: Partial<Record<MuscleGroup, number>>;
}

export interface WeeklyVolumeTarget {
  muscle: MuscleGroup;
  minDirectSets: number;
  targetDirectSets: number;
  maxDirectSets: number;
  targetFrequency: number;
}

export const MAJOR_MUSCLE_GROUPS: MuscleGroup[] = [
  'chest',
  'lats',
  'upper_back',
  'quads',
  'hamstrings',
  'glutes',
];

export const UNIVERSAL_FALLBACK_EXERCISES = new Set([
  'goblet squat',
  'bodyweight squat',
]);

const EMERGENCY_EXERCISE_LIBRARY: ExerciseDefinition[] = [
  exercise('dumbbell_bench_press', 'Dumbbell Bench Press', ['dumbbell', 'bench'], ['chest'], ['front_delts', 'triceps'], 'horizontal_push', 'beginner', 'low', { shoulder: 'medium' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('push_up', 'Push-Up', ['bodyweight'], ['chest'], ['front_delts', 'triceps'], 'horizontal_push', 'beginner', 'low', { shoulder: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('floor_press', 'Dumbbell Floor Press', ['dumbbell'], ['chest'], ['triceps'], 'horizontal_push', 'beginner', 'low', { shoulder: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('incline_dumbbell_press', 'Incline Dumbbell Press', ['dumbbell', 'bench'], ['chest', 'front_delts'], ['triceps'], 'horizontal_push', 'intermediate', 'low', { shoulder: 'medium' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('seated_dumbbell_shoulder_press', 'Seated Dumbbell Shoulder Press', ['dumbbell', 'bench'], ['front_delts', 'side_delts'], ['triceps'], 'vertical_push', 'intermediate', 'low', { shoulder: 'medium' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('pike_push_up', 'Pike Push-Up', ['bodyweight'], ['front_delts'], ['triceps'], 'vertical_push', 'intermediate', 'low', { shoulder: 'medium' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('close_grip_push_up', 'Close-Grip Push-Up', ['bodyweight'], ['triceps', 'chest'], ['front_delts'], 'elbow_extension', 'intermediate', 'low', { shoulder: 'medium' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('cable_triceps_pressdown', 'Cable Triceps Pressdown', ['cable'], ['triceps'], [], 'elbow_extension', 'beginner', 'low', { shoulder: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('dumbbell_triceps_extension', 'Dumbbell Triceps Extension', ['dumbbell'], ['triceps'], [], 'elbow_extension', 'beginner', 'low', { shoulder: 'medium' }, ['hypertrophy', 'general_fitness']),
  exercise('dead_bug', 'Dead Bug', ['bodyweight'], ['abs'], ['obliques'], 'anti_extension_core', 'beginner', 'low', { lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('front_squat', 'Front Squat', ['barbell'], ['quads', 'glutes'], ['abs', 'spinal_erectors'], 'squat', 'intermediate', 'high', { knee: 'medium', lowerBack: 'medium' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('goblet_squat', 'Goblet Squat', ['dumbbell'], ['quads', 'glutes'], ['abs'], 'squat', 'beginner', 'medium', { knee: 'medium', lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('bodyweight_squat', 'Bodyweight Squat', ['bodyweight'], ['quads', 'glutes'], ['abs'], 'squat', 'beginner', 'low', { knee: 'medium', lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('leg_press', 'Leg Press', ['machine'], ['quads', 'glutes'], [], 'squat', 'beginner', 'low', { knee: 'medium', lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('step_up', 'Step-Up', ['bodyweight'], ['quads', 'glutes'], ['hamstrings'], 'lunge_split_squat', 'beginner', 'low', { knee: 'low', lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('bulgarian_split_squat', 'Bulgarian Split Squat', ['bodyweight'], ['quads', 'glutes'], ['hamstrings'], 'lunge_split_squat', 'intermediate', 'medium', { knee: 'medium', lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('standing_calf_raise', 'Standing Calf Raise', ['machine', 'dumbbell'], ['calves'], [], 'calf_raise', 'beginner', 'low', { knee: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('calf_raise', 'Calf Raise', ['bodyweight', 'dumbbell'], ['calves'], [], 'calf_raise', 'beginner', 'low', { knee: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('pallof_press', 'Pallof Press', ['cable', 'band'], ['obliques', 'abs'], [], 'anti_rotation_core', 'beginner', 'low', { lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('lat_pulldown', 'Lat Pulldown', ['machine', 'cable'], ['lats'], ['biceps', 'upper_back'], 'vertical_pull', 'beginner', 'low', { shoulder: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('band_pulldown', 'Band Pulldown', ['band'], ['lats'], ['biceps'], 'vertical_pull', 'beginner', 'low', { shoulder: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('prone_lat_pulldown', 'Prone Lat Pulldown', ['bodyweight'], ['lats'], ['upper_back'], 'vertical_pull', 'beginner', 'low', { shoulder: 'low', lowerBack: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('chest_supported_row', 'Chest-Supported Row', ['dumbbell', 'bench'], ['upper_back', 'lats'], ['biceps', 'rear_delts'], 'horizontal_pull', 'beginner', 'low', { shoulder: 'low', lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('one_arm_dumbbell_row', 'One-Arm Dumbbell Row', ['dumbbell', 'bench'], ['lats', 'upper_back'], ['biceps'], 'horizontal_pull', 'beginner', 'low', { shoulder: 'low', lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('inverted_row', 'Inverted Row', ['bodyweight'], ['upper_back', 'lats'], ['biceps'], 'horizontal_pull', 'intermediate', 'low', { shoulder: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('face_pull', 'Face Pull', ['cable', 'band'], ['rear_delts', 'upper_back'], ['traps'], 'rear_delt', 'beginner', 'low', { shoulder: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('dumbbell_curl', 'Dumbbell Curl', ['dumbbell'], ['biceps'], ['forearms'], 'elbow_flexion', 'beginner', 'low', {}, ['hypertrophy', 'general_fitness']),
  exercise('towel_curl', 'Towel Curl', ['bodyweight'], ['biceps'], ['forearms'], 'elbow_flexion', 'beginner', 'low', {}, ['hypertrophy', 'general_fitness']),
  exercise('romanian_deadlift', 'Romanian Deadlift', ['barbell', 'dumbbell'], ['hamstrings', 'glutes'], ['spinal_erectors'], 'hinge', 'intermediate', 'high', { lowerBack: 'medium' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('kettlebell_rdl', 'Kettlebell Romanian Deadlift', ['kettlebell'], ['hamstrings', 'glutes'], ['spinal_erectors'], 'hinge', 'beginner', 'medium', { lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('single_leg_hip_hinge', 'Single-Leg Hip Hinge', ['bodyweight'], ['hamstrings', 'glutes'], ['abs'], 'hinge', 'beginner', 'low', { knee: 'low', lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('hip_thrust', 'Hip Thrust', ['barbell', 'bench'], ['glutes'], ['hamstrings'], 'hip_thrust_bridge', 'intermediate', 'medium', { lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('glute_bridge', 'Glute Bridge', ['bodyweight', 'dumbbell'], ['glutes', 'hamstrings'], [], 'hip_thrust_bridge', 'beginner', 'low', { lowerBack: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('seated_leg_curl', 'Seated Leg Curl', ['machine'], ['hamstrings'], [], 'knee_flexion', 'beginner', 'low', { knee: 'low', lowerBack: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('slider_leg_curl', 'Slider Leg Curl', ['bodyweight'], ['hamstrings'], ['glutes'], 'knee_flexion', 'intermediate', 'low', { knee: 'low', lowerBack: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('back_extension', 'Back Extension', ['machine', 'bodyweight'], ['spinal_erectors', 'glutes'], ['hamstrings'], 'hinge', 'intermediate', 'medium', { lowerBack: 'medium' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('bird_dog', 'Bird Dog', ['bodyweight'], ['spinal_erectors', 'abs'], ['glutes'], 'anti_extension_core', 'beginner', 'low', { lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('side_plank', 'Side Plank', ['bodyweight'], ['obliques', 'abs'], [], 'anti_rotation_core', 'beginner', 'low', { lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('dumbbell_lateral_raise', 'Dumbbell Lateral Raise', ['dumbbell'], ['side_delts'], [], 'lateral_raise', 'beginner', 'low', { shoulder: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('side_lying_y_raise', 'Side-Lying Y Raise', ['bodyweight'], ['side_delts'], ['rear_delts'], 'lateral_raise', 'beginner', 'low', { shoulder: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('rear_delt_fly', 'Rear Delt Fly', ['dumbbell', 'machine'], ['rear_delts'], ['upper_back'], 'rear_delt', 'beginner', 'low', { shoulder: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('prone_y_raise', 'Prone Y Raise', ['bodyweight'], ['rear_delts', 'upper_back'], ['traps'], 'rear_delt', 'beginner', 'low', { shoulder: 'low', lowerBack: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('cable_row', 'Cable Row', ['cable', 'machine'], ['upper_back', 'lats'], ['biceps', 'rear_delts'], 'horizontal_pull', 'beginner', 'low', { shoulder: 'low', lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
  exercise('band_row', 'Band Row', ['band'], ['upper_back', 'lats'], ['biceps'], 'horizontal_pull', 'beginner', 'low', { shoulder: 'low' }, ['hypertrophy', 'general_fitness']),
  exercise('overhead_triceps_extension', 'Overhead Triceps Extension', ['dumbbell', 'cable'], ['triceps'], [], 'elbow_extension', 'beginner', 'low', { shoulder: 'medium' }, ['hypertrophy', 'general_fitness']),
  exercise('hammer_curl', 'Hammer Curl', ['dumbbell'], ['biceps', 'forearms'], [], 'elbow_flexion', 'beginner', 'low', {}, ['hypertrophy', 'general_fitness']),
  exercise('walking_lunge', 'Walking Lunge', ['bodyweight'], ['quads', 'glutes'], ['hamstrings'], 'lunge_split_squat', 'intermediate', 'medium', { knee: 'medium', lowerBack: 'low' }, ['strength', 'hypertrophy', 'general_fitness']),
];

export const EXERCISE_LIBRARY: ExerciseDefinition[] = buildCanonicalExerciseLibrary();

export function findExerciseDefinitionByName(name: unknown): ExerciseDefinition | null {
  const normalized = normalizeExerciseAlias(normalizeExerciseName(name));
  return EXERCISE_LIBRARY.find((exerciseDef) =>
    normalizeExerciseAlias(normalizeExerciseName(exerciseDef.name)) === normalized
    || normalizeExerciseName(exerciseDef.id) === normalized
  ) ?? null;
}

function buildCanonicalExerciseLibrary(): ExerciseDefinition[] {
  try {
    const snapshot = buildRepoTrainingCatalogSnapshot();
    const catalogDefinitions = snapshot.exercises
      .filter((entry) => entry.active && (entry.modality === 'strength' || entry.modality === 'mobility' || entry.modality === 'prehab'))
      .map(exerciseDefinitionFromCatalogEntry)
      .filter((entry): entry is ExerciseDefinition => entry != null);
    return mergeExerciseDefinitions(catalogDefinitions, EMERGENCY_EXERCISE_LIBRARY);
  } catch {
    return EMERGENCY_EXERCISE_LIBRARY;
  }
}

function exerciseDefinitionFromCatalogEntry(entry: ExerciseCatalogEntry): ExerciseDefinition | null {
  const movementPattern = mapCatalogMovementPattern(entry);
  if (!movementPattern) return null;
  const refinedMuscles = refineCatalogMuscles(entry, movementPattern);
  return {
    id: entry.id,
    name: entry.canonicalName,
    equipment: normalizeCatalogEquipment(entry),
    primaryMuscles: refinedMuscles.primary,
    secondaryMuscles: refinedMuscles.secondary,
    movementPattern,
    difficulty: mapCatalogDifficulty(entry.difficulty),
    axialLoad: mapCatalogAxialLoad(entry.spinalLoading),
    jointStress: mapCatalogJointStress(entry),
    suitableGoals: ['strength', 'hypertrophy', 'general_fitness'],
  };
}

function refineCatalogMuscles(
  entry: ExerciseCatalogEntry,
  movementPattern: MovementPattern,
): { primary: MuscleGroup[]; secondary: MuscleGroup[] } {
  const catalogPrimary = entry.primaryMuscles.map(normalizeMuscleGroup).filter((muscle): muscle is MuscleGroup => muscle != null);
  const catalogSecondary = entry.secondaryMuscles.map(normalizeMuscleGroup).filter((muscle): muscle is MuscleGroup => muscle != null);
  const name = normalizeExerciseName(entry.canonicalName);

  if (movementPattern === 'elbow_flexion') return { primary: ['biceps'], secondary: ['forearms'] };
  if (movementPattern === 'elbow_extension') return { primary: ['triceps'], secondary: [] };
  if (movementPattern === 'lateral_raise') return { primary: ['side_delts'], secondary: [] };
  if (movementPattern === 'rear_delt') return { primary: ['rear_delts', 'upper_back'], secondary: ['traps'] };
  if (movementPattern === 'knee_flexion') return { primary: ['hamstrings'], secondary: [] };
  if (movementPattern === 'hip_thrust_bridge') return { primary: ['glutes'], secondary: ['hamstrings'] };
  if (movementPattern === 'calf_raise') return { primary: ['calves'], secondary: [] };
  if (movementPattern === 'anti_rotation_core') return { primary: ['obliques', 'abs'], secondary: [] };
  if (movementPattern === 'anti_extension_core') return { primary: ['abs'], secondary: ['obliques'] };
  if (movementPattern === 'vertical_push' && /\b(shoulder|overhead|pike)\b/.test(name)) {
    return { primary: ['front_delts', 'side_delts'], secondary: ['triceps'] };
  }
  if (movementPattern === 'horizontal_push') return { primary: ['chest'], secondary: ['front_delts', 'triceps'] };
  if (movementPattern === 'vertical_pull') return { primary: ['lats'], secondary: ['biceps', 'upper_back'] };
  if (movementPattern === 'horizontal_pull') return { primary: ['upper_back', 'lats'], secondary: ['biceps', 'rear_delts'] };
  if (movementPattern === 'squat' || movementPattern === 'lunge_split_squat') return { primary: ['quads', 'glutes'], secondary: ['hamstrings'] };
  if (movementPattern === 'hinge') return { primary: ['hamstrings', 'glutes'], secondary: ['spinal_erectors'] };

  return {
    primary: catalogPrimary.length > 0 ? catalogPrimary : ['abs'],
    secondary: catalogSecondary,
  };
}

function mergeExerciseDefinitions(
  primary: ExerciseDefinition[],
  emergency: ExerciseDefinition[],
): ExerciseDefinition[] {
  const seen = new Set<string>();
  const merged: ExerciseDefinition[] = [];
  for (const definition of [...primary, ...emergency]) {
    const key = normalizeExerciseAlias(normalizeExerciseName(definition.name));
    const idKey = normalizeExerciseName(definition.id);
    if (seen.has(key) || seen.has(idKey)) continue;
    seen.add(key);
    seen.add(idKey);
    merged.push(definition);
  }
  return merged;
}

function mapCatalogMovementPattern(entry: ExerciseCatalogEntry): MovementPattern | null {
  const name = normalizeExerciseName(entry.canonicalName);
  if (/\b(calf|calves)\b/.test(name)) return 'calf_raise';
  if (/\b(curl|biceps|hammer)\b/.test(name)) return 'elbow_flexion';
  if (/\b(triceps|pressdown|extension)\b/.test(name)) return 'elbow_extension';
  if (/\b(lateral raise|side lying y raise)\b/.test(name)) return 'lateral_raise';
  if (/\b(rear delt|face pull|prone y raise)\b/.test(name)) return 'rear_delt';
  if (/\b(leg curl|hamstring curl)\b/.test(name)) return 'knee_flexion';
  if (/\b(hip thrust|glute bridge)\b/.test(name)) return 'hip_thrust_bridge';
  if (/\b(pallof|side plank|rotation)\b/.test(name)) return 'anti_rotation_core';
  if (/\b(dead bug|bird dog|plank|core)\b/.test(name)) return 'anti_extension_core';

  switch (entry.movementPattern) {
    case 'horizontal_push':
    case 'vertical_push':
    case 'horizontal_pull':
    case 'vertical_pull':
    case 'squat':
    case 'hinge':
      return entry.movementPattern;
    case 'lunge':
    case 'step_up':
      return 'lunge_split_squat';
    case 'anti_rotation':
    case 'rotation':
      return 'anti_rotation_core';
    case 'anti_extension':
    case 'core_flexion':
    case 'core_lateral_flexion':
      return 'anti_extension_core';
    case 'calf_ankle':
      return 'calf_raise';
    case 'carry':
      return 'loaded_carry';
    case 'shoulder_stability':
    case 'scapular_control':
      return 'rear_delt';
    default:
      return null;
  }
}

function normalizeCatalogEquipment(entry: ExerciseCatalogEntry): string[] {
  const raw = [
    ...(entry.equipmentRequirements.requiredAllOf ?? []),
    ...(entry.equipmentRequirements.requiredAnyOf ?? []).flat(),
    ...(entry.equipmentRequirements.optional ?? []),
  ];
  const normalized = raw
    .map((item) => {
      const token = String(item || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      switch (token) {
        case '':
        case 'none':
        case 'no_equipment':
          return null;
        case 'dumbbells':
        case 'dumbbell':
          return 'dumbbell';
        case 'resistance_band':
        case 'resistance_bands':
        case 'bands':
          return 'band';
        case 'cables':
        case 'cable_machine':
          return 'cable';
        case 'machines':
          return 'machine';
        case 'kettlebells':
          return 'kettlebell';
        default:
          return token;
      }
    })
    .filter((item): item is string => item != null);
  return normalized.length > 0 ? Array.from(new Set(normalized)) : ['bodyweight'];
}

function mapCatalogDifficulty(difficulty: ExerciseCatalogEntry['difficulty']): ExerciseDefinition['difficulty'] {
  if (difficulty <= 2) return 'beginner';
  if (difficulty <= 4) return 'intermediate';
  return 'advanced';
}

function mapCatalogAxialLoad(spinalLoading: ExerciseCatalogEntry['spinalLoading']): ExerciseDefinition['axialLoad'] {
  switch (spinalLoading) {
    case 'high':
      return 'high';
    case 'moderate':
      return 'medium';
    default:
      return 'low';
  }
}

function mapCatalogJointStress(entry: ExerciseCatalogEntry): ExerciseDefinition['jointStress'] {
  const flags = new Set([...entry.contraindicationFlags, ...entry.cautionFlags].map((flag) => String(flag).toLowerCase()));
  const name = normalizeExerciseName(entry.canonicalName);
  const kneeStress: ExerciseDefinition['jointStress']['knee'] =
    flags.has('knee_pain')
      || flags.has('patellar_pain')
      || flags.has('meniscus')
      || flags.has('acl')
      || entry.impact === 'high'
      ? 'high'
      : /\b(squat|lunge|leg press)\b/.test(name)
        || entry.movementPattern === 'squat'
        || entry.movementPattern === 'lunge'
        ? 'medium'
        : 'low';
  return {
    shoulder: flags.has('shoulder_pain') || flags.has('shoulder_impingement') ? 'high' : 'low',
    knee: kneeStress,
    lowerBack: flags.has('low_back') || entry.spinalLoading === 'high'
      ? 'high'
      : entry.spinalLoading === 'moderate'
        ? 'medium'
        : 'low',
  };
}

export function normalizeMuscleGroup(raw: unknown): MuscleGroup | null {
  const text = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
  switch (text) {
    case 'quad':
    case 'quadriceps':
    case 'quads':
      return 'quads';
    case 'hamstring':
    case 'hamstrings':
      return 'hamstrings';
    case 'glute':
    case 'glutes':
      return 'glutes';
    case 'shoulder':
    case 'shoulders':
    case 'front_delt':
    case 'front_delts':
      return 'front_delts';
    case 'side_delt':
    case 'side_delts':
    case 'lateral_delt':
    case 'lateral_delts':
      return 'side_delts';
    case 'rear_delt':
    case 'rear_delts':
      return 'rear_delts';
    case 'back':
    case 'upper_back':
      return 'upper_back';
    case 'lat':
    case 'lats':
      return 'lats';
    case 'core':
    case 'abdominals':
    case 'abs':
      return 'abs';
    case 'oblique':
    case 'obliques':
      return 'obliques';
    case 'erectors':
    case 'spinal_erectors':
      return 'spinal_erectors';
    case 'chest':
    case 'traps':
    case 'biceps':
    case 'triceps':
    case 'forearms':
    case 'calves':
      return text as MuscleGroup;
    default:
      return null;
  }
}

function exercise(
  id: string,
  name: string,
  equipment: string[],
  primaryMuscles: MuscleGroup[],
  secondaryMuscles: MuscleGroup[],
  movementPattern: MovementPattern,
  difficulty: ExerciseDefinition['difficulty'],
  axialLoad: ExerciseDefinition['axialLoad'],
  jointStress: ExerciseDefinition['jointStress'],
  suitableGoals: ExerciseDefinition['suitableGoals'],
): ExerciseDefinition {
  return {
    id,
    name,
    equipment,
    primaryMuscles,
    secondaryMuscles,
    movementPattern,
    difficulty,
    axialLoad,
    jointStress,
    suitableGoals,
  };
}

function normalizeExerciseName(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeExerciseAlias(value: string): string {
  switch (value) {
    case 'db floor press':
      return 'dumbbell floor press';
    case 'db bench press':
      return 'dumbbell bench press';
    default:
      return value;
  }
}

export function directSetContribution(
  primaryMuscles: MuscleGroup[],
  sets: number,
): SetContribution {
  const direct: Partial<Record<MuscleGroup, number>> = {};
  for (const muscle of primaryMuscles) {
    direct[muscle] = (direct[muscle] ?? 0) + sets;
  }
  return { direct, indirect: {} };
}
