// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Ingredient, MealPlan, Recipe, ShoppingList } from './cooking-chef';

export type CookingConstraintSeverity = 'info' | 'warning' | 'blocker';

export interface CookingPreferenceProfile {
  allergies?: string[];
  dietaryRestrictions?: string[];
  dislikedIngredients?: string[];
  preferredIngredients?: string[];
  weekdayMaxPrepMinutes?: number;
  maxMealComplexityPerWeek?: number;
  budgetLimit?: number;
  budgetCurrency?: string;
  batchCookingPreferred?: boolean;
  trainingDayPreference?: string;
}

export interface CookingTrainingContext {
  trainingDates?: string[];
  hardTrainingDates?: string[];
  recoveryDates?: string[];
}

export interface CookingPantryItem {
  name: string;
  quantity?: string;
  unit?: string;
  expiresAt?: string | null;
  status?: 'available' | 'expired' | 'unknown' | 'unavailable';
}

export interface CookingPlanAssessmentInput {
  meals: MealPlan[];
  recipesById?: Map<number, Recipe>;
  shoppingList?: ShoppingList | null;
  preferences?: CookingPreferenceProfile;
  pantryItems?: CookingPantryItem[];
  availableCookingMinutesByDate?: Record<string, number>;
  estimatedBudget?: number | null;
  financeBudgetContext?: {
    status?: string;
    affordability?: string | null;
    budgetLimit?: number | null;
    currency?: string | null;
    source?: string;
  } | null;
  trainingContext?: CookingTrainingContext;
  todayIso?: string;
}

export interface CookingConstraintIssue {
  code: string;
  severity: CookingConstraintSeverity;
  message: string;
  date?: string;
  mealId?: number;
  ingredient?: string;
  source: string;
}

export interface CookingPlanAssessment {
  status: 'ready' | 'needs_review' | 'blocked';
  confidence: 'high' | 'medium' | 'low';
  issues: CookingConstraintIssue[];
  groceryCoherence: {
    status: 'ready' | 'partial' | 'missing';
    missingIngredientNames: string[];
    pantryAvailableNames: string[];
    expiredPantryNames: string[];
  };
  scheduleFit: {
    status: 'fits' | 'tight' | 'over_capacity' | 'unknown';
    overCapacityDates: string[];
  };
  budgetFit: {
    status: 'within_budget' | 'over_budget' | 'unknown';
    estimatedBudget: number | null;
    budgetLimit: number | null;
    currency: string | null;
  };
  trainingFit: {
    status: 'supported' | 'partial' | 'missing' | 'not_applicable';
    missingTrainingDates: string[];
    hardTrainingDatesWithoutMeals: string[];
  };
}

export function assessCookingMealPlan(input: CookingPlanAssessmentInput): CookingPlanAssessment {
  const issues: CookingConstraintIssue[] = [];
  const recipesById = input.recipesById ?? new Map<number, Recipe>();
  const pantry = normalizePantry(input.pantryItems ?? [], input.todayIso ?? new Date().toISOString().slice(0, 10));
  const mealIngredients = collectMealIngredients(input.meals, recipesById);

  addRestrictionIssues(issues, input.meals, mealIngredients, input.preferences);
  const groceryCoherence = assessGroceryCoherence(input.shoppingList ?? null, mealIngredients, pantry, issues);
  const scheduleFit = assessScheduleFit(input.meals, recipesById, input.availableCookingMinutesByDate ?? {}, issues);
  const budgetFit = assessBudgetFit(input.estimatedBudget ?? null, input.preferences, input.financeBudgetContext, issues);
  const trainingFit = assessTrainingFit(input.meals, input.trainingContext, issues);
  addRepetitionIssues(issues, input.meals);
  addComplexityIssues(issues, input.meals, recipesById, input.preferences);

  const hasBlocker = issues.some((issue) => issue.severity === 'blocker');
  const hasWarning = issues.some((issue) => issue.severity === 'warning');
  const status = hasBlocker ? 'blocked' : hasWarning ? 'needs_review' : 'ready';
  const confidence = status === 'ready'
    ? 'high'
    : hasBlocker
      ? 'low'
      : 'medium';

  return {
    status,
    confidence,
    issues,
    groceryCoherence,
    scheduleFit,
    budgetFit,
    trainingFit,
  };
}

