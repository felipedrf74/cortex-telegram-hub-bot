// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Deterministic Cooking mesh adapter. */

import {
  classifyIngredientAisle,
  getMealPlan,
  getRecipeById,
  getShoppingList,
  type Ingredient,
  type MealPlan,
  type Recipe,
  type ShoppingItem,
  type ShoppingList,
  type ShoppingListSafetyIssue,
} from '../cooking-chef';
import type { CookingPreferenceProfile } from '../cooking-intelligence';
import { buildCookingPreferenceReadModel } from '../cooking-preferences';
import { evaluateCookingSafetyTextForProfile } from '../cooking-safety-policy';
import { convertPlanningEstimateFromBrl, getPreferredCurrencyForUser } from '../finance-tracker';
import { getFocusBlockRecommendation, type FocusBlockRecommendation } from '../focus-planner';
import type { MeshPriority } from '../intelligence-bus';
import {
  getEventsWithDiagnostics,
  type UnifiedCalendarFetchResult,
} from '../unified-calendar';
import { logger } from '../../utils/logger';
import { isValidTenantUserId } from '../tenant-scope-observability';
import { getUserTimezoneById } from '../user-service';
import { resolveTrainingTimezone } from '../training-date-utils';
import type {
  CookingCalendarStatus,
  CookingMeshContext,
  CookingSafetySourceHealth,
  CookingSourceHealth,
} from './types';
import {
  endOfDayIso,
  extractTravelDates,
  reportInvalidMeshScope,
  resolveWeekWindow,
  roundTo,
  summarizeBusyDates,
  summarizeCalendarFragmentation,
  uniqueStrings,
  weekIsoDates,
} from './mesh-common';
import { findActivePlanForWeek, inferTrainingLoad, sessionDateForWeek } from './training-mesh-context';
import { getSessionsForWeek } from '../training-plans';

export function createEmptyCookingMeshContext(opts: { userId: number; weekStart?: string }): CookingMeshContext {
  const timezone = resolveCookingContextTimezone(opts.userId);
  const window = resolveWeekWindow(opts.weekStart, timezone);
  return {
    userId: opts.userId,
    timezone,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    meals: [],
    shoppingList: null,
    sourceHealth: {
      mealPlan: unavailableSource('COOKING_MEAL_PLAN_CONTEXT_UNAVAILABLE'),
      shoppingList: unavailableSource('COOKING_SHOPPING_CONTEXT_UNAVAILABLE'),
      recipes: unavailableSource('COOKING_RECIPE_CONTEXT_UNAVAILABLE'),
      focus: unavailableSource('COOKING_FOCUS_CONTEXT_UNAVAILABLE'),
      safety: unavailableSafetySource('COOKING_SAFETY_CONTEXT_UNAVAILABLE'),
    },
    availability: {
      busyDates: [],
      fragmentedDates: [],
      travelDates: [],
      focusDate: null,
    },
    calendar: {
      status: 'unavailable',
      warningCodes: ['COOKING_CALENDAR_CONTEXT_UNAVAILABLE'],
    },
    derivedSignals: [],
  };
}

