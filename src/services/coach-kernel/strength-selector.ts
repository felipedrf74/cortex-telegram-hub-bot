// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  exerciseConflictsWithUserPain,
  getExerciseComplexity,
  getExercisePrimaryPurpose,
  getExerciseSpinalLoading,
} from './exercise-metadata';
import { incrementTrainingGenerationCounter } from '../training-generation-observability';
import { loadTrainingCatalogSnapshot } from './training-catalog';
import type {
  AthleteState,
  Exercise,
  ExerciseSelectionReason,
} from './types';

export type StrengthSelectorProfile = 'maintenance' | 'hypertrophy' | 'max_strength' | 'athletic' | 'hybrid';

export interface CatalogStrengthVariant {
  title: string;
  exerciseIds: string[];
  tags: string[];
}

export interface StrengthSelectorTrace {
  selectorPolicyVersion: string;
  catalogVersion: string;
  candidateIds: string[];
  selectedIds: string[];
  selectedScores: Array<{ exerciseId: string; score: number }>;
  rejectedCandidateReasons: Array<{ exerciseId: string; reason: string }>;
}

export interface StrengthSelectorResult {
  variant: CatalogStrengthVariant;
  selectionReasons: Map<string, ExerciseSelectionReason>;
  trace: StrengthSelectorTrace;
}

export interface SelectStrengthExercisesInput {
  library: Exercise[];
  athlete: AthleteState;
  availableEquipment: ReadonlySet<string>;
  profile: StrengthSelectorProfile;
  durationMinutes: number;
  targetCount: number;
  targetSessions: number;
  sessionIndex: number;
  weekIndex: number;
}

type StrengthPattern = Exercise['movementPattern'];

export const STRENGTH_SELECTOR_POLICY_VERSION = 'selector-policy-v2';

export function selectStrengthExercisesFromCatalog(input: SelectStrengthExercisesInput): StrengthSelectorResult {
  const snapshot = loadTrainingCatalogSnapshot();
  const activeCatalogIds = new Set(snapshot.exercises.filter((entry) => entry.active).map((entry) => entry.id));
  const painAreas = (input.athlete.readiness?.painFlags ?? [])
    .map((flag) => flag.area ?? '')
    .filter(Boolean);
  const patternOrder = patternOrderFor(input);
  const usedIds = new Set<string>();
  const selected: Exercise[] = [];
  const selectedScores: Array<{ exerciseId: string; score: number }> = [];
  const rejectedCandidateReasons: Array<{ exerciseId: string; reason: string }> = [];
  const candidateIds = new Set<string>();

  for (const pattern of patternOrder) {
    if (selected.length >= input.targetCount) break;
    const scored = input.library
      .map((exercise) => {
        const hardFilter = hardFilterExercise({
          exercise,
          input,
          activeCatalogIds,
          painAreas,
          usedIds,
          pattern,
        });
        candidateIds.add(exercise.id);
        if (hardFilter) {
          rejectedCandidateReasons.push({ exerciseId: exercise.id, reason: hardFilter });
          return null;
        }
        return {
          exercise,
          score: scoreExercise({ exercise, input, pattern }),
        };
      })
      .filter((entry): entry is { exercise: Exercise; score: number } => entry !== null)
      .sort((left, right) => right.score - left.score || left.exercise.id.localeCompare(right.exercise.id));

    const winnerEntry = scored[0];
    const winner = winnerEntry?.exercise;
    if (!winner || !winnerEntry) continue;
    usedIds.add(winner.id);
    selected.push(winner);
    selectedScores.push({ exerciseId: winner.id, score: winnerEntry.score });
  }

  if (selected.length < input.targetCount) {
    incrementTrainingGenerationCounter('selector_no_candidate_total', input.targetCount - selected.length);
  }

  const reasons = new Map<string, ExerciseSelectionReason>();
  for (const exercise of selected) {
    reasons.set(exercise.id, {
      pattern: exercise.movementPattern,
      pickedBecause: pickedBecause({ exercise, input }),
      alternativesConsidered: Math.max(1, candidateIds.size),
      alternativesRejectedBecause: rejectedCandidateReasons
        .filter((entry) => entry.exerciseId !== exercise.id)
        .slice(0, 3),
    });
  }

  return {
    variant: {
      title: titleFor(input.profile, input.sessionIndex),
      exerciseIds: selected.map((exercise) => exercise.id),
      tags: [
        'catalog_selector',
        input.profile,
        ...selected.map((exercise) => exercise.movementPattern),
      ],
    },
    selectionReasons: reasons,
    trace: {
      selectorPolicyVersion: STRENGTH_SELECTOR_POLICY_VERSION,
      catalogVersion: snapshot.catalogVersion,
      candidateIds: Array.from(candidateIds).sort(),
      selectedIds: selected.map((exercise) => exercise.id),
      selectedScores,
      rejectedCandidateReasons: rejectedCandidateReasons
        .sort((left, right) => left.exerciseId.localeCompare(right.exerciseId))
        .slice(0, 25),
    },
  };
}

