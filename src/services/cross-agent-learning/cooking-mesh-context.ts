// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Deterministic Cooking mesh adapter. */

import {
  classifyIngredientAisle,
  getMealPlan,
  getRecipeById,
  getShoppingList,
  type Ingredient,
  type MealPlan,
  type ShoppingItem,
  type ShoppingList,
} from '../cooking-chef';
import { convertPlanningEstimateFromBrl, getPreferredCurrencyForUser } from '../finance-tracker';
import { getFocusBlockRecommendation, type FocusBlockRecommendation } from '../focus-planner';
import type { MeshPriority } from '../intelligence-bus';
import { getEvents, type UnifiedCalendarEvent } from '../unified-calendar';
import { logger } from '../../utils/logger';
import { isValidTenantUserId } from '../tenant-scope-observability';
import type { CookingMeshContext } from './types';
import {
  endOfDayIso,
  extractTravelDates,
  reportInvalidMeshScope,
  resolveWeekWindow,
  roundTo,
  safely,
  safelyAsync,
  summarizeBusyDates,
  summarizeCalendarFragmentation,
  uniqueStrings,
  weekIsoDates,
} from './mesh-common';
import { findActivePlanForWeek, inferTrainingLoad, sessionDateForWeek } from './training-mesh-context';
import { getSessionsForWeek } from '../training-plans';

export function createEmptyCookingMeshContext(opts: { userId: number; weekStart?: string }): CookingMeshContext {
  const window = resolveWeekWindow(opts.weekStart);
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    meals: [],
    shoppingList: null,
    derivedSignals: [],
  };
}

