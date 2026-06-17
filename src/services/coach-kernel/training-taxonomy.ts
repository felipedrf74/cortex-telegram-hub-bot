// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

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

export const EXERCISE_LIBRARY: ExerciseDefinition[] = [
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

export function findExerciseDefinitionByName(name: unknown): ExerciseDefinition | null {
  const normalized = normalizeExerciseAlias(normalizeExerciseName(name));
  return EXERCISE_LIBRARY.find((exerciseDef) => normalizeExerciseName(exerciseDef.name) === normalized) ?? null;
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
