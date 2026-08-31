/**
 * Tests for src/services/cooking-chef.ts
 *
 * Validates:
 * - Recipe CRUD (add, search, delete)
 * - Meal planning (set, get, delete)
 * - Shopping list generation from meal plan
 * - Per-user isolation
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({ getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  addRecipe, getRecipeById, getRecipes, deleteRecipe, updateRecipe,
  setMealPlan, getMealPlan, deleteMealPlan,
  generateShoppingList, getShoppingList, updateShoppingListItemChecked,
  upsertPantryItem, getPantryItems, getPantryItemById, updatePantryItem, deletePantryItem,
  applyMealPlanSubstitution,
} from '../../src/services/cooking-chef';
import { setCookingPreferenceMemory } from '../../src/services/cooking-preferences';
import { cookingPrivateScopePredicate } from '../../src/services/cooking-tenant-scope';
import type { Ingredient, PantryItemInput } from '../../src/services/cooking-chef';
import { addToConversation, getConversationHistory } from '../../src/state/conversation';
import { TOOLS } from '../../src/services/anthropic';

beforeAll(() => {
  testDb = createMigratedTestDatabase();
});

beforeEach(() => {
  testDb.exec('SAVEPOINT cooking_test_case');
});

afterEach(() => {
  vi.useRealTimers();
  testDb.exec('ROLLBACK TO cooking_test_case');
  testDb.exec('RELEASE cooking_test_case');
});

afterAll(() => {
  testDb.close();
});

describe('Recipe CRUD', () => {
  it('fails closed on malformed explicit Cooking scope identifiers', () => {
    expect(() => getRecipes(0)).toThrow(/COOKING_SCOPE_INVALID_USER/);
    expect(() => getRecipes(1, { tenantId: 0 })).toThrow(/COOKING_SCOPE_INVALID_TENANT/);
    expect(() => getRecipes(1, { tenantId: 1.5 })).toThrow(/COOKING_SCOPE_INVALID_TENANT/);
  });

  it('adds a recipe with structured ingredients', () => {
    const recipe = addRecipe(1, 'Grilled Ribeye', [
      { name: 'Ribeye steak', quantity: '400', unit: 'g' },
      { name: 'Salt', quantity: '1', unit: 'tsp' },
      { name: 'Butter', quantity: '30', unit: 'g' },
    ], {
      instructions: 'Grill at 200°C for 15 min',
      tags: 'carnivore,quick',
      source: 'https://example.com/recipe',
      prepTime: 5,
      cookTime: 15,
      servings: 2,
      protein: 32,
      fat: 18,
      carbs: 6,
      calories: 314,
    });

    expect(recipe.id).toBeDefined();
    expect(recipe.title).toBe('Grilled Ribeye');
    expect(recipe.ingredients).toHaveLength(3);
    expect(recipe.ingredients[0].name).toBe('Ribeye steak');
    expect(recipe.tags).toBe('carnivore,quick');
    expect(recipe.instructions).toBe('Grill at 200°C for 15 min');
    expect(recipe.source).toBe('https://example.com/recipe');
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
    addRecipe(1, 'Steak', [{ name: 'Beef', quantity: '500', unit: 'g' }], { tags: 'carnivore,quick' });
    addRecipe(1, 'Salad', [{ name: 'Lettuce', quantity: '200', unit: 'g' }], { tags: 'vegetarian' });

    const carnivore = getRecipes(1, { tags: 'carnivore' });
    expect(carnivore).toHaveLength(1);
    expect(carnivore[0].title).toBe('Steak');
    expect(getRecipes(1, { tags: 'quick' }).map((recipe) => recipe.title)).toEqual(['Steak']);
  });

  it('searches recipes by ingredient keyword', () => {
    addRecipe(1, 'Butter Steak', [{ name: 'Butter', quantity: '50', unit: 'g' }, { name: 'Steak', quantity: '400', unit: 'g' }]);
    addRecipe(1, 'Plain Eggs', [{ name: 'Eggs', quantity: '3', unit: 'pcs' }]);

    const results = getRecipes(1, { search: 'butter' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Butter Steak');
    expect(getRecipes(1, { search: 'BUTTER' })).toHaveLength(1);
  });

  it('deletes a recipe', () => {
    const recipe = addRecipe(1, 'Test', [{ name: 'Item', quantity: '1', unit: 'pcs' }]);
    expect(deleteRecipe(1, recipe.id)).toBe(true);
    expect(getRecipes(1)).toHaveLength(0);
  });

  it('does not delete a recipe linked by an active scoped meal', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-10T12:00:00.000Z'));
    const recipe = addRecipe(1, 'Planned dinner', [
      { name: 'Rice', quantity: '100', unit: 'g' },
    ], { tenantId: 101 });
    setMealPlan(1, '2024-06-15', 'dinner', 'Planned dinner', {
      recipeId: recipe.id,
      tenantId: 101,
    });

    expect(() => deleteRecipe(1, recipe.id, 101)).toThrow(/COOKING_RECIPE_IN_USE/);
    expect(getRecipeById(1, recipe.id, 101)?.title).toBe('Planned dinner');

    expect(deleteMealPlan(1, '2024-06-15', 'dinner', 101)).toBe(true);
    expect(deleteRecipe(1, recipe.id, 101)).toBe(true);
  });

  it('detaches historical meal references so an old plan does not pin a recipe forever', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-20T12:00:00.000Z'));
    const recipe = addRecipe(1, 'Historical dinner', [
      { name: 'Rice', quantity: '100', unit: 'g' },
    ], { tenantId: 101 });
    setMealPlan(1, '2024-06-15', 'dinner', 'Historical dinner', {
      recipeId: recipe.id,
      tenantId: 101,
    });

    expect(deleteRecipe(1, recipe.id, 101)).toBe(true);
    expect(getRecipeById(1, recipe.id, 101)).toBeNull();
    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 101)).toEqual([
      expect.objectContaining({ title: 'Historical dinner', recipe_id: null }),
    ]);
  });

  it('isolates recipes between users', () => {
    addRecipe(1, 'User 1 Recipe', [{ name: 'A', quantity: '1', unit: 'g' }]);
    addRecipe(2, 'User 2 Recipe', [{ name: 'B', quantity: '1', unit: 'g' }]);

    expect(getRecipes(1)).toHaveLength(1);
    expect(getRecipes(2)).toHaveLength(1);
  });

  it('enforces recipe invariants at the service boundary before persistence', () => {
    const validIngredients = [{ name: 'Rice', quantity: '100', unit: 'g' }];
    const invalidWrites: Array<() => unknown> = [
      () => addRecipe(1, '   ', validIngredients),
      () => addRecipe(1, 'Bad ingredient', [null] as unknown as Ingredient[]),
      () => addRecipe(1, 'Bad ingredient', [{ name: 'Rice', quantity: 100, unit: 'g' }] as unknown as Ingredient[]),
      () => addRecipe(1, 'Bad prep', validIngredients, { prepTime: -1 }),
      () => addRecipe(1, 'Bad cook', validIngredients, { cookTime: 1.5 }),
      () => addRecipe(1, 'Bad servings', validIngredients, { servings: 0 }),
      () => addRecipe(1, 'Bad nutrition', validIngredients, { protein: Number.NaN }),
    ];

    for (const write of invalidWrites) {
      expect(write).toThrow(/COOKING_RECIPE_INVALID/);
    }
    expect(getRecipes(1)).toEqual([]);
  });

  it('rejects invalid recipe updates without changing the stored row', () => {
    const recipe = addRecipe(1, 'Valid recipe', [
      { name: 'Rice', quantity: '100', unit: 'g' },
    ], { prepTime: 10, servings: 2 });

    expect(() => updateRecipe(1, recipe.id, { prepTime: -1 })).toThrow(/COOKING_RECIPE_INVALID/);
    expect(() => updateRecipe(1, recipe.id, {
      ingredients: [{ name: '', quantity: '100', unit: 'g' }],
    })).toThrow(/COOKING_RECIPE_INVALID/);
    expect(getRecipeById(1, recipe.id)).toEqual(expect.objectContaining({
      title: 'Valid recipe',
      prep_time_min: 10,
      servings: 2,
    }));
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

  it('blocks recipe creation when stored allergy memory matches an ingredient', () => {
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'peanuts' }, 70);

    expect(() => addRecipe(1, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
      { name: 'Noodles', quantity: '100', unit: 'g' },
    ], { tenantId: 70 })).toThrow(/COOKING_SAFETY_BLOCKED: recipe contains allergy "peanuts"/);

    expect(getRecipes(1, { tenantId: 70 })).toEqual([]);
  });

  it('blocks recipe updates that would introduce a stored allergy', () => {
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'almonds' }, 70);
    const recipe = addRecipe(1, 'Safe oats', [
      { name: 'Oats', quantity: '60', unit: 'g' },
    ], { tenantId: 70 });

    expect(() => updateRecipe(1, recipe.id, {
      ingredients: [
        { name: 'Oats', quantity: '60', unit: 'g' },
        { name: 'Almond butter', quantity: '20', unit: 'g' },
      ],
    }, 70)).toThrow(/COOKING_SAFETY_BLOCKED: recipe contains allergy "almonds"/);

    expect(getRecipeById(1, recipe.id, 70)?.ingredients.map((ingredient) => ingredient.name)).toEqual(['Oats']);
  });

  it('blocks Portuguese allergen aliases through the shared safety vocabulary', () => {
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'marisco' }, 70);

    expect(() => addRecipe(1, 'Arroz de camarão', [
      { name: 'Camarão', quantity: '200', unit: 'g' },
      { name: 'Arroz', quantity: '150', unit: 'g' },
    ], { tenantId: 70 })).toThrow(/COOKING_SAFETY_BLOCKED: recipe contains allergy "marisco"/);

    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'frutos secos' }, 70);
    expect(() => addRecipe(1, 'Iogurte com amêndoa', [
      { name: 'Iogurte', quantity: '1', unit: 'cup' },
      { name: 'Amêndoa', quantity: '20', unit: 'g' },
    ], { tenantId: 70 })).toThrow(/COOKING_SAFETY_BLOCKED: recipe contains allergy "frutos secos"/);
  });

  it('blocks recipe creation when stored dietary restrictions conflict', () => {
    setCookingPreferenceMemory(1, { kind: 'dietary_restriction', value: 'vegan' }, 70);

    expect(() => addRecipe(1, 'Chicken rice bowl', [
      { name: 'Chicken', quantity: '180', unit: 'g' },
      { name: 'Rice', quantity: '120', unit: 'g' },
    ], { tenantId: 70 })).toThrow(/COOKING_SAFETY_BLOCKED: recipe contains dietary restriction "vegan"/);
  });

  it('blocks compound foods that may contain a stored allergen', () => {
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'tree nut' }, 70);

    expect(() => addRecipe(1, 'Pesto pasta', [
      { name: 'Pesto', quantity: '3', unit: 'tbsp' },
      { name: 'Pasta', quantity: '100', unit: 'g' },
    ], { tenantId: 70 })).toThrow(/COOKING_SAFETY_BLOCKED: recipe contains allergy "tree nut"/);
  });
});

describe('Meal Planning', () => {
  it('sets a meal plan entry', () => {
    const recipe = addRecipe(1, 'Grilled Ribeye', [{ name: 'Ribeye', quantity: '400', unit: 'g' }]);
    const meal = setMealPlan(1, '2024-06-15', 'dinner', 'Grilled Ribeye with butter', {
      recipeId: recipe.id,
      notes: 'Medium rare',
    });
    expect(meal.date).toBe('2024-06-15');
    expect(meal.meal_type).toBe('dinner');
    expect(meal.title).toBe('Grilled Ribeye with butter');
    expect(meal.recipe_id).toBe(recipe.id);
    expect(meal.notes).toBe('Medium rare');
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

  it('isolates meal plans by tenant while allowing same user slot in another tenant', () => {
    setMealPlan(1, '2024-06-15', 'dinner', 'Tenant A dinner', { tenantId: 101 });

    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 101)).toHaveLength(1);
    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 202)).toHaveLength(0);
    setMealPlan(1, '2024-06-15', 'dinner', 'Tenant B dinner', { tenantId: 202 });
    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 202)[0].title).toBe('Tenant B dinner');
    expect(deleteMealPlan(1, '2024-06-15', 'dinner', 202)).toBe(true);
    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 101)[0].title).toBe('Tenant A dinner');
  });

  it('rejects missing and cross-tenant recipe links without writing a meal slot', () => {
    const tenantARecipe = addRecipe(1, 'Tenant A recipe', [
      { name: 'Rice', quantity: '100', unit: 'g' },
    ], { tenantId: 101 });

    expect(() => setMealPlan(1, '2024-06-15', 'dinner', 'Missing recipe', {
      recipeId: 999_999,
      tenantId: 101,
    })).toThrow(/COOKING_MEAL_PLAN_RECIPE_NOT_FOUND/);
    expect(() => setMealPlan(1, '2024-06-15', 'dinner', 'Cross-tenant recipe', {
      recipeId: tenantARecipe.id,
      tenantId: 202,
    })).toThrow(/COOKING_MEAL_PLAN_RECIPE_NOT_FOUND/);

    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 101)).toEqual([]);
    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 202)).toEqual([]);
  });

  it('rejects impossible dates, unsupported meal types, malformed titles, and reversed ranges', () => {
    expect(() => setMealPlan(1, '2026-02-30', 'dinner', 'Impossible')).toThrow(/COOKING_MEAL_PLAN_INVALID_DATE/);
    expect(() => setMealPlan(1, '2026-02-28', 'brunch', 'Unsupported')).toThrow(/COOKING_MEAL_PLAN_INVALID_MEAL_TYPE/);
    expect(() => setMealPlan(1, '2026-02-28', 'dinner', '   ')).toThrow(/COOKING_MEAL_PLAN_INVALID_TITLE/);
    expect(() => setMealPlan(1, '2026-02-28', 'dinner', 'Bad recipe id', { recipeId: 0 })).toThrow(/COOKING_MEAL_PLAN_INVALID_RECIPE_ID/);
    expect(() => getMealPlan(1, '2026-03-02', '2026-03-01')).toThrow(/COOKING_MEAL_PLAN_INVALID_DATE_RANGE/);
    expect(() => deleteMealPlan(1, 'not-a-date', 'dinner')).toThrow(/COOKING_MEAL_PLAN_INVALID_DATE/);
    expect(getMealPlan(1, '2026-02-28', '2026-02-28')).toEqual([]);
  });

  it('blocks meal plan text when stored allergy memory matches the planned title', () => {
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'peanuts' }, 70);

    expect(() => setMealPlan(1, '2024-06-15', 'dinner', 'Peanut noodles', {
      tenantId: 70,
    })).toThrow(/COOKING_SAFETY_BLOCKED: meal_plan contains allergy "peanuts"/);

    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 70)).toEqual([]);
  });

  it('blocks meal plan text when stored dietary restrictions conflict', () => {
    setCookingPreferenceMemory(1, { kind: 'dietary_restriction', value: 'gluten-free' }, 70);

    expect(() => setMealPlan(1, '2024-06-15', 'dinner', 'Wheat pasta', {
      tenantId: 70,
    })).toThrow(/COOKING_SAFETY_BLOCKED: meal_plan contains dietary restriction "gluten-free"/);

    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 70)).toEqual([]);
  });

  it('blocks meal plans that link a recipe made unsafe by later allergy memory', () => {
    const recipe = addRecipe(1, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
      { name: 'Noodles', quantity: '100', unit: 'g' },
    ], { tenantId: 70 });
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'peanuts' }, 70);

    expect(() => setMealPlan(1, '2024-06-15', 'dinner', 'Peanut noodles', {
      recipeId: recipe.id,
      tenantId: 70,
    })).toThrow(/COOKING_SAFETY_BLOCKED: recipe contains allergy "peanuts"/);

    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 70)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// QA regression pin for skill-hardening plan §C9 (2026-05-17):
// `setMealPlan` must surface a `mealPlanIssue` (code='pantry_expired') when a
// scheduled recipe references an expired pantry item, so iOS can render a
// confirmation prompt. Independent QA on 2026-05-18 found this was only
// flagged in the downstream shopping-list path and never on the meal-plan
// write — so an iOS client scheduling a meal got no warning at all. These
// tests pin both the warning shape and the explicit non-warning case.
// ─────────────────────────────────────────────────────────────────────────
describe('Meal plan expired pantry warnings (C9)', () => {
  it('surfaces a pantry_expired issue when a linked recipe references an expired pantry item', () => {
    upsertPantryItem(1, {
      name: 'Milk',
      quantity: '1',
      unit: 'L',
      expiresAt: '2020-01-01',
      freshnessStatus: 'expired',
    });
    const recipe = addRecipe(1, 'Café au lait', [
      { name: 'Milk', quantity: '250', unit: 'ml' },
      { name: 'Coffee', quantity: '20', unit: 'g' },
    ]);

    const result = setMealPlan(1, '2026-05-18', 'breakfast', 'Café au lait', { recipeId: recipe.id });

    expect(result.id).toBeGreaterThan(0);
    expect(result.issues).toBeDefined();
    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0]).toMatchObject({
      code: 'pantry_expired',
      ingredientName: 'Milk',
      pantryFreshnessStatus: 'expired',
    });
    expect(result.issues?.[0].message).toMatch(/expired/i);
  });

  it('does NOT surface a pantry_expired issue when the pantry item is fresh', () => {
    upsertPantryItem(1, {
      name: 'Milk',
      quantity: '1',
      unit: 'L',
      expiresAt: '2099-01-01',
      freshnessStatus: 'fresh',
    });
    const recipe = addRecipe(1, 'Café au lait', [
      { name: 'Milk', quantity: '250', unit: 'ml' },
    ]);

    const result = setMealPlan(1, '2026-05-18', 'breakfast', 'Café au lait', { recipeId: recipe.id });

    expect(result.issues).toBeUndefined();
  });

  it('does NOT surface a pantry_expired issue for ingredients not in the pantry', () => {
    const recipe = addRecipe(1, 'Lonely toast', [
      { name: 'Sourdough', quantity: '2', unit: 'slices' },
    ]);

    const result = setMealPlan(1, '2026-05-18', 'breakfast', 'Lonely toast', { recipeId: recipe.id });

    expect(result.issues).toBeUndefined();
  });

  it('persists the meal-plan slot even when an issue is raised (warning, not rejection)', () => {
    upsertPantryItem(1, {
      name: 'Yogurt',
      quantity: '500',
      unit: 'g',
      expiresAt: '2020-01-01',
      freshnessStatus: 'expired',
    });
    const recipe = addRecipe(1, 'Granola bowl', [
      { name: 'Yogurt', quantity: '200', unit: 'g' },
      { name: 'Granola', quantity: '40', unit: 'g' },
    ]);

    const result = setMealPlan(1, '2026-05-18', 'breakfast', 'Granola bowl', { recipeId: recipe.id });

    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0].code).toBe('pantry_expired');

    // Slot must still persist — the user explicitly asked to schedule it.
    const stored = getMealPlan(1, '2026-05-18', '2026-05-18');
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('Granola bowl');
  });

  it('aggregates multiple expired-pantry warnings when several recipe ingredients are expired', () => {
    upsertPantryItem(1, {
      name: 'Milk',
      quantity: '1',
      unit: 'L',
      expiresAt: '2020-01-01',
      freshnessStatus: 'expired',
    });
    upsertPantryItem(1, {
      name: 'Eggs',
      quantity: '6',
      unit: 'unit',
      expiresAt: '2020-01-01',
      freshnessStatus: 'expired',
    });
    const recipe = addRecipe(1, 'Pancakes', [
      { name: 'Milk', quantity: '250', unit: 'ml' },
      { name: 'Eggs', quantity: '2', unit: 'unit' },
      { name: 'Flour', quantity: '120', unit: 'g' },
    ]);

    const result = setMealPlan(1, '2026-05-18', 'breakfast', 'Pancakes', { recipeId: recipe.id });

    expect(result.issues).toHaveLength(2);
    const codes = result.issues?.map((issue) => issue.ingredientName).sort();
    expect(codes).toEqual(['Eggs', 'Milk']);
  });
});

describe('Cooking safety enforcement', () => {
  it('blocks substitutions that would introduce a stored allergy', () => {
    const recipe = addRecipe(1, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
      { name: 'Noodles', quantity: '100', unit: 'g' },
    ], { tenantId: 70 });
    setMealPlan(1, '2024-06-15', 'dinner', 'Peanut noodles', { recipeId: recipe.id, tenantId: 70 });
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'almonds' }, 70);

    expect(() => applyMealPlanSubstitution(1, {
      date: '2024-06-15',
      mealType: 'dinner',
      originalIngredient: 'Peanuts',
      suggestedIngredient: 'Almond butter',
      reason: 'disliked_ingredient',
    }, 70)).toThrow(/COOKING_SAFETY_BLOCKED: meal_plan_substitution contains allergy "almonds"/);

    expect(getRecipeById(1, recipe.id, 70)?.ingredients.map((ingredient) => ingredient.name)).toEqual(['Peanuts', 'Noodles']);
    expect(getMealPlan(1, '2024-06-15', '2024-06-15', 70)[0].title).toBe('Peanut noodles');
  });

  it('blocks recipe writes that conflict with a saved vegetarian restriction', () => {
    setCookingPreferenceMemory(1, { kind: 'dietary_restriction', value: 'vegetarian' }, 70);

    expect(() => addRecipe(1, 'Chicken bowl', [
      { name: 'Chicken breast', quantity: '200', unit: 'g' },
      { name: 'Rice', quantity: '100', unit: 'g' },
    ], { tenantId: 70 })).toThrow(/COOKING_SAFETY_BLOCKED: recipe contains dietary restriction "vegetarian"/);

    expect(getRecipes(1, { tenantId: 70 })).toHaveLength(0);
  });

  it('blocks meal-plan writes that conflict with a saved dairy-free restriction', () => {
    setCookingPreferenceMemory(1, { kind: 'dietary_restriction', value: 'dairy-free' }, 70);

    expect(() => setMealPlan(1, '2024-06-16', 'dinner', 'Vegetables with butter sauce', {
      tenantId: 70,
    })).toThrow(/COOKING_SAFETY_BLOCKED: meal_plan contains dietary restriction "dairy-free"/);

    expect(getMealPlan(1, '2024-06-16', '2024-06-16', 70)).toHaveLength(0);
  });

  it('allows substitutions that remove a stored allergen and replace it with a safe ingredient', () => {
    const recipe = addRecipe(1, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
      { name: 'Noodles', quantity: '100', unit: 'g' },
    ], {
      tenantId: 70,
      instructions: 'Toss noodles with peanuts.',
    });
    setMealPlan(1, '2024-06-15', 'dinner', 'Peanut noodles', {
      recipeId: recipe.id,
      notes: 'Use peanuts if available.',
      tenantId: 70,
    });
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'peanuts' }, 70);

    const result = applyMealPlanSubstitution(1, {
      date: '2024-06-15',
      mealType: 'dinner',
      originalIngredient: 'Peanuts',
      suggestedIngredient: 'sunflower seed butter',
      reason: 'allergy',
      updateShoppingList: false,
    }, 70);

    expect(result.applied).toBe(true);
    expect(result.recipe?.ingredients.map((ingredient) => ingredient.name)).toEqual(['sunflower seed butter', 'Noodles']);
    expect(result.meal?.title).toBe('sunflower seed butter noodles');
  });

  it('commits a safe substitution while another conflicting meal is withheld from regeneration', () => {
    const noodles = addRecipe(1, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
      { name: 'Noodles', quantity: '100', unit: 'g' },
    ], { tenantId: 70 });
    const curry = addRecipe(1, 'Peanut curry', [
      { name: 'Peanuts', quantity: '20', unit: 'g' },
      { name: 'Rice', quantity: '100', unit: 'g' },
    ], { tenantId: 70 });
    setMealPlan(1, '2024-06-17', 'dinner', 'Peanut noodles', { recipeId: noodles.id, tenantId: 70 });
    setMealPlan(1, '2024-06-18', 'dinner', 'Peanut curry', { recipeId: curry.id, tenantId: 70 });
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'peanuts' }, 70);

    const result = applyMealPlanSubstitution(1, {
      date: '2024-06-17',
      mealType: 'dinner',
      originalIngredient: 'Peanuts',
      suggestedIngredient: 'sunflower seed butter',
      reason: 'allergy',
    }, 70);

    expect(result.applied).toBe(true);
    expect(result.shoppingList?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Noodles' }),
      expect.objectContaining({ name: 'sunflower seed butter' }),
    ]));
    expect(result.shoppingList?.safetyIssues).toEqual([
      { code: 'ALLERGY_CONFLICT', itemName: 'Peanut curry' },
    ]);
    expect(getMealPlan(1, '2024-06-17', '2024-06-17', 70)[0]).toMatchObject({
      title: 'sunflower seed butter noodles',
      recipe_id: result.recipe?.id,
    });
  });

  it('matches ingredient tokens without rewriting unrelated substrings', () => {
    const hamburger = addRecipe(1, 'Hamburger plate', [
      { name: 'Hamburger patty', quantity: '1', unit: 'pcs' },
    ], { tenantId: 70 });
    setMealPlan(1, '2024-06-17', 'dinner', 'Hamburger plate', {
      recipeId: hamburger.id,
      tenantId: 70,
    });

    const unrelated = applyMealPlanSubstitution(1, {
      date: '2024-06-17',
      mealType: 'dinner',
      originalIngredient: 'ham',
      suggestedIngredient: 'tofu',
      reason: 'disliked_ingredient',
      updateShoppingList: false,
    }, 70);
    expect(unrelated).toEqual(expect.objectContaining({ applied: false, reason: 'ingredient_not_found' }));
    expect(getMealPlan(1, '2024-06-17', '2024-06-17', 70)[0].title).toBe('Hamburger plate');

    const chicken = addRecipe(1, 'Chicken breast bowl', [
      { name: 'Chicken breast', quantity: '180', unit: 'g' },
    ], { tenantId: 70 });
    setMealPlan(1, '2024-06-18', 'dinner', 'Chicken breast bowl', {
      recipeId: chicken.id,
      tenantId: 70,
    });
    const tokenMatch = applyMealPlanSubstitution(1, {
      date: '2024-06-18',
      mealType: 'dinner',
      originalIngredient: 'chicken',
      suggestedIngredient: 'tofu',
      reason: 'disliked_ingredient',
      updateShoppingList: false,
    }, 70);
    expect(tokenMatch.applied).toBe(true);
    expect(tokenMatch.recipe?.ingredients[0].name).toBe('tofu');
    expect(tokenMatch.meal?.title).toBe('tofu breast bowl');
  });

  it('rolls back the cloned recipe and meal rewrite when shopping refresh fails', () => {
    const recipe = addRecipe(1, 'Tomato pasta', [
      { name: 'Tomato', quantity: '2', unit: 'pcs' },
      { name: 'Pasta', quantity: '200', unit: 'g' },
    ], { tenantId: 70 });
    setMealPlan(1, '2024-06-17', 'dinner', 'Tomato pasta', {
      recipeId: recipe.id,
      tenantId: 70,
    });
    testDb.exec(`
      CREATE TRIGGER cooking_test_fail_shopping_refresh
      BEFORE INSERT ON shopping_lists
      BEGIN
        SELECT RAISE(ABORT, 'forced shopping refresh failure');
      END
    `);

    expect(() => applyMealPlanSubstitution(1, {
      date: '2024-06-17',
      mealType: 'dinner',
      originalIngredient: 'Tomato',
      suggestedIngredient: 'Courgette',
      reason: 'disliked_ingredient',
    }, 70)).toThrow(/forced shopping refresh failure/);

    expect(getRecipes(1, { tenantId: 70, limit: 10 }).map((item) => item.id)).toEqual([recipe.id]);
    expect(getMealPlan(1, '2024-06-17', '2024-06-17', 70)).toEqual([
      expect.objectContaining({ recipe_id: recipe.id, title: 'Tomato pasta' }),
    ]);
    expect(getShoppingList(1, '2024-06-17', 70)).toBeNull();
  });
});

describe('Shopping List', () => {
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
    expect(list.items.every((item) => item.checked === false)).toBe(true);
  });

  it('aggregates ingredients across multiple meals', () => {
    const breakfast = addRecipe(1, 'Eggs & Butter', [
      { name: 'Eggs', quantity: '3', unit: 'pcs' },
      { name: 'Butter', quantity: '20', unit: 'g' },
    ]);
    const dinner = addRecipe(1, 'Buttered steak', [
      { name: 'butter', quantity: '20', unit: 'g' },
      { name: 'Steak', quantity: '400', unit: 'g' },
    ]);
    setMealPlan(1, '2024-06-17', 'breakfast', 'Morning eggs', { recipeId: breakfast.id });
    setMealPlan(1, '2024-06-18', 'dinner', 'Buttered steak', { recipeId: dinner.id });

    const list = generateShoppingList(1, '2024-06-17');
    expect(list.items).toHaveLength(3);
    const eggs = list.items.find(i => i.name === 'Eggs')!;
    expect(eggs.quantity).toBe('3');
    expect(eggs.unit).toBe('pcs');
    const butter = list.items.filter((item) => item.name.toLowerCase() === 'butter');
    expect(butter).toHaveLength(1);
    expect(butter[0].quantity).toBe('40');
    expect(butter[0].unit).toBe('g');
  });

  it('does not drop compound quantities after encountering incompatible unit families', () => {
    const volume = addRecipe(1, 'Volume flour', [
      { name: 'Flour', quantity: '1', unit: 'cup' },
    ]);
    const mass = addRecipe(1, 'Mass flour', [
      { name: 'Flour', quantity: '100', unit: 'g' },
    ]);
    const moreVolume = addRecipe(1, 'More volume flour', [
      { name: 'Flour', quantity: '1', unit: 'cup' },
    ]);
    setMealPlan(1, '2024-06-17', 'breakfast', 'Volume flour', { recipeId: volume.id });
    setMealPlan(1, '2024-06-18', 'lunch', 'Mass flour', { recipeId: mass.id });
    setMealPlan(1, '2024-06-19', 'dinner', 'More volume flour', { recipeId: moreVolume.id });

    expect(generateShoppingList(1, '2024-06-17').items).toEqual([
      expect.objectContaining({
        name: 'Flour',
        quantity: '1 cup + 100 g + 1 cup',
        unit: '',
      }),
    ]);
  });

  it('requires a real Monday for generation but normalizes read and patch dates to their week', () => {
    expect(() => generateShoppingList(1, '2026-02-30')).toThrow(/COOKING_SHOPPING_LIST_INVALID_WEEK_START/);
    expect(() => generateShoppingList(1, '2024-06-18')).toThrow(/COOKING_SHOPPING_LIST_INVALID_WEEK_START/);
    expect(() => getShoppingList(1, '2026-02-30')).toThrow(/COOKING_SHOPPING_LIST_INVALID_WEEK_DATE/);

    const recipe = addRecipe(1, 'Tuesday list', [{ name: 'Rice', quantity: '100', unit: 'g' }]);
    setMealPlan(1, '2024-06-18', 'dinner', 'Tuesday list', { recipeId: recipe.id });
    generateShoppingList(1, '2024-06-17');

    expect(getShoppingList(1, '2024-06-18')).toMatchObject({ week_start: '2024-06-17' });
    expect(updateShoppingListItemChecked(1, '2024-06-23', 0, true)).toMatchObject({
      week_start: '2024-06-17',
      items: [expect.objectContaining({ name: 'Rice', checked: true })],
    });
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

  it('regenerates safe meals and discloses conflicting meals without blocking the week', () => {
    const safeRecipe = addRecipe(1, 'Rice bowl', [
      { name: 'Rice', quantity: '200', unit: 'g' },
    ], { tenantId: 70 });
    const unsafeRecipe = addRecipe(1, 'Peanut bowl', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
    ], { tenantId: 70 });
    setMealPlan(1, '2024-06-17', 'lunch', 'Rice bowl', { recipeId: safeRecipe.id, tenantId: 70 });
    generateShoppingList(1, '2024-06-17', 70);
    updateShoppingListItemChecked(1, '2024-06-17', 0, true, 70);
    setMealPlan(1, '2024-06-18', 'dinner', 'Peanut bowl', { recipeId: unsafeRecipe.id, tenantId: 70 });
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'peanuts' }, 70);

    expect(generateShoppingList(1, '2024-06-17', 70)).toMatchObject({
      items: [expect.objectContaining({ name: 'Rice', checked: true })],
      safetyIssues: [{ code: 'ALLERGY_CONFLICT', itemName: 'Peanut bowl' }],
    });

    const stored = testDb.prepare(
      'SELECT items FROM shopping_lists WHERE tenant_id = ? AND user_id = ? AND week_start = ?',
    ).get(70, 1, '2024-06-17') as { items: string };
    expect(JSON.parse(stored.items)).toEqual([
      expect.objectContaining({ name: 'Rice', checked: true }),
    ]);
  });

  it("does not apply another tenant's safety preferences to a shopping-list read", () => {
    const recipe = addRecipe(1, 'Peanut snack', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
    ], { tenantId: 101 });
    setMealPlan(1, '2024-06-17', 'snack', 'Peanut snack', { recipeId: recipe.id, tenantId: 101 });
    generateShoppingList(1, '2024-06-17', 101);
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'peanuts' }, 202);

    expect(getShoppingList(1, '2024-06-17', 101)?.items).toEqual([
      expect.objectContaining({ name: 'Peanuts' }),
    ]);
    expect(getShoppingList(1, '2024-06-17', 202)).toBeNull();
  });

  it('filters unsafe legacy items without deleting them when a visible item is checked', () => {
    const recipe = addRecipe(1, 'Apple and peanuts', [
      { name: 'Apple', quantity: '2', unit: 'pcs' },
      { name: 'Peanuts', quantity: '30', unit: 'g' },
    ], { tenantId: 70 });
    setMealPlan(1, '2024-06-17', 'snack', 'Apple and peanuts', { recipeId: recipe.id, tenantId: 70 });
    generateShoppingList(1, '2024-06-17', 70);
    setCookingPreferenceMemory(1, { kind: 'allergy', value: 'peanuts' }, 70);

    expect(getShoppingList(1, '2024-06-17', 70)).toMatchObject({
      items: [expect.objectContaining({ name: 'Apple', checked: false })],
      safetyIssues: [{ code: 'ALLERGY_CONFLICT', itemName: 'Peanuts' }],
    });

    const updated = updateShoppingListItemChecked(1, '2024-06-17', 0, true, 70);
    expect(updated).toMatchObject({
      items: [expect.objectContaining({ name: 'Apple', checked: true })],
      safetyIssues: [{ code: 'ALLERGY_CONFLICT', itemName: 'Peanuts' }],
    });

    const stored = testDb.prepare(
      'SELECT items FROM shopping_lists WHERE tenant_id = ? AND user_id = ? AND week_start = ?',
    ).get(70, 1, '2024-06-17') as { items: string };
    const storedItems = JSON.parse(stored.items);
    expect(storedItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Apple', checked: true }),
      expect.objectContaining({ name: 'Peanuts', checked: false }),
    ]));
    expect(storedItems).toHaveLength(2);
  });

  it('returns null for non-existent shopping list', () => {
    expect(getShoppingList(1, '2099-01-01')).toBeNull();
    expect(getShoppingList(1, '2024-06-24')).toBeNull();
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

  it('marks expired pantry matches as blocked inventory instead of available ingredients', () => {
    upsertPantryItem(1, {
      name: 'Arroz',
      quantity: '1',
      unit: 'kg',
      expiresAt: '2000-01-01',
    }, 101);
    const recipe = addRecipe(1, 'Arroz simples', [
      { name: 'Arroz', quantity: '250', unit: 'g' },
    ], { tenantId: 101 });
    setMealPlan(1, '2024-06-17', 'dinner', 'Arroz simples', { recipeId: recipe.id, tenantId: 101 });

    const list = generateShoppingList(1, '2024-06-17', 101);

    expect(list.items).toEqual([
      expect.objectContaining({
        name: 'Arroz',
        pantry_status: 'pantry_expired',
        pantry_note: 'Pantry item exists but is expired; do not use silently.',
      }),
    ]);
  });
});

describe('Pantry', () => {
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

  it('forces past-dated pantry items to expired even when marked fresh', () => {
    const item = upsertPantryItem(1, {
      name: 'Unsafe milk',
      expiresAt: '2000-01-01',
      freshnessStatus: 'fresh',
    }, 101);

    expect(item.freshness_status).toBe('expired');
  });

  it('keeps the most conservative freshness between expiry and supplied status', () => {
    const useSoonDate = new Date(Date.now() + (2 * 86400_000)).toISOString().slice(0, 10);
    const useSoon = upsertPantryItem(1, {
      name: 'Use-soon yogurt',
      expiresAt: useSoonDate,
      freshnessStatus: 'fresh',
    }, 101);
    const explicitlyExpired = upsertPantryItem(1, {
      name: 'Questionable rice',
      expiresAt: '2999-01-01',
      freshnessStatus: 'expired',
    }, 101);

    expect(useSoon.freshness_status).toBe('use_soon');
    expect(explicitlyExpired.freshness_status).toBe('expired');
  });

  it('recomputes freshness when only the expiry date changes', () => {
    const item = upsertPantryItem(1, {
      name: 'Spinach',
      freshnessStatus: 'expired',
    }, 101);

    const futureDated = updatePantryItem(1, item.id, { expiresAt: '2999-01-01' }, 101);
    expect(futureDated?.freshness_status).toBe('fresh');

    const pastDated = updatePantryItem(1, item.id, { expiresAt: '2000-01-01' }, 101);
    expect(pastDated?.freshness_status).toBe('expired');
  });

  it('does not persist derived expiry freshness during an unrelated edit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01T12:00:00.000Z'));
    const item = upsertPantryItem(1, {
      name: 'Archived oats',
      expiresAt: '2024-06-10',
      freshnessStatus: 'fresh',
    }, 101);
    expect(item.freshness_status).toBe('fresh');

    vi.setSystemTime(new Date('2024-06-11T12:00:00.000Z'));
    expect(getPantryItemById(1, item.id, 101)?.freshness_status).toBe('expired');

    const updated = updatePantryItem(1, item.id, { notes: 'Check before replacing' }, 101);
    const stored = testDb.prepare(
      'SELECT freshness_status, notes FROM cooking_pantry_items WHERE id = ?',
    ).get(item.id) as { freshness_status: string; notes: string | null };

    expect(updated?.freshness_status).toBe('expired');
    expect(stored).toEqual({ freshness_status: 'fresh', notes: 'Check before replacing' });
  });

  it('rejects invalid expiry dates before create or update persistence', () => {
    expect(() => upsertPantryItem(1, {
      name: 'Invalid milk',
      expiresAt: '2026-02-30',
    }, 101)).toThrow(/COOKING_PANTRY_INVALID_EXPIRY/);
    expect(getPantryItems(1, { tenantId: 101, includeExpired: true })).toEqual([]);

    const item = upsertPantryItem(1, { name: 'Valid milk' }, 101);
    expect(() => updatePantryItem(1, item.id, {
      expiresAt: 'not-a-date',
    }, 101)).toThrow(/COOKING_PANTRY_INVALID_EXPIRY/);
    expect(getPantryItemById(1, item.id, 101)?.expires_at).toBeNull();
  });

  it('rejects non-string pantry expiry values instead of coercing them to clear-expiry writes', () => {
    expect(() => upsertPantryItem(1, {
      name: 'Array expiry milk',
      expiresAt: [] as unknown as string,
    }, 101)).toThrow(/COOKING_PANTRY_INVALID_EXPIRY/);
    expect(getPantryItems(1, { tenantId: 101, includeExpired: true })).toEqual([]);

    const item = upsertPantryItem(1, { name: 'Valid expiry milk', expiresAt: '2999-01-01' }, 101);
    expect(() => updatePantryItem(1, item.id, {
      expiresAt: { date: '2000-01-01' } as unknown as string,
    }, 101)).toThrow(/COOKING_PANTRY_INVALID_EXPIRY/);
    expect(getPantryItemById(1, item.id, 101)?.expires_at).toBe('2999-01-01');
  });

  it('rejects invalid pantry statuses, confidence, and optional text before persistence', () => {
    const invalidWrites: PantryItemInput[] = [
      { name: { label: 'Object name' } as unknown as string },
      { name: 'Bad freshness', freshnessStatus: 'recent' },
      { name: 'Delete bypass', availabilityStatus: 'removed' },
      { name: 'Bad confidence', confidence: 1.5 },
      { name: 'Bad quantity', quantity: 3 as unknown as string },
    ];
    for (const input of invalidWrites) {
      expect(() => upsertPantryItem(1, input, 101)).toThrow(/COOKING_PANTRY_INVALID/);
    }
    expect(getPantryItems(1, { tenantId: 101, includeExpired: true })).toEqual([]);

    const item = upsertPantryItem(1, { name: 'Valid pantry item', freshnessStatus: 'fresh' }, 101);
    expect(() => updatePantryItem(1, item.id, { name: null as unknown as string }, 101))
      .toThrow(/COOKING_PANTRY_INVALID_NAME/);
    expect(() => updatePantryItem(1, item.id, { availabilityStatus: 'deleted' }, 101))
      .toThrow(/COOKING_PANTRY_INVALID_AVAILABILITY/);
    expect(() => updatePantryItem(1, item.id, { unexpected: true } as Partial<PantryItemInput>, 101))
      .toThrow(/COOKING_PANTRY_INVALID_UPDATE/);
    expect(getPantryItemById(1, item.id, 101)).toMatchObject({
      availability_status: 'available',
      freshness_status: 'fresh',
    });
    expect(() => getPantryItems(1, { tenantId: 101, limit: 2.5 }))
      .toThrow(/COOKING_PANTRY_INVALID_LIMIT/);
    expect(() => getPantryItems(1, { tenantId: 101, limit: 251 }))
      .toThrow(/COOKING_PANTRY_INVALID_LIMIT/);
  });

  it('derives effective freshness on reads when time has advanced since the last write', () => {
    const item = upsertPantryItem(1, {
      name: 'Stored-fresh milk',
      expiresAt: '2999-01-01',
      freshnessStatus: 'fresh',
    }, 101);
    testDb.prepare(`
      UPDATE cooking_pantry_items
      SET expires_at = '2000-01-01', freshness_status = 'fresh'
      WHERE id = ?
    `).run(item.id);

    expect(getPantryItemById(1, item.id, 101)?.freshness_status).toBe('expired');
    expect(getPantryItems(1, { tenantId: 101 })).toEqual([]);
    expect(getPantryItems(1, { tenantId: 101, includeExpired: true })).toEqual([
      expect.objectContaining({ id: item.id, freshness_status: 'expired' }),
    ]);
  });

  it('evaluates pantry expiry against the user local calendar date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T05:00:00.000Z'));
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, timezone, username)
      VALUES (?, ?, ?, ?)
    `).run(88, 880088, 'Pacific/Honolulu', 'honolulu-cook');

    const item = upsertPantryItem(88, {
      name: 'Local-date avocado',
      expiresAt: '2026-05-01',
      freshnessStatus: 'fresh',
    }, 88);

    expect(item.freshness_status).toBe('use_soon');
    expect(getPantryItemById(88, item.id, 88)?.freshness_status).toBe('use_soon');
    expect(getPantryItems(88, { tenantId: 88 }).map((entry) => entry.id)).toContain(item.id);
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

describe('Cooking schema and contract boundaries', () => {
  it('keeps runtime reads free of schema mutation and backfill helpers', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/services/cooking-chef.ts'),
      'utf8',
    );

    expect(source).not.toContain('ensureCookingTenantScopeColumns');
  });

  it('keeps the recipe, meal-plan, and shopping-list schema complete', () => {
    const tables = testDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('recipes','meal_plans','shopping_lists') ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(['meal_plans', 'recipes', 'shopping_lists']);

    const recipeColumns = testDb.prepare("PRAGMA table_info('recipes')").all() as Array<{ name: string }>;
    expect(recipeColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'id', 'tenant_id', 'owner_user_id', 'user_id', 'title', 'ingredients', 'instructions',
      'prep_time_min', 'cook_time_min', 'servings', 'tags', 'source', 'protein_g',
      'fat_g', 'carbs_g', 'calories_kcal', 'created_at', 'updated_at',
    ]));
  });

  it('enforces tenant-aware uniqueness for meal and shopping slots', () => {
    testDb.prepare("INSERT INTO meal_plans (tenant_id, owner_user_id, user_id, date, meal_type, title) VALUES (10, 1, 1, '2024-06-15', 'dinner', 'A')").run();
    expect(() => testDb.prepare("INSERT INTO meal_plans (tenant_id, owner_user_id, user_id, date, meal_type, title) VALUES (10, 1, 1, '2024-06-15', 'dinner', 'B')").run()).toThrow();
    expect(() => testDb.prepare("INSERT INTO meal_plans (tenant_id, owner_user_id, user_id, date, meal_type, title) VALUES (20, 1, 1, '2024-06-15', 'dinner', 'Tenant B')").run()).not.toThrow();

    testDb.prepare("INSERT INTO shopping_lists (tenant_id, owner_user_id, user_id, week_start, items) VALUES (10, 1, 1, '2024-06-17', '[]')").run();
    expect(() => testDb.prepare("INSERT INTO shopping_lists (tenant_id, owner_user_id, user_id, week_start, items) VALUES (10, 1, 1, '2024-06-17', '[]')").run()).toThrow();
    expect(() => testDb.prepare("INSERT INTO shopping_lists (tenant_id, owner_user_id, user_id, week_start, items) VALUES (20, 1, 1, '2024-06-17', '[]')").run()).not.toThrow();
  });

  it('requires explicit tenant and owner scope without user fallback', () => {
    const predicate = cookingPrivateScopePredicate();
    expect(predicate).toContain('tenant_id = ?');
    expect(predicate).toContain('owner_user_id = ?');
    expect(predicate).not.toMatch(/COALESCE\([^)]*tenant_id[^)]*user_id/i);
  });

  it('retains schema defaults and lookup indexes', () => {
    testDb.prepare("INSERT INTO recipes (tenant_id, owner_user_id, user_id, title, ingredients) VALUES (1, 1, 1, 'Test', '[]')").run();
    testDb.prepare("INSERT INTO shopping_lists (tenant_id, owner_user_id, user_id, week_start, items) VALUES (1, 1, 1, '2024-06-17', '[]')").run();
    expect((testDb.prepare("SELECT servings FROM recipes WHERE title = 'Test'").get() as { servings: number }).servings).toBe(1);
    expect((testDb.prepare("SELECT status FROM shopping_lists WHERE week_start = '2024-06-17'").get() as { status: string }).status).toBe('active');

    const indexes = testDb.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_recipes_user', 'idx_recipes_tags', 'idx_meal_plans_user', 'idx_shopping_user',
    ]));
  });
});

describe('Cooking CRUD edge matrices', () => {
  it('round-trips empty, special-character, Unicode, and large ingredient inputs', () => {
    const inputs: Array<{ title: string; ingredients: Ingredient[]; expectedCount: number }> = [
      { title: 'Mystery Dish', ingredients: [], expectedCount: 0 },
      { title: "Grandma's Steak & Eggs (Family Recipe)", ingredients: [{ name: 'Steak', quantity: '500', unit: 'g' }], expectedCount: 1 },
      { title: 'Brazilian Steak 🥩', ingredients: [{ name: 'Picanha 🥩', quantity: '1', unit: 'kg' }], expectedCount: 1 },
      {
        title: 'Complex Recipe',
        ingredients: Array.from({ length: 50 }, (_, index) => ({
          name: `Ingredient ${index + 1}`, quantity: `${index + 1}`, unit: 'g',
        })),
        expectedCount: 50,
      },
    ];

    for (const input of inputs) {
      const recipe = addRecipe(1, input.title, input.ingredients);
      expect(recipe.title).toBe(input.title);
      expect(recipe.ingredients).toHaveLength(input.expectedCount);
      expect(recipe.servings).toBe(1);
    }
  });

  it('returns safe empty and missing-record results', () => {
    expect(getRecipes(999)).toEqual([]);
    expect(deleteRecipe(1, 99999)).toBe(false);
  });

  it('enforces explicit and default recipe list limits', () => {
    for (let index = 0; index < 25; index += 1) {
      addRecipe(1, `Recipe ${index}`, [{ name: 'A', quantity: '1', unit: 'g' }]);
    }
    expect(getRecipes(1, { limit: 3 })).toHaveLength(3);
    expect(getRecipes(1)).toHaveLength(20);
    expect(() => getRecipes(1, { limit: 1.5 })).toThrow(/COOKING_RECIPE_INVALID_LIMIT/);
    expect(() => getRecipes(1, { limit: 101 })).toThrow(/COOKING_RECIPE_INVALID_LIMIT/);
  });

  it('prevents cross-user recipe deletion', () => {
    const recipe = addRecipe(1, 'User 1 Only', [{ name: 'A', quantity: '1', unit: 'g' }]);
    expect(deleteRecipe(2, recipe.id)).toBe(false);
    expect(getRecipes(1).map((item) => item.id)).toContain(recipe.id);
  });
});

describe('Meal-plan boundary matrices', () => {
  it('supports every meal type and returns deterministic date/type ordering', () => {
    for (const mealType of ['breakfast', 'lunch', 'dinner', 'snack']) {
      setMealPlan(1, '2024-06-15', mealType, `Meal: ${mealType}`);
    }
    setMealPlan(1, '2024-06-16', 'dinner', 'Later dinner');

    const plan = getMealPlan(1, '2024-06-15', '2024-06-16');
    expect(plan.slice(0, 4).map((meal) => meal.meal_type)).toEqual(['breakfast', 'dinner', 'lunch', 'snack']);
    expect(plan.at(-1)?.date).toBe('2024-06-16');
  });

  it('returns safe empty and missing-delete results', () => {
    expect(getMealPlan(1, '2024-06-15', '2024-06-21')).toEqual([]);
    expect(deleteMealPlan(1, '2099-01-01', 'dinner')).toBe(false);
  });

  it('isolates same-date meal slots between users', () => {
    setMealPlan(1, '2024-06-15', 'dinner', 'User 1 dinner');
    setMealPlan(2, '2024-06-15', 'dinner', 'User 2 dinner');
    expect(getMealPlan(1, '2024-06-15', '2024-06-15').map((meal) => meal.title)).toEqual(['User 1 dinner']);
    expect(getMealPlan(2, '2024-06-15', '2024-06-15').map((meal) => meal.title)).toEqual(['User 2 dinner']);
  });
});

describe('Shopping-list boundary matrices', () => {
  it('ignores meals without linked recipes without failing', () => {
    setMealPlan(1, '2024-06-17', 'dinner', 'Eating out');
    expect(generateShoppingList(1, '2024-06-17').items).toEqual([]);
  });

  it('covers exactly seven days from week start', () => {
    const recipe = addRecipe(1, 'R', [{ name: 'A', quantity: '1', unit: 'g' }]);
    setMealPlan(1, '2024-06-17', 'dinner', 'Day 1', { recipeId: recipe.id });
    setMealPlan(1, '2024-06-23', 'dinner', 'Day 7', { recipeId: recipe.id });
    setMealPlan(1, '2024-06-24', 'dinner', 'Day 8', { recipeId: recipe.id });
    expect(generateShoppingList(1, '2024-06-17').items).toEqual([
      expect.objectContaining({ name: 'A', quantity: '2', unit: 'g' }),
    ]);
  });

  it('regenerates the existing shopping-list record', () => {
    const firstRecipe = addRecipe(1, 'R', [{ name: 'A', quantity: '1', unit: 'g' }]);
    setMealPlan(1, '2024-06-17', 'dinner', 'Dinner', { recipeId: firstRecipe.id });
    const first = generateShoppingList(1, '2024-06-17');

    const secondRecipe = addRecipe(1, 'R2', [{ name: 'B', quantity: '2', unit: 'g' }]);
    setMealPlan(1, '2024-06-18', 'lunch', 'Lunch', { recipeId: secondRecipe.id });
    const second = generateShoppingList(1, '2024-06-17');
    expect(second.id).toBe(first.id);
    expect(second.items).toHaveLength(2);
  });

  it('isolates generated shopping lists between users', () => {
    const firstRecipe = addRecipe(1, 'User1', [{ name: 'A', quantity: '1', unit: 'g' }]);
    const secondRecipe = addRecipe(2, 'User2', [{ name: 'B', quantity: '1', unit: 'g' }]);
    setMealPlan(1, '2024-06-17', 'dinner', 'U1', { recipeId: firstRecipe.id });
    setMealPlan(2, '2024-06-17', 'dinner', 'U2', { recipeId: secondRecipe.id });
    expect(generateShoppingList(1, '2024-06-17').items.map((item) => item.name)).toEqual(['A']);
    expect(generateShoppingList(2, '2024-06-17').items.map((item) => item.name)).toEqual(['B']);
  });
});

describe('Cooking runtime assets and tool contract', () => {
  it('bounds cooking history to the eight most recent messages', () => {
    for (let index = 0; index < 10; index += 1) {
      addToConversation(1, 'cooking', 'user', `message-${index}`, 1);
    }
    expect(getConversationHistory(1, 'cooking', 1).map((message) => message.content)).toEqual(
      Array.from({ length: 8 }, (_, index) => `message-${index + 2}`),
    );
  });

  it('keeps the cooking prompt substantial and transport agnostic', () => {
    const promptPath = path.resolve(__dirname, '../../prompts/cooking.md');
    expect(fs.existsSync(promptPath)).toBe(true);
    const content = fs.readFileSync(promptPath, 'utf-8');
    expect(content.length).toBeGreaterThan(100);
    expect(content.toLowerCase()).toContain('carnivore');
    expect(content.toLowerCase()).toContain('budget');
    expect(content.toLowerCase()).toContain('calendar');
    expect(content).toContain('Do NOT use HTML tags');
    expect(content).not.toContain('Telegram HTML only');
  });

  it('exposes the exact cooking tool set', () => {
    const cookingTools = TOOLS.filter((tool) => tool.name.startsWith('cooking_'));
    expect(cookingTools.map((tool) => tool.name).sort()).toEqual([
      'cooking_add_recipe', 'cooking_delete_meal', 'cooking_delete_pantry_item',
      'cooking_delete_recipe', 'cooking_generate_shopping_list', 'cooking_get_meal_plan',
      'cooking_get_pantry', 'cooking_get_preferences', 'cooking_get_recipes',
      'cooking_get_shopping_list', 'cooking_set_meal', 'cooking_set_preference',
      'cooking_upsert_pantry_item',
    ]);
  });

  it('keeps cooking write-tool schemas strict', () => {
    const addRecipeTool = TOOLS.find((tool) => tool.name === 'cooking_add_recipe');
    const setMealTool = TOOLS.find((tool) => tool.name === 'cooking_set_meal');
    expect(addRecipeTool?.input_schema.required).toEqual(expect.arrayContaining(['title', 'ingredients']));
    expect(setMealTool?.input_schema.required).toEqual(expect.arrayContaining(['date', 'meal_type', 'title']));
    expect((setMealTool?.input_schema.properties as any).meal_type.enum).toEqual([
      'breakfast', 'lunch', 'dinner', 'snack',
    ]);
  });
});