export async function readCookingMeshContext(opts: {
  userId: number;
  tenantId?: number;
  weekStart?: string;
}): Promise<CookingMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_cooking_mesh_context', opts.userId, opts.weekStart);
    return createEmptyCookingMeshContext(opts);
  }

  const window = resolveWeekWindow(opts.weekStart);
  let meals: MealPlan[] = [];
  let shoppingList: ShoppingList | null = null;

  try {
    meals = getMealPlan(opts.userId, window.weekStart, window.weekEnd, opts.tenantId);
  } catch (err) {
    logger.debug({ err, userId: opts.userId }, 'Mesh: cooking meal plan unavailable');
  }

  try {
    shoppingList = getShoppingList(opts.userId, window.weekStart, opts.tenantId);
  } catch (err) {
    logger.debug({ err, userId: opts.userId }, 'Mesh: shopping list unavailable');
  }

  const mealProfiles = meals.map((meal) => buildCookingMealProfile(opts.userId, meal, opts.tenantId));
  const [calendarEvents, focusBlock] = await Promise.all([
    safelyAsync(
      () => getEvents(window.start.toUTC().toISO()!, window.end.toUTC().toISO()!, opts.userId),
      [] as UnifiedCalendarEvent[],
    ),
    safelyAsync(
      () => opts.tenantId == null
        ? Promise.resolve(null)
        : getFocusBlockRecommendation(opts.userId, { tenantId: opts.tenantId, horizonDays: 7 }),
      null as FocusBlockRecommendation | null,
    ),
  ]);

  const coveredDays = new Set(meals.map((meal) => meal.date));
  const missingDates = weekIsoDates(window.start).filter((date) => !coveredDays.has(date));
  const busyDates = new Set(summarizeBusyDates(calendarEvents));
  const fragmentedDates = new Set(summarizeCalendarFragmentation(calendarEvents).fragmentedDates);
  const travelDates = new Set(extractTravelDates(calendarEvents));
  const focusDate = focusBlock?.date ?? null;
  const constrainedDates = new Set<string>([
    ...busyDates,
    ...fragmentedDates,
    ...travelDates,
    ...(focusDate ? [focusDate] : []),
  ]);
  const prepPressureDates = uniqueStrings(
    mealProfiles
      .filter((profile) => constrainedDates.has(profile.date) && (!profile.hasLinkedRecipe || profile.isHighEffort))
      .map((profile) => profile.date),
  );
  const constrainedMealDates = uniqueStrings(
    meals
      .map((meal) => meal.date)
      .filter((date) => constrainedDates.has(date)),
  );
  const shoppingForecastSource = deriveShoppingForecastSource(shoppingList?.items ?? [], mealProfiles, meals.length);
  const aisleCount = new Set(shoppingForecastSource.items.map((item) => normalizeShoppingAisle(item.aisle)).filter(Boolean)).size;
  const estimatedSpendBrl = estimateShoppingSpendBrl(shoppingForecastSource.items);
  const requestedCurrency = getPreferredCurrencyForUser(opts.userId);
  let preferredCurrency = requestedCurrency;
  let estimatedSpend = estimatedSpendBrl;
  try {
    estimatedSpend = convertPlanningEstimateFromBrl(estimatedSpendBrl, requestedCurrency);
  } catch {
    preferredCurrency = 'BRL';
  }
  const shoppingReady = (shoppingList?.items.length ?? 0) > 0;
  const manualMealCount = mealProfiles.filter((profile) => !profile.hasLinkedRecipe).length;
  const highEffortMealCount = mealProfiles.filter((profile) => profile.isHighEffort).length;
  const totalPrepMinutes = mealProfiles.reduce((sum, profile) => sum + profile.prepMinutes, 0);
  const totalCookMinutes = mealProfiles.reduce((sum, profile) => sum + profile.cookMinutes, 0);

  const activePlanMatch = findActivePlanForWeek(
    opts.userId,
    opts.tenantId ?? opts.userId,
    window.weekStart,
  );
  const trainingSessions = activePlanMatch?.week ? getSessionsForWeek(activePlanMatch.week.id) : [];
  const scheduledTraining = trainingSessions
    .map((session) => ({
      session,
      date: sessionDateForWeek(session, window.start),
      load: inferTrainingLoad(session),
    }))
    .filter((entry) => Boolean(entry.date));
  const trainingDates = uniqueStrings(scheduledTraining.map((entry) => entry.date));
  const hardTrainingDates = uniqueStrings(
    scheduledTraining
      .filter((entry) => entry.load === 'hard')
      .map((entry) => entry.date),
  );
  const trainingDatesMissingMeals = trainingDates.filter((date) => !coveredDays.has(date));
  const hardDatesMissingMeals = hardTrainingDates.filter((date) => !coveredDays.has(date));
  const trainingCoverageRatio = trainingDates.length > 0
    ? roundTo((trainingDates.length - trainingDatesMissingMeals.length) / trainingDates.length, 2)
    : null;
  const fuelingSupportStatus = trainingDates.length === 0
    ? null
    : hardDatesMissingMeals.length > 0
      ? 'at_risk'
      : trainingDatesMissingMeals.length > 0 || !shoppingReady
      ? 'partial'
        : 'ready';
  const mealExecutionStatus = missingDates.length >= 3 && !shoppingReady
    ? 'at_risk'
    : prepPressureDates.length >= 2
      ? 'at_risk'
      : missingDates.length > 0 || !shoppingReady || prepPressureDates.length > 0 || manualMealCount > 0
      ? 'partial'
      : 'ready';

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    meals,
    shoppingList,
    derivedSignals: [
      {
        sourceAgent: 'mesh.cooking-context',
        signalType: 'meal_plan_window',
        meshPriority: 3,
        priority: 'normal',
        expiresAt: endOfDayIso(window.end),
        payload: {
          weekStart: window.weekStart,
          weekEnd: window.weekEnd,
          coveredDays: [...coveredDays],
          totalMeals: meals.length,
          missingDates,
        },
      },
      ...(fuelingSupportStatus
        ? [{
            sourceAgent: 'mesh.cooking-context',
            signalType: 'fueling_support_status' as const,
            meshPriority: (fuelingSupportStatus === 'at_risk' ? 2 : 3) as MeshPriority,
            priority: fuelingSupportStatus === 'at_risk' ? 'urgent' as const : 'normal' as const,
            expiresAt: endOfDayIso(window.end),
            payload: {
              status: fuelingSupportStatus,
              trainingDates,
              trainingDatesMissingMeals,
              hardDatesMissingMeals,
              trainingCoverageRatio,
              shoppingReady,
            },
          }]
        : []),
      {
        sourceAgent: 'mesh.cooking-context',
        signalType: 'meal_execution_readiness',
        meshPriority: (mealExecutionStatus === 'at_risk' ? 2 : 3) as MeshPriority,
        priority: mealExecutionStatus === 'at_risk' ? 'urgent' : 'normal',
        expiresAt: endOfDayIso(window.end),
        payload: {
          status: mealExecutionStatus,
          missingDates,
          shoppingReady,
          shoppingItemCount: shoppingList?.items.length ?? 0,
          coveredDayCount: coveredDays.size,
          constrainedMealDates,
          prepPressureDates,
          manualMealCount,
          highEffortMealCount,
          totalPrepMinutes,
          totalCookMinutes,
          focusDate,
        },
      },
      {
        sourceAgent: 'mesh.cooking-context',
        signalType: 'grocery_spend_forecast',
        meshPriority: 3 as MeshPriority,
        priority: 'background',
        expiresAt: endOfDayIso(window.end),
        payload: {
          estimatedSpendBrl,
          estimatedSpend,
          currency: preferredCurrency,
          itemCount: shoppingForecastSource.items.length,
          aisleCount,
          source: shoppingForecastSource.source,
          confidence: shoppingForecastSource.confidence,
        },
      },
    ],
  };
}

