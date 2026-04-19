import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

const mockRouteMessage = vi.fn();
const mockKeywordMatch = vi.fn(() => null);
const mockTryDeterministicChatCommand = vi.fn();
const mockClassifyAndExtractImage = vi.fn();
const mockGetUserLanguage = vi.fn(() => 'en');
const mockSetUserLanguage = vi.fn();
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
}));
const mockGetLastAssistantMessage = vi.fn(() => null);
const mockAddToConversation = vi.fn();
const mockSyncLastAssistantConversationMessage = vi.fn();
const mockClearAllConversations = vi.fn();
const mockCompleteOneShotWithFallback = vi.fn();
const mockHandleSecretary = vi.fn(async () => ({ text: 'Scheduled.', domain: 'secretary' as const }));
const mockGetScript = vi.fn();
const mockGetActiveContentPillars = vi.fn(() => []);
const mockGetContentDeskItems = vi.fn(() => []);
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
const mockStoreCallback = vi.fn(() => 'cb-ref');
const mockGetLastCoachState = vi.fn(() => null);
const mockApplyCoachRecommendations = vi.fn(async () => ({
  count: 0,
  appliedRecommendations: [],
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/router', () => ({
  routeMessage: (...args: unknown[]) => mockRouteMessage(...args),
  keywordMatch: (...args: unknown[]) => mockKeywordMatch(...args),
  isSystemCommand: vi.fn(() => null),
}));

vi.mock('../../src/api/routes/chat-fastpath', () => ({
  tryDeterministicChatCommand: (...args: unknown[]) => mockTryDeterministicChatCommand(...args),
}));

vi.mock('../../src/services/anthropic', () => ({
  classifyAndExtractImage: (...args: unknown[]) => mockClassifyAndExtractImage(...args),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: vi.fn(() => null),
  setCache: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
  setUserLanguage: (...args: unknown[]) => mockSetUserLanguage(...args),
  getUserById: (userId: number) => ({ id: userId, tier: 'pro' }),
  getUserByTelegramId: (userId: number) => ({ id: userId, tier: 'pro' }),
}));

vi.mock('../../src/services/secretary-fastpath', () => ({
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
  getTaxEvents: (...args: unknown[]) => mockGetTaxEvents(...args),
  calculateMonthlyTax: (...args: unknown[]) => mockCalculateMonthlyTax(...args),
}));

vi.mock('../../src/services/fiscal-bundle', () => ({
  getFiscalCollectionSummary: (...args: unknown[]) => mockGetFiscalCollectionSummary(...args),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: (...args: unknown[]) => mockCompleteOneShotWithFallback(...args),
}));

vi.mock('../../src/domains/domain-handler', () => ({
  getLastCoachState: (...args: unknown[]) => mockGetLastCoachState(...args),
}));

