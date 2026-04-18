import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetMealPlan = vi.fn();
const mockGetShoppingList = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();

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
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
  getWeeklyAdherence: vi.fn(),
}));

import { readCookingMeshContext } from '../../src/services/cross-agent-learning';

describe('readCookingMeshContext', () => {
  beforeEach(() => {
    mockGetMealPlan.mockReset();
    mockGetShoppingList.mockReset();
    mockGetActivePlans.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetSessionsForWeek.mockReset();

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
