// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import { completePendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import {
  applyMealPlanSubstitution,
  deleteMealPlan,
  deletePantryItem,
  deleteRecipe,
  generateShoppingList,
  getMealPlan,
  getPantryItemById,
  getPantryItems,
  getRecipeById,
  getRecipes,
  getShoppingList,
  setMealPlan,
  suggestMealPlanSubstitutions,
} from '../../cooking-chef';
import { buildCookingPreferenceReadModel } from '../../cooking-preferences';
import { readTrainingContextAll } from '../../training-signals';
import { getActivePlans, getCurrentWeek, getSessionsForWeek, type TrainingSession } from '../../training-plans';
import { claimActionRunForStepExecution, reconciliationPendingResult, replayDuplicateClaimedActionRun, updateClaimedActionRun } from '../../chat/executor/helpers';
import { invalidateCookingDerivedCaches } from '../../cache-coherence-registry';
import { evaluateCookingSafetyTextForProfile } from '../../cooking-safety-policy';

export function executeCookingDeleteStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const recipeId = step.action === 'cooking_delete_recipe' ? Number(step.args.recipeId) : undefined;
  const mealDate = step.action === 'cooking_delete_meal' && typeof step.args.date === 'string'
    ? step.args.date.trim()
    : undefined;
  const mealType = step.action === 'cooking_delete_meal' && typeof step.args.mealType === 'string'
    ? step.args.mealType.trim().toLowerCase()
    : undefined;
  const pantryItemId = step.action === 'cooking_delete_pantry_item' ? Number(step.args.itemId) : undefined;
  let validationError: string | null = null;
  if (step.action === 'cooking_delete_recipe' && (!Number.isSafeInteger(recipeId) || Number(recipeId) <= 0)) {
    validationError = 'cooking_delete_recipe_requires_recipe_id';
  }
  if (step.action === 'cooking_delete_meal') {
    const parsedDate = DateTime.fromISO(mealDate ?? '', { zone: input.timezone });
    if (!parsedDate.isValid
      || parsedDate.toISODate() !== mealDate
      || !['breakfast', 'lunch', 'dinner', 'snack'].includes(mealType ?? '')) {
      validationError = 'cooking_delete_meal_requires_date_and_meal_type';
    }
  }
  if (step.action === 'cooking_delete_pantry_item' && (!Number.isSafeInteger(pantryItemId) || Number(pantryItemId) <= 0)) {
    validationError = 'cooking_delete_pantry_item_requires_item_id';
  }
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  if (validationError) {
    if (!updateClaimedActionRun(claim, 'blocked', { error: { message: validationError } })) {
      return reconciliationPendingResult(step, 'blocked');
    }
    return { step, status: 'blocked', error: validationError };
  }
  try {
    let deleted = false;
    let verified = false;
    let providerObjectId = '';
    let result: Record<string, unknown>;
    if (step.action === 'cooking_delete_recipe') {
      deleted = deleteRecipe(input.userId, recipeId!, input.tenantId);
      verified = deleted && getRecipeById(input.userId, recipeId!, input.tenantId) == null;
      providerObjectId = `recipe:${recipeId}`;
      result = { recipeId, deleted, verified };
    } else if (step.action === 'cooking_delete_meal') {
      deleted = deleteMealPlan(input.userId, mealDate!, mealType!, input.tenantId);
      verified = deleted && !getMealPlan(input.userId, mealDate!, mealDate!, input.tenantId)
        .some((meal) => meal.meal_type === mealType);
      providerObjectId = `meal:${mealDate}:${mealType}`;
      result = { date: mealDate, mealType, deleted, verified };
    } else {
      deleted = deletePantryItem(input.userId, pantryItemId!, input.tenantId);
      verified = deleted && getPantryItemById(input.userId, pantryItemId!, input.tenantId) == null;
      providerObjectId = `pantry:${pantryItemId}`;
      result = { itemId: pantryItemId, deleted, verified };
    }
    if (!deleted) {
      if (!updateClaimedActionRun(claim, 'blocked', { result, error: { message: 'cooking_item_not_found' } })) {
        return reconciliationPendingResult(step, 'blocked');
      }
      return { step, status: 'blocked', result, error: 'cooking_item_not_found' };
    }
    invalidateCookingDerivedCaches(input.userId);
    let pendingCompleted = true;
    if (verified && persistRuns && typeof step.args.pendingActionId === 'string') {
      try {
        completePendingCookingDelete(input, step, plan.createdAt);
      } catch {
        pendingCompleted = false;
      }
    }
    result = { ...result, pendingCompleted };
    const status: ChatActionRunStatus = verified && pendingCompleted ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId,
      verification: { verified, expected: { ...step.args } },
    })) return reconciliationPendingResult(step, status);
    return {
      step,
      status,
      result,
      error: !verified ? 'local_read_back_mismatch' : pendingCompleted ? undefined : 'cooking_pending_completion_failed',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const conflict = message.startsWith('COOKING_RECIPE_IN_USE');
    const status: ChatActionRunStatus = conflict ? 'blocked' : 'failed';
    if (claim) updateChatActionRun(claim.row.id, status, { error: { message } });
    return { step, status, error: conflict ? 'cooking_recipe_in_use' : 'cooking_delete_failed' };
  }
}

