import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetMonthlySummary = vi.fn();
const mockGetMonthlyBudgetView = vi.fn();
const mockGetPreferredCurrencyForUser = vi.fn(() => 'EUR');
const mockGetTaxEvents = vi.fn();
const mockGetAnnualTaxSummary = vi.fn();
const mockGetSubscriptionStatus = vi.fn();

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

vi.mock('../../src/services/finance-tracker', () => ({
  getPreferredCurrencyForUser: (...args: unknown[]) => mockGetPreferredCurrencyForUser(...args),
  getMonthlyBudgetView: (...args: unknown[]) => mockGetMonthlyBudgetView(...args),
  getMonthlySummary: (...args: unknown[]) => mockGetMonthlySummary(...args),
  getTaxEvents: (...args: unknown[]) => mockGetTaxEvents(...args),
  getAnnualTaxSummary: (...args: unknown[]) => mockGetAnnualTaxSummary(...args),
}));

vi.mock('../../src/services/stripe-service', () => ({
  getSubscriptionStatus: (...args: unknown[]) => mockGetSubscriptionStatus(...args),
}));

import { readFinanceMeshContext } from '../../src/services/cross-agent-learning';

describe('readFinanceMeshContext', () => {
  beforeEach(() => {
    mockGetMonthlySummary.mockReset();
    mockGetMonthlyBudgetView.mockReset();
    mockGetPreferredCurrencyForUser.mockReset();
    mockGetTaxEvents.mockReset();
    mockGetAnnualTaxSummary.mockReset();
    mockGetSubscriptionStatus.mockReset();

    mockGetPreferredCurrencyForUser.mockReturnValue('EUR');
    mockGetMonthlyBudgetView.mockReturnValue({
      month: '2026-04',
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'reliable',
      affordability: 'comfortable',
      incomeInBasisCurrency: 0,
      expensesInBasisCurrency: 0,
      currentRemainingInBasisCurrency: 0,
      currentRemainingRatio: 0,
      projectedExpensesInBasisCurrency: 0,
      projectedRemainingInBasisCurrency: 0,
      projectedRemainingRatio: 0,
      recurringExpenseEstimate: 0,
      recurringExpenseCount: 0,
      recurringExpenses: [],
      notes: [],
    });
    mockGetTaxEvents.mockReturnValue([]);
    mockGetAnnualTaxSummary.mockReturnValue({
      year: 2026,
      totalGrossIncome: 0,
      totalDeductions: 0,
      totalInssDue: 0,
      totalTaxDue: 0,
      totalPaid: 0,
      totalPending: 0,
      effectiveAnnualRate: 0,
      monthsPaid: 0,
      monthsPending: 0,
      months: [],
    });
    mockGetSubscriptionStatus.mockReturnValue({
      plan: 'pro',
      period: 'monthly',
      status: 'active',
      provider: 'stripe',
      currentPeriodEnd: '2026-04-22T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      isActive: true,
      isPro: true,
    });
  });

  it('publishes controlled budget modes for tighter months', async () => {
    mockGetMonthlySummary.mockReturnValue({
      month: '2026-04',
      totalIncome: 1000,
      totalExpenses: 820,
      totalDeductions: 0,
      netIncome: 180,
      transactionCount: 4,
    });
    mockGetMonthlyBudgetView.mockReturnValue({
      month: '2026-04',
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'reliable',
      affordability: 'controlled',
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
    });
    mockGetTaxEvents.mockReturnValue([
      {
        month: '2026-04',
        tax_due: 210,
        status: 'pending',
      },
    ]);

    const context = await readFinanceMeshContext({ userId: 42, weekStart: '2026-04-13' });

    const budget = context.derivedSignals.find((signal) => signal.signalType === 'budget_remaining');

    expect(budget?.payload).toMatchObject({
      remainingRatio: 0.18,
      budgetMode: 'controlled',
      groceryMode: 'cost_aware',
      trainingSpendMode: 'selective',
      contentSpendMode: 'selective',
      supplementMode: 'pause_new',
      subscriptionMode: 'review_now',
    });
  });

  it('publishes normal budget modes for healthier months', async () => {
    mockGetMonthlySummary.mockReturnValue({
      month: '2026-04',
      totalIncome: 2000,
      totalExpenses: 900,
      totalDeductions: 0,
      netIncome: 1100,
      transactionCount: 7,
    });
    mockGetMonthlyBudgetView.mockReturnValue({
      month: '2026-04',
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'reliable',
      affordability: 'comfortable',
      incomeInBasisCurrency: 2000,
      expensesInBasisCurrency: 900,
      currentRemainingInBasisCurrency: 1100,
      currentRemainingRatio: 0.55,
      projectedExpensesInBasisCurrency: 900,
      projectedRemainingInBasisCurrency: 1100,
      projectedRemainingRatio: 0.55,
      recurringExpenseEstimate: 0,
      recurringExpenseCount: 0,
      recurringExpenses: [],
      notes: [],
    });

    const context = await readFinanceMeshContext({ userId: 42, weekStart: '2026-04-13' });

    const budget = context.derivedSignals.find((signal) => signal.signalType === 'budget_remaining');

    expect(budget?.payload).toMatchObject({
      remainingRatio: 0.55,
      budgetMode: 'normal',
      groceryMode: 'normal',
      trainingSpendMode: 'normal',
      contentSpendMode: 'normal',
      supplementMode: 'normal',
      subscriptionMode: 'confirm_value',
    });
  });

  it('suppresses budget_remaining and emits a mixed-currency caution when budget headroom is not reliable', async () => {
    mockGetMonthlySummary.mockReturnValue({
      month: '2026-04',
      totalIncome: 2000,
      totalExpenses: 900,
      totalDeductions: 0,
      netIncome: 1100,
      transactionCount: 7,
    });
    mockGetMonthlyBudgetView.mockReturnValue({
      month: '2026-04',
      basisCurrency: 'EUR',
      currencies: ['EUR', 'BRL'],
      integrity: 'mixed_currency',
      affordability: 'unknown',
      incomeInBasisCurrency: 2000,
      expensesInBasisCurrency: 500,
      currentRemainingInBasisCurrency: null,
      currentRemainingRatio: null,
      projectedExpensesInBasisCurrency: null,
      projectedRemainingInBasisCurrency: null,
      projectedRemainingRatio: null,
      recurringExpenseEstimate: 0,
      recurringExpenseCount: 0,
      recurringExpenses: [],
      notes: ['Mixed currencies are logged this month.'],
    });

    const context = await readFinanceMeshContext({ userId: 42, weekStart: '2026-04-13' });

    expect(context.derivedSignals.find((signal) => signal.signalType === 'budget_remaining')).toBeUndefined();
    expect(context.derivedSignals.find((signal) => signal.signalType === 'expense_anomaly')?.payload).toMatchObject({
      reason: 'mixed_currency_budget',
      currencies: ['EUR', 'BRL'],
    });
  });

  it('uses projected recurring pressure when classifying budget mode', async () => {
    mockGetMonthlySummary.mockReturnValue({
      month: '2026-04',
      totalIncome: 2000,
      totalExpenses: 1200,
      totalDeductions: 0,
      netIncome: 800,
      transactionCount: 7,
    });
    mockGetMonthlyBudgetView.mockReturnValue({
      month: '2026-04',
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'reliable',
      affordability: 'tight',
      incomeInBasisCurrency: 2000,
      expensesInBasisCurrency: 1200,
      currentRemainingInBasisCurrency: 800,
      currentRemainingRatio: 0.4,
      projectedExpensesInBasisCurrency: 1800,
      projectedRemainingInBasisCurrency: 200,
      projectedRemainingRatio: 0.1,
      recurringExpenseEstimate: 600,
      recurringExpenseCount: 2,
      recurringExpenses: [],
      notes: ['Recurring expense pressure still likely this month.'],
    });

    const context = await readFinanceMeshContext({ userId: 42, weekStart: '2026-04-13' });

    expect(context.derivedSignals.find((signal) => signal.signalType === 'budget_remaining')?.payload).toMatchObject({
      remainingRatio: 0.1,
      projectedRemainingRatio: 0.1,
      recurringExpenseEstimate: 600,
      recurringExpenseCount: 2,
      budgetMode: 'tight',
      groceryMode: 'essentials_only',
      trainingSpendMode: 'maintenance_only',
      contentSpendMode: 'lean',
      supplementMode: 'essentials_only',
    });
  });
});
