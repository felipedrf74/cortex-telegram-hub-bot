// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Ingredient, MealPlan, Recipe, ShoppingList } from './cooking-chef';
import {
  containsCookingSafetyTerm,
  matchesCookingAllergenText,
  normalizeCookingSafetyText,
  violatesCookingDietaryRestrictionText,
} from './cooking-allergen-vocabulary';

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

export interface CookingSubstitutionSuggestion {
  originalIngredient: string;
  suggestedIngredient: string;
  reason: 'allergy' | 'dietary_restriction' | 'disliked_ingredient' | 'expired_pantry';
  cookingRole: 'protein' | 'carb' | 'fat' | 'vegetable' | 'dairy' | 'sauce' | 'seasoning' | 'unknown';
  impact: string[];
  confidence: 'high' | 'medium' | 'low';
  requiresReview: boolean;
  source: 'cooking_substitution_rules';
}

export interface CookingConstraintIssue {
  code: string;
  severity: CookingConstraintSeverity;
  message: string;
  date?: string;
  mealId?: number;
  ingredient?: string;
  source: string;
  substitutionSuggestions?: CookingSubstitutionSuggestion[];
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
  substitutionSuggestions: CookingSubstitutionSuggestion[];
}

const SUBSTITUTION_RULES: Array<{
  terms: string[];
  role: CookingSubstitutionSuggestion['cookingRole'];
  alternatives: string[];
}> = [
  { terms: ['peanut', 'peanuts', 'peanut sauce', 'peanut butter', 'amendoim', 'manteiga de amendoim'], role: 'sauce', alternatives: ['sunflower seed butter', 'roasted chickpeas'] },
  { terms: ['tree nut', 'tree nuts', 'almond', 'walnut', 'cashew', 'hazelnut', 'frutos secos', 'amêndoa', 'noz', 'caju', 'avelã'], role: 'fat', alternatives: ['sunflower seeds', 'pumpkin seeds', 'avocado'] },
  { terms: ['shellfish', 'shrimp', 'prawn', 'crab', 'lobster', 'marisco', 'camarão', 'gambas', 'caranguejo', 'lagosta'], role: 'protein', alternatives: ['tofu', 'white beans', 'chicken'] },
  { terms: ['chicken', 'turkey', 'frango', 'peru'], role: 'protein', alternatives: ['tofu', 'tempeh', 'chickpeas', 'white beans'] },
  { terms: ['beef', 'steak', 'pork', 'bacon', 'carne', 'bife', 'porco'], role: 'protein', alternatives: ['lentils', 'black beans', 'tofu', 'turkey'] },
  { terms: ['fish', 'salmon', 'tuna', 'cod', 'peixe', 'salmão', 'atum', 'bacalhau'], role: 'protein', alternatives: ['chickpeas', 'tofu', 'chicken'] },
  { terms: ['egg', 'eggs', 'ovo', 'ovos'], role: 'protein', alternatives: ['tofu scramble', 'chickpea flour'] },
  { terms: ['milk', 'cream', 'yogurt', 'leite', 'natas', 'iogurte'], role: 'dairy', alternatives: ['oat milk', 'coconut yogurt'] },
  { terms: ['cheese', 'queijo'], role: 'dairy', alternatives: ['nutritional yeast', 'avocado'] },
  { terms: ['butter', 'manteiga'], role: 'fat', alternatives: ['olive oil', 'avocado oil'] },
  { terms: ['wheat', 'flour', 'bread', 'pasta', 'trigo', 'farinha', 'pão', 'massa'], role: 'carb', alternatives: ['rice noodles', 'quinoa', 'corn tortillas'] },
  { terms: ['rice', 'arroz'], role: 'carb', alternatives: ['quinoa', 'potatoes', 'cauliflower rice'] },
  { terms: ['mushroom', 'mushrooms', 'cogumelo', 'cogumelos'], role: 'vegetable', alternatives: ['zucchini', 'eggplant', 'bell pepper'] },
];

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
  const substitutionSuggestions = collectSubstitutionSuggestions(issues);

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
    substitutionSuggestions,
  };
}