export function buildCookingPreferenceMemorySummary(preferences: CookingPreferenceProfile = {}): string {
  const lines: string[] = [];
  if (preferences.allergies?.length) lines.push(`Allergies: ${preferences.allergies.join(', ')}`);
  if (preferences.dietaryRestrictions?.length) lines.push(`Restrictions: ${preferences.dietaryRestrictions.join(', ')}`);
  if (preferences.dislikedIngredients?.length) lines.push(`Avoid: ${preferences.dislikedIngredients.join(', ')}`);
  if (preferences.preferredIngredients?.length) lines.push(`Prefer: ${preferences.preferredIngredients.join(', ')}`);
  if (preferences.weekdayMaxPrepMinutes != null) lines.push(`Weekday prep tolerance: ${preferences.weekdayMaxPrepMinutes} minutes`);
  if (preferences.budgetLimit != null) lines.push(`Grocery budget sensitivity: ${preferences.budgetLimit} ${preferences.budgetCurrency ?? 'budget units'}`);
  if (preferences.trainingDayPreference) lines.push(`Training-day fueling preference: ${preferences.trainingDayPreference}`);
  return lines.join('\n');
}

function addRestrictionIssues(
  issues: CookingConstraintIssue[],
  meals: MealPlan[],
  ingredientsByMealId: Map<number, Ingredient[]>,
  preferences?: CookingPreferenceProfile,
): void {
  const allergies = normalizeTerms(preferences?.allergies ?? []);
  const restrictions = normalizeTerms(preferences?.dietaryRestrictions ?? []);
  const dislikes = normalizeTerms(preferences?.dislikedIngredients ?? []);
  if (allergies.length === 0 && restrictions.length === 0 && dislikes.length === 0) return;

  for (const meal of meals) {
    const haystack = [
      meal.title,
      meal.notes ?? '',
      ...(ingredientsByMealId.get(meal.id) ?? []).map((ingredient) => ingredient.name),
    ].join(' | ');

    for (const allergy of allergies) {
      if (containsTerm(haystack, allergy)) {
        issues.push({
          code: 'ALLERGY_CONFLICT',
          severity: 'blocker',
          message: `Meal includes or references allergy "${allergy}".`,
          date: meal.date,
          mealId: meal.id,
          ingredient: allergy,
          source: 'cooking_preference_profile',
        });
      }
    }

    for (const restriction of restrictions) {
      if (violatesDietaryRestriction(haystack, restriction)) {
        issues.push({
          code: 'DIETARY_RESTRICTION_CONFLICT',
          severity: 'blocker',
          message: `Meal conflicts with dietary restriction "${restriction}".`,
          date: meal.date,
          mealId: meal.id,
          source: 'cooking_preference_profile',
        });
      }
    }

    for (const disliked of dislikes) {
      if (containsTerm(haystack, disliked)) {
        issues.push({
          code: 'DISLIKED_INGREDIENT',
          severity: 'warning',
          message: `Meal uses disliked ingredient "${disliked}".`,
          date: meal.date,
          mealId: meal.id,
          ingredient: disliked,
          source: 'cooking_preference_profile',
        });
      }
    }
  }
}

function assessGroceryCoherence(
  shoppingList: ShoppingList | null,
  ingredientsByMealId: Map<number, Ingredient[]>,
  pantry: Map<string, CookingPantryItem>,
  issues: CookingConstraintIssue[],
): CookingPlanAssessment['groceryCoherence'] {
  const neededNames = uniqueStrings([...ingredientsByMealId.values()].flat().map((ingredient) => normalizeName(ingredient.name)).filter(Boolean));
  const listNames = new Set((shoppingList?.items ?? []).map((item) => normalizeName(item.name)).filter(Boolean));
  const pantryAvailableNames: string[] = [];
  const expiredPantryNames: string[] = [];
  const missingIngredientNames: string[] = [];

  for (const needed of neededNames) {
    const pantryItem = pantry.get(needed);
    if (pantryItem?.status === 'expired') {
      expiredPantryNames.push(pantryItem.name);
      issues.push({
        code: 'EXPIRED_PANTRY_ITEM',
        severity: 'blocker',
        message: `Pantry item "${pantryItem.name}" appears expired and should not be used silently.`,
        ingredient: pantryItem.name,
        source: 'pantry',
      });
      continue;
    }
    if (pantryItem?.status === 'available') {
      pantryAvailableNames.push(pantryItem.name);
      continue;
    }
    if (!listNames.has(needed)) missingIngredientNames.push(needed);
  }

  if (missingIngredientNames.length > 0) {
    issues.push({
      code: 'GROCERY_LIST_MISSING_INGREDIENTS',
      severity: 'warning',
      message: 'Shopping list does not cover every planned recipe ingredient.',
      source: 'shopping_list',
    });
  }

  return {
    status: neededNames.length === 0
      ? 'missing'
      : missingIngredientNames.length === 0
        ? 'ready'
        : 'partial',
    missingIngredientNames,
    pantryAvailableNames,
    expiredPantryNames,
  };
}

