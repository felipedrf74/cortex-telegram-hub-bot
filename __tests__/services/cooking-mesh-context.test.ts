import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetMealPlan = vi.fn();
const mockGetShoppingList = vi.fn();
const mockGetRecipeById = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();
const mockGetEvents = vi.fn();
const mockGetFocusBlockRecommendation = vi.fn();

vi.mock('../../src/config', () => ({
  config: {
    app: {
      timezone: 'Europe/Lisbon',
    },
    garmin: {
      tokenPath: '/tmp',
    },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../src/services/cooking-chef', () => ({
  getMealPlan: (...args: unknown[]) => mockGetMealPlan(...args),
  getShoppingList: (...args: unknown[]) => mockGetShoppingList(...args),
  getRecipeById: (...args: unknown[]) => mockGetRecipeById(...args),
  classifyIngredientAisle: (name: string) => {
    const lower = name.toLowerCase();
    if (lower.includes('chicken')) return 'protein';
    if (lower.includes('rice')) return 'pantry';
    if (lower.includes('potato')) return 'produce';
    return 'other';
  },
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
  getWeeklyAdherence: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  hasWritableCalendarForUser: vi.fn(),
}));

vi.mock('../../src/services/focus-planner', () => ({
  getFocusBlockRecommendation: (...args: unknown[]) => mockGetFocusBlockRecommendation(...args),
}));

import { readCookingMeshContext } from '../../src/services/cross-agent-learning';

describe('readCookingMeshContext', () => {
  beforeEach(() => {
    mockGetMealPlan.mockReset();
    mockGetShoppingList.mockReset();
    mockGetRecipeById.mockReset();
    mockGetActivePlans.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetSessionsForWeek.mockReset();
    mockGetEvents.mockReset();
    mockGetFocusBlockRecommendation.mockReset();

    mockGetActivePlans.mockReturnValue([
      {
        id: 1,
        user_id: 42,
        start_date: '2026-04-13',
      },
    ]);
    mockGetWeeksForPlan.mockReturnValue([
      {
        id: 11,
        week_number: 1,
        focus: 'Build',
      },
    ]);
    mockGetSessionsForWeek.mockReturnValue([
      {
        id: 101,
        week_id: 11,
        plan_id: 1,
        day_of_week: 'Wednesday',
        session_type: 'run',
        title: 'Track intervals',
        description: '6x800m at 5K pace',
        duration_minutes: 60,
        intensity_text: 'Hard',
      },
      {
        id: 102,
        week_id: 11,
        plan_id: 1,
        day_of_week: 'Friday',
        session_type: 'strength',
        title: 'Upper body lift',
        description: 'Moderate upper focus',
        duration_minutes: 50,
        intensity_text: 'Moderate',
      },
    ]);
    mockGetRecipeById.mockImplementation((_userId: number, recipeId: number) => ({
      id: recipeId,
      user_id: 42,
      title: `Meal ${recipeId}`,
      ingredients: [{ name: 'Chicken', quantity: '300', unit: 'g' }],
      instructions: null,
      prep_time_min: 10,
      cook_time_min: 20,
      servings: 2,
      tags: null,
      source: null,
      protein: null,
      fat: null,
      carbs: null,
      calories: null,
      created_at: '2026-04-13T08:00:00.000Z',
      updated_at: '2026-04-13T08:00:00.000Z',
    }));
    mockGetEvents.mockResolvedValue([]);
    mockGetFocusBlockRecommendation.mockResolvedValue(null);
  });

  it('publishes at-risk fueling support when a hard training day still lacks meals', async () => {
    mockGetMealPlan.mockReturnValue([
      {
        id: 1,
        user_id: 42,
        date: '2026-04-17',
        meal_type: 'dinner',
        recipe_id: 9,
        title: 'Recovery bowl',
        notes: null,
        created_at: '2026-04-13T08:00:00.000Z',
      },
    ]);
    mockGetShoppingList.mockReturnValue({
      id: 1,
      user_id: 42,
      week_start: '2026-04-13',
      status: 'draft',
      created_at: '2026-04-13T08:00:00.000Z',
      updated_at: '2026-04-13T08:00:00.000Z',
      items: [
        { name: 'Rice', quantity: '1', unit: 'kg', checked: false, aisle: 'Grains' },
      ],
    });

    const context = await readCookingMeshContext({ userId: 42, weekStart: '2026-04-13' });

    const fuelingSupport = context.derivedSignals.find((signal) => signal.signalType === 'fueling_support_status');
    const executionReadiness = context.derivedSignals.find((signal) => signal.signalType === 'meal_execution_readiness');

    expect(fuelingSupport?.payload).toMatchObject({
      status: 'at_risk',
      trainingDates: ['2026-04-15', '2026-04-17'],
      trainingDatesMissingMeals: ['2026-04-15'],
      hardDatesMissingMeals: ['2026-04-15'],
      trainingCoverageRatio: 0.5,
      shoppingReady: true,
    });
    expect(executionReadiness?.payload).toMatchObject({
      status: 'partial',
      missingDates: expect.arrayContaining(['2026-04-14', '2026-04-15']),
      shoppingReady: true,
      shoppingItemCount: 1,
      coveredDayCount: 1,
      manualMealCount: 0,
    });
  });

  it('publishes ready fueling and execution signals when the week is fully covered and shopping is ready', async () => {
    mockGetMealPlan.mockReturnValue([
      meal(1, '2026-04-13'),
      meal(2, '2026-04-14'),
      meal(3, '2026-04-15'),
      meal(4, '2026-04-16'),
      meal(5, '2026-04-17'),
      meal(6, '2026-04-18'),
      meal(7, '2026-04-19'),
    ]);
    mockGetShoppingList.mockReturnValue({
      id: 1,
      user_id: 42,
      week_start: '2026-04-13',
      status: 'ready',
      created_at: '2026-04-13T08:00:00.000Z',
      updated_at: '2026-04-13T08:00:00.000Z',
      items: [
        { name: 'Chicken', quantity: '1', unit: 'kg', checked: false, aisle: 'Protein' },
        { name: 'Potatoes', quantity: '2', unit: 'kg', checked: false, aisle: 'Produce' },
      ],
    });

    const context = await readCookingMeshContext({ userId: 42, weekStart: '2026-04-13' });

    const fuelingSupport = context.derivedSignals.find((signal) => signal.signalType === 'fueling_support_status');
    const executionReadiness = context.derivedSignals.find((signal) => signal.signalType === 'meal_execution_readiness');

    expect(fuelingSupport?.payload).toMatchObject({
      status: 'ready',
      trainingDates: ['2026-04-15', '2026-04-17'],
      trainingDatesMissingMeals: [],
      hardDatesMissingMeals: [],
      trainingCoverageRatio: 1,
      shoppingReady: true,
    });
    expect(executionReadiness?.payload).toMatchObject({
      status: 'ready',
      missingDates: [],
      shoppingReady: true,
      shoppingItemCount: 2,
      coveredDayCount: 7,
    });
  });

  it('marks execution at risk when high-effort meals land on fragmented days', async () => {
    mockGetMealPlan.mockReturnValue([
      meal(1, '2026-04-13'),
      meal(2, '2026-04-14'),
    ]);
    mockGetShoppingList.mockReturnValue({
      id: 1,
      user_id: 42,
      week_start: '2026-04-13',
      status: 'draft',
      created_at: '2026-04-13T08:00:00.000Z',
      updated_at: '2026-04-13T08:00:00.000Z',
      items: [{ name: 'Chicken', quantity: '1', unit: 'kg', checked: false, aisle: 'Protein' }],
    });
    mockGetRecipeById.mockImplementation((_userId: number, recipeId: number) => ({
      id: recipeId,
      user_id: 42,
      title: `Meal ${recipeId}`,
      ingredients: [{ name: 'Chicken', quantity: '300', unit: 'g' }],
      instructions: null,
      prep_time_min: 25,
      cook_time_min: 30,
      servings: 2,
      tags: null,
      source: null,
      protein: null,
      fat: null,
      carbs: null,
      calories: null,
      created_at: '2026-04-13T08:00:00.000Z',
      updated_at: '2026-04-13T08:00:00.000Z',
    }));
    mockGetEvents.mockResolvedValue([
      {
        id: 'evt-1',
        title: 'Travel to Porto',
        summary: 'Travel to Porto',
        start: '2026-04-13T09:00:00Z',
        end: '2026-04-13T11:00:00Z',
        source: 'outlook',
      },
      {
        id: 'evt-2',
        title: 'Client review',
        summary: 'Client review',
        start: '2026-04-14T10:00:00Z',
        end: '2026-04-14T11:00:00Z',
        source: 'outlook',
      },
      {
        id: 'evt-3',
        title: 'Content block',
        summary: 'Content block',
        start: '2026-04-14T13:00:00Z',
        end: '2026-04-14T14:00:00Z',
        source: 'outlook',
      },
      {
        id: 'evt-4',
        title: 'Admin block',
        summary: 'Admin block',
        start: '2026-04-14T16:00:00Z',
        end: '2026-04-14T16:30:00Z',
        source: 'outlook',
      },
    ]);

    const context = await readCookingMeshContext({ userId: 42, weekStart: '2026-04-13' });
    const executionReadiness = context.derivedSignals.find((signal) => signal.signalType === 'meal_execution_readiness');

    expect(executionReadiness?.payload).toMatchObject({
      status: 'at_risk',
      prepPressureDates: ['2026-04-13', '2026-04-14'],
      highEffortMealCount: 2,
      totalPrepMinutes: 50,
      totalCookMinutes: 60,
    });
  });

  it('builds a medium-confidence grocery forecast from recipe ingredients when shopping is missing', async () => {
    mockGetMealPlan.mockReturnValue([
      meal(1, '2026-04-13'),
      meal(2, '2026-04-15'),
    ]);
    mockGetShoppingList.mockReturnValue(null);
    mockGetRecipeById.mockImplementation((_userId: number, recipeId: number) => ({
      id: recipeId,
      user_id: 42,
      title: `Meal ${recipeId}`,
      ingredients: recipeId === 1
        ? [
            { name: 'Chicken breast', quantity: '300', unit: 'g' },
            { name: 'Rice', quantity: '150', unit: 'g' },
          ]
        : [
            { name: 'Potatoes', quantity: '400', unit: 'g' },
          ],
      instructions: null,
      prep_time_min: 10,
      cook_time_min: 20,
      servings: 2,
      tags: null,
      source: null,
      protein: null,
      fat: null,
      carbs: null,
      calories: null,
      created_at: '2026-04-13T08:00:00.000Z',
      updated_at: '2026-04-13T08:00:00.000Z',
    }));

    const context = await readCookingMeshContext({ userId: 42, weekStart: '2026-04-13' });
    const spend = context.derivedSignals.find((signal) => signal.signalType === 'grocery_spend_forecast');

    expect(spend?.payload).toMatchObject({
      source: 'recipe_ingredients',
      confidence: 'medium',
      itemCount: 3,
      aisleCount: 3,
      estimatedSpendBrl: 37,
    });
  });
});

function meal(id: number, date: string) {
  return {
    id,
    user_id: 42,
    date,
    meal_type: 'lunch',
    recipe_id: id,
    title: `Meal ${id}`,
    notes: null,
    created_at: '2026-04-13T08:00:00.000Z',
  };
}