export async function readCookingMeshContext(opts: {
  userId: number;
  tenantId?: number;
  weekStart?: string;
  timezone?: string;
}): Promise<CookingMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_cooking_mesh_context', opts.userId, opts.weekStart);
    return createEmptyCookingMeshContext(opts);
  }

  const timezone = resolveCookingContextTimezone(opts.userId, opts.timezone);
  const window = resolveWeekWindow(opts.weekStart, timezone);
  const tenantId = opts.tenantId ?? opts.userId;
  let persistedMeals: MealPlan[] = [];
  let shoppingList: ShoppingList | null = null;
  let mealPlanHealth: CookingSourceHealth = readySource();
  let shoppingHealth: CookingSourceHealth = readySource();

  try {
    persistedMeals = getMealPlan(opts.userId, window.weekStart, window.weekEnd, tenantId);
  } catch (err) {
    logger.debug({ err, userId: opts.userId }, 'Mesh: cooking meal plan unavailable');
    mealPlanHealth = unavailableSource('COOKING_MEAL_PLAN_READ_FAILED');
  }

  try {
    shoppingList = getShoppingList(opts.userId, window.weekStart, tenantId);
  } catch (err) {
    logger.debug({ err, userId: opts.userId }, 'Mesh: shopping list unavailable');
    shoppingHealth = unavailableSource('COOKING_SHOPPING_LIST_READ_FAILED');
  }

  const recipeReads = persistedMeals.map((meal) => buildCookingMealProfile(opts.userId, meal, tenantId));
  const recipeWarningCodes = uniqueStrings(recipeReads.flatMap((entry) => entry.warningCodes));
  const recipeHealth: CookingSourceHealth = mealPlanHealth.status !== 'ready'
    ? unavailableSource('COOKING_RECIPE_CONTEXT_BLOCKED_BY_MEAL_PLAN')
    : recipeWarningCodes.includes('COOKING_RECIPE_READ_FAILED')
      ? { status: 'unavailable', warningCodes: recipeWarningCodes }
      : recipeWarningCodes.length > 0
        ? { status: 'degraded', warningCodes: recipeWarningCodes }
        : readySource();
  const safetyProjection = projectCookingSafety({
    userId: opts.userId,
    tenantId,
    mealPlanHealth,
    recipeReads,
    shoppingList,
  });
  const meals = safetyProjection.meals;
  const mealProfiles = safetyProjection.mealProfiles;
  const safeShoppingList = safetyProjection.shoppingList;
  const [calendarRead, focusRead] = await Promise.all([
    readCookingCalendarWithDiagnostics({
      userId: opts.userId,
      start: window.start.toUTC().toISO()!,
      end: window.end.toUTC().toISO()!,
    }),
    readCookingFocusWithDiagnostics({
      userId: opts.userId,
      tenantId,
    }),
  ]);
  const calendarEvents = calendarRead.events;
  const calendarAvailabilityVerified = calendarRead.status === 'ready'
    || calendarRead.status === 'not_configured';
  const focusBlock = focusRead.value;

  const coveredDays = new Set(meals.map((meal) => meal.date));
  const missingDates = weekIsoDates(window.start).filter((date) => !coveredDays.has(date));
  const busyDateList = summarizeBusyDates(calendarEvents, timezone);
  const fragmentedDateList = summarizeCalendarFragmentation(calendarEvents, timezone).fragmentedDates;
  const travelDateList = extractTravelDates(calendarEvents, timezone);
  const busyDates = new Set(busyDateList);
  const fragmentedDates = new Set(fragmentedDateList);
  const travelDates = new Set(travelDateList);
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
  const shoppingForecastSource = deriveShoppingForecastSource(safeShoppingList?.items ?? [], mealProfiles, meals.length);
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
  const shoppingReady = (safeShoppingList?.items.length ?? 0) > 0;
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
  const mealCoverageVerified = mealPlanHealth.status === 'ready'
    && safetyProjection.health.status !== 'unavailable';
  const fuelingInputsVerified = mealCoverageVerified && shoppingHealth.status === 'ready';
  const executionInputsVerified = fuelingInputsVerified
    && recipeHealth.status === 'ready'
    && calendarAvailabilityVerified
    && focusRead.health.status === 'ready';
  const forecastInputsVerified = mealCoverageVerified
    && shoppingHealth.status === 'ready'
    && recipeHealth.status === 'ready';

  return {
    userId: opts.userId,
    timezone,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    meals,
    shoppingList: safeShoppingList,
    sourceHealth: {
      mealPlan: mealPlanHealth,
      shoppingList: shoppingHealth,
      recipes: recipeHealth,
      focus: focusRead.health,
      safety: safetyProjection.health,
    },
    availability: {
      busyDates: busyDateList,
      fragmentedDates: fragmentedDateList,
      travelDates: travelDateList,
      focusDate,
    },
    calendar: {
      status: calendarRead.status,
      warningCodes: calendarRead.warningCodes,
    },
    derivedSignals: [
      ...(mealCoverageVerified ? [{
        sourceAgent: 'mesh.cooking-context',
        signalType: 'meal_plan_window' as const,
        meshPriority: 3 as MeshPriority,
        priority: 'normal' as const,
        expiresAt: endOfDayIso(window.end),
        payload: {
          weekStart: window.weekStart,
          weekEnd: window.weekEnd,
          coveredDays: [...coveredDays],
          totalMeals: meals.length,
          missingDates,
        },
      }] : []),
      ...(fuelingSupportStatus && fuelingInputsVerified
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
      ...(executionInputsVerified ? [{
        sourceAgent: 'mesh.cooking-context',
        signalType: 'meal_execution_readiness' as const,
        meshPriority: (mealExecutionStatus === 'at_risk' ? 2 : 3) as MeshPriority,
        priority: mealExecutionStatus === 'at_risk' ? 'urgent' as const : 'normal' as const,
        expiresAt: endOfDayIso(window.end),
        payload: {
          status: mealExecutionStatus,
          missingDates,
          shoppingReady,
          shoppingItemCount: safeShoppingList?.items.length ?? 0,
          coveredDayCount: coveredDays.size,
          constrainedMealDates,
          prepPressureDates,
          manualMealCount,
          highEffortMealCount,
          totalPrepMinutes,
          totalCookMinutes,
          focusDate,
        },
      }] : []),
      ...(forecastInputsVerified ? [{
        sourceAgent: 'mesh.cooking-context',
        signalType: 'grocery_spend_forecast' as const,
        meshPriority: 3 as MeshPriority,
        priority: 'background' as const,
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
      }] : []),
    ],
  };
}