function assessScheduleFit(
  meals: MealPlan[],
  recipesById: Map<number, Recipe>,
  availableByDate: Record<string, number>,
  issues: CookingConstraintIssue[],
): CookingPlanAssessment['scheduleFit'] {
  const overCapacityDates: string[] = [];
  for (const date of uniqueStrings(meals.map((meal) => meal.date))) {
    const available = availableByDate[date];
    if (available == null) continue;
    const required = meals
      .filter((meal) => meal.date === date)
      .reduce((sum, meal) => {
        const recipe = meal.recipe_id ? recipesById.get(meal.recipe_id) : null;
        return sum + (recipe?.prep_time_min ?? 0) + (recipe?.cook_time_min ?? 0);
      }, 0);
    if (required > available) {
      overCapacityDates.push(date);
      issues.push({
        code: 'COOKING_TIME_OVER_CAPACITY',
        severity: 'warning',
        message: `Planned cooking time (${required} min) exceeds available window (${available} min).`,
        date,
        source: 'secretary_schedule_context',
      });
    }
  }

  const knownDates = Object.keys(availableByDate).length;
  return {
    status: overCapacityDates.length > 0
      ? 'over_capacity'
      : knownDates > 0
        ? 'fits'
        : 'unknown',
    overCapacityDates,
  };
}

function assessBudgetFit(
  estimatedBudget: number | null,
  preferences: CookingPreferenceProfile | undefined,
  financeBudgetContext: CookingPlanAssessmentInput['financeBudgetContext'],
  issues: CookingConstraintIssue[],
): CookingPlanAssessment['budgetFit'] {
  const limit = preferences?.budgetLimit ?? financeBudgetContext?.budgetLimit ?? null;
  const currency = preferences?.budgetCurrency ?? financeBudgetContext?.currency ?? null;
  if (estimatedBudget == null && financeBudgetContext?.status === 'available' && financeBudgetContext.affordability === 'tight') {
    issues.push({
      code: 'FINANCE_BUDGET_TIGHT',
      severity: 'warning',
      message: 'Finance budget context is tight; keep grocery choices conservative or confirm a higher food budget.',
      source: financeBudgetContext.source ?? 'finance_budget_context',
    });
  }
  if (estimatedBudget == null || limit == null) {
    return {
      status: 'unknown',
      estimatedBudget,
      budgetLimit: limit,
      currency,
    };
  }
  if (estimatedBudget > limit) {
    issues.push({
      code: 'GROCERY_BUDGET_OVER_LIMIT',
      severity: 'warning',
      message: `Estimated grocery budget ${estimatedBudget} exceeds limit ${limit}.`,
      source: 'finance_budget_context',
    });
    return {
      status: 'over_budget',
      estimatedBudget,
      budgetLimit: limit,
      currency,
    };
  }
  return {
    status: 'within_budget',
    estimatedBudget,
    budgetLimit: limit,
    currency,
  };
}

function assessTrainingFit(
  meals: MealPlan[],
  trainingContext: CookingTrainingContext | undefined,
  issues: CookingConstraintIssue[],
): CookingPlanAssessment['trainingFit'] {
  const trainingDates = uniqueStrings(trainingContext?.trainingDates ?? []);
  const hardTrainingDates = uniqueStrings(trainingContext?.hardTrainingDates ?? []);
  if (trainingDates.length === 0 && hardTrainingDates.length === 0) {
    return {
      status: 'not_applicable',
      missingTrainingDates: [],
      hardTrainingDatesWithoutMeals: [],
    };
  }

  const mealDates = new Set(meals.map((meal) => meal.date));
  const missingTrainingDates = trainingDates.filter((date) => !mealDates.has(date));
  const hardTrainingDatesWithoutMeals = hardTrainingDates.filter((date) => !mealDates.has(date));

  if (hardTrainingDatesWithoutMeals.length > 0) {
    issues.push({
      code: 'HARD_TRAINING_DAY_UNSUPPORTED',
      severity: 'warning',
      message: 'A hard training day has no planned meal support.',
      date: hardTrainingDatesWithoutMeals[0],
      source: 'training_context',
    });
  }

  return {
    status: hardTrainingDatesWithoutMeals.length > 0
      ? 'missing'
      : missingTrainingDates.length > 0
        ? 'partial'
        : 'supported',
    missingTrainingDates,
    hardTrainingDatesWithoutMeals,
  };
}