vi.mock('../../src/services/garmin-coach', () => ({
  applyCoachRecommendations: (...args: unknown[]) => mockApplyCoachRecommendations(...args),
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

vi.mock('../../src/utils/callback-store', () => ({
  getCallback: (...args: unknown[]) => mockGetCallback(...args),
  storeCallback: (...args: unknown[]) => mockStoreCallback(...args),
}));

import { chatRoutes } from '../../src/api/routes/chat';

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
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { r.statusCode = code; return r; },
    json(body: any) { r.body = body; return r; },
  };
  return r;
}

function mockReq(userId: number, body?: any, headers: Record<string, string> = {}): Request {
  return {
    userId,
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
): Promise<MockRes> {
  const router = chatRoutes();
  const req = mockReq(userId, body, headers);
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

describe('Chat API routes', () => {
  beforeEach(() => {
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
    mockCheckTierAccess.mockReset();
    mockIsUserOverDailyCap.mockReset();
    mockGetLastAssistantMessage.mockReset();
    mockAddToConversation.mockReset();
    mockSyncLastAssistantConversationMessage.mockReset();
    mockClearAllConversations.mockReset();
    mockCompleteOneShotWithFallback.mockReset();
    mockHandleSecretary.mockReset();
    mockGetScript.mockReset();
    mockGetActiveContentPillars.mockReset();
    mockGetContentDeskItems.mockReset();
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
    mockGetTaxEvents.mockReset();
    mockCalculateMonthlyTax.mockReset();
    mockGetFiscalCollectionSummary.mockReset();
    mockGetCallback.mockReset();
    mockStoreCallback.mockReset();
    mockGetLastCoachState.mockReset();
    mockApplyCoachRecommendations.mockReset();

    mockTryDeterministicChatCommand.mockResolvedValue(null);
    mockKeywordMatch.mockReturnValue(null);
    mockGetUserLanguage.mockReturnValue('en');
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
    mockGetActiveContentPillars.mockReturnValue([]);
    mockGetContentDeskItems.mockReturnValue([]);
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
    mockStoreCallback.mockReturnValue('cb-ref');
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
    testDb?.close();
  });

  it('persists text chat exchanges and returns them through history', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'classifier',
      confidence: 0.93,
      strippedMessage: 'schedule a meeting',
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'schedule a meeting',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.text).toBe('Scheduled.');
    expect(messageRes.body.routeMethod).toBe('classifier');

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.statusCode).toBe(200);
    expect(historyRes.body.messages).toHaveLength(2);
    expect(historyRes.body.messages[0]).toMatchObject({
      role: 'user',
      text: 'schedule a meeting',
    });
    expect(historyRes.body.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'Scheduled.',
      domain: 'secretary',
      routeMethod: 'classifier',
      confidence: 0.93,
    });
  });

  it('clears persisted chat history for the authenticated user only', async () => {
    testDb.prepare(`
      INSERT INTO messages (user_id, message_uuid, role, text, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(7001, 'msg-1', 'assistant', 'Hello again', '2026-04-19T20:00:00.000Z');
    testDb.prepare(`
      INSERT INTO messages (user_id, message_uuid, role, text, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(7002, 'msg-2', 'assistant', 'Other user', '2026-04-19T20:00:00.000Z');

    const clearRes = await dispatch('DELETE', '/history', 7001);

    const remainingRows = testDb.prepare(
      'SELECT user_id, message_uuid FROM messages ORDER BY user_id ASC'
    ).all() as Array<{ user_id: number; message_uuid: string }>;

    expect(clearRes.statusCode, JSON.stringify(clearRes.body)).toBe(200);
    expect(clearRes.body.ok).toBe(true);
    expect(clearRes.body.data.cleared).toBe(true);
    expect(mockClearAllConversations).toHaveBeenCalledWith(7001);
    expect(remainingRows).toEqual([
      { user_id: 7002, message_uuid: 'msg-2' },
    ]);
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
    expect(mockSyncLastAssistantConversationMessage).toHaveBeenCalledWith(7003, 'secretary', 'Cancelled.');
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
    expect(mockSyncLastAssistantConversationMessage).toHaveBeenCalledWith(7003, 'secretary', 'Cancelado.');
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
    expect(mockSyncLastAssistantConversationMessage).toHaveBeenCalledWith(7001, 'secretary', '<b>Day overview</b>');
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

  it('applies coach callbacks and clears buttons from the persisted message', async () => {
    mockGetCallback.mockReturnValue({ recommendationIds: ['evt-1'] });
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
      INSERT INTO messages (user_id, message_uuid, role, text, domain, buttons_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    expect(mockSyncLastAssistantConversationMessage).toHaveBeenCalledWith(7001, 'triathlon', callbackRes.body.text);
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
    expect(mockAddToConversation).toHaveBeenCalledWith(7001, 'content', 'user', 'Write a short script about recovery after hard intervals in English');
    expect(mockAddToConversation).toHaveBeenCalledWith(7001, 'content', 'assistant', expect.stringContaining('Short script'));
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

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: "what's my budget remaining this month?",
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('finance-state-shortcut');
    expect(messageRes.body.text).toContain('Remaining');
    expect(messageRes.body.text).toContain('1,500');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'finance_budget_snapshot',
      totalIncome: 2400,
      totalExpenses: 900,
      remaining: 1500,
      remainingRatio: 63,
      derived: true,
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
    });
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

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'how much did i spend this month?',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(200);
    expect(messageRes.body.domain).toBe('finance');
    expect(messageRes.body.routeMethod).toBe('finance-state-shortcut');
    expect(messageRes.body.text).toContain('Total spending');
    expect(messageRes.body.text).toContain('780');
    expect(messageRes.body.metadata).toMatchObject({
      type: 'finance_monthly_spend_snapshot',
      month: '2026-04',
      totalExpenses: 780,
      transactionCount: 6,
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

  it('returns 402 with quota details when a free user tries an AI chat request', async () => {
    mockIsUserOverDailyCap.mockReturnValue({
      over: true,
      spentUsd: 0,
      capUsd: 0,
      plan: 'free',
      resetAt: '2026-04-15T00:00:00.000Z',
    });

    const messageRes = await dispatch('POST', '/message', 7001, {
      text: 'Help me plan my week',
    });

    expect(messageRes.statusCode, JSON.stringify(messageRes.body)).toBe(402);
    expect(messageRes.body.ok).toBe(false);
    expect(messageRes.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(messageRes.body.error.details).toEqual({
      plan: 'free',
      resetAt: '2026-04-15T00:00:00.000Z',
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
      strippedMessage: 'delete the task to review the training deck',
    });
    mockKeywordMatch.mockReturnValue('secretary');
    mockHandleSecretary.mockRejectedValue(Object.assign(
      new Error('Gemini overloaded'),
      { provider: 'gemini', status: 503, retryable: true },
    ));

    const res = await dispatch('POST', '/message', 7001, {
      text: 'delete the task to review the training deck',
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
      'delete the task to review the training deck',
    );
    expect(mockAddToConversation).toHaveBeenCalledWith(
      7001,
      'secretary',
      'assistant',
      expect.stringContaining('temporarily'),
    );

    const historyRes = await dispatch('GET', '/history?limit=10', 7001);
    expect(historyRes.body.messages).toHaveLength(2);
    expect(historyRes.body.messages[1]).toMatchObject({
      domain: 'secretary',
      routeMethod: 'degraded',
    });
  });
});
