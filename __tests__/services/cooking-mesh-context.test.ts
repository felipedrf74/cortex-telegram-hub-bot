import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetMealPlan = vi.fn();
const mockGetShoppingList = vi.fn();
const mockGetRecipeById = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();
const mockGetEventsWithDiagnostics = vi.fn();
const mockGetFocusBlockRecommendation = vi.fn();
const mockGetUserTimezoneById = vi.fn(() => 'Europe/Lisbon');
const mockBuildCookingPreferenceReadModel = vi.fn();

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
  LOGGER_REDACTION_PATHS: [],
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
  getEventsWithDiagnostics: (...args: unknown[]) => mockGetEventsWithDiagnostics(...args),
  hasWritableCalendarForUser: vi.fn(),
}));

vi.mock('../../src/services/focus-planner', () => ({
  getFocusBlockRecommendation: (...args: unknown[]) => mockGetFocusBlockRecommendation(...args),
}));

vi.mock('../../src/services/cooking-preferences', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/cooking-preferences')>(
    '../../src/services/cooking-preferences',
  );
  return {
    ...actual,
    buildCookingPreferenceReadModel: (...args: unknown[]) => mockBuildCookingPreferenceReadModel(...args),
  };
});

vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  );
  return {
    ...actual,
    getUserTimezoneById: (...args: unknown[]) => mockGetUserTimezoneById(...args),
  };
});

import { readCookingMeshContext } from '../../src/services/cross-agent-learning';

