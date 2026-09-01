import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

const mockGetUserLanguage = vi.fn(() => 'en-US');
const mockGetDailyContext = vi.fn(() => '');
const mockBuildDailyContext = vi.fn(async () => '');
const mockGetLatestByType = vi.fn(() => null);
const mockComposeDailyBrief = vi.fn(async () => ({
  coordination: { topPriority: null, executionOrder: [], watchouts: [], handoffs: [] },
  day: { secretary: { priorityNote: null, tradeoffNote: null } },
}));
const mockGetUnreadMailSummaryForUser = vi.fn(async () => ({ totalUnread: 0, outlookUnread: 0, gmailUnread: 0 }));
const mockGetMonthlySummary = vi.fn(() => ({
  month: '2026-04',
  totalIncome: 0,
  totalExpenses: 0,
  totalDeductions: 0,
  netIncome: 0,
  transactionCount: 0,
}));
const mockGetPreferredCurrencyForUser = vi.fn(() => 'EUR');
const mockFormatCurrencyAmount = vi.fn((currency: string, amount: number) => `${currency} ${amount.toFixed(2)}`);
const mockGetContentDeskItems = vi.fn(() => []);
const mockGetActiveContentPillars = vi.fn(() => []);

vi.mock('../../src/services/user-service', () => ({
  // Identity-safety: chat domains call the strict by-id helpers post-audit.
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
  getUserLanguageById: (...args: unknown[]) => mockGetUserLanguage(...args),
  getPreferredDisplayName: vi.fn(() => 'Test User'),
  getPreferredDisplayNameById: vi.fn(() => 'Test User'),
  getUserTimezone: vi.fn(() => 'Europe/Lisbon'),
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
}));

vi.mock('../../src/services/context-engine', () => ({
  getDailyContext: (...args: unknown[]) => mockGetDailyContext(...args),
  buildDailyContext: (...args: unknown[]) => mockBuildDailyContext(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getLatestByType: (...args: unknown[]) => mockGetLatestByType(...args),
}));

vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: (...args: unknown[]) => mockComposeDailyBrief(...args),
}));

vi.mock('../../src/services/unified-mail-pressure', () => ({
  getUnreadMailSummaryForUser: (...args: unknown[]) => mockGetUnreadMailSummaryForUser(...args),
}));

vi.mock('../../src/services/finance-tracker', () => ({
  getMonthlySummary: (...args: unknown[]) => mockGetMonthlySummary(...args),
  getPreferredCurrencyForUser: (...args: unknown[]) => mockGetPreferredCurrencyForUser(...args),
  formatCurrencyAmount: (...args: unknown[]) => mockFormatCurrencyAmount(...args),
}));

vi.mock('../../src/services/content-intelligence', () => ({
  getContentDeskItems: (...args: unknown[]) => mockGetContentDeskItems(...args),
  getActiveContentPillars: (...args: unknown[]) => mockGetActiveContentPillars(...args),
}));

import { buildAITemporarilyBusyResponse } from '../../src/domains/ai-unavailable';

describe('buildAITemporarilyBusyResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetDailyContext.mockReturnValue('');
    mockBuildDailyContext.mockResolvedValue('');
    mockGetLatestByType.mockReturnValue(null);
    mockComposeDailyBrief.mockResolvedValue({
      coordination: { topPriority: null, executionOrder: [], watchouts: [], handoffs: [] },
      day: { secretary: { priorityNote: null, tradeoffNote: null } },
    });
    mockGetUnreadMailSummaryForUser.mockResolvedValue({ totalUnread: 0, outlookUnread: 0, gmailUnread: 0 });
    mockGetMonthlySummary.mockReturnValue({
      month: '2026-04',
      totalIncome: 0,
      totalExpenses: 0,
      totalDeductions: 0,
      netIncome: 0,
      transactionCount: 0,
    });
    mockGetPreferredCurrencyForUser.mockReturnValue('EUR');
    mockFormatCurrencyAmount.mockImplementation((currency: string, amount: number) => `${currency} ${amount.toFixed(2)}`);
    mockGetContentDeskItems.mockReturnValue([]);
    mockGetActiveContentPillars.mockReturnValue([]);
    clearTenantScopeAnomaliesForTests();
  });

  it('keeps the generic degraded copy for non-training domains', async () => {
    const response = await buildAITemporarilyBusyResponse('secretary', 41);

    expect(response.domain).toBe('secretary');
    expect(response.text).toContain('temporarily busy');
    expect(response.text).not.toContain('Saved training context');
  });

  it('uses saved coach briefing and daily context for training overloads', async () => {
    mockGetDailyContext.mockReturnValue(
      'TRAINING: Tempo ride (planned)\nREADINESS: 68/100 (yellow) — Keep intensity controlled',
    );
    mockGetLatestByType.mockReturnValue({
      id: 1,
      userId: 41,
      type: 'coach_briefing',
      title: 'Coach briefing',
      summary: 'Keep tomorrow controlled after the leg session.',
      documentJson: {
        message: 'Keep tomorrow controlled after the leg session.',
        recommendations: ['Stay aerobic if the legs still feel heavy.'],
      },
      sourceJob: 'scheduler',
      status: 'unread',
      readAt: null,
      createdAt: new Date().toISOString(),
    });

    const response = await buildAITemporarilyBusyResponse('triathlon', 41, 410);

    expect(response.domain).toBe('triathlon');
    expect(response.text).toContain('latest coach briefing');
    expect(response.text).toContain('Tempo ride (planned)');
    expect(response.text).toContain('68/100');
    expect(mockGetLatestByType).toHaveBeenCalledWith(41, 'coach_briefing', 410);
  });

  it('builds daily context on demand when the cache is empty', async () => {
    mockGetUserLanguage.mockReturnValue('pt-BR');
    mockBuildDailyContext.mockResolvedValue(
      'TRAINING: Rodagem leve\nREADINESS: 74/100 (green) — Mantém o plano normal',
    );

    const response = await buildAITemporarilyBusyResponse('triathlon', 41);

    expect(mockBuildDailyContext).toHaveBeenCalledWith(41);
    expect(response.text).toContain('contexto salvo de treino');
    expect(response.text).toContain('Rodagem leve');
    expect(response.text).toContain('74/100');
  });

  it('uses saved daily brief coordination for secretary overloads', async () => {
    mockComposeDailyBrief.mockResolvedValue({
      coordination: {
        topPriority: 'Protect the filming block before admin work.',
        executionOrder: ['Reserve filming block', 'Clear overdue admin task'],
        watchouts: ['Inbox pressure is rising'],
        handoffs: [],
      },
      day: { secretary: { priorityNote: null, tradeoffNote: null } },
    });
    mockGetUnreadMailSummaryForUser.mockResolvedValue({ totalUnread: 9, outlookUnread: 4, gmailUnread: 5 });

    const response = await buildAITemporarilyBusyResponse('secretary', 41, 410);

    expect(response.text).toContain('Top priority');
    expect(response.text).toContain('Reserve filming block');
    expect(response.text).toContain('Inbox pressure');
    expect(mockComposeDailyBrief).toHaveBeenCalledWith(expect.objectContaining({
      userId: 41,
      tenantId: 410,
    }));
  });

  it('uses monthly finance summary for finance overloads', async () => {
    mockGetMonthlySummary.mockReturnValue({
      month: '2026-04',
      totalIncome: 2400,
      totalExpenses: 187,
      totalDeductions: 0,
      netIncome: 2213,
      transactionCount: 3,
    });

    const response = await buildAITemporarilyBusyResponse('finance', 41);

    expect(response.text).toContain('3 finance entries');
    expect(response.text).toContain('income EUR 2400.00');
    expect(response.text).toContain('expenses EUR 187.00');
  });

  it('uses content desk items and pillars for content overloads', async () => {
    mockGetContentDeskItems.mockReturnValue([
      { id: 1, type: 'script_ready', title: 'Vibe coding launch script', body: '', createdAt: '2026-04-18T10:00:00.000Z' },
    ]);
    mockGetActiveContentPillars.mockReturnValue([
      { name: 'Product', keywordCount: 8 },
      { name: 'Founder journey', keywordCount: 6 },
    ]);

    const response = await buildAITemporarilyBusyResponse('content', 41);

    expect(response.text).toContain('Content desk items ready');
    expect(response.text).toContain('Vibe coding launch script');
    expect(response.text).toContain('Product');
  });

  it('fails closed on invalid tenant scope for training busy fallback', async () => {
    const response = await buildAITemporarilyBusyResponse('triathlon', 0);

    expect(mockGetUserLanguage).not.toHaveBeenCalled();
    expect(mockGetLatestByType).not.toHaveBeenCalled();
    expect(mockBuildDailyContext).not.toHaveBeenCalled();
    expect(response.text).toContain('temporariamente ocupado');
    expect(response.text).not.toContain('contexto salvo de treino');
    expect(getTenantScopeAnomalies()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          layer: 'delivery',
          operation: 'build_ai_temporarily_busy_response',
          reason: 'invalid_user_scope',
          userId: 0,
          details: { domain: 'triathlon' },
        }),
      ]),
    );
  });
});
