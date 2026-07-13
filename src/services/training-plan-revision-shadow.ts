// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { incrementTrainingGenerationCounter } from './training-generation-observability';
import type { TrainingPlanCandidateRequest } from './training-plan-revision-candidate-builder';
import { computeTrainingPlanRevisionShadow } from './training-plan-revisions';
import { getTrainingPlanRevisionV1Mode, type RuntimeFlagScope } from './runtime-flags';

export type TrainingRevisionShadowOutcome =
  | { computed: true; contentHash: string }
  | { computed: false; reason: 'mode' | 'scope' | 'unsupported_or_missing_inputs' | 'invalid' };

export function runTrainingPlanRevisionShadowForLegacyRequest(input: {
  scope: RuntimeFlagScope;
  body: unknown;
  env?: NodeJS.ProcessEnv;
}): TrainingRevisionShadowOutcome {
  const env = input.env ?? process.env;
  if (getTrainingPlanRevisionV1Mode(env, input.scope) !== 'shadow') {
    return { computed: false, reason: 'mode' };
  }
  if (input.scope.userId !== input.scope.tenantId) {
    incrementTrainingGenerationCounter('revision_shadow_candidate_skipped_total');
    return { computed: false, reason: 'scope' };
  }
  const request = mapExplicitLegacyShadowInputs(input.body);
  if (!request) {
    incrementTrainingGenerationCounter('revision_shadow_candidate_skipped_total');
    return { computed: false, reason: 'unsupported_or_missing_inputs' };
  }
  try {
    const built = computeTrainingPlanRevisionShadow(request);
    incrementTrainingGenerationCounter('revision_shadow_candidate_succeeded_total');
    return { computed: true, contentHash: built.contentHash };
  } catch {
    incrementTrainingGenerationCounter('revision_shadow_candidate_skipped_total');
    return { computed: false, reason: 'invalid' };
  }
}

function mapExplicitLegacyShadowInputs(value: unknown): TrainingPlanCandidateRequest | null {
  if (!isRecord(value)) return null;
  if (value.goalMode !== 'general_fitness' || value.planMode !== 'continuous') return null;
  if (value.discipline !== 'strength') return null;
  if (value.experienceLevel !== 'novice'
      && value.experienceLevel !== 'intermediate'
      && value.experienceLevel !== 'advanced') return null;
  if (!Number.isInteger(value.sessionsPerWeek)
      || !Number.isInteger(value.sessionDurationMinutes)
      || !Array.isArray(value.availableDays)
      || !Array.isArray(value.equipmentIds)
      || (value.location !== 'home' && value.location !== 'gym')) return null;
  return {
    planMode: 'continuous',
    goal: 'general_fitness',
    discipline: 'strength',
    ...(Number.isInteger(value.durationWeeks) ? { horizonWeeks: Number(value.durationWeeks) } : {}),
    profile: {
      experienceLevel: value.experienceLevel,
      sessionsPerWeek: Number(value.sessionsPerWeek),
      sessionDurationMinutes: Number(value.sessionDurationMinutes),
      availableDays: value.availableDays.filter((entry): entry is any => typeof entry === 'string'),
      equipmentIds: value.equipmentIds.filter((entry): entry is string => typeof entry === 'string'),
      location: value.location,
      preferences: Array.isArray(value.preferences)
        ? value.preferences.filter((entry): entry is string => typeof entry === 'string')
        : [],
      exclusions: Array.isArray(value.exclusions)
        ? value.exclusions.filter((entry): entry is string => typeof entry === 'string')
        : [],
    },
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