describe('readCookingMeshContext', () => {
  beforeEach(() => {
    mockGetMealPlan.mockReset();
    mockGetShoppingList.mockReset();
    mockGetRecipeById.mockReset();
    mockGetActivePlans.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetSessionsForWeek.mockReset();
    mockGetEventsWithDiagnostics.mockReset();
    mockGetFocusBlockRecommendation.mockReset();
    mockGetUserTimezoneById.mockReset();
    mockBuildCookingPreferenceReadModel.mockReset();
    mockGetUserTimezoneById.mockReturnValue('Europe/Lisbon');
    mockBuildCookingPreferenceReadModel.mockReturnValue({
      profile: {},
      memories: [],
      summary: '',
      skillMemorySummary: '',
    });

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
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });
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
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [{
        id: 'evt-1',
        title: 'Travel to Porto',
        summary: 'Travel to Porto',
        start: '2026-04-13T09:00:00Z',
        end: '2026-04-13T11:00:00Z',
        source: 'outlook',
      }, {
        id: 'evt-2',
        title: 'Client review',
        summary: 'Client review',
        start: '2026-04-14T10:00:00Z',
        end: '2026-04-14T11:00:00Z',
        source: 'outlook',
      }, {
        id: 'evt-3',
        title: 'Content block',
        summary: 'Content block',
        start: '2026-04-14T13:00:00Z',
        end: '2026-04-14T14:00:00Z',
        source: 'outlook',
      }, {
        id: 'evt-4',
        title: 'Admin block',
        summary: 'Admin block',
        start: '2026-04-14T16:00:00Z',
        end: '2026-04-14T16:30:00Z',
        source: 'outlook',
      }],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });

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

  it('marks calendar evidence unavailable when the scoped provider read rejects', async () => {
    mockGetMealPlan.mockReturnValue([]);
    mockGetShoppingList.mockReturnValue(null);
    mockGetEventsWithDiagnostics.mockRejectedValueOnce(new Error('provider timeout'));

    const context = await readCookingMeshContext({ userId: 42, tenantId: 42, weekStart: '2026-04-13' });

    expect(mockGetEventsWithDiagnostics).toHaveBeenCalledWith(
      '2026-04-12T23:00:00.000Z',
      '2026-04-19T22:59:59.999Z',
      42,
    );
    expect(context.calendar).toEqual({
      status: 'unavailable',
      warningCodes: ['COOKING_CALENDAR_READ_FAILED'],
    });
  });

  it('treats a missing optional calendar integration as verified empty availability', async () => {
    mockGetMealPlan.mockReturnValue([meal(1, '2026-04-13')]);
    mockGetShoppingList.mockReturnValue(null);
    mockGetEventsWithDiagnostics.mockResolvedValueOnce({
      events: [],
      status: 'unavailable',
      warningCodes: ['CALENDAR_INTEGRATION_MISSING'],
      warnings: ['No calendar integration is connected.'],
      sources: { configured: [], fulfilled: [], failed: [] },
    });

    const context = await readCookingMeshContext({ userId: 42, tenantId: 42, weekStart: '2026-04-13' });

    expect(context.calendar).toEqual({
      status: 'not_configured',
      warningCodes: [],
    });
    expect(context.derivedSignals.some((signal) => signal.signalType === 'meal_execution_readiness')).toBe(true);
  });

  it('uses the user timezone for the Cooking week and calendar-to-day grouping', async () => {
    mockGetUserTimezoneById.mockReturnValue('Pacific/Honolulu');
    mockGetMealPlan.mockReturnValue([meal(1, '2026-04-13')]);
    mockGetShoppingList.mockReturnValue({
      id: 1,
      user_id: 42,
      week_start: '2026-04-13',
      status: 'draft',
      created_at: '2026-04-13T08:00:00.000Z',
      updated_at: '2026-04-13T08:00:00.000Z',
      items: [{ name: 'Rice', quantity: '1', unit: 'kg', checked: false, aisle: 'Grains' }],
    });
    mockGetRecipeById.mockReturnValue({
      id: 9,
      user_id: 42,
      title: 'Long prep bowl',
      ingredients: [{ name: 'Rice', quantity: '1', unit: 'cup' }],
      prep_time_min: 30,
      cook_time_min: 30,
    });
    mockGetEventsWithDiagnostics.mockResolvedValue({
      events: [
        { id: '1', summary: 'Prep', start: '2026-04-14T05:00:00.000Z', end: '2026-04-14T05:30:00.000Z', source: 'outlook' },
        { id: '2', summary: 'Call', start: '2026-04-14T06:00:00.000Z', end: '2026-04-14T06:30:00.000Z', source: 'outlook' },
        { id: '3', summary: 'Admin', start: '2026-04-14T07:00:00.000Z', end: '2026-04-14T07:30:00.000Z', source: 'outlook' },
      ],
      status: 'ready',
      warningCodes: [],
      warnings: [],
      sources: { configured: ['outlook'], fulfilled: ['outlook'], failed: [] },
    });

    const context = await readCookingMeshContext({ userId: 42, tenantId: 42, weekStart: '2026-04-13' });

    expect(mockGetEventsWithDiagnostics).toHaveBeenCalledWith(
      '2026-04-13T10:00:00.000Z',
      '2026-04-20T09:59:59.999Z',
      42,
    );
    expect(context.timezone).toBe('Pacific/Honolulu');
    expect(context.availability?.busyDates).toEqual(['2026-04-13']);
    expect(context.derivedSignals.find((signal) => signal.signalType === 'meal_execution_readiness')?.payload)
      .toMatchObject({ prepPressureDates: ['2026-04-13'] });
  });

  it('withholds persisted meals that conflict with current safety preferences from coverage and output', async () => {
    mockBuildCookingPreferenceReadModel.mockReturnValue({
      profile: { allergies: ['peanut'] },
      memories: [],
      summary: 'Allergy: peanut',
      skillMemorySummary: '',
    });
    mockGetMealPlan.mockReturnValue([
      meal(1, '2026-04-13'),
      meal(2, '2026-04-15'),
    ]);
    mockGetShoppingList.mockReturnValue({
      id: 1,
      user_id: 42,
      week_start: '2026-04-13',
      status: 'draft',
      created_at: '2026-04-13T08:00:00.000Z',
      updated_at: '2026-04-13T08:00:00.000Z',
      items: [
        { name: 'Peanut oil', quantity: '1', unit: 'bottle', checked: false, aisle: 'Pantry' },
        { name: 'Rice', quantity: '1', unit: 'kg', checked: false, aisle: 'Grains' },
      ],
    });
    mockGetRecipeById.mockImplementation((_userId: number, recipeId: number) => ({
      id: recipeId,
      user_id: 42,
      title: recipeId === 1 ? 'Peanut noodle bowl' : 'Lemon rice bowl',
      ingredients: recipeId === 1
        ? [{ name: 'Peanut butter', quantity: '2', unit: 'tbsp' }]
        : [{ name: 'Rice', quantity: '1', unit: 'cup' }],
      instructions: 'Combine and serve.',
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

    const context = await readCookingMeshContext({
      userId: 42,
      tenantId: 700,
      weekStart: '2026-04-13',
    });
    const coverage = context.derivedSignals.find((signal) => signal.signalType === 'meal_plan_window');

    expect(mockBuildCookingPreferenceReadModel).toHaveBeenCalledWith(42, 700);
    expect(context.meals.map((entry) => entry.id)).toEqual([2]);
    expect(context.shoppingList?.items.map((item) => item.name)).toEqual(['Rice']);
    expect(context.sourceHealth?.safety).toEqual({
      status: 'degraded',
      warningCodes: [
        'COOKING_SAVED_MEAL_ALLERGY_CONFLICT',
        'COOKING_SAVED_MEAL_SAFETY_WITHHELD',
        'COOKING_SHOPPING_LIST_ALLERGY_CONFLICT',
      ],
      excludedMealCount: 1,
      excludedMealDates: ['2026-04-13'],
      excludedMeals: [{ date: '2026-04-13', reason: 'preference_conflict' }],
    });
    expect(coverage?.payload).toMatchObject({
      coveredDays: ['2026-04-15'],
      totalMeals: 1,
      missingDates: expect.arrayContaining(['2026-04-13']),
    });
  });

  it('withholds all persisted meals and suppresses coverage when the current safety profile is unavailable', async () => {
    mockGetMealPlan.mockReturnValue([meal(1, '2026-04-13')]);
    mockGetShoppingList.mockReturnValue(null);
    mockBuildCookingPreferenceReadModel.mockImplementation(() => {
      throw new Error('preference store unavailable');
    });

    const context = await readCookingMeshContext({
      userId: 42,
      tenantId: 700,
      weekStart: '2026-04-13',
    });

    expect(context.meals).toEqual([]);
    expect(context.sourceHealth?.safety).toEqual({
      status: 'unavailable',
      warningCodes: ['COOKING_SAFETY_PROFILE_UNAVAILABLE'],
      excludedMealCount: 1,
      excludedMealDates: ['2026-04-13'],
    });
    expect(context.derivedSignals.some((signal) => signal.signalType === 'meal_plan_window')).toBe(false);
    expect(context.derivedSignals.some((signal) => signal.signalType === 'meal_execution_readiness')).toBe(false);
    expect(context.derivedSignals.some((signal) => signal.signalType === 'grocery_spend_forecast')).toBe(false);
  });

  it('records failed meal and shopping sources instead of publishing valid-empty signals', async () => {
    mockGetMealPlan.mockImplementation(() => { throw new Error('meal db unavailable'); });
    mockGetShoppingList.mockImplementation(() => { throw new Error('shopping db unavailable'); });

    const context = await readCookingMeshContext({ userId: 42, tenantId: 42, weekStart: '2026-04-13' });

    expect(context.sourceHealth).toMatchObject({
      mealPlan: { status: 'unavailable', warningCodes: ['COOKING_MEAL_PLAN_READ_FAILED'] },
      shoppingList: { status: 'unavailable', warningCodes: ['COOKING_SHOPPING_LIST_READ_FAILED'] },
      recipes: { status: 'unavailable', warningCodes: ['COOKING_RECIPE_CONTEXT_BLOCKED_BY_MEAL_PLAN'] },
      focus: { status: 'ready', warningCodes: [] },
      safety: {
        status: 'unavailable',
        warningCodes: ['COOKING_SAFETY_CONTEXT_BLOCKED_BY_MEAL_PLAN'],
        excludedMealCount: 0,
        excludedMealDates: [],
      },
    });
    expect(context.derivedSignals.some((signal) => signal.signalType === 'meal_plan_window')).toBe(false);
    expect(context.derivedSignals.some((signal) => signal.signalType === 'meal_execution_readiness')).toBe(false);
    expect(context.derivedSignals.some((signal) => signal.signalType === 'grocery_spend_forecast')).toBe(false);
  });

  it('exposes linked-recipe and Secretary focus failures and suppresses prep readiness', async () => {
    mockGetMealPlan.mockReturnValue([meal(1, '2026-04-13')]);
    mockGetShoppingList.mockReturnValue(null);
    mockGetRecipeById.mockImplementation(() => { throw new Error('recipe read failed'); });
    mockGetFocusBlockRecommendation.mockRejectedValueOnce(new Error('focus read failed'));

    const context = await readCookingMeshContext({ userId: 42, tenantId: 42, weekStart: '2026-04-13' });

    expect(context.sourceHealth?.recipes).toEqual({
      status: 'unavailable',
      warningCodes: ['COOKING_RECIPE_READ_FAILED'],
    });
    expect(context.sourceHealth?.focus).toEqual({
      status: 'unavailable',
      warningCodes: ['COOKING_FOCUS_READ_FAILED'],
    });
    expect(context.meals).toEqual([]);
    expect(context.sourceHealth?.safety).toEqual({
      status: 'degraded',
      warningCodes: [
        'COOKING_SAVED_MEAL_RECIPE_UNVERIFIED',
        'COOKING_SAVED_MEAL_SAFETY_WITHHELD',
      ],
      excludedMealCount: 1,
      excludedMealDates: ['2026-04-13'],
      excludedMeals: [{ date: '2026-04-13', reason: 'unverified_recipe' }],
    });
    expect(context.derivedSignals.some((signal) => signal.signalType === 'meal_execution_readiness')).toBe(false);
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
