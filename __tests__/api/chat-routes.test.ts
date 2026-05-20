import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { Request, Response } from 'express';
import { Settings } from 'luxon';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

const calendarMocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
  getEventsForSources: vi.fn(),
  isGoogleCalendarConfigured: vi.fn(() => false),
  isOutlookCalendarConfigured: vi.fn(() => false),
}));

const mockRouteMessage = vi.fn();
const mockKeywordMatch = vi.fn(() => null);
const mockTryDeterministicChatCommand = vi.fn();
const mockClassifyAndExtractImage = vi.fn();
const mockGetUserLanguage = vi.fn(() => 'en');
const mockSetUserLanguage = vi.fn();
const mockGetPreferredDisplayName = vi.fn(() => 'Jaqueline');
const mockCheckTierAccess = vi.fn(() => ({
  allowed: true,
  userTier: 'pro',
  requiredTier: 'free',
}));
const mockIsUserOverDailyCap = vi.fn(() => ({
  over: false,
  spentUsd: 0,
  capUsd: 1,
  plan: 'pro',
  resetAt: '2026-04-15T00:00:00.000Z',
  limitUsd: 1,
  usedUsd: 0,
  remainingUsd: 1,
  planDailyLimitUsd: 1,
  includedRemainingUsd: 1,
  nexusPointsBalance: 0,
  nexusPointsRemainingUsd: 0,
  pointsPurchaseAvailable: true,
}));
const mockGetLastAssistantMessage = vi.fn(() => null);
const mockAddToConversation = vi.fn();
const mockSyncLastAssistantConversationMessage = vi.fn();
const mockClearAllConversations = vi.fn();
const mockCompleteOneShotWithFallback = vi.fn();
const mockCompleteOneShotWithSearch = vi.fn();
const mockBuildSimpleStateContext = vi.fn(async () => 'Scoped Nexus state for research prompt');
const mockHandleSecretary = vi.fn(async () => ({ text: 'Scheduled.', domain: 'secretary' as const }));
const mockGetScript = vi.fn();
const mockGetActiveContentPillars = vi.fn(() => []);
const mockGetContentDeskItems = vi.fn(() => []);
const mockGetNextContentExecutionHint = vi.fn(async () => null);
const mockGetRankedContentSignals = vi.fn(() => []);
const mockLocalizeFilmingRecommendation = vi.fn((value) => value);
const mockGetFilmingRecommendation = vi.fn(async () => null);
const mockGetUpcomingTopicCount = vi.fn(() => 0);
const mockGetTopics = vi.fn(() => []);
const mockGetPerformanceSummary = vi.fn(() => ({
  count: 0,
  avgViews: 0,
  avgRetention: 0,
  totalLikes: 0,
  totalComments: 0,
  totalSubsGained: 0,
  entries: [],
}));
const mockGetLearnedPatterns = vi.fn(() => []);
const mockGetAllInvoiceVendors = vi.fn(() => []);
const mockGetFilingsForMonth = vi.fn(() => []);
const mockGetSubscriptionStatus = vi.fn(() => ({
  plan: 'free',
  period: 'monthly',
  status: 'inactive',
  provider: 'none',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  isActive: false,
  isPro: false,
}));
const mockGetMonthlySummary = vi.fn(() => ({
  month: '2026-04',
  totalIncome: 0,
  totalExpenses: 0,
  totalDeductions: 0,
  netIncome: 0,
  transactionCount: 0,
}));
const mockGetMonthlyBudgetView = vi.fn(() => ({
  month: '2026-04',
  basisCurrency: 'EUR',
  currencies: ['EUR'],
  integrity: 'reliable',
  affordability: 'unknown',
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
}));
const mockGetTaxEvents = vi.fn(() => []);
const mockCalculateMonthlyTax = vi.fn(() => ({
  grossIncome: 0,
  deductions: 0,
  inssDue: 0,
  taxableIncome: 0,
  taxDue: 0,
  effectiveRate: 0,
  bracket: 'Isento',
}));
const mockGetFiscalCollectionSummary = vi.fn(() => ({
  profile: {
    user_id: 7001,
    destination_email: 'accountant@example.com',
    cadence: 'monthly',
    primary_day: 5,
    secondary_day: null,
    enabled: true,
    last_bundle_sent_at: null,
    last_bundle_document_count: 0,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
  },
  destinationEmail: 'accountant@example.com',
  nextRunAt: '2026-05-05T08:10:00.000Z',
  providers: [
    { provider: 'gmail', connected: true },
    { provider: 'outlook', connected: false },
  ],
  ruleCount: 5,
  customRuleCount: 2,
  deliveryAvailable: true,
  warnings: [],
}));
const mockGetCallback = vi.fn(() => null);
const mockGetCallbackForScope = vi.fn(() => null);
const mockConsumeCallbackForScope = vi.fn(() => true);
const mockStoreCallback = vi.fn(() => 'cb-ref');
const mockStoreCallbackForScope = vi.fn(() => 'cb-ref');
const mockGetLastCoachState = vi.fn(() => null);
const mockApplyCoachRecommendations = vi.fn(async () => ({
  count: 0,
  appliedRecommendations: [],
}));
const mockClearChatHistory = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/chat-history-store', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/chat-history-store')>(
    '../../src/services/chat-history-store',
  );

  return {
    ...actual,
    clearChatHistory: (...args: Parameters<typeof actual.clearChatHistory>) => {
      const override = mockClearChatHistory.getMockImplementation();
      if (override) return override(...args);
      return actual.clearChatHistory(...args);
    },
  };
});

vi.mock('../../src/router', () => ({
  routeMessage: (...args: unknown[]) => mockRouteMessage(...args),
  keywordMatch: (...args: unknown[]) => mockKeywordMatch(...args),
  isSystemCommand: vi.fn(() => null),
}));

vi.mock('../../src/api/routes/chat-fastpath', () => ({
  tryDeterministicChatCommand: (...args: unknown[]) => mockTryDeterministicChatCommand(...args),
  getPendingTasksCacheKey: (userId?: number, tenantId?: number) =>
    `u:${userId ?? 'unknown'}:t:${tenantId ?? userId ?? 'unknown'}:fastpath:pending-tasks`,
}));

vi.mock('../../src/services/anthropic', () => ({
  classifyAndExtractImage: (...args: unknown[]) => mockClassifyAndExtractImage(...args),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: vi.fn(() => null),
  setCache: vi.fn(),
  clearCacheByPrefix: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
  getUserLanguageById: (...args: unknown[]) => mockGetUserLanguage(...args),
  setUserLanguage: (...args: unknown[]) => mockSetUserLanguage(...args),
  getPreferredDisplayName: (...args: unknown[]) => mockGetPreferredDisplayName(...args),
  getPreferredDisplayNameById: (...args: unknown[]) => mockGetPreferredDisplayName(...args),
  getUserTimezone: () => 'Europe/Lisbon',
  getUserTimezoneById: () => 'Europe/Lisbon',
  getUserById: (userId: number) => ({ id: userId, tier: 'pro' }),
  getUserByTelegramId: (userId: number) => ({ id: userId, tier: 'pro' }),
}));

vi.mock('../../src/services/secretary-fastpath', () => ({
  tryFastpath: vi.fn(async () => ({ matched: false })),
  normalizeLangHeader: (value: string) => {
    const normalized = value.toLowerCase();
    if (normalized.startsWith('pt-pt') || normalized.startsWith('pt_pt')) return 'pt-PT';
    if (normalized.startsWith('pt')) return 'pt-BR';
    return 'en-US';
  },
}));

vi.mock('../../src/services/skill-tiers', () => ({
  checkTierAccess: (...args: unknown[]) => mockCheckTierAccess(...args),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  isUserOverDailyCap: (...args: unknown[]) => mockIsUserOverDailyCap(...args),
  buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
  enforceCostGuardrails: (userId: number) => {
    const quota = mockIsUserOverDailyCap(userId);
    const global = { totalUsd: 0, limitUsd: 100, exceeded: false };
    if (!quota.over) return { block: false, status: 200, reason: 'ok', quota, global };
    return {
      block: true,
      status: 429,
      reason: 'daily_limit_exceeded',
      message: `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`,
      quota,
      global,
      details: {
        plan: quota.plan,
        resetAt: quota.resetAt,
        limitUsd: quota.limitUsd,
        usedUsd: quota.usedUsd,
        remainingUsd: quota.remainingUsd,
        planDailyLimitUsd: quota.planDailyLimitUsd,
        includedRemainingUsd: quota.includedRemainingUsd,
        nexusPointsBalance: quota.nexusPointsBalance,
        nexusPointsRemainingUsd: quota.nexusPointsRemainingUsd,
        pointsPurchaseAvailable: quota.pointsPurchaseAvailable,
      },
    };
  },
  // M-2 (2026-04-21 pass 2): route handlers wrap their check+AI+spend
  // in acquireCostLock to serialize concurrent same-user requests.
  // Tests don't exercise concurrency, so stub with a no-op release.
  acquireCostLock: vi.fn(async () => () => { /* no-op */ }),
}));

vi.mock('../../src/state/conversation', () => ({
  getLastAssistantMessage: (...args: unknown[]) => mockGetLastAssistantMessage(...args),
  addToConversation: (...args: unknown[]) => mockAddToConversation(...args),
  syncLastAssistantConversationMessage: (...args: unknown[]) => mockSyncLastAssistantConversationMessage(...args),
  clearAllConversations: (...args: unknown[]) => mockClearAllConversations(...args),
}));

vi.mock('../../src/domains/secretary', () => ({
  handleSecretary: (...args: unknown[]) => mockHandleSecretary(...args),
}));

vi.mock('../../src/domains/triathlon', () => ({
  handleTriathlon: vi.fn(async () => ({ text: 'Training.', domain: 'triathlon' as const })),
}));

vi.mock('../../src/domains/content-creator', () => ({
  handleContent: vi.fn(async () => ({ text: 'Content.', domain: 'content' as const })),
}));

vi.mock('../../src/domains/finance', () => ({
  handleFinance: vi.fn(async () => ({ text: 'Finance.', domain: 'finance' as const })),
}));

vi.mock('../../src/domains/cooking', () => ({
  handleCooking: vi.fn(async () => ({ text: 'Cooking.', domain: 'cooking' as const })),
}));

vi.mock('../../src/services/content-engine', () => ({
  getScript: (...args: unknown[]) => mockGetScript(...args),
}));

vi.mock('../../src/services/content-intelligence', () => ({
  getActiveContentPillars: (...args: unknown[]) => mockGetActiveContentPillars(...args),
  getContentDeskItems: (...args: unknown[]) => mockGetContentDeskItems(...args),
  getNextContentExecutionHint: (...args: unknown[]) => mockGetNextContentExecutionHint(...args),
  getRankedContentSignals: (...args: unknown[]) => mockGetRankedContentSignals(...args),
  localizeFilmingRecommendation: (...args: unknown[]) => mockLocalizeFilmingRecommendation(...args),
}));

vi.mock('../../src/services/content-scheduler', () => ({
  getFilmingRecommendation: (...args: unknown[]) => mockGetFilmingRecommendation(...args),
  getUpcomingTopicCount: (...args: unknown[]) => mockGetUpcomingTopicCount(...args),
  getTopics: (...args: unknown[]) => mockGetTopics(...args),
}));