function completePendingCookingDelete(input: ChatPlannerInput, step: ChatPlanStep, nowIso: string): void {
  const pendingActionId = typeof step.args.pendingActionId === 'string'
    ? step.args.pendingActionId
    : undefined;
  if (!pendingActionId) return;
  const collectedSlots = { ...step.args };
  delete collectedSlots.pendingActionId;
  const completed = completePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'cooking',
    action: step.action,
    pendingActionId,
    collectedSlots,
    nowIso,
  });
  if (completed !== 1) throw new Error('cooking_pending_action_completion_mismatch');
}

export function executeCookingGroceryListStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const weekStart = String(args.weekStart || '');
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const list = generateShoppingList(input.userId, weekStart, input.tenantId);
    invalidateCookingDerivedCaches(input.userId);
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
  const hasRecipeId = args.recipeId !== undefined && args.recipeId !== null;
  const recipeId = hasRecipeId ? Number(args.recipeId) : undefined;
  const parsedDate = DateTime.fromISO(date, { zone: input.timezone });
  if (!parsedDate.isValid
      || parsedDate.toISODate() !== date
      || !['breakfast', 'lunch', 'dinner', 'snack'].includes(mealType)
      || !title) {
    return { step, status: 'blocked', error: 'cooking_meal_plan_requires_date_meal_type_and_title' };
  }
  if (hasRecipeId && (!Number.isSafeInteger(recipeId) || recipeId! <= 0)) {
    return { step, status: 'blocked', error: 'cooking_meal_plan_requires_positive_recipe_id' };
  }
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const meal = setMealPlan(input.userId, date, mealType, title, {
      recipeId,
      notes: typeof args.notes === 'string' ? args.notes : 'Created from Chat action.',
      tenantId: input.tenantId,
    });
    invalidateCookingDerivedCaches(input.userId);
    const readBack = getMealPlan(input.userId, date, date, input.tenantId)
      .find((candidate) => candidate.id === meal.id || (candidate.meal_type === mealType && candidate.title === title));
    const verified = Boolean(readBack && readBack.title === title && readBack.meal_type === mealType);
    let pendingCompleted = true;
    if (verified && persistRuns && typeof step.args.pendingActionId === 'string') {
      try {
        completePendingCookingMealPlan(input, plan.createdAt, step.args);
      } catch {
        pendingCompleted = false;
      }
    }
    const verifiedMeal = readBack
      ? { ...readBack, ...(meal.issues?.length ? { issues: meal.issues } : {}) }
      : meal;
    const result = { meal: verifiedMeal, verified, pendingCompleted };
    const status: ChatActionRunStatus = verified && pendingCompleted ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(meal.id),
      verification: { verified, expected: { date, mealType, title } },
    })) return reconciliationPendingResult(step, status);
    return {
      step,
      status,
      result,
      error: !verified ? 'local_read_back_mismatch' : pendingCompleted ? undefined : 'cooking_pending_completion_failed',
    };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'cooking_meal_plan_failed' };
  }
}

