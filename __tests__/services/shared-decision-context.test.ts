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
  invalidateSharedContextForSkillChange,
  invalidateSharedDecisionContextCache,
  resetSharedDecisionContextCacheForTests,
} from '../../src/services/shared-decision-context';

function makeBudgetView(overrides: Partial<{
  month: string;
  basisCurrency: string;
  currencies: string[];
  integrity: 'reliable' | 'mixed_currency' | 'no_income';
  affordability: 'tight' | 'controlled' | 'comfortable' | 'unknown';
  incomeInBasisCurrency: number;
  expensesInBasisCurrency: number;
  currentRemainingInBasisCurrency: number | null;
  currentRemainingRatio: number | null;
  projectedExpensesInBasisCurrency: number | null;
  projectedRemainingInBasisCurrency: number | null;
  projectedRemainingRatio: number | null;
  recurringExpenseEstimate: number;
  recurringExpenseCount: number;
  recurringExpenses: unknown[];
  notes: string[];
}> = {}) {
  return {
    month: '2026-04',
    basisCurrency: 'EUR',
    currencies: ['EUR'],
    integrity: 'reliable' as const,
    affordability: 'controlled' as const,
    incomeInBasisCurrency: 1000,
    expensesInBasisCurrency: 820,
    currentRemainingInBasisCurrency: 180,
    currentRemainingRatio: 0.18,
    projectedExpensesInBasisCurrency: 820,
    projectedRemainingInBasisCurrency: 180,
    projectedRemainingRatio: 0.18,
    recurringExpenseEstimate: 0,
    recurringExpenseCount: 0,
    recurringExpenses: [],
    notes: [],
    ...overrides,
  };
}