export function suggestCookingSubstitutionsForIngredient(
  originalIngredient: string,
  reason: CookingSubstitutionSuggestion['reason'],
  preferences: CookingPreferenceProfile = {},
): CookingSubstitutionSuggestion[] {
  return buildSubstitutionSuggestions(originalIngredient, reason, preferences);
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
  const allergies = uniqueStrings((preferences?.allergies ?? []).map((value) => String(value ?? '').trim()).filter(Boolean));
  const restrictions = normalizeTerms(preferences?.dietaryRestrictions ?? []);
  const dislikes = normalizeTerms(preferences?.dislikedIngredients ?? []);
  if (allergies.length === 0 && restrictions.length === 0 && dislikes.length === 0) return;

  for (const meal of meals) {
    const ingredients = ingredientsByMealId.get(meal.id) ?? [];
    const haystack = [
      meal.title,
      meal.notes ?? '',
      ...ingredients.map((ingredient) => ingredient.name),
    ].join(' | ');

    for (const allergy of allergies) {
      if (matchesCookingAllergenText(allergy, haystack)) {
        const matchedIngredient = findIngredientContainingAllergen(ingredients, allergy) ?? allergy;
        issues.push({
          code: 'ALLERGY_CONFLICT',
          severity: 'blocker',
          message: `Meal includes or references allergy "${allergy}".`,
          date: meal.date,
          mealId: meal.id,
          ingredient: matchedIngredient,
          source: 'cooking_preference_profile',
          substitutionSuggestions: buildSubstitutionSuggestions(matchedIngredient, 'allergy', preferences),
        });
      }
    }

    for (const restriction of restrictions) {
      if (violatesDietaryRestriction(haystack, restriction)) {
        const matchedIngredient = findIngredientViolatingRestriction(ingredients, restriction) ?? restriction;
        issues.push({
          code: 'DIETARY_RESTRICTION_CONFLICT',
          severity: 'blocker',
          message: `Meal conflicts with dietary restriction "${restriction}".`,
          date: meal.date,
          mealId: meal.id,
          ingredient: matchedIngredient,
          source: 'cooking_preference_profile',
          substitutionSuggestions: buildSubstitutionSuggestions(matchedIngredient, 'dietary_restriction', preferences),
        });
      }
    }

    for (const disliked of dislikes) {
      if (containsTerm(haystack, disliked)) {
        const matchedIngredient = findIngredientContainingTerm(ingredients, disliked) ?? disliked;
        issues.push({
          code: 'DISLIKED_INGREDIENT',
          severity: 'warning',
          message: `Meal uses disliked ingredient "${disliked}".`,
          date: meal.date,
          mealId: meal.id,
          ingredient: matchedIngredient,
          source: 'cooking_preference_profile',
          substitutionSuggestions: buildSubstitutionSuggestions(matchedIngredient, 'disliked_ingredient', preferences),
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
        substitutionSuggestions: buildSubstitutionSuggestions(pantryItem.name, 'expired_pantry'),
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

function buildSubstitutionSuggestions(
  originalIngredient: string,
  reason: CookingSubstitutionSuggestion['reason'],
  preferences: CookingPreferenceProfile = {},
): CookingSubstitutionSuggestion[] {
  const normalizedOriginal = normalizeName(originalIngredient);
  if (!normalizedOriginal) return [];
  const rules = SUBSTITUTION_RULES.filter((rule) => rule.terms.some((term) => containsTerm(normalizedOriginal, term)));
  // Unknown-role substitutions intentionally emit no automatic alternatives in
  // v1. If future rules add fallback candidates, the `unknown` role below keeps
  // them low-confidence and review-required before user acceptance.
  const sourceRules = rules.length > 0 ? rules : [{ terms: [normalizedOriginal], role: 'unknown' as const, alternatives: [] }];
  const suggestions: CookingSubstitutionSuggestion[] = [];

  for (const rule of sourceRules) {
    for (const alternative of rule.alternatives) {
      if (candidateConflictsWithPreferences(alternative, preferences)) continue;
      suggestions.push({
        originalIngredient,
        suggestedIngredient: alternative,
        reason,
        cookingRole: rule.role,
        impact: buildSubstitutionImpact(reason),
        confidence: rule.role === 'unknown' ? 'low' : reason === 'allergy' || reason === 'dietary_restriction' ? 'medium' : 'high',
        requiresReview: rule.role === 'unknown'
          || reason === 'allergy'
          || reason === 'dietary_restriction'
          || reason === 'expired_pantry',
        source: 'cooking_substitution_rules',
      });
      if (suggestions.length >= 3) return suggestions;
    }
  }

  return suggestions;
}

function buildSubstitutionImpact(reason: CookingSubstitutionSuggestion['reason']): string[] {
  if (reason === 'allergy') return ['allergy_safe_candidate', 'requires_review'];
  if (reason === 'dietary_restriction') return ['restriction_safe_candidate', 'requires_review'];
  if (reason === 'expired_pantry') return ['avoids_expired_pantry', 'requires_review'];
  return ['preference_fit'];
}

function candidateConflictsWithPreferences(candidate: string, preferences: CookingPreferenceProfile): boolean {
  for (const allergy of preferences.allergies ?? []) {
    if (matchesCookingAllergenText(allergy, candidate)) return true;
  }
  for (const restriction of normalizeTerms(preferences.dietaryRestrictions ?? [])) {
    if (violatesDietaryRestriction(candidate, restriction)) return true;
  }
  for (const disliked of normalizeTerms(preferences.dislikedIngredients ?? [])) {
    if (containsTerm(candidate, disliked)) return true;
  }
  return false;
}

function collectSubstitutionSuggestions(issues: CookingConstraintIssue[]): CookingSubstitutionSuggestion[] {
  const seen = new Set<string>();
  const suggestions: CookingSubstitutionSuggestion[] = [];
  for (const issue of issues) {
    for (const suggestion of issue.substitutionSuggestions ?? []) {
      const key = [
        normalizeName(suggestion.originalIngredient),
        normalizeName(suggestion.suggestedIngredient),
        suggestion.reason,
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push(suggestion);
    }
  }
  return suggestions;
}

function findIngredientContainingTerm(ingredients: Ingredient[], term: string): string | null {
  return ingredients.find((ingredient) => containsTerm(ingredient.name, term))?.name ?? null;
}

function findIngredientContainingAllergen(ingredients: Ingredient[], allergy: string): string | null {
  return ingredients.find((ingredient) => matchesCookingAllergenText(allergy, ingredient.name))?.name ?? null;
}

function findIngredientViolatingRestriction(ingredients: Ingredient[], restriction: string): string | null {
  return ingredients.find((ingredient) => violatesDietaryRestriction(ingredient.name, restriction))?.name ?? null;
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
  return violatesCookingDietaryRestrictionText(haystack, restriction);
}

function containsTerm(haystack: string, term: string): boolean {
  return containsCookingSafetyTerm(haystack, term);
}

function normalizeTerms(values: string[]): string[] {
  return uniqueStrings(values.map(normalizeName).filter(Boolean));
}

function normalizeName(value: string): string {
  return normalizeCookingSafetyText(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