function completePendingCookingMealPlan(input: ChatPlannerInput, nowIso: string, collectedSlots: Record<string, unknown>): void {
  const pendingActionId = typeof collectedSlots.pendingActionId === 'string'
    ? collectedSlots.pendingActionId
    : undefined;
  if (!pendingActionId) return;
  const durableSlots = { ...collectedSlots };
  delete durableSlots.pendingActionId;
  const completed = completePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'cooking',
    action: 'cooking_meal_plan',
    pendingActionId,
    collectedSlots: durableSlots,
    nowIso,
  });
  if (pendingActionId && completed !== 1) throw new Error('cooking_pending_action_completion_mismatch');
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
    try {
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
    } catch {
      return { step, status: 'failed', error: 'cooking_substitution_failed' };
    }
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
    invalidateCookingDerivedCaches(input.userId);
    const readBackRecipe = result.substitution.affectedRecipeId
      ? getRecipeById(input.userId, result.substitution.affectedRecipeId, input.tenantId)
      : null;
    const verified = Boolean(readBackRecipe?.ingredients.some((ingredient) => ingredientNameMatches(ingredient.name, suggestedIngredient)))
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
  const parsedNow = DateTime.fromISO(input.nowIso ?? new Date().toISOString(), { setZone: true });
  const now = (parsedNow.isValid ? parsedNow : DateTime.utc()).setZone(input.timezone);
  const mealContext = typeof step.args.mealContext === 'string' ? step.args.mealContext : '';
  const requestedDate = cookingSupportDate(mealContext, now);
  if (!requestedDate) return { step, status: 'blocked', error: 'cooking_date_range_required' };
  const weekStart = DateTime.fromISO(requestedDate, { zone: input.timezone }).startOf('week').toISODate();
  if (!weekStart) return { step, status: 'blocked', error: 'cooking_date_range_required' };
  const foldedContext = foldCookingSupportText(mealContext);
  const namedWeekday = cookingSupportNamedWeekday(foldedContext);
  const timing = cookingFuelingTiming(mealContext);
  const weekScoped = step.args.supportMode === 'shopping_list_read'
    || (namedWeekday == null && /\b(?:week|semana)\b/.test(foldedContext));
  const mealRangeStart = weekScoped ? weekStart : requestedDate;
  const mealRangeEnd = weekScoped
    ? DateTime.fromISO(weekStart, { zone: input.timezone }).plus({ days: 6 }).toISODate()!
    : requestedDate;

  const warningCodes: string[] = [];
  const sourceHealth: Record<string, 'ok' | 'empty' | 'unavailable'> = {};
  let meals: ReturnType<typeof getMealPlan> = [];
  let shopping: ReturnType<typeof getShoppingList> = null;
  let pantry: ReturnType<typeof getPantryItems> = [];
  let preferences: ReturnType<typeof buildCookingPreferenceReadModel> | null = null;
  let recipes: ReturnType<typeof getRecipes> = [];
  let trainingContext: ReturnType<typeof readTrainingContextAll> | null = null;
  let trainingSession: TrainingSession | null = null;

  try {
    meals = getMealPlan(input.userId, mealRangeStart, mealRangeEnd, input.tenantId);
    sourceHealth.mealPlan = meals.length > 0 ? 'ok' : 'empty';
  } catch {
    sourceHealth.mealPlan = 'unavailable';
    warningCodes.push('COOKING_MEAL_PLAN_SOURCE_UNAVAILABLE');
  }
  try {
    shopping = getShoppingList(input.userId, weekStart, input.tenantId);
    sourceHealth.shoppingList = shopping ? 'ok' : 'empty';
  } catch {
    sourceHealth.shoppingList = 'unavailable';
    warningCodes.push('COOKING_SHOPPING_SOURCE_UNAVAILABLE');
  }
  try {
    pantry = getPantryItems(input.userId, { tenantId: input.tenantId, includeExpired: true, limit: 250 });
    sourceHealth.pantry = pantry.length > 0 ? 'ok' : 'empty';
  } catch {
    sourceHealth.pantry = 'unavailable';
    warningCodes.push('COOKING_PANTRY_SOURCE_UNAVAILABLE');
  }
  try {
    preferences = buildCookingPreferenceReadModel(input.userId, input.tenantId);
    sourceHealth.preferences = preferences.memories.length > 0 ? 'ok' : 'empty';
  } catch {
    sourceHealth.preferences = 'unavailable';
    warningCodes.push('COOKING_PREFERENCES_SOURCE_UNAVAILABLE');
  }
  try {
    recipes = getRecipes(input.userId, { tenantId: input.tenantId, limit: 12 });
    sourceHealth.recipeLibrary = recipes.length > 0 ? 'ok' : 'empty';
  } catch {
    sourceHealth.recipeLibrary = 'unavailable';
    warningCodes.push('COOKING_RECIPE_LIBRARY_UNAVAILABLE');
  }
  try {
    trainingContext = readTrainingContextAll({ userId: input.userId, tenantId: input.tenantId });
    sourceHealth.trainingSignals = trainingContext.signals.length > 0 ? 'ok' : 'empty';
    if (trainingContext.signals.length === 0) warningCodes.push('COOKING_NO_ACTIVE_TRAINING_SIGNALS');
  } catch {
    sourceHealth.trainingSignals = 'unavailable';
    warningCodes.push('COOKING_TRAINING_SIGNALS_UNAVAILABLE');
  }
  try {
    const plans = getActivePlans(input.userId, input.tenantId);
    if (plans.length === 0) {
      sourceHealth.trainingPlan = 'empty';
      warningCodes.push('COOKING_NO_ACTIVE_TRAINING_PLAN');
    } else {
      const targetDate = DateTime.fromISO(requestedDate, { zone: input.timezone }).startOf('day');
      const inactiveStatuses = new Set(['rest', 'skipped', 'unscheduled', 'deferred', 'dropped', 'cancelled', 'superseded']);
      let targetInsidePlan = false;
      const matchingSessions: TrainingSession[] = [];
      for (const plan of plans) {
        if (requestedDate < plan.start_date || requestedDate > plan.end_date) continue;
        targetInsidePlan = true;
        const week = getCurrentWeek(plan.id, { now: targetDate.toJSDate(), timezone: input.timezone });
        if (!week) continue;
        const sessions = getSessionsForWeek(week.id)
          .filter((session) => !inactiveStatuses.has(String(session.status ?? '').toLowerCase()));
        matchingSessions.push(...sessions.filter(
          (session) => cookingTrainingSessionDate(session, weekStart, input.timezone) === requestedDate,
        ));
      }
      trainingSession = [...matchingSessions].sort((left, right) => {
        const demandDifference = cookingTrainingDemandScore(right) - cookingTrainingDemandScore(left);
        if (demandDifference !== 0) return demandDifference;
        const leftStart = left.scheduled_start_at ?? '';
        const rightStart = right.scheduled_start_at ?? '';
        if (leftStart !== rightStart) return leftStart.localeCompare(rightStart);
        return `${left.title}:${left.id}`.localeCompare(`${right.title}:${right.id}`);
      })[0] ?? null;
      sourceHealth.trainingPlan = trainingSession ? 'ok' : 'empty';
      if (!targetInsidePlan) warningCodes.push('COOKING_TRAINING_PLAN_OUTSIDE_REQUESTED_DATE');
      else if (!trainingSession) warningCodes.push('COOKING_NO_TRAINING_SESSION_FOR_DATE');
    }
  } catch {
    sourceHealth.trainingPlan = 'unavailable';
    warningCodes.push('COOKING_TRAINING_PLAN_SOURCE_UNAVAILABLE');
  }

  const readinessFlags = trainingContext ? {
    lowSleep: trainingContext.flags.lowSleep,
    lowHrv: trainingContext.flags.lowHrv,
    lowReadiness: trainingContext.flags.lowReadiness,
    highLegLoad: trainingContext.flags.highLegLoad,
    highShoulderLoad: trainingContext.flags.highShoulderLoad,
    fuelingGap: trainingContext.flags.fuelingGap,
    otherSportRpeToday: trainingContext.flags.otherSportRpeToday,
  } : null;
  const signalScores = (trainingContext?.signals ?? []).slice(0, 8).map((signal) => ({
    type: signal.signal_type,
    confidence: signal.confidence,
    evidenceCount: signal.evidence_count,
  }));
  const expiredPantryItems = pantry.filter((item) => item.freshness_status === 'expired').length;
  const useSoonPantryItems = pantry.filter((item) => item.freshness_status === 'use_soon').length;
  const availablePantryItems = pantry.filter((item) => item.availability_status === 'available' && item.freshness_status !== 'expired').length;
  const preferenceProfile = preferences?.profile;
  const safeRecipes = preferenceProfile
    ? recipes.filter((recipe) => !evaluateCookingSafetyTextForProfile(
        preferenceProfile,
        'chat_core_v2_cooking',
        [
          recipe.title,
          recipe.instructions,
          recipe.tags,
          recipe.source,
          ...recipe.ingredients.flatMap((ingredient) => [ingredient.name, ingredient.quantity, ingredient.unit]),
        ],
      ).blocked)
    : [];
  const recipeById = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  let mealSafetyConflicts = 0;
  let mealSafetyUnverified = 0;
  const safeMeals = preferenceProfile
    ? meals.filter((meal) => {
        let linkedRecipe = meal.recipe_id ? recipeById.get(meal.recipe_id) ?? null : null;
        if (meal.recipe_id && !linkedRecipe) {
          try {
            linkedRecipe = getRecipeById(input.userId, meal.recipe_id, input.tenantId);
          } catch {
            sourceHealth.recipeLibrary = 'unavailable';
            mealSafetyUnverified += 1;
            warningCodes.push('COOKING_MEAL_SAFETY_UNVERIFIED');
            return false;
          }
        }
        if (meal.recipe_id && !linkedRecipe) {
          mealSafetyUnverified += 1;
          warningCodes.push('COOKING_MEAL_SAFETY_UNVERIFIED');
          return false;
        }
        const evaluation = evaluateCookingSafetyTextForProfile(preferenceProfile, 'chat_core_v2_cooking', [
          meal.title,
          linkedRecipe?.title,
          linkedRecipe?.instructions,
          linkedRecipe?.tags,
          linkedRecipe?.source,
          ...(linkedRecipe?.ingredients.flatMap((ingredient) => [ingredient.name, ingredient.quantity, ingredient.unit]) ?? []),
        ]);
        if (!evaluation.blocked) return true;
        mealSafetyConflicts += 1;
        warningCodes.push('COOKING_MEAL_SAFETY_CONFLICT');
        return false;
      })
    : [];
  if (!preferenceProfile && meals.length > 0) {
    mealSafetyUnverified = meals.length;
    warningCodes.push('COOKING_MEAL_SAFETY_UNVERIFIED');
  }
  if (shopping?.safetyIssues?.length) warningCodes.push('COOKING_SHOPPING_SAFETY_CONFLICT');
  const advisorySuggestions = safeMeals.length > 0
    ? []
    : safeRecipes.slice(0, 3).map((recipe) => ({
        title: recipe.title,
        source: 'saved_recipe' as const,
        recipeId: recipe.id,
        prepMinutes: recipe.prep_time_min,
        cookMinutes: recipe.cook_time_min,
      }));
  const guidance = buildCookingSupportGuidance({
    action: step.action,
    timing,
    capabilityBoundary: step.args.capabilityBoundary,
    trainingSession,
    readinessFlags,
    mealsPlanned: safeMeals.length,
    expiredPantryItems,
    hasSafetyPreferences: Boolean(preferenceProfile?.allergies?.length || preferenceProfile?.dietaryRestrictions?.length),
    hasSavedRecipeSuggestions: advisorySuggestions.length > 0,
    locale: input.locale,
  });
  const isFueling = step.action === 'cooking_fueling_support';
  const criticalSources = step.args.supportMode === 'shopping_list_read'
    ? ['shoppingList']
    : ['mealPlan', 'shoppingList', 'pantry', 'preferences', 'recipeLibrary', ...(isFueling ? ['trainingPlan', 'trainingSignals'] : [])];
  const sourceFailure = criticalSources.some((source) => sourceHealth[source] === 'unavailable');
  return {
    step,
    status: sourceFailure ? 'partial_success' : 'verified_success',
    result: {
      requestedDate,
      requestedRange: { from: mealRangeStart, to: mealRangeEnd, scope: weekScoped ? 'week' : 'date' },
      timezone: input.timezone,
      timing,
      plannedMeals: safeMeals.map((meal) => ({ mealType: meal.meal_type, title: meal.title, recipeId: meal.recipe_id })),
      shoppingItemCount: shopping?.items.length ?? 0,
      shoppingItems: (shopping?.items ?? []).slice(0, 25).map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        checked: item.checked,
      })),
      shoppingSafetyConflicts: shopping?.safetyIssues?.length ?? 0,
      mealSafetyConflicts,
      mealSafetyUnverified,
      suggestions: advisorySuggestions,
      pantry: { availableItems: availablePantryItems, useSoonItems: useSoonPantryItems, expiredItems: expiredPantryItems },
      preferences: {
        allergies: preferenceProfile?.allergies ?? [],
        dietaryRestrictions: preferenceProfile?.dietaryRestrictions ?? [],
        dislikedIngredients: preferenceProfile?.dislikedIngredients ?? [],
        weekdayMaxPrepMinutes: preferenceProfile?.weekdayMaxPrepMinutes ?? null,
      },
      training: {
        session: trainingSession ? {
          title: trainingSession.title,
          sessionType: trainingSession.session_type,
          durationMinutes: trainingSession.duration_minutes,
          intensity: trainingSession.intensity_text,
          scheduledStartAt: trainingSession.scheduled_start_at ?? null,
        } : null,
        readinessFlags,
        signalScores,
      },
      guidance,
      sourceHealth,
      degraded: sourceFailure || (isFueling && (sourceHealth.trainingPlan !== 'ok' || sourceHealth.trainingSignals !== 'ok')),
      warningCodes: [...new Set(warningCodes)],
      providerReadsPerformed: false,
    },
    error: sourceFailure ? 'cooking_support_sources_degraded' : undefined,
  };
}

