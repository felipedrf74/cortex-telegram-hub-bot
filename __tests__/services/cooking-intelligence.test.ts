import { describe, expect, it } from 'vitest';

import {
  assessCookingMealPlan,
  buildCookingPreferenceMemorySummary,
} from '../../src/services/cooking-intelligence';
import type { MealPlan, Recipe, ShoppingList } from '../../src/services/cooking-chef';

function meal(overrides: Partial<MealPlan>): MealPlan {
  return {
    id: overrides.id ?? 1,
    tenant_id: overrides.tenant_id ?? 1,
    user_id: overrides.user_id ?? 1,
    owner_user_id: overrides.owner_user_id ?? 1,
    visibility_scope: overrides.visibility_scope ?? 'user_private',
    lifecycle_state: overrides.lifecycle_state ?? 'planned',
    scope_status: overrides.scope_status ?? 'active',
    date: overrides.date ?? '2026-05-04',
    meal_type: overrides.meal_type ?? 'dinner',
    recipe_id: overrides.recipe_id ?? 10,
    title: overrides.title ?? 'Chicken rice bowl',
    notes: overrides.notes ?? null,
    created_at: overrides.created_at ?? '2026-05-01T00:00:00.000Z',
  };
}

function recipe(overrides: Partial<Recipe>): Recipe {
  return {
    id: overrides.id ?? 10,
    tenant_id: overrides.tenant_id ?? 1,
    user_id: overrides.user_id ?? 1,
    owner_user_id: overrides.owner_user_id ?? 1,
    visibility_scope: overrides.visibility_scope ?? 'user_private',
    lifecycle_state: overrides.lifecycle_state ?? 'active',
    scope_status: overrides.scope_status ?? 'active',
    title: overrides.title ?? 'Chicken rice bowl',
    ingredients: overrides.ingredients ?? [
      { name: 'Chicken', quantity: '300', unit: 'g' },
      { name: 'Rice', quantity: '200', unit: 'g' },
    ],
    instructions: overrides.instructions ?? null,
    prep_time_min: overrides.prep_time_min ?? 15,
    cook_time_min: overrides.cook_time_min ?? 20,
    servings: overrides.servings ?? 2,
    tags: overrides.tags ?? null,
    source: overrides.source ?? null,
    protein: overrides.protein ?? null,
    fat: overrides.fat ?? null,
    carbs: overrides.carbs ?? null,
    calories: overrides.calories ?? null,
    created_at: overrides.created_at ?? '2026-05-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-05-01T00:00:00.000Z',
  };
}

function shoppingList(items: ShoppingList['items']): ShoppingList {
  return {
    id: 1,
    tenant_id: 1,
    user_id: 1,
    owner_user_id: 1,
    visibility_scope: 'user_private',
    lifecycle_state: 'active',
    scope_status: 'active',
    week_start: '2026-05-04',
    items,
    status: 'active',
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
  };
}

describe('cooking intelligence assessment', () => {
  it('blocks meals that conflict with allergies', () => {
    const assessment = assessCookingMealPlan({
      meals: [meal({ title: 'Peanut chicken bowl' })],
      recipesById: new Map([[10, recipe({ ingredients: [{ name: 'Peanut sauce', quantity: '2', unit: 'tbsp' }] })]]),
      preferences: { allergies: ['peanut'] },
    });

    expect(assessment.status).toBe('blocked');
    expect(assessment.issues).toEqual([
      expect.objectContaining({ code: 'ALLERGY_CONFLICT', severity: 'blocker' }),
      expect.objectContaining({ code: 'GROCERY_LIST_MISSING_INGREDIENTS' }),
    ]);
  });

  it('detects missing groceries while respecting available pantry items', () => {
    const assessment = assessCookingMealPlan({
      meals: [meal({})],
      recipesById: new Map([[10, recipe({})]]),
      shoppingList: shoppingList([
        { name: 'Chicken', quantity: '300', unit: 'g', checked: false, aisle: 'protein' },
      ]),
      pantryItems: [
        { name: 'Rice', quantity: '1', unit: 'kg', status: 'available' },
      ],
    });

    expect(assessment.groceryCoherence.status).toBe('ready');
    expect(assessment.groceryCoherence.pantryAvailableNames).toEqual(['Rice']);
    expect(assessment.issues.map((issue) => issue.code)).not.toContain('GROCERY_LIST_MISSING_INGREDIENTS');
  });

  it('blocks expired pantry items instead of using them silently', () => {
    const assessment = assessCookingMealPlan({
      meals: [meal({})],
      recipesById: new Map([[10, recipe({})]]),
      pantryItems: [
        { name: 'Rice', quantity: '1', unit: 'kg', expiresAt: '2026-04-01' },
      ],
      todayIso: '2026-05-04',
    });

    expect(assessment.status).toBe('blocked');
    expect(assessment.groceryCoherence.expiredPantryNames).toEqual(['Rice']);
    expect(assessment.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'EXPIRED_PANTRY_ITEM', severity: 'blocker' }),
    ]));
  });

  it('flags schedule and budget pressure for impractical plans', () => {
    const assessment = assessCookingMealPlan({
      meals: [meal({ date: '2026-05-04' })],
      recipesById: new Map([[10, recipe({ prep_time_min: 30, cook_time_min: 40 })]]),
      availableCookingMinutesByDate: { '2026-05-04': 30 },
      estimatedBudget: 125,
      preferences: { budgetLimit: 80, budgetCurrency: 'EUR' },
    });

    expect(assessment.status).toBe('needs_review');
    expect(assessment.scheduleFit.status).toBe('over_capacity');
    expect(assessment.budgetFit.status).toBe('over_budget');
    expect(assessment.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'COOKING_TIME_OVER_CAPACITY' }),
      expect.objectContaining({ code: 'GROCERY_BUDGET_OVER_LIMIT' }),
    ]));
  });

  it('surfaces tight Finance budget context even before item-level grocery prices exist', () => {
    const assessment = assessCookingMealPlan({
      meals: [meal({ date: '2026-05-04' })],
      financeBudgetContext: {
        status: 'available',
        affordability: 'tight',
        budgetLimit: 25,
        currency: 'EUR',
        source: 'finance_monthly_budget',
      },
    });

    expect(assessment.status).toBe('needs_review');
    expect(assessment.budgetFit).toMatchObject({
      status: 'unknown',
      budgetLimit: 25,
      currency: 'EUR',
    });
    expect(assessment.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'FINANCE_BUDGET_TIGHT',
        source: 'finance_monthly_budget',
      }),
    ]));
  });

  it('flags hard training days without meal support', () => {
    const assessment = assessCookingMealPlan({
      meals: [meal({ date: '2026-05-04' })],
      trainingContext: {
        trainingDates: ['2026-05-04', '2026-05-05'],
        hardTrainingDates: ['2026-05-05'],
      },
    });

    expect(assessment.trainingFit.status).toBe('missing');
    expect(assessment.trainingFit.hardTrainingDatesWithoutMeals).toEqual(['2026-05-05']);
    expect(assessment.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'HARD_TRAINING_DAY_UNSUPPORTED' }),
    ]));
  });

  it('builds a scoped memory summary without storing raw prompts', () => {
    expect(buildCookingPreferenceMemorySummary({
      allergies: ['shellfish'],
      dislikedIngredients: ['mushrooms'],
      weekdayMaxPrepMinutes: 20,
      trainingDayPreference: 'higher-protein dinners after hard sessions',
    })).toContain('Allergies: shellfish');
  });
});