function patternOrderFor(input: SelectStrengthExercisesInput): StrengthPattern[] {
  const base: StrengthPattern[] = input.profile === 'hybrid'
    ? ['hinge', 'single_leg', 'pull', 'push', 'carry', 'core']
    : input.profile === 'maintenance'
      ? ['squat', 'push', 'pull', 'hinge', 'core', 'carry']
      : input.profile === 'hypertrophy'
        ? ['squat', 'push', 'hinge', 'pull', 'single_leg', 'core']
        : ['squat', 'hinge', 'push', 'pull', 'single_leg', 'core'];
  const rotation = (Math.max(0, input.sessionIndex) + Math.max(0, input.weekIndex)) % Math.max(1, Math.min(input.targetSessions, base.length));
  return [
    ...base.slice(rotation),
    ...base.slice(0, rotation),
  ];
}

function hardFilterExercise(args: {
  exercise: Exercise;
  input: SelectStrengthExercisesInput;
  activeCatalogIds: Set<string>;
  painAreas: string[];
  usedIds: Set<string>;
  pattern: StrengthPattern;
}): string | null {
  const { exercise, input } = args;
  if (!args.activeCatalogIds.has(exercise.id)) return 'inactive_catalog_row';
  if (args.usedIds.has(exercise.id)) return 'duplicate_in_session';
  if (exercise.movementPattern !== args.pattern) return 'movement_pattern_mismatch';
  if (!exercise.equipment.every((equipmentId) => input.availableEquipment.has(equipmentId))) {
    incrementTrainingGenerationCounter('unavailable_equipment_blocked_total');
    return 'equipment_unavailable';
  }
  if (exerciseConflictsWithUserPain(exercise, args.painAreas)) return 'pain_contraindication';

  const complexity = getExerciseComplexity(exercise);
  if (input.athlete.profile.experienceLevel === 'novice' && (complexity === 'advanced' || complexity === 'expert')) {
    return 'complexity_too_high';
  }
  if (input.durationMinutes < 25 && (exercise.fatigueCost === 'very_high' || complexity === 'expert')) {
    return 'short_session_fatigue_cost';
  }
  if (input.profile === 'hybrid' && getExerciseSpinalLoading(exercise) === 'high' && exercise.fatigueCost === 'very_high') {
    return 'endurance_interference_risk';
  }
  return null;
}

function scoreExercise(args: {
  exercise: Exercise;
  input: SelectStrengthExercisesInput;
  pattern: StrengthPattern;
}): number {
  const { exercise, input, pattern } = args;
  let score = 100;
  if (exercise.movementPattern === pattern) score += 30;
  const purpose = getExercisePrimaryPurpose(exercise);
  if (input.profile === 'hypertrophy' && purpose === 'hypertrophy') score += 20;
  if (input.profile === 'max_strength' && purpose === 'strength') score += 20;
  if (input.profile === 'maintenance' && (purpose === 'stability' || purpose === 'mobility')) score += 10;
  if (input.profile === 'hybrid' && (purpose === 'stability' || purpose === 'conditioning')) score += 16;
  if (input.profile === 'hybrid' && getExerciseSpinalLoading(exercise) === 'high') score -= 12;
  if (input.profile !== 'max_strength' && exercise.fatigueCost === 'very_high') score -= 18;
  if (input.athlete.profile.experienceLevel === 'advanced' && getExerciseComplexity(exercise) === 'advanced') score += 6;
  if (input.athlete.profile.experienceLevel === 'novice' && getExerciseComplexity(exercise) === 'beginner') score += 14;
  if (exercise.unilateral) score += pattern === 'single_leg' || input.profile === 'hybrid' ? 8 : 0;
  if (input.durationMinutes < 30 && exercise.fatigueCost === 'low') score += 8;
  return score;
}

function pickedBecause(args: {
  exercise: Exercise;
  input: SelectStrengthExercisesInput;
}): string[] {
  const reasons = [
    `fills the ${args.exercise.movementPattern} slot`,
    'fits your available equipment',
  ];
  if (args.input.athlete.profile.experienceLevel === 'novice') {
    reasons.push('matches your current training experience');
  }
  if (args.input.profile === 'hybrid') {
    reasons.push('keeps strength compatible with endurance work');
  }
  if (args.exercise.progressionFamily) {
    reasons.push(`keeps continuity in the ${args.exercise.progressionFamily} progression`);
  }
  return reasons;
}

function titleFor(profile: StrengthSelectorProfile, sessionIndex: number): string {
  const label = profile === 'hypertrophy'
    ? 'Hypertrophy'
    : profile === 'max_strength'
      ? 'Strength'
      : profile === 'maintenance'
        ? 'Maintenance'
        : profile === 'hybrid'
          ? 'Hybrid'
          : 'Athletic';
  return `Catalog ${label} Strength ${sessionIndex + 1}`;
}