function futureIso(minutes = 120): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function pastIso(minutes = 5): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function meshSignal(input: {
  signalType: string;
  payload?: Record<string, unknown>;
  sourceAgent?: string;
  priority?: string;
  meshPriority?: number;
  expiresAt?: string;
}) {
  return {
    sourceAgent: input.sourceAgent ?? 'mesh.test',
    signalType: input.signalType,
    priority: input.priority ?? 'normal',
    meshPriority: input.meshPriority ?? 3,
    payload: input.payload ?? {},
    expiresAt: input.expiresAt ?? futureIso(),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

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
      budgetView: makeBudgetView(),
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
    expect(context).toContain('fueling support is at_risk because hard training lacks meals on 2026-04-18');
    expect(context).toContain('Finance: projected budget remaining is 18% for 2026-04; training spend mode is selective; supplement mode is pause_new');
    expect(context).toContain('Content: 3 topic(s) are queued');
    expect(context).not.toContain('Training: recovery is strained');
    expect(mockReadTrainingMeshContext).not.toHaveBeenCalled();
    expect(mockReadSecretaryMeshContext).toHaveBeenCalledWith({ userId: 42, tenantId: 42 });
  });

  it('builds a secretary peer context block with training, cooking, finance, and content tradeoffs', async () => {
    const context = await buildSharedDecisionContext('secretary', 42);

    expect(context).toContain('Training: recovery is strained; next key session is Tempo Run on 2026-04-17');
    expect(context).toContain('session immovability is high for Tempo Run');
    expect(context).toContain('Cooking: 2 day(s) still have no meals planned; fueling support is at_risk with 1 hard training day(s) still lacking meals; execution readiness is partial; shopping forecast is EUR 16.65');
    expect(context).toContain('Finance: projected budget remaining is 18% for 2026-04; budget mode is controlled; tax deadline lands on 2026-04-30');
    expect(context).toContain('Content: 3 topic(s) are queued; next publish target is "Race-week recap" on 2026-04-18; best filming window is 2026-04-18 14:00-16:00');
    expect(context).not.toContain('BRL');
    expect(mockReadTrainingMeshContext).toHaveBeenCalledWith({ userId: 42, tenantId: 42 });
  });

  it('adds source attribution, skill ownership boundaries, and downstream update signals for Training -> Secretary', async () => {
    mockReadTrainingMeshContext.mockResolvedValueOnce({
      derivedSignals: [
        meshSignal({
          sourceAgent: 'mesh.training-context',
          signalType: 'recovery_state',
          priority: 'urgent',
          meshPriority: 2,
          payload: { state: 'strained' },
        }),
        meshSignal({
          sourceAgent: 'mesh.training-context',
          signalType: 'session_prescription',
          meshPriority: 3,
          payload: { title: 'Tempo Run', date: '2026-04-17' },
        }),
      ],
    });

    const context = await buildSharedDecisionContext('secretary', 42);

    expect(context).toContain('<context_scope tenant_id="42" user_id="42" visibility="user_private"');
    expect(context).toContain('Training: recovery is strained; next key session is Tempo Run on 2026-04-17');
    expect(context).toContain('training.recovery_state: source=mesh.training-context; freshness=active; confidence=0.84; priority=urgent; meshPriority=2');
    expect(context).toContain('Secretary owns schedule placement, agenda feasibility, reminders, reflow, and calendar arbitration.');
    expect(context).toContain('Training owns workout content, recovery logic, and training-plan shape.');
    expect(context).toContain('If training changes its source state, invalidate shared context and refresh secretary before acting from cached tradeoffs.');
  });

  it('keeps Training -> Cooking and Content -> Secretary context visible with source metadata', async () => {
    mockReadTrainingMeshContext.mockResolvedValue({
      derivedSignals: [
        meshSignal({
          sourceAgent: 'mesh.training-fueling',
          signalType: 'fueling_requirements',
          meshPriority: 2,
          payload: { supportLevel: 'elevated', carbFocus: 'high' },
        }),
      ],
    });
    mockReadContentMeshContext.mockResolvedValue({
      derivedSignals: [
        meshSignal({
          sourceAgent: 'mesh.content-calendar',
          signalType: 'publishing_commitment',
          meshPriority: 2,
          payload: { upcomingTopicCount: 2, nextDate: '2026-04-21', nextTopicTitle: 'Build week recap' },
        }),
      ],
      filmingRecommendation: null,
    });

    const cookingContext = await buildSharedDecisionContext('cooking', 42);
    const secretaryContext = await buildSharedDecisionContext('secretary', 42);

    expect(cookingContext).toContain('Training: fueling support is elevated with high carb focus');
    expect(cookingContext).toContain('training.fueling_requirements: source=mesh.training-fueling');
    expect(secretaryContext).toContain('Content: 2 topic(s) are queued; next publish target is "Build week recap" on 2026-04-21');
    expect(secretaryContext).toContain('content.publishing_commitment: source=mesh.content-calendar');
  });

  it('shares Finance constraints into Training and Cooking without losing scope metadata', async () => {
    mockReadFinanceMeshContext.mockResolvedValue({
      monthlySummary: { transactionCount: 4, totalIncome: 1000, totalExpenses: 900, totalDeductions: 0 },
      budgetView: makeBudgetView({
        expensesInBasisCurrency: 900,
        currentRemainingInBasisCurrency: 100,
        currentRemainingRatio: 0.1,
        projectedExpensesInBasisCurrency: 900,
        projectedRemainingInBasisCurrency: 100,
        projectedRemainingRatio: 0.1,
        affordability: 'tight',
      }),
      derivedSignals: [
        meshSignal({
          sourceAgent: 'mesh.finance-budget',
          signalType: 'budget_remaining',
          priority: 'high',
          meshPriority: 1,
          payload: {
            month: '2026-04',
            remainingRatio: 0.1,
            budgetMode: 'tight',
            groceryMode: 'lean',
            trainingSpendMode: 'minimum_effective_dose',
          },
        }),
      ],
    });

    const trainingContext = await buildSharedDecisionContext('triathlon', 42);
    const cookingContext = await buildSharedDecisionContext('cooking', 42);

    expect(trainingContext).toContain('Finance: projected budget remaining is 10% for 2026-04; training spend mode is minimum_effective_dose');
    expect(trainingContext).toContain('finance.budget_remaining: source=mesh.finance-budget; freshness=active; confidence=0.92');
    expect(cookingContext).toContain('Finance: projected budget remaining is 10% for 2026-04; grocery mode is lean');
    expect(cookingContext).toContain('finance.budget_remaining: source=mesh.finance-budget; freshness=active; confidence=0.92');
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
    expect(mockReadSecretaryMeshContext).toHaveBeenCalledWith({ userId: 42, tenantId: 42 });
    expect(mockReadContentMeshContext).toHaveBeenCalledWith({ userId: 42, tenantId: 42 });
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
      budgetView: makeBudgetView({
        integrity: 'no_income',
        affordability: 'unknown',
        incomeInBasisCurrency: 0,
        expensesInBasisCurrency: 0,
        currentRemainingInBasisCurrency: null,
        currentRemainingRatio: null,
        projectedExpensesInBasisCurrency: null,
        projectedRemainingInBasisCurrency: null,
        projectedRemainingRatio: null,
      }),
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
      budgetView: makeBudgetView({
        expensesInBasisCurrency: 920,
        currentRemainingInBasisCurrency: 80,
        currentRemainingRatio: 0.08,
        projectedExpensesInBasisCurrency: 920,
        projectedRemainingInBasisCurrency: 80,
        projectedRemainingRatio: 0.08,
        affordability: 'tight',
      }),
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
    expect(refreshed).toContain('projected budget remaining is 8% for 2026-04');
  });

  it('invalidates shared decision and chat context together after a source skill update signal', async () => {
    const first = await buildSharedDecisionContext('secretary', 42);
    expect(first).toContain('budget mode is controlled');

    mockReadFinanceMeshContext.mockResolvedValueOnce({
      monthlySummary: {
        transactionCount: 4,
        totalIncome: 1000,
        totalExpenses: 930,
        totalDeductions: 0,
      },
      budgetView: makeBudgetView({
        expensesInBasisCurrency: 930,
        currentRemainingInBasisCurrency: 70,
        currentRemainingRatio: 0.07,
        projectedExpensesInBasisCurrency: 930,
        projectedRemainingInBasisCurrency: 70,
        projectedRemainingRatio: 0.07,
        affordability: 'tight',
      }),
      derivedSignals: [
        meshSignal({
          sourceAgent: 'mesh.finance-budget',
          signalType: 'budget_remaining',
          meshPriority: 1,
          payload: {
            month: '2026-04',
            remainingRatio: 0.07,
            budgetMode: 'tight',
            groceryMode: 'lean',
            trainingSpendMode: 'minimum_effective_dose',
          },
        }),
      ],
    });

    invalidateSharedContextForSkillChange({
      userId: 42,
      tenantId: 0,
      sourceSkill: 'finance',
      reason: 'budget_updated',
    });
    const refreshed = await buildSharedDecisionContext('secretary', 42);

    expect(refreshed).toContain('budget mode is tight');
    expect(refreshed).toContain('projected budget remaining is 7% for 2026-04');
  });

  it('ignores stale peer signals and records why they were excluded', async () => {
    mockReadTrainingMeshContext.mockResolvedValueOnce({
      derivedSignals: [
        meshSignal({
          sourceAgent: 'mesh.training-context',
          signalType: 'recovery_state',
          meshPriority: 2,
          payload: { state: 'critical' },
          expiresAt: pastIso(),
        }),
      ],
    });
    mockReadCookingMeshContext.mockResolvedValueOnce({ derivedSignals: [] });
    mockReadFinanceMeshContext.mockResolvedValueOnce({
      monthlySummary: {
        transactionCount: 0,
        totalIncome: 0,
        totalExpenses: 0,
        totalDeductions: 0,
      },
      budgetView: makeBudgetView({
        integrity: 'no_income',
        affordability: 'unknown',
        incomeInBasisCurrency: 0,
        expensesInBasisCurrency: 0,
        currentRemainingInBasisCurrency: null,
        currentRemainingRatio: null,
        projectedExpensesInBasisCurrency: null,
        projectedRemainingInBasisCurrency: null,
        projectedRemainingRatio: null,
      }),
      derivedSignals: [],
    });
    mockReadContentMeshContext.mockResolvedValueOnce({ derivedSignals: [], filmingRecommendation: null });
    mockReadSecretaryMeshContext.mockResolvedValueOnce({ derivedSignals: [], focusBlock: null });

    const context = await buildSharedDecisionContext('secretary', 42);

    expect(context).toContain('<stale_context>');
    expect(context).toContain('training.recovery_state: ignored stale signal from mesh.training-context');
    expect(context).not.toContain('Training: recovery is critical');
    expect(context).toContain('No fresh peer-skill signals');
  });

  it('deduplicates repeated cross-skill warnings before Chat or Secretary consume them', async () => {
    const duplicateFueling = meshSignal({
      sourceAgent: 'mesh.cooking-fueling',
      signalType: 'fueling_support_status',
      meshPriority: 2,
      payload: { status: 'at_risk', hardDatesMissingMeals: ['2026-04-18'] },
    });
    mockReadCookingMeshContext.mockResolvedValueOnce({
      derivedSignals: [
        duplicateFueling,
        { ...duplicateFueling },
        meshSignal({
          sourceAgent: 'mesh.cooking-execution',
          signalType: 'meal_execution_readiness',
          payload: { status: 'partial' },
        }),
      ],
    });

    const context = await buildSharedDecisionContext('triathlon', 42);

    expect(countOccurrences(context, 'fueling support is at_risk because hard training lacks meals on 2026-04-18')).toBe(1);
    expect(countOccurrences(context, 'cooking.fueling_support_status: source=mesh.cooking-fueling')).toBe(1);
  });

  it('refuses peer mesh prompt context for a non-canonical tenant until tenant-aware mesh reads exist', async () => {
    const tenantA = await buildSharedDecisionContext('secretary', 42, 1001);
    expect(tenantA).toBe('');

    mockReadFinanceMeshContext.mockResolvedValueOnce({
      monthlySummary: {
        transactionCount: 4,
        totalIncome: 1000,
        totalExpenses: 920,
        totalDeductions: 0,
      },
      budgetView: makeBudgetView({
        expensesInBasisCurrency: 920,
        currentRemainingInBasisCurrency: 80,
        currentRemainingRatio: 0.08,
        projectedExpensesInBasisCurrency: 920,
        projectedRemainingInBasisCurrency: 80,
        projectedRemainingRatio: 0.08,
        affordability: 'tight',
      }),
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

    const tenantB = await buildSharedDecisionContext('secretary', 42, 1002);
    expect(tenantB).toBe('');
    expect(mockReadFinanceMeshContext).not.toHaveBeenCalled();
  });

  it('builds typed peer contracts for Secretary with non-negotiables and publish deadlines', async () => {
    const contracts = await buildSharedDecisionContracts('secretary', 42);

    expect(contracts.training?.nonNegotiables).toContain('Keep Tempo Run on 2026-04-17 protected before moving lower-value work.');
    expect(contracts.finance?.budgetMode).toBe('controlled');
    expect(contracts.content?.publishDeadline).toBe('2026-04-18');
    expect(contracts.cooking?.notes).toContain('Shopping forecast: EUR 16.65.');
  });

  // ── Cross-skill contract enrichments ──────────────────────────────

  it('critical recovery forces Content to defer filming explicitly', async () => {
    mockReadTrainingMeshContext.mockResolvedValueOnce({
      derivedSignals: [
        { signalType: 'recovery_state', payload: { state: 'critical' } },
        { signalType: 'session_prescription', payload: { title: 'Long Ride', date: '2026-04-20' } },
      ],
    });

    const contracts = await buildSharedDecisionContracts('content', 42);
    expect(contracts.training?.nonNegotiables).toContain(
      'Defer filming and new capture asks — recovery is critical, protect it explicitly this week.',
    );
    expect(contracts.training?.fallbackIfDeferred).toContain(
      'Move filming to a future recovered-state week; surface this to Secretary so the calendar slot re-opens.',
    );
    expect(contracts.training?.notes).toContain(
      'Content-capture priority is currently deprioritized while recovery stabilizes.',
    );
  });

  it('Secretary sees filming as first-candidate for deferral when recovery is strained', async () => {
    const contracts = await buildSharedDecisionContracts('secretary', 42);
    // Default mock has recovery_state=strained → the filming-deferrable note should fire
    expect(contracts.training?.fallbackIfDeferred).toContain(
      'Filming and content-capture blocks are the first-candidate for deferral while recovery stabilizes.',
    );
  });

  it('very-tight budget defers supplements + equipment in Training contract', async () => {
    // Persistent override — buildSharedDecisionContracts may read finance
    // context more than once internally, so mockResolvedValueOnce gets
    // consumed before our call completes. mockResolvedValue stays until
    // the next reset.
    mockReadFinanceMeshContext.mockResolvedValue({
      monthlySummary: { transactionCount: 2, totalIncome: 1000, totalExpenses: 950, totalDeductions: 0 },
      budgetView: makeBudgetView({
        expensesInBasisCurrency: 950,
        currentRemainingInBasisCurrency: 50,
        currentRemainingRatio: 0.05,
        projectedExpensesInBasisCurrency: 950,
        projectedRemainingInBasisCurrency: 50,
        projectedRemainingRatio: 0.05,
        affordability: 'tight',
      }),
      derivedSignals: [
        {
          signalType: 'budget_remaining',
          payload: {
            month: '2026-04',
            remainingRatio: 0.05,
            budgetMode: 'tight',
            trainingSpendMode: 'minimum_effective_dose',
            supplementMode: 'pause',
          },
        },
      ],
    });

    const contracts = await buildSharedDecisionContracts('triathlon', 42);
    expect(contracts.finance?.nonNegotiables).toContain(
      'Budget headroom is at or below 10% — defer supplement, gear, and equipment asks this cycle.',
    );
    expect(contracts.finance?.preferredWindows).toContain('Supplement spend mode is pause.');
    expect(contracts.finance?.notes).toContain('Projected budget remaining: 5% for 2026-04.');
  });

  it('Training contracts turn Secretary schedule pressure into reflow guidance', async () => {
    mockReadSecretaryMeshContext.mockResolvedValue({
      focusBlock: { date: '2026-04-20' },
      derivedSignals: [
        { signalType: 'calendar_busy_blocks', payload: { dates: ['2026-04-20'], totalEvents: 7 } },
        {
          signalType: 'calendar_fragmentation',
          payload: { dates: ['2026-04-20', '2026-04-21'], fragmentedDayCount: 2, maxEventsInDay: 6 },
        },
        { signalType: 'meeting_criticality', payload: { criticalEventCount: 2 } },
      ],
    });

    const contracts = await buildSharedDecisionContracts('triathlon', 42);
    expect(contracts.secretary?.nonNegotiables).toContain(
      '2 critical meeting(s) are protected and should not be displaced by training.',
    );
    expect(contracts.secretary?.preferredWindows).toContain(
      'Prefer lower-friction sessions on fragmented calendar days (2026-04-20, 2026-04-21).',
    );
    expect(contracts.secretary?.fallbackIfDeferred).toContain(
      'If availability changes, reflow the training plan and resync agenda ownership before showing the old schedule as final.',
    );
  });

  it('Training contracts keep fueling gaps specific and non-noisy', async () => {
    const contracts = await buildSharedDecisionContracts('triathlon', 42);
    expect(contracts.cooking?.nonNegotiables).toContain(
      'Hard-session fueling is still missing on 2026-04-18.',
    );
    expect(contracts.cooking?.fallbackIfDeferred).toContain(
      'Reflow, lower, or shorten hard training before forcing unsupported fueling through another warning.',
    );
    expect(contracts.cooking?.notes).toContain(
      'Fueling gap dates are already named above; do not repeat generic fueling warnings in the coach rationale.',
    );
  });

  it('very-tight budget anchors Cooking on cheap staples', async () => {
    mockReadFinanceMeshContext.mockResolvedValueOnce({
      monthlySummary: { transactionCount: 2, totalIncome: 1000, totalExpenses: 950, totalDeductions: 0 },
      budgetView: makeBudgetView({
        expensesInBasisCurrency: 950,
        currentRemainingInBasisCurrency: 50,
        currentRemainingRatio: 0.08,
        projectedExpensesInBasisCurrency: 920,
        projectedRemainingInBasisCurrency: 80,
        projectedRemainingRatio: 0.08,
        affordability: 'tight',
      }),
      derivedSignals: [
        {
          signalType: 'budget_remaining',
          payload: {
            month: '2026-04',
            remainingRatio: 0.08,
            budgetMode: 'tight',
            groceryMode: 'lean',
          },
        },
      ],
    });

    const contracts = await buildSharedDecisionContracts('cooking', 42);
    expect(contracts.finance?.nonNegotiables).toContain(
      'Budget headroom is at or below 10% — anchor meal suggestions on cheap staples (rice, beans, eggs, seasonal veg).',
    );
    expect(contracts.finance?.preferredWindows).toContain('Grocery mode is lean.');
  });

  it('moderate budget gets the balanced guidance line on Cooking', async () => {
    mockReadFinanceMeshContext.mockResolvedValueOnce({
      monthlySummary: { transactionCount: 2, totalIncome: 1000, totalExpenses: 700, totalDeductions: 0 },
      budgetView: makeBudgetView({
        expensesInBasisCurrency: 700,
        currentRemainingInBasisCurrency: 300,
        currentRemainingRatio: 0.3,
        projectedExpensesInBasisCurrency: 700,
        projectedRemainingInBasisCurrency: 300,
        projectedRemainingRatio: 0.3,
        affordability: 'controlled',
      }),
      derivedSignals: [
        {
          signalType: 'budget_remaining',
          payload: {
            month: '2026-04',
            remainingRatio: 0.3,
            budgetMode: 'controlled',
            groceryMode: 'cost_aware',
          },
        },
      ],
    });

    const contracts = await buildSharedDecisionContracts('cooking', 42);
    expect(contracts.finance?.preferredWindows.some((line) => line.includes('10\u201350% remaining'))).toBe(true);
  });

  it('publish deadline derives a filming/edit window 3–5 days before publish', async () => {
    const contracts = await buildSharedDecisionContracts('secretary', 42);
    // Default mock has nextDate='2026-04-18' → window is 2026-04-13 to 2026-04-15
    expect(contracts.content?.nonNegotiables).toContain(
      'Protect 2026-04-13\u20132026-04-15 as the filming/edit window for that publish date.',
    );
  });

  it('keeps actionable content execution visible across secretary, cooking, and finance even without a publish date', async () => {
    mockReadContentMeshContext.mockResolvedValue({
      derivedSignals: [],
      filmingRecommendation: null,
      nextExecution: {
        mode: 'script_ready',
        title: 'Marathon recap hook',
        summary: 'Script is already ready and only needs a protected execution block.',
        scheduledDate: '2026-04-19',
        confidence: 'high',
        sourceType: 'desk_item',
      },
    });

    const [secretaryContext, financeContext, cookingContracts, financeContracts] = await Promise.all([
      buildSharedDecisionContext('secretary', 42),
      buildSharedDecisionContext('finance', 42),
      buildSharedDecisionContracts('cooking', 42),
      buildSharedDecisionContracts('finance', 42),
    ]);

    expect(secretaryContext).toContain('next content move is to execute the ready script "Marathon recap hook"');
    expect(financeContext).toContain('next content move is to execute the ready script "Marathon recap hook"');
    expect(cookingContracts.content?.notes).toContain(
      'Next execution: next content move is to execute the ready script "Marathon recap hook" by 2026-04-19.',
    );
    expect(financeContracts.content?.notes).toContain(
      'Next execution: next content move is to execute the ready script "Marathon recap hook" by 2026-04-19.',
    );
  });

  it('Training sees actionable content execution as creator workload, not optional noise', async () => {
    mockReadContentMeshContext.mockResolvedValue({
      derivedSignals: [],
      filmingRecommendation: null,
      nextExecution: {
        mode: 'film_window',
        title: 'Strength block story',
        summary: 'Film the weekly training insight while the block is still current.',
        scheduledDate: '2026-04-21',
        confidence: 'high',
        sourceType: 'desk_item',
      },
    });

    const [context, contracts] = await Promise.all([
      buildSharedDecisionContext('triathlon', 42),
      buildSharedDecisionContracts('triathlon', 42),
    ]);

    expect(context).toContain('next content move is to capture "Strength block story" on 2026-04-21');
    expect(contracts.content?.preferredWindows).toContain(
      'next content move is to capture "Strength block story" on 2026-04-21.',
    );
    expect(contracts.content?.fallbackIfDeferred).toContain(
      'Avoid stacking hard doubles on the same day as the next content execution unless Secretary confirms spare capacity.',
    );
  });

  it('malformed publish date does not crash the contract builder', async () => {
    mockReadContentMeshContext.mockResolvedValueOnce({
      derivedSignals: [
        { signalType: 'publishing_commitment', payload: { upcomingTopicCount: 1, nextDate: 'not-a-date' } },
      ],
      filmingRecommendation: null,
    });

    const contracts = await buildSharedDecisionContracts('secretary', 42);
    // Should still return a contract, just without the filming-window line
    expect(contracts.content).not.toBeNull();
    expect(contracts.content?.nonNegotiables.some((line) => line.includes('filming/edit window'))).toBe(false);
  });

  it('at-risk fueling surfaces day-before prep reservation to Secretary', async () => {
    // Default mock has fueling_support_status.hardDatesMissingMeals=['2026-04-18']
    const contracts = await buildSharedDecisionContracts('secretary', 42);
    expect(contracts.cooking?.nonNegotiables).toContain(
      'Reserve 60\u201390 min of prep/cook time on 2026-04-17 to cover the upcoming hard session(s).',
    );
  });

  it('meal prep pressure is surfaced explicitly to Secretary when cooking execution is fragile', async () => {
    mockReadCookingMeshContext.mockResolvedValue({
      derivedSignals: [
        { signalType: 'meal_plan_window', payload: { coveredDays: ['2026-04-17'], missingDates: ['2026-04-18'] } },
        {
          signalType: 'meal_execution_readiness',
          payload: {
            status: 'partial',
            prepPressureDates: ['2026-04-17', '2026-04-18'],
            constrainedMealDates: ['2026-04-17'],
            highEffortMealCount: 2,
            manualMealCount: 1,
          },
        },
      ],
    });

    const contracts = await buildSharedDecisionContracts('secretary', 42);
    expect(contracts.cooking?.preferredWindows).toContain(
      'Prep pressure lands on 2026-04-17, 2026-04-18 — simplify food execution ahead of those dates.',
    );
    expect(contracts.cooking?.fallbackIfDeferred).toContain(
      'If prep keeps slipping, replace high-effort meals on the pressured dates with simpler repeatable options.',
    );
    expect(contracts.cooking?.notes).toContain(
      'Meal execution pressure hits 2026-04-17, 2026-04-18 with 2 high-effort meal(s).',
    );
  });

  it('Secretary focus block is binding on Content and Cooking as a non-negotiable', async () => {
    const [contentContracts, cookingContracts] = await Promise.all([
      buildSharedDecisionContracts('content', 42),
      buildSharedDecisionContracts('cooking', 42),
    ]);

    expect(contentContracts.secretary?.nonNegotiables).toContain(
      'Do not place filming or capture blocks on 2026-04-17 — Secretary is protecting it as a focus block.',
    );
    expect(cookingContracts.secretary?.nonNegotiables).toContain(
      'Do not place prep or shopping on 2026-04-17 — Secretary is protecting it as a focus block.',
    );
  });

  it('coach phase memory surfaces as a Secretary-facing training note', async () => {
    mockReadTrainingMeshContext.mockResolvedValueOnce({
      derivedSignals: [
        { signalType: 'recovery_state', payload: { state: 'stable' } },
        { signalType: 'session_prescription', payload: { title: 'Easy Run', date: '2026-04-17' } },
      ],
      coachPhaseMemory: {
        phase: 'build',
        weekInPhase: 3,
        phaseTotalWeeks: 6,
        narrative: 'Progressing from aerobic base to specific intensity.',
        adherenceTrend: 'improving',
        recentDeloadDates: ['2026-03-25'],
        activeConcern: null,
        nextExpectedShift: 'Deload end of week 4 if adherence holds.',
        writtenAt: '2026-04-10T09:00:00Z',
      },
    });

    const contracts = await buildSharedDecisionContracts('secretary', 42);
    const note = contracts.training?.notes.join(' ') ?? '';
    expect(note).toContain('Training phase: build (week 3/6)');
    expect(note).toContain('adherence improving');
    expect(note).toContain('next shift: Deload end of week 4 if adherence holds');
  });

  it('missing coach phase memory leaves the training note clean (falls back to recovery only)', async () => {
    // Default mock returns no coachPhaseMemory — should not inject any phase line
    const contracts = await buildSharedDecisionContracts('secretary', 42);
    const note = contracts.training?.notes.join(' ') ?? '';
    expect(note).toContain('Recovery state: strained');
    expect(note).not.toContain('Training phase:');
  });
});
