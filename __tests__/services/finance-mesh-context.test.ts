import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetMonthlySummary = vi.fn();
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
}));

vi.mock('../../src/services/finance-tracker', () => ({
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
    mockGetTaxEvents.mockReset();
    mockGetAnnualTaxSummary.mockReset();
    mockGetSubscriptionStatus.mockReset();

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
});