vi.mock('../../src/services/content-learning-store', () => ({
  getPerformanceSummary: (...args: unknown[]) => mockGetPerformanceSummary(...args),
  getLearnedPatterns: (...args: unknown[]) => mockGetLearnedPatterns(...args),
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
  getMonthlySummary: (...args: unknown[]) => mockGetMonthlySummary(...args),
  getMonthlyBudgetView: (...args: unknown[]) => mockGetMonthlyBudgetView(...args),
  getTaxEvents: (...args: unknown[]) => mockGetTaxEvents(...args),
  calculatePortugueseMonthlyTax: (...args: unknown[]) => mockCalculateMonthlyTax(...args),
  calculateMonthlyTax: vi.fn(() => { throw new Error("Brazilian tax engine removed; see finance-tax-pt"); }),
  formatCurrencyAmount: (currency: string, amount: number) => `${currency} ${amount.toFixed(2)}`,
}));

vi.mock('../../src/services/fiscal-bundle', () => ({
  getFiscalCollectionSummary: (...args: unknown[]) => mockGetFiscalCollectionSummary(...args),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: (...args: unknown[]) => mockCompleteOneShotWithFallback(...args),
  completeOneShotWithSearch: (...args: unknown[]) => mockCompleteOneShotWithSearch(...args),
}));

vi.mock('../../src/domains/domain-handler', () => ({
  getLastCoachState: (...args: unknown[]) => mockGetLastCoachState(...args),
  buildSimpleStateContext: (...args: unknown[]) => mockBuildSimpleStateContext(...args),
}));

vi.mock('../../src/services/garmin-coach', () => ({
  applyCoachRecommendations: (...args: unknown[]) => mockApplyCoachRecommendations(...args),
}));

vi.mock('../../src/services/google-calendar', async () => {
  const actual = await vi.importActual<any>('../../src/services/google-calendar');
  return {
    ...actual,
    isGoogleCalendarConfigured: (...args: unknown[]) => calendarMocks.isGoogleCalendarConfigured(...args),
  };
});

vi.mock('../../src/services/outlook-calendar', async () => {
  const actual = await vi.importActual<any>('../../src/services/outlook-calendar');
  return {
    ...actual,
    isOutlookCalendarConfigured: (...args: unknown[]) => calendarMocks.isOutlookCalendarConfigured(...args),
  };
});

vi.mock('../../src/services/unified-calendar', async () => {
  const actual = await vi.importActual<any>('../../src/services/unified-calendar');
  return {
    ...actual,
    createEvent: (...args: unknown[]) => calendarMocks.createEvent(...args),
    getEventsForSources: (...args: unknown[]) => calendarMocks.getEventsForSources(...args),
  };
});

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

vi.mock('../../src/utils/callback-store', () => ({
  getCallback: (...args: unknown[]) => mockGetCallback(...args),
  getCallbackForScope: (...args: unknown[]) => mockGetCallbackForScope(...args),
  consumeCallbackForScope: (...args: unknown[]) => mockConsumeCallbackForScope(...args),
  storeCallback: (...args: unknown[]) => mockStoreCallback(...args),
  storeCallbackForScope: (...args: unknown[]) => mockStoreCallbackForScope(...args),
}));

import { chatRoutes } from '../../src/api/routes/chat';
import { authMiddleware } from '../../src/api/auth-middleware';
import { upsertPendingChatAction } from '../../src/services/chat-action-state';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on runtime-only services; the chat/history
        // tests only need the schema that can apply cleanly in isolation.
      }
    }
  }
}

interface MockRes {
  statusCode: number;
  body: any;
  headers: Record<string, string>;
  status(code: number): MockRes;
  setHeader(name: string, value: string): MockRes;
  getHeader(name: string): string | undefined;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    setHeader(name: string, value: string) {
      r.headers[name.toLowerCase()] = value;
      return r;
    },
    getHeader(name: string) {
      return r.headers[name.toLowerCase()];
    },
    json(body: any) { r.body = body; return r; },
  };
  return r;
}

function mockReq(userId: number, body?: any, headers: Record<string, string> = {}, tenantId = userId): Request {
  return {
    userId,
    tenantId,
    body,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
  } as any;
}