function cookingSupportDate(context: string, now: DateTime): string | null {
  const explicit = context.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (explicit) {
    const parsed = DateTime.fromISO(explicit, { zone: now.zoneName ?? 'UTC' });
    if (parsed.isValid && parsed.toISODate() === explicit) return explicit;
    return null;
  }
  const folded = foldCookingSupportText(context);
  const weekday = cookingSupportNamedWeekday(folded);
  if (weekday != null) {
    const lastQualified = /\b(?:last|previous|passada|passado|anterior|pasada|pasado)\b/.test(folded);
    const nextQualified = /\b(?:next|proxima|proximo|seguinte)\b/.test(folded);
    const weekQualified = /\b(?:week|semana)\b/.test(folded);
    if (weekQualified) {
      const qualifiedWeekStart = lastQualified
        ? now.minus({ weeks: 1 }).startOf('week')
        : nextQualified
          ? now.plus({ weeks: 1 }).startOf('week')
          : now.startOf('week');
      return qualifiedWeekStart.plus({ days: weekday - 1 }).toISODate();
    }
    if (lastQualified) {
      let daysBack = (now.weekday - weekday + 7) % 7;
      if (daysBack === 0) daysBack = 7;
      return now.minus({ days: daysBack }).toISODate();
    }
    let daysAhead = (weekday - now.weekday + 7) % 7;
    if (daysAhead === 0 && nextQualified) daysAhead = 7;
    return now.plus({ days: daysAhead }).toISODate();
  }
  if (/\b(?:last week|semana passada|semana anterior|la semana pasada)\b/.test(folded)) {
    return now.minus({ weeks: 1 }).startOf('week').toISODate();
  }
  if (/\b(?:next week|proxima semana|semana que vem|la proxima semana)\b/.test(folded)) {
    return now.plus({ weeks: 1 }).startOf('week').toISODate()!;
  }
  if (/\b(?:this week|esta semana)\b/.test(folded)) return now.startOf('week').toISODate();
  if (/\b(?:day after tomorrow|depois de amanha|pasado manana)\b/.test(folded)) return now.plus({ days: 2 }).toISODate()!;
  if (/\b(?:tomorrow|amanha|manana)\b/.test(folded)) return now.plus({ days: 1 }).toISODate()!;
  if (/\b(?:today|tonight|hoje|esta noite|hoy|esta noche)\b/.test(folded)) return now.toISODate();
  if (/\b(?:yesterday|ontem|ayer|last month|next month|mes passado|proximo mes|mes que vem|mes pasado)\b/.test(folded)) return null;
  return now.toISODate()!;
}

