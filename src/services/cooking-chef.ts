// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cooking Chef Service
 *
 * Provides recipe management, meal planning, and shopping list generation.
 * All data is per-user via user_id.
 */

import { DateTime } from 'luxon';
import { getDb } from './database';
import { logger } from '../utils/logger';
import {
  cookingPrivateScopePredicate,
  cookingScopeForInsert,
  cookingScopeParams,
  resolveCookingTenantId,
} from './cooking-tenant-scope';
import { buildCookingPreferenceReadModel } from './cooking-preferences';
import { assertCookingSafetyText, evaluateCookingSafetyTextForProfile } from './cooking-safety-policy';
import {
  suggestCookingSubstitutionsForIngredient,
  type CookingSubstitutionSuggestion,
} from './cooking-intelligence';
import { getUserTimezoneById } from './user-service';
import { emitSkillFirstSuccess } from './product-analytics';

// ── Types ──────────────────────────────────────────────────────────

export interface Ingredient {
  name: string;
  quantity: string;
  unit: string;
}

export interface Recipe {
  id: number;
  tenant_id: number;
  user_id: number;
  owner_user_id: number;
  visibility_scope: string;
  lifecycle_state: string;
  scope_status: string;
  title: string;
  ingredients: Ingredient[];
  instructions: string | null;
  prep_time_min: number | null;
  cook_time_min: number | null;
  servings: number;
  tags: string | null;
  source: string | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  calories: number | null;
  created_at: string;
  updated_at: string;
}

export interface MealPlan {
  id: number;
  tenant_id: number;
  user_id: number;
  owner_user_id: number;
  visibility_scope: string;
  lifecycle_state: string;
  scope_status: string;
  date: string;
  meal_type: string;
  recipe_id: number | null;
  title: string;
  notes: string | null;
  created_at: string;
}

/**
 * Surface-level warning attached to a meal-plan write. Hard rejections (allergy
 * / dietary violations) still throw — `MealPlanIssue` carries the cases where
 * the slot was persisted but the user should see a confirmation prompt before
 * cooking. Plan §C9 (skill-hardening 2026-05-17) requires this for expired
 * pantry items: the slot is saved, but iOS should render a "the pantry item
 * you listed is expired — buy fresh?" interstitial.
 */
export interface MealPlanIssue {
  code: 'pantry_expired';
  ingredientName: string;
  pantryItemId: number;
  pantryFreshnessStatus: string;
  pantryExpiresAt: string | null;
  message: string;
}

export type MealPlanWriteResult = MealPlan & { issues?: MealPlanIssue[] };

export interface ShoppingList {
  id: number;
  tenant_id: number;
  user_id: number;
  owner_user_id: number;
  visibility_scope: string;
  lifecycle_state: string;
  scope_status: string;
  week_start: string;
  items: ShoppingItem[];
  status: string;
  created_at: string;
  updated_at: string;
  safetyIssues?: ShoppingListSafetyIssue[];
}

export interface ShoppingListSafetyIssue {
  code: 'ALLERGY_CONFLICT' | 'DIETARY_RESTRICTION_CONFLICT';
  itemName: string;
}

export interface ShoppingItem {
  name: string;
  quantity: string;
  unit: string;
  checked: boolean;
  aisle: string;
  pantry_status?: 'needed' | 'pantry_available' | 'pantry_expired';
  pantry_item_id?: number;
  pantry_freshness_status?: string;
  pantry_note?: string;
}

export interface PantryItem {
  id: number;
  tenant_id: number;
  user_id: number;
  owner_user_id: number;
  visibility_scope: string;
  lifecycle_state: string;
  scope_status: string;
  name: string;
  normalized_name: string;
  quantity: string | null;
  unit: string | null;
  category: string | null;
  expires_at: string | null;
  freshness_status: string;
  availability_status: string;
  source: string;
  confidence: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PantryItemInput {
  name: string;
  quantity?: string | null;
  unit?: string | null;
  category?: string | null;
  expiresAt?: string | null;
  freshnessStatus?: string | null;
  availabilityStatus?: string | null;
  source?: string | null;
  confidence?: number | null;
  notes?: string | null;
}

export type CookingSubstitutionReason =
  | 'allergy'
  | 'dietary_restriction'
  | 'disliked_ingredient'
  | 'expired_pantry';

export interface MealPlanSubstitutionInput {
  date: string;
  mealType: string;
  originalIngredient: string;
  suggestedIngredient: string;
  reason: CookingSubstitutionReason;
  updateShoppingList?: boolean;
}

export interface MealPlanSubstitutionSuggestionInput {
  date: string;
  mealType: string;
  originalIngredient: string;
  reason?: CookingSubstitutionReason;
}

export interface MealPlanSubstitutionSuggestionResult {
  found: boolean;
  reason?: 'meal_not_found' | 'recipe_not_found' | 'ingredient_not_found';
  meal: MealPlan | null;
  recipe: Recipe | null;
  suggestions: CookingSubstitutionSuggestion[];
  originalIngredient: string;
}

export interface MealPlanSubstitutionResult {
  applied: boolean;
  reason?: 'meal_not_found' | 'recipe_not_found' | 'ingredient_not_found';
  meal: MealPlan | null;
  recipe: Recipe | null;
  shoppingList: ShoppingList | null;
  substitution: {
    originalIngredient: string;
    suggestedIngredient: string;
    reason: CookingSubstitutionReason;
    affectedMealId?: number;
    affectedRecipeId?: number;
    sourceRecipeId?: number;
    shoppingListUpdated: boolean;
    appliedAt: string;
  };
}

export class CookingRecipeDeleteConflictError extends Error {
  readonly code = 'COOKING_RECIPE_IN_USE';

