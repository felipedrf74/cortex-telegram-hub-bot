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
const mockCheckSkillAccess = vi.fn(() => ({
  allowed: true,
  userTier: 'pro',
  requiredTier: 'free',
}));
const mockIsUserOverDailyCap = vi.fn(() => ({
  over: false,
  spentUsd: 0,
  capUsd: 1,
  plan: 'pro',
  usageLevel: 'enhanced',
  usageFraction: 0,
  resetAt: '2026-04-15T00:00:00.000Z',
  limitUsd: 1,
  usedUsd: 0,
  remainingUsd: 1,
  planDailyLimitUsd: 1,
  includedRemainingUsd: 1,
  nexusPointsBalance: 0,
  nexusPointsRemainingUsd: 0,
  boostAvailable: true,
  pointsPurchaseAvailable: true,
}));
const mockGetLastAssistantMessage = vi.fn(() => null);
const mockAddToConversation = vi.fn();
const mockSyncLastAssistantConversationMessage = vi.fn();
const mockClearAllConversations = vi.fn();
const mockCompleteOneShotWithFallback = vi.fn();
const mockCompleteOneShotWithSearch = vi.fn();
const mockBuildSimpleStateContext = vi.fn(async () => 'Scoped Nexus state for research prompt');
const mockHandleSecretary = vi.fn(async () => ({ text: 'Quarterly planning cleanupd.', domain: 'secretary' as const }));
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
const mockGetActivePlan = vi.fn(() => null);
const mockGetWeeksForPlan = vi.fn(() => []);
const mockGetSessionsForWeek = vi.fn(() => []);
const mockGetWeeklyAdherence = vi.fn(() => ({
  planId: 101,
  weekNumber: 1,
  totalSessions: 0,
  completedSessions: 0,
  skippedSessions: 0,
  pendingSessions: 0,
  adherenceRate: 0,
  avgRpe: null,
  avgEnergy: null,
  avgSoreness: null,
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
  clearCache: vi.fn(),
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
  checkSkillAccess: (...args: unknown[]) => mockCheckSkillAccess(...args),
  checkTierAccess: (...args: unknown[]) => mockCheckSkillAccess(...args),
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
        usageLevel: quota.usageLevel,
        usageFraction: quota.usageFraction,
        usagePercent: Math.round((quota.usageFraction || 0) * 100),
        isOverLimit: quota.over,
        boostAvailable: quota.boostAvailable,
        nexusPointsBalance: quota.nexusPointsBalance,
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

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: (...args: unknown[]) => mockGetActivePlan(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
  getWeeklyAdherence: (...args: unknown[]) => mockGetWeeklyAdherence(...args),
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
import { resetPendingChatConfirmationsForTests } from '../../src/services/chat-pending-confirmations';
import { signChatConfirmationToken } from '../../src/services/chat-confirmation-token';
import { resetPendingChatCoreV2CommandsForTests } from '../../src/services/chat-core-v2';
import { upsertTask } from '../../src/services/task-store/unified-task-store';

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

function todayIsoInTestTimezone(timezone = 'Europe/Lisbon'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error('Failed to format test date');
  }
  return `${year}-${month}-${day}`;
}

function currentMondayIso(): string {
  const today = todayIsoInTestTimezone();
  const parsed = new Date(`${today}T00:00:00.000Z`);
  const mondayOffset = (parsed.getUTCDay() + 6) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - mondayOffset);
  return parsed.toISOString().slice(0, 10);
}

function addIsoDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function daysBetweenIsoDates(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / (24 * 60 * 60 * 1000));
}

function weekdayNameForIsoDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

function shortDateLabelForIsoDate(date: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

describe('Chat API routes', () => {
  beforeEach(() => {
    Settings.now = () => new Date('2026-04-15T12:00:00.000Z').valueOf();

    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();
    resetPendingChatConfirmationsForTests();
    resetPendingChatCoreV2CommandsForTests();

    mockRouteMessage.mockReset();
    mockKeywordMatch.mockReset();
    mockTryDeterministicChatCommand.mockReset();
    mockClassifyAndExtractImage.mockReset();
    mockGetUserLanguage.mockReset();
    mockSetUserLanguage.mockReset();
    mockGetPreferredDisplayName.mockReset();
    mockCheckSkillAccess.mockReset();
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
    mockGetActivePlan.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetSessionsForWeek.mockReset();
    mockGetWeeklyAdherence.mockReset();
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
    mockCheckSkillAccess.mockReturnValue({
      allowed: true,
      userTier: 'pro',
      requiredTier: 'free',
    });
    mockIsUserOverDailyCap.mockReturnValue({
      over: false,
      spentUsd: 0,
      capUsd: 1,
      plan: 'pro',
      usageLevel: 'enhanced',
      usageFraction: 0,
      resetAt: '2026-04-15T00:00:00.000Z',
      limitUsd: 1,
      usedUsd: 0,
      remainingUsd: 1,
      planDailyLimitUsd: 1,
      includedRemainingUsd: 1,
      nexusPointsBalance: 0,
      nexusPointsRemainingUsd: 0,
      boostAvailable: true,
      pointsPurchaseAvailable: true,
    });
    mockGetLastAssistantMessage.mockReturnValue(null);
    mockHandleSecretary.mockResolvedValue({ text: 'Quarterly planning cleanupd.', domain: 'secretary' });
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
    mockGetActivePlan.mockReturnValue(null);
    mockGetWeeksForPlan.mockReturnValue([]);
    mockGetSessionsForWeek.mockReturnValue([]);
    mockGetWeeklyAdherence.mockReturnValue({
      planId: 101,
      weekNumber: 1,
      totalSessions: 0,
      completedSessions: 0,
      skippedSessions: 0,
      pendingSessions: 0,
      adherenceRate: 0,
      avgRpe: null,
      avgEnergy: null,
      avgSoreness: null,
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
    delete process.env.CHAT_V2_SHADOW_EVIDENCE_ENABLED;
    delete process.env.CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED;
    delete process.env.CHAT_V2_DETERMINISTIC_READ_EVIDENCE_ENABLED;
    delete process.env.CHAT_V2_WRITE_EVIDENCE_ENABLED;
    delete process.env.CHAT_V2_COMPLETION_MODE;
    delete process.env.CHAT_V2_EVIDENCE_HMAC_SECRET;
    delete process.env.CHAT_CORE_V2_ACTION_GATEWAY_MODE;
    delete process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE;
    delete process.env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS;
    delete process.env.CHAT_CORE_V2_ALLOWED_DOMAINS;
    delete process.env.CHAT_CORE_V2_ALLOW_DETERMINISTIC_READS;
    delete process.env.CHAT_CORE_V2_ENABLED;
    delete process.env.CHAT_CORE_V2_READS_ENABLED;
    delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
    delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    delete process.env.CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK;
    delete process.env.CHAT_CORE_V2_LEGACY_FALLBACK_DISABLED;
    delete process.env.CHAT_CORE_V2_LEGACY_FALLBACK_DISABLED_TENANTS;
    testDb?.close();
  });

  it('keeps ChatV2 completion evidence dark by default', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'classifier',
      confidence: 0.93,
      strippedMessage: 'give me a simple focus tip',
    });
    mockHandleSecretary.mockResolvedValue({ text: 'Keep the next step small.', domain: 'secretary' });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'give me a simple focus tip',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM chat_v2_completion_evidence').get()).toMatchObject({ count: 0 });
  });

  it('records safe HMAC-only ChatV2 shadow evidence when explicitly enabled', async () => {
    process.env.CHAT_V2_SHADOW_EVIDENCE_ENABLED = 'true';
    process.env.CHAT_V2_EVIDENCE_HMAC_SECRET = 'chat-routes-evidence-secret';
    const rawMessage = 'give me a simple focus tip with private words';
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'classifier',
      confidence: 0.93,
      strippedMessage: rawMessage,
    });
    mockHandleSecretary.mockResolvedValue({ text: 'Keep the next step small.', domain: 'secretary' });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: rawMessage,
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    const row = testDb.prepare('SELECT * FROM chat_v2_completion_evidence').get() as any;
    expect(row).toMatchObject({
      evidence_kind: 'shadow',
      tenant_id: 7001,
      user_id: 7001,
      message_identifier_kind: 'hmac',
      raw_field_audit_count: 0,
      response_contract_valid: 1,
    });
    expect(row.message_hmac).toMatch(/^hmac:message:[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(rawMessage);
    expect(JSON.parse(row.candidate_capabilities_json)).toContain(row.final_capability_id);
  });

  it('uses ChatCoreV2 unsupported fallback instead of routeMessage when the tenant catch-all is retired', async () => {
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'on';
    process.env.CHAT_CORE_V2_LEGACY_FALLBACK_DISABLED = 'true';
    process.env.CHAT_CORE_V2_LEGACY_FALLBACK_DISABLED_TENANTS = '7001';
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'classifier',
      confidence: 0.93,
      strippedMessage: 'tell me about unsupported parity gizmos',
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'tell me about unsupported parity gizmos',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body).toMatchObject({
      routeMethod: 'unsupported',
      metadata: {
        kind: 'unsupported',
        chatReasoning: {
          actionability: 'blocked',
          verificationStatus: 'not_required',
          fallback: {
            fallbackType: 'degraded_response',
            fallbackReason: 'legacy_fallback_disabled',
          },
        },
      },
    });
    expect(messageRes.body.reasonCodes).toContain('legacy_fallback_disabled');
    expect(mockRouteMessage).not.toHaveBeenCalled();
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

  it('routes enforced task-create write intents through ChatCoreV2 action gateway before the legacy action planner', async () => {
    process.env.CHAT_CORE_V2_ACTION_GATEWAY_MODE = 'enforce';
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Create a task called parity planner check',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
    expect(messageRes.body.routeMethod).toBe('chat-core-v2-command-preview');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'chat_core_v2_command_preview',
      chatCoreV2: {
        capabilityId: 'tasks.create',
        command: {
          commandType: 'tasks.create',
          domain: 'tasks',
        },
      },
    });
    expect(messageRes.body.metadata.chatReasoning).toMatchObject({
      routeMethod: 'chat-core-v2-command-preview',
      actionability: 'preview',
      verificationStatus: 'pending',
    });
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithFallback).not.toHaveBeenCalled();
  });

  it('executes ChatCoreV2 command-preview confirmations through the command bus and replays idempotently', async () => {
    process.env.CHAT_V2_WRITE_EVIDENCE_ENABLED = 'true';
    process.env.CHAT_V2_EVIDENCE_HMAC_SECRET = 'chat-routes-chatcore-v2-confirm-evidence-secret';
    process.env.CHAT_CORE_V2_ACTION_GATEWAY_MODE = 'enforce';
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';

    const preview = await dispatch('POST', '/message', 7001, {
      text: 'Create a task called ChatCoreV2 confirmation bridge',
      clientMessageId: 'chatcore-v2-confirm-bridge-1',
    });

    expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
    expect(preview.body.routeMethod).toBe('chat-core-v2-command-preview');
    const token = preview.body.metadata.pendingConfirmation.confirmation_token;

    const confirmed = await dispatch('POST', '/confirm-action', 7001, {
      confirmation_token: token,
      intent_class: 'tasks.create',
      idempotencyKey: 'chatcore-v2-confirm-bridge-idempotency',
    });

    expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({
      routeMethod: 'chat-core-v2-command-confirmation',
      metadata: {
        type: 'chat_core_v2_command_result',
        actionStatus: 'verified',
        verificationStatus: 'verified',
        pendingConfirmation: {
          kind: 'completed_confirmation',
          intent_class: 'tasks.create',
        },
        chatCoreV2: {
          capabilityId: 'tasks.create',
          commandType: 'tasks.create',
          status: 'verified',
        },
      },
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ? AND title = ?')
      .get(7001, 'ChatCoreV2 confirmation bridge')).toMatchObject({ count: 1 });

    const replay = await dispatch('POST', '/confirm-action', 7001, {
      confirmation_token: token,
      intent_class: 'tasks.create',
      idempotencyKey: 'chatcore-v2-confirm-bridge-idempotency',
    });

    expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.metadata).toMatchObject({
      idempotentReplay: true,
      confirmationReplay: true,
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ? AND title = ?')
      .get(7001, 'ChatCoreV2 confirmation bridge')).toMatchObject({ count: 1 });

    const evidenceRows = testDb.prepare("SELECT * FROM chat_v2_write_evidence WHERE phase = 'confirmed_writes'").all() as any[];
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]).toMatchObject({
      evidence_source: 'runtime_route',
      phase: 'confirmed_writes',
      sample_identifier_kind: 'hmac',
      risk_class: 'A',
      preview_valid: 1,
      diff_required: 1,
      visible_diff_present: 1,
      executed: 1,
      validated_before_execution: 1,
      success_claimed: 1,
      verification_status: 'verified',
      escalated_per_policy: 1,
      idempotency_passed: 1,
      retry_cancel_passed: 1,
      raw_field_audit_count: 0,
    });
    expect(evidenceRows[0].sample_hmac).toMatch(/^hmac:write:[a-f0-9]{64}$/);
    expect(JSON.stringify(evidenceRows[0])).not.toContain('ChatCoreV2 confirmation bridge');
  });

  it('routes enabled natural-language task reads through ChatCoreV2 deterministic read without disabling slash token-zero reads', async () => {
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'canary';
    process.env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS = '7001';
    process.env.CHAT_CORE_V2_ALLOWED_DOMAINS = 'tasks';
    process.env.CHAT_CORE_V2_ALLOW_DETERMINISTIC_READS = 'true';

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'What tasks do I have today?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.routeMethod).toBe('chat-core-v2-deterministic-read');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'chat_core_v2_deterministic_read',
      chatCoreV2: {
        capabilityId: 'tasks.today_summary',
      },
    });
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithFallback).not.toHaveBeenCalled();
    expect(testDb.prepare(`
      SELECT fallback_count, total_count
      FROM chat_v2_legacy_fallback_counter
      WHERE tenant_id = ?
    `).get('7001')).toMatchObject({
      fallback_count: 0,
      total_count: 1,
    });
    expect(testDb.prepare(`
      SELECT domain, route_owner, route_method, fallback_count, total_count
      FROM chat_v2_legacy_fallback_attribution_counter
      WHERE tenant_id = ?
    `).get('7001')).toMatchObject({
      domain: 'tasks',
      route_owner: 'chat_core_v2_deterministic_read',
      route_method: 'chat-core-v2-deterministic-read',
      fallback_count: 0,
      total_count: 1,
    });

    mockTryDeterministicChatCommand.mockResolvedValueOnce({
      text: '<b>Tasks</b>',
      domain: 'secretary',
      buttons: [[{ text: '📅 Today', callbackData: 'cmd:/day' }]],
    });
    const slashRes = await dispatch('POST', '/message', 7001, {
      text: '/todo',
    });
    expect(slashRes.statusCode, JSON.stringify(slashRes.body)).toBe(200);
    expect(slashRes.body.routeMethod).toBe('fast-path');
    expect(testDb.prepare(`
      SELECT fallback_count, total_count
      FROM chat_v2_legacy_fallback_counter
      WHERE tenant_id = ?
    `).get('7001')).toMatchObject({
      fallback_count: 0,
      total_count: 1,
    });
  });

  it('does not let ChatCoreV2 deterministic reads preempt write intents when reads are enabled', async () => {
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'canary';
    process.env.CHAT_CORE_V2_ACTION_GATEWAY_MODE = 'enforce';
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_ALLOWED_DOMAINS = 'tasks,secretary';
    process.env.CHAT_CORE_V2_ALLOW_DETERMINISTIC_READS = 'true';

    const taskRes = await dispatch('POST', '/message', 7001, {
      text: 'Create a task called read preemption guard',
    });

    expect(taskRes.statusCode, JSON.stringify(taskRes.body)).toBe(202);
    expect(taskRes.body.routeMethod).toBe('chat-core-v2-command-preview');
    expect(taskRes.body.routeMethod).not.toBe('chat-core-v2-deterministic-read');

    const scheduleRes = await dispatch('POST', '/message', 7001, {
      text: 'Schedule a meeting for Friday at 2pm',
    });

    expect(scheduleRes.statusCode, JSON.stringify(scheduleRes.body)).toBe(202);
    expect(scheduleRes.body.routeMethod).toBe('chat-core-v2-action-gateway');
    expect(scheduleRes.body.metadata).toMatchObject({
      type: 'chat_core_v2_write_intent_guard',
    });
    expect(scheduleRes.body.routeMethod).not.toBe('chat-core-v2-deterministic-read');
    expect(mockCompleteOneShotWithFallback).not.toHaveBeenCalled();
  });

  it('runs the action planner before Gmail unread or generic chat for Gmail-agenda event creation', async () => {
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'canary';
    process.env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS = '7001';
    mockGetUserLanguage.mockReturnValue('pt-PT');

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo',
      clientMessageId: 'pt-gmail-agenda-event-1',
    }, {
      'x-language': 'pt-AO',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
    expect(messageRes.body.domain).toBe('secretary');
    expect(messageRes.body.routeMethod).toBe('chat-action-deterministic');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'chat_action_needs_confirmation',
      actionStatus: 'needs_confirmation',
      involvedSkills: ['secretary_calendar'],
      pendingConfirmation: {
        intent_class: 'event_create',
        confirmation_token: expect.any(String),
      },
    });
    expect(messageRes.body.text).toContain('Google Calendar');
    const forbiddenTokensRegex = /927|e-mails não lidos|unread|auth\.scope|chat\.skill_capability_registry|<b>|<\/b>|Resposta estruturada/i;
    expect(messageRes.body.text).not.toMatch(forbiddenTokensRegex);
    expect(messageRes.body.metadata?.chatReasoning?.userFacingSummary ?? '').not.toMatch(forbiddenTokensRegex);
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithFallback).not.toHaveBeenCalled();
    expect(testDb.prepare(`
      SELECT fallback_count, total_count
      FROM chat_v2_legacy_fallback_counter
      WHERE tenant_id = ?
    `).get('7001')).toMatchObject({
      fallback_count: 1,
      total_count: 1,
    });
    expect(testDb.prepare(`
      SELECT domain, route_owner, route_method, fallback_count, total_count
      FROM chat_v2_legacy_fallback_attribution_counter
      WHERE tenant_id = ?
    `).get('7001')).toMatchObject({
      domain: 'secretary',
      route_owner: 'chat_action_planner',
      route_method: 'chat-action-deterministic',
      fallback_count: 1,
      total_count: 1,
    });
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

  it('gates iOS task creation behind a confirmation token and replays idempotently', async () => {
    process.env.CHAT_V2_WRITE_EVIDENCE_ENABLED = 'true';
    process.env.CHAT_V2_EVIDENCE_HMAC_SECRET = 'chat-routes-confirm-write-evidence-secret';

    const first = await dispatch('POST', '/message', 7001, {
      text: 'Add a task to call my dentist on Friday',
      clientMessageId: 'task-create-confirmation-contract-1',
    });

    expect(first.statusCode, JSON.stringify(first.body)).toBe(202);
    expect(first.body.metadata).toMatchObject({
      type: 'chat_action_needs_confirmation',
      actionStatus: 'needs_confirmation',
      pendingConfirmation: {
        kind: 'pending_confirmation',
        intent_class: 'task_create',
        sourceMessageId: 'msg-user-task-create-confirmation-contract-1',
        confirmation_token: expect.any(String),
      },
    });
    expect(first.body.metadata.actionConfirmation).toMatchObject({
      intentClass: 'task_create',
      confirmationToken: first.body.metadata.pendingConfirmation.confirmation_token,
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ?').get(7001)).toMatchObject({ count: 0 });

    const confirmationBody = {
      confirmation_token: first.body.metadata.pendingConfirmation.confirmation_token,
      intent_class: 'task_create',
    };
    const confirmed = await dispatch('POST', '/confirm-action', 7001, confirmationBody);

    expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.metadata).toMatchObject({
      type: 'chat_action_verified_success',
      actionStatus: 'verified_success',
      pendingConfirmation: {
        kind: 'completed_confirmation',
        intent_class: 'task_create',
      },
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ?').get(7001)).toMatchObject({ count: 1 });
    const evidenceRows = testDb.prepare('SELECT * FROM chat_v2_write_evidence').all() as any[];
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0]).toMatchObject({
      evidence_source: 'runtime_route',
      phase: 'confirmed_writes',
      sample_identifier_kind: 'hmac',
      risk_class: 'A',
      preview_valid: 1,
      diff_required: 1,
      visible_diff_present: 1,
      executed: 1,
      validated_before_execution: 1,
      success_claimed: 1,
      verification_status: 'verified',
      escalated_per_policy: 1,
      idempotency_passed: 1,
      retry_cancel_passed: 1,
      raw_field_audit_count: 0,
    });
    expect(evidenceRows[0].sample_hmac).toMatch(/^hmac:write:[a-f0-9]{64}$/);
    expect(JSON.stringify(evidenceRows[0])).not.toContain('call my dentist');

    const replay = await dispatch('POST', '/confirm-action', 7001, confirmationBody);
    expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.metadata).toMatchObject({
      idempotentReplay: true,
      confirmationReplay: true,
    });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ?').get(7001)).toMatchObject({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM chat_v2_write_evidence').get()).toMatchObject({ count: 1 });
  });

  it('rejects stale and wrong-user confirmation tokens before execution', async () => {
    const first = await dispatch('POST', '/message', 7001, {
      text: 'Create a task called token scope test',
      clientMessageId: 'task-create-token-scope-1',
    });
    expect(first.statusCode, JSON.stringify(first.body)).toBe(202);

    const token = first.body.metadata.pendingConfirmation.confirmation_token;
    const wrongUser = await dispatch('POST', '/confirm-action', 7002, {
      confirmation_token: token,
      intent_class: 'task_create',
    });
    expect(wrongUser.statusCode).toBe(401);

    const staleToken = signChatConfirmationToken({
      pendingId: first.body.metadata.pendingConfirmation.id,
      userId: 7001,
      tenantId: 7001,
      intentClass: 'task_create',
      expiresAt: '2026-04-15T11:59:00.000Z',
      sourceMessageId: first.body.metadata.pendingConfirmation.sourceMessageId,
      now: new Date('2026-04-15T11:50:00.000Z'),
    });
    const stale = await dispatch('POST', '/confirm-action', 7001, {
      confirmation_token: staleToken,
      intent_class: 'task_create',
    });
    expect(stale.statusCode).toBe(401);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ?').get(7001)).toMatchObject({ count: 0 });
  });

  it('routes task-with-subtasks messages through the action planner confirmation path', async () => {
    const messageRes = await dispatch('POST', '/message', 7001, {
      text: "Create a task called Prozis where it has sub tasks called creatine K2 D3 for now that's it",
      clientMessageId: 'prozis-subtasks-1',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
    expect(messageRes.body).toMatchObject({
      domain: 'tasks',
      routeMethod: 'chat-action-deterministic',
      metadata: {
        type: 'chat_action_needs_confirmation',
        actionStatus: 'needs_confirmation',
        pendingConfirmation: {
          kind: 'pending_confirmation',
          intent_class: 'task_create',
          confirmation_token: expect.any(String),
        },
      },
    });
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockHandleSecretary).not.toHaveBeenCalled();
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ? AND title = ?')
      .get(7001, 'Prozis')).toMatchObject({ count: 0 });

    const confirmed = await dispatch('POST', '/confirm-action', 7001, {
      confirmation_token: messageRes.body.metadata.pendingConfirmation.confirmation_token,
      intent_class: 'task_create',
    });

    expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({
      domain: 'tasks',
      routeMethod: 'chat-action-mixed',
      metadata: {
        type: 'chat_action_verified_success',
        actionStatus: 'verified_success',
        title: 'Prozis',
        verificationStatus: 'verified_success',
        subtasks: [
          { title: 'creatine' },
          { title: 'K2' },
          { title: 'D3' },
        ],
        pendingConfirmation: {
          kind: 'completed_confirmation',
          intent_class: 'task_create',
        },
      },
    });
    expect(confirmed.body.text).toContain('Created task “Prozis” with 3 subtasks');

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
    const run = testDb.prepare(`
      SELECT status, action_type, provider_object_id
      FROM chat_action_runs
      WHERE user_id = ? AND tenant_id = ? AND message_id = ?
    `).get(7001, 7001, 'msg-user-prozis-subtasks-1') as any;
    expect(run).toMatchObject({
      status: 'verified_success',
      action_type: 'create_task_with_subtasks',
      provider_object_id: String(task.id),
    });
  });

  it('does not duplicate task/subtask execution when iOS retries the same client message id', async () => {
    const body = {
      text: 'Create task Prozis with subtasks creatine K2 D3',
      clientMessageId: 'prozis-subtasks-retry',
    };

    const first = await dispatch('POST', '/message', 7001, body);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(202);
    const confirmationBody = {
      confirmation_token: first.body.metadata.pendingConfirmation.confirmation_token,
      intent_class: 'task_create',
    };
    const confirmed = await dispatch('POST', '/confirm-action', 7001, confirmationBody);
    const second = await dispatch('POST', '/confirm-action', 7001, confirmationBody);

    expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
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
      verificationStatus: 'not_required',
    });
    expect(messageRes.body.metadata.chatReasoning.groundingFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'chat.fast_path', safeForUser: true }),
      ]),
    );
    expect(messageRes.body.metadata.finalAnswerComposition).toMatchObject({
      mode: 'templated',
    });

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.body.messages[1]).toMatchObject({
      buttons: [[{ text: '📅 Today', callbackData: 'cmd:/day' }]],
      routeMethod: 'fast-path',
    });
  });

  it('records HMAC-only deterministic-read evidence for slash fast-path responses when enabled', async () => {
    process.env.CHAT_V2_DETERMINISTIC_READ_EVIDENCE_ENABLED = 'true';
    process.env.CHAT_V2_EVIDENCE_HMAC_SECRET = 'chat-routes-deterministic-read-evidence-secret';
    mockTryDeterministicChatCommand.mockResolvedValue({
      text: '<b>Tasks</b>',
      domain: 'secretary',
      buttons: [[{ text: '📅 Today', callbackData: 'cmd:/day' }]],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: '/todo private task phrase',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    const rows = testDb.prepare(`
      SELECT *
      FROM chat_v2_deterministic_read_evidence
      ORDER BY evidence_kind
    `).all() as any[];
    expect(rows.map((row) => row.evidence_kind)).toEqual(['deterministic_read', 'token_zero_surface']);
    for (const row of rows) {
      expect(row.evidence_source).toBe('runtime_route');
      expect(row.sample_hmac).toMatch(/^hmac:token-zero-read:[a-f0-9]{64}$/);
      expect(row.sample_identifier_kind).toBe('hmac');
      expect(row.response_contract_valid).toBe(1);
      expect(row.tenant_user_isolation_passed).toBe(1);
      expect(JSON.stringify(row)).not.toContain('private task phrase');
    }
    expect(rows.find((row) => row.evidence_kind === 'token_zero_surface')).toMatchObject({
      token_zero_surface: 'slash',
      token_zero_preserved: 1,
    });
  });

  it('records templated answer-canary evidence for slash fast-path responses when enabled', async () => {
    process.env.CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED = 'true';
    process.env.CHAT_V2_EVIDENCE_HMAC_SECRET = 'chat-routes-answer-canary-evidence-secret';
    const rawMessage = '/todo private deterministic task phrase';
    mockTryDeterministicChatCommand.mockResolvedValue({
      text: '<b>Tasks</b>',
      domain: 'secretary',
      buttons: [[{ text: '📅 Today', callbackData: 'cmd:/day' }]],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: rawMessage,
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.metadata.finalAnswerComposition).toMatchObject({
      mode: 'templated',
    });
    const row = testDb.prepare(`
      SELECT *
      FROM chat_v2_completion_evidence
      WHERE evidence_kind = 'answer_canary'
    `).get() as any;
    expect(row).toMatchObject({
      evidence_source: 'runtime_route',
      message_identifier_kind: 'hmac',
      raw_field_audit_count: 0,
      response_contract_valid: 1,
      composition_mode: 'templated',
    });
    expect(row.message_hmac).toMatch(/^hmac:message:[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain('private deterministic task phrase');
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
      strippedMessage: 'me indique uma receita de legumes assados para 3 pessoas',
    });
    mockHandleSecretary.mockResolvedValue({ text: 'Should not run.', domain: 'secretary' });
    const { handleCooking } = await import('../../src/domains/cooking');
    vi.mocked(handleCooking).mockClear();
    vi.mocked(handleCooking).mockResolvedValue({
      text: [
        'Legumes assados para 3 pessoas',
        '',
        'Ingredientes: batata, cenoura, abobrinha, cebola, azeite e sal.',
        '',
        'Modo de preparo:',
        '1. Corte os legumes em pedaços parecidos.',
        '2. Tempere com azeite, sal e ervas.',
        '3. Asse por 35 minutos a 180°C.',
        '',
        'Rende 3 porções.',
      ].join('\n'),
      domain: 'cooking',
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'me indique uma receita de legumes assados para 3 pessoas',
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
        strippedMessage: 'me indique uma receita de legumes assados para 3 pessoas',
      });
      mockHandleSecretary.mockResolvedValue({ text: 'Legacy secretary route.', domain: 'secretary' });
      const { handleCooking } = await import('../../src/domains/cooking');
      vi.mocked(handleCooking).mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'me indique uma receita de legumes assados para 3 pessoas',
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
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'canary';
    process.env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS = '7001';

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
    expect(messageRes.body.routeMethod).toBe('chat-core-v2-internet-research');
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
      expect.stringContaining('public health and training guidance for person has knee pain'),
      'chat_internet_research',
      expect.objectContaining({
        userId: 7001,
        tenantId: 7001,
      }),
    );
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[1]).not.toContain('Scoped Nexus state for research prompt');
    expect(mockCompleteOneShotWithSearch.mock.calls[0]?.[1]).not.toContain('I have knee pain, should I train today?');
    expect(testDb.prepare(`
      SELECT fallback_count, total_count
      FROM chat_v2_legacy_fallback_counter
      WHERE tenant_id = ?
    `).get('7001')).toMatchObject({
      fallback_count: 1,
      total_count: 1,
    });
  });

  it('routes regional Spanish research turns with a hard Spanish response contract', async () => {
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'canary';
    process.env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS = '7001';

    mockRouteMessage.mockClear();
    mockCompleteOneShotWithSearch.mockResolvedValueOnce({
      text: 'La inflación reciente en América Latina varía según el país y debe revisarse con fuentes actuales.',
      sources: ['https://example.com/inflacion-latam'],
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Search noticias recientes sobre inflación en América Latina esta semana.',
    }, {
      'x-language': 'es-419',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.routeMethod).toBe('chat-core-v2-internet-research');
    expect(messageRes.body.text).toContain('Fuentes consultadas: https://example.com/inflacion-latam');
    expect(messageRes.body.metadata.chatTurnContract).toMatchObject({
      routeKind: 'internet_research',
      groundingRequired: 'web',
      language: 'es',
    });
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockCompleteOneShotWithSearch).toHaveBeenCalledWith(
      expect.stringContaining('Answer in Spanish. This is a hard contract'),
      expect.stringContaining('Search noticias recientes sobre inflación'),
      'chat_internet_research',
      expect.objectContaining({
        userId: 7001,
        tenantId: 7001,
      }),
    );
    const systemPrompt = mockCompleteOneShotWithSearch.mock.calls[0]?.[0];
    expect(systemPrompt).toContain('Output language: Spanish');
    expect(systemPrompt).toContain('do not answer Spanish prompts in Portuguese');
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
      usageLevel: 'exhausted',
      usageFraction: 1,
      resetAt: '2026-04-15T00:00:00.000Z',
      limitUsd: 0.04,
      usedUsd: 0.06,
      remainingUsd: 0,
      planDailyLimitUsd: 0.04,
      includedRemainingUsd: 0,
      nexusPointsBalance: 0,
      nexusPointsRemainingUsd: 0,
      boostAvailable: true,
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

  it('keeps Chat Core v2 deterministic task reads available after the AI usage limit is reached when explicitly enabled', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousReads = process.env.CHAT_CORE_V2_READS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_READS_ENABLED = 'true';
    try {
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
      upsertTask(7001, {
        provider: 'nexus',
        externalId: 'task-core-v2-1',
        title: 'Review proposal',
        status: 'pending',
        priority: 3,
        dueDate: '2026-04-15',
        dueIsDatetime: false,
        projectName: 'Inbox',
      });

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'What tasks do I have today?',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-deterministic-read');
      expect(messageRes.body.domain).toBe('tasks');
      expect(messageRes.body.text).toContain('You have 1 open task.');
      expect(messageRes.body.text).toContain('Review proposal');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'tasks.today_summary',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'message',
          },
          readModel: {
            capabilityId: 'tasks.today_summary',
            domain: 'tasks',
            data: {
              pendingCount: 1,
            },
          },
        },
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousReads === undefined) {
        delete process.env.CHAT_CORE_V2_READS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_READS_ENABLED = previousReads;
      }
    }
  });

  it('returns a Chat Core v2 task-create preview without mutating data when write previews are enabled', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    try {
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Create a task called Buy milk',
        clientMessageId: 'chat-core-v2-task-create-preview-1',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-command-preview');
      expect(messageRes.body.domain).toBe('secretary');
      expect(messageRes.body.text).toContain('I would prepare the task "Buy milk"');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        chatCoreV2: {
          capabilityId: 'tasks.create',
          executionEnabled: false,
          executionDisabledReason: 'preview_only_rollout',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['preview_only_rollout']),
          },
          command: {
            commandSchemaVersion: 'tasks.create@1.0.0',
            previewSchemaVersion: 'task_preview_card@1.0.0',
            responseSchemaVersion: 'chat_response_v2@1.0.0',
            domain: 'tasks',
            commandType: 'tasks.create',
            origin: 'chat',
            payload: {
              title: 'Buy milk',
              dueDateTime: null,
            },
            preconditions: {
              requiredEntityVersions: {},
              invariants: [],
              hasPermissionSnapshot: true,
              hasTenantPolicySnapshot: false,
              hasIntegrationConnectionSnapshot: false,
              hasDecisionSnapshot: false,
            },
          },
          gate: {
            ok: true,
            operation: 'preview',
            commandStatus: 'previewed',
          },
        },
      });
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        type: 'task_preview_card',
        title: 'Task preview: Buy milk',
        primaryAction: {
          kind: 'view',
          label: 'View',
        },
        secondaryActions: [],
        diff: [{ label: 'Task', after: 'Buy milk' }],
      });
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0].confirmationToken).toBeUndefined();
      expect(messageRes.body.responseCards).toEqual([{
        kind: 'taskCard',
        title: 'Buy milk',
        status: 'pending',
        dueAt: null,
        listName: null,
      }]);
      const metadataJson = JSON.stringify(messageRes.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ?').get(7001)).toMatchObject({ count: 0 });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
    }
  });

  it('confirms a Chat Core v2 task-create command through the v2 command bus and replays idempotently', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    const previousConfirmations = process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';
    try {
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const preview = await dispatch('POST', '/message', 7001, {
        text: 'Create a task called Buy milk',
        clientMessageId: 'chat-core-v2-task-create-confirm-1',
      });

      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
      expect(preview.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        pendingConfirmation: {
          kind: 'pending_confirmation',
          intent_class: 'tasks.create',
          confirmation_token: expect.any(String),
        },
        chatCoreV2: {
          capabilityId: 'tasks.create',
          executionEnabled: true,
          response: {
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['confirmation_required']),
          },
        },
      });
      expect(preview.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        primaryAction: {
          kind: 'confirm',
          confirmationToken: preview.body.metadata.pendingConfirmation.confirmation_token,
        },
      });
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM unified_tasks WHERE user_id = ?').get(7001)).toMatchObject({ count: 0 });

      const confirmationBody = {
        confirmation_token: preview.body.metadata.pendingConfirmation.confirmation_token,
        intent_class: 'tasks.create',
      };
      const confirmed = await dispatch('POST', '/confirm-action', 7001, confirmationBody);

      expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
      expect(confirmed.body.routeMethod).toBe('chat-core-v2-command-confirmation');
      expect(confirmed.body.text).toBe('Done — I created the task "Buy milk".');
      expect(confirmed.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_result',
        actionStatus: 'verified',
        verificationStatus: 'verified',
        pendingConfirmation: {
          kind: 'completed_confirmation',
          intent_class: 'tasks.create',
        },
        chatCoreV2: {
          capabilityId: 'tasks.create',
          commandType: 'tasks.create',
          status: 'verified',
          response: {
            kind: 'action_result',
            cards: [expect.objectContaining({
              type: 'command_result_card',
              status: 'verified',
            })],
          },
          gate: {
            ok: true,
            operation: 'execute',
            commandStatus: 'confirmed',
          },
        },
      });
      expect(confirmed.body.responseCards).toEqual([{
        kind: 'taskCard',
        taskId: expect.any(String),
        title: 'Buy milk',
        status: 'created',
        dueAt: null,
        listName: null,
      }]);
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ? AND title = ?').get(7001, 'Buy milk')).toMatchObject({ count: 1 });
      const metadataJson = JSON.stringify(confirmed.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');

      const replay = await dispatch('POST', '/confirm-action', 7001, confirmationBody);
      expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.metadata).toMatchObject({
        idempotentReplay: true,
        confirmationReplay: true,
      });
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE user_id = ? AND title = ?').get(7001, 'Buy milk')).toMatchObject({ count: 1 });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
      if (previousConfirmations === undefined) {
        delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = previousConfirmations;
      }
    }
  });

  it('confirms a Chat Core v2 task-complete command through the v2 command bus and replays idempotently', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    const previousConfirmations = process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';
    try {
      upsertTask(7001, {
        provider: 'nexus',
        externalId: 'task-core-v2-complete-confirm-1',
        title: 'Buy milk',
        status: 'pending',
        priority: 0,
        projectName: 'Inbox',
      });
      const taskRow = testDb.prepare('SELECT id FROM unified_tasks WHERE user_id = ? AND title = ?')
        .get(7001, 'Buy milk') as { id: number };
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const preview = await dispatch('POST', '/message', 7001, {
        text: 'Complete the Buy milk task',
        clientMessageId: 'chat-core-v2-task-complete-confirm-1',
      });

      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
      expect(preview.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        pendingConfirmation: {
          kind: 'pending_confirmation',
          intent_class: 'tasks.complete',
          confirmation_token: expect.any(String),
        },
        chatCoreV2: {
          capabilityId: 'tasks.complete',
          executionEnabled: true,
          response: {
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['confirmation_required']),
          },
        },
      });
      expect(preview.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        primaryAction: {
          kind: 'confirm',
          confirmationToken: preview.body.metadata.pendingConfirmation.confirmation_token,
        },
      });
      expect(testDb.prepare('SELECT status FROM unified_tasks WHERE id = ?').get(taskRow.id)).toMatchObject({ status: 'pending' });

      const confirmationBody = {
        confirmation_token: preview.body.metadata.pendingConfirmation.confirmation_token,
        intent_class: 'tasks.complete',
      };
      const confirmed = await dispatch('POST', '/confirm-action', 7001, confirmationBody);

      expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
      expect(confirmed.body.routeMethod).toBe('chat-core-v2-command-confirmation');
      expect(confirmed.body.text).toBe('Done — I marked "Buy milk" as done.');
      expect(confirmed.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_result',
        actionStatus: 'verified',
        verificationStatus: 'verified',
        pendingConfirmation: {
          kind: 'completed_confirmation',
          intent_class: 'tasks.complete',
        },
        chatCoreV2: {
          capabilityId: 'tasks.complete',
          commandType: 'tasks.complete',
          status: 'verified',
          response: {
            kind: 'action_result',
            cards: [expect.objectContaining({
              type: 'command_result_card',
              status: 'verified',
            })],
          },
          gate: {
            ok: true,
            operation: 'execute',
            commandStatus: 'confirmed',
          },
        },
      });
      expect(confirmed.body.responseCards).toEqual([{
        kind: 'taskCard',
        taskId: String(taskRow.id),
        title: 'Buy milk',
        status: 'completed',
        dueAt: null,
        listName: null,
      }]);
      expect(testDb.prepare('SELECT status FROM unified_tasks WHERE id = ?').get(taskRow.id)).toMatchObject({ status: 'completed' });
      const metadataJson = JSON.stringify(confirmed.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');

      const replay = await dispatch('POST', '/confirm-action', 7001, confirmationBody);
      expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.metadata).toMatchObject({
        idempotentReplay: true,
        confirmationReplay: true,
      });
      expect(testDb.prepare('SELECT status FROM unified_tasks WHERE id = ?').get(taskRow.id)).toMatchObject({ status: 'completed' });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
      if (previousConfirmations === undefined) {
        delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = previousConfirmations;
      }
    }
  });

  it('rejects a stale Chat Core v2 task-complete confirmation before mutating again', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    const previousConfirmations = process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';
    try {
      upsertTask(7001, {
        provider: 'nexus',
        externalId: 'task-core-v2-complete-stale-1',
        title: 'Buy milk',
        status: 'pending',
        priority: 0,
        projectName: 'Inbox',
      });
      const taskRow = testDb.prepare('SELECT id FROM unified_tasks WHERE user_id = ? AND title = ?')
        .get(7001, 'Buy milk') as { id: number };

      const preview = await dispatch('POST', '/message', 7001, {
        text: 'Complete the Buy milk task',
        clientMessageId: 'chat-core-v2-task-complete-stale-1',
      });
      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
      expect(preview.body.metadata.pendingConfirmation.confirmation_token).toEqual(expect.any(String));

      testDb.prepare("UPDATE unified_tasks SET status = 'completed', content_hash = NULL WHERE id = ?").run(taskRow.id);

      const confirmed = await dispatch('POST', '/confirm-action', 7001, {
        confirmation_token: preview.body.metadata.pendingConfirmation.confirmation_token,
        intent_class: 'tasks.complete',
      });

      expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(409);
      expect(confirmed.body.error).toMatchObject({
        code: 'CHAT_CORE_V2_CONFIRMATION_NOT_EXECUTABLE',
        message: 'This preview is no longer safe to apply. Please ask again so I can refresh it.',
      });
      expect(testDb.prepare('SELECT status FROM unified_tasks WHERE id = ?').get(taskRow.id)).toMatchObject({ status: 'completed' });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
      if (previousConfirmations === undefined) {
        delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = previousConfirmations;
      }
    }
  });

  it('returns a Chat Core v2 secretary schedule preview without creating calendar events', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousPreviews = process.env.CHAT_CORE_V2_PREVIEWS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_PREVIEWS_ENABLED = 'true';
    try {
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Schedule a meeting for Friday at 2pm called weekly sync',
        clientMessageId: 'chat-core-v2-secretary-schedule-preview-1',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-command-preview');
      expect(messageRes.body.domain).toBe('secretary');
      expect(messageRes.body.text).toContain('No calendar event or invite would be created yet.');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        chatCoreV2: {
          capabilityId: 'secretary.schedule_event_preview',
          executionEnabled: false,
          executionDisabledReason: 'preview_only_rollout',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['preview_only_rollout']),
          },
          command: {
            commandSchemaVersion: 'secretary.schedule_event@1.0.0',
            previewSchemaVersion: 'calendar_change_preview_card@1.0.0',
            responseSchemaVersion: 'chat_response_v2@1.0.0',
            domain: 'secretary',
            commandType: 'secretary.schedule_event',
            origin: 'chat',
            payload: {
              operation: 'schedule_event',
              title: 'weekly sync',
              provider: 'google_calendar',
              calendarId: 'primary',
              timezone: 'Europe/Lisbon',
              attendees: [],
              status: 'preview',
            },
            basedOn: {
              entityIds: [expect.stringMatching(/^calendar_event_draft:cmd_/)],
              entityVersions: {},
            },
            preconditions: {
              requiredEntityVersions: {},
              invariants: [{
                type: 'preview_only',
                description: 'Secretary calendar previews do not create events or invite attendees in this rollout.',
                check: 'secretary_schedule_event_preview_only',
              }],
              hasPermissionSnapshot: true,
            },
          },
          gate: {
            ok: true,
            operation: 'preview',
            commandStatus: 'previewed',
          },
        },
      });
      expect(String(messageRes.body.metadata.chatCoreV2.command.payload.startDateTime)).toContain('2026-06-05T14:00:00');
      expect(String(messageRes.body.metadata.chatCoreV2.command.payload.endDateTime)).toContain('2026-06-05T15:00:00');
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        type: 'calendar_change_preview_card',
        title: 'Calendar preview: weekly sync',
        primaryAction: {
          kind: 'view',
          label: 'View',
        },
        secondaryActions: [],
        diff: expect.arrayContaining([
          { label: 'Event', after: 'weekly sync' },
          { label: 'Calendar', after: 'Google' },
          { label: 'Status', after: 'Preview' },
        ]),
      });
      expect(messageRes.body.responseCards).toEqual([{
        kind: 'eventCard',
        eventId: null,
        title: 'weekly sync',
        startAt: expect.stringContaining('2026-06-05T14:00:00'),
        endAt: expect.stringContaining('2026-06-05T15:00:00'),
        location: null,
        attendees: [],
        status: 'pending',
      }]);
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0].confirmationToken).toBeUndefined();
      const metadataJson = JSON.stringify(messageRes.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousPreviews === undefined) {
        delete process.env.CHAT_CORE_V2_PREVIEWS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_PREVIEWS_ENABLED = previousPreviews;
      }
    }
  });

  it('returns a Chat Core v2 task-complete preview with entity preconditions without completing the task', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    try {
      upsertTask(7001, {
        provider: 'nexus',
        externalId: 'task-core-v2-complete-1',
        title: 'Buy milk',
        status: 'pending',
        priority: 0,
        projectName: 'Inbox',
      });
      const taskRow = testDb.prepare('SELECT id FROM unified_tasks WHERE user_id = ? AND title = ?')
        .get(7001, 'Buy milk') as { id: number };
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Complete the Buy milk task',
        clientMessageId: 'chat-core-v2-task-complete-preview-1',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-command-preview');
      expect(messageRes.body.domain).toBe('secretary');
      expect(messageRes.body.text).toBe('I would mark "Buy milk" as done.');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        chatCoreV2: {
          capabilityId: 'tasks.complete',
          executionEnabled: false,
          executionDisabledReason: 'preview_only_rollout',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['preview_only_rollout']),
          },
          command: {
            commandSchemaVersion: 'tasks.complete@1.0.0',
            previewSchemaVersion: 'task_preview_card@1.0.0',
            responseSchemaVersion: 'chat_response_v2@1.0.0',
            domain: 'tasks',
            commandType: 'tasks.complete',
            origin: 'chat',
            payload: {
              operation: 'complete',
              taskId: taskRow.id,
              title: 'Buy milk',
              currentStatus: 'pending',
              targetStatus: 'completed',
            },
            basedOn: {
              entityIds: [`task:${taskRow.id}`],
              entityVersions: {
                [`task:${taskRow.id}`]: expect.stringMatching(/^[0-9a-f]{16}$/),
              },
            },
            preconditions: {
              requiredEntityVersions: {
                [`task:${taskRow.id}`]: expect.stringMatching(/^[0-9a-f]{16}$/),
              },
              invariants: [{
                type: 'task_status',
                description: 'Task must still be pending when the preview is confirmed.',
                check: 'task_is_pending',
              }],
              hasPermissionSnapshot: true,
            },
          },
          gate: {
            ok: true,
            operation: 'preview',
            commandStatus: 'previewed',
          },
        },
      });
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        type: 'task_preview_card',
        title: 'Completion preview: Buy milk',
        primaryAction: {
          kind: 'view',
          label: 'View',
        },
        secondaryActions: [],
        diff: [
          { label: 'Task', after: 'Buy milk' },
          { label: 'Status', after: 'Done' },
        ],
      });
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0].confirmationToken).toBeUndefined();
      const metadataJson = JSON.stringify(messageRes.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');
      expect(testDb.prepare('SELECT status FROM unified_tasks WHERE id = ?').get(taskRow.id)).toMatchObject({ status: 'pending' });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
    }
  });

  it('answers Decision Center status through Chat Core v2 deterministic reads when explicitly enabled', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousReads = process.env.CHAT_CORE_V2_READS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_READS_ENABLED = 'true';
    try {
      mockRouteMessage.mockResolvedValue({
        domain: 'secretary',
        method: 'keyword',
        confidence: 0.9,
        strippedMessage: 'cancel my training plan and clear the calendar',
      });
      mockGetUserLanguage.mockReturnValue('en-US');

      const decisionSeed = await dispatch('POST', '/message', 7001, {
        text: 'cancel my training plan and clear the calendar',
      });
      expect(decisionSeed.statusCode, JSON.stringify(decisionSeed.body)).toBe(200);
      expect(decisionSeed.body.routeMethod).toBe('confirmation-required');

      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'What is in Decision Center?',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-deterministic-read');
      expect(messageRes.body.domain).toBe('decision_center');
      expect(messageRes.body.text).toContain('Decision Center has');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'decision_center.summary',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'message',
          },
          readModel: {
            capabilityId: 'decision_center.summary',
            domain: 'decision_center',
            data: {
              openCount: expect.any(Number),
            },
          },
        },
      });
      expect(messageRes.body.metadata.chatCoreV2.readModel.data.openCount).toBeGreaterThan(0);
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousReads === undefined) {
        delete process.env.CHAT_CORE_V2_READS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_READS_ENABLED = previousReads;
      }
    }
  });

  it('answers notification status through Chat Core v2 deterministic reads when explicitly enabled', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousReads = process.env.CHAT_CORE_V2_READS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_READS_ENABLED = 'true';
    try {
      const { createNotificationIntent } = await import('../../src/services/notification-orchestrator');
      await createNotificationIntent({
        userId: 7001,
        tenantId: 7001,
        sourceSkill: 'system',
        type: 'reminder',
        priority: 'active',
        title: 'Daily planning reminder',
        body: 'Review today before the afternoon starts.',
        actionButtons: [{ id: 'open', label: 'Open', style: 'primary' }],
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'standard',
        dedupeKey: 'chat-core-v2-notification-read-route',
      });
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'What notifications do I have?',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-deterministic-read');
      expect(messageRes.body.domain).toBe('notifications');
      expect(messageRes.body.text).toContain('You have 1 unread notification.');
      expect(messageRes.body.text).toContain('Daily planning reminder');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'notifications.summary',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'message',
          },
          readModel: {
            capabilityId: 'notifications.summary',
            domain: 'notifications',
            data: {
              unreadCount: 1,
              actionRequiredCount: 1,
            },
          },
        },
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousReads === undefined) {
        delete process.env.CHAT_CORE_V2_READS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_READS_ENABLED = previousReads;
      }
    }
  });

  it('returns a Chat Core v2 notification-snooze preview with entity preconditions without mutating the notification', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    try {
      const { createNotificationIntent, listNotificationCenterItems } = await import('../../src/services/notification-orchestrator');
      await createNotificationIntent({
        userId: 7001,
        tenantId: 7001,
        sourceSkill: 'system',
        type: 'reminder',
        priority: 'active',
        title: 'Daily planning reminder',
        body: 'Review today before the afternoon starts.',
        actionButtons: [{ id: 'open', label: 'Open', style: 'primary' }],
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'standard',
        dedupeKey: 'chat-core-v2-notification-snooze-preview',
      });
      const item = listNotificationCenterItems(7001, 7001, { status: 'unread', limit: 5 })[0];
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Snooze the Daily planning reminder notification for 30 minutes',
        clientMessageId: 'chat-core-v2-notification-snooze-preview-1',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-command-preview');
      expect(messageRes.body.domain).toBe('secretary');
      expect(messageRes.body.text).toBe('I would snooze "Daily planning reminder" for 30 minutes.');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        chatCoreV2: {
          capabilityId: 'notifications.snooze',
          executionEnabled: false,
          executionDisabledReason: 'preview_only_rollout',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['preview_only_rollout']),
          },
          command: {
            commandSchemaVersion: 'notifications.snooze@1.0.0',
            previewSchemaVersion: 'notification_preview_card@1.0.0',
            responseSchemaVersion: 'chat_response_v2@1.0.0',
            domain: 'notifications',
            commandType: 'notifications.snooze',
            origin: 'chat',
            payload: {
              operation: 'snooze',
              notificationId: item.itemId,
              title: 'Daily planning reminder',
              currentStatus: 'unread',
              targetStatus: 'snoozed',
              snoozeMinutes: 30,
            },
            basedOn: {
              entityIds: [`notification:${item.itemId}`],
              entityVersions: {
                [`notification:${item.itemId}`]: expect.stringMatching(/^[0-9a-f]{16}$/),
              },
            },
            preconditions: {
              requiredEntityVersions: {
                [`notification:${item.itemId}`]: expect.stringMatching(/^[0-9a-f]{16}$/),
              },
              invariants: [{
                type: 'notification_status',
                description: 'Notification must still be snooze-eligible when the preview is confirmed.',
                check: 'notification_is_snooze_eligible',
              }],
              hasPermissionSnapshot: true,
            },
          },
          gate: {
            ok: true,
            operation: 'preview',
            commandStatus: 'previewed',
          },
        },
      });
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        type: 'notification_preview_card',
        title: 'Snooze preview: Daily planning reminder',
        primaryAction: {
          kind: 'view',
          label: 'View',
        },
        secondaryActions: [],
        diff: [
          { label: 'Notification', after: 'Daily planning reminder' },
          { label: 'Status', before: 'Unread', after: 'Snoozed' },
          { label: 'Until', after: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
        ],
      });
      expect(messageRes.body.responseCards).toEqual([{
        kind: 'notificationCard',
        notificationId: item.itemId,
        title: 'Daily planning reminder',
        detail: 'I would snooze "Daily planning reminder" for 30 minutes.',
      }]);
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0].confirmationToken).toBeUndefined();
      const metadataJson = JSON.stringify(messageRes.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');
      expect(listNotificationCenterItems(7001, 7001, { status: 'unread', limit: 5 })[0]).toMatchObject({
        itemId: item.itemId,
        status: 'unread',
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
    }
  });

  it('confirms a Chat Core v2 notification-snooze command through the v2 command bus and replays idempotently', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    const previousConfirmations = process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';
    try {
      const { createNotificationIntent, listNotificationCenterItems } = await import('../../src/services/notification-orchestrator');
      await createNotificationIntent({
        userId: 7001,
        tenantId: 7001,
        sourceSkill: 'system',
        type: 'reminder',
        priority: 'active',
        title: 'Daily planning reminder',
        body: 'Review today before the afternoon starts.',
        actionButtons: [{ id: 'open', label: 'Open', style: 'primary' }],
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'standard',
        dedupeKey: 'chat-core-v2-notification-snooze-confirm',
      });
      const item = listNotificationCenterItems(7001, 7001, { status: 'unread', limit: 5 })[0];
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const preview = await dispatch('POST', '/message', 7001, {
        text: 'Snooze the Daily planning reminder notification for 30 minutes',
        clientMessageId: 'chat-core-v2-notification-snooze-confirm-1',
      });

      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
      expect(preview.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        pendingConfirmation: {
          kind: 'pending_confirmation',
          intent_class: 'notifications.snooze',
          confirmation_token: expect.any(String),
        },
        chatCoreV2: {
          capabilityId: 'notifications.snooze',
          executionEnabled: true,
          response: {
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['confirmation_required']),
          },
        },
      });
      expect(preview.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        primaryAction: {
          kind: 'confirm',
          confirmationToken: preview.body.metadata.pendingConfirmation.confirmation_token,
        },
      });
      expect(listNotificationCenterItems(7001, 7001, { status: 'unread', limit: 5 })[0]).toMatchObject({
        itemId: item.itemId,
        status: 'unread',
        snoozedUntil: null,
      });

      const confirmationBody = {
        confirmation_token: preview.body.metadata.pendingConfirmation.confirmation_token,
        intent_class: 'notifications.snooze',
      };
      const confirmed = await dispatch('POST', '/confirm-action', 7001, confirmationBody);

      expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
      expect(confirmed.body.routeMethod).toBe('chat-core-v2-command-confirmation');
      expect(confirmed.body.text).toBe('Done — I snoozed "Daily planning reminder" for 30 minutes.');
      expect(confirmed.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_result',
        actionStatus: 'verified',
        verificationStatus: 'verified',
        pendingConfirmation: {
          kind: 'completed_confirmation',
          intent_class: 'notifications.snooze',
        },
        chatCoreV2: {
          capabilityId: 'notifications.snooze',
          commandType: 'notifications.snooze',
          status: 'verified',
          response: {
            kind: 'action_result',
            cards: [expect.objectContaining({
              type: 'command_result_card',
              status: 'verified',
            })],
          },
          gate: {
            ok: true,
            operation: 'execute',
            commandStatus: 'confirmed',
          },
        },
      });
      expect(confirmed.body.responseCards).toEqual([{
        kind: 'notificationCard',
        notificationId: item.itemId,
        title: 'Daily planning reminder',
        detail: 'Done — I snoozed "Daily planning reminder" for 30 minutes.',
      }]);
      const updated = listNotificationCenterItems(7001, 7001, { status: 'all', limit: 5 })
        .find((candidate) => candidate.itemId === item.itemId);
      expect(updated).toMatchObject({
        itemId: item.itemId,
        status: 'snoozed',
        snoozedUntil: expect.any(String),
      });
      const metadataJson = JSON.stringify(confirmed.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');

      const replay = await dispatch('POST', '/confirm-action', 7001, confirmationBody);
      expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.metadata).toMatchObject({
        idempotentReplay: true,
        confirmationReplay: true,
      });
      const snoozedRows = listNotificationCenterItems(7001, 7001, { status: 'snoozed', limit: 5 })
        .filter((candidate) => candidate.itemId === item.itemId);
      expect(snoozedRows).toHaveLength(1);
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
      if (previousConfirmations === undefined) {
        delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = previousConfirmations;
      }
    }
  });

  it('confirms a Chat Core v2 notification-snooze command after the notification is read', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    const previousConfirmations = process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';
    try {
      const { createNotificationIntent, listNotificationCenterItems } = await import('../../src/services/notification-orchestrator');
      await createNotificationIntent({
        userId: 7001,
        tenantId: 7001,
        sourceSkill: 'system',
        type: 'reminder',
        priority: 'active',
        title: 'Daily planning reminder',
        body: 'Review today before the afternoon starts.',
        actionButtons: [{ id: 'open', label: 'Open', style: 'primary' }],
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'standard',
        dedupeKey: 'chat-core-v2-notification-snooze-stale',
      });
      const item = listNotificationCenterItems(7001, 7001, { status: 'unread', limit: 5 })[0];

      const preview = await dispatch('POST', '/message', 7001, {
        text: 'Snooze the Daily planning reminder notification for 30 minutes',
        clientMessageId: 'chat-core-v2-notification-snooze-stale-1',
      });
      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
      expect(preview.body.metadata.pendingConfirmation.confirmation_token).toEqual(expect.any(String));

      testDb.prepare(`
        UPDATE notification_center_items
        SET status = 'read', read_at = datetime('now')
        WHERE item_id = ? AND user_id = ? AND tenant_id = ?
      `).run(item.itemId, 7001, 7001);

      const confirmed = await dispatch('POST', '/confirm-action', 7001, {
        confirmation_token: preview.body.metadata.pendingConfirmation.confirmation_token,
        intent_class: 'notifications.snooze',
      });

      expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
      expect(confirmed.body.routeMethod).toBe('chat-core-v2-command-confirmation');
      expect(confirmed.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_result',
        actionStatus: 'verified',
        verificationStatus: 'verified',
        chatCoreV2: {
          capabilityId: 'notifications.snooze',
          commandType: 'notifications.snooze',
          status: 'verified',
        },
      });
      const updated = listNotificationCenterItems(7001, 7001, { status: 'all', limit: 5 })
        .find((candidate) => candidate.itemId === item.itemId);
      expect(updated).toMatchObject({
        itemId: item.itemId,
        status: 'snoozed',
        snoozedUntil: expect.any(String),
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
      if (previousConfirmations === undefined) {
        delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = previousConfirmations;
      }
    }
  });

  it('rejects a stale Chat Core v2 notification-snooze confirmation after the notification is dismissed', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    const previousConfirmations = process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';
    try {
      const { createNotificationIntent, listNotificationCenterItems } = await import('../../src/services/notification-orchestrator');
      await createNotificationIntent({
        userId: 7001,
        tenantId: 7001,
        sourceSkill: 'system',
        type: 'reminder',
        priority: 'active',
        title: 'Daily planning reminder',
        body: 'Review today before the afternoon starts.',
        actionButtons: [{ id: 'open', label: 'Open', style: 'primary' }],
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'standard',
        dedupeKey: 'chat-core-v2-notification-snooze-dismissed-stale',
      });
      const item = listNotificationCenterItems(7001, 7001, { status: 'unread', limit: 5 })[0];

      const preview = await dispatch('POST', '/message', 7001, {
        text: 'Snooze the Daily planning reminder notification for 30 minutes',
        clientMessageId: 'chat-core-v2-notification-snooze-dismissed-stale-1',
      });
      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
      expect(preview.body.metadata.pendingConfirmation.confirmation_token).toEqual(expect.any(String));

      testDb.prepare(`
        UPDATE notification_center_items
        SET status = 'dismissed', dismissed_at = datetime('now')
        WHERE item_id = ? AND user_id = ? AND tenant_id = ?
      `).run(item.itemId, 7001, 7001);

      const confirmed = await dispatch('POST', '/confirm-action', 7001, {
        confirmation_token: preview.body.metadata.pendingConfirmation.confirmation_token,
        intent_class: 'notifications.snooze',
      });

      expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(409);
      expect(confirmed.body.error).toMatchObject({
        code: 'CHAT_CORE_V2_CONFIRMATION_NOT_EXECUTABLE',
        message: 'This preview is no longer safe to apply. Please ask again so I can refresh it.',
      });
      const updated = listNotificationCenterItems(7001, 7001, { status: 'all', limit: 5 })
        .find((candidate) => candidate.itemId === item.itemId);
      expect(updated).toMatchObject({
        itemId: item.itemId,
        status: 'dismissed',
        snoozedUntil: null,
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
      if (previousConfirmations === undefined) {
        delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = previousConfirmations;
      }
    }
  });

  it('returns a Chat Core v2 decision-dismiss preview with entity preconditions without dismissing the decision', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    try {
      const {
        buildSkillDecisionFixtureIntent,
        createDecisionIntent,
        getDecisionItem,
        listDecisionItems,
      } = await import('../../src/services/decision-center');
      const { createContentWorkflowObject } = await import('../../src/services/content-editorial-workflow');
      const object = createContentWorkflowObject({
        userId: 7001,
        tenantId: 7001,
        objectType: 'script',
        title: 'Quarterly planning cleanup decision',
        editorialState: 'drafted',
      });
      const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', 7001, {
        tenantId: 7001,
        relatedEntityId: object.id,
        relatedEntityType: 'content_workflow_object',
        title: 'Quarterly planning cleanup decision',
        body: 'Quarterly planning cleanup decision needs input before the day plan changes.',
        safePreviewTitle: 'Quarterly planning cleanup decision',
        safePreviewBody: 'Quarterly planning cleanup decision needs input before the day plan changes.',
        actionButtons: [{ id: 'approve_script', label: 'Approve', style: 'primary' }],
        dedupeKey: 'chat-core-v2-decision-dismiss-preview',
        decisionContext: {
          entityTitle: 'Quarterly planning cleanup decision',
          sourceState: 'needs_user_input',
        },
      }));
      const item = created.item!;
      expect(item).toMatchObject({
        title: 'Content review',
        status: 'unread',
      });
      expect(listDecisionItems(7001, 7001, { limit: 50 }).map((decision) => decision.decisionId)).toContain(item.decisionId);
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Dismiss the Content review decision',
        clientMessageId: 'chat-core-v2-decision-dismiss-preview-1',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-command-preview');
      expect(messageRes.body.domain).toBe('secretary');
      expect(messageRes.body.text).toBe('I would dismiss "Content review" from Decision Center. Nothing else would change.');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        chatCoreV2: {
          capabilityId: 'decision_center.dismiss',
          executionEnabled: false,
          executionDisabledReason: 'preview_only_rollout',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['preview_only_rollout']),
          },
          command: {
            commandSchemaVersion: 'decision_center.dismiss@1.0.0',
            previewSchemaVersion: 'decision_preview_card@1.0.0',
            responseSchemaVersion: 'chat_response_v2@1.0.0',
            domain: 'decision_center',
            commandType: 'decision_center.dismiss',
            origin: 'chat',
            payload: {
              operation: 'dismiss',
              decisionId: item.decisionId,
              title: 'Content review',
              currentStatus: 'unread',
              targetStatus: 'dismissed',
            },
            basedOn: {
              entityIds: [`decision:${item.decisionId}`],
              entityVersions: {
                [`decision:${item.decisionId}`]: expect.stringMatching(/^[0-9a-f]{16}$/),
              },
            },
            preconditions: {
              requiredEntityVersions: {
                [`decision:${item.decisionId}`]: expect.stringMatching(/^[0-9a-f]{16}$/),
              },
              invariants: [{
                type: 'decision_status',
                description: 'Decision must still be dismissible when the preview is confirmed.',
                check: 'decision_is_active',
              }],
              hasPermissionSnapshot: true,
              hasDecisionSnapshot: true,
            },
          },
          gate: {
            ok: true,
            operation: 'preview',
            commandStatus: 'previewed',
          },
        },
      });
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        type: 'decision_preview_card',
        title: 'Dismiss preview: Content review',
        primaryAction: {
          kind: 'view',
          label: 'View',
        },
        secondaryActions: [],
        diff: [
          { label: 'Decision', after: 'Content review' },
          { label: 'Status', before: 'Active', after: 'Dismissed' },
          { label: 'Effect', after: 'Remove from active queue' },
        ],
      });
      expect(messageRes.body.responseCards).toEqual([{
        kind: 'decisionCard',
        decisionId: item.decisionId,
        status: 'pending',
        detail: 'I would dismiss "Content review" from Decision Center. Nothing else would change.',
      }]);
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0].confirmationToken).toBeUndefined();
      const metadataJson = JSON.stringify(messageRes.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');
      expect(getDecisionItem(item.decisionId, 7001, 7001)).toMatchObject({
        decisionId: item.decisionId,
        status: 'unread',
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
    }
  });

  it('confirms a Chat Core v2 decision-dismiss command through the v2 command bus and replays idempotently', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    const previousConfirmations = process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';
    try {
      const {
        createDecisionIntent,
        getDecisionItem,
        listDecisionItems,
      } = await import('../../src/services/decision-center');
      const created = await createDecisionIntent({
        userId: 7001,
        tenantId: 7001,
        sourceSkill: 'system',
        type: 'decision_required',
        priority: 'active',
        title: 'Schedule review',
        body: 'The schedule review needs a decision.',
        safePreviewTitle: 'Schedule review',
        safePreviewBody: 'The schedule review needs a decision.',
        relatedEntityId: 'chat-core-v2-decision-dismiss-confirm',
        relatedEntityType: 'chat_core_v2_decision',
        actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
        requiresUserAction: true,
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'standard',
        dedupeKey: 'chat-core-v2-decision-dismiss-confirm',
      });
      const item = created.item;
      expect(item).not.toBeNull();
      expect(getDecisionItem(item.decisionId, 7001, 7001)).toMatchObject({
        decisionId: item.decisionId,
        status: 'unread',
      });
      expect(listDecisionItems(7001, 7001, { limit: 50 }).map((decision) => decision.title))
        .toContain('Schedule review');
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const preview = await dispatch('POST', '/message', 7001, {
        text: 'Dismiss the decision called Schedule review',
        clientMessageId: 'chat-core-v2-decision-dismiss-confirm-1',
      });

      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
      expect(preview.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        pendingConfirmation: {
          kind: 'pending_confirmation',
          intent_class: 'decision_center.dismiss',
          confirmation_token: expect.any(String),
        },
        chatCoreV2: {
          capabilityId: 'decision_center.dismiss',
          executionEnabled: true,
          response: {
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['confirmation_required']),
          },
        },
      });
      expect(preview.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        primaryAction: {
          kind: 'confirm',
          confirmationToken: preview.body.metadata.pendingConfirmation.confirmation_token,
        },
      });
      expect(getDecisionItem(item.decisionId, 7001, 7001)).toMatchObject({
        decisionId: item.decisionId,
        status: 'unread',
      });

      const confirmationBody = {
        confirmation_token: preview.body.metadata.pendingConfirmation.confirmation_token,
        intent_class: 'decision_center.dismiss',
      };
      const confirmed = await dispatch('POST', '/confirm-action', 7001, confirmationBody);

      expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
      expect(confirmed.body.routeMethod).toBe('chat-core-v2-command-confirmation');
      expect(confirmed.body.text).toBe('Done — I dismissed "Schedule review" from Decision Center.');
      expect(confirmed.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_result',
        actionStatus: 'verified',
        verificationStatus: 'verified',
        pendingConfirmation: {
          kind: 'completed_confirmation',
          intent_class: 'decision_center.dismiss',
        },
        chatCoreV2: {
          capabilityId: 'decision_center.dismiss',
          commandType: 'decision_center.dismiss',
          status: 'verified',
          response: {
            kind: 'action_result',
            cards: [expect.objectContaining({
              type: 'command_result_card',
              status: 'verified',
            })],
          },
          gate: {
            ok: true,
            operation: 'execute',
            commandStatus: 'confirmed',
          },
        },
      });
      expect(confirmed.body.responseCards).toEqual([{
        kind: 'decisionCard',
        decisionId: item.decisionId,
        status: 'dismissed',
        detail: 'Done — I dismissed "Schedule review" from Decision Center.',
      }]);
      expect(getDecisionItem(item.decisionId, 7001, 7001)).toMatchObject({
        decisionId: item.decisionId,
        status: 'dismissed',
      });
      expect(listDecisionItems(7001, 7001, { limit: 50 }).map((decision) => decision.decisionId))
        .not.toContain(item.decisionId);
      const metadataJson = JSON.stringify(confirmed.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');

      const replay = await dispatch('POST', '/confirm-action', 7001, confirmationBody);
      expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.metadata).toMatchObject({
        idempotentReplay: true,
        confirmationReplay: true,
      });
      expect(getDecisionItem(item.decisionId, 7001, 7001)).toMatchObject({
        decisionId: item.decisionId,
        status: 'dismissed',
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
      if (previousConfirmations === undefined) {
        delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = previousConfirmations;
      }
    }
  });

  it('confirms a Chat Core v2 decision-dismiss command after the decision is read', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    const previousConfirmations = process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';
    try {
      const {
        createDecisionIntent,
        getDecisionItem,
        markDecisionViewed,
      } = await import('../../src/services/decision-center');
      const created = await createDecisionIntent({
        userId: 7001,
        tenantId: 7001,
        sourceSkill: 'system',
        type: 'decision_required',
        priority: 'active',
        title: 'Read then dismiss review',
        body: 'The read then dismiss review needs a decision.',
        safePreviewTitle: 'Read then dismiss review',
        safePreviewBody: 'The read then dismiss review needs a decision.',
        relatedEntityId: 'chat-core-v2-decision-dismiss-read-confirm',
        relatedEntityType: 'chat_core_v2_decision',
        actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
        requiresUserAction: true,
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'standard',
        dedupeKey: 'chat-core-v2-decision-dismiss-read-confirm',
      });
      const item = created.item;
      expect(item).not.toBeNull();

      const preview = await dispatch('POST', '/message', 7001, {
        text: 'Dismiss the decision called Read then dismiss review',
        clientMessageId: 'chat-core-v2-decision-dismiss-read-confirm-1',
      });
      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
      expect(preview.body.metadata.pendingConfirmation.confirmation_token).toEqual(expect.any(String));

      markDecisionViewed(item.decisionId, 7001, 7001);
      expect(getDecisionItem(item.decisionId, 7001, 7001)).toMatchObject({
        decisionId: item.decisionId,
        status: 'read',
      });

      const confirmed = await dispatch('POST', '/confirm-action', 7001, {
        confirmation_token: preview.body.metadata.pendingConfirmation.confirmation_token,
        intent_class: 'decision_center.dismiss',
      });

      expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
      expect(confirmed.body.routeMethod).toBe('chat-core-v2-command-confirmation');
      expect(confirmed.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_result',
        actionStatus: 'verified',
        verificationStatus: 'verified',
        chatCoreV2: {
          capabilityId: 'decision_center.dismiss',
          commandType: 'decision_center.dismiss',
          status: 'verified',
        },
      });
      expect(getDecisionItem(item.decisionId, 7001, 7001)).toMatchObject({
        decisionId: item.decisionId,
        status: 'dismissed',
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
      if (previousConfirmations === undefined) {
        delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = previousConfirmations;
      }
    }
  });

  it('rejects a stale Chat Core v2 decision-dismiss confirmation before mutating the decision again', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    const previousConfirmations = process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';
    try {
      const {
        createDecisionIntent,
        dismissDecision,
        getDecisionItem,
        listDecisionItems,
      } = await import('../../src/services/decision-center');
      const created = await createDecisionIntent({
        userId: 7001,
        tenantId: 7001,
        sourceSkill: 'system',
        type: 'decision_required',
        priority: 'active',
        title: 'Schedule review',
        body: 'The schedule review needs a decision.',
        safePreviewTitle: 'Schedule review',
        safePreviewBody: 'The schedule review needs a decision.',
        relatedEntityId: 'chat-core-v2-decision-dismiss-stale',
        relatedEntityType: 'chat_core_v2_decision',
        actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
        requiresUserAction: true,
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'standard',
        dedupeKey: 'chat-core-v2-decision-dismiss-stale',
      });
      const item = created.item;
      expect(item).not.toBeNull();
      expect(listDecisionItems(7001, 7001, { limit: 50 }).map((decision) => decision.title))
        .toContain('Schedule review');

      const preview = await dispatch('POST', '/message', 7001, {
        text: 'Dismiss the decision called Schedule review',
        clientMessageId: 'chat-core-v2-decision-dismiss-stale-1',
      });
      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
      expect(preview.body.metadata.pendingConfirmation.confirmation_token).toEqual(expect.any(String));

      dismissDecision(item.decisionId, 7001, 7001);

      const confirmed = await dispatch('POST', '/confirm-action', 7001, {
        confirmation_token: preview.body.metadata.pendingConfirmation.confirmation_token,
        intent_class: 'decision_center.dismiss',
      });

      expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(409);
      expect(confirmed.body.error).toMatchObject({
        code: 'CHAT_CORE_V2_CONFIRMATION_NOT_EXECUTABLE',
        message: 'This preview is no longer safe to apply. Please ask again so I can refresh it.',
      });
      expect(getDecisionItem(item.decisionId, 7001, 7001)).toMatchObject({
        decisionId: item.decisionId,
        status: 'dismissed',
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
      if (previousConfirmations === undefined) {
        delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = previousConfirmations;
      }
    }
  });

  it('rejects a Chat Core v2 decision-dismiss confirmation when decision content changed after preview', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousWrites = process.env.CHAT_CORE_V2_WRITES_ENABLED;
    const previousConfirmations = process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_WRITES_ENABLED = 'true';
    process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = 'true';
    try {
      const {
        createDecisionIntent,
        getDecisionItem,
      } = await import('../../src/services/decision-center');
      const created = await createDecisionIntent({
        userId: 7001,
        tenantId: 7001,
        sourceSkill: 'system',
        type: 'decision_required',
        priority: 'active',
        title: 'Versioned schedule review',
        body: 'The versioned schedule review needs a decision.',
        safePreviewTitle: 'Versioned schedule review',
        safePreviewBody: 'The versioned schedule review needs a decision.',
        relatedEntityId: 'chat-core-v2-decision-dismiss-version-stale',
        relatedEntityType: 'chat_core_v2_decision',
        actionButtons: [{ id: 'open_detail', label: 'Review', style: 'primary' }],
        requiresUserAction: true,
        deliveryPolicy: 'in_app_only',
        privacyPolicy: 'standard',
        dedupeKey: 'chat-core-v2-decision-dismiss-version-stale',
      });
      const item = created.item;
      expect(item).not.toBeNull();

      const preview = await dispatch('POST', '/message', 7001, {
        text: 'Dismiss the decision called Versioned schedule review',
        clientMessageId: 'chat-core-v2-decision-dismiss-version-stale-1',
      });
      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(202);
      expect(preview.body.metadata.pendingConfirmation.confirmation_token).toEqual(expect.any(String));

      testDb.prepare(`
        UPDATE notification_center_items
        SET title = ?, safe_body = ?
        WHERE item_id = ? AND user_id = ? AND tenant_id = ?
      `).run(
        'Versioned schedule review changed',
        'The versioned schedule review changed after preview.',
        item.decisionId,
        7001,
        7001,
      );

      const confirmed = await dispatch('POST', '/confirm-action', 7001, {
        confirmation_token: preview.body.metadata.pendingConfirmation.confirmation_token,
        intent_class: 'decision_center.dismiss',
      });

      expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(409);
      expect(confirmed.body.error).toMatchObject({
        code: 'CHAT_CORE_V2_CONFIRMATION_NOT_EXECUTABLE',
        message: 'This preview is no longer safe to apply. Please ask again so I can refresh it.',
      });
      expect(getDecisionItem(item.decisionId, 7001, 7001)).toMatchObject({
        decisionId: item.decisionId,
        title: 'Versioned schedule review changed',
        status: 'unread',
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousWrites === undefined) {
        delete process.env.CHAT_CORE_V2_WRITES_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_WRITES_ENABLED = previousWrites;
      }
      if (previousConfirmations === undefined) {
        delete process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_CONFIRMATIONS_ENABLED = previousConfirmations;
      }
    }
  });

  it('returns a Chat Core v2 cooking grocery preview without mutating the shopping list', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousPreviews = process.env.CHAT_CORE_V2_PREVIEWS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_PREVIEWS_ENABLED = 'true';
    try {
      const { getShoppingList } = await import('../../src/services/cooking-chef');
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Add eggs and milk to my grocery list',
        clientMessageId: 'chat-core-v2-cooking-grocery-preview-1',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
      const groceryWeekStart = messageRes.body.metadata?.chatCoreV2?.command?.payload?.weekStart;
      expect(groceryWeekStart).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-command-preview');
      expect(messageRes.body.domain).toBe('secretary');
      expect(messageRes.body.text).toBe('I would prepare eggs and milk for the grocery list. Nothing would be added yet.');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        chatCoreV2: {
          capabilityId: 'cooking.grocery_item_preview',
          executionEnabled: false,
          executionDisabledReason: 'preview_only_rollout',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['preview_only_rollout']),
          },
          command: {
            commandSchemaVersion: 'cooking.grocery_item@1.0.0',
            previewSchemaVersion: 'grocery_preview_card@1.0.0',
            responseSchemaVersion: 'chat_response_v2@1.0.0',
            domain: 'cooking',
            commandType: 'cooking.grocery_item',
            origin: 'chat',
            payload: {
              operation: 'add_items',
              items: ['eggs', 'milk'],
              itemCount: 2,
              weekStart: groceryWeekStart,
              list: 'grocery',
            },
            basedOn: {
              entityIds: [expect.stringMatching(/^cooking_grocery_draft:cmd_[0-9a-f]{16}$/)],
              entityVersions: {},
            },
            preconditions: {
              requiredEntityVersions: {},
              invariants: [{
                type: 'preview_only',
                description: 'Grocery item previews do not mutate the shopping list in this rollout.',
                check: 'cooking_grocery_preview_only',
              }],
              hasPermissionSnapshot: true,
            },
          },
          gate: {
            ok: true,
            operation: 'preview',
            commandStatus: 'previewed',
          },
        },
      });
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        type: 'grocery_preview_card',
        title: 'Grocery preview: eggs and milk',
        primaryAction: {
          kind: 'view',
          label: 'View',
        },
        secondaryActions: [],
        diff: [
          { label: 'Items', after: 'eggs and milk' },
          { label: 'List', after: 'Grocery' },
          { label: 'Status', after: 'Preview' },
        ],
      });
      expect(messageRes.body.responseCards).toEqual([{
        kind: 'groceryListCard',
        weekStart: groceryWeekStart,
        items: ['eggs', 'milk'],
      }]);
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0].confirmationToken).toBeUndefined();
      const metadataJson = JSON.stringify(messageRes.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');
      expect(getShoppingList(7001, groceryWeekStart, 7001)).toBeNull();
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousPreviews === undefined) {
        delete process.env.CHAT_CORE_V2_PREVIEWS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_PREVIEWS_ENABLED = previousPreviews;
      }
    }
  });

  it('returns a Chat Core v2 content brief preview without calling the content generator', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousPreviews = process.env.CHAT_CORE_V2_PREVIEWS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_PREVIEWS_ENABLED = 'true';
    try {
      const { handleContent } = await import('../../src/domains/content-creator');
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();
      mockGetScript.mockClear();
      vi.mocked(handleContent).mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Create a content brief about recovery after hard intervals',
        clientMessageId: 'chat-core-v2-content-brief-preview-1',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-command-preview');
      expect(messageRes.body.domain).toBe('secretary');
      expect(messageRes.body.text).toBe('I would prepare a content brief about recovery after hard intervals. Nothing would be created or published yet.');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        chatCoreV2: {
          capabilityId: 'content.brief_draft_preview',
          executionEnabled: false,
          executionDisabledReason: 'preview_only_rollout',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['preview_only_rollout']),
          },
          command: {
            commandSchemaVersion: 'content.brief_draft@1.0.0',
            previewSchemaVersion: 'content_brief_preview_card@1.0.0',
            responseSchemaVersion: 'chat_response_v2@1.0.0',
            domain: 'content',
            commandType: 'content.brief_draft',
            origin: 'chat',
            payload: {
              operation: 'draft_brief',
              topic: 'recovery after hard intervals',
              objective: 'Prepare a content brief about recovery after hard intervals.',
              format: 'content',
              status: 'preview',
            },
            basedOn: {
              entityIds: [expect.stringMatching(/^content_brief_draft:cmd_[0-9a-f]{16}$/)],
              entityVersions: {},
            },
            preconditions: {
              requiredEntityVersions: {},
              invariants: [{
                type: 'preview_only',
                description: 'Content brief previews do not create drafts, scripts, or publishable content in this rollout.',
                check: 'content_brief_preview_only',
              }],
              hasPermissionSnapshot: true,
            },
          },
          gate: {
            ok: true,
            operation: 'preview',
            commandStatus: 'previewed',
          },
        },
      });
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        type: 'content_brief_preview_card',
        title: 'Content brief preview: recovery after hard intervals',
        primaryAction: {
          kind: 'view',
          label: 'View',
        },
        secondaryActions: [],
        diff: [
          { label: 'Topic', after: 'recovery after hard intervals' },
          { label: 'Format', after: 'Content' },
          { label: 'Status', after: 'Preview' },
        ],
      });
      expect(messageRes.body.responseCards).toEqual([{
        kind: 'openSurfaceCard',
        surface: 'content',
        pendingActionId: null,
        prefill: {
          kind: 'content_brief_preview',
          topic: 'recovery after hard intervals',
          format: 'content',
          objective: 'Prepare a content brief about recovery after hard intervals.',
        },
      }]);
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0].confirmationToken).toBeUndefined();
      const metadataJson = JSON.stringify(messageRes.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');
      expect(mockGetScript).not.toHaveBeenCalled();
      expect(vi.mocked(handleContent)).not.toHaveBeenCalled();
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousPreviews === undefined) {
        delete process.env.CHAT_CORE_V2_PREVIEWS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_PREVIEWS_ENABLED = previousPreviews;
      }
    }
  });

  it('returns a Chat Core v2 training lighter-session preview without mutating the plan', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousPreviews = process.env.CHAT_CORE_V2_PREVIEWS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_PREVIEWS_ENABLED = 'true';
    try {
      const planStart = currentMondayIso();
      const targetDate = addIsoDays(todayIsoInTestTimezone(), 1);
      const targetWeekNumber = Math.floor(daysBetweenIsoDates(planStart, targetDate) / 7) + 1;
      const targetDayOfWeek = weekdayNameForIsoDate(targetDate);
      const targetDateLabel = shortDateLabelForIsoDate(targetDate);
      mockGetActivePlan.mockReturnValue({
        id: 101,
        user_id: 7001,
        tenant_id: 7001,
        name: 'Strength Base',
        sport: 'strength',
        goal: 'Build strength',
        duration_weeks: 4,
        periodization: 'linear',
        status: 'active',
        start_date: planStart,
        end_date: addIsoDays(planStart, 27),
        preferences_json: null,
        plan_version: 1,
        created_at: '2026-05-20T09:00:00.000Z',
        updated_at: '2026-05-20T09:00:00.000Z',
      });
      mockGetWeeksForPlan.mockReturnValue([{
        id: 201,
        plan_id: 101,
        week_number: targetWeekNumber,
        focus: 'Base strength',
        intensity_pct: 80,
        volume_sessions: 3,
        notes: null,
        auto_adjusted: 0,
        adjustment_reason: null,
        created_at: '2026-05-25T00:00:00.000Z',
      }]);
      mockGetSessionsForWeek.mockReturnValue([{
        id: 301,
        week_id: 201,
        plan_id: 101,
        tenant_id: 7001,
        day_of_week: targetDayOfWeek,
        session_type: 'strength',
        title: 'Lower-body strength',
        description: 'Private training instructions',
        description_json: null,
        exercises_json: '[{"name":"Private lift"}]',
        duration_minutes: 55,
        intensity_text: 'hard',
        calendar_event_id: 'evt_private_training',
        calendar_source: 'google',
        session_identity_key: 'week1_strength1',
        session_shape_hash: 'shape_training_1',
        preferred_time_unavailable: 0,
        status: 'scheduled',
        created_at: '2026-05-20T09:00:00.000Z',
        updated_at: '2026-05-20T09:00:00.000Z',
      }]);
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Make tomorrow workout lighter',
        clientMessageId: 'chat-core-v2-training-preview-1',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(202);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-command-preview');
      expect(messageRes.body.domain).toBe('secretary');
      expect(messageRes.body.text).toContain('Your training plan would not change yet.');
      expect(messageRes.body.text).not.toContain('Private training instructions');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('Private lift');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('evt_private_training');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_command_preview',
        chatCoreV2: {
          capabilityId: 'training.modify_session_preview',
          executionEnabled: false,
          executionDisabledReason: 'preview_only_rollout',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'action_preview',
            reasonCodes: expect.arrayContaining(['preview_only_rollout']),
          },
          command: {
            commandSchemaVersion: 'training.modify_session@1.0.0',
            previewSchemaVersion: 'training_change_preview_card@1.0.0',
            responseSchemaVersion: 'chat_response_v2@1.0.0',
            domain: 'training',
            commandType: 'training.modify_session',
            origin: 'chat',
            payload: {
              operation: 'modify_session',
              changeType: 'reduce_intensity',
              sessionId: 301,
              planId: 101,
              weekId: 201,
              title: 'Lower-body strength',
              dayOfWeek: targetDayOfWeek,
              sessionDate: targetDate,
              sessionDateLabel: targetDateLabel,
              currentIntensity: 'hard',
              targetIntensity: 'easier',
              status: 'preview',
            },
            basedOn: {
              entityIds: ['training_session:301', 'training_plan:101'],
              entityVersions: {
                'training_session:301': expect.stringMatching(/^[0-9a-f]{16}$/),
                'training_plan:101': expect.stringMatching(/^[0-9a-f]{16}$/),
              },
            },
            preconditions: {
              requiredEntityVersions: {
                'training_session:301': expect.stringMatching(/^[0-9a-f]{16}$/),
                'training_plan:101': expect.stringMatching(/^[0-9a-f]{16}$/),
              },
              invariants: expect.arrayContaining([{
                type: 'preview_only',
                description: 'Training session modification previews do not change the plan in this rollout.',
                check: 'training_modify_session_preview_only',
              }]),
              hasPermissionSnapshot: true,
            },
          },
          gate: {
            ok: true,
            operation: 'preview',
            commandStatus: 'previewed',
          },
        },
      });
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0]).toMatchObject({
        type: 'training_change_preview_card',
        title: 'Training preview: Lower-body strength',
        sensitivity: 'health_adjacent',
        primaryAction: {
          kind: 'view',
          label: 'View',
        },
        secondaryActions: [],
        diff: expect.arrayContaining([
          { label: 'Session', after: 'Lower-body strength' },
          { label: 'Intensity', before: 'hard', after: 'Easier' },
          { label: 'Status', after: 'Preview' },
        ]),
      });
      expect(messageRes.body.responseCards).toEqual([{
        kind: 'trainingSessionCard',
        sessionId: '301',
        title: 'Lower-body strength',
        dateLabel: targetDateLabel,
        summary: [{
          kind: 'paragraph',
          text: expect.stringContaining('Your training plan would not change yet.'),
        }],
      }]);
      expect(messageRes.body.metadata.chatCoreV2.response.cards[0].confirmationToken).toBeUndefined();
      const metadataJson = JSON.stringify(messageRes.body.metadata);
      expect(metadataJson).not.toContain('actorUserId');
      expect(metadataJson).not.toContain('delegatedScopes');
      expect(metadataJson).not.toContain('idempotencyKey');
      expect(metadataJson).not.toContain('chat-v2-permissions:7001:7001');
      expect(mockGetActivePlan).toHaveBeenCalledWith(7001, 7001);
      expect(mockGetWeeksForPlan).toHaveBeenCalledWith(101);
      expect(mockGetSessionsForWeek).toHaveBeenCalledWith(201);
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousPreviews === undefined) {
        delete process.env.CHAT_CORE_V2_PREVIEWS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_PREVIEWS_ENABLED = previousPreviews;
      }
    }
  });

  it('answers connection status through Chat Core v2 deterministic reads when explicitly enabled', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousReads = process.env.CHAT_CORE_V2_READS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_READS_ENABLED = 'true';
    try {
      testDb.prepare(`
        INSERT INTO garmin_user_tokens (
          user_id,
          garmin_email,
          tokens_json,
          status,
          last_refresh,
          last_used,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        7001,
        'athlete@example.com',
        JSON.stringify({ oauth1: { token: 'test-oauth1' }, oauth2: { token: 'test-oauth2' } }),
        'active',
        '2026-04-15T09:00:00.000Z',
        '2026-04-15T09:00:00.000Z',
        '2026-04-15T09:00:00.000Z',
        '2026-04-15T09:00:00.000Z',
      );
      testDb.prepare(`
        INSERT INTO garmin_sessions (
          user_id,
          oauth1_token_json,
          oauth2_token_json,
          last_refreshed_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        7001,
        JSON.stringify({ token: 'session-oauth1' }),
        JSON.stringify({ token: 'session-oauth2' }),
        '2026-04-15T09:00:00.000Z',
        '2026-04-15T09:00:00.000Z',
        '2026-04-15T09:00:00.000Z',
      );
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'What connections are active?',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-deterministic-read');
      expect(messageRes.body.domain).toBe('connections');
      expect(messageRes.body.text).toContain('Your connections have 1 active integration.');
      expect(messageRes.body.text).toContain('Garmin: connected');
      expect(messageRes.body.text).not.toContain('test-oauth');
      expect(messageRes.body.text).not.toContain('session-oauth');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'connections.status',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'message',
          },
          readModel: {
            capabilityId: 'connections.status',
            domain: 'connections',
            sensitivity: 'credential_adjacent',
            data: {
              connectedCount: 1,
              capabilities: {
                health: true,
              },
            },
          },
        },
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousReads === undefined) {
        delete process.env.CHAT_CORE_V2_READS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_READS_ENABLED = previousReads;
      }
    }
  });

  it('answers Secretary agenda status through Chat Core v2 deterministic reads when explicitly enabled', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousReads = process.env.CHAT_CORE_V2_READS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_READS_ENABLED = 'true';
    try {
      const todayParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Lisbon',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
      const todayPart = (type: string) => todayParts.find((part) => part.type === type)?.value;
      const today = `${todayPart('year')}-${todayPart('month')}-${todayPart('day')}`;
      testDb.prepare(`
        INSERT INTO secretary_agenda_items (
          agenda_item_id,
          source_intent_id,
          source_skill,
          source_action,
          intent_action,
          source_entity_id,
          source_entity_type,
          owner_user_id,
          tenant_id,
          lifecycle_state,
          provider_sync_state,
          provider_event_id,
          provider_source,
          version,
          title,
          start_at,
          end_at,
          duration_minutes,
          decision_action,
          decision_reason_codes_json,
          source_shape_hash,
          scheduled_segments_json,
          cancellation_reason,
          superseded_by_agenda_item_id,
          created_at,
          updated_at,
          completed_at,
          source_created_at,
          source_updated_at
        ) VALUES (
          'agenda-chat-core-v2-today',
          'intent-chat-core-v2-today',
          'content',
          'review',
          'schedule_this',
          'content-brief-1',
          'content_brief',
          7001,
          '7001',
          'scheduled',
          'synced',
          NULL,
          NULL,
          1,
          'Review launch brief',
          ?,
          ?,
          30,
          'scheduled',
          '[]',
          'shape-chat-core-v2-today',
          '[]',
          NULL,
          NULL,
          '2026-04-15T09:00:00.000Z',
          '2026-04-15T09:00:00.000Z',
          NULL,
          NULL,
          NULL
        )
      `).run(`${today}T14:00:00.000Z`, `${today}T14:30:00.000Z`);
      testDb.prepare(`
        INSERT INTO secretary_agenda_items (
          agenda_item_id,
          source_intent_id,
          source_skill,
          source_action,
          intent_action,
          source_entity_id,
          source_entity_type,
          owner_user_id,
          tenant_id,
          lifecycle_state,
          provider_sync_state,
          provider_event_id,
          provider_source,
          version,
          title,
          start_at,
          end_at,
          duration_minutes,
          decision_action,
          decision_reason_codes_json,
          source_shape_hash,
          scheduled_segments_json,
          cancellation_reason,
          superseded_by_agenda_item_id,
          created_at,
          updated_at,
          completed_at,
          source_created_at,
          source_updated_at
        ) VALUES (
          'agenda-chat-core-v2-unscheduled',
          'intent-chat-core-v2-unscheduled',
          'finance',
          'follow_up',
          'create_follow_up',
          'invoice-1',
          'invoice',
          7001,
          '7001',
          'proposed',
          'readback_failed',
          NULL,
          NULL,
          1,
          'Finance follow-up',
          NULL,
          NULL,
          NULL,
          'needs_more_context',
          '[]',
          'shape-chat-core-v2-unscheduled',
          '[]',
          NULL,
          NULL,
          '2026-04-15T09:10:00.000Z',
          '2026-04-15T09:10:00.000Z',
          NULL,
          NULL,
          NULL
        )
      `).run();
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: "What's on my agenda today?",
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-deterministic-read');
      expect(messageRes.body.domain).toBe('secretary');
      expect(messageRes.body.text).toContain('Secretary has 2 active agenda items.');
      expect(messageRes.body.text).toContain('1 for today');
      expect(messageRes.body.text).toContain('1 not timed yet');
      expect(messageRes.body.text).toContain('1 needing verification');
      expect(messageRes.body.text).toContain('Review launch brief');
      expect(messageRes.body.text).toContain('Finance follow-up');
      expect(messageRes.body.text).not.toContain('secretary_agenda_items');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'secretary.agenda_summary',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'message',
          },
          readModel: {
            capabilityId: 'secretary.agenda_summary',
            domain: 'secretary',
            data: {
              activeCount: 2,
              todayCount: 1,
              unscheduledCount: 1,
              providerAttentionCount: 1,
            },
          },
        },
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousReads === undefined) {
        delete process.env.CHAT_CORE_V2_READS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_READS_ENABLED = previousReads;
      }
    }
  });

  it('answers aggregate finance status through Chat Core v2 deterministic reads when explicitly enabled', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousReads = process.env.CHAT_CORE_V2_READS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_READS_ENABLED = 'true';
    try {
      const monthParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Lisbon',
        year: 'numeric',
        month: '2-digit',
      }).formatToParts(new Date());
      const monthPart = (type: string) => monthParts.find((part) => part.type === type)?.value;
      const month = `${monthPart('year')}-${monthPart('month')}`;
      mockGetMonthlySummary.mockReturnValue({
        month,
        totalIncome: 4200,
        totalExpenses: 2300,
        totalDeductions: 400,
        netIncome: 1900,
        transactionCount: 12,
      });
      mockGetMonthlyBudgetView.mockReturnValue({
        month,
        basisCurrency: 'EUR',
        currencies: ['EUR'],
        integrity: 'reliable',
        affordability: 'controlled',
        incomeInBasisCurrency: 4200,
        expensesInBasisCurrency: 2300,
        currentRemainingInBasisCurrency: 1900,
        currentRemainingRatio: 0.45,
        projectedExpensesInBasisCurrency: 2800,
        projectedRemainingInBasisCurrency: 1400,
        projectedRemainingRatio: 0.33,
        recurringExpenseEstimate: 500,
        recurringExpenseCount: 2,
        recurringExpenses: [
          {
            fingerprint: 'private-vendor',
            label: 'Private vendor subscription',
            currency: 'EUR',
            monthlyEstimate: 500,
            monthCount: 3,
            lastSeenDate: '2026-04-20',
            alreadyLoggedThisMonth: false,
          },
        ],
        notes: ['Recurring expense pressure still likely this month: EUR 500.00 across 2 pending commitment(s).'],
      });
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Show my finance budget summary',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-deterministic-read');
      expect(messageRes.body.domain).toBe('finance');
      expect(messageRes.body.text).toContain(`Finance summary for ${month}`);
      expect(messageRes.body.text).toContain('EUR 4200.00 income');
      expect(messageRes.body.text).toContain('EUR 2300.00 expenses');
      expect(messageRes.body.text).toContain('Budget mode: controlled');
      expect(messageRes.body.text).not.toContain('Private vendor');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('Private vendor');
      expect(mockGetMonthlySummary).toHaveBeenCalledWith(7001, month, { tenantId: 7001 });
      expect(mockGetMonthlyBudgetView).toHaveBeenCalledWith(7001, month, { tenantId: 7001 });
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'finance.summary',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'message',
            reasonCodes: ['deterministic_read', 'finance.summary', 'aggregate_read_allowed'],
          },
          readModel: {
            capabilityId: 'finance.summary',
            domain: 'finance',
            sensitivity: 'financial',
            data: {
              month,
              basisCurrency: 'EUR',
              totalIncome: 4200,
              totalExpenses: 2300,
              netIncome: 1900,
              transactionCount: 12,
              affordability: 'controlled',
            },
          },
        },
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousReads === undefined) {
        delete process.env.CHAT_CORE_V2_READS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_READS_ENABLED = previousReads;
      }
    }
  });

  it('answers training plan status through Chat Core v2 deterministic reads when explicitly enabled', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousReads = process.env.CHAT_CORE_V2_READS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_READS_ENABLED = 'true';
    try {
      mockGetActivePlan.mockReturnValue({
        id: 101,
        user_id: 7001,
        tenant_id: 7001,
        name: 'Marathon Base',
        sport: 'running',
        goal: 'Finish strong',
        duration_weeks: 8,
        periodization: 'linear',
        status: 'active',
        start_date: '2026-04-13',
        end_date: '2026-06-07',
        preferences_json: null,
        plan_version: 2,
        created_at: '2026-04-13T00:00:00.000Z',
        updated_at: '2026-04-14T08:00:00.000Z',
      });
      mockGetWeeksForPlan.mockReturnValue([
        {
          id: 201,
          plan_id: 101,
          week_number: 1,
          focus: 'Base endurance',
          intensity_pct: 85,
          volume_sessions: 3,
          notes: null,
          auto_adjusted: 0,
          adjustment_reason: null,
          created_at: '2026-04-13T00:00:00.000Z',
        },
      ]);
      mockGetSessionsForWeek.mockReturnValue([
        {
          id: 301,
          week_id: 201,
          plan_id: 101,
          tenant_id: 7001,
          day_of_week: 'Monday',
          session_type: 'running',
          title: 'Easy run',
          description: 'Private coaching detail',
          description_json: null,
          exercises_json: '[{"name":"Private drill"}]',
          duration_minutes: 45,
          intensity_text: 'easy',
          calendar_event_id: 'evt_private',
          calendar_source: 'google',
          session_identity_key: 'week1_run1',
          session_shape_hash: 'shape_1',
          preferred_time_unavailable: 0,
          status: 'completed',
          created_at: '2026-04-13T00:00:00.000Z',
          updated_at: '2026-04-14T08:00:00.000Z',
        },
        {
          id: 302,
          week_id: 201,
          plan_id: 101,
          tenant_id: 7001,
          day_of_week: 'Wednesday',
          session_type: 'running',
          title: 'Tempo intervals',
          description: null,
          description_json: null,
          exercises_json: null,
          duration_minutes: 50,
          intensity_text: 'moderate',
          calendar_event_id: null,
          calendar_source: null,
          session_identity_key: 'week1_run2',
          session_shape_hash: 'shape_2',
          preferred_time_unavailable: 0,
          status: 'scheduled',
          created_at: '2026-04-13T00:00:00.000Z',
          updated_at: '2026-04-14T08:00:00.000Z',
        },
      ]);
      mockGetWeeklyAdherence.mockReturnValue({
        planId: 101,
        weekNumber: 1,
        totalSessions: 2,
        completedSessions: 1,
        skippedSessions: 0,
        pendingSessions: 1,
        adherenceRate: 50,
        avgRpe: 6,
        avgEnergy: 7,
        avgSoreness: 3,
      });
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Show my training sessions',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-deterministic-read');
      expect(messageRes.body.domain).toBe('training');
      expect(messageRes.body.text).toContain('Training plan: Marathon Base');
      expect(messageRes.body.text).toContain('week 1/8');
      expect(messageRes.body.text).toContain('50% adherence');
      expect(messageRes.body.text).toContain('Tempo intervals');
      expect(messageRes.body.text).not.toContain('evt_private');
      expect(messageRes.body.text).not.toContain('Private coaching detail');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('Private drill');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('evt_private');
      expect(mockGetActivePlan).toHaveBeenCalledWith(7001, 7001);
      expect(mockGetWeeksForPlan).toHaveBeenCalledWith(101);
      expect(mockGetSessionsForWeek).toHaveBeenCalledWith(201);
      expect(mockGetWeeklyAdherence).toHaveBeenCalledWith(101, 201);
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'training.session_explain',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'message',
            reasonCodes: ['deterministic_read', 'training.session_explain', 'read_only_allowed'],
          },
          readModel: {
            capabilityId: 'training.session_explain',
            domain: 'training',
            sensitivity: 'health_adjacent',
            data: {
              hasActivePlan: true,
              planName: 'Marathon Base',
              sport: 'running',
              currentWeekNumber: 1,
              currentWeekFocus: 'Base endurance',
              currentWeekIntensityPct: 85,
              adherenceRate: 50,
            },
          },
        },
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousReads === undefined) {
        delete process.env.CHAT_CORE_V2_READS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_READS_ENABLED = previousReads;
      }
    }
  });

  it('answers content pipeline status through Chat Core v2 deterministic reads when explicitly enabled', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousReads = process.env.CHAT_CORE_V2_READS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_READS_ENABLED = 'true';
    try {
      mockGetTopics.mockReturnValue([
        {
          id: 401,
          user_id: 7001,
          title: 'Race-week fueling mistakes',
          notes: 'Private draft notes',
          scheduled_date: '2026-04-17',
          scheduled_at: null,
          status: 'ready',
          secretary_task_list_id: null,
          secretary_task_list_name: null,
          secretary_task_external_id: null,
          calendar_event_id: 'calendar_private',
          calendar_source: 'google',
          secretary_sync_status: null,
          secretary_sync_error: null,
          created_at: '2026-04-14T08:00:00.000Z',
          updated_at: '2026-04-14T08:00:00.000Z',
        },
        {
          id: 402,
          user_id: 7001,
          title: 'Recovery myth carousel',
          notes: null,
          scheduled_date: null,
          scheduled_at: null,
          status: 'drafting',
          created_at: '2026-04-14T09:00:00.000Z',
          updated_at: '2026-04-14T09:00:00.000Z',
        },
      ]);
      mockGetContentDeskItems.mockReturnValue([
        {
          id: 501,
          type: 'script_ready',
          title: 'Recovery reel draft',
          body: 'Full private script body',
          createdAt: '2026-04-14T10:00:00.000Z',
        },
      ]);
      mockGetRankedContentSignals.mockReturnValue([
        {
          type: 'reaction_opportunity',
          title: 'Creators are debating carb myths again',
          summary: 'Full private signal summary',
          priority: 'urgent',
          relevanceScore: 0.93,
          confidence: 0.81,
        },
      ]);
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'Show my content pipeline',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-deterministic-read');
      expect(messageRes.body.domain).toBe('content');
      expect(messageRes.body.text).toContain('Content pipeline: 2 tracked topics.');
      expect(messageRes.body.text).toContain('1 ready');
      expect(messageRes.body.text).toContain('1 drafting');
      expect(messageRes.body.text).toContain('1 desk-ready item');
      expect(messageRes.body.text).toContain('1 urgent signal');
      expect(messageRes.body.text).toContain('Race-week fueling mistakes');
      expect(messageRes.body.text).toContain('Recovery reel draft');
      expect(messageRes.body.text).not.toContain('Full private script body');
      expect(messageRes.body.text).not.toContain('Full private signal summary');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('Private draft notes');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('Full private script body');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('calendar_private');
      expect(mockGetTopics).toHaveBeenCalledWith(7001, { includeTerminal: false, limit: 20 });
      expect(mockGetContentDeskItems).toHaveBeenCalledWith(7001, 5);
      expect(mockGetRankedContentSignals).toHaveBeenCalledWith(7001, 5);
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'content.pipeline_summary',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'message',
            reasonCodes: ['deterministic_read', 'content.pipeline_summary'],
          },
          readModel: {
            capabilityId: 'content.pipeline_summary',
            domain: 'content',
            sensitivity: 'personal',
            data: {
              topicCount: 2,
              readyCount: 1,
              draftingCount: 1,
              deskReadyCount: 1,
              urgentSignalCount: 1,
            },
          },
        },
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousReads === undefined) {
        delete process.env.CHAT_CORE_V2_READS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_READS_ENABLED = previousReads;
      }
    }
  });

  it('answers cooking meal-plan status through Chat Core v2 deterministic reads when explicitly enabled', async () => {
    const previousGlobal = process.env.CHAT_CORE_V2_ENABLED;
    const previousReads = process.env.CHAT_CORE_V2_READS_ENABLED;
    process.env.CHAT_CORE_V2_ENABLED = 'true';
    process.env.CHAT_CORE_V2_READS_ENABLED = 'true';
    try {
      const {
        addRecipe,
        generateShoppingList,
        setMealPlan,
        upsertPantryItem,
      } = await import('../../src/services/cooking-chef');
      const weekStart = currentMondayIso();
      const dinnerDate = addIsoDays(weekStart, 2);
      const recipe = addRecipe(7001, 'Salmon recovery bowl', [
        { name: 'salmon', quantity: '2', unit: 'fillets' },
        { name: 'rice', quantity: '500', unit: 'g' },
      ], {
        tenantId: 7001,
        instructions: 'Private instruction text',
        tags: 'private-tag',
        source: 'private-source',
      });
      upsertPantryItem(7001, {
        name: 'rice',
        quantity: '500',
        unit: 'g',
        freshnessStatus: 'fresh',
        notes: 'Private pantry note',
      }, 7001);
      setMealPlan(7001, dinnerDate, 'dinner', 'Salmon recovery bowl', {
        recipeId: recipe.id,
        notes: 'Private meal note',
        tenantId: 7001,
      });
      generateShoppingList(7001, weekStart, 7001);
      mockRouteMessage.mockClear();
      mockHandleSecretary.mockClear();

      const messageRes = await dispatch('POST', '/message', 7001, {
        text: 'What meals do I have this week?',
      });

      expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
      expect(messageRes.body.routeMethod).toBe('chat-core-v2-deterministic-read');
      expect(messageRes.body.domain).toBe('cooking');
      expect(messageRes.body.text).toContain(`This week's meal plan (${weekStart} to ${addIsoDays(weekStart, 6)}).`);
      expect(messageRes.body.text).toContain('1 planned meal');
      expect(messageRes.body.text).toContain('2 shopping items');
      expect(messageRes.body.text).toContain('1 already in the pantry');
      expect(messageRes.body.text).toContain('Salmon recovery bowl');
      expect(messageRes.body.text).toContain('salmon');
      expect(messageRes.body.text).not.toContain('Private instruction text');
      expect(messageRes.body.text).not.toContain('Private meal note');
      expect(messageRes.body.text).not.toContain('Private pantry note');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('Private instruction text');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('Private meal note');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('Private pantry note');
      expect(JSON.stringify(messageRes.body.metadata)).not.toContain('private-source');
      expect(messageRes.body.metadata).toMatchObject({
        type: 'chat_core_v2_deterministic_read',
        chatCoreV2: {
          capabilityId: 'cooking.meal_plan_summary',
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'message',
            reasonCodes: ['deterministic_read', 'cooking.meal_plan_summary'],
          },
          readModel: {
            capabilityId: 'cooking.meal_plan_summary',
            domain: 'cooking',
            sensitivity: 'personal',
            data: {
              rangeStart: weekStart,
              rangeEnd: addIsoDays(weekStart, 6),
              plannedMealCount: 1,
              shoppingItemCount: 2,
              pantryAvailableShoppingItemCount: 1,
            },
          },
        },
      });
      expect(mockRouteMessage).not.toHaveBeenCalled();
      expect(mockHandleSecretary).not.toHaveBeenCalled();
    } finally {
      if (previousGlobal === undefined) {
        delete process.env.CHAT_CORE_V2_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_ENABLED = previousGlobal;
      }
      if (previousReads === undefined) {
        delete process.env.CHAT_CORE_V2_READS_ENABLED;
      } else {
        process.env.CHAT_CORE_V2_READS_ENABLED = previousReads;
      }
    }
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
      usageLevel: 'exhausted',
      usageFraction: 1,
      resetAt: '2026-04-15T00:00:00.000Z',
      limitUsd: 0,
      usedUsd: 0,
      remainingUsd: 0,
      planDailyLimitUsd: 0,
      includedRemainingUsd: 0,
      nexusPointsBalance: 0,
      nexusPointsRemainingUsd: 0,
      boostAvailable: false,
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
      usageLevel: 'exhausted',
      usageFraction: 1,
          usagePercent: 100,
          isOverLimit: true,
          boostAvailable: false,
          nexusPointsBalance: 0,
          pointsPurchaseAvailable: false,
      error: 'rate_limited',
      retryable: true,
    });
    expect(JSON.stringify(messageRes.body.error.details)).not.toMatch(/usd|allowance/i);
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
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'canary';
    process.env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS = '7001';

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
    expect(testDb.prepare(`
      SELECT fallback_count, total_count
      FROM chat_v2_legacy_fallback_counter
      WHERE tenant_id = ?
    `).get('7001')).toMatchObject({
      fallback_count: 1,
      total_count: 1,
    });
  });

  it('renders ChatCoreV2 destructive holds as guard-only confirmations and never executes on confirm', async () => {
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'canary';
    process.env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS = '7001';
    process.env.CHAT_CORE_V2_ACTION_GATEWAY_MODE = 'enforce';
    process.env.CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK = 'on';
    process.env.CHAT_V2_WRITE_EVIDENCE_ENABLED = 'true';
    process.env.CHAT_V2_EVIDENCE_HMAC_SECRET = 'chat-routes-guard-only-confirmation-secret';

    const first = await dispatch('POST', '/message', 7001, {
      text: 'Delete all my tasks',
      clientMessageId: 'chat-core-v2-guard-only-1',
    });

    expect(first.statusCode, JSON.stringify(first.body)).toBe(202);
    expect(first.body.routeMethod).toBe('chat-core-v2-action-gateway');
    expect(first.body.metadata).toMatchObject({
      type: 'chat_core_v2_write_intent_guard',
      responseKind: 'action_preview',
      pendingConfirmation: {
        kind: 'pending_confirmation',
        intent_class: 'chat_core_v2_destructive_hold',
        confirmation_token: expect.any(String),
      },
      actionConfirmation: {
        actionLabel: 'Keep paused',
        destructive: true,
        variant: 'destructive',
        confirmationToken: expect.any(String),
      },
      chatCoreV2: {
        actionGateway: {
          guardOnlyConfirmation: true,
        },
      },
    });
    expect(first.body.responseCards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'confirmationCard',
        destructive: true,
      }),
    ]));
    expect(mockRouteMessage).not.toHaveBeenCalled();
    expect(mockHandleSecretary).not.toHaveBeenCalled();

    const token = first.body.metadata.pendingConfirmation.confirmation_token;
    const confirmed = await dispatch('POST', '/confirm-action', 7001, {
      confirmation_token: token,
      intent_class: 'chat_core_v2_destructive_hold',
      idempotencyKey: 'guard-only-confirm-once',
    });

    expect(confirmed.statusCode, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.routeMethod).toBe('chat-core-v2-action-gateway-confirmation-hold');
    expect(confirmed.body.metadata).toMatchObject({
      type: 'chat_core_v2_destructive_confirmation_hold',
      actionStatus: 'confirmation_acknowledged',
      verificationStatus: 'not_executed',
      pendingConfirmation: {
        kind: 'completed_confirmation',
        intent_class: 'chat_core_v2_destructive_hold',
      },
      chatCoreV2: {
        guardOnlyConfirmation: true,
      },
    });
    expect(String(confirmed.body.text)).toContain('did not change anything');

    const replay = await dispatch('POST', '/confirm-action', 7001, {
      confirmation_token: token,
      intent_class: 'chat_core_v2_destructive_hold',
      idempotencyKey: 'guard-only-confirm-once',
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.metadata).toMatchObject({
      idempotentReplay: true,
      confirmationReplay: true,
      verificationStatus: 'not_executed',
    });
  });

  it('uses the ChatCoreV2 route locale for destructive confirmation text instead of stale profile locale', async () => {
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'canary';
    process.env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS = '7001';

    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'cancel my training plan and clear the calendar',
    });
    mockGetUserLanguage.mockReturnValue('en-US');

    const res = await dispatch('POST', '/message', 7001, {
      text: 'cancel my training plan and clear the calendar',
    }, {
      'x-language': 'pt-PT',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.routeMethod).toBe('confirmation-required');
    expect(String(res.body.text)).toContain('Antes de fazer uma alteração destrutiva');
    expect(String(res.body.text)).not.toContain('Before I make');
    expect(res.body.metadata.pendingConfirmation.decisionId).toMatch(/^nc_/);
    expect(mockRouteMessage).not.toHaveBeenCalled();
  });

  it('accepts numeric regional language tags like es-419 for ChatCoreV2 route locale', async () => {
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'canary';
    process.env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS = '7001';

    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'cancel my training plan and clear the calendar',
    });
    mockGetUserLanguage.mockReturnValue('en-US');

    const res = await dispatch('POST', '/message', 7001, {
      text: 'cancel my training plan and clear the calendar',
    }, {
      'x-language': 'es-419',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.routeMethod).toBe('confirmation-required');
    expect(String(res.body.text)).toContain('Antes de hacer un cambio destructivo');
    expect(String(res.body.text)).not.toContain('Before I make');
    expect(res.body.metadata.pendingConfirmation.decisionId).toMatch(/^nc_/);
    expect(mockRouteMessage).not.toHaveBeenCalled();
  });

  it('routes accept-this-decision chat confirmations through Decision Center action policy', async () => {
    process.env.CHAT_CORE_V2_ORCHESTRATOR_MODE = 'canary';
    process.env.CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS = '7001';

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
    expect(testDb.prepare(`
      SELECT fallback_count, total_count
      FROM chat_v2_legacy_fallback_counter
      WHERE tenant_id = ?
    `).get('7001')).toMatchObject({
      fallback_count: 2,
      total_count: 2,
    });
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
