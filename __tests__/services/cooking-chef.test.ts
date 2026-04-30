/**
 * Tests for src/services/cooking-chef.ts
 *
 * Validates:
 * - Recipe CRUD (add, search, delete)
 * - Meal planning (set, get, delete)
 * - Shopping list generation from meal plan
 * - Per-user isolation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  addRecipe, getRecipeById, getRecipes, deleteRecipe, updateRecipe,
  setMealPlan, getMealPlan, deleteMealPlan,
  generateShoppingList, getShoppingList,
  upsertPantryItem, getPantryItems, getPantryItemById, updatePantryItem, deletePantryItem,
} from '../../src/services/cooking-chef';

describe('Recipe CRUD', () => {
  beforeEach(() => { testDb = createTestDb(); applyMigrations(testDb); });
  afterEach(() => { testDb.close(); });

  it('adds a recipe with structured ingredients', () => {
    const recipe = addRecipe(1, 'Grilled Ribeye', [
      { name: 'Ribeye steak', quantity: '400', unit: 'g' },
      { name: 'Salt', quantity: '1', unit: 'tsp' },
      { name: 'Butter', quantity: '30', unit: 'g' },
    ], { tags: 'carnivore,quick', prepTime: 5, cookTime: 15, servings: 2, protein: 32, fat: 18, carbs: 6, calories: 314 });

    expect(recipe.id).toBeDefined();
    expect(recipe.title).toBe('Grilled Ribeye');
    expect(recipe.ingredients).toHaveLength(3);
    expect(recipe.ingredients[0].name).toBe('Ribeye steak');
    expect(recipe.tags).toBe('carnivore,quick');
    expect(recipe.servings).toBe(2);
    expect(recipe.protein).toBe(32);
    expect(recipe.fat).toBe(18);
    expect(recipe.carbs).toBe(6);
    expect(recipe.calories).toBe(314);
  });

  it('updates recipe nutrition fields', () => {
    const recipe = addRecipe(1, 'Protein oats', [
      { name: 'Oats', quantity: '60', unit: 'g' },
    ]);

    const updated = updateRecipe(1, recipe.id, {
      protein: 28,
      fat: 7,
      carbs: 42,
      calories: 339,
    });

    expect(updated?.protein).toBe(28);
    expect(updated?.fat).toBe(7);
    expect(updated?.carbs).toBe(42);
    expect(updated?.calories).toBe(339);
  });

  it('searches recipes by tag', () => {
    addRecipe(1, 'Steak', [{ name: 'Beef', quantity: '500', unit: 'g' }], { tags: 'carnivore' });
    addRecipe(1, 'Salad', [{ name: 'Lettuce', quantity: '200', unit: 'g' }], { tags: 'vegetarian' });

    const carnivore = getRecipes(1, { tags: 'carnivore' });
    expect(carnivore).toHaveLength(1);
    expect(carnivore[0].title).toBe('Steak');
  });

  it('searches recipes by ingredient keyword', () => {
    addRecipe(1, 'Butter Steak', [{ name: 'Butter', quantity: '50', unit: 'g' }, { name: 'Steak', quantity: '400', unit: 'g' }]);
    addRecipe(1, 'Plain Eggs', [{ name: 'Eggs', quantity: '3', unit: 'pcs' }]);

    const results = getRecipes(1, { search: 'butter' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Butter Steak');
  });

  it('deletes a recipe', () => {
    const recipe = addRecipe(1, 'Test', [{ name: 'Item', quantity: '1', unit: 'pcs' }]);
    expect(deleteRecipe(1, recipe.id)).toBe(true);
    expect(getRecipes(1)).toHaveLength(0);
  });

  it('isolates recipes between users', () => {
    addRecipe(1, 'User 1 Recipe', [{ name: 'A', quantity: '1', unit: 'g' }]);
    addRecipe(2, 'User 2 Recipe', [{ name: 'B', quantity: '1', unit: 'g' }]);

    expect(getRecipes(1)).toHaveLength(1);
    expect(getRecipes(2)).toHaveLength(1);
  });

  it('isolates recipes between active tenants for the same user', () => {
    const tenantARecipe = addRecipe(1, 'Tenant A Recipe', [
      { name: 'A', quantity: '1', unit: 'g' },
    ], { tenantId: 101 });

    addRecipe(1, 'Tenant B Recipe', [
      { name: 'B', quantity: '1', unit: 'g' },
    ], { tenantId: 202 });

    expect(getRecipes(1, { tenantId: 101 }).map((recipe) => recipe.title)).toEqual(['Tenant A Recipe']);
    expect(getRecipes(1, { tenantId: 202 }).map((recipe) => recipe.title)).toEqual(['Tenant B Recipe']);
    expect(getRecipeById(1, tenantARecipe.id, 202)).toBeNull();
    expect(updateRecipe(1, tenantARecipe.id, { title: 'Leaked' }, 202)).toBeNull();
    expect(deleteRecipe(1, tenantARecipe.id, 202)).toBe(false);
    expect(getRecipeById(1, tenantARecipe.id, 101)?.title).toBe('Tenant A Recipe');
  });
});

describe('Meal Planning', () => {
  beforeEach(() => { testDb = createTestDb(); applyMigrations(testDb); });
  afterEach(() => { testDb.close(); });

  it('sets a meal plan entry', () => {
    const meal = setMealPlan(1, '2024-06-15', 'dinner', 'Grilled Ribeye with butter');
    expect(meal.date).toBe('2024-06-15');
    expect(meal.meal_type).toBe('dinner');
    expect(meal.title).toBe('Grilled Ribeye with butter');
  });

  it('upserts on same date+meal_type', () => {
    setMealPlan(1, '2024-06-15', 'dinner', 'Original');
    setMealPlan(1, '2024-06-15', 'dinner', 'Updated');

    const plan = getMealPlan(1, '2024-06-15', '2024-06-15');
    expect(plan).toHaveLength(1);
    expect(plan[0].title).toBe('Updated');
  });

  it('gets meal plan for date range', () => {
    setMealPlan(1, '2024-06-15', 'breakfast', 'Eggs');
    setMealPlan(1, '2024-06-15', 'dinner', 'Steak');
    setMealPlan(1, '2024-06-16', 'lunch', 'Chicken');

    const plan = getMealPlan(1, '2024-06-15', '2024-06-16');
    expect(plan).toHaveLength(3);
  });

  it('deletes a meal plan entry', () => {
    setMealPlan(1, '2024-06-15', 'dinner', 'Steak');
    expect(deleteMealPlan(1, '2024-06-15', 'dinner')).toBe(true);
    expect(getMealPlan(1, '2024-06-15', '2024-06-15')).toHaveLength(0);
  });

  it('isolates meal plans by tenant and rejects same-slot tenant overwrite', () => {
    setMealPlan(1, '2024-06-15', 'dinner', 'Tenant A dinner', { tenantId: 101 });

    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 101)).toHaveLength(1);
    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 202)).toHaveLength(0);
    expect(() => {
      setMealPlan(1, '2024-06-15', 'dinner', 'Tenant B overwrite', { tenantId: 202 });
    }).toThrow(/COOKING_SCOPE_CONFLICT/);
    expect(deleteMealPlan(1, '2024-06-15', 'dinner', 202)).toBe(false);
    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 101)[0].title).toBe('Tenant A dinner');
  });
});

describe('Shopping List', () => {
  beforeEach(() => { testDb = createTestDb(); applyMigrations(testDb); });
  afterEach(() => { testDb.close(); });

  it('generates shopping list from meal plan with linked recipes', () => {
    const recipe = addRecipe(1, 'Steak', [
      { name: 'Ribeye', quantity: '400', unit: 'g' },
      { name: 'Butter', quantity: '30', unit: 'g' },
    ]);
    setMealPlan(1, '2024-06-17', 'dinner', 'Steak', { recipeId: recipe.id });

    const list = generateShoppingList(1, '2024-06-17');
    expect(list.items).toHaveLength(2);
    expect(list.items.map(i => i.name)).toContain('Ribeye');
    expect(list.items.map(i => i.name)).toContain('Butter');
  });

  it('aggregates ingredients across multiple meals', () => {
    const recipe = addRecipe(1, 'Eggs & Butter', [
      { name: 'Eggs', quantity: '3', unit: 'pcs' },
      { name: 'Butter', quantity: '20', unit: 'g' },
    ]);
    setMealPlan(1, '2024-06-17', 'breakfast', 'Morning eggs', { recipeId: recipe.id });
    setMealPlan(1, '2024-06-18', 'breakfast', 'Morning eggs', { recipeId: recipe.id });

    const list = generateShoppingList(1, '2024-06-17');
    expect(list.items).toHaveLength(2);
    const eggs = list.items.find(i => i.name === 'Eggs')!;
    expect(eggs.quantity).toBe('6');
    expect(eggs.unit).toBe('pcs');
  });

  it('returns empty list for week with no meals', () => {
    const list = generateShoppingList(1, '2024-06-17');
    expect(list.items).toHaveLength(0);
  });

  it('retrieves saved shopping list', () => {
    const recipe = addRecipe(1, 'Test', [{ name: 'Item', quantity: '1', unit: 'pcs' }]);
    setMealPlan(1, '2024-06-17', 'dinner', 'Test', { recipeId: recipe.id });
    generateShoppingList(1, '2024-06-17');

    const retrieved = getShoppingList(1, '2024-06-17');
    expect(retrieved).toBeTruthy();
    expect(retrieved!.items).toHaveLength(1);
  });

  it('isolates shopping lists by tenant', () => {
    const recipe = addRecipe(1, 'Tenant Pantry Pasta', [
      { name: 'Pasta', quantity: '250', unit: 'g' },
    ], { tenantId: 101 });
    setMealPlan(1, '2024-06-17', 'dinner', 'Tenant pasta', { recipeId: recipe.id, tenantId: 101 });
    const list = generateShoppingList(1, '2024-06-17', 101);

    expect(list.items.map((item) => item.name)).toEqual(['Pasta']);
    expect(getShoppingList(1, '2024-06-17', 202)).toBeNull();
    expect(generateShoppingList(1, '2024-06-24', 202).items).toEqual([]);
  });

  it('returns null for non-existent shopping list', () => {
    expect(getShoppingList(1, '2099-01-01')).toBeNull();
  });

  it('marks shopping list items that are already available in tenant pantry', () => {
    upsertPantryItem(1, {
      name: 'Pasta',
      quantity: '500',
      unit: 'g',
      freshnessStatus: 'fresh',
    }, 101);
    const recipe = addRecipe(1, 'Tenant pasta', [
      { name: 'Pasta', quantity: '250', unit: 'g' },
      { name: 'Tomatoes', quantity: '2', unit: 'pcs' },
    ], { tenantId: 101 });
    setMealPlan(1, '2024-06-17', 'dinner', 'Tenant pasta', { recipeId: recipe.id, tenantId: 101 });

    const list = generateShoppingList(1, '2024-06-17', 101);

    expect(list.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Pasta', pantry_status: 'pantry_available' }),
      expect.objectContaining({ name: 'Tomatoes', pantry_status: 'needed' }),
    ]));
  });
});

describe('Pantry', () => {
  beforeEach(() => { testDb = createTestDb(); applyMigrations(testDb); });
  afterEach(() => { testDb.close(); });

  it('upserts and lists pantry items for the active tenant', () => {
    const item = upsertPantryItem(1, {
      name: 'Greek yogurt',
      quantity: '2',
      unit: 'cups',
      category: 'protein',
      expiresAt: '2099-01-01',
      notes: 'For breakfast bowls',
    }, 101);

    expect(item.name).toBe('Greek yogurt');
    expect(item.tenant_id).toBe(101);
    expect(item.freshness_status).toBe('fresh');

    const updated = upsertPantryItem(1, {
      name: 'Greek yogurt',
      quantity: '3',
      unit: 'cups',
      category: 'protein',
    }, 101);

    expect(updated.id).toBe(item.id);
    expect(updated.quantity).toBe('3');
    expect(getPantryItems(1, { tenantId: 101 })).toHaveLength(1);
  });

  it('isolates pantry items between active tenants for the same user', () => {
    const tenantA = upsertPantryItem(1, { name: 'Rice', quantity: '1', unit: 'kg' }, 101);
    upsertPantryItem(1, { name: 'Beans', quantity: '2', unit: 'cans' }, 202);

    expect(getPantryItems(1, { tenantId: 101 }).map((item) => item.name)).toEqual(['Rice']);
    expect(getPantryItems(1, { tenantId: 202 }).map((item) => item.name)).toEqual(['Beans']);
    expect(getPantryItemById(1, tenantA.id, 202)).toBeNull();
    expect(updatePantryItem(1, tenantA.id, { quantity: 'leaked' }, 202)).toBeNull();
    expect(deletePantryItem(1, tenantA.id, 202)).toBe(false);
    expect(getPantryItemById(1, tenantA.id, 101)?.quantity).toBe('1');
  });

  it('soft deletes pantry items without exposing them in list reads', () => {
    const item = upsertPantryItem(1, { name: 'Old oats' }, 101);

    expect(deletePantryItem(1, item.id, 101)).toBe(true);
    expect(getPantryItems(1, { tenantId: 101, includeExpired: true })).toEqual([]);
    expect(getPantryItemById(1, item.id, 101)).toBeNull();
  });

  it('keeps expired pantry items out of default list reads but available for review', () => {
    upsertPantryItem(1, { name: 'Old milk', expiresAt: '2000-01-01' }, 101);

    expect(getPantryItems(1, { tenantId: 101 })).toEqual([]);
    expect(getPantryItems(1, { tenantId: 101, includeExpired: true })).toEqual([
      expect.objectContaining({ name: 'Old milk', freshness_status: 'expired' }),
    ]);
  });
});
