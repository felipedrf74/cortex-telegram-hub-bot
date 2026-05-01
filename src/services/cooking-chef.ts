// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cooking Chef Service
 *
 * Provides recipe management, meal planning, and shopping list generation.
 * All data is per-user via user_id.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import {
  cookingPrivateScopePredicate,
  cookingScopeForInsert,
  cookingScopeParams,
  ensureCookingTenantScopeColumns,
} from './cooking-tenant-scope';

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
    shoppingListUpdated: boolean;
    appliedAt: string;
  };
}

// ── Recipe CRUD ────────────────────────────────────────────────────

function getCookingDb() {
  const db = getDb();
  ensureCookingTenantScopeColumns(db);
  return db;
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
  const scope = cookingScopeForInsert(userId, opts?.tenantId, 'user_private', 'active');
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
    title, JSON.stringify(ingredients),
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
  logger.info({ userId, title }, 'Recipe added');
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

  const limit = opts?.limit ?? 20;
  params.push(limit);

  const rows = db.prepare(
    `SELECT * FROM recipes WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
  ).all(...params) as any[];

  return rows.map(parseRecipe);
}

export function deleteRecipe(userId: number, recipeId: number, tenantId?: number | null): boolean {
  const db = getCookingDb();
  const result = db.prepare(
    `DELETE FROM recipes WHERE id = ? AND ${cookingPrivateScopePredicate()}`,
  ).run(recipeId, ...cookingScopeParams(userId, tenantId));
  return result.changes > 0;
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

  // Build the SET clause dynamically so we only touch fields the
  // caller actually wants to change.
  const setParts: string[] = [];
  const params: any[] = [];

  if (updates.title !== undefined) {
    setParts.push('title = ?');
    params.push(updates.title);
  }
  if (updates.ingredients !== undefined) {
    setParts.push('ingredients = ?');
    params.push(JSON.stringify(updates.ingredients));
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
): MealPlan {
  const db = getCookingDb();
  const scope = cookingScopeForInsert(userId, opts?.tenantId, 'user_private', 'planned');
  const existingScope = db.prepare(
    'SELECT tenant_id FROM meal_plans WHERE user_id = ? AND date = ? AND meal_type = ?',
  ).get(userId, date, mealType) as { tenant_id: number | null } | undefined;
  if (existingScope && Number(existingScope.tenant_id ?? userId) !== scope.tenantId) {
    throw new Error('COOKING_SCOPE_CONFLICT: meal plan slot belongs to a different tenant');
  }
  db.prepare(`
    INSERT INTO meal_plans (
      tenant_id, user_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
      created_by, updated_by, audit_metadata_json,
      date, meal_type, recipe_id, title, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date, meal_type) DO UPDATE SET
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
    date,
    mealType,
    opts?.recipeId ?? null,
    title,
    opts?.notes ?? null,
  );

  return db.prepare(
    `SELECT * FROM meal_plans WHERE date = ? AND meal_type = ? AND ${cookingPrivateScopePredicate()}`,
  ).get(date, mealType, ...cookingScopeParams(userId, opts?.tenantId)) as MealPlan;
}

export function getMealPlan(userId: number, startDate: string, endDate: string, tenantId?: number | null): MealPlan[] {
  const db = getCookingDb();
  return db.prepare(
    `SELECT * FROM meal_plans WHERE ${cookingPrivateScopePredicate()} AND date >= ? AND date <= ? ORDER BY date, meal_type`,
  ).all(...cookingScopeParams(userId, tenantId), startDate, endDate) as MealPlan[];
}

export function deleteMealPlan(userId: number, date: string, mealType: string, tenantId?: number | null): boolean {
  const db = getCookingDb();
  const result = db.prepare(
    `DELETE FROM meal_plans WHERE date = ? AND meal_type = ? AND ${cookingPrivateScopePredicate()}`,
  ).run(date, mealType, ...cookingScopeParams(userId, tenantId));
  return result.changes > 0;
}

