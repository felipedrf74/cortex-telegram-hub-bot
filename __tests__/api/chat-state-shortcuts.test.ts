// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetFilmingRecommendation = vi.fn();
const mockGetTopics = vi.fn();
const mockGetUpcomingTopicCount = vi.fn();
const mockGetLearnedPatterns = vi.fn();
const mockGetPerformanceSummary = vi.fn();
const mockGetAllInvoiceVendors = vi.fn();
const mockGetFilingsForMonth = vi.fn();
const mockGetSubscriptionStatus = vi.fn();
const mockCalculateMonthlyTax = vi.fn();
const mockFormatCurrencyAmount = vi.fn();
const mockGetMonthlyBudgetView = vi.fn();
const mockGetMonthlySummary = vi.fn();
const mockGetTaxEvents = vi.fn();
const mockGetFiscalCollectionSummary = vi.fn();
const mockGetActiveContentPillars = vi.fn();
const mockGetContentDeskItems = vi.fn();
const mockGetNextContentExecutionHint = vi.fn();
const mockGetRankedContentSignals = vi.fn();
const mockLocalizeFilmingRecommendation = vi.fn();

vi.mock('../../src/services/content-scheduler', () => ({
  getFilmingRecommendation: (...args: unknown[]) => mockGetFilmingRecommendation(...args),
  getTopics: (...args: unknown[]) => mockGetTopics(...args),
  getUpcomingTopicCount: (...args: unknown[]) => mockGetUpcomingTopicCount(...args),
}));

vi.mock('../../src/services/content-learning-store', () => ({
  getLearnedPatterns: (...args: unknown[]) => mockGetLearnedPatterns(...args),
  getPerformanceSummary: (...args: unknown[]) => mockGetPerformanceSummary(...args),
}));

vi.mock('../../src/services/invoice-collector', () => ({
  getAllVendors: (...args: unknown[]) => mockGetAllInvoiceVendors(...args),
}));

vi.mock('../../src/state/invoice-filings', () => ({
  getFilingsForMonth: (...args: unknown[]) => mockGetFilingsForMonth(...args),
}));

vi.mock('../../src/services/stripe-service', () => ({
  getSubscriptionStatus: (...args: unknown[]) => mockGetSubscriptionStatus(...args),
}));

vi.mock('../../src/services/finance-tracker', () => ({
  calculateMonthlyTax: (...args: unknown[]) => mockCalculateMonthlyTax(...args),
  formatCurrencyAmount: (...args: unknown[]) => mockFormatCurrencyAmount(...args),
  getMonthlyBudgetView: (...args: unknown[]) => mockGetMonthlyBudgetView(...args),
  getMonthlySummary: (...args: unknown[]) => mockGetMonthlySummary(...args),
  getTaxEvents: (...args: unknown[]) => mockGetTaxEvents(...args),
}));

vi.mock('../../src/services/fiscal-bundle', () => ({
  getFiscalCollectionSummary: (...args: unknown[]) => mockGetFiscalCollectionSummary(...args),
}));

vi.mock('../../src/services/content-intelligence', () => ({
  getActiveContentPillars: (...args: unknown[]) => mockGetActiveContentPillars(...args),
  getContentDeskItems: (...args: unknown[]) => mockGetContentDeskItems(...args),
  getNextContentExecutionHint: (...args: unknown[]) => mockGetNextContentExecutionHint(...args),
  getRankedContentSignals: (...args: unknown[]) => mockGetRankedContentSignals(...args),
  localizeFilmingRecommendation: (...args: unknown[]) => mockLocalizeFilmingRecommendation(...args),
}));