function addRepetitionIssues(issues: CookingConstraintIssue[], meals: MealPlan[]): void {
  const countByTitle = new Map<string, number>();
  for (const meal of meals) {
    const key = normalizeName(meal.title);
    if (!key) continue;
    countByTitle.set(key, (countByTitle.get(key) ?? 0) + 1);
  }
  for (const [title, count] of countByTitle) {
    if (count >= 4) {
      issues.push({
        code: 'REPEATED_MEAL_WITHOUT_REASON',
        severity: 'info',
        message: `Meal "${title}" repeats ${count} times; confirm this is intentional batch cooking or reuse.`,
        source: 'meal_plan',
      });
    }
  }
}

function addComplexityIssues(
  issues: CookingConstraintIssue[],
  meals: MealPlan[],
  recipesById: Map<number, Recipe>,
  preferences?: CookingPreferenceProfile,
): void {
  const limit = preferences?.maxMealComplexityPerWeek ?? 4;
  const complexMeals = meals.filter((meal) => {
    const recipe = meal.recipe_id ? recipesById.get(meal.recipe_id) : null;
    const minutes = (recipe?.prep_time_min ?? 0) + (recipe?.cook_time_min ?? 0);
    return minutes >= 45;
  });
  if (complexMeals.length > limit) {
    issues.push({
      code: 'TOO_MANY_COMPLEX_MEALS',
      severity: 'warning',
      message: `Plan has ${complexMeals.length} high-effort meals; limit is ${limit}.`,
      source: 'cooking_preference_profile',
    });
  }
}

function collectMealIngredients(meals: MealPlan[], recipesById: Map<number, Recipe>): Map<number, Ingredient[]> {
  const result = new Map<number, Ingredient[]>();
  for (const meal of meals) {
    const recipe = meal.recipe_id ? recipesById.get(meal.recipe_id) : null;
    result.set(meal.id, recipe?.ingredients ?? []);
  }
  return result;
}

function normalizePantry(items: CookingPantryItem[], todayIso: string): Map<string, CookingPantryItem> {
  const result = new Map<string, CookingPantryItem>();
  for (const item of items) {
    const key = normalizeName(item.name);
    if (!key) continue;
    const expiredByDate = item.expiresAt ? item.expiresAt < todayIso : false;
    result.set(key, {
      ...item,
      status: item.status ?? (expiredByDate ? 'expired' : 'available'),
    });
  }
  return result;
}

function violatesDietaryRestriction(haystack: string, restriction: string): boolean {
  if (restriction === 'vegetarian') return containsAnyTerm(haystack, ['beef', 'chicken', 'pork', 'turkey', 'fish', 'salmon', 'tuna', 'shrimp']);
  if (restriction === 'vegan') return containsAnyTerm(haystack, ['beef', 'chicken', 'pork', 'turkey', 'fish', 'salmon', 'tuna', 'shrimp', 'egg', 'milk', 'cheese', 'butter', 'yogurt', 'honey']);
  if (restriction === 'gluten_free' || restriction === 'gluten-free') return containsAnyTerm(haystack, ['wheat', 'flour', 'bread', 'pasta', 'seitan']);
  return containsTerm(haystack, restriction);
}

function containsAnyTerm(haystack: string, terms: string[]): boolean {
  return terms.some((term) => containsTerm(haystack, term));
}

function containsTerm(haystack: string, term: string): boolean {
  return normalizeName(haystack).includes(normalizeName(term));
}

function normalizeTerms(values: string[]): string[] {
  return uniqueStrings(values.map(normalizeName).filter(Boolean));
}

function normalizeName(value: string): string {
  return String(value ?? '').trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