async function readCookingCalendarWithDiagnostics(input: {
  userId: number;
  start: string;
  end: string;
}): Promise<Omit<UnifiedCalendarFetchResult, 'status'> & { status: CookingCalendarStatus }> {
  try {
    const result = await getEventsWithDiagnostics(input.start, input.end, input.userId);
    const integrationMissing = result.status === 'unavailable'
      && result.sources.configured.length === 0
      && result.warningCodes.includes('CALENDAR_INTEGRATION_MISSING');
    if (integrationMissing) {
      return {
        ...result,
        status: 'not_configured',
        warningCodes: [],
        warnings: [],
      };
    }
    return result;
  } catch (err) {
    logger.warn(
      { err, userId: input.userId },
      'Mesh: Cooking calendar read failed; availability is unavailable',
    );
    return {
      events: [],
      status: 'unavailable',
      warningCodes: ['COOKING_CALENDAR_READ_FAILED'],
      warnings: ['Calendar availability could not be verified for Cooking planning.'],
      sources: {
        configured: [],
        fulfilled: [],
        failed: [],
      },
    };
  }
}

async function readCookingFocusWithDiagnostics(input: {
  userId: number;
  tenantId: number;
}): Promise<{ value: FocusBlockRecommendation | null; health: CookingSourceHealth }> {
  try {
    return {
      value: await getFocusBlockRecommendation(input.userId, {
        tenantId: input.tenantId,
        horizonDays: 7,
      }),
      health: readySource(),
    };
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, tenantId: input.tenantId },
      'Mesh: Cooking focus availability read failed',
    );
    return {
      value: null,
      health: unavailableSource('COOKING_FOCUS_READ_FAILED'),
    };
  }
}

function resolveCookingContextTimezone(userId: number, requested?: string | null): string {
  if (requested) return resolveTrainingTimezone(requested);
  try {
    return resolveTrainingTimezone(getUserTimezoneById(userId));
  } catch {
    return resolveTrainingTimezone();
  }
}

function readySource(): CookingSourceHealth {
  return { status: 'ready', warningCodes: [] };
}

function unavailableSource(warningCode: string): CookingSourceHealth {
  return { status: 'unavailable', warningCodes: [warningCode] };
}