describe('chat state shortcut builders', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-23T10:00:00.000Z'));

    mockGetFilmingRecommendation.mockReset();
    mockGetTopics.mockReset();
    mockGetUpcomingTopicCount.mockReset();
    mockGetLearnedPatterns.mockReset();
    mockGetPerformanceSummary.mockReset();
    mockGetAllInvoiceVendors.mockReset();
    mockGetFilingsForMonth.mockReset();
    mockGetSubscriptionStatus.mockReset();
    mockCalculateMonthlyTax.mockReset();
    mockFormatCurrencyAmount.mockReset();
    mockGetMonthlyBudgetView.mockReset();
    mockGetMonthlySummary.mockReset();
    mockGetTaxEvents.mockReset();
    mockGetFiscalCollectionSummary.mockReset();
    mockGetActiveContentPillars.mockReset();
    mockGetContentDeskItems.mockReset();
    mockGetNextContentExecutionHint.mockReset();
    mockGetRankedContentSignals.mockReset();
    mockLocalizeFilmingRecommendation.mockReset();

    mockGetTopics.mockReturnValue([]);
    mockGetUpcomingTopicCount.mockReturnValue(0);
    mockGetLearnedPatterns.mockReturnValue([]);
    mockGetPerformanceSummary.mockReturnValue({ count: 0, avgViews: 0, avgRetention: 0, entries: [] });
    mockGetAllInvoiceVendors.mockReturnValue([]);
    mockGetFilingsForMonth.mockReturnValue([]);
    mockGetSubscriptionStatus.mockReturnValue({ isActive: false, currentPeriodEnd: null });
    mockCalculateMonthlyTax.mockReturnValue({ taxDue: 0, inssDue: 0 });
    mockFormatCurrencyAmount.mockImplementation((currency: string, value: number) => `${currency} ${value}`);
    mockGetMonthlyBudgetView.mockReturnValue({
      integrity: 'single_currency',
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      recurringExpenseEstimate: 0,
      recurringExpenseCount: 0,
      incomeInBasisCurrency: 0,
      expensesInBasisCurrency: 0,
    });
    mockGetMonthlySummary.mockReturnValue({
      totalIncome: 0,
      totalExpenses: 0,
      totalDeductions: 0,
      transactionCount: 0,
    });
    mockGetTaxEvents.mockReturnValue([]);
    mockGetFiscalCollectionSummary.mockReturnValue({
      destinationEmail: null,
      providers: [],
      warnings: [],
      profile: {
        cadence: 'monthly',
        last_bundle_sent_at: null,
        last_bundle_document_count: 0,
      },
      ruleCount: 0,
      customRuleCount: 0,
      nextRunAt: null,
      deliveryAvailable: false,
    });
    mockGetActiveContentPillars.mockReturnValue([]);
    mockGetContentDeskItems.mockReturnValue([]);
    mockGetNextContentExecutionHint.mockResolvedValue(null);
    mockGetRankedContentSignals.mockReturnValue([]);
    mockLocalizeFilmingRecommendation.mockImplementation((value: unknown) => value);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns localized desk-ready content snapshot', async () => {
    const { buildContentStateShortcutResponse } = await import('../../src/api/routes/chat-state-shortcuts');
    mockGetContentDeskItems.mockReturnValue([
      { type: 'script_ready', title: 'Semana de corrida' },
      { type: 'weekly_package_ready', title: 'Pacote de bastidores' },
    ]);

    const result = await buildContentStateShortcutResponse('desk', 42, 'pt-PT');

    expect(result.text).toContain('Isto já está na sua mesa agora');
    expect(result.text).toContain('Roteiro pronto');
    expect(result.text).toContain('Pacote semanal pronto');
    expect(result.metadata).toMatchObject({
      type: 'content_desk_snapshot',
      deskReadyCount: 2,
    });
  });

  it('surfaces next execution hint when there is no explicit publish candidate', async () => {
    const { buildContentStateShortcutResponse } = await import('../../src/api/routes/chat-state-shortcuts');
    mockGetNextContentExecutionHint.mockResolvedValue({
      mode: 'reaction_window',
      title: 'Reagir ao treino de hoje',
      confidence: 'high',
      sourceType: 'signal',
    });
    mockGetRankedContentSignals.mockReturnValue([{ type: 'training_win' }]);

    const result = await buildContentStateShortcutResponse('next_publish', 42, 'pt-PT');

    expect(result.text).toContain('A jogada mais forte de conteúdo agora é reagir');
    expect(result.text).toContain('Reagir ao treino de hoje');
    expect(result.metadata).toMatchObject({
      type: 'content_next_publish_snapshot',
      candidateMode: 'reaction_window',
      candidateTitle: 'Reagir ao treino de hoje',
      topSignalType: 'training_win',
    });
  });

  it('builds accountant bundle blockers with provider labels', async () => {
    const { buildFinanceStateShortcutResponse } = await import('../../src/api/routes/chat-state-shortcuts');
    mockGetFiscalCollectionSummary.mockReturnValue({
      destinationEmail: null,
      providers: [
        { provider: 'gmail', connected: true },
        { provider: 'outlook', connected: false },
      ],
      warnings: ['DESTINATION_EMAIL_MISSING', 'BUNDLE_DELIVERY_NOT_CONFIGURED'],
      profile: {
        cadence: 'monthly',
        last_bundle_sent_at: '2026-04-20T09:00:00.000Z',
        last_bundle_document_count: 12,
      },
      ruleCount: 8,
      customRuleCount: 3,
      nextRunAt: '2026-04-28T09:00:00.000Z',
      deliveryAvailable: false,
    });

    const result = buildFinanceStateShortcutResponse('accountant_bundle', 7, 'pt-PT');

    expect(result.text).toContain('A entrega ao contabilista ainda precisa de alguns ajustes');
    expect(result.text).toContain('Fontes de e-mail ligadas: Gmail');
    expect(result.text).toContain('Defina o e-mail de destino do seu contabilista.');
    expect(result.text).toContain('O envio do bundle ainda não está configurado neste servidor.');
    expect(result.metadata).toMatchObject({
      type: 'finance_accountant_bundle_snapshot',
      connectedProviders: ['Gmail'],
      ruleCount: 8,
      deliveryAvailable: false,
    });
  });

  it('reports tracked missing bills for the current month', async () => {
    const { buildFinanceStateShortcutResponse } = await import('../../src/api/routes/chat-state-shortcuts');
    mockGetAllInvoiceVendors.mockReturnValue([
      { name: 'Vodafone' },
      { name: 'EDP' },
      { name: 'MEO' },
    ]);
    mockGetFilingsForMonth.mockReturnValue([
      { status: 'filed', vendor: 'Vodafone' },
    ]);

    const result = buildFinanceStateShortcutResponse('missing_bills', 7, 'en-US');

    expect(result.text).toContain('These tracked bills still look missing');
    expect(result.text).toContain('• EDP');
    expect(result.text).toContain('• MEO');
    expect(result.metadata).toMatchObject({
      type: 'finance_missing_bills_snapshot',
      trackedVendorCount: 3,
      filedVendorCount: 1,
      missingVendors: ['EDP', 'MEO'],
    });
  });
});