async function dispatch(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  userId: number,
  body?: any,
  headers: Record<string, string> = {},
  tenantId = userId,
): Promise<MockRes> {
  const router = chatRoutes();
  const req = mockReq(userId, body, headers, tenantId);
  (req as any).method = method;
  (req as any).url = url;
  (req as any).originalUrl = url;
  (req as any).baseUrl = '';
  (req as any).path = url.split('?')[0];
  (req as any).query = {};
  (req as any).params = {};

  const queryString = url.split('?')[1];
  if (queryString) {
    for (const [key, value] of new URLSearchParams(queryString).entries()) {
      (req as any).query[key] = value;
    }
  }

  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

async function requestApp(
  app: express.Express,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ statusCode: number; body: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to start test server'));
        return;
      }

      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: url,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
            ...headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            server.close();
            resolve({
              statusCode: res.statusCode ?? 0,
              body: data ? JSON.parse(data) : null,
              headers: res.headers,
            });
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('Chat API routes', () => {
  beforeEach(() => {
    Settings.now = () => new Date('2026-04-15T12:00:00.000Z').valueOf();

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();

    mockRouteMessage.mockReset();
    mockKeywordMatch.mockReset();
    mockTryDeterministicChatCommand.mockReset();
    mockClassifyAndExtractImage.mockReset();
    mockGetUserLanguage.mockReset();
    mockSetUserLanguage.mockReset();
    mockGetPreferredDisplayName.mockReset();
    mockCheckTierAccess.mockReset();
    mockIsUserOverDailyCap.mockReset();
    mockGetLastAssistantMessage.mockReset();
    mockAddToConversation.mockReset();
    mockSyncLastAssistantConversationMessage.mockReset();
    mockClearAllConversations.mockReset();
    mockCompleteOneShotWithFallback.mockReset();
    mockCompleteOneShotWithSearch.mockReset();
    mockBuildSimpleStateContext.mockReset();
    mockHandleSecretary.mockReset();
    mockGetScript.mockReset();
    mockGetActiveContentPillars.mockReset();
    mockGetContentDeskItems.mockReset();
    mockGetNextContentExecutionHint.mockReset();
    mockGetRankedContentSignals.mockReset();
    mockLocalizeFilmingRecommendation.mockReset();
    mockGetFilmingRecommendation.mockReset();
    mockGetUpcomingTopicCount.mockReset();
    mockGetTopics.mockReset();
    mockGetPerformanceSummary.mockReset();
    mockGetLearnedPatterns.mockReset();
    mockGetAllInvoiceVendors.mockReset();
    mockGetFilingsForMonth.mockReset();
    mockGetSubscriptionStatus.mockReset();
    mockGetMonthlySummary.mockReset();
    mockGetMonthlyBudgetView.mockReset();
    mockGetTaxEvents.mockReset();
    mockCalculateMonthlyTax.mockReset();
    mockGetFiscalCollectionSummary.mockReset();
    mockGetCallback.mockReset();
    mockGetCallbackForScope.mockReset();
    mockConsumeCallbackForScope.mockReset();
    mockStoreCallback.mockReset();
    mockStoreCallbackForScope.mockReset();
    mockGetLastCoachState.mockReset();
    mockApplyCoachRecommendations.mockReset();
    mockClearChatHistory.mockReset();
    calendarMocks.createEvent.mockReset();
    calendarMocks.getEventsForSources.mockReset();
    calendarMocks.isGoogleCalendarConfigured.mockReset();
    calendarMocks.isOutlookCalendarConfigured.mockReset();
    calendarMocks.isGoogleCalendarConfigured.mockReturnValue(false);
    calendarMocks.isOutlookCalendarConfigured.mockReturnValue(false);

    mockTryDeterministicChatCommand.mockResolvedValue(null);
    mockKeywordMatch.mockReturnValue(null);
    mockGetUserLanguage.mockReturnValue('en');
    mockGetPreferredDisplayName.mockReturnValue('Jaqueline');
    mockCheckTierAccess.mockReturnValue({
      allowed: true,
      userTier: 'pro',
      requiredTier: 'free',
    });
    mockIsUserOverDailyCap.mockReturnValue({
      over: false,
      spentUsd: 0,
      capUsd: 1,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
      limitUsd: 1,
      usedUsd: 0,
      remainingUsd: 1,
      planDailyLimitUsd: 1,
      includedRemainingUsd: 1,
      nexusPointsBalance: 0,
      nexusPointsRemainingUsd: 0,
      pointsPurchaseAvailable: true,
    });
    mockGetLastAssistantMessage.mockReturnValue(null);
    mockHandleSecretary.mockResolvedValue({ text: 'Scheduled.', domain: 'secretary' });
    mockGetScript.mockResolvedValue({
      topic: 'Recovery after intervals',
      script: 'Open strong. Explain why recovery matters after hard intervals.',
      hook: 'Most athletes sabotage the adaptation window after intervals.',
      title_options: ['Recovery after intervals', 'Why your intervals stop working', 'The recovery mistake'],
      sources_used: [],
      estimated_duration: '0:45-0:55',
      duration_ms: 3200,
      hashtags: ['#running'],
      caption: 'Caption',
      cta: 'Save this for your next hard session.',
      degraded: false,
      warnings: [],
    });
    mockCompleteOneShotWithFallback.mockResolvedValue({
      text: 'Tighter revised draft.',
      provider: 'gemini',
    });
    mockCompleteOneShotWithSearch.mockResolvedValue({
      text: 'Use current sources and avoid private-state claims.',
      sources: ['https://example.com/source'],
    });
    mockBuildSimpleStateContext.mockResolvedValue('Scoped Nexus state for research prompt');
    mockGetActiveContentPillars.mockReturnValue([]);
    mockGetContentDeskItems.mockReturnValue([]);
    mockGetNextContentExecutionHint.mockResolvedValue(null);
    mockGetRankedContentSignals.mockReturnValue([]);
    mockLocalizeFilmingRecommendation.mockImplementation((value) => value);
    mockGetFilmingRecommendation.mockResolvedValue(null);
    mockGetUpcomingTopicCount.mockReturnValue(0);
    mockGetTopics.mockReturnValue([]);
    mockGetPerformanceSummary.mockReturnValue({
      count: 0,
      avgViews: 0,
      avgRetention: 0,
      totalLikes: 0,
      totalComments: 0,
      totalSubsGained: 0,
      entries: [],
    });
    mockGetLearnedPatterns.mockReturnValue([]);
    mockGetAllInvoiceVendors.mockReturnValue([]);
    mockGetFilingsForMonth.mockReturnValue([]);
    mockGetSubscriptionStatus.mockReturnValue({
      plan: 'free',
      period: 'monthly',
      status: 'inactive',
      provider: 'none',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      isActive: false,
      isPro: false,
    });
    mockGetMonthlySummary.mockReturnValue({
      month: '2026-04',
      totalIncome: 0,
      totalExpenses: 0,
      totalDeductions: 0,
      netIncome: 0,
      transactionCount: 0,
    });
    mockGetMonthlyBudgetView.mockReturnValue({
      month: '2026-04',
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'reliable',
      affordability: 'unknown',
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
    mockCalculateMonthlyTax.mockReturnValue({
      grossIncome: 0,
      deductions: 0,
      inssDue: 0,
      taxableIncome: 0,
      taxDue: 0,
      effectiveRate: 0,
      bracket: 'Isento',
    });
    mockGetFiscalCollectionSummary.mockReturnValue({
      profile: {
        user_id: 7001,
        destination_email: 'accountant@example.com',
        cadence: 'monthly',
        primary_day: 5,
        secondary_day: null,
        enabled: true,
        last_bundle_sent_at: null,
        last_bundle_document_count: 0,
        created_at: '2026-04-01T00:00:00.000Z',
        updated_at: '2026-04-01T00:00:00.000Z',
      },
      destinationEmail: 'accountant@example.com',
      nextRunAt: '2026-05-05T08:10:00.000Z',
      providers: [
        { provider: 'gmail', connected: true },
        { provider: 'outlook', connected: false },
      ],
      ruleCount: 5,
      customRuleCount: 2,
      deliveryAvailable: true,
      warnings: [],
    });
    mockGetCallback.mockReturnValue(null);
    mockGetCallbackForScope.mockReturnValue(null);
    mockConsumeCallbackForScope.mockReturnValue(true);
    mockStoreCallback.mockReturnValue('cb-ref');
    mockStoreCallbackForScope.mockReturnValue('cb-ref');
    mockGetLastCoachState.mockReturnValue(null);
    mockApplyCoachRecommendations.mockResolvedValue({
      count: 0,
      appliedRecommendations: [],
    });

    testDb.prepare(`
      INSERT INTO users (
        id,
        telegram_id,
        first_name,
        language,
        timezone,
        tier,
        status,
        auth_provider,
        daily_message_limit,
        daily_token_limit,
        daily_cost_limit_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      7001,
      7001,
      'Test',
      'en',
      'Europe/Lisbon',
      'pro',
      'active',
      'telegram',
      40,
      100000,
      1,
    );
    testDb.prepare(`
      INSERT INTO users (
        id,
        telegram_id,
        first_name,
        language,
        timezone,
        tier,
        status,
        auth_provider,
        daily_message_limit,
        daily_token_limit,
        daily_cost_limit_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      7002,
      7002,
      'Test',
      'en',
      'Europe/Lisbon',
      'pro',
      'active',
      'telegram',
      40,
      100000,
      1,
    );
    testDb.prepare(`
      INSERT INTO users (
        id,
        telegram_id,
        first_name,
        language,
        timezone,
        tier,
        status,
        auth_provider,
        daily_message_limit,
        daily_token_limit,
        daily_cost_limit_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      7003,
      7003,
      'Test',
      'en',
      'Europe/Lisbon',
      'pro',
      'active',
      'telegram',
      40,
      100000,
      1,
    );
  });

  afterEach(() => {
    Settings.now = Date.now;
    testDb?.close();
  });

  it('persists text chat exchanges and returns them through history', async () => {
    // Phase 1 batch 4 (2026-05-15): bare "schedule a meeting" used to fall
    // through to the classifier (now mocked), which produced the
    // unverified-success-claim quality-gate copy. The calendar parser was
    // extended (audit §11 routing fixes) to recognise "meeting" as a calendar
    // noun and the registry-subset fallback now emits a low-confidence
    // schedule_event step → HTTP 202 needs_clarification. The persistence
    // contract is independent of the routing tier; assert it against the
    // clarification response instead.
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'classifier',
      confidence: 0.93,
      strippedMessage: 'schedule a meeting',
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'schedule a meeting',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
    expect(messageRes.body.metadata).toMatchObject({
      type: 'chat_action_needs_input',
      actionStatus: 'needs_clarification',
    });
    expect(messageRes.body.routeMethod).toBe('chat-action-deterministic');
    expect(messageRes.body.metadata.involvedSkills).toContain('secretary_calendar');

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.statusCode).toBe(200);
    expect(historyRes.body.messages).toHaveLength(2);
    expect(historyRes.body.messages[0]).toMatchObject({
      role: 'user',
      text: 'schedule a meeting',
    });
    expect(historyRes.body.messages[1]).toMatchObject({
      role: 'assistant',
      domain: 'secretary',
      routeMethod: 'chat-action-deterministic',
    });
  });

  it('runs the action planner before Gmail unread or generic chat for Gmail-agenda event creation', async () => {
    mockGetUserLanguage.mockReturnValue('pt-PT');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo',
      clientMessageId: 'pt-gmail-agenda-event-1',
    }, {
      'x-language': 'pt-PT',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('secretary');
    expect(messageRes.body.routeMethod).toBe('chat-action-deterministic');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'chat_action_blocked',
      actionStatus: 'blocked',
      involvedSkills: ['secretary_calendar'],
    });
    expect(messageRes.body.text).toContain('Google Calendar');
    expect(messageRes.body.text).not.toMatch(/927|e-mails não lidos|unread|auth\.scope|chat\.skill_capability_registry|<b>|<\/b>|Resposta estruturada/i);
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithFallback).not.toHaveBeenCalled();
  });

  it('durably tracks action-planner confirmations for external side effects', async () => {
    mockGetUserLanguage.mockReturnValue('pt-PT');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Cria um evento no Google Calendar chamado reunião das 9 às 10 amanhã e convida ana@example.com',
      clientMessageId: 'calendar-attendee-confirmation-1',
    }, {
      'x-language': 'pt-PT',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
    expect(messageRes.body.routeMethod).toBe('chat-action-deterministic');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'chat_action_needs_confirmation',
      actionStatus: 'needs_confirmation',
      pendingConfirmation: {
        sourceMessageId: 'msg-user-calendar-attendee-confirmation-1',
        decisionId: expect.any(String),
      },
    });
    expect(JSON.stringify(messageRes.body)).not.toMatch(/auth\.scope|chat\.skill_capability_registry|raw|debug|<b>|<\/b>/i);
    expect(mockRouteMessage).not.toHaveBeenCalled();
  });

  it('executes a confirmed action-planner calendar invite from the durable pending run', async () => {
    mockGetUserLanguage.mockReturnValue('pt-PT');
    calendarMocks.isGoogleCalendarConfigured.mockReturnValue(true);
    const createdEvent = {
      id: 'google-event-confirmed-1',
      summary: 'reunião',
      start: '2026-05-15T09:00:00+01:00',
      end: '2026-05-15T10:00:00+01:00',
      source: 'google',
    };
    calendarMocks.getEventsForSources
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createdEvent]);
    calendarMocks.createEvent.mockResolvedValue(createdEvent);

    const first = await dispatch('POST', '/message', 7001, {
      text: 'Cria um evento no Google Calendar chamado reunião das 9 às 10 amanhã e convida ana@example.com',
      clientMessageId: 'calendar-attendee-confirmation-exec-1',
    }, {
      'x-language': 'pt-PT',
    });

    expect(first.statusCode, JSON.stringify(first.body)).toBe(202);
    expect(first.body.metadata.type).toBe('chat_action_needs_confirmation');

    const accept = await dispatch('POST', '/message', 7001, {
      text: 'confirmar esta decisão',
      idempotencyKey: 'calendar-attendee-confirmation-exec-accept',
    }, {
      'x-language': 'pt-PT',
    });

    expect(accept.statusCode, JSON.stringify(accept.body)).toBe(200);
    expect(accept.body.routeMethod).toBe('chat-action-mixed');
    expect(accept.body.metadata).toMatchObject({
      type: 'chat_action_verified_success',
      actionStatus: 'verified_success',
      verificationStatus: 'verified_success',
      confirmationDecision: {
        actionId: 'option_a',
      },
    });
    expect(accept.body.text).toContain('Feito — criei');
    expect(calendarMocks.createEvent).toHaveBeenCalledTimes(1);
    expect(calendarMocks.createEvent.mock.calls[0][0]).toMatchObject({
      title: 'reunião',
      attendees: ['ana@example.com'],
    });
    expect(calendarMocks.getEventsForSources).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(accept.body)).not.toMatch(/auth\.scope|chat\.skill_capability_registry|raw|debug|<b>|<\/b>|Resposta estruturada/i);
  });

  it('routes task-with-subtasks messages through Chat Reasoning Engine before the AI/tool loop', async () => {
    const messageRes = await dispatch('POST', '/message', 7001, {
      text: "Create a task called Prozis where it has sub tasks called creatine K2 D3 for now that's it",
      clientMessageId: 'prozis-subtasks-1',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body).toMatchObject({
      domain: 'secretary',
      routeMethod: 'chat-reasoning-engine',
      metadata: {
        type: 'task_created',
        title: 'Prozis',
        verificationStatus: 'verified',
        subtasks: [
          { title: 'creatine' },
          { title: 'K2' },
          { title: 'D3' },
        ],
      },
    });
    expect(messageRes.body.text).toContain('Created task “Prozis” with 3 subtasks');
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockHandleSecretary).not.toHaveBeenCalled();

    const task = testDb.prepare('SELECT id, title, user_id FROM native_tasks WHERE user_id = ? AND title = ?')
      .get(7001, 'Prozis') as any;
    expect(task).toMatchObject({ title: 'Prozis', user_id: 7001 });
    const subtasks = testDb.prepare(`
      SELECT display_name
      FROM native_task_checklist_items
      WHERE user_id = ? AND task_id = ?
      ORDER BY position ASC, id ASC
    `).all(7001, task.id).map((row: any) => row.display_name);
    expect(subtasks).toEqual(['creatine', 'K2', 'D3']);
    const plan = testDb.prepare(`
      SELECT status, frame_json, created_entity_refs_json
      FROM chat_action_plans
      WHERE user_id = ? AND tenant_id = ? AND source_message_id = ?
    `).get(7001, 7001, 'msg-user-prozis-subtasks-1') as any;
    expect(plan).toMatchObject({ status: 'completed' });
    expect(JSON.parse(plan.frame_json)).toMatchObject({
      primaryIntent: 'create_task_with_subtasks',
      skill: 'secretary',
    });
    expect(JSON.parse(plan.created_entity_refs_json)).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'task', title: 'Prozis' }),
      expect.objectContaining({ entityType: 'subtask', title: 'creatine' }),
      expect.objectContaining({ entityType: 'subtask', title: 'K2' }),
      expect.objectContaining({ entityType: 'subtask', title: 'D3' }),
    ]));
  });

  it('does not duplicate task/subtask execution when iOS retries the same client message id', async () => {
    const body = {
      text: 'Create task Prozis with subtasks creatine K2 D3',
      clientMessageId: 'prozis-subtasks-retry',
    };

    const first = await dispatch('POST', '/message', 7001, body);
    const second = await dispatch('POST', '/message', 7001, body);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body.metadata).toMatchObject({ idempotentReplay: true });

    const taskCount = (testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ? AND title = ?')
      .get(7001, 'Prozis') as any).count;
    const checklistCount = (testDb.prepare(`
      SELECT COUNT(*) AS count
      FROM native_task_checklist_items ci
      JOIN native_tasks t ON t.id = ci.task_id
      WHERE t.user_id = ? AND t.title = ?
    `).get(7001, 'Prozis') as any).count;
    expect(taskCount).toBe(1);
    expect(checklistCount).toBe(3);
  });

  it('rejects chat access when the authenticated tenant scope does not match the canonical user tenant', async () => {
    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'schedule a meeting',
    }, {}, 7002);

    expect(messageRes.statusCode).toBe(403);
    expect(messageRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Invalid tenant scope',
      },
    });
    expect(mockRouteMessage).not.toHaveBeenCalled();

    const anomalies = getTenantScopeAnomalies(1);
    expect(anomalies[0]).toMatchObject({
      operation: 'chat_route_message',
      reason: 'tenant_mismatch',
      userId: 7001,
    });
  });

  it('answers who-am-I questions from authenticated scope before classifier or model routing', async () => {
    mockGetUserLanguage.mockReturnValue('pt-PT');
    mockGetPreferredDisplayName.mockReturnValue('Jaqueline');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Quem sou eu?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body).toMatchObject({
      domain: 'secretary',
      routeMethod: 'authenticated-identity',
      confidence: 1,
      metadata: {
        type: 'authenticated_identity',
        userId: 7001,
        hasDisplayName: true,
        chatReasoning: {
          version: 'nexus_answer_contract.v1',
          ownerSkill: 'secretary',
          routeMethod: 'authenticated-identity',
          verificationStatus: 'not_required',
        },
      },
    });
    expect(messageRes.body.text).toContain('Jaqueline');
    expect(messageRes.body.text).not.toContain('Felipe');
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockHandleSecretary).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithFallback).not.toHaveBeenCalled();
  });

  it('returns the existing assistant response on idempotent retry without invoking the skill twice', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'plan my day',
    });
    mockHandleSecretary.mockResolvedValue({ text: 'Here is your plan.', domain: 'secretary' });

    const first = await dispatch('POST', '/message', 7001, {
      text: 'plan my day',
      clientMessageId: 'ios-client-1',
    });
    const second = await dispatch('POST', '/message', 7001, {
      text: 'plan my day',
      clientMessageId: 'ios-client-1',
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toMatchObject({
      text: 'Here is your plan.',
      metadata: {
        idempotentReplay: true,
        replayOfUserMessageId: 'msg-user-ios-client-1',
      },
    });
    expect(mockHandleSecretary).toHaveBeenCalledTimes(1);
    expect(mockRouteMessage).toHaveBeenCalledTimes(1);

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.body.messages.filter((message: any) => message.id === 'msg-user-ios-client-1')).toHaveLength(1);
  });

  it('does not execute a second skill call when an idempotent retry arrives before completion', async () => {
    testDb.prepare(`
      INSERT INTO messages (
        tenant_id, user_id, visibility_scope, scope_status, created_by,
        message_uuid, role, text, lifecycle_state, client_message_id, request_id, created_at
      ) VALUES (?, ?, 'user_private', 'active', ?, ?, 'user', ?, 'sent', ?, ?, ?)
    `).run(
      7001,
      7001,
      7001,
      'msg-user-ios-client-in-flight',
      'plan my day',
      'ios-client-in-flight',
      'req-original',
      '2026-04-29T08:00:00.000Z',
    );

    const res = await dispatch('POST', '/message', 7001, {
      text: 'plan my day',
      clientMessageId: 'ios-client-in-flight',
    });

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({
      routeMethod: 'idempotency-in-progress',
      metadata: {
        idempotencyInProgress: true,
        replayOfUserMessageId: 'msg-user-ios-client-in-flight',
        chatReasoning: {
          actionability: 'degraded',
          verificationStatus: 'pending',
        },
      },
    });
    expect(mockHandleSecretary).not.toHaveBeenCalled();
    expect(mockRouteMessage).not.toHaveBeenCalled();
  });

  it('rejects reused client message ids with different text', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'plan my day',
    });

    const first = await dispatch('POST', '/message', 7001, {
      text: 'plan my day',
      clientMessageId: 'ios-client-conflict',
    });
    const second = await dispatch('POST', '/message', 7001, {
      text: 'cancel my day instead',
      clientMessageId: 'ios-client-conflict',
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.body).toMatchObject({
      error: {
        code: 'CHAT_IDEMPOTENCY_CONFLICT',
      },
    });
  });

  it('clears persisted chat history for the authenticated user only', async () => {
    testDb.prepare(`
      INSERT INTO messages (tenant_id, user_id, message_uuid, role, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(7001, 7001, 'msg-1', 'assistant', 'Hello again', '2026-04-19T20:00:00.000Z');
    testDb.prepare(`
      INSERT INTO messages (tenant_id, user_id, message_uuid, role, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(7002, 7002, 'msg-2', 'assistant', 'Other user', '2026-04-19T20:00:00.000Z');

    const clearRes = await dispatch('DELETE', '/history', 7001);

    const remainingRows = testDb.prepare(
      'SELECT user_id, message_uuid FROM messages ORDER BY user_id ASC'
    ).all() as Array<{ user_id: number; message_uuid: string }>;

    expect(clearRes.statusCode, JSON.stringify(clearRes.body)).toBe(200);
    expect(clearRes.body.ok).toBe(true);
    expect(clearRes.body.data.cleared).toBe(true);
    expect(mockClearAllConversations).toHaveBeenCalledWith(7001, 7001);
    expect(remainingRows).toEqual([
      { user_id: 7002, message_uuid: 'msg-2' },
    ]);
  });

  it('sanitizes clear-history failures instead of leaking the raw exception', async () => {
    mockClearChatHistory.mockImplementationOnce(() => {
      throw new Error('sqlite busy while clearing tenant 7001 history');
    });

    const clearRes = await dispatch('DELETE', '/history', 7001);

    expect(clearRes.statusCode).toBe(500);
    expect(clearRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'CHAT_HISTORY_CLEAR_FAILED',
        message: 'Failed to clear chat history',
      },
    });
    expect(JSON.stringify(clearRes.body)).not.toContain('sqlite busy while clearing tenant 7001 history');
  });

  it('sanitizes unexpected message-route failures instead of leaking provider details', async () => {
    mockRouteMessage.mockRejectedValueOnce(new Error('provider timeout for tenant 7001 while calling model'));

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'help me plan today',
    });

    expect(messageRes.statusCode).toBe(500);
    expect(messageRes.body).toMatchObject({
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'Failed to process message',
      },
    });
    expect(JSON.stringify(messageRes.body)).not.toContain('provider timeout for tenant 7001 while calling model');
  });

  it('persists attachment-driven replies and marks them as attachment routes', async () => {
    mockClassifyAndExtractImage.mockResolvedValue({
      type: 'invoice',
      vendor: 'McDonalds',
      totalAmount: '34.45 EUR',
      documentDateRaw: '07/04/2026',
      confidence: 0.98,
    });

    const messageRes = await dispatch('POST', '/message', 7002, {
      attachments: [
        { base64: 'ZmFrZS1pbWFnZS1kYXRh', mimeType: 'image/jpeg' },
      ],
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('attachment');
    expect(messageRes.body.text).toContain('McDonalds');

    const historyRes = await dispatch('GET', '/history?limit=10', 7002);
    expect(historyRes.body.messages).toHaveLength(2);
    expect(historyRes.body.messages[0]).toMatchObject({
      role: 'user',
      text: 'Analyze this image.',
    });
    expect(historyRes.body.messages[1]).toMatchObject({
      role: 'assistant',
      domain: 'finance',
      routeMethod: 'attachment',
    });
  });

  it('edits the original persisted assistant message on callback updates', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'classifier',
      confidence: 0.81,
      strippedMessage: 'cancel this',
    });

    const messageRes = await dispatch('POST', '/message', 7003, {
      text: 'cancel this',
    });
    const assistantMessageId = messageRes.body.id;

    const callbackRes = await dispatch('POST', '/callback', 7003, {
      callbackData: 'td:dn:abc123',
      messageId: assistantMessageId,
    });

    expect(callbackRes.statusCode, JSON.stringify(callbackRes.body)).toBe(200);
    expect(callbackRes.body).toMatchObject({
      text: 'Cancelled.',
      editOriginal: true,
    });

    const historyRes = await dispatch('GET', '/history?limit=10', 7003);
    expect(historyRes.body.messages).toHaveLength(2);
    expect(historyRes.body.messages[1]).toMatchObject({
      id: assistantMessageId,
      role: 'assistant',
      text: 'Cancelled.',
    });
    expect(mockSyncLastAssistantConversationMessage).toHaveBeenCalledWith(7003, 'secretary', 'Cancelled.', 7003);
  });

  it('localizes callback confirmations for Portuguese users', async () => {
    mockGetUserLanguage.mockReturnValue('pt-BR');
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'classifier',
      confidence: 0.81,
      strippedMessage: 'cancel this',
    });

    const messageRes = await dispatch('POST', '/message', 7003, {
      text: 'cancel this',
    });
    const assistantMessageId = messageRes.body.id;

    const callbackRes = await dispatch('POST', '/callback', 7003, {
      callbackData: 'td:dn:abc123',
      messageId: assistantMessageId,
    });

    expect(callbackRes.statusCode, JSON.stringify(callbackRes.body)).toBe(200);
    expect(callbackRes.body).toMatchObject({
      text: 'Cancelado.',
      editOriginal: true,
    });

    const historyRes = await dispatch('GET', '/history?limit=10', 7003);
    expect(historyRes.body.messages[1]).toMatchObject({
      id: assistantMessageId,
      role: 'assistant',
      text: 'Cancelado.',
    });
    expect(mockSyncLastAssistantConversationMessage).toHaveBeenCalledWith(7003, 'secretary', 'Cancelado.', 7003);
  });

  it('localizes callback validation errors for Portuguese users', async () => {
    mockGetUserLanguage.mockReturnValue('pt-BR');

    const callbackRes = await dispatch('POST', '/callback', 7003, {});

    expect(callbackRes.statusCode).toBe(400);
    expect(callbackRes.body.error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'callbackData é obrigatório',
    });
  });

  it('returns a client-safe localized callback error instead of leaking internal details', async () => {
    mockGetUserLanguage.mockReturnValue('pt-BR');
    mockTryDeterministicChatCommand.mockRejectedValueOnce(new Error('database password mismatch'));

    const callbackRes = await dispatch('POST', '/callback', 7003, {
      callbackData: 'cmd:/day',
    });

    expect(callbackRes.statusCode, JSON.stringify(callbackRes.body)).toBe(500);
    expect(callbackRes.body.error).toMatchObject({
      code: 'INTERNAL',
      message: 'Falha ao processar a ação.',
    });
    expect(JSON.stringify(callbackRes.body)).not.toContain('database password mismatch');
  });

  it('returns inline buttons for deterministic fast-path responses and persists them', async () => {
    mockTryDeterministicChatCommand.mockResolvedValue({
      text: '<b>Tasks</b>',
      domain: 'secretary',
      buttons: [[{ text: '📅 Today', callbackData: 'cmd:/day' }]],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: '/todo',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.buttons).toEqual([[{ text: '📅 Today', callbackData: 'cmd:/day' }]]);
    expect(messageRes.body.metadata.chatReasoning).toMatchObject({
      version: 'nexus_answer_contract.v1',
      ownerSkill: 'tasks',
      routeMethod: 'fast-path',
      actionability: 'answer_only',
    });

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.body.messages[1]).toMatchObject({
      buttons: [[{ text: '📅 Today', callbackData: 'cmd:/day' }]],
      routeMethod: 'fast-path',
    });
  });

  it('handles deterministic command callbacks by replacing the original message and buttons', async () => {
    mockTryDeterministicChatCommand
      .mockResolvedValueOnce({
        text: '<b>Status</b>',
        domain: 'secretary',
        buttons: [[{ text: '📅 Today', callbackData: 'cmd:/day' }]],
      })
      .mockResolvedValueOnce({
        text: '<b>Day overview</b>',
        domain: 'secretary',
        buttons: [[{ text: '📋 Tasks', callbackData: 'cmd:/todo_summary' }]],
      });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: '/status',
    });
    const assistantMessageId = messageRes.body.id;

    const callbackRes = await dispatch('POST', '/callback', 7001, {
      callbackData: 'cmd:/day',
      messageId: assistantMessageId,
    });

    expect(callbackRes.statusCode, JSON.stringify(callbackRes.body)).toBe(200);
    expect(callbackRes.body).toMatchObject({
      text: '<b>Day overview</b>',
      editOriginal: true,
      newButtons: [[{ text: '📋 Tasks', callbackData: 'cmd:/todo_summary' }]],
    });

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.body.messages[1]).toMatchObject({
      id: assistantMessageId,
      text: '<b>Day overview</b>',
      buttons: [[{ text: '📋 Tasks', callbackData: 'cmd:/todo_summary' }]],
      routeMethod: 'fast-path',
    });
    expect(mockSyncLastAssistantConversationMessage).toHaveBeenCalledWith(7001, 'secretary', '<b>Day overview</b>', 7001);
  });

  it('attaches actionable coach buttons to fresh triathlon briefings', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'triathlon',
      method: 'classifier',
      confidence: 0.95,
      strippedMessage: 'coach me for tomorrow',
    });
    const { handleTriathlon } = await import('../../src/domains/triathlon');
    vi.mocked(handleTriathlon).mockResolvedValue({
      text: '🏋️ Coach briefing ready.',
      domain: 'triathlon',
    });
    mockGetLastCoachState.mockReturnValue({
      timestamp: Date.now(),
      briefingSummary: 'Coach briefing ready.',
      recommendations: [
        {
          eventId: 'evt-1',
          source: 'outlook',
          action: 'MODIFY',
          originalTitle: 'Track workout',
          newTitle: 'Easy run 30min',
          newStart: null,
          newEnd: null,
          summary: 'Reduce intensity for tomorrow',
        },
      ],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Coach me for tomorrow',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('triathlon');
    expect(messageRes.body.buttons).toEqual([
      [{ text: '⚠️ Reduce intensity for tomorrow', callbackData: 'coach:apply:cb-ref' }],
      [{ text: '👍 Keep all', callbackData: 'coach:dismiss' }],
    ]);
  });

  it('routes free-form Portuguese storage questions to cooking in the iOS chat flow', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'cooking',
      method: 'keyword',
      confidence: 0.94,
      strippedMessage: 'Olá eu gostaria de ralar uma cenoura como que conservo ela na geladeira por vários dias',
    });
    const { handleCooking } = await import('../../src/domains/cooking');
    vi.mocked(handleCooking).mockResolvedValue({
      text: 'Pode guardar a cenoura ralada num recipiente bem fechado com papel absorvente seco por 3 a 4 dias no frigorífico.',
      domain: 'cooking',
    });

    const messageRes = await dispatch(
      'POST',
      '/message',
      7001,
      {
        text: 'Olá eu gostaria de ralar uma cenoura como que conservo ela na geladeira por vários dias',
      },
      {
        'x-language': 'pt-BR',
      },
    );

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('cooking');
    expect(messageRes.body.text).toContain('cenoura ralada');
    expect(mockSetUserLanguage).toHaveBeenCalledWith(7001, 'pt-BR');
    expect(vi.mocked(handleCooking)).toHaveBeenCalledWith(
      'Olá eu gostaria de ralar uma cenoura como que conservo ela na geladeira por vários dias',
      7001,
      7001,
    );
  });

  it('uses the chat turn contract to correct generic recipe routing before the domain handler', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.62,
      strippedMessage: 'me indique uma receita de kibe de forno para 3 pessoas',
    });
    mockHandleSecretary.mockResolvedValue({ text: 'Should not run.', domain: 'secretary' });
    const { handleCooking } = await import('../../src/domains/cooking');
    vi.mocked(handleCooking).mockClear();
    vi.mocked(handleCooking).mockResolvedValue({
      text: [
        'Kibe de forno para 3 pessoas',
        '',
        'Ingredientes: 250g de trigo para kibe, 350g de carne moída, cebola, hortelã e sal.',
        '',
        'Modo de preparo:',
        '1. Hidrate o trigo por 20 minutos.',
        '2. Misture com a carne e temperos.',
        '3. Asse por 35 minutos a 180°C.',
        '',
        'Rende 3 porções.',
      ].join('\n'),
      domain: 'cooking',
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'me indique uma receita de kibe de forno para 3 pessoas',
    }, {
      'x-language': 'pt-BR',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('cooking');
    expect(messageRes.body.metadata.chatTurnContract).toMatchObject({
      skill: 'cooking',
      routeKind: 'generic_skill_answer',
      groundingRequired: 'none',
      expectedResponseShape: 'recipe',
    });
    expect(vi.mocked(handleCooking)).toHaveBeenCalledTimes(1);
    expect(mockHandleSecretary).not.toHaveBeenCalled();
  });

  it('does not apply turn-contract route hints when the feature flag is disabled', async () => {
    const previous = process.env.CHAT_TURN_CONTRACT_ENABLED;
    process.env.CHAT_TURN_CONTRACT_ENABLED = 'false';
    try {
      mockRouteMessage.mockResolvedValue({
        domain: 'secretary',
        method: 'keyword',
        confidence: 0.62,
        strippedMessage: 'me indique uma receita de kibe de forno para 3 pessoas',
      });
      mockHandleSecretary.mockResolvedValue({ text: 'Legacy secretary route.', domain: 'secretary' });
      const { handleCooking } = await import('../../src/domains/cooking');
      vi.mocked(handleCooking).mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'me indique uma receita de kibe de forno para 3 pessoas',
      }, {
        'x-language': 'pt-BR',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
      expect(messageRes.body.domain).toBe('secretary');
      expect(mockHandleSecretary).toHaveBeenCalledTimes(1);
      expect(vi.mocked(handleCooking)).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.CHAT_TURN_CONTRACT_ENABLED;
      } else {
        process.env.CHAT_TURN_CONTRACT_ENABLED = previous;
      }
    }
  });

  it('routes local-and-web high-risk turns through research instead of weak generic routing', async () => {
    mockRouteMessage.mockClear();
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'Do not train through knee pain. Use current sports-medicine guidance and seek professional care if pain persists.',
      sources: ['https://sportsmedicine.example/knee-pain'],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'I have knee pain, should I train today?',
    }, {
      'x-language': 'en-US',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('triathlon');
    expect(messageRes.body.routeMethod).toBe('internet-research');
    expect(messageRes.body.text).toContain('Sources consulted: https://sportsmedicine.example/knee-pain');
    expect(messageRes.body.metadata.chatTurnContract).toMatchObject({
      skill: 'training',
      routeKind: 'internet_research',
      groundingRequired: 'local_and_web',
      riskClass: 'high',
    });
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockBuildSimpleStateContext).toHaveBeenCalledWith(
      'triathlon',
      7001,
      'I have knee pain, should I train today?',
      7001,
    );
    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledWith(
      expect.stringContaining('<stable_system_policy>'),
      expect.stringContaining('Scoped Nexus state for research prompt'),
      'chat_internet_research',
      expect.objectContaining({
        userId: 7001,
        tenantId: 7001,
      }),
    );
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[1]).toContain('I have knee pain, should I train today?');
  });

  it('applies coach callbacks and clears buttons from the persisted message', async () => {
    mockGetCallbackForScope.mockReturnValue({ recommendationIds: ['evt-1'] });
    mockApplyCoachRecommendations.mockResolvedValue({
      count: 1,
      appliedRecommendations: [
        {
          eventId: 'evt-1',
          source: 'outlook',
          action: 'MODIFY',
          originalTitle: 'Track workout',
          newTitle: 'Easy run 30min',
          newStart: null,
          newEnd: null,
          summary: 'Reduce intensity for tomorrow',
        },
      ],
    });

    testDb.prepare(`
      INSERT INTO messages (tenant_id, user_id, message_uuid, role, text, domain, buttons_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      7001,
      7001,
      'coach-msg-1',
      'assistant',
      '🏋️ Coach briefing ready.',
      'triathlon',
      JSON.stringify([[{ text: '⚠️ Reduce intensity for tomorrow', callbackData: 'coach:apply:cb-ref' }]]),
      '2026-04-13T09:00:01Z',
    );

    const callbackRes = await dispatch('POST', '/callback', 7001, {
      callbackData: 'coach:apply:cb-ref',
      messageId: 'coach-msg-1',
    });

    expect(callbackRes.statusCode, JSON.stringify(callbackRes.body)).toBe(200);
    expect(callbackRes.body).toMatchObject({
      editOriginal: true,
      newButtons: null,
    });
    expect(callbackRes.body.text).toContain('Applied 1 recommendation');

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    const updated = historyRes.body.messages.find((message: any) => message.id === 'coach-msg-1');
    expect(updated).toMatchObject({
      text: callbackRes.body.text,
      buttons: null,
    });
    expect(mockSyncLastAssistantConversationMessage).toHaveBeenCalledWith(7001, 'triathlon', callbackRes.body.text, 7001);
  });

  it('routes explicit script generation asks through the canonical content script pipeline', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.97,
      strippedMessage: 'Write a short script about recovery after hard intervals',
    });
    mockGetScript.mockResolvedValueOnce({
      topic: 'Recovery after intervals',
      script: 'Hook body here. [SFX:vine-boom] [TAKE] [VERIFIED: Mock Source]\n\nFONTES VERIFICADAS:\n1. Source\n\nCTA:\nDo not leak this.',
      hook: 'Most athletes sabotage the adaptation window after intervals.',
      title_options: ['Recovery after intervals', 'Why your intervals stop working', 'The recovery mistake'],
      sources_used: [],
      estimated_duration: '0:45-0:55',
      duration_ms: 3200,
      hashtags: ['#running'],
      caption: 'Caption',
      cta: 'Save this for your next hard session.',
      degraded: false,
      warnings: [],
    });
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Write a short script about recovery after hard intervals in English',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('content');
    expect(messageRes.body.routeMethod).toBe('content-script');
    expect(messageRes.body.text).toContain('Short script');
    expect(messageRes.body.text).toContain('Hook body here.');
    expect(messageRes.body.text).toContain('Suggested closing line: Save this for your next hard session.');
    expect(messageRes.body.text).not.toContain('Possible titles');
    expect(messageRes.body.text).not.toContain('Grounded in');
    expect(messageRes.body.text).not.toContain('Visuals:');
    expect(messageRes.body.text).not.toContain('FONTES VERIFICADAS');
    expect(messageRes.body.text).not.toContain('Hashtags');
    expect(messageRes.body.text).not.toContain('[SFX:');
    expect(messageRes.body.text).not.toContain('[SHOW ON SCREEN:');
    expect(messageRes.body.text).not.toContain('[TAKE]');
    expect(messageRes.body.text).not.toContain('[VERIFIED:');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_script',
      format: 'Reel',
      topic: 'Recovery after intervals',
      cta: 'Save this for your next hard session.',
    });
    expect(mockGetScript).toHaveBeenCalledWith(
      'recovery after hard intervals',
      'general',
      1,
      'Reel',
      'quick',
      null,
      'en-US',
      'chat',
      7001,
    );
    expect(mockAddToConversation).toHaveBeenCalledWith(7001, 'content', 'user', 'Write a short script about recovery after hard intervals in English', 7001);
    expect(mockAddToConversation).toHaveBeenCalledWith(7001, 'content', 'assistant', expect.stringContaining('Short script'), 7001);
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('routes help me script prompts through the canonical content script pipeline', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.94,
      strippedMessage: 'help me script an intro about training consistency',
    });
    mockGetScript.mockResolvedValueOnce({
      topic: 'Training consistency intro',
      script: 'Open with the truth: consistency beats motivation.',
      hook: 'Training consistency is built on boring days.',
      sources_used: [],
      estimated_duration: '1:30-2:00',
      duration_ms: 2800,
      hashtags: ['#training'],
      caption: 'Training consistency starts on the ordinary days.',
      cta: 'Save this for the next week you want to skip.',
      degraded: false,
      warnings: [],
    });
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'help me script an intro about training consistency',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('content');
    expect(messageRes.body.routeMethod).toBe('content-script');
    expect(messageRes.body.text).toContain('Open with the truth: consistency beats motivation.');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_script',
      format: 'YouTube',
      topic: 'Training consistency intro',
      cta: 'Save this for the next week you want to skip.',
    });
    expect(mockGetScript).toHaveBeenCalledWith(
      'training consistency',
      'general',
      8,
      'YouTube',
      'standard',
      null,
      'en-US',
      'chat',
      7001,
    );
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('localizes degraded script warnings for Portuguese chat output and strips production cue leftovers', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.94,
      strippedMessage: 'Escreve um roteiro curto sobre recuperação depois de intervalos duros',
    });
    mockGetScript.mockResolvedValueOnce({
      topic: 'recuperação depois de intervalos duros',
      script: 'Recupera melhor. [SHOW ON SCREEN: rolo leve] [TAKE]!.',
      hook: 'Recuperar faz parte do treino.',
      title_options: ['Recupera melhor', 'Não estragues o treino'],
      sources_used: [],
      estimated_duration: '0:30-0:45',
      duration_ms: 2800,
      hashtags: ['#triatlo'],
      caption: 'Caption',
      cta: 'Guarda isto para o teu próximo treino duro.',
      degraded: true,
      warnings: ['AI synthesis was unavailable; returning search-based fallback briefs.'],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Escreve um roteiro curto sobre recuperação depois de intervalos duros em português europeu',
    }, {
      'x-language': 'pt-PT',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.text).toContain('Aviso: este roteiro foi gerado em modo degradado.');
    expect(messageRes.body.text).toContain('A síntese por IA ficou indisponível');
    expect(messageRes.body.text).toContain('Fecho sugerido: Guarda isto para o teu próximo treino duro.');
    expect(messageRes.body.text).not.toContain('[SHOW ON SCREEN:');
    expect(messageRes.body.text).not.toContain('[TAKE]');
    expect(messageRes.body.text).not.toContain('!.');
  });

  it('uses the content refine shortcut for content follow-up rewrites instead of the generic content handler', async () => {
    mockRouteMessage.mockResolvedValueOnce({
      domain: 'content',
      method: 'keyword',
      confidence: 0.97,
      strippedMessage: 'Write a short script about recovery after hard intervals',
    });

    const firstRes = await dispatch('POST', '/message', 7001, {
      text: 'Write a short script about recovery after hard intervals in English',
    });

    expect(firstRes.statusCode, JSON.stringify(firstRes.body)).toBe(200);
    mockGetLastAssistantMessage.mockReturnValue(firstRes.body.text);
    mockRouteMessage.mockResolvedValueOnce({
      domain: 'content',
      method: 'context',
      confidence: 0.91,
      strippedMessage: 'make it shorter',
    });

    const { handleContent } = await import('../../src/domains/content-creator');
    const refineRes = await dispatch('POST', '/message', 7001, {
      text: 'make it shorter',
    }, {
      'x-language': 'en-US',
    });

    expect(refineRes.statusCode, JSON.stringify(refineRes.body)).toBe(200);
    expect(refineRes.body.domain).toBe('content');
    expect(refineRes.body.routeMethod).toBe('content-refine');
    expect(refineRes.body.text).toBe('Tighter revised draft.');
    expect(refineRes.body.metadata).toMatchObject({
      type: 'content_refine',
      degraded: false,
    });
    expect(mockCompleteOneShotWithFallback).toHaveBeenCalledWith(
      expect.stringContaining('Reply in English unless the user explicitly asks to switch languages.'),
      expect.stringContaining('make it shorter'),
      'content_chat_refine',
      expect.any(Function),
      expect.objectContaining({
        maxTokens: 1200,
        temperature: 0.5,
        userId: 7001,
      }),
    );
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('returns a conservative shortened fallback when live content refinement is unavailable', async () => {
    mockRouteMessage.mockResolvedValueOnce({
      domain: 'content',
      method: 'context',
      confidence: 0.91,
      strippedMessage: 'make it shorter',
    });
    mockGetLastAssistantMessage.mockReturnValue(
      'You are training hard, but recovery is where adaptation happens. Sleep and fuel matter more than most athletes admit. If you ignore recovery, your next interval day will suffer.',
    );
    mockCompleteOneShotWithFallback.mockRejectedValueOnce(new Error('gemini overloaded'));

    const refineRes = await dispatch('POST', '/message', 7001, {
      text: 'make it shorter',
    }, {
      'x-language': 'en-US',
    });

    expect(refineRes.statusCode, JSON.stringify(refineRes.body)).toBe(200);
    expect(refineRes.body.routeMethod).toBe('content-refine-fallback');
    expect(refineRes.body.text).toContain('conservative shorter version');
    expect(refineRes.body.text).toContain('You are training hard');
    expect(refineRes.body.metadata).toMatchObject({
      type: 'content_refine_fallback',
      degraded: true,
      warnings: ['content_refine_unavailable'],
    });
  });

  it('returns an explicit degraded script-unavailable response when the structured script pipeline fails', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'Write a short script about recovery after hard intervals',
    });
    mockGetScript.mockRejectedValueOnce(new Error('content engine unavailable'));
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Write a short script about recovery after hard intervals in English',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('content');
    expect(messageRes.body.routeMethod).toBe('content-script-unavailable');
    expect(messageRes.body.text).toContain('structured script');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_script_unavailable',
      degraded: true,
      format: 'Reel',
      warnings: ['content_engine_unavailable'],
    });
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('returns desk-ready content from the deterministic content shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.95,
      strippedMessage: 'what content is already ready on my desk?',
    });
    mockGetContentDeskItems.mockReturnValue([
      {
        id: 1,
        type: 'script_ready',
        title: 'Recovery reel draft',
        body: 'Script ready to review',
        createdAt: '2026-04-15T12:00:00.000Z',
      },
      {
        id: 2,
        type: 'weekly_package_ready',
        title: 'Weekly creator pack',
        body: 'Topics and hooks ready',
        createdAt: '2026-04-15T11:00:00.000Z',
      },
    ]);
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what content is already ready on my desk?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('content');
    expect(messageRes.body.routeMethod).toBe('content-intelligence-shortcut');
    expect(messageRes.body.text).toContain('Recovery reel draft');
    expect(messageRes.body.text).toContain('Weekly creator pack');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_desk_snapshot',
      deskReadyCount: 2,
    });
    expect(mockGetContentDeskItems).toHaveBeenCalledWith(7001, 3);
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('returns tracked pillars from the deterministic content shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'classifier',
      confidence: 0.91,
      strippedMessage: 'what pillars am i tracking right now?',
    });
    mockGetActiveContentPillars.mockReturnValue([
      { name: 'Training', keywordCount: 9 },
      { name: 'AI', keywordCount: 6 },
    ]);
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what pillars am i tracking right now?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.routeMethod).toBe('content-intelligence-shortcut');
    expect(messageRes.body.text).toContain('Training (9 keywords)');
    expect(messageRes.body.text).toContain('AI (6 keywords)');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_pillars_snapshot',
      monitoredPillars: [
        { name: 'Training', keywordCount: 9 },
        { name: 'AI', keywordCount: 6 },
      ],
    });
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('returns filming guidance from the deterministic content shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.93,
      strippedMessage: 'how should i schedule filming around my week?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetFilmingRecommendation.mockResolvedValue({
      date: '2026-04-17',
      confidence: 'high',
      reason: 'This day has the cleanest mix of energy and calendar space for filming.',
      reasons: ['This day has the cleanest mix of energy and calendar space for filming.'],
      readinessScore: 78,
      trainingLoad: 'light',
      calendarLoad: 'light',
      blockStart: '2026-04-17T11:00:00.000Z',
      blockEnd: '2026-04-17T13:00:00.000Z',
      calendarReservationAvailable: false,
      calendarReservationMessage: 'Connect Google Calendar or Outlook in Settings to reserve this filming block.',
    });
    mockGetUpcomingTopicCount.mockReturnValue(3);
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'how should i schedule filming around my week?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.routeMethod).toBe('content-intelligence-shortcut');
    expect(messageRes.body.text).toContain('Best day');
    expect(messageRes.body.text).toContain('Suggested block: 11:00-13:00');
    expect(messageRes.body.text).toContain('Upcoming scheduled topics: 3');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_filming_snapshot',
      upcomingCount: 3,
      filmingRecommendation: {
        date: '2026-04-17',
        confidence: 'high',
      },
    });
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('returns the next publish candidate from the deterministic content shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.94,
      strippedMessage: 'what should i publish next?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetTopics.mockReturnValue([
      {
        id: 11,
        user_id: 7001,
        title: 'Race-week fueling mistakes',
        notes: null,
        scheduled_date: '2026-04-18',
        status: 'ready',
        created_at: '2026-04-15T10:00:00.000Z',
        updated_at: '2026-04-15T10:00:00.000Z',
      },
    ]);
    mockGetContentDeskItems.mockReturnValue([
      {
        id: 1,
        type: 'script_ready',
        title: 'Race-week fueling mistakes',
        body: 'Script ready to review',
        createdAt: '2026-04-15T09:00:00.000Z',
      },
    ]);
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what should i publish next?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('content');
    expect(messageRes.body.routeMethod).toBe('content-intelligence-shortcut');
    expect(messageRes.body.text).toContain('Race-week fueling mistakes');
    expect(messageRes.body.text).toContain('strongest next publish candidate');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_next_publish_snapshot',
      nextTopic: {
        id: 11,
        title: 'Race-week fueling mistakes',
        status: 'ready',
        scheduledDate: '2026-04-18',
      },
      deskReadyCount: 1,
    });
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('falls back to a reaction-window content priority when nothing is publish-ready yet', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.92,
      strippedMessage: 'what should i publish next?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetTopics.mockReturnValue([]);
    mockGetContentDeskItems.mockReturnValue([]);
    mockGetRankedContentSignals.mockReturnValue([
      {
        type: 'reaction_opportunity',
        title: 'Creators are debating carb myths again',
        summary: 'This is moving quickly and still has room for a strong response.',
        priority: 'urgent',
        relevanceScore: 0.93,
        confidence: 0.81,
      },
    ]);
    mockGetNextContentExecutionHint.mockResolvedValue({
      mode: 'reaction_window',
      title: 'Creators are debating carb myths again',
      summary: 'This is moving quickly and still has room for a strong response.',
      scheduledDate: null,
      confidence: 'high',
      sourceType: 'reaction_opportunity',
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what should i publish next?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('content');
    expect(messageRes.body.routeMethod).toBe('content-intelligence-shortcut');
    expect(messageRes.body.text).toContain('react while this window is still fresh');
    expect(messageRes.body.text).toContain('Creators are debating carb myths again');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_next_publish_snapshot',
      nextTopic: null,
      deskReadyCount: 0,
      candidateMode: 'reaction_window',
      candidateTitle: 'Creators are debating carb myths again',
      confidence: 'high',
      sourceType: 'reaction_opportunity',
      topSignalType: 'reaction_opportunity',
    });
  });

  it('returns the best recent content performance from the deterministic content shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.95,
      strippedMessage: 'what performed best?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetPerformanceSummary.mockReturnValue({
      count: 2,
      avgViews: 4100,
      avgRetention: 54.5,
      totalLikes: 0,
      totalComments: 0,
      totalSubsGained: 0,
      entries: [
        {
          id: 21,
          pipelineId: null,
          videoUrl: 'https://youtu.be/best-views',
          views: 6200,
          retentionPct: 49.1,
          likes: 0,
          comments: 0,
          subsGained: 0,
          hookUsed: null,
          notes: null,
          analysis: null,
          userId: 7001,
          loggedAt: '2026-04-15T10:00:00.000Z',
        },
        {
          id: 22,
          pipelineId: null,
          videoUrl: 'https://youtu.be/best-retention',
          views: 2000,
          retentionPct: 59.9,
          likes: 0,
          comments: 0,
          subsGained: 0,
          hookUsed: null,
          notes: null,
          analysis: null,
          userId: 7001,
          loggedAt: '2026-04-14T10:00:00.000Z',
        },
      ],
    });
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what performed best?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('content');
    expect(messageRes.body.routeMethod).toBe('content-intelligence-shortcut');
    expect(messageRes.body.text).toContain('best-views');
    expect(messageRes.body.text).toContain('best-retention');
    expect(messageRes.body.text).toContain('30-day average');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_performance_snapshot',
      count: 2,
      avgViews: 4100,
      avgRetention: 54.5,
      bestByViews: {
        id: 21,
        views: 6200,
      },
      bestByRetention: {
        id: 22,
        retentionPct: 59.9,
      },
    });
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('returns learned content patterns from the deterministic content shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.93,
      strippedMessage: 'what are we learning this week?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetLearnedPatterns.mockReturnValue([
      {
        id: 31,
        category: 'hook_effectiveness',
        patternText: 'Direct confession hooks lift early retention.',
        examples: [],
        confidence: 0.88,
        frequency: 4,
        sourceAgent: 'content-analysis',
        firstDetectedAt: '2026-04-10T10:00:00.000Z',
        lastSeenAt: '2026-04-15T10:00:00.000Z',
        userId: 7001,
      },
      {
        id: 32,
        category: 'content_formula',
        patternText: '45-60 second myth-busting reels outperform longer explainers.',
        examples: [],
        confidence: 0.82,
        frequency: 3,
        sourceAgent: 'content-analysis',
        firstDetectedAt: '2026-04-11T10:00:00.000Z',
        lastSeenAt: '2026-04-15T10:00:00.000Z',
        userId: 7001,
      },
    ]);
    const { handleContent } = await import('../../src/domains/content-creator');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what are we learning this week?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('content');
    expect(messageRes.body.routeMethod).toBe('content-intelligence-shortcut');
    expect(messageRes.body.text).toContain('learning loop');
    expect(messageRes.body.text).toContain('Hook performance');
    expect(messageRes.body.text).toContain('Winning format');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'content_learning_snapshot',
      count: 2,
      patterns: [
        { id: 31, category: 'hook_effectiveness', frequency: 4 },
        { id: 32, category: 'content_formula', frequency: 3 },
      ],
    });
    expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
  });

  it('returns missing tracked bills for the deterministic finance shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'finance',
      method: 'keyword',
      confidence: 0.92,
      strippedMessage: 'what bills are still missing this month?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetAllInvoiceVendors.mockReturnValue([
      { name: 'Santander Consumer', senderPatterns: ['santander.pt'], subjectPatterns: ['fatura'], builtin: true },
      { name: 'ViaVerde', senderPatterns: ['viaverde.pt'], subjectPatterns: ['fatura'], builtin: true },
      { name: 'NOS Empresas', senderPatterns: ['nos.pt'], subjectPatterns: ['fatura'], builtin: true },
    ]);
    mockGetFilingsForMonth.mockReturnValue([
      { vendor: 'Santander Consumer', status: 'filed', document_date: '2026-04-03', user_id: 7001 },
    ]);

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what bills are still missing this month?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('finance-state-shortcut');
    expect(messageRes.body.text).toContain('ViaVerde');
    expect(messageRes.body.text).toContain('NOS Empresas');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'finance_missing_bills_snapshot',
      trackedVendorCount: 3,
      filedVendorCount: 1,
      missingVendors: ['ViaVerde', 'NOS Empresas'],
    });
  });

  it('returns the current renewal state from the deterministic finance shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'finance',
      method: 'keyword',
      confidence: 0.91,
      strippedMessage: 'what subscriptions renew soon?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetSubscriptionStatus.mockReturnValue({
      plan: 'max',
      period: 'monthly',
      status: 'active',
      provider: 'stripe',
      currentPeriodEnd: '2026-04-24T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      isActive: true,
      isPro: true,
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what subscriptions renew soon?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('finance-state-shortcut');
    expect(messageRes.body.text).toContain('Nexus Hub');
    expect(messageRes.body.text).toContain('Plan: max monthly');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'finance_subscription_snapshot',
      trackedSubscriptions: 1,
      renewalDueSoon: true,
      subscription: {
        plan: 'max',
        provider: 'stripe',
      },
    });
  });

  it('returns remaining budget from the deterministic finance shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'finance',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: "what's my budget remaining this month?",
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetMonthlySummary.mockReturnValue({
      month: '2026-04',
      totalIncome: 2400,
      totalExpenses: 900,
      totalDeductions: 100,
      netIncome: 1500,
      transactionCount: 8,
    });
    mockGetMonthlyBudgetView.mockReturnValue({
      month: '2026-04',
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'reliable',
      affordability: 'comfortable',
      incomeInBasisCurrency: 2400,
      expensesInBasisCurrency: 900,
      currentRemainingInBasisCurrency: 1500,
      currentRemainingRatio: 0.63,
      projectedExpensesInBasisCurrency: 1000,
      projectedRemainingInBasisCurrency: 1400,
      projectedRemainingRatio: 0.58,
      recurringExpenseEstimate: 100,
      recurringExpenseCount: 2,
      recurringExpenses: [],
      notes: [],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: "what's my budget remaining this month?",
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('finance-state-shortcut');
    expect(messageRes.body.text).toContain('Remaining');
    expect(messageRes.body.text).toContain('recurring commitments');
    expect(messageRes.body.text).toContain('1,500');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'finance_budget_snapshot',
      totalIncome: 2400,
      totalExpenses: 900,
      remaining: 1500,
      remainingRatio: 63,
      integrity: 'reliable',
      basisCurrency: 'EUR',
      recurringExpenseEstimate: 100,
      recurringExpenseCount: 2,
      derived: true,
    });
  });

  it('warns when the month mixes currencies instead of pretending budget headroom is reliable', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'finance',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: "what's my budget remaining this month?",
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetMonthlySummary.mockReturnValue({
      month: '2026-04',
      totalIncome: 2400,
      totalExpenses: 900,
      totalDeductions: 0,
      netIncome: 1500,
      transactionCount: 8,
    });
    mockGetMonthlyBudgetView.mockReturnValue({
      month: '2026-04',
      basisCurrency: 'EUR',
      currencies: ['EUR', 'BRL'],
      integrity: 'mixed_currency',
      affordability: 'unknown',
      incomeInBasisCurrency: 2400,
      expensesInBasisCurrency: 550,
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

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: "what's my budget remaining this month?",
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.text).toContain('mixed currencies');
    expect(messageRes.body.text).toContain('normalize or separate');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'finance_budget_snapshot',
      integrity: 'mixed_currency',
      remainingRatio: null,
      currencies: ['EUR', 'BRL'],
      derived: false,
    });
  });

  it('returns the next pending tax from the deterministic finance shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'finance',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'what tax is due next?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetTaxEvents.mockReturnValue([
      {
        id: 77,
        user_id: 7001,
        month: '2026-03',
        gross_income: 5000,
        deductions: 400,
        taxable_income: 3600,
        tax_due: 275,
        inss_due: 908.86,
        status: 'pending',
        darf_code: '0190',
        paid_at: null,
        notes: null,
        created_at: '2026-04-01T10:00:00.000Z',
        updated_at: '2026-04-01T10:00:00.000Z',
      },
    ]);

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what tax is due next?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('finance-state-shortcut');
    expect(messageRes.body.text).toContain('2026-03');
    expect(messageRes.body.text).toContain('275');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'finance_tax_snapshot',
      month: '2026-03',
      taxDue: 275,
      inssDue: 908.86,
      status: 'pending',
      derived: false,
      chatReasoning: {
        version: 'nexus_answer_contract.v1',
        ownerSkill: 'finance',
        routeMethod: 'finance-state-shortcut',
        actionability: 'answer_only',
      },
    });
  });

  it('keeps token-zero deterministic reads available after the AI usage limit is reached', async () => {
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0.06,
      capUsd: 0.04,
      plan: 'pro',
      resetAt: '2026-04-15T00:00:00.000Z',
      limitUsd: 0.04,
      usedUsd: 0.06,
      remainingUsd: 0,
      planDailyLimitUsd: 0.04,
      includedRemainingUsd: 0,
      nexusPointsBalance: 0,
      nexusPointsRemainingUsd: 0,
      pointsPurchaseAvailable: true,
    });
    mockRouteMessage.mockResolvedValue({
      domain: 'finance',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'what tax is due next?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetTaxEvents.mockReturnValue([
      {
        id: 78,
        user_id: 7001,
        month: '2026-04',
        gross_income: 5000,
        deductions: 400,
        taxable_income: 3600,
        tax_due: 300,
        inss_due: 920,
        status: 'pending',
        darf_code: '0190',
        paid_at: null,
        notes: null,
        created_at: '2026-04-01T10:00:00.000Z',
        updated_at: '2026-04-01T10:00:00.000Z',
      },
    ]);

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what tax is due next?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.routeMethod).toBe('finance-state-shortcut');
    expect(messageRes.body.text).toContain('2026-04');
    expect(mockHandleSecretary).not.toHaveBeenCalled();
  });

  it('returns the accountant handoff state from the deterministic finance shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'finance',
      method: 'classifier',
      confidence: 0.9,
      strippedMessage: 'what should i send to my accountant?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetFiscalCollectionSummary.mockReturnValue({
      profile: {
        user_id: 7001,
        destination_email: null,
        cadence: 'twice_monthly',
        primary_day: 5,
        secondary_day: 20,
        enabled: true,
        last_bundle_sent_at: '2026-04-10T08:10:00.000Z',
        last_bundle_document_count: 7,
        created_at: '2026-04-01T00:00:00.000Z',
        updated_at: '2026-04-10T08:10:00.000Z',
      },
      destinationEmail: null,
      nextRunAt: '2026-04-20T08:10:00.000Z',
      providers: [
        { provider: 'gmail', connected: true },
        { provider: 'outlook', connected: false },
      ],
      ruleCount: 6,
      customRuleCount: 3,
      deliveryAvailable: true,
      warnings: ['DESTINATION_EMAIL_MISSING'],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what should i send to my accountant?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('finance-state-shortcut');
    expect(messageRes.body.text).toContain('accountant handoff');
    expect(messageRes.body.text).toContain('Missing destination email');
    expect(messageRes.body.text).toContain('Gmail');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'finance_accountant_bundle_snapshot',
      destinationEmail: null,
      cadence: 'twice_monthly',
      connectedProviders: ['Gmail'],
      ruleCount: 6,
      customRuleCount: 3,
      warnings: ['DESTINATION_EMAIL_MISSING'],
      deliveryAvailable: true,
    });
  });

  it('returns monthly spend from the deterministic finance shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'finance',
      method: 'classifier',
      confidence: 0.9,
      strippedMessage: 'how much did i spend this month?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetMonthlySummary.mockReturnValue({
      month: '2026-04',
      totalIncome: 2400,
      totalExpenses: 780,
      totalDeductions: 100,
      netIncome: 1620,
      transactionCount: 6,
    });
    mockGetMonthlyBudgetView.mockReturnValue({
      month: '2026-04',
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'reliable',
      affordability: 'controlled',
      incomeInBasisCurrency: 2400,
      expensesInBasisCurrency: 780,
      currentRemainingInBasisCurrency: 1620,
      currentRemainingRatio: 0.68,
      projectedExpensesInBasisCurrency: 960,
      projectedRemainingInBasisCurrency: 1440,
      projectedRemainingRatio: 0.6,
      recurringExpenseEstimate: 180,
      recurringExpenseCount: 3,
      recurringExpenses: [],
      notes: [],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'how much did i spend this month?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('finance-state-shortcut');
    expect(messageRes.body.text).toContain('Total spending');
    expect(messageRes.body.text).toContain('recurring commitments');
    expect(messageRes.body.text).toContain('780');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'finance_monthly_spend_snapshot',
      month: '2026-04',
      totalExpenses: 780,
      transactionCount: 6,
      recurringExpenseEstimate: 180,
      recurringExpenseCount: 3,
    });
  });

  it('returns filed invoices from the deterministic finance shortcut', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'finance',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'what invoices did i file this month?',
    });
    mockGetUserLanguage.mockReturnValue('en-US');
    mockGetFilingsForMonth.mockReturnValue([
      {
        id: 1,
        user_id: 7001,
        vendor: 'NOS Empresas',
        sender: 'faturas@nos.pt',
        subject: 'Fatura Abril',
        received_at: '2026-04-12T09:15:00.000Z',
        status: 'filed',
        filed_at: '2026-04-12T09:20:00.000Z',
        archived_path: '/tmp/nos.pdf',
        notes: null,
        created_at: '2026-04-12T09:20:00.000Z',
        updated_at: '2026-04-12T09:20:00.000Z',
      },
      {
        id: 2,
        user_id: 7001,
        vendor: 'ViaVerde',
        sender: 'documentos@viaverde.pt',
        subject: 'Extrato Abril',
        received_at: '2026-04-13T11:40:00.000Z',
        status: 'filed',
        filed_at: '2026-04-13T11:50:00.000Z',
        archived_path: '/tmp/viaverde.xml',
        notes: null,
        created_at: '2026-04-13T11:50:00.000Z',
        updated_at: '2026-04-13T11:50:00.000Z',
      },
    ]);

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'what invoices did i file this month?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('finance-state-shortcut');
    expect(messageRes.body.text).toContain('These invoices are already filed');
    expect(messageRes.body.text).toContain('NOS Empresas');
    expect(messageRes.body.text).toContain('ViaVerde');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'finance_filed_invoices_snapshot',
      month: '2026-04',
      filedCount: 2,
      vendors: ['NOS Empresas', 'ViaVerde'],
    });
  });

  it('returns 429 with quota details when a free user tries an AI chat request', async () => {
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0,
      capUsd: 0,
      plan: 'free',
      resetAt: '2026-04-15T00:00:00.000Z',
      limitUsd: 0,
      usedUsd: 0,
      remainingUsd: 0,
      planDailyLimitUsd: 0,
      includedRemainingUsd: 0,
      nexusPointsBalance: 0,
      nexusPointsRemainingUsd: 0,
      pointsPurchaseAvailable: false,
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Help me plan my week',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(429);
    expect(messageRes.body.ok).toBe(false);
    expect(messageRes.body.error.code).toBe('daily_limit_exceeded');
    expect(messageRes.body.error.details).toEqual({
      plan: 'free',
      resetAt: '2026-04-15T00:00:00.000Z',
      limitUsd: 0,
      usedUsd: 0,
      remainingUsd: 0,
      planDailyLimitUsd: 0,
      includedRemainingUsd: 0,
      nexusPointsBalance: 0,
      nexusPointsRemainingUsd: 0,
      pointsPurchaseAvailable: false,
    });
  });

  it('fails closed on invalid tenant scope before processing personalized chat state', async () => {
    const messageRes = await dispatch('POST', '/message', 0, {
      text: 'what is on my content desk?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(401);
    expect(messageRes.body.ok).toBe(false);
    expect(messageRes.body.error.code).toBe('UNAUTHORIZED');
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockGetContentDeskItems).not.toHaveBeenCalled();
    expect(mockHandleSecretary).not.toHaveBeenCalled();

    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'chat_route_message',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('fails closed on invalid tenant scope before processing callbacks', async () => {
    const callbackRes = await dispatch('POST', '/callback', 0, {
      callbackData: 'cmd:/todo',
      messageId: 'msg-1',
    });

    expect(callbackRes.statusCode, JSON.stringify(callbackRes.body)).toBe(401);
    expect(callbackRes.body.ok).toBe(false);
    expect(callbackRes.body.error.code).toBe('UNAUTHORIZED');
    expect(mockTryDeterministicChatCommand).not.toHaveBeenCalled();

    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'chat_route_callback',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('fails closed on invalid tenant scope before loading chat history', async () => {
    const historyRes = await dispatch('GET', '/history?limit=10', 0);

    expect(historyRes.statusCode, JSON.stringify(historyRes.body)).toBe(401);
    expect(historyRes.body.ok).toBe(false);
    expect(historyRes.body.error.code).toBe('UNAUTHORIZED');

    expect(getTenantScopeAnomalies(1)).toEqual([
      expect.objectContaining({
        layer: 'delivery',
        operation: 'chat_route_history',
        reason: 'invalid_user_scope',
        userId: 0,
      }),
    ]);
  });

  it('returns a degraded chat response instead of 500 when the AI provider is temporarily overloaded', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'help me prioritize my day',
    });
    mockKeywordMatch.mockReturnValue('secretary');
    mockHandleSecretary.mockRejectedValue(Object.assign(
      new Error('Gemini overloaded'),
      { provider: 'gemini', status: 503, retryable: true },
    ));

    const res = await dispatch('POST', '/message', 7001, {
      text: 'help me prioritize my day',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.domain).toBe('secretary');
    expect(res.body.routeMethod).toBe('degraded');
    expect(res.body.metadata).toMatchObject({ degraded: true, retryable: true });
    expect(String(res.body.text)).toContain('temporarily');
    expect(mockAddToConversation).toHaveBeenCalledWith(
      7001,
      'secretary',
      'user',
      'help me prioritize my day',
      7001,
    );
    expect(mockAddToConversation).toHaveBeenCalledWith(
      7001,
      'secretary',
      'assistant',
      expect.stringContaining('temporarily'),
      7001,
    );

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.body.messages).toHaveLength(2);
    expect(historyRes.body.messages[1]).toMatchObject({
      domain: 'secretary',
      routeMethod: 'degraded',
    });
  });

  it('pauses destructive chat actions for explicit confirmation before invoking a skill handler', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'cancel my training plan and clear the calendar',
    });
    mockGetUserLanguage.mockReturnValue('en-US');

    const res = await dispatch('POST', '/message', 7001, {
      text: 'cancel my training plan and clear the calendar',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.domain).toBe('secretary');
    expect(res.body.routeMethod).toBe('confirmation-required');
    expect(res.body.metadata).toMatchObject({
      type: 'chat_action_confirmation_required',
      involvedSkills: expect.arrayContaining(['secretary', 'training']),
    });
    expect(res.body.metadata.pendingConfirmation.decisionId).toMatch(/^nc_/);
    expect(String(res.body.text)).toContain('explicit confirmation');
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockHandleSecretary).not.toHaveBeenCalled();
  });

  it('routes accept-this-decision chat confirmations through Decision Center action policy', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'cancel my training plan and clear the calendar',
    });
    mockGetUserLanguage.mockReturnValue('en-US');

    const first = await dispatch('POST', '/message', 7001, {
      text: 'cancel my training plan and clear the calendar',
    });
    const decisionId = first.body.metadata.pendingConfirmation.decisionId;
    expect(decisionId).toMatch(/^nc_/);

    const accept = await dispatch('POST', '/message', 7001, {
      text: 'accept this decision',
      idempotencyKey: 'chat-decision-accept',
    });

    expect(accept.statusCode).toBe(200);
    expect(accept.body.routeMethod).toBe('decision-center-action');
    expect(accept.body.metadata).toMatchObject({
      type: 'decision_center_chat_confirmation_actioned',
      decisionId,
      actionId: 'option_a',
    });
    expect(mockHandleSecretary).not.toHaveBeenCalled();
  });

  function expectNoStorePendingActionHeaders(res: MockRes): void {
    expect(res.headers['cache-control']).toBe('no-store, max-age=0, must-revalidate');
    expect(res.headers.pragma).toBe('no-cache');
    expect(res.headers.expires).toBe('0');
    expect(res.headers.vary).toBe('Authorization');
  }

  function seedPendingActionForHeaderTest() {
    return upsertPendingChatAction({
      userId: 7001,
      tenantId: 7001,
      conversationId: `chat-route-cache-headers-${Date.now()}`,
      skill: 'training',
      action: 'training_plan_create',
      collectedSlots: { goal: 'sub-19 5K', sessionsPerWeek: 4 },
      missingSlots: [],
      riskClass: 'R1',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      originatingSurface: 'ios',
      nowIso: new Date().toISOString(),
    });
  }

  it.each([
    {
      label: '200',
      expectedStatus: 200,
      run: async () => {
        const pending = seedPendingActionForHeaderTest();
        return dispatch('GET', `/actions/${pending.id}`, 7001);
      },
    },
    {
      label: '400',
      expectedStatus: 400,
      run: () => dispatch('GET', '/actions/!!invalid!!', 7001),
    },
    {
      label: '401',
      expectedStatus: 401,
      run: () => dispatch('GET', '/actions/missing_action', undefined as any),
    },
    {
      label: '403',
      expectedStatus: 403,
      run: () => dispatch('GET', '/actions/missing_action', 7001, undefined, {}, 7002),
    },
    {
      label: '404',
      expectedStatus: 404,
      run: () => dispatch('GET', '/actions/missing_action', 7001),
    },
  ])('sets pending-action no-store headers on runtime $label responses', async ({ expectedStatus, run }) => {
    const response = await run();
    expect(response.statusCode).toBe(expectedStatus);
    expectNoStorePendingActionHeaders(response);
  });

  it('sets no-store headers on app-level auth middleware rejection before the chat router', async () => {
    const app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.use('/chat', chatRoutes());

    const response = await requestApp(app, 'GET', '/chat/actions/missing_action', {
      Authorization: 'Bearer not-a-valid-token',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store, max-age=0, must-revalidate');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers.expires).toBe('0');
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('sets pending-action no-store headers before auth, validation, and lookup returns', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/api/routes/chat-message-routes.ts'), 'utf-8');
    const routeStart = source.indexOf("router.get('/actions/:pendingActionId'");
    const routeEnd = source.indexOf("  /**\n   * POST /api/v1/chat/message", routeStart);
    const routeSource = source.slice(routeStart, routeEnd);

    expect(routeSource).toContain("asyncHandler(async (req, res: Response) =>");
    expect(routeSource).toContain("res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate')");
    expect(routeSource).toContain("res.setHeader('Pragma', 'no-cache')");
    expect(routeSource).toContain("res.setHeader('Expires', '0')");
    expect(routeSource).toContain("res.setHeader('Vary', 'Authorization')");
    expect(routeSource.indexOf("res.setHeader('Cache-Control'")).toBeLessThan(routeSource.indexOf('ensureValidChatRouteScope'));
    expect(routeSource.indexOf("res.setHeader('Cache-Control'")).toBeLessThan(routeSource.indexOf('res.status(400)'));
    expect(routeSource.indexOf("res.setHeader('Cache-Control'")).toBeLessThan(routeSource.indexOf('res.status(404)'));
  });
});