function unavailableSafetySource(
  warningCode: string,
  excludedMealDates: string[] = [],
  additionalWarningCodes: string[] = [],
): CookingSafetySourceHealth {
  return {
    status: 'unavailable',
    warningCodes: uniqueStrings([warningCode, ...additionalWarningCodes]),
    excludedMealCount: excludedMealDates.length,
    excludedMealDates,
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

interface CookingMealProfileRead {
  meal: MealPlan;
  recipe: Recipe | null;
  profile: CookingMealProfile;
  warningCodes: string[];
}

function buildCookingMealProfile(userId: number, meal: MealPlan, tenantId?: number): CookingMealProfileRead {
  if (!meal.recipe_id) {
    return {
      meal,
      recipe: null,
      profile: {
        date: meal.date,
        hasLinkedRecipe: false,
        prepMinutes: 0,
        cookMinutes: 0,
        isHighEffort: false,
        ingredients: [],
      },
      warningCodes: [],
    };
  }

  let recipe: ReturnType<typeof getRecipeById>;
  try {
    recipe = getRecipeById(userId, meal.recipe_id, tenantId);
  } catch (err) {
    logger.warn(
      { err, userId, recipeId: meal.recipe_id },
      'Mesh: Cooking linked recipe read failed',
    );
    return {
      meal,
      recipe: null,
      profile: {
        date: meal.date,
        hasLinkedRecipe: false,
        prepMinutes: 0,
        cookMinutes: 0,
        isHighEffort: false,
        ingredients: [],
      },
      warningCodes: ['COOKING_RECIPE_READ_FAILED'],
    };
  }
  if (!recipe) {
    return {
      meal,
      recipe: null,
      profile: {
        date: meal.date,
        hasLinkedRecipe: false,
        prepMinutes: 0,
        cookMinutes: 0,
        isHighEffort: false,
        ingredients: [],
      },
      warningCodes: ['COOKING_LINKED_RECIPE_MISSING'],
    };
  }
  const prepMinutes = recipe?.prep_time_min ?? 0;
  const cookMinutes = recipe?.cook_time_min ?? 0;
  const totalMinutes = prepMinutes + cookMinutes;

  return {
    meal,
    recipe,
    profile: {
      date: meal.date,
      hasLinkedRecipe: true,
      prepMinutes,
      cookMinutes,
      isHighEffort: prepMinutes >= 20 || totalMinutes >= 45,
      ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
    },
    warningCodes: [],
  };
}

function projectCookingSafety(input: {
  userId: number;
  tenantId: number;
  mealPlanHealth: CookingSourceHealth;
  recipeReads: CookingMealProfileRead[];
  shoppingList: ShoppingList | null;
}): {
  meals: MealPlan[];
  mealProfiles: CookingMealProfile[];
  shoppingList: ShoppingList | null;
  health: CookingSafetySourceHealth;
} {
  const persistedMealDates = input.recipeReads.map((entry) => entry.meal.date);

  let profile: CookingPreferenceProfile;
  try {
    profile = buildCookingPreferenceReadModel(input.userId, input.tenantId).profile;
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, tenantId: input.tenantId },
      'Mesh: Cooking safety preference read failed; persisted meals withheld',
    );
    return {
      meals: [],
      mealProfiles: [],
      shoppingList: null,
      health: unavailableSafetySource(
        'COOKING_SAFETY_PROFILE_UNAVAILABLE',
        persistedMealDates,
      ),
    };
  }

  const safeShoppingList = projectShoppingListForCurrentSafety(input.shoppingList, profile);
  const shoppingWarningCodes = shoppingSafetyWarningCodes(safeShoppingList);
  if (input.mealPlanHealth.status !== 'ready') {
    return {
      meals: [],
      mealProfiles: [],
      shoppingList: safeShoppingList,
      health: unavailableSafetySource(
        'COOKING_SAFETY_CONTEXT_BLOCKED_BY_MEAL_PLAN',
        persistedMealDates,
        shoppingWarningCodes,
      ),
    };
  }

  const safeReads: CookingMealProfileRead[] = [];
  const excludedMealDates: string[] = [];
  const excludedMeals: NonNullable<CookingSafetySourceHealth['excludedMeals']> = [];
  const warningCodes = [...shoppingWarningCodes];
  for (const entry of input.recipeReads) {
    const evaluations = [evaluateCookingSafetyTextForProfile(
      profile,
      'meal_plan',
      [entry.meal.title, entry.meal.notes],
    )];
    if (entry.recipe) {
      evaluations.push(evaluateCookingSafetyTextForProfile(
        profile,
        'recipe',
        [
          entry.recipe.title,
          entry.recipe.instructions,
          entry.recipe.tags,
          entry.recipe.source,
          ...(Array.isArray(entry.recipe.ingredients)
            ? entry.recipe.ingredients.flatMap((ingredient) => [
                ingredient.name,
                ingredient.quantity,
                ingredient.unit,
              ])
            : []),
        ],
      ));
    }

    const linkedRecipeUnverified = entry.meal.recipe_id != null && entry.recipe == null;
    const conflictIssues = evaluations.flatMap((evaluation) => evaluation.issues);
    if (!linkedRecipeUnverified && conflictIssues.length === 0) {
      safeReads.push(entry);
      continue;
    }

    excludedMealDates.push(entry.meal.date);
    excludedMeals.push({
      date: entry.meal.date,
      reason: linkedRecipeUnverified && conflictIssues.length > 0
        ? 'preference_conflict_and_unverified_recipe'
        : linkedRecipeUnverified
          ? 'unverified_recipe'
          : 'preference_conflict',
    });
    warningCodes.push('COOKING_SAVED_MEAL_SAFETY_WITHHELD');
    if (linkedRecipeUnverified) {
      warningCodes.push('COOKING_SAVED_MEAL_RECIPE_UNVERIFIED');
    }
    for (const issue of conflictIssues) {
      if (issue.code === 'ALLERGY_CONFLICT') {
        warningCodes.push('COOKING_SAVED_MEAL_ALLERGY_CONFLICT');
      } else if (issue.code === 'DIETARY_RESTRICTION_CONFLICT') {
        warningCodes.push('COOKING_SAVED_MEAL_DIETARY_RESTRICTION_CONFLICT');
      }
    }
  }

  const normalizedWarningCodes = uniqueStrings(warningCodes);
  return {
    meals: safeReads.map((entry) => entry.meal),
    mealProfiles: safeReads.map((entry) => entry.profile),
    shoppingList: safeShoppingList,
    health: {
      status: normalizedWarningCodes.length > 0 ? 'degraded' : 'ready',
      warningCodes: normalizedWarningCodes,
      excludedMealCount: excludedMealDates.length,
      excludedMealDates,
      excludedMeals,
    },
  };
}

