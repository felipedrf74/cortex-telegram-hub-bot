// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { invalidateExecutiveBriefCaches } from './coordination-cache-invalidator';
import { invalidateCookingDerivedCaches } from './cooking-cache-invalidator';
import { invalidateTrainingDerivedCaches } from './training-cache-invalidator';

const TRAINING_PROFILE_TYPES = new Set([
  'fitness',
  'triathlon-gym',
  'triathlon-running',
  'triathlon-cycling',
  'triathlon-swim',
]);

/**
 * Onboarding answers shape downstream Home, plan, shared-context, and skill
 * read models. Keep that ownership here so routes/tools do not guess which
 * cache prefixes matter for each questionnaire family.
 */
export function invalidateOnboardingDerivedCaches(
  userId: number,
  questionnaireId: string,
): void {
  if (!Number.isFinite(userId)) return;

  if (TRAINING_PROFILE_TYPES.has(questionnaireId)) {
    invalidateTrainingDerivedCaches(userId);
    return;
  }

  if (questionnaireId === 'diet') {
    invalidateCookingDerivedCaches(userId);
    return;
  }

  invalidateExecutiveBriefCaches(userId);
}
