// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { TrainingPlanGoal } from '../training-plan-spec';
import type { MovementPattern, MuscleGroup } from './training-taxonomy';

export type SplitCode = 'AB' | 'ABC' | 'ABCD' | 'ABCDE' | 'ABCDEF';

export interface SplitSlotDefinition {
  slot: string;
  title: string;
  focus: string;
  primaryMuscles: MuscleGroup[];
  secondaryMuscles: MuscleGroup[];
  movementPatterns: MovementPattern[];
  lowerHeavy?: boolean;
  sectionBlueprint: Array<'warmup' | 'activation' | 'main_lift' | 'secondary_lift' | 'accessory' | 'core' | 'cooldown'>;
}

export interface SplitTemplate {
  code: SplitCode;
  daysPerWeek: number;
  goalFit: TrainingPlanGoal[];
  slots: SplitSlotDefinition[];
  rules: string[];
}

const WARM_MAIN_ACCESSORY_CORE = ['warmup', 'main_lift', 'secondary_lift', 'accessory', 'core', 'cooldown'] as const;

export const SPLIT_TEMPLATES: SplitTemplate[] = [
  {
    code: 'AB',
    daysPerWeek: 2,
    goalFit: ['strength', 'hypertrophy', 'general_fitness', 'hybrid', 'endurance_support'],
    rules: ['full_body_spacing', 'major_patterns_each_week'],
    slots: [
      slot('A', 'Full Body Strength A', 'Squat + push + pull', ['quads', 'glutes', 'chest', 'lats'], ['hamstrings', 'front_delts', 'triceps', 'abs'], ['squat', 'horizontal_push', 'vertical_push', 'vertical_pull', 'anti_extension_core'], true),
      slot('B', 'Full Body Strength B', 'Hinge + upper pull/push', ['hamstrings', 'glutes', 'upper_back', 'chest'], ['quads', 'biceps', 'abs'], ['hinge', 'horizontal_pull', 'horizontal_push', 'vertical_push', 'anti_rotation_core'], true),
    ],
  },
  {
    code: 'ABC',
    daysPerWeek: 3,
    goalFit: ['strength', 'hypertrophy', 'general_fitness', 'hybrid', 'endurance_support'],
    rules: ['full_body_or_push_pull_lower', 'no_lower_before_key_endurance_day'],
    slots: [
      slot('A', 'Full Body Strength A', 'Squat emphasis', ['quads', 'glutes', 'chest'], ['lats', 'triceps', 'abs'], ['squat', 'horizontal_push', 'vertical_pull', 'anti_extension_core'], true),
      slot('B', 'Full Body Strength B', 'Hinge and pull emphasis', ['hamstrings', 'glutes', 'upper_back'], ['biceps', 'rear_delts', 'abs'], ['hinge', 'horizontal_pull', 'rear_delt', 'anti_rotation_core'], true),
      slot('C', 'Full Body Hypertrophy C', 'Single-leg and accessories', ['chest', 'lats', 'quads'], ['upper_back', 'side_delts', 'biceps', 'triceps', 'calves'], ['lunge_split_squat', 'vertical_pull', 'horizontal_pull', 'horizontal_push', 'lateral_raise', 'elbow_extension'], false),
    ],
  },
  {
    code: 'ABCD',
    daysPerWeek: 4,
    goalFit: ['strength', 'hypertrophy', 'general_fitness', 'hybrid'],
    rules: ['upper_lower_spacing', 'two_lower_days_separated'],
    slots: [
      slot('A', 'Upper Strength A', 'Horizontal push/pull', ['chest', 'upper_back', 'lats'], ['front_delts', 'triceps', 'biceps'], ['horizontal_push', 'horizontal_pull', 'vertical_pull'], false),
      slot('B', 'Lower Quad B', 'Quad-dominant lower body', ['quads', 'glutes'], ['hamstrings', 'calves', 'abs'], ['squat', 'lunge_split_squat', 'knee_flexion', 'calf_raise', 'anti_extension_core'], true),
      slot('C', 'Upper Hypertrophy C', 'Vertical push/pull and arms', ['lats', 'side_delts', 'triceps'], ['upper_back', 'chest', 'biceps', 'rear_delts'], ['vertical_pull', 'horizontal_pull', 'vertical_push', 'horizontal_push', 'lateral_raise', 'elbow_flexion'], false),
      slot('D', 'Lower Posterior Chain D', 'Hinge and glute emphasis', ['hamstrings', 'glutes', 'spinal_erectors'], ['quads', 'calves', 'abs'], ['hinge', 'hip_thrust_bridge', 'knee_flexion', 'lunge_split_squat', 'anti_rotation_core'], true),
    ],
  },
  {
    code: 'ABCDE',
    daysPerWeek: 5,
    goalFit: ['strength', 'hypertrophy', 'hybrid'],
    rules: ['unique_slots', 'no_adjacent_same_primary', 'lower_days_separated', 'major_groups_twice_weekly'],
    slots: [
      slot('A', 'Push Hypertrophy A', 'Chest, delts, triceps', ['chest', 'front_delts', 'triceps'], ['side_delts', 'abs'], ['horizontal_push', 'vertical_push', 'elbow_extension'], false),
      slot('B', 'Lower Quad B', 'Quad-dominant lower body', ['quads', 'glutes'], ['hamstrings', 'calves', 'abs'], ['squat', 'lunge_split_squat', 'knee_flexion', 'calf_raise', 'anti_extension_core'], true),
      slot('C', 'Pull Hypertrophy C', 'Back and biceps', ['lats', 'upper_back', 'biceps'], ['rear_delts', 'forearms', 'abs'], ['vertical_pull', 'horizontal_pull', 'elbow_flexion', 'rear_delt'], false),
      slot('D', 'Lower Posterior Chain D', 'Hamstrings and glutes', ['hamstrings', 'glutes', 'spinal_erectors'], ['quads', 'calves', 'abs'], ['hinge', 'hip_thrust_bridge', 'knee_flexion', 'lunge_split_squat', 'anti_rotation_core'], true),
      slot('E', 'Upper Accessories E', 'Delts, arms, upper-back balance', ['side_delts', 'rear_delts', 'triceps', 'biceps'], ['upper_back', 'chest', 'forearms'], ['horizontal_push', 'horizontal_pull', 'lateral_raise', 'rear_delt', 'elbow_extension', 'elbow_flexion'], false),
    ],
  },
  {
    code: 'ABCDEF',
    daysPerWeek: 6,
    goalFit: ['strength', 'hypertrophy'],
    rules: ['push_pull_legs_repeat', 'no_same_pattern_back_to_back'],
    slots: [
      slot('A', 'Push Strength A', 'Heavy push', ['chest', 'front_delts', 'triceps'], ['side_delts', 'abs'], ['horizontal_push', 'vertical_push', 'elbow_extension'], false),
      slot('B', 'Pull Strength B', 'Heavy pull', ['lats', 'upper_back', 'biceps'], ['rear_delts', 'forearms'], ['vertical_pull', 'horizontal_pull', 'elbow_flexion'], false),
      slot('C', 'Lower Strength C', 'Heavy squat/hinge', ['quads', 'glutes', 'hamstrings'], ['calves', 'abs'], ['squat', 'hinge', 'calf_raise'], true),
      slot('D', 'Push Hypertrophy D', 'Volume push', ['chest', 'side_delts', 'triceps'], ['front_delts', 'abs'], ['horizontal_push', 'lateral_raise', 'elbow_extension'], false),
      slot('E', 'Pull Hypertrophy E', 'Volume pull', ['lats', 'upper_back', 'rear_delts'], ['biceps', 'forearms'], ['vertical_pull', 'horizontal_pull', 'rear_delt'], false),
      slot('F', 'Lower Hypertrophy F', 'Lower volume and core', ['quads', 'hamstrings', 'glutes'], ['calves', 'abs', 'obliques'], ['lunge_split_squat', 'knee_flexion', 'hip_thrust_bridge', 'anti_rotation_core'], true),
    ],
  },
];