export function applyMealPlanSubstitution(
  userId: number,
  input: MealPlanSubstitutionInput,
  tenantId?: number | null,
): MealPlanSubstitutionResult {
  const originalIngredient = normalizeRequiredText(input.originalIngredient, 'originalIngredient');
  const suggestedIngredient = normalizeRequiredText(input.suggestedIngredient, 'suggestedIngredient');
  if (normalizePantryName(originalIngredient) === normalizePantryName(suggestedIngredient)) {
    throw new Error('COOKING_SUBSTITUTION_NOOP: suggestedIngredient must differ from originalIngredient');
  }

  const meals = getMealPlan(userId, input.date, input.date, tenantId);
  const meal = meals.find((candidate) => candidate.meal_type === input.mealType) ?? null;
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

  const updatedRecipe = updateRecipe(userId, recipe.id, {
    title: replaceIngredientText(recipe.title, originalIngredient, suggestedIngredient),
    ingredients: updatedIngredients,
    instructions: recipe.instructions == null
      ? recipe.instructions
      : replaceIngredientText(recipe.instructions, originalIngredient, suggestedIngredient),
  }, tenantId);
  const updatedMeal = setMealPlan(userId, meal.date, meal.meal_type, replaceIngredientText(meal.title, originalIngredient, suggestedIngredient), {
    recipeId: recipe.id,
    notes: meal.notes == null ? undefined : replaceIngredientText(meal.notes, originalIngredient, suggestedIngredient),
    tenantId,
  });
  const shoppingList = input.updateShoppingList === false
    ? null
    : generateShoppingList(userId, weekStartForDate(input.date), tenantId);

  return {
    applied: true,
    meal: updatedMeal,
    recipe: updatedRecipe,
    shoppingList,
    substitution: {
      ...baseSubstitution,
      affectedMealId: meal.id,
      affectedRecipeId: recipe.id,
      shoppingListUpdated: Boolean(shoppingList),
    },
  };
}

// ── Pantry ─────────────────────────────────────────────────────────

export function upsertPantryItem(userId: number, input: PantryItemInput, tenantId?: number | null): PantryItem {
  const db = getCookingDb();
  const name = normalizeRequiredText(input.name, 'name');
  const normalizedName = normalizePantryName(name);
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
      cleanNullableText(input.expiresAt),
      normalizePantryFreshness(input.freshnessStatus, input.expiresAt),
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
    cleanNullableText(input.expiresAt),
    normalizePantryFreshness(input.freshnessStatus, input.expiresAt),
    normalizePantryAvailability(input.availabilityStatus),
    cleanNullableText(input.source) ?? 'manual',
    normalizeConfidence(input.confidence),
    cleanNullableText(input.notes),
  );

  const row = db.prepare(
    `SELECT * FROM cooking_pantry_items WHERE normalized_name = ? AND ${cookingPrivateScopePredicate()}`,
  ).get(normalizedName, ...cookingScopeParams(userId, tenantId)) as any;
  logger.info({ userId, tenantId: scope.tenantId, pantryItemId: row?.id }, 'Cooking pantry item upserted');
  return parsePantryItem(row);
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
    conditions.push("COALESCE(freshness_status, 'unknown') != 'expired'");
  }

  const limit = Math.min(Math.max(Number(opts?.limit ?? 100) || 100, 1), 250);
  params.push(limit);

  const rows = db.prepare(`
    SELECT * FROM cooking_pantry_items
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE COALESCE(freshness_status, 'unknown')
        WHEN 'use_soon' THEN 0
        WHEN 'unknown' THEN 1
        WHEN 'fresh' THEN 2
        ELSE 3
      END,
      updated_at DESC,
      name ASC
    LIMIT ?
  `).all(...params) as any[];
  return rows.map(parsePantryItem);
}

export function getPantryItemById(userId: number, itemId: number, tenantId?: number | null): PantryItem | null {
  const db = getCookingDb();
  const row = db.prepare(
    `SELECT * FROM cooking_pantry_items WHERE id = ? AND ${cookingPrivateScopePredicate()} AND COALESCE(availability_status, 'available') != 'removed'`,
  ).get(itemId, ...cookingScopeParams(userId, tenantId)) as any;
  return row ? parsePantryItem(row) : null;
}