function projectShoppingListForCurrentSafety(
  shoppingList: ShoppingList | null,
  profile: CookingPreferenceProfile,
): ShoppingList | null {
  if (!shoppingList) return null;
  const items: ShoppingItem[] = [];
  const safetyIssues: ShoppingListSafetyIssue[] = [...(shoppingList.safetyIssues ?? [])];
  for (const item of shoppingList.items) {
    const evaluation = evaluateCookingSafetyTextForProfile(
      profile,
      'shopping_list',
      [item.name, item.quantity, item.unit],
    );
    if (!evaluation.blocked) {
      items.push(item);
      continue;
    }
    for (const issue of evaluation.issues) {
      if (issue.code === 'ALLERGY_CONFLICT' || issue.code === 'DIETARY_RESTRICTION_CONFLICT') {
        safetyIssues.push({ code: issue.code, itemName: item.name });
      }
    }
  }
  const dedupedSafetyIssues = safetyIssues.filter((issue, index, all) => (
    all.findIndex((candidate) => candidate.code === issue.code && candidate.itemName === issue.itemName) === index
  ));
  return dedupedSafetyIssues.length > 0
    ? { ...shoppingList, items, safetyIssues: dedupedSafetyIssues }
    : { ...shoppingList, items };
}

function shoppingSafetyWarningCodes(shoppingList: ShoppingList | null): string[] {
  return uniqueStrings((shoppingList?.safetyIssues ?? []).map((issue) => (
    issue.code === 'ALLERGY_CONFLICT'
      ? 'COOKING_SHOPPING_LIST_ALLERGY_CONFLICT'
      : 'COOKING_SHOPPING_LIST_DIETARY_RESTRICTION_CONFLICT'
  )));
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