export function selectSplitTemplate(daysPerWeek: number, goal: TrainingPlanGoal): SplitTemplate {
  const clamped = Math.min(Math.max(Math.round(daysPerWeek || 5), 2), 6);
  const exact = SPLIT_TEMPLATES.find((template) =>
    template.daysPerWeek === clamped && template.goalFit.includes(goal)
  );
  if (exact) return exact;
  return SPLIT_TEMPLATES.find((template) => template.daysPerWeek === clamped) ?? SPLIT_TEMPLATES[3];
}

export function formatSplitSessionTitle(slotDef: SplitSlotDefinition, goal: TrainingPlanGoal): string {
  if (goal === 'strength' && slotDef.title.includes('Hypertrophy')) {
    return slotDef.title.replace('Hypertrophy', 'Strength');
  }
  if (goal === 'general_fitness') {
    return slotDef.title.replace('Hypertrophy', 'Training').replace('Strength', 'Training');
  }
  return slotDef.title;
}

function slot(
  slotId: string,
  title: string,
  focus: string,
  primaryMuscles: MuscleGroup[],
  secondaryMuscles: MuscleGroup[],
  movementPatterns: MovementPattern[],
  lowerHeavy = false,
): SplitSlotDefinition {
  return {
    slot: slotId,
    title,
    focus,
    primaryMuscles,
    secondaryMuscles,
    movementPatterns,
    lowerHeavy,
    sectionBlueprint: [...WARM_MAIN_ACCESSORY_CORE],
  };
}
