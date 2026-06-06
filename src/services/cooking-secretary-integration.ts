// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  previewSecretarySchedulingIntent,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingDecision,
  type SecretarySchedulingIntent,
  type SecretarySchedulingPreview,
} from './secretary-scheduling-arbitrator';

export interface CookingMealPrepSecretaryInput {
  userId: number;
  tenantId?: number;
  week: string;
  title: string;
  startIso: string;
  endIso: string;
  durationMinutes: number;
  mealCount: number;
}

export function submitCookingMealPrepSchedulingIntent(
  input: CookingMealPrepSecretaryInput,
): SecretarySchedulingDecision {
  return submitSecretarySchedulingIntent(buildCookingMealPrepSchedulingIntent(input));
}

export function previewCookingMealPrepSchedulingIntent(
  input: CookingMealPrepSecretaryInput,
): SecretarySchedulingPreview {
  return previewSecretarySchedulingIntent(buildCookingMealPrepSchedulingIntent(input));
}

export function buildCookingMealPrepSchedulingIntent(
  input: CookingMealPrepSecretaryInput,
): SecretarySchedulingIntent {
  const tenantId = input.tenantId ?? input.userId;
  return {
    intentId: `cooking:meal-prep:${tenantId}:${input.userId}:${input.week}:${input.startIso}:${input.durationMinutes}`,
    sourceSkill: 'cooking',
    sourceAction: 'schedule_meal_prep',
    sourceEntityId: input.week,
    sourceEntityType: 'meal_prep_block',
    ownerUserId: input.userId,
    tenantId,
    title: input.title,
    requestedDurationMinutes: input.durationMinutes,
    minimumDurationMinutes: Math.min(input.durationMinutes, Math.max(30, Math.round(input.durationMinutes * 0.75))),
    preferredWindows: [{
      start: input.startIso,
      end: input.endIso,
      label: 'meal prep window',
      hard: true,
    }],
    priority: 'normal',
    flexibility: 'fixed',
    reason: 'Cooking requested a meal-prep calendar block after user confirmation.',
    context: `week=${input.week}; meal_count=${input.mealCount}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