function cookingSupportNamedWeekday(foldedText: string): number | null {
  const patterns: Array<[number, RegExp]> = [
    [1, /\b(?:monday|segunda(?:-feira)?|lunes)\b/],
    [2, /\b(?:tuesday|terca(?:-feira)?|martes)\b/],
    [3, /\b(?:wednesday|quarta(?:-feira)?|miercoles)\b/],
    [4, /\b(?:thursday|quinta(?:-feira)?|jueves)\b/],
    [5, /\b(?:friday|sexta(?:-feira)?|viernes)\b/],
    [6, /\b(?:saturday|sabado)\b/],
    [7, /\b(?:sunday|domingo)\b/],
  ];
  return patterns.find(([, pattern]) => pattern.test(foldedText))?.[0] ?? null;
}

function cookingFuelingTiming(context: string): 'pre_workout' | 'post_workout' | 'general' {
  const folded = foldCookingSupportText(context);
  if (/\b(?:post[\s-]?workout|post[\s-]?treino|after\s+(?:the\s+)?(?:workout|training|run|ride)|depois\s+d[oa]\s+treino|despues\s+del?\s+entrenamiento)\b/.test(folded)) return 'post_workout';
  if (/\b(?:pre[\s-]?workout|pre[\s-]?treino|before\s+(?:the\s+)?(?:workout|training|run|ride)|antes\s+d[oa]\s+treino|antes\s+del?\s+entrenamiento|fuel(?:ing)?(?:\s+support)?\s+for)\b/.test(folded)) return 'pre_workout';
  return 'general';
}

