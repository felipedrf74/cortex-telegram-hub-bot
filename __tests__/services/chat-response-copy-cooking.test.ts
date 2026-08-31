// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';

import { successCopy } from '../../src/services/chat/executor/response-copy';

function cookingCopy({
  action,
  args = {},
  result,
  locale = 'en',
  nowIso = '2026-08-31T12:00:00Z',
}: {
  action: string;
  args?: Record<string, unknown>;
  result?: unknown;
  locale?: string;
  nowIso?: string;
}): string {
  return successCopy({
    locale,
    nowIso,
    text: 'test cooking response copy',
    timezone: 'UTC',
    userId: 42,
    tenantId: 84,
  } as any, [{
    result,
    status: 'completed',
    step: {
      action,
      args,
      type: 'tool',
    },
  } as any]);
}

describe('Cooking success response copy', () => {
  it('formats generated grocery lists for current, future, and missing weeks', () => {
    expect(cookingCopy({
      action: 'cooking_grocery_list',
      args: { weekStart: '2026-08-31' },
      result: { itemCount: 4, weekStart: '2026-09-07' },
    })).toContain('for the week of 2026-09-07 with 4 item(s)');

    expect(cookingCopy({
      action: 'cooking_grocery_list',
      args: { weekStart: '2026-08-31' },
      locale: 'pt-PT',
      result: { itemCount: 2 },
    })).toContain('desta semana com 2 item(ns)');

    expect(cookingCopy({
      action: 'cooking_grocery_list',
      nowIso: 'not-a-date',
      result: { itemCount: 0 },
    })).toContain('for this week with 0 item(s)');
  });

  it('includes verified meal-plan warnings only when present', () => {
    expect(cookingCopy({
      action: 'cooking_meal_plan',
      args: { date: '2026-09-01', mealType: 'dinner', title: 'Curry' },
      result: {
        meal: {
          issues: [
            { message: ' Verify the sauce label. ' },
            { message: 7 },
            { message: '   ' },
          ],
        },
      },
    })).toContain('Check before cooking: Verify the sauce label.');

    expect(cookingCopy({
      action: 'cooking_meal_plan',
      args: { date: '2026-09-01', mealType: 'jantar', title: 'Caril' },
      locale: 'pt-PT',
      result: { meal: { issues: null } },
    })).toBe('Feito — guardei “Caril” para jantar em 2026-09-01 e verifiquei o plano.');
  });

  it('uses verified delete targets and falls back to the requested targets', () => {
    expect(cookingCopy({
      action: 'cooking_delete_recipe',
      args: { recipeId: 4 },
      result: { recipeId: 8 },
    })).toContain('deleted recipe 8');
    expect(cookingCopy({
      action: 'cooking_delete_recipe',
      args: { recipeId: 4 },
      locale: 'pt-PT',
    })).toContain('receita 4');

    expect(cookingCopy({
      action: 'cooking_delete_meal',
      args: { date: '2026-09-02', mealType: 'lunch' },
      result: { date: '2026-09-03', mealType: 'dinner' },
    })).toContain('deleted dinner on 2026-09-03');
    expect(cookingCopy({
      action: 'cooking_delete_meal',
      args: { date: '2026-09-02', mealType: 'almoço' },
      locale: 'pt-PT',
      result: {},
    })).toContain('almoço de 2026-09-02');

    expect(cookingCopy({
      action: 'cooking_delete_pantry_item',
      args: { itemId: 3 },
      result: { itemId: 9 },
    })).toContain('pantry item 9');
    expect(cookingCopy({
      action: 'cooking_delete_pantry_item',
      args: { itemId: 3 },
      locale: 'pt-PT',
    })).toContain('item 3 da despensa');
  });

  it('formats substitution values from verified, requested, and default sources', () => {
    expect(cookingCopy({
      action: 'cooking_substitute_ingredient',
      args: { originalIngredient: 'shrimp', suggestedIngredient: 'tofu' },
      result: {
        substitution: {
          originalIngredient: 'prawn',
          suggestedIngredient: 'chicken',
        },
      },
    })).toContain('replaced prawn with chicken');

    expect(cookingCopy({
      action: 'cooking_substitute_ingredient',
      args: { originalIngredient: 'camarão', suggestedIngredient: 'tofu' },
      locale: 'pt-PT',
      result: { substitution: {} },
    })).toContain('troquei camarão por tofu');

    expect(cookingCopy({
      action: 'cooking_substitute_ingredient',
    })).toContain('replaced ingredient with replacement');
  });

  it('discloses degraded and safety-filtered shopping support', () => {
    const english = cookingCopy({
      action: 'cooking_meal_support',
      args: { supportMode: 'shopping_list_read' },
      result: {
        degraded: true,
        guidance: ['Use pantry staples.', '', 7],
        mealSafetyConflicts: 2,
        mealSafetyUnverified: 1,
        plannedMeals: [{ title: 'Soup' }, null, { title: '' }],
        requestedRange: { scope: 'week' },
        shoppingItems: [{ name: 'Rice' }, null, { name: '' }, { nope: true }],
        shoppingSafetyConflicts: 3,
        suggestions: [{ title: 'Stew' }, null, { title: '' }],
      },
    });
    expect(english).toContain('Shopping list for the requested week: Rice.');
    expect(english).toContain('Some local sources are unavailable or incomplete.');
    expect(english).toContain('3 conflicting shopping item(s) were omitted');
    expect(english).toContain('2 conflicting saved meal(s) were omitted');
    expect(english).toContain('1 saved meal(s) were omitted because their safety could not be verified');

    const portuguese = cookingCopy({
      action: 'cooking_meal_support',
      args: { supportMode: 'shopping_list_read' },
      locale: 'pt-PT',
      result: {
        degraded: true,
        guidance: null,
        mealSafetyConflicts: 1,
        mealSafetyUnverified: 1,
        plannedMeals: [],
        requestedRange: { scope: 'week' },
        shoppingItems: [],
        shoppingSafetyConflicts: 1,
        suggestions: [],
      },
    });
    expect(portuguese).toContain('Lista de compras da semana pedida: nenhum item guardado.');
    expect(portuguese).toContain('Algumas fontes locais estão indisponíveis ou incompletas.');
    expect(portuguese).toContain('1 item(ns) da lista em conflito foram omitidos');
  });

  it('formats saved meals, recipe suggestions, and aggregate fueling fallbacks', () => {
    expect(cookingCopy({
      action: 'cooking_meal_support',
      result: {
        guidance: [],
        plannedMeals: [{ title: 'Pasta' }, { title: 'Salad' }],
        requestedDate: '2026-09-02',
        requestedRange: { scope: 'day' },
        shoppingItems: null,
        suggestions: [],
      },
    })).toContain('Saved meals on 2026-09-02: Pasta, Salad.');

    const suggestions = cookingCopy({
      action: 'cooking_meal_support',
      locale: 'pt-PT',
      result: {
        guidance: ['Prepare cedo.'],
        plannedMeals: 2,
        requestedRange: { scope: 'day' },
        shoppingItems: 3,
        suggestions: [{ title: 'Sopa' }, { title: 'Arroz' }],
      },
    });
    expect(suggestions).toContain('Sugestões das suas receitas guardadas em a data pedida: Sopa, Arroz.');
    expect(suggestions).toContain('Orientação: Prepare cedo.');

    expect(cookingCopy({
      action: 'cooking_fueling_support',
      result: {
        guidance: null,
        plannedMeals: 3,
        requestedRange: { scope: 'day' },
        shoppingItemCount: null,
        shoppingItems: null,
        suggestions: null,
      },
    })).toContain('there are 3 planned meal(s) and 0 shopping item(s)');

    expect(cookingCopy({
      action: 'cooking_fueling_support',
      locale: 'pt-PT',
      result: {
        guidance: ['Hidrata-te.'],
        plannedMeals: [{ title: '' }, null],
        requestedDate: '2026-09-04',
        requestedRange: { scope: 'day' },
        shoppingItemCount: 5,
        shoppingItems: [],
        suggestions: [],
      },
    })).toContain('Cozinha em 2026-09-04: há 2 refeição(ões) planeadas e 5 item(ns)');
  });
});