interface CookingMealProfile {
  date: string;
  hasLinkedRecipe: boolean;
  prepMinutes: number;
  cookMinutes: number;
  isHighEffort: boolean;
  ingredients: Ingredient[];
}

function buildCookingMealProfile(userId: number, meal: MealPlan, tenantId?: number): CookingMealProfile {
  if (!meal.recipe_id) {
    return {
      date: meal.date,
      hasLinkedRecipe: false,
      prepMinutes: 0,
      cookMinutes: 0,
      isHighEffort: false,
      ingredients: [],
    };
  }

  const recipe = safely(() => getRecipeById(userId, meal.recipe_id!, tenantId), null);
  const prepMinutes = recipe?.prep_time_min ?? 0;
  const cookMinutes = recipe?.cook_time_min ?? 0;
  const totalMinutes = prepMinutes + cookMinutes;

  return {
    date: meal.date,
    hasLinkedRecipe: Boolean(recipe),
    prepMinutes,
    cookMinutes,
    isHighEffort: prepMinutes >= 20 || totalMinutes >= 45,
    ingredients: recipe?.ingredients ?? [],
  };
}

function deriveShoppingForecastSource(
  shoppingItems: ShoppingItem[],
  mealProfiles: CookingMealProfile[],
  mealCount: number,
): {
  source: 'shopping_list' | 'recipe_ingredients' | 'meal_count_fallback';
  confidence: 'high' | 'medium' | 'low';
  items: Array<{ aisle: string }>;
} {
  if (shoppingItems.length > 0) {
    return {
      source: 'shopping_list',
      confidence: 'high',
      items: shoppingItems.map((item) => ({ aisle: item.aisle })),
    };
  }

  const ingredientItems = mealProfiles.flatMap((profile) =>
    profile.ingredients.map((ingredient) => ({
      aisle: classifyIngredientAisle(ingredient.name),
    })),
  );
  if (ingredientItems.length > 0) {
    return {
      source: 'recipe_ingredients',
      confidence: 'medium',
      items: ingredientItems,
    };
  }

  return {
    source: 'meal_count_fallback',
    confidence: mealCount > 0 ? 'low' : 'high',
    items: Array.from({ length: mealCount * 3 }, () => ({ aisle: 'other' })),
  };
}

function estimateShoppingSpendBrl(items: Array<{ aisle: string }>): number {
  const spendByAisle: Record<string, number> = {
    produce: 8,
    protein: 24,
    dairy: 10,
    bakery: 6,
    pantry: 5,
    frozen: 9,
    beverages: 6,
    household: 7,
    other: 6,
  };

  const total = items.reduce((sum, item) => {
    const aisle = normalizeShoppingAisle(item.aisle);
    return sum + (spendByAisle[aisle] ?? spendByAisle.other);
  }, 0);

  return roundTo(total, 2);
}

function normalizeShoppingAisle(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}