function cookingTrainingSessionDate(session: TrainingSession, weekStart: string, timezone: string): string | null {
  if (session.scheduled_start_at) {
    const scheduled = DateTime.fromISO(session.scheduled_start_at, { setZone: true }).setZone(timezone);
    if (scheduled.isValid) return scheduled.toISODate();
  }
  const dayIndex = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .indexOf(session.day_of_week.trim().toLowerCase());
  if (dayIndex < 0) return null;
  return DateTime.fromISO(weekStart, { zone: timezone }).plus({ days: dayIndex }).toISODate();
}

function cookingTrainingDemandScore(session: TrainingSession): number {
  const haystack = `${session.title} ${session.session_type} ${session.intensity_text ?? ''}`.toLowerCase();
  let score = Math.max(0, Number(session.duration_minutes ?? 0)) / 10;
  if (/\b(?:long|race|brick|threshold|interval|tempo|endurance|vo2|marathon|century)\b/.test(haystack)) score += 100;
  if (/\b(?:hard|high|heavy|max|intense)\b/.test(haystack)) score += 40;
  return score;
}

function buildCookingSupportGuidance(input: {
  action: ChatPlanStep['action'];
  timing: 'pre_workout' | 'post_workout' | 'general';
  capabilityBoundary: unknown;
  trainingSession: TrainingSession | null;
  readinessFlags: {
    lowSleep: boolean;
    lowHrv: boolean;
    lowReadiness: boolean;
    highLegLoad: boolean;
    highShoulderLoad: boolean;
    fuelingGap: boolean;
    otherSportRpeToday: number;
  } | null;
  mealsPlanned: number;
  expiredPantryItems: number;
  hasSafetyPreferences: boolean;
  hasSavedRecipeSuggestions: boolean;
  locale?: string;
}): string[] {
  const guidance: string[] = [];
  const pt = input.locale?.startsWith('pt') === true;
  const localize = (english: string, portuguese: string) => pt ? portuguese : english;
  if (input.capabilityBoundary === 'single_meal_slot_only') {
    guidance.push(localize(
      'Cooking can save one dated meal slot at a time; choose a date, meal type, and title before requesting a write.',
      'Cooking guarda uma refeição datada de cada vez; escolha a data, o tipo de refeição e o título antes de pedir a gravação.',
    ));
  }
  if (input.action === 'cooking_fueling_support') {
    if (input.timing === 'pre_workout') guidance.push(localize(
      'Use a familiar carbohydrate-forward option before the session, with timing and portion adjusted to personal tolerance.',
      'Antes da sessão, escolha uma opção familiar rica em hidratos, ajustando o horário e a porção à sua tolerância.',
    ));
    else if (input.timing === 'post_workout') guidance.push(localize(
      'Prioritize carbohydrate, protein, and fluid after the session to support recovery.',
      'Depois da sessão, priorize hidratos, proteína e líquidos para apoiar a recuperação.',
    ));
    else if (input.trainingSession) guidance.push(localize(
      'Protect both pre-session energy and post-session recovery around the verified training schedule.',
      'Proteja a energia antes da sessão e a recuperação depois, seguindo o horário de treino verificado.',
    ));
    else guidance.push(localize(
      'No training session is verified for the requested date; use general balanced-meal guidance and confirm the Training plan before timing fuel.',
      'Não há uma sessão de treino verificada para a data pedida; use orientação geral de refeição equilibrada e confirme o plano de Training antes de definir o horário.',
    ));
    if (input.trainingSession && /\b(?:long|interval|tempo|threshold|race|brick|endurance)\b/i.test(`${input.trainingSession.title} ${input.trainingSession.session_type} ${input.trainingSession.intensity_text ?? ''}`)) {
      guidance.push(localize('This is a higher-demand session; plan the fueling window explicitly instead of relying on an unplanned meal.', 'Esta é uma sessão mais exigente; planeie explicitamente a janela de alimentação em vez de depender de uma refeição improvisada.'));
    }
    if (input.readinessFlags?.lowSleep || input.readinessFlags?.lowHrv || input.readinessFlags?.lowReadiness) {
      guidance.push(localize('Readiness is flagged low; favor easy-to-tolerate food and hydration, and follow the Training plan if session intensity is reduced.', 'A prontidão está baixa; prefira alimentos fáceis de tolerar e hidratação, seguindo o plano de Training se a intensidade for reduzida.'));
    }
    if (input.readinessFlags?.highLegLoad || input.readinessFlags?.highShoulderLoad || (input.readinessFlags?.otherSportRpeToday ?? 0) > 0) {
      guidance.push(localize('Recent training load is active; do not skip the recovery meal window.', 'Existe carga de treino recente; não salte a janela da refeição de recuperação.'));
    }
  } else {
    guidance.push(input.mealsPlanned > 0
      ? localize('Use the persisted meal slot and shopping coverage as the source of truth before changing the plan.', 'Use a refeição guardada e a respetiva cobertura de compras como fonte de verdade antes de alterar o plano.')
      : input.hasSavedRecipeSuggestions
        ? localize('A saved recipe that already satisfies current safety checks is available as an advisory option.', 'Existe uma receita guardada que passou as verificações de segurança atuais e pode ser usada como opção consultiva.')
        : localize('Build a simple meal from one tolerated protein, one staple carbohydrate, and produce you already use; save the chosen dated slot before generating shopping coverage.', 'Monte uma refeição simples com uma proteína tolerada, um hidrato base e vegetais que já usa; guarde a refeição datada antes de gerar a cobertura de compras.'));
  }
  if (input.expiredPantryItems > 0) guidance.push(localize('Do not use pantry items marked expired; prefer fresh or use-soon inventory that also satisfies saved constraints.', 'Não use itens da despensa marcados como expirados; prefira itens frescos ou a usar em breve que também respeitem as restrições guardadas.'));
  if (input.hasSafetyPreferences) guidance.push(localize('Keep all saved allergies and dietary restrictions as hard constraints when choosing ingredients.', 'Trate todas as alergias e restrições alimentares guardadas como limites obrigatórios ao escolher ingredientes.'));
  return guidance;
}

function foldCookingSupportText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeSubstitutionReason(value: unknown): 'allergy' | 'dietary_restriction' | 'disliked_ingredient' | 'expired_pantry' {
  if (value === 'allergy' || value === 'dietary_restriction' || value === 'disliked_ingredient' || value === 'expired_pantry') return value;
  return 'disliked_ingredient';
}

function ingredientNameMatches(candidate: string, originalIngredient: string): boolean {
  const candidateName = candidate.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  const originalName = originalIngredient.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!originalName) return false;
  if (candidateName === originalName) return true;
  let searchFrom = 0;
  while (searchFrom <= candidateName.length - originalName.length) {
    const index = candidateName.indexOf(originalName, searchFrom);
    if (index < 0) return false;
    const before = index > 0 ? candidateName[index - 1] : undefined;
    const afterIndex = index + originalName.length;
    const after = afterIndex < candidateName.length ? candidateName[afterIndex] : undefined;
    const isWordCharacter = (value: string | undefined) => value !== undefined && /[\p{L}\p{N}]/u.test(value);
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    searchFrom = index + 1;
  }
  return false;
}
