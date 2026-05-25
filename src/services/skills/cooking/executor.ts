// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { claimChatActionRunForExecution, updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import {
  applyMealPlanSubstitution,
  generateShoppingList,
  getMealPlan,
  getRecipeById,
  getShoppingList,
  setMealPlan,
  suggestMealPlanSubstitutions,
} from '../../cooking-chef';
import { claimActionRunForStepExecution, reconciliationPendingResult, replayDuplicateClaimedActionRun, updateClaimedActionRun } from '../../chat/executor/helpers';

export function executeCookingGroceryListStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const weekStart = String(args.weekStart || '');
  const claim = persistRuns ? claimChatActionRunForExecution({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    normalizedActionHash: step.idempotencyKey,
    provider: 'nexus',
    actionType: step.action,
    risk: step.risk,
    request: step.args,
    nowIso: plan.createdAt,
  }) : null;
  if (claim && !claim.acquired && claim.row.status === 'verified_success') {
    return { step, status: 'verified_success', result: claim.row.result_json ? JSON.parse(claim.row.result_json) : { replayed: true } };
  }
  try {
    const list = generateShoppingList(input.userId, weekStart, input.tenantId);
    const readBack = getShoppingList(input.userId, weekStart, input.tenantId);
    const verified = readBack?.week_start === list.week_start;
    const result = { weekStart, itemCount: list.items.length, items: list.items.slice(0, 12), verified: Boolean(verified) };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: `shopping-list:${weekStart}`,
      verification: { verified, expected: { weekStart } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'cooking_grocery_list_failed' };
  }
}

export function executeCookingMealPlanStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const date = typeof args.date === 'string' ? args.date.trim() : '';
  const mealType = typeof args.mealType === 'string' ? args.mealType.trim().toLowerCase() : '';
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !mealType || !title) {
    return { step, status: 'blocked', error: 'cooking_meal_plan_requires_date_meal_type_and_title' };
  }
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const meal = setMealPlan(input.userId, date, mealType, title, {
      notes: typeof args.notes === 'string' ? args.notes : 'Created from Chat action.',
      tenantId: input.tenantId,
    });
    const readBack = getMealPlan(input.userId, date, date, input.tenantId)
      .find((candidate) => candidate.id === meal.id || (candidate.meal_type === mealType && candidate.title === title));
    const verified = Boolean(readBack && readBack.title === title && readBack.meal_type === mealType);
    const result = { meal: readBack ?? meal, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(meal.id),
      verification: { verified, expected: { date, mealType, title } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'cooking_meal_plan_failed' };
  }
}

export function executeCookingSubstituteIngredientStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const date = typeof args.date === 'string' ? args.date.trim() : '';
  const mealType = typeof args.mealType === 'string' ? args.mealType.trim().toLowerCase() : '';
  const originalIngredient = typeof args.originalIngredient === 'string' ? args.originalIngredient.trim() : '';
  const suggestedIngredient = typeof args.suggestedIngredient === 'string' ? args.suggestedIngredient.trim() : '';
  const reason = normalizeSubstitutionReason(args.reason);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !mealType || !originalIngredient) {
    return { step, status: 'blocked', error: 'cooking_substitution_requires_date_meal_and_ingredient' };
  }
  if (!suggestedIngredient) {
    const suggestions = suggestMealPlanSubstitutions(input.userId, {
      date,
      mealType,
      originalIngredient,
      reason,
    }, input.tenantId);
    return {
      step,
      status: 'blocked',
      result: {
        suggestions: suggestions.suggestions,
        originalIngredient: suggestions.originalIngredient,
        reason: suggestions.reason,
      },
      error: 'cooking_substitution_requires_suggested_ingredient',
    };
  }
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const result = applyMealPlanSubstitution(input.userId, {
      date,
      mealType,
      originalIngredient,
      suggestedIngredient,
      reason,
      updateShoppingList: args.updateShoppingList !== false,
    }, input.tenantId);
    if (!result.applied) {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { message: result.reason ?? 'substitution_not_applied' } });
      return { step, status: 'blocked', result, error: result.reason ?? 'substitution_not_applied' };
    }
    const readBackRecipe = result.substitution.affectedRecipeId
      ? getRecipeById(input.userId, result.substitution.affectedRecipeId, input.tenantId)
      : null;
    const verified = Boolean(readBackRecipe?.ingredients.some((ingredient) => ingredient.name === suggestedIngredient))
      && !Boolean(readBackRecipe?.ingredients.some((ingredient) => ingredientNameMatches(ingredient.name, originalIngredient)));
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    const payload = {
      ...result,
      verified,
    };
    if (!updateClaimedActionRun(claim, status, {
      result: payload,
      providerObjectId: result.substitution.affectedMealId ? String(result.substitution.affectedMealId) : `${date}:${mealType}`,
      verification: { verified, expected: { date, mealType, originalIngredient, suggestedIngredient } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result: payload, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'cooking_substitution_failed' };
  }
}

export function executeCookingSupportStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const now = DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);
  const start = now.startOf('week').toISODate() || now.toISODate();
  const end = now.endOf('week').toISODate() || now.toISODate();
  if (!start || !end) return { step, status: 'blocked', error: 'cooking_date_range_required' };
  try {
    const meals = getMealPlan(input.userId, start, end, input.tenantId);
    const shopping = getShoppingList(input.userId, start, input.tenantId);
    return {
      step,
      status: 'verified_success',
      result: {
        dateRange: { start, end },
        plannedMeals: meals.length,
        shoppingItemCount: shopping?.items.length ?? 0,
        guidance: step.action === 'cooking_fueling_support'
          ? 'Use planned meals and shopping coverage to protect pre/post-training fueling.'
          : 'Use current meal-plan and shopping-list truth before changing meals.',
      },
    };
  } catch {
    return { step, status: 'failed', error: 'cooking_support_failed' };
  }
}

function normalizeSubstitutionReason(value: unknown): 'allergy' | 'dietary_restriction' | 'disliked_ingredient' | 'expired_pantry' {
  if (value === 'allergy' || value === 'dietary_restriction' || value === 'disliked_ingredient' || value === 'expired_pantry') return value;
  return 'disliked_ingredient';
}

function ingredientNameMatches(candidate: string, originalIngredient: string): boolean {
  const candidateName = candidate.trim().toLowerCase().replace(/\s+/g, ' ');
  const originalName = originalIngredient.trim().toLowerCase().replace(/\s+/g, ' ');
  return candidateName === originalName || candidateName.includes(originalName);
}
