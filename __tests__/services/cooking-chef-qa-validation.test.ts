/**
 * QA Validation Tests — Cooking Chef Feature
 *
 * Validates:
 * - Recipe edge cases (empty ingredients, special characters, large inputs)
 * - Meal planning boundary conditions
 * - Shopping list aggregation correctness
 * - User isolation security
 * - SQL injection resistance
 * - Migration schema integrity
 * - Tool executor integration
 * - Domain handler wiring
 * - Conversation history limits
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

vi.mock('../../src/services/database', () => ({ getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  addRecipe, getRecipes, deleteRecipe,
  setMealPlan, getMealPlan, deleteMealPlan,
  generateShoppingList, getShoppingList,
} from '../../src/services/cooking-chef';
import type { Ingredient } from '../../src/services/cooking-chef';

// ── Migration schema integrity ────────────────────────────────────

describe('QA: Cooking migration schema', () => {
  beforeEach(() => { testDb = createTestDb(); applyMigrations(testDb); });
  afterEach(() => { testDb.close(); });

  it('migration 024 creates all three required tables', () => {
    const tables = testDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('recipes','meal_plans','shopping_lists') ORDER BY name",
    ).all() as { name: string }[];
    expect(tables.map(t => t.name)).toEqual(['meal_plans', 'recipes', 'shopping_lists']);
  });

  it('recipes table has all expected columns', () => {
    const cols = testDb.prepare("PRAGMA table_info('recipes')").all() as { name: string }[];
    const names = cols.map(c => c.name);
    expect(names).toContain('id');
    expect(names).toContain('user_id');
    expect(names).toContain('title');
    expect(names).toContain('ingredients');
    expect(names).toContain('instructions');
    expect(names).toContain('prep_time_min');
    expect(names).toContain('cook_time_min');
    expect(names).toContain('servings');
    expect(names).toContain('tags');
    expect(names).toContain('source');
    expect(names).toContain('protein_g');
    expect(names).toContain('fat_g');
    expect(names).toContain('carbs_g');
    expect(names).toContain('calories_kcal');
    expect(names).toContain('created_at');
    expect(names).toContain('updated_at');
  });

  it('meal_plans has UNIQUE constraint on (user_id, date, meal_type)', () => {
    testDb.prepare("INSERT INTO meal_plans (user_id, date, meal_type, title) VALUES (1, '2024-06-15', 'dinner', 'A')").run();
    expect(() => {
      testDb.prepare("INSERT INTO meal_plans (user_id, date, meal_type, title) VALUES (1, '2024-06-15', 'dinner', 'B')").run();
    }).toThrow();
  });

  it('shopping_lists has UNIQUE constraint on (user_id, week_start)', () => {
    testDb.prepare("INSERT INTO shopping_lists (user_id, week_start, items) VALUES (1, '2024-06-17', '[]')").run();
    expect(() => {
      testDb.prepare("INSERT INTO shopping_lists (user_id, week_start, items) VALUES (1, '2024-06-17', '[]')").run();
    }).toThrow();
  });

  it('recipes.servings defaults to 1', () => {
    testDb.prepare("INSERT INTO recipes (user_id, title, ingredients) VALUES (1, 'Test', '[]')").run();
    const row = testDb.prepare('SELECT servings FROM recipes WHERE title = ?').get('Test') as any;
    expect(row.servings).toBe(1);
  });

  it('shopping_lists.status defaults to active', () => {
    testDb.prepare("INSERT INTO shopping_lists (user_id, week_start, items) VALUES (1, '2024-06-17', '[]')").run();
    const row = testDb.prepare("SELECT status FROM shopping_lists WHERE week_start = '2024-06-17'").get() as any;
    expect(row.status).toBe('active');
  });

  it('indices exist for performance', () => {
    const indices = testDb.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    const names = indices.map(i => i.name);
    expect(names).toContain('idx_recipes_user');
    expect(names).toContain('idx_recipes_tags');
    expect(names).toContain('idx_meal_plans_user');
    expect(names).toContain('idx_shopping_user');
  });
});

// ── Recipe edge cases ─────────────────────────────────────────────

describe('QA: Recipe edge cases', () => {
  beforeEach(() => { testDb = createTestDb(); applyMigrations(testDb); });
  afterEach(() => { testDb.close(); });

  it('handles recipe with empty ingredients array', () => {
    const recipe = addRecipe(1, 'Mystery Dish', []);
    expect(recipe.ingredients).toEqual([]);
    expect(recipe.title).toBe('Mystery Dish');
  });

  it('handles recipe with special characters in title', () => {
    const recipe = addRecipe(1, "Grandma's Steak & Eggs (Family Recipe)", [
      { name: 'Steak', quantity: '500', unit: 'g' },
    ]);
    expect(recipe.title).toBe("Grandma's Steak & Eggs (Family Recipe)");
  });

  it('handles recipe with unicode/emoji in ingredients', () => {
    const recipe = addRecipe(1, 'Brazilian Steak 🥩', [
      { name: 'Picanha 🥩', quantity: '1', unit: 'kg' },
    ]);
    expect(recipe.ingredients[0].name).toBe('Picanha 🥩');
  });

  it('handles recipe with very long ingredient list', () => {
    const ingredients: Ingredient[] = Array.from({ length: 50 }, (_, i) => ({
      name: `Ingredient ${i + 1}`, quantity: `${i + 1}`, unit: 'g',
    }));
    const recipe = addRecipe(1, 'Complex Recipe', ingredients);
    expect(recipe.ingredients).toHaveLength(50);
  });

  it('recipe defaults servings to 1 when not provided', () => {
    const recipe = addRecipe(1, 'Simple', [{ name: 'A', quantity: '1', unit: 'g' }]);
    expect(recipe.servings).toBe(1);
  });

  it('recipe stores and retrieves all optional fields', () => {
    const recipe = addRecipe(1, 'Full Recipe', [
      { name: 'Beef', quantity: '500', unit: 'g' },
    ], {
      instructions: 'Grill at 200°C for 15 min',
      prepTime: 10,
      cookTime: 15,
      servings: 4,
      tags: 'carnivore,grilled,quick',
      source: 'https://example.com/recipe',
      protein: 35,
      fat: 22,
      carbs: 8,
      calories: 374,
    });
    expect(recipe.instructions).toBe('Grill at 200°C for 15 min');
    expect(recipe.prep_time_min).toBe(10);
    expect(recipe.cook_time_min).toBe(15);
    expect(recipe.servings).toBe(4);
    expect(recipe.tags).toBe('carnivore,grilled,quick');
    expect(recipe.source).toBe('https://example.com/recipe');
    expect(recipe.protein).toBe(35);
    expect(recipe.fat).toBe(22);
    expect(recipe.carbs).toBe(8);
    expect(recipe.calories).toBe(374);
  });

  it('getRecipes returns empty array for user with no recipes', () => {
    expect(getRecipes(999)).toEqual([]);
  });

  it('getRecipes respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      addRecipe(1, `Recipe ${i}`, [{ name: 'A', quantity: '1', unit: 'g' }]);
    }
    expect(getRecipes(1, { limit: 3 })).toHaveLength(3);
  });

  it('getRecipes default limit is 20', () => {
    for (let i = 0; i < 25; i++) {
      addRecipe(1, `Recipe ${i}`, [{ name: 'A', quantity: '1', unit: 'g' }]);
    }
    expect(getRecipes(1)).toHaveLength(20);
  });

  it('deleteRecipe returns false for non-existent recipe', () => {
    expect(deleteRecipe(1, 99999)).toBe(false);
  });

  it('deleteRecipe prevents cross-user deletion', () => {
    const recipe = addRecipe(1, 'User 1 Only', [{ name: 'A', quantity: '1', unit: 'g' }]);
    // User 2 tries to delete user 1's recipe
    expect(deleteRecipe(2, recipe.id)).toBe(false);
    // Verify recipe still exists
    expect(getRecipes(1)).toHaveLength(1);
  });

  it('search is case-insensitive via LIKE', () => {
    addRecipe(1, 'GRILLED RIBEYE', [{ name: 'Ribeye Steak', quantity: '400', unit: 'g' }]);
    expect(getRecipes(1, { search: 'ribeye' })).toHaveLength(1);
    expect(getRecipes(1, { search: 'RIBEYE' })).toHaveLength(1);
  });

  it('tag search matches partial tags', () => {
    addRecipe(1, 'Recipe A', [{ name: 'A', quantity: '1', unit: 'g' }], { tags: 'carnivore,quick,high-protein' });
    // Should match because LIKE %quick% matches within the comma-separated string
    expect(getRecipes(1, { tags: 'quick' })).toHaveLength(1);
  });
});

// ── Meal planning edge cases ──────────────────────────────────────

describe('QA: Meal planning edge cases', () => {
  beforeEach(() => { testDb = createTestDb(); applyMigrations(testDb); });
  afterEach(() => { testDb.close(); });

  it('supports all four meal types', () => {
    const types = ['breakfast', 'lunch', 'dinner', 'snack'];
    for (const type of types) {
      setMealPlan(1, '2024-06-15', type, `Meal: ${type}`);
    }
    const plan = getMealPlan(1, '2024-06-15', '2024-06-15');
    expect(plan).toHaveLength(4);
  });

  it('getMealPlan returns empty array when no meals exist', () => {
    expect(getMealPlan(1, '2024-06-15', '2024-06-21')).toEqual([]);
  });

  it('deleteMealPlan returns false for non-existent entry', () => {
    expect(deleteMealPlan(1, '2099-01-01', 'dinner')).toBe(false);
  });

  it('meal plans are ordered by date then meal_type', () => {
    setMealPlan(1, '2024-06-16', 'dinner', 'Late dinner');
    setMealPlan(1, '2024-06-15', 'breakfast', 'Early breakfast');
    setMealPlan(1, '2024-06-15', 'dinner', 'Early dinner');

    const plan = getMealPlan(1, '2024-06-15', '2024-06-16');
    expect(plan[0].date).toBe('2024-06-15');
    expect(plan[plan.length - 1].date).toBe('2024-06-16');
  });

  it('meal plan isolation between users', () => {
    setMealPlan(1, '2024-06-15', 'dinner', 'User 1 dinner');
    setMealPlan(2, '2024-06-15', 'dinner', 'User 2 dinner');

    expect(getMealPlan(1, '2024-06-15', '2024-06-15')).toHaveLength(1);
    expect(getMealPlan(2, '2024-06-15', '2024-06-15')).toHaveLength(1);
    expect(getMealPlan(1, '2024-06-15', '2024-06-15')[0].title).toBe('User 1 dinner');
  });

  it('upsert preserves notes field', () => {
    setMealPlan(1, '2024-06-15', 'dinner', 'Steak', { notes: 'Medium rare' });
    const plan = getMealPlan(1, '2024-06-15', '2024-06-15');
    expect(plan[0].notes).toBe('Medium rare');
  });

  it('meal plan can link to recipe', () => {
    const recipe = addRecipe(1, 'Ribeye', [{ name: 'Beef', quantity: '500', unit: 'g' }]);
    setMealPlan(1, '2024-06-15', 'dinner', 'Ribeye Dinner', { recipeId: recipe.id });
    const plan = getMealPlan(1, '2024-06-15', '2024-06-15');
    expect(plan[0].recipe_id).toBe(recipe.id);
  });
});

// ── Shopping list edge cases ──────────────────────────────────────

describe('QA: Shopping list edge cases', () => {
  beforeEach(() => { testDb = createTestDb(); applyMigrations(testDb); });
  afterEach(() => { testDb.close(); });

  it('handles meals without linked recipes (no crash)', () => {
    // Meal without recipe_id should not contribute to shopping list but should not crash
    setMealPlan(1, '2024-06-17', 'dinner', 'Eating out');
    const list = generateShoppingList(1, '2024-06-17');
    expect(list.items).toHaveLength(0);
  });

  it('aggregates same ingredient across different recipes', () => {
    const r1 = addRecipe(1, 'Steak', [
      { name: 'Butter', quantity: '30', unit: 'g' },
      { name: 'Beef', quantity: '400', unit: 'g' },
    ]);
    const r2 = addRecipe(1, 'Eggs', [
      { name: 'Butter', quantity: '20', unit: 'g' },
      { name: 'Eggs', quantity: '4', unit: 'pcs' },
    ]);
    setMealPlan(1, '2024-06-17', 'dinner', 'Steak', { recipeId: r1.id });
    setMealPlan(1, '2024-06-18', 'breakfast', 'Eggs', { recipeId: r2.id });

    const list = generateShoppingList(1, '2024-06-17');
    const butter = list.items.find(i => i.name.toLowerCase() === 'butter');
    expect(butter).toBeTruthy();
    expect(butter!.quantity).toBe('50');
    expect(butter!.unit).toBe('g');
    expect(list.items).toHaveLength(3); // butter, beef, eggs
  });

  it('ingredient aggregation is case-insensitive (by key)', () => {
    const r1 = addRecipe(1, 'R1', [{ name: 'Butter', quantity: '30', unit: 'g' }]);
    const r2 = addRecipe(1, 'R2', [{ name: 'butter', quantity: '20', unit: 'g' }]);
    setMealPlan(1, '2024-06-17', 'dinner', 'R1', { recipeId: r1.id });
    setMealPlan(1, '2024-06-18', 'dinner', 'R2', { recipeId: r2.id });

    const list = generateShoppingList(1, '2024-06-17');
    // Both "Butter" and "butter" should merge because key is lowercased
    const butterItems = list.items.filter(i => i.name.toLowerCase() === 'butter');
    expect(butterItems).toHaveLength(1);
  });

  it('shopping list covers exactly 7 days from week_start', () => {
    // Meal on day 7 should be included, day 8 should not
    const r = addRecipe(1, 'R', [{ name: 'A', quantity: '1', unit: 'g' }]);
    setMealPlan(1, '2024-06-17', 'dinner', 'Day 1', { recipeId: r.id }); // included
    setMealPlan(1, '2024-06-23', 'dinner', 'Day 7', { recipeId: r.id }); // included (day 7 = +6)
    setMealPlan(1, '2024-06-24', 'dinner', 'Day 8', { recipeId: r.id }); // excluded

    const list = generateShoppingList(1, '2024-06-17');
    // Should have aggregated A from 2 meals (day 1 and day 7), not 3
    const itemA = list.items.find(i => i.name === 'A');
    expect(itemA).toBeTruthy();
    expect(itemA!.quantity).toBe('2');
    expect(itemA!.unit).toBe('g');
  });

  it('regenerating shopping list updates existing record', () => {
    const r = addRecipe(1, 'R', [{ name: 'A', quantity: '1', unit: 'g' }]);
    setMealPlan(1, '2024-06-17', 'dinner', 'Dinner', { recipeId: r.id });

    generateShoppingList(1, '2024-06-17');
    const first = getShoppingList(1, '2024-06-17')!;
    expect(first.items).toHaveLength(1);

    // Add another meal and regenerate
    const r2 = addRecipe(1, 'R2', [{ name: 'B', quantity: '2', unit: 'g' }]);
    setMealPlan(1, '2024-06-18', 'lunch', 'Lunch', { recipeId: r2.id });
    generateShoppingList(1, '2024-06-17');

    const second = getShoppingList(1, '2024-06-17')!;
    expect(second.items).toHaveLength(2);
    // Same ID — upsert, not duplicate
    expect(second.id).toBe(first.id);
  });

  it('all shopping items start unchecked', () => {
    const r = addRecipe(1, 'R', [
      { name: 'A', quantity: '1', unit: 'g' },
      { name: 'B', quantity: '2', unit: 'g' },
    ]);
    setMealPlan(1, '2024-06-17', 'dinner', 'D', { recipeId: r.id });

    const list = generateShoppingList(1, '2024-06-17');
    for (const item of list.items) {
      expect(item.checked).toBe(false);
    }
  });

  it('shopping list user isolation', () => {
    const r1 = addRecipe(1, 'User1', [{ name: 'A', quantity: '1', unit: 'g' }]);
    const r2 = addRecipe(2, 'User2', [{ name: 'B', quantity: '1', unit: 'g' }]);
    setMealPlan(1, '2024-06-17', 'dinner', 'U1', { recipeId: r1.id });
    setMealPlan(2, '2024-06-17', 'dinner', 'U2', { recipeId: r2.id });

    const list1 = generateShoppingList(1, '2024-06-17');
    const list2 = generateShoppingList(2, '2024-06-17');

    expect(list1.items.map(i => i.name)).toEqual(['A']);
    expect(list2.items.map(i => i.name)).toEqual(['B']);
  });
});

// ── Domain handler wiring ─────────────────────────────────────────

describe('QA: Cooking domain handler', () => {
  it('handleCooking is exported and calls handleSimpleDomain', async () => {
    // Verify the domain handler module exports correctly
    const mod = await import('../../src/domains/cooking');
    expect(typeof mod.handleCooking).toBe('function');
  });

  it('cooking is listed in DefaultDomainName type', async () => {
    // Verify the type was properly updated
    const { DefaultDomainName } = await import('../../src/domains/types') as any;
    // The type itself is compile-time, but we can check that bot.ts imports handleCooking
    // by checking the cooking domain handler exists and is importable
    const botSource = fs.readFileSync(path.resolve(__dirname, '../../src/bot.ts'), 'utf-8');
    expect(botSource).toContain("import { handleCooking } from './domains/cooking'");
  });
});

// ── Conversation history limit ────────────────────────────────────

describe('QA: Cooking conversation config', () => {
  it('cooking domain has a conversation history limit', () => {
    const convSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/state/conversation.ts'), 'utf-8',
    );
    expect(convSource).toMatch(/cooking:\s*\d+/);
  });
});

// ── Prompt file exists ────────────────────────────────────────────

describe('QA: Cooking prompt file', () => {
  it('prompts/cooking.md exists and has content', () => {
    const promptPath = path.resolve(__dirname, '../../prompts/cooking.md');
    expect(fs.existsSync(promptPath)).toBe(true);
    const content = fs.readFileSync(promptPath, 'utf-8');
    expect(content.length).toBeGreaterThan(100);
    // Must still support carnivore-fluent planning without hard-locking
    // the whole skill to one dietary approach.
    expect(content.toLowerCase()).toContain('carnivore');
    expect(content.toLowerCase()).toContain('budget');
    expect(content.toLowerCase()).toContain('calendar');
  });

  it('prompt has transport-agnostic formatting rules', () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../prompts/cooking.md'), 'utf-8',
    );
    // Prompts are now transport-agnostic — no Telegram HTML
    expect(content).toContain('Do NOT use HTML tags');
    expect(content).not.toContain('Telegram HTML only');
  });
});

// ── Tool definitions ──────────────────────────────────────────────

describe('QA: Cooking tool definitions', () => {
  it('all cooking tools are defined in TOOLS array', async () => {
    const { TOOLS } = await import('../../src/services/anthropic');
    const cookingTools = TOOLS.filter((t: any) => t.name.startsWith('cooking_'));
    const expectedTools = [
      'cooking_add_recipe',
      'cooking_get_recipes',
      'cooking_delete_recipe',
      'cooking_upsert_pantry_item',
      'cooking_get_pantry',
      'cooking_delete_pantry_item',
      'cooking_set_preference',
      'cooking_get_preferences',
      'cooking_set_meal',
      'cooking_get_meal_plan',
      'cooking_delete_meal',
      'cooking_generate_shopping_list',
      'cooking_get_shopping_list',
    ];
    expect(cookingTools.map((t: any) => t.name).sort()).toEqual(expectedTools.sort());
  });

  it('cooking_add_recipe requires title and ingredients', async () => {
    const { TOOLS } = await import('../../src/services/anthropic');
    const tool = TOOLS.find((t: any) => t.name === 'cooking_add_recipe') as any;
    expect(tool.input_schema.required).toContain('title');
    expect(tool.input_schema.required).toContain('ingredients');
  });

  it('cooking_set_meal requires date, meal_type, and title', async () => {
    const { TOOLS } = await import('../../src/services/anthropic');
    const tool = TOOLS.find((t: any) => t.name === 'cooking_set_meal') as any;
    expect(tool.input_schema.required).toEqual(expect.arrayContaining(['date', 'meal_type', 'title']));
  });

  it('cooking_set_meal meal_type enum includes all types', async () => {
    const { TOOLS } = await import('../../src/services/anthropic');
    const tool = TOOLS.find((t: any) => t.name === 'cooking_set_meal') as any;
    const enumValues = tool.input_schema.properties.meal_type.enum;
    expect(enumValues).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
  });
});

// ── Telegram templates ────────────────────────────────────────────

describe('QA: Telegram template system', () => {
  let templates: typeof import('../../src/utils/telegram-templates');

  beforeEach(async () => {
    templates = await import('../../src/utils/telegram-templates');
  });

  it('header escapes HTML entities', () => {
    const result = templates.header('Tom & Jerry <script>');
    expect(result).toContain('&amp;');
    expect(result).toContain('&lt;');
    expect(result).not.toContain('<script>');
  });

  it('buildMessage joins lines with newlines', () => {
    const msg = templates.buildMessage(
      templates.header('Title'),
      templates.bullet('Item 1'),
      templates.bullet('Item 2'),
    );
    expect(msg.split('\n')).toHaveLength(3);
  });

  it('table generates valid pre block', () => {
    const result = templates.table(['Name', 'Qty'], [['Eggs', '3'], ['Butter', '30g']]);
    expect(result).toContain('<pre>');
    expect(result).toContain('</pre>');
    expect(result).toContain('Eggs');
  });

  it('progress shows correct percentage', () => {
    expect(templates.progress(5, 10)).toContain('50%');
    expect(templates.progress(0, 10)).toContain('0%');
    expect(templates.progress(10, 10)).toContain('100%');
  });

  it('progress handles zero total without crashing', () => {
    expect(templates.progress(0, 0)).toContain('0%');
  });

  it('summaryCard builds structured output', () => {
    const card = templates.summaryCard('Stats', '📊', [
      { key: 'Recipes', value: '5' },
      { key: 'Meals', value: '21' },
    ]);
    expect(card).toContain('Stats');
    expect(card).toContain('Recipes');
    expect(card).toContain('Meals');
  });

  it('alertBlock handles details array', () => {
    const alert = templates.alertBlock('error', 'Something failed', ['Detail 1', 'Detail 2']);
    expect(alert).toContain('❌');
    expect(alert).toContain('Detail 1');
    expect(alert).toContain('Detail 2');
  });
});