  constructor(readonly recipeId: number) {
    super('COOKING_RECIPE_IN_USE: recipe is referenced by an active meal plan');
    this.name = 'CookingRecipeDeleteConflictError';
  }
}

// ── Recipe CRUD ────────────────────────────────────────────────────

function getCookingDb() {
  return getDb();
}

export function addRecipe(
  userId: number,
  title: string,
  ingredients: Ingredient[],
  opts?: {
    instructions?: string;
    prepTime?: number;
    cookTime?: number;
    servings?: number;
    tags?: string;
    source?: string;
    protein?: number | null;
    fat?: number | null;
    carbs?: number | null;
    calories?: number | null;
    tenantId?: number | null;
  },
): Recipe {
  const db = getCookingDb();
  const normalizedTitle = normalizeRecipeTitle(title);
  const normalizedIngredients = normalizeRecipeIngredients(ingredients);
  validateRecipeOptionalText(opts?.instructions, 'instructions');
  validateRecipeOptionalText(opts?.tags, 'tags');
  validateRecipeOptionalText(opts?.source, 'source');
  validateRecipeNonNegativeInteger(opts?.prepTime, 'prepTime');
  validateRecipeNonNegativeInteger(opts?.cookTime, 'cookTime');
  validateRecipeServings(opts?.servings);
  validateRecipeNutrition(opts?.protein, 'protein');
  validateRecipeNutrition(opts?.fat, 'fat');
  validateRecipeNutrition(opts?.carbs, 'carbs');
  validateRecipeNutrition(opts?.calories, 'calories');
  const scope = cookingScopeForInsert(userId, opts?.tenantId, 'user_private', 'active');
  assertCookingSafeRecipe(userId, scope.tenantId, {
    title: normalizedTitle,
    ingredients: normalizedIngredients,
    instructions: opts?.instructions,
    tags: opts?.tags,
    source: opts?.source,
  });
  db.prepare(`
    INSERT INTO recipes (
      tenant_id, user_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
      created_by, updated_by, audit_metadata_json,
      title, ingredients, instructions, prep_time_min, cook_time_min,
      servings, tags, source, protein_g, fat_g, carbs_g, calories_kcal
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scope.tenantId,
    userId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.lifecycleState,
    scope.scopeStatus,
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
    normalizedTitle, JSON.stringify(normalizedIngredients),
    opts?.instructions ?? null,
    opts?.prepTime ?? null,
    opts?.cookTime ?? null,
    opts?.servings ?? 1,
    opts?.tags ?? null,
    opts?.source ?? null,
    opts?.protein ?? null,
    opts?.fat ?? null,
    opts?.carbs ?? null,
    opts?.calories ?? null,
  );
  const row = db.prepare('SELECT * FROM recipes WHERE rowid = last_insert_rowid()').get() as any;
  logger.info({ userId, title: normalizedTitle }, 'Recipe added');
  return parseRecipe(row);
}

export function getRecipes(
  userId: number,
  opts?: { tags?: string; search?: string; limit?: number; tenantId?: number | null },
): Recipe[] {
  const db = getCookingDb();
  const conditions = [cookingPrivateScopePredicate()];
  const params: any[] = cookingScopeParams(userId, opts?.tenantId);

  if (opts?.tags) {
    conditions.push("tags LIKE ?");
    params.push(`%${opts.tags}%`);
  }
  if (opts?.search) {
    conditions.push("(title LIKE ? OR ingredients LIKE ?)");
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }

  const limit = normalizeCookingReadLimit(opts?.limit, 20, 100, 'COOKING_RECIPE_INVALID_LIMIT');
  params.push(limit);

  const rows = db.prepare(
    `SELECT * FROM recipes WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
  ).all(...params) as any[];

  return rows.map(parseRecipe);
}

/**
 * Returns false when the scoped recipe does not exist. A recipe that exists
 * but is still referenced is a distinct conflict so HTTP/tool adapters can
 * return an actionable response instead of misreporting it as missing.
 */
export function deleteRecipe(userId: number, recipeId: number, tenantId?: number | null): boolean {
  const db = getCookingDb();
  const scopeParams = cookingScopeParams(userId, tenantId);
  const todayIso = cookingTodayIso(userId);
  return db.transaction(() => {
    const recipe = db.prepare(
      `SELECT id FROM recipes WHERE id = ? AND ${cookingPrivateScopePredicate()}`,
    ).get(recipeId, ...scopeParams) as { id: number } | undefined;
    if (!recipe) return false;

    const activeReference = db.prepare(
      `SELECT id
       FROM meal_plans
       WHERE recipe_id = ?
         AND date >= ?
         AND ${cookingPrivateScopePredicate()}
       LIMIT 1`,
    ).get(recipeId, todayIso, ...scopeParams) as { id: number } | undefined;
    if (activeReference) throw new CookingRecipeDeleteConflictError(recipeId);

    // Historical meal records keep their title and notes, but no longer pin a
    // deleted recipe forever or retain a dangling foreign-key reference.
    db.prepare(
      `UPDATE meal_plans
       SET recipe_id = NULL, updated_by = ?
       WHERE recipe_id = ?
         AND date < ?
         AND ${cookingPrivateScopePredicate()}`,
    ).run(userId, recipeId, todayIso, ...scopeParams);

    const result = db.prepare(
      `DELETE FROM recipes WHERE id = ? AND ${cookingPrivateScopePredicate()}`,
    ).run(recipeId, ...scopeParams);
    return result.changes > 0;
  })();
}

/**
 * Fetch a single recipe by id, scoped to user_id. Returns null
 * if not found or owned by another user.
 */
export function getRecipeById(userId: number, recipeId: number, tenantId?: number | null): Recipe | null {
  const db = getCookingDb();
  const row = db.prepare(
    `SELECT * FROM recipes WHERE id = ? AND ${cookingPrivateScopePredicate()}`,
  ).get(recipeId, ...cookingScopeParams(userId, tenantId)) as any;
  return row ? parseRecipe(row) : null;
}

/**
 * Partial update — only the fields present in `updates` are written.
 * Ingredients arrays are serialized to JSON before persisting (same
 * convention as addRecipe). Returns the updated row, or null if no
 * row matched (wrong id or cross-user write attempt).
 *
 * Always bumps updated_at on any successful write — drives the
 * "most recently edited" sort order that `getRecipes` uses.
 */
export function updateRecipe(
  userId: number,
  recipeId: number,
  updates: {
    title?: string;
    ingredients?: Ingredient[];
    instructions?: string | null;
    prepTime?: number | null;
    cookTime?: number | null;
    servings?: number;
    tags?: string | null;
    source?: string | null;
    protein?: number | null;
    fat?: number | null;
    carbs?: number | null;
    calories?: number | null;
  },
  tenantId?: number | null,
): Recipe | null {
  const db = getCookingDb();
  const current = getRecipeById(userId, recipeId, tenantId);
  if (!current) return null;
  const normalizedTitle = updates.title === undefined
    ? undefined
    : normalizeRecipeTitle(updates.title);
  const normalizedIngredients = updates.ingredients === undefined
    ? undefined
    : normalizeRecipeIngredients(updates.ingredients);
  validateRecipeOptionalText(updates.instructions, 'instructions');
  validateRecipeOptionalText(updates.tags, 'tags');
  validateRecipeOptionalText(updates.source, 'source');
  validateRecipeNonNegativeInteger(updates.prepTime, 'prepTime');
  validateRecipeNonNegativeInteger(updates.cookTime, 'cookTime');
  validateRecipeServings(updates.servings);
  validateRecipeNutrition(updates.protein, 'protein');
  validateRecipeNutrition(updates.fat, 'fat');
  validateRecipeNutrition(updates.carbs, 'carbs');
  validateRecipeNutrition(updates.calories, 'calories');
  assertCookingSafeRecipe(userId, resolveCookingTenantId(userId, tenantId), {
    title: normalizedTitle ?? current.title,
    ingredients: normalizedIngredients ?? current.ingredients,
    instructions: updates.instructions === undefined ? current.instructions : updates.instructions,
    tags: updates.tags === undefined ? current.tags : updates.tags,
    source: updates.source === undefined ? current.source : updates.source,
  });

  // Build the SET clause dynamically so we only touch fields the
  // caller actually wants to change.
  const setParts: string[] = [];
  const params: any[] = [];

  if (updates.title !== undefined) {
    setParts.push('title = ?');
    params.push(normalizedTitle);
  }
  if (updates.ingredients !== undefined) {
    setParts.push('ingredients = ?');
    params.push(JSON.stringify(normalizedIngredients));
  }
  if (updates.instructions !== undefined) {
    setParts.push('instructions = ?');
    params.push(updates.instructions);
  }
  if (updates.prepTime !== undefined) {
    setParts.push('prep_time_min = ?');
    params.push(updates.prepTime);
  }
  if (updates.cookTime !== undefined) {
    setParts.push('cook_time_min = ?');
    params.push(updates.cookTime);
  }
  if (updates.servings !== undefined) {
    setParts.push('servings = ?');
    params.push(updates.servings);
  }
  if (updates.tags !== undefined) {
    setParts.push('tags = ?');
    params.push(updates.tags);
  }
  if (updates.source !== undefined) {
    setParts.push('source = ?');
    params.push(updates.source);
  }
  if (updates.protein !== undefined) {
    setParts.push('protein_g = ?');
    params.push(updates.protein);
  }
  if (updates.fat !== undefined) {
    setParts.push('fat_g = ?');
    params.push(updates.fat);
  }
  if (updates.carbs !== undefined) {
    setParts.push('carbs_g = ?');
    params.push(updates.carbs);
  }
  if (updates.calories !== undefined) {
    setParts.push('calories_kcal = ?');
    params.push(updates.calories);
  }

  if (setParts.length > 0) {
    setParts.push("updated_at = datetime('now')");
    setParts.push('updated_by = ?');
    params.push(userId);
    const sql = `UPDATE recipes SET ${setParts.join(', ')} WHERE id = ? AND ${cookingPrivateScopePredicate()}`;
    params.push(recipeId, ...cookingScopeParams(userId, tenantId));
    const result = db.prepare(sql).run(...params);
    if (result.changes === 0) return null;
    logger.info({ userId, recipeId }, 'Recipe updated');
  }

  return getRecipeById(userId, recipeId, tenantId);
}

// ── Meal Planning ──────────────────────────────────────────────────

export function setMealPlan(
  userId: number,
  date: string,
  mealType: string,
  title: string,
  opts?: { recipeId?: number; notes?: string; tenantId?: number | null },
): MealPlanWriteResult {
  const db = getCookingDb();
  const normalizedDate = normalizeIsoDate(date, 'COOKING_MEAL_PLAN_INVALID_DATE', 'date');
  const normalizedMealType = normalizeMealType(mealType);
  const normalizedTitle = normalizeMealPlanTitle(title);
  if (opts?.notes !== undefined && typeof opts.notes !== 'string') {
    throw new Error('COOKING_MEAL_PLAN_INVALID_NOTES: notes must be a string when provided');
  }
  const scope = cookingScopeForInsert(userId, opts?.tenantId, 'user_private', 'planned');
  const requestedRecipeId = opts?.recipeId;
  if (requestedRecipeId !== undefined && requestedRecipeId !== null
      && (!Number.isInteger(requestedRecipeId) || requestedRecipeId <= 0)) {
    throw new Error('COOKING_MEAL_PLAN_INVALID_RECIPE_ID: recipeId must be a positive integer');
  }
  const linkedRecipe = requestedRecipeId === undefined || requestedRecipeId === null
    ? null
    : getRecipeById(userId, requestedRecipeId, opts?.tenantId);
  if (requestedRecipeId !== undefined && requestedRecipeId !== null && !linkedRecipe) {
    throw new Error('COOKING_MEAL_PLAN_RECIPE_NOT_FOUND: recipeId must reference an active recipe in the current scope');
  }
  if (linkedRecipe) {
    assertCookingSafeRecipe(userId, scope.tenantId, linkedRecipe);
  }
  assertCookingSafetyText(userId, scope.tenantId, 'meal_plan', [
    normalizedTitle,
    opts?.notes,
  ]);

  // C9 / skill-hardening 2026-05-17: surface expired-pantry warnings to the
  // caller. The slot still gets persisted (the user explicitly asked to
  // schedule it); the issue list lets iOS prompt for confirmation before
  // cook-time. Allergy/dietary violations remain hard throws above.
  const issues: MealPlanIssue[] = [];
  if (linkedRecipe && Array.isArray(linkedRecipe.ingredients) && linkedRecipe.ingredients.length > 0) {
    const pantryByName = new Map(
      getPantryItems(userId, { tenantId: opts?.tenantId, includeExpired: true, limit: 250 })
        .map((item) => [item.normalized_name, item] as const),
    );
    for (const ingredient of linkedRecipe.ingredients) {
      if (!ingredient || typeof ingredient.name !== 'string') continue;
      const pantryMatch = pantryByName.get(normalizePantryName(ingredient.name));
      if (pantryMatch && pantryMatch.freshness_status === 'expired') {
        issues.push({
          code: 'pantry_expired',
          ingredientName: ingredient.name,
          pantryItemId: pantryMatch.id,
          pantryFreshnessStatus: pantryMatch.freshness_status,
          pantryExpiresAt: pantryMatch.expires_at,
          message: `Pantry item "${pantryMatch.name}" is expired — verify before cooking or replace from shopping list.`,
        });
      }
    }
  }
  const existingScope = db.prepare(
    'SELECT tenant_id FROM meal_plans WHERE tenant_id = ? AND user_id = ? AND date = ? AND meal_type = ?',
  ).get(scope.tenantId, userId, normalizedDate, normalizedMealType) as { tenant_id: number | null } | undefined;
  if (existingScope && Number(existingScope.tenant_id) !== scope.tenantId) {
    throw new Error('COOKING_SCOPE_CONFLICT: meal plan slot belongs to a different tenant');
  }
  db.prepare(`
    INSERT INTO meal_plans (
      tenant_id, user_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
      created_by, updated_by, audit_metadata_json,
      date, meal_type, recipe_id, title, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, date, meal_type) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      owner_user_id = excluded.owner_user_id,
      visibility_scope = excluded.visibility_scope,
      lifecycle_state = excluded.lifecycle_state,
      scope_status = excluded.scope_status,
      updated_by = excluded.updated_by,
      audit_metadata_json = excluded.audit_metadata_json,
      recipe_id = excluded.recipe_id,
      title = excluded.title,
      notes = excluded.notes
  `).run(
    scope.tenantId,
    userId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.lifecycleState,
    scope.scopeStatus,
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
    normalizedDate,
    normalizedMealType,
    linkedRecipe?.id ?? null,
    normalizedTitle,
    opts?.notes ?? null,
  );

  const persisted = db.prepare(
    `SELECT * FROM meal_plans WHERE date = ? AND meal_type = ? AND ${cookingPrivateScopePredicate()}`,
  ).get(normalizedDate, normalizedMealType, ...cookingScopeParams(userId, opts?.tenantId)) as MealPlan;

  emitSkillFirstSuccess(userId, 'cooking');
  return issues.length > 0 ? { ...persisted, issues } : persisted;
}

export function getMealPlan(userId: number, startDate: string, endDate: string, tenantId?: number | null): MealPlan[] {
  const db = getCookingDb();
  const normalizedStartDate = normalizeIsoDate(startDate, 'COOKING_MEAL_PLAN_INVALID_DATE', 'startDate');
  const normalizedEndDate = normalizeIsoDate(endDate, 'COOKING_MEAL_PLAN_INVALID_DATE', 'endDate');
  if (normalizedStartDate > normalizedEndDate) {
    throw new Error('COOKING_MEAL_PLAN_INVALID_DATE_RANGE: startDate must not be after endDate');
  }
  return db.prepare(
    `SELECT * FROM meal_plans WHERE ${cookingPrivateScopePredicate()} AND date >= ? AND date <= ? ORDER BY date, meal_type`,
  ).all(...cookingScopeParams(userId, tenantId), normalizedStartDate, normalizedEndDate) as MealPlan[];
}

export function deleteMealPlan(userId: number, date: string, mealType: string, tenantId?: number | null): boolean {
  const db = getCookingDb();
  const normalizedDate = normalizeIsoDate(date, 'COOKING_MEAL_PLAN_INVALID_DATE', 'date');
  const normalizedMealType = normalizeMealType(mealType);
  const result = db.prepare(
    `DELETE FROM meal_plans WHERE date = ? AND meal_type = ? AND ${cookingPrivateScopePredicate()}`,
  ).run(normalizedDate, normalizedMealType, ...cookingScopeParams(userId, tenantId));
  return result.changes > 0;
}

export function applyMealPlanSubstitution(
  userId: number,
  input: MealPlanSubstitutionInput,
  tenantId?: number | null,
): MealPlanSubstitutionResult {
  const normalizedDate = normalizeIsoDate(input.date, 'COOKING_SUBSTITUTION_INVALID_DATE', 'date');
  const normalizedMealType = normalizeMealType(input.mealType, 'COOKING_SUBSTITUTION_INVALID_MEAL_TYPE');
  const originalIngredient = normalizeRequiredText(input.originalIngredient, 'originalIngredient');
  const suggestedIngredient = normalizeRequiredText(input.suggestedIngredient, 'suggestedIngredient');
  if (normalizePantryName(originalIngredient) === normalizePantryName(suggestedIngredient)) {
    throw new Error('COOKING_SUBSTITUTION_NOOP: suggestedIngredient must differ from originalIngredient');
  }
  const resolvedTenantId = resolveCookingTenantId(userId, tenantId);
  assertCookingSafetyText(userId, resolvedTenantId, 'meal_plan_substitution', [suggestedIngredient]);

  const meals = getMealPlan(userId, normalizedDate, normalizedDate, tenantId);
  const meal = meals.find((candidate) => candidate.meal_type === normalizedMealType) ?? null;
  const baseSubstitution = {
    originalIngredient,
    suggestedIngredient,
    reason: input.reason,
    shoppingListUpdated: false,
    appliedAt: new Date().toISOString(),
  };
  if (!meal) {
    return {
      applied: false,
      reason: 'meal_not_found',
      meal: null,
      recipe: null,
      shoppingList: null,
      substitution: baseSubstitution,
    };
  }
  if (!meal.recipe_id) {
    return {
      applied: false,
      reason: 'recipe_not_found',
      meal,
      recipe: null,
      shoppingList: null,
      substitution: { ...baseSubstitution, affectedMealId: meal.id },
    };
  }

  const recipe = getRecipeById(userId, meal.recipe_id, tenantId);
  if (!recipe) {
    return {
      applied: false,
      reason: 'recipe_not_found',
      meal,
      recipe: null,
      shoppingList: null,
      substitution: { ...baseSubstitution, affectedMealId: meal.id },
    };
  }

  let ingredientChanged = false;
  const updatedIngredients = recipe.ingredients.map((ingredient) => {
    if (!ingredientNameMatches(ingredient.name, originalIngredient)) return ingredient;
    ingredientChanged = true;
    return { ...ingredient, name: suggestedIngredient };
  });

  if (!ingredientChanged) {
    return {
      applied: false,
      reason: 'ingredient_not_found',
      meal,
      recipe,
      shoppingList: null,
      substitution: {
        ...baseSubstitution,
        affectedMealId: meal.id,
        affectedRecipeId: recipe.id,
      },
    };
  }

  const shoppingWeekStart = input.updateShoppingList === false
    ? null
    : weekStartForDate(normalizedDate);
  const db = getCookingDb();

  return db.transaction((): MealPlanSubstitutionResult => {
    const updatedRecipe = addRecipe(userId, replaceIngredientText(recipe.title, originalIngredient, suggestedIngredient), updatedIngredients, {
      instructions: recipe.instructions == null
        ? undefined
        : replaceIngredientText(recipe.instructions, originalIngredient, suggestedIngredient),
      prepTime: recipe.prep_time_min ?? undefined,
      cookTime: recipe.cook_time_min ?? undefined,
      servings: recipe.servings,
      tags: recipe.tags ?? undefined,
      source: recipe.source ?? undefined,
      protein: recipe.protein,
      fat: recipe.fat,
      carbs: recipe.carbs,
      calories: recipe.calories,
      tenantId,
    });
    const updatedMeal = setMealPlan(userId, meal.date, meal.meal_type, replaceIngredientText(meal.title, originalIngredient, suggestedIngredient), {
      recipeId: updatedRecipe.id,
      notes: meal.notes == null ? undefined : replaceIngredientText(meal.notes, originalIngredient, suggestedIngredient),
      tenantId,
    });
    const shoppingList = shoppingWeekStart == null
      ? null
      : generateShoppingList(userId, shoppingWeekStart, tenantId);

    return {
      applied: true,
      meal: updatedMeal,
      recipe: updatedRecipe,
      shoppingList,
      substitution: {
        ...baseSubstitution,
        affectedMealId: meal.id,
        sourceRecipeId: recipe.id,
        affectedRecipeId: updatedRecipe.id,
        shoppingListUpdated: Boolean(shoppingList),
      },
    };
  })();
}

export function suggestMealPlanSubstitutions(
  userId: number,
  input: MealPlanSubstitutionSuggestionInput,
  tenantId?: number | null,
): MealPlanSubstitutionSuggestionResult {
  const normalizedDate = normalizeIsoDate(input.date, 'COOKING_SUBSTITUTION_INVALID_DATE', 'date');
  const normalizedMealType = normalizeMealType(input.mealType, 'COOKING_SUBSTITUTION_INVALID_MEAL_TYPE');
  const originalIngredient = normalizeRequiredText(input.originalIngredient, 'originalIngredient');
  const reason = input.reason ?? 'disliked_ingredient';
  const meals = getMealPlan(userId, normalizedDate, normalizedDate, tenantId);
  const meal = meals.find((candidate) => candidate.meal_type === normalizedMealType) ?? null;
  if (!meal) {
    return {
      found: false,
      reason: 'meal_not_found',
      meal: null,
      recipe: null,
      suggestions: [],
      originalIngredient,
    };
  }
  if (!meal.recipe_id) {
    return {
      found: false,
      reason: 'recipe_not_found',
      meal,
      recipe: null,
      suggestions: [],
      originalIngredient,
    };
  }
  const recipe = getRecipeById(userId, meal.recipe_id, tenantId);
  if (!recipe) {
    return {
      found: false,
      reason: 'recipe_not_found',
      meal,
      recipe: null,
      suggestions: [],
      originalIngredient,
    };
  }
  const ingredient = recipe.ingredients.find((candidate) => ingredientNameMatches(candidate.name, originalIngredient));
  if (!ingredient) {
    return {
      found: false,
      reason: 'ingredient_not_found',
      meal,
      recipe,
      suggestions: [],
      originalIngredient,
    };
  }
  const preferences = buildCookingPreferenceReadModel(userId, tenantId).profile;
  return {
    found: true,
    meal,
    recipe,
    suggestions: suggestCookingSubstitutionsForIngredient(ingredient.name, reason, preferences),
    originalIngredient: ingredient.name,
  };
}

// ── Pantry ─────────────────────────────────────────────────────────

export function upsertPantryItem(userId: number, input: PantryItemInput, tenantId?: number | null): PantryItem {
  const db = getCookingDb();
  validatePantryWriteInput(input);
  const todayIso = cookingTodayIso(userId);
  const name = normalizeRequiredText(input.name, 'name');
  const normalizedName = normalizePantryName(name);
  const expiresAt = normalizePantryExpiry(input.expiresAt);
  const scope = cookingScopeForInsert(userId, tenantId, 'user_private', 'available');
  const existing = db.prepare(
    `SELECT id FROM cooking_pantry_items WHERE normalized_name = ? AND ${cookingPrivateScopePredicate()}`,
  ).get(normalizedName, ...cookingScopeParams(userId, tenantId)) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE cooking_pantry_items
      SET
        name = ?,
        quantity = ?,
        unit = ?,
        category = ?,
        expires_at = ?,
        freshness_status = ?,
        availability_status = ?,
        source = ?,
        confidence = ?,
        notes = ?,
        lifecycle_state = ?,
        updated_by = ?,
        updated_at = datetime('now')
      WHERE id = ? AND ${cookingPrivateScopePredicate()}
    `).run(
      name,
      cleanNullableText(input.quantity),
      cleanNullableText(input.unit),
      cleanNullableText(input.category),
      expiresAt,
      normalizePantryFreshness(input.freshnessStatus, expiresAt, todayIso),
      normalizePantryAvailability(input.availabilityStatus),
      cleanNullableText(input.source) ?? 'manual',
      normalizeConfidence(input.confidence),
      cleanNullableText(input.notes),
      normalizePantryAvailability(input.availabilityStatus) === 'available' ? 'available' : 'unavailable',
      userId,
      existing.id,
      ...cookingScopeParams(userId, tenantId),
    );
    return getPantryItemById(userId, existing.id, tenantId)!;
  }

  db.prepare(`
    INSERT INTO cooking_pantry_items (
      tenant_id, user_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
      created_by, updated_by, audit_metadata_json,
      name, normalized_name, quantity, unit, category, expires_at, freshness_status,
      availability_status, source, confidence, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scope.tenantId,
    userId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.lifecycleState,
    scope.scopeStatus,
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
    name,
    normalizedName,
    cleanNullableText(input.quantity),
    cleanNullableText(input.unit),
    cleanNullableText(input.category),
    expiresAt,
    normalizePantryFreshness(input.freshnessStatus, expiresAt, todayIso),
    normalizePantryAvailability(input.availabilityStatus),
    cleanNullableText(input.source) ?? 'manual',
    normalizeConfidence(input.confidence),
    cleanNullableText(input.notes),
  );

  const row = db.prepare(
    `SELECT * FROM cooking_pantry_items WHERE normalized_name = ? AND ${cookingPrivateScopePredicate()}`,
  ).get(normalizedName, ...cookingScopeParams(userId, tenantId)) as any;
  logger.info({ userId, tenantId: scope.tenantId, pantryItemId: row?.id }, 'Cooking pantry item upserted');
  return parsePantryItem(row, todayIso);
}

export function getPantryItems(
  userId: number,
  opts?: {
    tenantId?: number | null;
    search?: string;
    category?: string;
    includeExpired?: boolean;
    limit?: number;
  },
): PantryItem[] {
  const db = getCookingDb();
  const todayIso = cookingTodayIso(userId);
  const effectiveFreshness = effectivePantryFreshnessSql(todayIso);
  const conditions = [cookingPrivateScopePredicate(), "COALESCE(availability_status, 'available') != 'removed'"];
  const params: any[] = cookingScopeParams(userId, opts?.tenantId);

  if (opts?.search?.trim()) {
    conditions.push('(name LIKE ? OR notes LIKE ?)');
    const search = `%${opts.search.trim()}%`;
    params.push(search, search);
  }
  if (opts?.category?.trim()) {
    conditions.push('category = ?');
    params.push(opts.category.trim());
  }
  if (!opts?.includeExpired) {
    conditions.push(`(${effectiveFreshness}) != 'expired'`);
  }

  const limit = normalizeCookingReadLimit(opts?.limit, 100, 250, 'COOKING_PANTRY_INVALID_LIMIT');
  params.push(limit);

  const rows = db.prepare(`
    SELECT *, (${effectiveFreshness}) AS effective_freshness_status
    FROM cooking_pantry_items
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE (${effectiveFreshness})
        WHEN 'use_soon' THEN 0
        WHEN 'unknown' THEN 1
        WHEN 'fresh' THEN 2
        ELSE 3
      END,
      updated_at DESC,
      name ASC
    LIMIT ?
  `).all(...params) as any[];
  return rows.map((row) => parsePantryItem(row, todayIso));
}

export function getPantryItemById(userId: number, itemId: number, tenantId?: number | null): PantryItem | null {
  const db = getCookingDb();
  const row = db.prepare(
    `SELECT * FROM cooking_pantry_items WHERE id = ? AND ${cookingPrivateScopePredicate()} AND COALESCE(availability_status, 'available') != 'removed'`,
  ).get(itemId, ...cookingScopeParams(userId, tenantId)) as any;
  return row ? parsePantryItem(row, cookingTodayIso(userId)) : null;
}

export function updatePantryItem(
  userId: number,
  itemId: number,
  updates: Partial<PantryItemInput>,
  tenantId?: number | null,
): PantryItem | null {
  const db = getCookingDb();
  validatePantryWriteInput(updates, true);
  const todayIso = cookingTodayIso(userId);
  const existingRow = db.prepare(
    `SELECT * FROM cooking_pantry_items
     WHERE id = ?
       AND ${cookingPrivateScopePredicate()}
       AND COALESCE(availability_status, 'available') != 'removed'`,
  ).get(itemId, ...cookingScopeParams(userId, tenantId)) as any;
  if (!existingRow) return null;
  const existing = parsePantryItem(existingRow, todayIso);

  const name = updates.name !== undefined ? normalizeRequiredText(updates.name, 'name') : existing.name;
  const setParts = [
    'name = ?',
    'normalized_name = ?',
    'quantity = ?',
    'unit = ?',
    'category = ?',
    'expires_at = ?',
    'freshness_status = ?',
    'availability_status = ?',
    'source = ?',
    'confidence = ?',
    'notes = ?',
    "updated_at = datetime('now')",
    'updated_by = ?',
  ];
  const expiresAt = updates.expiresAt !== undefined
    ? normalizePantryExpiry(updates.expiresAt)
    : existing.expires_at;
  const freshnessStatus = updates.freshnessStatus !== undefined || updates.expiresAt !== undefined
    ? normalizePantryFreshness(updates.freshnessStatus, expiresAt, todayIso)
    : existingRow.freshness_status;
  const availability = normalizePantryAvailability(updates.availabilityStatus ?? existing.availability_status);
  const params = [
    name,
    normalizePantryName(name),
    updates.quantity !== undefined ? cleanNullableText(updates.quantity) : existing.quantity,
    updates.unit !== undefined ? cleanNullableText(updates.unit) : existing.unit,
    updates.category !== undefined ? cleanNullableText(updates.category) : existing.category,
    expiresAt,
    freshnessStatus,
    availability,
    updates.source !== undefined ? cleanNullableText(updates.source) ?? 'manual' : existing.source,
    updates.confidence !== undefined ? normalizeConfidence(updates.confidence) : existing.confidence,
    updates.notes !== undefined ? cleanNullableText(updates.notes) : existing.notes,
    userId,
    itemId,
    ...cookingScopeParams(userId, tenantId),
  ];

  const result = db.prepare(`
    UPDATE cooking_pantry_items
    SET ${setParts.join(', ')}
    WHERE id = ? AND ${cookingPrivateScopePredicate()}
  `).run(...params);
  if (result.changes === 0) return null;
  return getPantryItemById(userId, itemId, tenantId);
}

export function deletePantryItem(userId: number, itemId: number, tenantId?: number | null): boolean {
  const db = getCookingDb();
  const result = db.prepare(`
    UPDATE cooking_pantry_items
    SET scope_status = 'deleted',
        availability_status = 'removed',
        lifecycle_state = 'archived',
        updated_by = ?,
        updated_at = datetime('now')
    WHERE id = ? AND ${cookingPrivateScopePredicate()}
  `).run(userId, itemId, ...cookingScopeParams(userId, tenantId));
  return result.changes > 0;
}

// ── Shopping List ──────────────────────────────────────────────────

export function generateShoppingList(userId: number, weekStart: string, tenantId?: number | null): ShoppingList {
  const db = getCookingDb();
  const normalizedWeekStart = normalizeWeekStart(weekStart);
  const scope = cookingScopeForInsert(userId, tenantId, 'user_private', 'active');
  let safetyProfile: ReturnType<typeof buildCookingPreferenceReadModel>['profile'];
  try {
    safetyProfile = buildCookingPreferenceReadModel(userId, scope.tenantId).profile;
  } catch {
    throw new Error('COOKING_SAFETY_BLOCKED: shopping list safety profile unavailable');
  }

  // Calculate week end (7 days)
  const start = new Date(`${normalizedWeekStart}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 6 * 86400_000);
  const endDate = end.toISOString().slice(0, 10);

  // Get all meal plans for the week
  const meals = getMealPlan(userId, normalizedWeekStart, endDate, tenantId);

  // Aggregate ingredients from linked recipes
  const itemMap = new Map<string, ShoppingItem>();
  const quantityMap = new Map<string, NormalizedQuantity>();
  const safetyIssues: ShoppingListSafetyIssue[] = [];
  const safetyIssueKeys = new Set<string>();
  const existing = getShoppingList(userId, normalizedWeekStart, tenantId);
  const pantryByName = new Map(
    getPantryItems(userId, { tenantId, includeExpired: true, limit: 250 })
      .map((item) => [item.normalized_name, item]),
  );
  const checkedByKey = new Map(
    (existing?.items ?? []).map((item) => [item.name.toLowerCase(), item.checked]),
  );

  for (const meal of meals) {
    if (meal.recipe_id) {
      const recipe = db.prepare(
        `SELECT title, ingredients, instructions, tags, source FROM recipes WHERE id = ? AND ${cookingPrivateScopePredicate()}`,
      ).get(meal.recipe_id, ...cookingScopeParams(userId, tenantId)) as any;
      if (recipe) {
        const ingredients: Ingredient[] = JSON.parse(recipe.ingredients);
        const safety = evaluateCookingSafetyTextForProfile(safetyProfile, 'shopping_list', [
          meal.title,
          recipe.title,
          recipe.instructions,
          recipe.tags,
          recipe.source,
          ...ingredients.flatMap((ingredient) => [ingredient.name, ingredient.quantity, ingredient.unit]),
        ]);
        if (safety.blocked) {
          for (const issue of safety.issues) {
            if (issue.code === 'SAFETY_PROFILE_UNAVAILABLE') continue;
            const key = `${issue.code}:${recipe.title}`;
            if (safetyIssueKeys.has(key)) continue;
            safetyIssueKeys.add(key);
            safetyIssues.push({ code: issue.code, itemName: recipe.title });
          }
          continue;
        }
        for (const ing of ingredients) {
          const key = ing.name.toLowerCase();
          const existing = itemMap.get(key);
          if (existing) {
            const merged = mergeIngredientQuantity(quantityMap.get(key), ing);
            if (merged) {
              quantityMap.set(key, merged);
              const display = formatNormalizedQuantity(merged);
              existing.quantity = display.quantity;
              existing.unit = display.unit;
            } else {
              // Once quantities from incompatible families (or unparseable
              // units) are rendered as a compound expression, the normalized
              // accumulator is no longer authoritative. Leaving it in the map
              // lets a later compatible quantity overwrite and silently drop
              // the compound amount.
              quantityMap.delete(key);
              existing.quantity = appendQuantity(existing, ing);
              existing.unit = '';
            }
          } else {
            const normalizedQuantity = normalizeIngredientQuantity(ing);
            if (normalizedQuantity) quantityMap.set(key, normalizedQuantity);
            itemMap.set(key, {
              name: ing.name,
              quantity: ing.quantity,
              unit: ing.unit,
              checked: checkedByKey.get(key) ?? false,
              aisle: classifyIngredientAisle(ing.name),
              ...shoppingPantryMetadata(pantryByName.get(normalizePantryName(ing.name))),
            });
          }
        }
      }
    }
  }

  const items = [...itemMap.values()].sort((a, b) => {
    const aisleOrder = shoppingAisleSortKey(a.aisle) - shoppingAisleSortKey(b.aisle);
    if (aisleOrder !== 0) return aisleOrder;
    return a.name.localeCompare(b.name);
  });

  // Upsert shopping list
  const existingScope = db.prepare(
    'SELECT tenant_id FROM shopping_lists WHERE tenant_id = ? AND user_id = ? AND week_start = ?',
  ).get(scope.tenantId, userId, normalizedWeekStart) as { tenant_id: number | null } | undefined;
  if (existingScope && Number(existingScope.tenant_id) !== scope.tenantId) {
    throw new Error('COOKING_SCOPE_CONFLICT: shopping list belongs to a different tenant');
  }

  db.prepare(`
    INSERT INTO shopping_lists (
      tenant_id, user_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
      created_by, updated_by, audit_metadata_json, week_start, items
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, week_start) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      owner_user_id = excluded.owner_user_id,
      visibility_scope = excluded.visibility_scope,
      lifecycle_state = excluded.lifecycle_state,
      scope_status = excluded.scope_status,
      updated_by = excluded.updated_by,
      audit_metadata_json = excluded.audit_metadata_json,
      items = excluded.items,
      updated_at = datetime('now')
  `).run(
    scope.tenantId,
    userId,
    scope.ownerUserId,
    scope.visibilityScope,
    scope.lifecycleState,
    scope.scopeStatus,
    scope.createdBy,
    scope.updatedBy,
    scope.auditMetadataJson,
    normalizedWeekStart,
    JSON.stringify(items),
  );

  const row = db.prepare(
    `SELECT * FROM shopping_lists WHERE week_start = ? AND ${cookingPrivateScopePredicate()}`,
  ).get(normalizedWeekStart, ...cookingScopeParams(userId, tenantId)) as any;

  logger.info({ userId, weekStart: normalizedWeekStart, itemCount: items.length }, 'Shopping list generated');
  const list = parseShoppingList(row);
  return safetyIssues.length > 0 ? { ...list, safetyIssues } : list;
}

type QuantityFamily = 'mass' | 'volume' | 'count';

interface NormalizedQuantity {
  family: QuantityFamily;
  baseValue: number;
}

function mergeIngredientQuantity(
  existing: NormalizedQuantity | undefined,
  ingredient: Ingredient,
): NormalizedQuantity | null {
  const next = normalizeIngredientQuantity(ingredient);
  if (!existing || !next || existing.family !== next.family) return null;
  return { family: existing.family, baseValue: existing.baseValue + next.baseValue };
}

function normalizeIngredientQuantity(ingredient: Ingredient): NormalizedQuantity | null {
  const quantity = parseIngredientNumber(ingredient.quantity);
  if (quantity == null) return null;

  const unit = normalizeIngredientUnit(ingredient.unit);
  switch (unit) {
    case 'mg': return { family: 'mass', baseValue: quantity / 1000 };
    case 'g': return { family: 'mass', baseValue: quantity };
    case 'kg': return { family: 'mass', baseValue: quantity * 1000 };
    case 'ml': return { family: 'volume', baseValue: quantity };
    case 'l': return { family: 'volume', baseValue: quantity * 1000 };
    case 'tsp': return { family: 'volume', baseValue: quantity * 5 };
    case 'tbsp': return { family: 'volume', baseValue: quantity * 15 };
    case 'cup': return { family: 'volume', baseValue: quantity * 240 };
    case 'pcs': return { family: 'count', baseValue: quantity };
    default: return null;
  }
}

function parseIngredientNumber(value: string): number | null {
  const normalized = String(value || '').trim().replace(',', '.');
  if (!normalized) return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeIngredientUnit(unit: string): string {
  const normalized = String(unit || '').trim().toLowerCase();
  if (['mg', 'milligram', 'milligrams', 'miligrama', 'miligramas'].includes(normalized)) return 'mg';
  if (['g', 'gr', 'gram', 'grams', 'grama', 'gramas'].includes(normalized)) return 'g';
  if (['kg', 'kilogram', 'kilograms', 'quilo', 'quilos'].includes(normalized)) return 'kg';
  if (['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'mililitro', 'mililitros'].includes(normalized)) return 'ml';
  if (['l', 'lt', 'liter', 'liters', 'litre', 'litres', 'litro', 'litros'].includes(normalized)) return 'l';
  if (['tsp', 'teaspoon', 'teaspoons', 'colher de cha', 'colher de chá'].includes(normalized)) return 'tsp';
  if (['tbsp', 'tablespoon', 'tablespoons', 'colher de sopa'].includes(normalized)) return 'tbsp';
  if (['cup', 'cups', 'xicara', 'xícara', 'xicaras', 'xícaras'].includes(normalized)) return 'cup';
  if (['pc', 'pcs', 'piece', 'pieces', 'unit', 'units', 'un', 'unidade', 'unidades', 'dose', 'doses'].includes(normalized)) return 'pcs';
  return normalized;
}

function formatNormalizedQuantity(quantity: NormalizedQuantity): { quantity: string; unit: string } {
  if (quantity.family === 'mass') {
    if (quantity.baseValue >= 1000) {
      return { quantity: formatQuantityNumber(quantity.baseValue / 1000), unit: 'kg' };
    }
    return { quantity: formatQuantityNumber(quantity.baseValue), unit: 'g' };
  }
  if (quantity.family === 'volume') {
    if (quantity.baseValue >= 1000) {
      return { quantity: formatQuantityNumber(quantity.baseValue / 1000), unit: 'l' };
    }
    return { quantity: formatQuantityNumber(quantity.baseValue), unit: 'ml' };
  }
  return { quantity: formatQuantityNumber(quantity.baseValue), unit: 'pcs' };
}

function formatQuantityNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function appendQuantity(existing: ShoppingItem, ingredient: Ingredient): string {
  const left = `${existing.quantity}${existing.unit ? ` ${existing.unit}` : ''}`.trim();
  const right = `${ingredient.quantity}${ingredient.unit ? ` ${ingredient.unit}` : ''}`.trim();
  return `${left} + ${right}`;
}

interface ShoppingListSafetyProjection {
  rawList: ShoppingList;
  visibleList: ShoppingList;
  visibleRawIndexes: number[];
}

function readShoppingListSafetyProjection(
  userId: number,
  weekStart: string,
  tenantId?: number | null,
): ShoppingListSafetyProjection | null {
  const db = getCookingDb();
  const normalizedWeekStart = normalizeShoppingLookupWeekStart(weekStart);
  const row = db.prepare(
    `SELECT * FROM shopping_lists WHERE week_start = ? AND ${cookingPrivateScopePredicate()}`,
  ).get(normalizedWeekStart, ...cookingScopeParams(userId, tenantId)) as any;
  if (!row) return null;
  const list = parseShoppingList(row);
  let safetyProfile: ReturnType<typeof buildCookingPreferenceReadModel>['profile'];
  try {
    safetyProfile = buildCookingPreferenceReadModel(userId, resolveCookingTenantId(userId, tenantId)).profile;
  } catch {
    throw new Error('COOKING_SAFETY_BLOCKED: shopping list safety profile unavailable');
  }
  const safeItems: ShoppingItem[] = [];
  const safetyIssues: ShoppingListSafetyIssue[] = [];
  const visibleRawIndexes: number[] = [];
  for (const [rawIndex, item] of list.items.entries()) {
    const evaluation = evaluateCookingSafetyTextForProfile(
      safetyProfile,
      'shopping_list',
      [item.name, item.quantity, item.unit],
    );
    if (!evaluation.blocked) {
      safeItems.push(item);
      visibleRawIndexes.push(rawIndex);
      continue;
    }
    for (const issue of evaluation.issues) {
      if (issue.code === 'SAFETY_PROFILE_UNAVAILABLE') continue;
      safetyIssues.push({ code: issue.code, itemName: item.name });
    }
  }
  const visibleList = safetyIssues.length > 0
    ? { ...list, items: safeItems, safetyIssues }
    : list;
  return { rawList: list, visibleList, visibleRawIndexes };
}

export function getShoppingList(userId: number, weekStart: string, tenantId?: number | null): ShoppingList | null {
  return readShoppingListSafetyProjection(userId, weekStart, tenantId)?.visibleList ?? null;
}

export function updateShoppingListItemChecked(
  userId: number,
  weekStart: string,
  itemIndex: number,
  checked: boolean,
  tenantId?: number | null,
): ShoppingList | null {
  const db = getCookingDb();
  const normalizedWeekStart = normalizeShoppingLookupWeekStart(weekStart);
  const projection = readShoppingListSafetyProjection(userId, normalizedWeekStart, tenantId);
  if (!projection) {
    return null;
  }
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= projection.visibleRawIndexes.length) {
    throw new Error('Shopping list item index is out of range');
  }
  const rawItemIndex = projection.visibleRawIndexes[itemIndex]!;

  // The API index addresses the safety-filtered view. Update the corresponding
  // raw item only; persisting the filtered projection would silently delete
  // hidden conflict items during an unrelated checked-state toggle.
  const items = projection.rawList.items.map((item, index) => (
    index === rawItemIndex ? { ...item, checked } : item
  ));

  db.prepare(`
    UPDATE shopping_lists
    SET items = ?, updated_at = datetime('now'), updated_by = ?
    WHERE week_start = ? AND ${cookingPrivateScopePredicate()}
  `).run(JSON.stringify(items), userId, normalizedWeekStart, ...cookingScopeParams(userId, tenantId));

  const updated = getShoppingList(userId, normalizedWeekStart, tenantId);
  logger.info({ userId, weekStart: normalizedWeekStart, itemIndex, checked }, 'Shopping list item updated');
  return updated;
}

// ── Helpers ────────────────────────────────────────────────────────

function parseRecipe(row: any): Recipe {
  const {
    protein_g,
    fat_g,
    carbs_g,
    calories_kcal,
    ...rest
  } = row;
  return {
    ...rest,
    ingredients: typeof row.ingredients === 'string' ? JSON.parse(row.ingredients) : row.ingredients,
    protein: protein_g ?? null,
    fat: fat_g ?? null,
    carbs: carbs_g ?? null,
    calories: calories_kcal ?? null,
  };
}

function parseShoppingList(row: any): ShoppingList {
  const parsedItems = typeof row.items === 'string' ? JSON.parse(row.items) : row.items;
  return {
    ...row,
    items: Array.isArray(parsedItems)
      ? parsedItems.map((item) => ({
          ...item,
          aisle: typeof item?.aisle === 'string' && item.aisle.trim()
            ? item.aisle
            : classifyIngredientAisle(String(item?.name ?? '')),
          pantry_status: item?.pantry_status ?? 'needed',
        }))
      : [],
  };
}

function parsePantryItem(row: any, todayIso: string): PantryItem {
  const { effective_freshness_status, ...rest } = row;
  return {
    ...rest,
    freshness_status: typeof effective_freshness_status === 'string'
      ? effective_freshness_status
      : normalizePantryFreshness(row.freshness_status, row.expires_at, todayIso),
    confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence ?? 1),
  };
}

function normalizeRecipeTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('COOKING_RECIPE_INVALID: title must be a non-empty string');
  }
  return value.trim();
}

function normalizeRecipeIngredients(value: unknown): Ingredient[] {
  if (!Array.isArray(value)) {
    throw new Error('COOKING_RECIPE_INVALID: ingredients must be an array');
  }
  return value.map((ingredient, index) => {
    if (ingredient === null || typeof ingredient !== 'object' || Array.isArray(ingredient)) {
      throw new Error(`COOKING_RECIPE_INVALID: ingredients[${index}] must be an object`);
    }
    const row = ingredient as Record<string, unknown>;
    if (typeof row.name !== 'string' || !row.name.trim()) {
      throw new Error(`COOKING_RECIPE_INVALID: ingredients[${index}].name must be a non-empty string`);
    }
    if (typeof row.quantity !== 'string') {
      throw new Error(`COOKING_RECIPE_INVALID: ingredients[${index}].quantity must be a string`);
    }
    if (typeof row.unit !== 'string') {
      throw new Error(`COOKING_RECIPE_INVALID: ingredients[${index}].unit must be a string`);
    }
    return {
      name: row.name.trim(),
      quantity: row.quantity,
      unit: row.unit,
    };
  });
}

function validateRecipeOptionalText(value: unknown, field: string): void {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new Error(`COOKING_RECIPE_INVALID: ${field} must be a string or null`);
  }
}

function validateRecipeNonNegativeInteger(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`COOKING_RECIPE_INVALID: ${field} must be a non-negative integer or null`);
  }
}

function validateRecipeServings(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('COOKING_RECIPE_INVALID: servings must be a positive integer');
  }
}

function validateRecipeNutrition(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`COOKING_RECIPE_INVALID: ${field} must be a non-negative finite number or null`);
  }
}

function normalizeMealPlanTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('COOKING_MEAL_PLAN_INVALID_TITLE: title must be a non-empty string');
  }
  return value.trim();
}

function normalizeMealType(value: unknown, errorCode = 'COOKING_MEAL_PLAN_INVALID_MEAL_TYPE'): string {
  if (typeof value !== 'string') {
    throw new Error(`${errorCode}: mealType must be breakfast, lunch, dinner, or snack`);
  }
  const normalized = value.trim().toLowerCase();
  if (!['breakfast', 'lunch', 'dinner', 'snack'].includes(normalized)) {
    throw new Error(`${errorCode}: mealType must be breakfast, lunch, dinner, or snack`);
  }
  return normalized;
}

function normalizeIsoDate(value: unknown, errorCode: string, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${errorCode}: ${field} must be a valid YYYY-MM-DD date`);
  }
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) {
    throw new Error(`${errorCode}: ${field} must be a valid YYYY-MM-DD date`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${errorCode}: ${field} must be a valid YYYY-MM-DD date`);
  }
  return normalized;
}

function normalizeWeekStart(value: unknown): string {
  const normalized = normalizeIsoDate(value, 'COOKING_SHOPPING_LIST_INVALID_WEEK_START', 'weekStart');
  if (new Date(`${normalized}T00:00:00.000Z`).getUTCDay() !== 1) {
    throw new Error('COOKING_SHOPPING_LIST_INVALID_WEEK_START: weekStart must be a Monday');
  }
  return normalized;
}

function normalizeShoppingLookupWeekStart(value: unknown): string {
  const normalized = normalizeIsoDate(value, 'COOKING_SHOPPING_LIST_INVALID_WEEK_DATE', 'week');
  return mondayForNormalizedDate(normalized);
}

function normalizeRequiredText(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function assertCookingSafeRecipe(
  userId: number,
  tenantId: number,
  recipe: {
    title?: string | null;
    ingredients?: Ingredient[] | null;
    instructions?: string | null;
    tags?: string | null;
    source?: string | null;
  },
): void {
  const ingredientTexts = (recipe.ingredients ?? []).flatMap((ingredient) => [
    ingredient.name,
    ingredient.quantity,
    ingredient.unit,
  ]);
  assertCookingSafetyText(userId, tenantId, 'recipe', [
    recipe.title,
    recipe.instructions,
    recipe.tags,
    recipe.source,
    ...ingredientTexts,
  ]);
}

function ingredientNameMatches(candidate: string, originalIngredient: string): boolean {
  const candidateName = normalizePantryName(candidate);
  const originalName = normalizePantryName(originalIngredient);
  return candidateName === originalName || containsIngredientTokenSequence(candidateName, originalName);
}

function replaceIngredientText(value: string, originalIngredient: string, suggestedIngredient: string): string {
  const source = String(value ?? '');
  const needles = replacementNeedles(originalIngredient);
  if (needles.length === 0) return source;

  const lowerSource = source.toLowerCase();
  const lowerNeedles = needles.map((needle) => needle.toLowerCase());
  let cursor = 0;
  let result = '';
  while (cursor < source.length) {
    const match = findNextIngredientBoundaryMatch(lowerSource, lowerNeedles, cursor);
    if (!match) {
      result += source.slice(cursor);
      break;
    }
    result += source.slice(cursor, match.index);
    result += suggestedIngredient;
    cursor = match.index + match.length;
  }
  return result;
}

function containsIngredientTokenSequence(candidate: string, original: string): boolean {
  if (!original) return false;
  return findNextIngredientBoundaryMatch(candidate, [original], 0) !== null;
}

function findNextIngredientBoundaryMatch(
  source: string,
  needles: string[],
  fromIndex: number,
): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const needle of needles) {
    if (!needle) continue;
    let searchFrom = fromIndex;
    while (searchFrom <= source.length - needle.length) {
      const index = source.indexOf(needle, searchFrom);
      if (index < 0) break;
      const before = index > 0 ? source[index - 1] : undefined;
      const afterIndex = index + needle.length;
      const after = afterIndex < source.length ? source[afterIndex] : undefined;
      if (!isIngredientWordCharacter(before) && !isIngredientWordCharacter(after)) {
        if (!best || index < best.index || (index === best.index && needle.length > best.length)) {
          best = { index, length: needle.length };
        }
        break;
      }
      searchFrom = index + 1;
    }
  }
  return best;
}

function isIngredientWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function replacementNeedles(originalIngredient: string): string[] {
  const original = String(originalIngredient ?? '').trim();
  if (!original) return [];
  const needles = [original];
  if (original.toLowerCase().endsWith('s') && original.length > 1) {
    needles.push(original.slice(0, -1));
  } else {
    needles.push(`${original}s`);
  }
  return [...new Set(needles)].sort((a, b) => b.length - a.length);
}

function weekStartForDate(date: string): string {
  const normalizedDate = normalizeIsoDate(date, 'COOKING_SUBSTITUTION_INVALID_DATE', 'date');
  return mondayForNormalizedDate(normalizedDate);
}

function mondayForNormalizedDate(normalizedDate: string): string {
  const utc = new Date(`${normalizedDate}T00:00:00.000Z`);
  const dayOfWeek = utc.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  utc.setUTCDate(utc.getUTCDate() + mondayOffset);
  return utc.toISOString().slice(0, 10);
}

function cleanNullableText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizePantryName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizePantryExpiry(value: unknown): string | null {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new Error('COOKING_PANTRY_INVALID_EXPIRY: expiresAt must be a valid YYYY-MM-DD date');
  }
  const normalized = cleanNullableText(value);
  if (normalized == null) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) {
    throw new Error('COOKING_PANTRY_INVALID_EXPIRY: expiresAt must be a valid YYYY-MM-DD date');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const expiry = new Date(Date.UTC(year, month - 1, day));
  if (
    expiry.getUTCFullYear() !== year
    || expiry.getUTCMonth() !== month - 1
    || expiry.getUTCDate() !== day
  ) {
    throw new Error('COOKING_PANTRY_INVALID_EXPIRY: expiresAt must be a valid YYYY-MM-DD date');
  }

  return normalized;
}

function validatePantryWriteInput(input: Partial<PantryItemInput>, requireSupportedField = false): void {
  const supportedFields: Array<keyof PantryItemInput> = [
    'name',
    'quantity',
    'unit',
    'category',
    'expiresAt',
    'freshnessStatus',
    'availabilityStatus',
    'source',
    'confidence',
    'notes',
  ];
  if (requireSupportedField
      && !supportedFields.some((field) => Object.prototype.hasOwnProperty.call(input, field))) {
    throw new Error('COOKING_PANTRY_INVALID_UPDATE: at least one supported pantry field must be provided');
  }
  const hasName = Object.prototype.hasOwnProperty.call(input, 'name');
  if ((!requireSupportedField || hasName)
      && (typeof input.name !== 'string' || input.name.trim().length === 0)) {
    throw new Error('COOKING_PANTRY_INVALID_NAME: name must be a non-empty string');
  }
  const optionalTextFields: Array<keyof Pick<PantryItemInput, 'quantity' | 'unit' | 'category' | 'source' | 'notes'>> = [
    'quantity',
    'unit',
    'category',
    'source',
    'notes',
  ];
  for (const field of optionalTextFields) {
    const value = input[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new Error(`COOKING_PANTRY_INVALID_TEXT: ${field} must be a string or null`);
    }
  }
  if (input.confidence !== undefined && input.confidence !== null
      && (typeof input.confidence !== 'number'
        || !Number.isFinite(input.confidence)
        || input.confidence < 0
        || input.confidence > 1)) {
    throw new Error('COOKING_PANTRY_INVALID_CONFIDENCE: confidence must be a number between 0 and 1');
  }
  const freshness = cleanNullableText(input.freshnessStatus);
  if (freshness !== null && !['fresh', 'unknown', 'use_soon', 'expired'].includes(freshness.toLowerCase())) {
    throw new Error('COOKING_PANTRY_INVALID_FRESHNESS: freshnessStatus must be fresh, unknown, use_soon, or expired');
  }
  const availability = cleanNullableText(input.availabilityStatus);
  if (availability !== null && !['available', 'low_stock', 'unavailable'].includes(availability.toLowerCase())) {
    throw new Error('COOKING_PANTRY_INVALID_AVAILABILITY: availabilityStatus must be available, low_stock, or unavailable');
  }
}

function normalizeCookingReadLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  errorCode: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${errorCode}: limit must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function effectivePantryFreshnessSql(todayIso: string): string {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(todayIso) ? todayIso : DateTime.utc().toISODate()!;
  return `CASE
    WHEN expires_at IS NOT NULL AND expires_at < date('${today}') THEN 'expired'
    WHEN COALESCE(freshness_status, 'unknown') = 'expired' THEN 'expired'
    WHEN expires_at IS NOT NULL AND expires_at <= date('${today}', '+3 days') THEN 'use_soon'
    WHEN COALESCE(freshness_status, 'unknown') = 'use_soon' THEN 'use_soon'
    WHEN COALESCE(freshness_status, 'unknown') = 'unknown' THEN 'unknown'
    WHEN expires_at IS NOT NULL THEN 'fresh'
    WHEN COALESCE(freshness_status, 'unknown') = 'fresh' THEN 'fresh'
    ELSE 'unknown'
  END`;
}

function normalizePantryFreshness(value: unknown, expiresAt?: string | null, todayIso = DateTime.utc().toISODate()!): string {
  type PantryFreshness = 'fresh' | 'unknown' | 'use_soon' | 'expired';
  const severity: Record<PantryFreshness, number> = {
    fresh: 0,
    unknown: 1,
    use_soon: 2,
    expired: 3,
  };
  let expiryFreshness: PantryFreshness | null = null;
  if (expiresAt) {
    const expiryDate = DateTime.fromISO(expiresAt, { zone: 'UTC' }).startOf('day');
    const today = DateTime.fromISO(todayIso, { zone: 'UTC' }).startOf('day');
    const daysUntilExpiry = Math.floor(expiryDate.diff(today, 'days').days);
    expiryFreshness = daysUntilExpiry < 0
      ? 'expired'
      : daysUntilExpiry <= 3
        ? 'use_soon'
        : 'fresh';
  }

  const normalized = String(value ?? '').trim().toLowerCase();
  const explicitFreshness = ['fresh', 'unknown', 'use_soon', 'expired'].includes(normalized)
    ? normalized as PantryFreshness
    : null;
  if (expiryFreshness && explicitFreshness) {
    return severity[expiryFreshness] >= severity[explicitFreshness]
      ? expiryFreshness
      : explicitFreshness;
  }
  return expiryFreshness ?? explicitFreshness ?? 'unknown';
}

function cookingTodayIso(userId: number): string {
  const timezone = getUserTimezoneById(userId);
  const localToday = DateTime.now().setZone(timezone).toISODate();
  return localToday ?? DateTime.utc().toISODate()!;
}

function normalizePantryAvailability(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['available', 'low_stock', 'unavailable', 'removed'].includes(normalized)) return normalized;
  return 'available';
}

function normalizeConfidence(value: unknown): number {
  const numberValue = Number(value ?? 1);
  if (!Number.isFinite(numberValue)) return 1;
  return Math.max(0, Math.min(1, numberValue));
}

function shoppingPantryMetadata(item: PantryItem | undefined): Pick<ShoppingItem, 'pantry_status' | 'pantry_item_id' | 'pantry_freshness_status' | 'pantry_note'> {
  if (!item || item.availability_status === 'unavailable' || item.availability_status === 'removed') {
    return { pantry_status: 'needed' };
  }
  if (item.freshness_status === 'expired') {
    return {
      pantry_status: 'pantry_expired',
      pantry_item_id: item.id,
      pantry_freshness_status: item.freshness_status,
      pantry_note: 'Pantry item exists but is expired; do not use silently.',
    };
  }
  return {
    pantry_status: 'pantry_available',
    pantry_item_id: item.id,
    pantry_freshness_status: item.freshness_status,
  };
}

export function classifyIngredientAisle(name: string): string {
  const lower = name.trim().toLowerCase();
  if (!lower) return 'other';

  if (/(chicken|frango|beef|carne|turkey|peru|pork|porco|steak|bife|salmon|salm[aã]o|tuna|atum|cod|bacalhau|shrimp|camar[aã]o|egg|ovo|tofu|tempeh|yogurt|iogurte|skyr|cottage cheese|greek yogurt|protein|prote[ií]na)/i.test(lower)) {
    return 'protein';
  }
  if (/(milk|leite|cheese|queijo|butter|manteiga|cream|natas|kefir|mozzarella|parmesan|parmes[aã]o)/i.test(lower)) {
    return 'dairy';
  }
  if (/(spinach|espinafre|lettuce|alface|broccoli|br[oó]colos?|carrot|cenoura|onion|cebola|garlic|alho|pepper|pimento|tomato|tomate|cucumber|pepino|courgette|zucchini|curgete|avocado|abacate|mushroom|cogumelo|apple|ma[cç][aã]|banana|berries|frutos vermelhos|lemon|lim[aã]o|lime|lima|orange|laranja|potato|batata|sweet potato|batata doce|vegetable|vegetais|legumes|beans|feij[aã]o|lentil|lentilha|chickpea|gr[aã]o-de-bico)/i.test(lower)) {
    return 'produce';
  }
  if (/(bread|p[aã]o|wrap|tortilla|bagel|bun|pita|flour|farinha|oats|aveia|granola|pasta|massa|noodle|cereal|cracker|rice cake)/i.test(lower)) {
    return 'bakery';
  }
  if (/(olive oil|azeite|oil|[óo]leo|vinegar|vinagre|salt|sal|peppercorn|pimenta|paprika|oregano|or[eé]g[aã]os|basil|manjeric[aã]o|cinnamon|canela|spice|tempero|stock|caldo|broth|soy sauce|molho de soja|mustard|mostarda|ketchup|tomato sauce|molho de tomate|coconut milk|leite de coco|peanut butter|manteiga de amendoim|honey|mel|jam|compota|nuts|frutos secos|seeds|sementes|rice|arroz)/i.test(lower)) {
    return 'pantry';
  }
  if (/(frozen|ice cream|frozen berries|frozen vegetables)/i.test(lower)) {
    return 'frozen';
  }
  if (/(water|juice|sparkling|coffee|tea|kombucha|soda|drink)/i.test(lower)) {
    return 'beverages';
  }
  if (/(foil|paper|bag|container|soap|detergent|napkin)/i.test(lower)) {
    return 'household';
  }
  return 'other';
}

function shoppingAisleSortKey(aisle: string): number {
  switch (aisle) {
    case 'produce': return 0;
    case 'protein': return 1;
    case 'dairy': return 2;
    case 'bakery': return 3;
    case 'pantry': return 4;
    case 'frozen': return 5;
    case 'beverages': return 6;
    case 'household': return 7;
    default: return 8;
  }
}
