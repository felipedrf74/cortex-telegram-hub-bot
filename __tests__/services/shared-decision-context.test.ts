import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadTrainingMeshContext = vi.fn();
const mockReadCookingMeshContext = vi.fn();
const mockReadFinanceMeshContext = vi.fn();
const mockReadContentMeshContext = vi.fn();
const mockReadSecretaryMeshContext = vi.fn();

vi.mock('../../src/services/cross-agent-learning', () => ({
  readTrainingMeshContext: (...args: unknown[]) => mockReadTrainingMeshContext(...args),
  readCookingMeshContext: (...args: unknown[]) => mockReadCookingMeshContext(...args),
  readFinanceMeshContext: (...args: unknown[]) => mockReadFinanceMeshContext(...args),
  readContentMeshContext: (...args: unknown[]) => mockReadContentMeshContext(...args),
  readSecretaryMeshContext: (...args: unknown[]) => mockReadSecretaryMeshContext(...args),
}));

import {
  buildSharedDecisionContext,
  buildSharedDecisionContracts,
  invalidateSharedDecisionContextCache,
  resetSharedDecisionContextCacheForTests,
} from '../../src/services/shared-decision-context';

describe('shared-decision-context', () => {
  beforeEach(() => {
    resetSharedDecisionContextCacheForTests();
    mockReadTrainingMeshContext.mockReset();
    mockReadCookingMeshContext.mockReset();
    mockReadFinanceMeshContext.mockReset();
    mockReadContentMeshContext.mockReset();
    mockReadSecretaryMeshContext.mockReset();

    mockReadTrainingMeshContext.mockResolvedValue({
      derivedSignals: [
        { signalType: 'recovery_state', payload: { state: 'strained' } },
        { signalType: 'session_prescription', payload: { title: 'Tempo Run', date: '2026-04-17' } },
        { signalType: 'training_load_forecast', payload: { hardSessionCount: 2 } },
        { signalType: 'session_immovability', payload: { title: 'Tempo Run', level: 'high' } },
        { signalType: 'fueling_requirements', payload: { supportLevel: 'elevated', carbFocus: 'high' } },
        { signalType: 'content_capture_opportunity', payload: { angle: 'coach_adjustment', title: 'Tempo Run', date: '2026-04-17' } },
      ],
    });
    mockReadCookingMeshContext.mockResolvedValue({
      derivedSignals: [
        { signalType: 'meal_plan_window', payload: { coveredDays: ['2026-04-17'], missingDates: ['2026-04-18', '2026-04-19'] } },
        { signalType: 'fueling_support_status', payload: { status: 'at_risk', hardDatesMissingMeals: ['2026-04-18'] } },
        { signalType: 'meal_execution_readiness', payload: { status: 'partial' } },
        { signalType: 'grocery_spend_forecast', payload: { estimatedSpendBrl: 92.5, estimatedSpend: 16.65, currency: 'EUR' } },
      ],
    });
    mockReadFinanceMeshContext.mockResolvedValue({
      monthlySummary: {
        transactionCount: 4,
        totalIncome: 1000,
        totalExpenses: 820,
        totalDeductions: 0,
      },
      derivedSignals: [
        {
          signalType: 'budget_remaining',
          payload: {
            month: '2026-04',
            remainingRatio: 0.18,
            budgetMode: 'controlled',
            groceryMode: 'cost_aware',
            trainingSpendMode: 'selective',
            contentSpendMode: 'selective',
            supplementMode: 'pause_new',
          },
        },
        { signalType: 'tax_deadline', payload: { reminderDate: '2026-04-30' } },
      ],
    });
    mockReadContentMeshContext.mockResolvedValue({
      derivedSignals: [
        {
          signalType: 'publishing_commitment',
          payload: {
            upcomingTopicCount: 3,
            nextDate: '2026-04-18',
            nextTopicTitle: 'Race-week recap',
          },
        },
      ],
      filmingRecommendation: {
        date: '2026-04-18',
        blockStart: '2026-04-18T14:00:00.000Z',
        blockEnd: '2026-04-18T16:00:00.000Z',
      },
    });
    mockReadSecretaryMeshContext.mockResolvedValue({
      focusBlock: {
        date: '2026-04-17',
      },
      derivedSignals: [
        { signalType: 'calendar_busy_blocks', payload: { dates: ['2026-04-17', '2026-04-18'], totalEvents: 9 } },
        { signalType: 'travel_window', payload: { dates: ['2026-04-19'] } },
        { signalType: 'inbox_pressure', payload: { overdueCount: 2, dueTodayCount: 1, dueThisWeekCount: 4, pendingCount: 11 } },
      ],
    });
  });

  it('builds a peer context block for training without repeating training state', async () => {
    const context = await buildSharedDecisionContext('triathlon', 42);

    expect(context).toContain('<shared_decision_context domain="triathlon">');
    expect(context).toContain('Cooking:');
    expect(context).toContain('Secretary: calendar is busy on 2 day(s) with 9 events; travel is scheduled on 2026-04-19; focus protection is currently best on 2026-04-17; admin pressure shows 2 overdue and 1 due today');
    expect(context).toContain('fueling support is at_risk because 1 hard training day(s) still lack meals');
    expect(context).toContain('Finance: budget remaining is 18% for 2026-04; training spend mode is selective; supplement mode is pause_new');
    expect(context).toContain('Content: 3 topic(s) are queued');
    expect(context).not.toContain('Training: recovery is strained');
    expect(mockReadTrainingMeshContext).not.toHaveBeenCalled();
    expect(mockReadSecretaryMeshContext).toHaveBeenCalledWith({ userId: 42 });
  });

  it('builds a secretary peer context block with training, cooking, finance, and content tradeoffs', async () => {
    const context = await buildSharedDecisionContext('secretary', 42);

    expect(context).toContain('Training: recovery is strained; next key session is Tempo Run on 2026-04-17');
    expect(context).toContain('session immovability is high for Tempo Run');
    expect(context).toContain('Cooking: 2 day(s) still have no meals planned; fueling support is at_risk with 1 hard training day(s) still lacking meals; execution readiness is partial; shopping forecast is EUR 16.65');
    expect(context).toContain('Finance: budget remaining is 18% for 2026-04; budget mode is controlled; tax deadline lands on 2026-04-30');
    expect(context).toContain('Content: 3 topic(s) are queued; next publish target is "Race-week recap" on 2026-04-18; best filming window is 2026-04-18 14:00-16:00');
    expect(context).not.toContain('BRL');
    expect(mockReadTrainingMeshContext).toHaveBeenCalledWith({ userId: 42 });
  });

  it('gives cooking and content the secretary/content context they need for schedule-aware tradeoffs', async () => {
    const cookingContext = await buildSharedDecisionContext('cooking', 42);
    const contentContext = await buildSharedDecisionContext('content', 42);

    expect(cookingContext).toContain('Secretary:');
    expect(cookingContext).toContain('calendar is busy on 2 day(s)');
    expect(cookingContext).toContain('travel is scheduled on 2026-04-19');
    expect(cookingContext).toContain('focus protection is currently best on 2026-04-17');
    expect(cookingContext).toContain('admin pressure shows 2 overdue and 1 due today');
    expect(cookingContext).toContain('Content: next publish target is "Race-week recap" on 2026-04-18; best filming window is 2026-04-18 14:00-16:00');
    expect(contentContext).toContain('Secretary: calendar is busy on 2 day(s) with 9 events; travel is scheduled on 2026-04-19; focus protection is currently best on 2026-04-17; admin pressure shows 2 overdue and 1 due today');
    expect(contentContext).toContain('Training: recovery is strained; next session is Tempo Run on 2026-04-17; session immovability is high; story angle is coach_adjustment around "Tempo Run" on 2026-04-17');
    expect(mockReadSecretaryMeshContext).toHaveBeenCalledWith({ userId: 42 });
    expect(mockReadContentMeshContext).toHaveBeenCalledWith({ userId: 42 });
  });

  it('returns an empty string when there is no meaningful peer context', async () => {
    mockReadTrainingMeshContext.mockResolvedValueOnce({ derivedSignals: [] });
    mockReadCookingMeshContext.mockResolvedValueOnce({ derivedSignals: [] });
    mockReadFinanceMeshContext.mockResolvedValueOnce({
      monthlySummary: {
        transactionCount: 0,
        totalIncome: 0,
        totalExpenses: 0,
        totalDeductions: 0,
      },
      derivedSignals: [],
    });
    mockReadContentMeshContext.mockResolvedValueOnce({ derivedSignals: [], filmingRecommendation: null });
    mockReadSecretaryMeshContext.mockResolvedValueOnce({ derivedSignals: [], focusBlock: null });

    const context = await buildSharedDecisionContext('finance', 42);
    expect(context).toBe('');
  });

  it('can invalidate a cached user context after peer state changes', async () => {
    const first = await buildSharedDecisionContext('secretary', 42);
    expect(first).toContain('budget mode is controlled');

    mockReadFinanceMeshContext.mockResolvedValueOnce({
      monthlySummary: {
        transactionCount: 4,
        totalIncome: 1000,
        totalExpenses: 920,
        totalDeductions: 0,
      },
      derivedSignals: [
        {
          signalType: 'budget_remaining',
          payload: {
            month: '2026-04',
            remainingRatio: 0.08,
            budgetMode: 'tight',
            groceryMode: 'lean',
            trainingSpendMode: 'minimum_effective_dose',
          },
        },
      ],
    });

    invalidateSharedDecisionContextCache(42);
    const refreshed = await buildSharedDecisionContext('secretary', 42);

    expect(refreshed).toContain('budget mode is tight');
    expect(refreshed).toContain('budget remaining is 8% for 2026-04');
  });

  it('builds typed peer contracts for Secretary with non-negotiables and publish deadlines', async () => {
    const contracts = await buildSharedDecisionContracts('secretary', 42);

    expect(contracts.training?.nonNegotiables).toContain('Keep Tempo Run on 2026-04-17 protected before moving lower-value work.');
    expect(contracts.finance?.budgetMode).toBe('controlled');
    expect(contracts.content?.publishDeadline).toBe('2026-04-18');
    expect(contracts.cooking?.notes).toContain('Shopping forecast: EUR 16.65.');
  });
});