export function updatePantryItem(
  userId: number,
  itemId: number,
  updates: Partial<PantryItemInput>,
  tenantId?: number | null,
): PantryItem | null {
  const db = getCookingDb();
  const existing = getPantryItemById(userId, itemId, tenantId);
  if (!existing) return null;

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
  const expiresAt = updates.expiresAt !== undefined ? cleanNullableText(updates.expiresAt) : existing.expires_at;
  const availability = normalizePantryAvailability(updates.availabilityStatus ?? existing.availability_status);
  const params = [
    name,
    normalizePantryName(name),
    updates.quantity !== undefined ? cleanNullableText(updates.quantity) : existing.quantity,
    updates.unit !== undefined ? cleanNullableText(updates.unit) : existing.unit,
    updates.category !== undefined ? cleanNullableText(updates.category) : existing.category,
    expiresAt,
    normalizePantryFreshness(updates.freshnessStatus ?? existing.freshness_status, expiresAt),
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
  const scope = cookingScopeForInsert(userId, tenantId, 'user_private', 'active');

  // Calculate week end (7 days)
  const start = new Date(weekStart);
  const end = new Date(start.getTime() + 6 * 86400_000);
  const endDate = end.toISOString().slice(0, 10);

  // Get all meal plans for the week
  const meals = getMealPlan(userId, weekStart, endDate, tenantId);

  // Aggregate ingredients from linked recipes
  const itemMap = new Map<string, ShoppingItem>();
  const quantityMap = new Map<string, NormalizedQuantity>();
  const existing = getShoppingList(userId, weekStart, tenantId);
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
        `SELECT ingredients FROM recipes WHERE id = ? AND ${cookingPrivateScopePredicate()}`,
      ).get(meal.recipe_id, ...cookingScopeParams(userId, tenantId)) as any;
      if (recipe) {
        const ingredients: Ingredient[] = JSON.parse(recipe.ingredients);
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
    'SELECT tenant_id FROM shopping_lists WHERE user_id = ? AND week_start = ?',
  ).get(userId, weekStart) as { tenant_id: number | null } | undefined;
  if (existingScope && Number(existingScope.tenant_id ?? userId) !== scope.tenantId) {
    throw new Error('COOKING_SCOPE_CONFLICT: shopping list belongs to a different tenant');
  }

  db.prepare(`
    INSERT INTO shopping_lists (
      tenant_id, user_id, owner_user_id, visibility_scope, lifecycle_state, scope_status,
      created_by, updated_by, audit_metadata_json, week_start, items
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, week_start) DO UPDATE SET
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
    weekStart,
    JSON.stringify(items),
  );

  const row = db.prepare(
    `SELECT * FROM shopping_lists WHERE week_start = ? AND ${cookingPrivateScopePredicate()}`,
  ).get(weekStart, ...cookingScopeParams(userId, tenantId)) as any;

  logger.info({ userId, weekStart, itemCount: items.length }, 'Shopping list generated');
  return parseShoppingList(row);
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

export function getShoppingList(userId: number, weekStart: string, tenantId?: number | null): ShoppingList | null {
  const db = getCookingDb();
  const row = db.prepare(
    `SELECT * FROM shopping_lists WHERE week_start = ? AND ${cookingPrivateScopePredicate()}`,
  ).get(weekStart, ...cookingScopeParams(userId, tenantId)) as any;
  return row ? parseShoppingList(row) : null;
}

export function updateShoppingListItemChecked(
  userId: number,
  weekStart: string,
  itemIndex: number,
  checked: boolean,
  tenantId?: number | null,
): ShoppingList | null {
  const db = getCookingDb();
  const existing = getShoppingList(userId, weekStart, tenantId);
  if (!existing) {
    return null;
  }
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= existing.items.length) {
    throw new Error('Shopping list item index is out of range');
  }

  const items = existing.items.map((item, index) => (
    index === itemIndex ? { ...item, checked } : item
  ));

  db.prepare(`
    UPDATE shopping_lists
    SET items = ?, updated_at = datetime('now'), updated_by = ?
    WHERE week_start = ? AND ${cookingPrivateScopePredicate()}
  `).run(JSON.stringify(items), userId, weekStart, ...cookingScopeParams(userId, tenantId));

  const updated = getShoppingList(userId, weekStart, tenantId);
  logger.info({ userId, weekStart, itemIndex, checked }, 'Shopping list item updated');
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

function parsePantryItem(row: any): PantryItem {
  return {
    ...row,
    confidence: typeof row.confidence === 'number' ? row.confidence : Number(row.confidence ?? 1),
  };
}

function normalizeRequiredText(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function ingredientNameMatches(candidate: string, originalIngredient: string): boolean {
  const candidateName = normalizePantryName(candidate);
  const originalName = normalizePantryName(originalIngredient);
  return candidateName === originalName || candidateName.includes(originalName);
}

function replaceIngredientText(value: string, originalIngredient: string, suggestedIngredient: string): string {
  let source = String(value ?? '');
  for (const needle of replacementNeedles(originalIngredient)) {
    const lowerSource = source.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    let cursor = 0;
    let result = '';
    let changed = false;
    while (cursor < source.length) {
      const index = lowerSource.indexOf(lowerNeedle, cursor);
      if (index === -1) {
        result += source.slice(cursor);
        break;
      }
      result += source.slice(cursor, index);
      result += suggestedIngredient;
      cursor = index + needle.length;
      changed = true;
    }
    if (changed) source = result;
  }
  return source;
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
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error('COOKING_SUBSTITUTION_INVALID_DATE: date must be YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error('COOKING_SUBSTITUTION_INVALID_DATE: date must be YYYY-MM-DD');
  }
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

function normalizePantryFreshness(value: unknown, expiresAt?: string | null): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['fresh', 'use_soon', 'expired', 'unknown'].includes(normalized)) return normalized;
  if (expiresAt && /^\d{4}-\d{2}-\d{2}/.test(expiresAt)) {
    const expiryDate = new Date(`${expiresAt.slice(0, 10)}T00:00:00.000Z`).getTime();
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const daysUntilExpiry = Math.floor((expiryDate - todayUtc) / 86400_000);
    if (daysUntilExpiry < 0) return 'expired';
    if (daysUntilExpiry <= 3) return 'use_soon';
    return 'fresh';
  }
  return 'unknown';
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
