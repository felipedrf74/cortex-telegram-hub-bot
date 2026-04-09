// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cooking Chef Service
 *
 * Provides recipe management, meal planning, and shopping list generation.
 * All data is per-user via user_id.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

// ── Types ──────────────────────────────────────────────────────────

export interface Ingredient {
  name: string;
  quantity: string;
  unit: string;
}

export interface Recipe {
  id: number;
  user_id: number;
  title: string;
  ingredients: Ingredient[];
  instructions: string | null;
  prep_time_min: number | null;
  cook_time_min: number | null;
  servings: number;
  tags: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface MealPlan {
  id: number;
  user_id: number;
  date: string;
  meal_type: string;
  recipe_id: number | null;
  title: string;
  notes: string | null;
  created_at: string;
}

export interface ShoppingList {
  id: number;
  user_id: number;
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
}

// ── Recipe CRUD ────────────────────────────────────────────────────

export function addRecipe(
  userId: number,
  title: string,
  ingredients: Ingredient[],
  opts?: { instructions?: string; prepTime?: number; cookTime?: number; servings?: number; tags?: string; source?: string },
): Recipe {
  const db = getDb();
  db.prepare(`
    INSERT INTO recipes (user_id, title, ingredients, instructions, prep_time_min, cook_time_min, servings, tags, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, title, JSON.stringify(ingredients),
    opts?.instructions ?? null,
    opts?.prepTime ?? null,
    opts?.cookTime ?? null,
    opts?.servings ?? 1,
    opts?.tags ?? null,
    opts?.source ?? null,
  );
  const row = db.prepare('SELECT * FROM recipes WHERE rowid = last_insert_rowid()').get() as any;
  logger.info({ userId, title }, 'Recipe added');
  return parseRecipe(row);
}

export function getRecipes(
  userId: number,
  opts?: { tags?: string; search?: string; limit?: number },
): Recipe[] {
  const db = getDb();
  const conditions = ['user_id = ?'];
  const params: any[] = [userId];

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

export function deleteRecipe(userId: number, recipeId: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM recipes WHERE id = ? AND user_id = ?').run(recipeId, userId);
  return result.changes > 0;
}

/**
 * Fetch a single recipe by id, scoped to user_id. Returns null
 * if not found or owned by another user.
 */
export function getRecipeById(userId: number, recipeId: number): Recipe | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM recipes WHERE id = ? AND user_id = ?',
  ).get(recipeId, userId) as any;
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
  },
): Recipe | null {
  const db = getDb();

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

  if (setParts.length > 0) {
    setParts.push("updated_at = datetime('now')");
    const sql = `UPDATE recipes SET ${setParts.join(', ')} WHERE id = ? AND user_id = ?`;
    params.push(recipeId, userId);
    const result = db.prepare(sql).run(...params);
    if (result.changes === 0) return null;
    logger.info({ userId, recipeId }, 'Recipe updated');
  }

  return getRecipeById(userId, recipeId);
}

// ── Meal Planning ──────────────────────────────────────────────────

export function setMealPlan(
  userId: number,
  date: string,
  mealType: string,
  title: string,
  opts?: { recipeId?: number; notes?: string },
): MealPlan {
  const db = getDb();
  db.prepare(`
    INSERT INTO meal_plans (user_id, date, meal_type, recipe_id, title, notes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, date, meal_type) DO UPDATE SET
      recipe_id = excluded.recipe_id,
      title = excluded.title,
      notes = excluded.notes
  `).run(userId, date, mealType, opts?.recipeId ?? null, title, opts?.notes ?? null);

  return db.prepare(
    'SELECT * FROM meal_plans WHERE user_id = ? AND date = ? AND meal_type = ?',
  ).get(userId, date, mealType) as MealPlan;
}

export function getMealPlan(userId: number, startDate: string, endDate: string): MealPlan[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM meal_plans WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date, meal_type',
  ).all(userId, startDate, endDate) as MealPlan[];
}

export function deleteMealPlan(userId: number, date: string, mealType: string): boolean {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM meal_plans WHERE user_id = ? AND date = ? AND meal_type = ?',
  ).run(userId, date, mealType);
  return result.changes > 0;
}

// ── Shopping List ──────────────────────────────────────────────────

export function generateShoppingList(userId: number, weekStart: string): ShoppingList {
  const db = getDb();

  // Calculate week end (7 days)
  const start = new Date(weekStart);
  const end = new Date(start.getTime() + 6 * 86400_000);
  const endDate = end.toISOString().slice(0, 10);

  // Get all meal plans for the week
  const meals = getMealPlan(userId, weekStart, endDate);

  // Aggregate ingredients from linked recipes
  const itemMap = new Map<string, ShoppingItem>();

  for (const meal of meals) {
    if (meal.recipe_id) {
      const recipe = db.prepare('SELECT ingredients FROM recipes WHERE id = ? AND user_id = ?').get(meal.recipe_id, userId) as any;
      if (recipe) {
        const ingredients: Ingredient[] = JSON.parse(recipe.ingredients);
        for (const ing of ingredients) {
          const key = ing.name.toLowerCase();
          const existing = itemMap.get(key);
          if (existing) {
            // Simple quantity aggregation — just append
            existing.quantity = `${existing.quantity} + ${ing.quantity}`;
          } else {
            itemMap.set(key, { name: ing.name, quantity: ing.quantity, unit: ing.unit, checked: false });
          }
        }
      }
    }
  }

  const items = [...itemMap.values()];

  // Upsert shopping list
  db.prepare(`
    INSERT INTO shopping_lists (user_id, week_start, items)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, week_start) DO UPDATE SET
      items = excluded.items,
      updated_at = datetime('now')
  `).run(userId, weekStart, JSON.stringify(items));

  const row = db.prepare(
    'SELECT * FROM shopping_lists WHERE user_id = ? AND week_start = ?',
  ).get(userId, weekStart) as any;

  logger.info({ userId, weekStart, itemCount: items.length }, 'Shopping list generated');
  return parseShoppingList(row);
}

export function getShoppingList(userId: number, weekStart: string): ShoppingList | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM shopping_lists WHERE user_id = ? AND week_start = ?',
  ).get(userId, weekStart) as any;
  return row ? parseShoppingList(row) : null;
}

// ── Helpers ────────────────────────────────────────────────────────

function parseRecipe(row: any): Recipe {
  return {
    ...row,
    ingredients: typeof row.ingredients === 'string' ? JSON.parse(row.ingredients) : row.ingredients,
  };
}

function parseShoppingList(row: any): ShoppingList {
  return {
    ...row,
    items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items,
  };
}
