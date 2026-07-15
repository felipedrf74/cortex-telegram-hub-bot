import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
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


import { addRecipe, setMealPlan } from '../../src/services/cooking-chef';
import { assessCookingMealPlan } from '../../src/services/cooking-intelligence';
import {
  buildCookingPreferenceReadModel,
  getCookingPreferenceMemories,
  setCookingPreferenceMemory,
} from '../../src/services/cooking-preferences';

describe('cooking preference memory adapter', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('writes user-private Cooking preferences and builds an assessment-ready profile', () => {
    setCookingPreferenceMemory(7, { kind: 'allergy', value: 'Peanuts', source: 'user_correction' }, 70);
    setCookingPreferenceMemory(7, { kind: 'disliked_ingredient', value: 'mushrooms' }, 70);
    setCookingPreferenceMemory(7, { kind: 'weekday_max_prep_minutes', value: 20 }, 70);
    setCookingPreferenceMemory(7, { kind: 'budget_limit', value: 80 }, 70);
    setCookingPreferenceMemory(7, { kind: 'budget_currency', value: 'eur' }, 70);

    const readModel = buildCookingPreferenceReadModel(7, 70);

    expect(readModel.profile).toEqual(expect.objectContaining({
      allergies: ['Peanuts'],
      dislikedIngredients: ['mushrooms'],
      weekdayMaxPrepMinutes: 20,
      budgetLimit: 80,
      budgetCurrency: 'EUR',
    }));
    expect(readModel.summary).toContain('Allergies: Peanuts');
    expect(readModel.memories.every((memory) => memory.scope === 'user_private')).toBe(true);
  });

  it('applies corrections by superseding the older preference memory', () => {
    const first = setCookingPreferenceMemory(7, {
      kind: 'weekday_max_prep_minutes',
      value: 45,
      source: 'onboarding',
    }, 70);

    const corrected = setCookingPreferenceMemory(7, {
      kind: 'weekday_max_prep_minutes',
      value: 20,
      correction: true,
      source: 'chat_correction',
    }, 70);

    expect(corrected.freshnessStatus).toBe('corrected');
    expect(corrected.correctionParentMemoryId).toBe(first.memoryId);
    expect(buildCookingPreferenceReadModel(7, 70).profile.weekdayMaxPrepMinutes).toBe(20);

    const rows = testDb.prepare(`
      SELECT memory_value, status, freshness_status
      FROM skill_memories
      WHERE skill_id = 'cooking' AND memory_key = 'weekday_max_prep_minutes'
      ORDER BY id ASC
    `).all() as Array<{ memory_value: string; status: string; freshness_status: string }>;
    expect(rows).toEqual([
      { memory_value: '45', status: 'superseded', freshness_status: 'stale' },
      { memory_value: '20', status: 'active', freshness_status: 'corrected' },
    ]);
  });

  it('partitions same-user Cooking preferences by active tenant', () => {
    setCookingPreferenceMemory(7, { kind: 'disliked_ingredient', value: 'mushrooms' }, 70);
    setCookingPreferenceMemory(7, { kind: 'disliked_ingredient', value: 'cilantro' }, 71);

    expect(buildCookingPreferenceReadModel(7, 70).profile.dislikedIngredients).toEqual(['mushrooms']);
    expect(buildCookingPreferenceReadModel(7, 71).profile.dislikedIngredients).toEqual(['cilantro']);
    expect(getCookingPreferenceMemories(8, 70)).toEqual([]);
  });

  it('fails closed when preference memory is accessed without an active tenant', () => {
    expect(() => setCookingPreferenceMemory(7, {
      kind: 'disliked_ingredient',
      value: 'mushrooms',
    })).toThrow(/COOKING_PREFERENCE_SCOPE/);

    expect(() => buildCookingPreferenceReadModel(7)).toThrow(/COOKING_PREFERENCE_SCOPE/);
  });

  it('feeds preference memory into meal-plan safety assessment for existing unsafe plans', () => {
    const recipe = addRecipe(7, 'Peanut noodles', [
      { name: 'Peanuts', quantity: '30', unit: 'g' },
      { name: 'Noodles', quantity: '100', unit: 'g' },
    ], { tenantId: 70 });
    const meal = setMealPlan(7, '2026-04-30', 'dinner', 'Peanut noodles', {
      recipeId: recipe.id,
      tenantId: 70,
    });
    setCookingPreferenceMemory(7, { kind: 'allergy', value: 'peanuts' }, 70);

    const assessment = assessCookingMealPlan({
      meals: [meal],
      recipesById: new Map([[recipe.id, recipe]]),
      preferences: buildCookingPreferenceReadModel(7, 70).profile,
    });

    expect(assessment.status).toBe('blocked');
    expect(assessment.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        ingredient: 'Peanuts',
        substitutionSuggestions: expect.arrayContaining([
          expect.objectContaining({
            originalIngredient: 'Peanuts',
            suggestedIngredient: 'sunflower seed butter',
            reason: 'allergy',
          }),
        ]),
      }),
    ]));
    expect(assessment.substitutionSuggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ originalIngredient: 'Peanuts', reason: 'allergy' }),
    ]));
  });

  it('rejects unsafe or invalid preference writes before durable memory storage', () => {
    expect(() => setCookingPreferenceMemory(7, {
      kind: 'budget_currency',
      value: 'EURO',
    }, 70)).toThrow(/COOKING_PREFERENCE_INVALID/);

    expect(() => setCookingPreferenceMemory(7, {
      kind: 'grocery_preference',
      value: 'postgres://user:password@example/db',
    }, 70)).toThrow(/SKILL_MEMORY_UNSAFE/);
  });
});
