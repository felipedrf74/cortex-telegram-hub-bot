/**
 * M6 replay net for POST /api/v1/chat/message.
 *
 * A deterministic corpus of representative turns covering the terminal
 * stage families that can be driven without live providers. Each original
 * turn's response envelope is normalized (volatile ids/timestamps/tokens/
 * latency stripped) and pinned against an inline expected object — this
 * suite is the byte-parity net for milestones 8-10: any envelope change
 * fails loudly with a readable diff. The later-added families pin the full
 * STAGE ORDER plus the load-bearing envelope fields (status, routeMethod,
 * metadata discriminators).
 *
 * The suite also pins the per-turn STAGE ORDER recorded by the M6
 * chat-stage-trace seam; that ordering pin is load-bearing for the M10
 * stage-pipeline decomposition.
 *
 * COVERED stage families (see EXPECTED_STAGES):
 *   request_received, request_validated, legacy_route, legacy_response,
 *   idempotent_replay, idempotent_replay_conflict, idempotency_in_progress,
 *   idempotency_claim_conflict, token_zero_shortcut, fast_path,
 *   cached_command, authenticated_identity, pending_work_cancel_empty,
 *   pending_work_cancelled, action_planner_deterministic,
 *   training_plan_shortcut, destructive_confirmation_hold,
 *   decision_confirmation_shortcut, domain_shortcut,
 *   action_gateway_preview, action_gateway_stop (the two gateway families
 *   run with documented CHAT_CORE_V2_* activation env flags scoped to their
 *   own turn — still deterministic, zero live providers).
 *
 * NOT COVERED (needs activation env beyond what is safe to pin here):
 *   chat_core_v2_deterministic_read_early, chat_core_v2_deterministic_read,
 *   chat_core_v2_local_answer, chat_core_v2_unsupported_fallback.
 * NOT COVERED (needs model providers or binary attachments):
 *   attachment, action_planner_model, internet_research.
 *
 * Regenerating expectations after an INTENTIONAL envelope change:
 *   CHAT_REPLAY_DUMP=1 CHAT_REPLAY_DUMP_FILE=/tmp/chat-replay-dump.json \
 *     npx vitest run __tests__/api/chat-message-replay.test.ts
 * (dump mode skips assertions and writes normalized actuals to the dump
 * file) then copy the JSON into EXPECTED_ENVELOPES / EXPECTED_STAGES.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import type { Request } from 'express';

let testDb: Database.Database;

const mockRouteMessage = vi.fn();
const mockTryDeterministicChatCommand = vi.fn(async () => null as unknown);
const mockGetCached = vi.fn(() => null as unknown);
const mockSetCache = vi.fn();
const mockTryHandleChatActionPlan = vi.fn(async () => null as unknown);
const mockExecuteConfirmedChatActionRuns = vi.fn(async () => null as unknown);
const mockHandleSecretary = vi.fn(async (message: string) => ({
  text: `Secretary handled: ${message}`,
  domain: 'secretary' as const,
}));
const decisionMocks = vi.hoisted(() => ({
  createDecisionIntent: vi.fn(async () => ({ item: { decisionId: 'decision-fixed' } })),
  findDecisionByRelatedEntity: vi.fn((): unknown => null),
  performDecisionAction: vi.fn(async (): Promise<unknown> => {
    throw new Error('performDecisionAction should not run in this corpus');
  }),
}));
const mockGetScript = vi.hoisted(() => vi.fn(async () => ({
  topic: 'morning routines',
  script: 'Mock script body about morning routines.',
  hook: 'Mock hook.',
  sources_used: [],
  estimated_duration_minutes: 5,
  format: 'YouTube',
})));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => {
      if (process.env.CHAT_REPLAY_DUMP === '1') {
        // eslint-disable-next-line no-console
        console.log('LOGGER_ERROR', ...args.map((arg) => {
          if (arg && typeof arg === 'object' && 'err' in (arg as Record<string, unknown>)) {
            const err = (arg as Record<string, unknown>).err;
            return err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
          }
          return String(arg);
        }));
      }
    },
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/router', () => ({
  routeMessage: (...args: unknown[]) => mockRouteMessage(...args),
  keywordMatch: vi.fn(() => null),
  isSystemCommand: vi.fn(() => null),
}));

vi.mock('../../src/api/routes/chat-fastpath', () => ({
  tryDeterministicChatCommand: (...args: unknown[]) => mockTryDeterministicChatCommand(...args),
  getPendingTasksCacheKey: (userId?: number, tenantId?: number) =>
    `u:${userId ?? 'unknown'}:t:${tenantId ?? userId ?? 'unknown'}:fastpath:pending-tasks`,
}));

vi.mock('../../src/services/secretary-fastpath', () => ({
  tryFastpath: vi.fn(async () => ({ matched: false })),
  normalizeLangHeader: (value: string) => (value.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en-US'),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
  clearCache: vi.fn(),
  clearCacheByPrefix: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: vi.fn(() => 'en-US'),
  getUserLanguageById: vi.fn(() => 'en-US'),
  setUserLanguage: vi.fn(),
  getPreferredDisplayName: vi.fn(() => 'Test User'),
  getPreferredDisplayNameById: vi.fn(() => 'Test User'),
  getUserTimezone: () => 'Europe/Lisbon',
  getUserTimezoneById: () => 'Europe/Lisbon',
  getUserById: (userId: number) => ({ id: userId, tier: 'pro' }),
  getUserByTelegramId: (userId: number) => ({ id: userId, tier: 'pro' }),
}));

vi.mock('../../src/services/skill-tiers', () => ({
  checkSkillAccess: vi.fn(() => ({ allowed: true, userTier: 'pro', requiredTier: 'free' })),
  checkTierAccess: vi.fn(() => ({ allowed: true, userTier: 'pro', requiredTier: 'free' })),
}));

vi.mock('../../src/services/cost-guardrail', () => {
  class AiBudgetError extends Error {
    decision: unknown;
    constructor(decision: { code: string }) {
      super(decision.code);
      this.name = 'AiBudgetError';
      this.decision = decision;
    }
  }
  return {
    AiBudgetError,
    acquireAiBudgetReservation: vi.fn(async () => () => { /* no-op */ }),
    acquireCostLock: vi.fn(async () => () => { /* no-op */ }),
    isUserOverDailyCap: vi.fn(() => ({ over: false, plan: 'pro', resetAt: '2026-07-21T00:00:00.000Z' })),
    buildQuotaExceededPayload: vi.fn(() => ({})),
    buildQuotaExceededMessage: vi.fn(() => 'quota'),
    enforceCostGuardrails: vi.fn(() => ({ block: false, status: 200, reason: 'ok' })),
  };
});

vi.mock('../../src/state/conversation', () => ({
  getLastAssistantMessage: vi.fn(() => null),
  addToConversation: vi.fn(),
  syncLastAssistantConversationMessage: vi.fn(),
  clearAllConversations: vi.fn(),
}));

vi.mock('../../src/domains/secretary', () => ({
  handleSecretary: (...args: unknown[]) => mockHandleSecretary(args[0] as string),
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

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithFallback: vi.fn(async () => ({ text: 'mock', provider: 'gemini' })),
  completeOneShotWithSearch: vi.fn(async () => ({ text: 'mock', provider: 'gemini' })),
}));

vi.mock('../../src/services/anthropic', () => ({
  classifyAndExtractImage: vi.fn(async () => ({ kind: 'unknown' })),
}));

vi.mock('../../src/services/chat', () => ({
  tryHandleChatActionPlan: (...args: unknown[]) => mockTryHandleChatActionPlan(...args),
  executeConfirmedChatActionRuns: (...args: unknown[]) => mockExecuteConfirmedChatActionRuns(...args),
}));

vi.mock('../../src/services/decision-center', () => ({
  createDecisionIntent: (...args: unknown[]) => decisionMocks.createDecisionIntent(...args as []),
  findDecisionByRelatedEntity: (...args: unknown[]) => decisionMocks.findDecisionByRelatedEntity(...args as []),
  performDecisionAction: (...args: unknown[]) => decisionMocks.performDecisionAction(...args as []),
  // Used by the ChatCoreV2 command-preview route (decision dismiss/snooze
  // resolution); returns no candidates in this corpus.
  listDecisionItems: vi.fn(() => []),
}));

// Content engine is an external Python subprocess — never reachable in tests.
// The domain_shortcut corpus turn drives the content script shortcut against
// this deterministic mock.
vi.mock('../../src/services/content-engine', () => ({
  getScript: (...args: unknown[]) => mockGetScript(...args as []),
}));

// Finance state shortcut dependencies (token-zero corpus turn).
vi.mock('../../src/services/invoice-collector', () => ({
  getAllVendors: vi.fn(() => []),
}));

vi.mock('../../src/state/invoice-filings', () => ({
  getFilingsForMonth: vi.fn(() => []),
}));

vi.mock('../../src/services/stripe-service', () => ({
  getSubscriptionStatus: vi.fn(() => ({
    plan: 'free',
    period: 'monthly',
    status: 'inactive',
    provider: 'none',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    isActive: false,
    isPro: false,
  })),
}));

vi.mock('../../src/services/finance-tracker', () => ({
  getMonthlySummary: vi.fn(() => ({
    month: '2026-07',
    totalIncome: 0,
    totalExpenses: 0,
    totalDeductions: 0,
    netIncome: 0,
    transactionCount: 0,
  })),
  getMonthlyBudgetView: vi.fn(() => ({
    month: '2026-07',
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
  })),
  getTaxEvents: vi.fn(() => []),
  calculatePortugueseMonthlyTax: vi.fn(() => ({
    grossIncome: 0,
    deductions: 0,
    inssDue: 0,
    taxableIncome: 0,
    taxDue: 0,
    effectiveRate: 0,
    bracket: 'Isento',
  })),
  formatCurrencyAmount: (currency: string, amount: number) => `${currency} ${amount.toFixed(2)}`,
}));

vi.mock('../../src/services/fiscal-bundle', () => ({
  getFiscalCollectionSummary: vi.fn(() => ({
    profile: null,
    destinationEmail: null,
    nextRunAt: null,
    providers: [],
    ruleCount: 0,
    customRuleCount: 0,
    deliveryAvailable: false,
    warnings: [],
  })),
}));

import { chatRoutes } from '../../src/api/routes/chat';
import {
  enableChatStageTraceForTests,
  getChatStageTrace,
  resetChatStageTraceForTests,
} from '../../src/services/chat-stage-trace';
import { upsertPendingChatAction } from '../../src/services/chat-action-state';
import { resetPendingChatConfirmationsForTests } from '../../src/services/chat-pending-confirmations';
import { resetPendingChatCoreV2CommandsForTests } from '../../src/services/chat-core-v2';
import { claimUserChatMessage } from '../../src/services/chat-history-store';

/**
 * Temporarily apply documented ChatCoreV2 activation env flags for a single
 * corpus turn (values are read live from process.env on every request, so
 * scoping them per-turn cannot leak into other assertions).
 */
async function withChatCoreV2Env<T>(
  overrides: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const USER_ID = 7001;
const TENANT_ID = 7001;

interface MockRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  headersSent: boolean;
  status(code: number): MockRes;
  setHeader(name: string, value: string): MockRes;
  getHeader(name: string): string | undefined;
  json(body: unknown): MockRes;
}

function mockRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    headersSent: false,
    status(code: number) { r.statusCode = code; return r; },
    setHeader(name: string, value: string) { r.headers[name.toLowerCase()] = value; return r; },
    getHeader(name: string) { return r.headers[name.toLowerCase()]; },
    json(body: unknown) { r.body = body; r.headersSent = true; return r; },
  };
  return r;
}

async function postMessage(
  requestId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<MockRes> {
  const router = chatRoutes();
  const req = {
    userId: USER_ID,
    tenantId: TENANT_ID,
    requestId,
    method: 'POST',
    url: '/message',
    originalUrl: '/message',
    baseUrl: '',
    path: '/message',
    query: {},
    params: {},
    body,
    headers,
    header(name: string) {
      return headers[name.toLowerCase()] ?? headers[name];
    },
  } as unknown as Request;
  const res = mockRes();
  await new Promise<void>((resolve, reject) => {
    (router as unknown as { handle: (req: unknown, res: unknown, next: (err?: unknown) => void) => void })
      .handle(req, res, (err?: unknown) => {
        if (err) reject(err);
        resolve();
      });
    setImmediate(resolve);
  });
  // The /message handler is async without asyncHandler; wait for the JSON write.
  const deadline = Date.now() + 2_000;
  while (!res.headersSent && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return res;
}

// ── Envelope normalizer ─────────────────────────────────────────────
// Replaces volatile fields (ids, timestamps, tokens, latency numbers)
// with stable placeholders while preserving envelope STRUCTURE, so any
// shape/copy change fails with a readable object diff.

const TS_KEYS = new Set([
  'timestamp', 'createdAt', 'updatedAt', 'expiresAt', 'expires_at',
  'completedAt', 'occurredAt', 'resetAt', 'observedAt',
]);
const LATENCY_KEYS = new Set(['latency', 'latencyMs', 'durationMs', 'firstProgressMs', 'elapsedMs']);
const TOKEN_KEYS = new Set(['confirmationToken', 'confirmation_token']);

function normalizeString(value: string): string {
  return value
    .replace(/msg-user-\d{10,}/g, 'msg-user-<ts>')
    .replace(/msg-(confirm-)?pending-\d+-\d+-\d{10,}/g, 'msg-$1<pendingId>')
    .replace(/pending-\d+-\d+-\d{10,}/g, '<pendingId>')
    .replace(/chat-pending-[0-9a-f-]{36}/g, '<pendingActionId>')
    .replace(/chat-action-[0-9a-f-]{36}/g, '<actionRunId>')
    .replace(/msg-\d{10,}/g, 'msg-<ts>')
    .replace(/chat-\d{10,}/g, 'chat-<ts>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<iso>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
}

function normalizeEnvelope(value: unknown, key?: string): unknown {
  if (key !== undefined) {
    if (TS_KEYS.has(key)) return value == null ? value : '<ts>';
    if (LATENCY_KEYS.has(key)) return value == null ? value : '<latency>';
    if (TOKEN_KEYS.has(key)) return value == null ? value : '<token>';
    if (key === 'traceId') return value == null ? value : '<traceId>';
    if (key === 'decisionId') return value == null ? value : '<decisionId>';
    if (key === 'idempotencyKey') return value == null ? value : '<idempotencyKey>';
    // Real-clock month label from the finance state shortcut.
    if (key === 'month') return value == null ? value : '<month>';
  }
  if (typeof value === 'string') return normalizeString(value);
  if (Array.isArray(value)) return value.map((item) => normalizeEnvelope(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = normalizeEnvelope(childValue, childKey);
    }
    return out;
  }
  return value;
}

const dumped: Record<string, unknown> = {};
const dumpedStages: Record<string, string[] | null> = {};

function captureTurn(name: string, res: MockRes, requestId: string): { envelope: unknown; stages: string[] | null } {
  const envelope = { statusCode: res.statusCode, body: normalizeEnvelope(res.body) };
  const stages = getChatStageTrace(requestId);
  if (process.env.CHAT_REPLAY_DUMP === '1') {
    dumped[name] = envelope;
    dumpedStages[name] = stages;
  }
  return { envelope, stages };
}


const DUMP_MODE = process.env.CHAT_REPLAY_DUMP === '1';

function assertTurn(name: string, capture: { envelope: unknown; stages: string[] | null }): void {
  if (DUMP_MODE) return; // collecting actuals; assertions resume on normal runs
  expect(capture.stages ?? []).toEqual(EXPECTED_STAGES[name]);
  expect(capture.envelope).toEqual(EXPECTED_ENVELOPES[name]);
}

afterEach(async () => {
  if (process.env.CHAT_REPLAY_DUMP === '1') {
    const fs = await import('fs');
    const target = process.env.CHAT_REPLAY_DUMP_FILE || '/tmp/chat-replay-dump.json';
    fs.writeFileSync(target, JSON.stringify({ dumped, dumpedStages }, null, 2));
  }
});

describe('POST /api/v1/chat/message replay net', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    // Chat history rows FK-reference users; seed the corpus user.
    testDb.prepare(`
      INSERT INTO users (
        id, telegram_id, first_name, language, timezone, tier, status,
        auth_provider, daily_message_limit, daily_token_limit, daily_cost_limit_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(USER_ID, USER_ID, 'Test', 'en', 'Europe/Lisbon', 'pro', 'active', 'telegram', 40, 100000, 1);
    resetPendingChatConfirmationsForTests();
    resetPendingChatCoreV2CommandsForTests();
    resetChatStageTraceForTests();
    enableChatStageTraceForTests();
    mockRouteMessage.mockReset();
    mockTryDeterministicChatCommand.mockReset();
    mockTryDeterministicChatCommand.mockResolvedValue(null);
    mockGetCached.mockReset();
    mockGetCached.mockReturnValue(null);
    mockSetCache.mockReset();
    mockTryHandleChatActionPlan.mockReset();
    mockTryHandleChatActionPlan.mockResolvedValue(null);
    mockExecuteConfirmedChatActionRuns.mockReset();
    mockExecuteConfirmedChatActionRuns.mockResolvedValue(null);
    mockHandleSecretary.mockClear();
    decisionMocks.createDecisionIntent.mockReset();
    decisionMocks.createDecisionIntent.mockResolvedValue({ item: { decisionId: 'decision-fixed' } });
    decisionMocks.findDecisionByRelatedEntity.mockReset();
    decisionMocks.findDecisionByRelatedEntity.mockReturnValue(null);
    decisionMocks.performDecisionAction.mockReset();
    decisionMocks.performDecisionAction.mockImplementation(async () => {
      throw new Error('performDecisionAction should not run in this corpus');
    });
    mockGetScript.mockClear();
    mockRouteMessage.mockResolvedValue({
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'hello legacy',
    });
  });

  afterEach(() => {
    resetChatStageTraceForTests();
    testDb?.close();
  });

  it('pins the empty-request envelope (400 family)', async () => {
    const res = await postMessage('req-empty', { text: '' });
    const { envelope } = captureTurn('empty_message', res, 'req-empty');

    expect(envelope).toEqual({
      statusCode: 400,
      body: { error: { code: 'BAD_REQUEST', message: 'text or attachments are required' } },
    });
  });

  it('pins the legacy secretary route envelope and stage order', async () => {
    const res = await postMessage('req-legacy', { text: 'hello legacy' });
    assertTurn('legacy_route_secretary', captureTurn('legacy_route_secretary', res, 'req-legacy'));
  });

  it('pins the idempotent replay + conflict envelopes', async () => {
    const first = await postMessage('req-idem-1', { text: 'hello legacy', clientMessageId: 'cmid-replay' });
    expect(first.statusCode).toBe(200);

    const replay = await postMessage('req-idem-2', { text: 'hello legacy', clientMessageId: 'cmid-replay' });
    assertTurn('idempotent_replay', captureTurn('idempotent_replay', replay, 'req-idem-2'));

    const conflict = await postMessage('req-idem-3', { text: 'different text', clientMessageId: 'cmid-replay' });
    assertTurn('idempotency_conflict', captureTurn('idempotency_conflict', conflict, 'req-idem-3'));
  });

  it('pins the token-zero finance shortcut envelope and stage order', async () => {
    const res = await postMessage('req-token-zero', { text: 'What bills are still missing this month?' });
    assertTurn('token_zero_shortcut', captureTurn('token_zero_shortcut', res, 'req-token-zero'));
  });

  it('pins the fast-path and cached-command envelopes and stage order', async () => {
    mockTryDeterministicChatCommand.mockResolvedValue({
      text: 'Your day: 2 tasks, 1 event.',
      domain: 'secretary',
      buttons: undefined,
    });
    const fastPath = await postMessage('req-fast-path', { text: '/day' });
    assertTurn('fast_path_slash_day', captureTurn('fast_path_slash_day', fastPath, 'req-fast-path'));

    // Second send replays from the deterministic command cache.
    const setCacheCall = mockSetCache.mock.calls.find(([key]) => String(key).includes(':/day'));
    expect(setCacheCall).toBeDefined();
    mockGetCached.mockReturnValue(setCacheCall?.[1] ?? null);
    const cached = await postMessage('req-cached', { text: '/day' });
    assertTurn('cached_command', captureTurn('cached_command', cached, 'req-cached'));
  });

  it('pins the authenticated-identity envelope and stage order', async () => {
    const res = await postMessage('req-identity', { text: 'who am i' });
    assertTurn('authenticated_identity', captureTurn('authenticated_identity', res, 'req-identity'));
  });

  it('pins the pending-work cancellation envelopes (empty + seeded) and stage order', async () => {
    const empty = await postMessage('req-cancel-empty', { text: 'cancel' });
    assertTurn('cancel_empty', captureTurn('cancel_empty', empty, 'req-cancel-empty'));

    upsertPendingChatAction({
      userId: USER_ID,
      tenantId: TENANT_ID,
      conversationId: 'req-cancel-seeded',
      skill: 'tasks',
      action: 'create_task',
      collectedSlots: { title: null },
      missingSlots: ['title'],
      riskClass: 'R1',
      locale: 'en',
      timezone: 'UTC',
      originatingSurface: 'ios_chat',
    });
    const seeded = await postMessage('req-cancel-seeded', { text: 'cancel' });
    assertTurn('cancel_pending', captureTurn('cancel_pending', seeded, 'req-cancel-seeded'));
  });

  it('pins the deterministic action-planner confirmation hold (202 family) and stage order', async () => {
    mockTryHandleChatActionPlan.mockImplementation(async (input: unknown) => {
      const { allowModelPlanner } = input as { allowModelPlanner?: boolean };
      if (allowModelPlanner !== false) return null;
      return {
        status: 'needs_confirmation',
        plan: {
          planner: 'deterministic',
          steps: [{
            skill: 'tasks',
            action: 'delete_task',
            risk: 'destructive',
            args: { taskId: 'task-1' },
          }],
        },
        response: {
          id: 'msg-1752000000000',
          text: 'Should I delete the task "old task"?',
          domain: 'secretary',
          routeMethod: 'action-planner',
          confidence: 0.92,
          buttons: null,
          metadata: { type: 'chat_action_plan', actionStatus: 'needs_confirmation' },
          timestamp: '2026-07-20T12:00:00.000Z',
        },
      };
    });

    const res = await postMessage('req-planner', { text: 'delete my old task' });
    assertTurn('planner_confirmation', captureTurn('planner_confirmation', res, 'req-planner'));
  });

  it('pins the training-plan shortcut envelope and stage order', async () => {
    const res = await postMessage('req-training-plan', { text: 'create training plan for my race' });
    assertTurn('training_plan_shortcut', captureTurn('training_plan_shortcut', res, 'req-training-plan'));
  });

  it('pins the destructive-confirmation hold envelope and stage order', async () => {
    const res = await postMessage('req-destructive', { text: 'delete all my calendar events' });
    assertTurn('destructive_hold', captureTurn('destructive_hold', res, 'req-destructive'));
  });

  it('pins the unknown-domain envelope and stage order', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'not_a_domain',
      method: 'keyword',
      confidence: 0.5,
      strippedMessage: 'route me nowhere',
    });
    const res = await postMessage('req-unknown-domain', { text: 'route me nowhere' });
    assertTurn('unknown_domain', captureTurn('unknown_domain', res, 'req-unknown-domain'));
  });

  it('pins the idempotency in-progress (202) and claim-conflict (409) families and stage order', async () => {
    // Seed an in-flight user-message claim (no completed assistant yet), the
    // state a slow first request leaves behind while still processing.
    claimUserChatMessage({
      userId: USER_ID,
      tenantId: TENANT_ID,
      messageId: 'msg-user-cmid-inflight',
      text: 'long running request',
      clientMessageId: 'cmid-inflight',
      requestId: 'req-claim-seed',
      timestamp: '2026-07-20T12:00:00.000Z',
    });

    const inProgress = await postMessage('req-claim-dup', {
      text: 'long running request',
      clientMessageId: 'cmid-inflight',
    });
    const inProgressCapture = captureTurn('idempotency_in_progress', inProgress, 'req-claim-dup');
    if (!DUMP_MODE) {
      expect(inProgressCapture.stages ?? []).toEqual(EXPECTED_STAGES.idempotency_in_progress);
      expect(inProgress.statusCode).toBe(202);
      const inProgressBody = inProgress.body as Record<string, any>;
      expect(inProgressBody.routeMethod).toBe('idempotency-in-progress');
      expect(inProgressBody.metadata.type).toBe('chat_idempotency_in_progress');
      expect(inProgressBody.metadata.idempotencyInProgress).toBe(true);
      expect(inProgressBody.metadata.replayOfUserMessageId).toBe('msg-user-cmid-inflight');
    }

    const conflict = await postMessage('req-claim-conflict', {
      text: 'a different message entirely',
      clientMessageId: 'cmid-inflight',
    });
    const conflictCapture = captureTurn('idempotency_claim_conflict', conflict, 'req-claim-conflict');
    if (!DUMP_MODE) {
      expect(conflictCapture.stages ?? []).toEqual(EXPECTED_STAGES.idempotency_claim_conflict);
      expect(conflictCapture.envelope).toEqual({
        statusCode: 409,
        body: {
          error: {
            code: 'CHAT_IDEMPOTENCY_CONFLICT',
            message: 'This chat request id was already used for a different message.',
          },
        },
      });
    }
  });

  it('pins the decision-confirmation shortcut family and stage order', async () => {
    // Stage a destructive hold first: it tracks the pending chat confirmation
    // this shortcut resolves.
    const hold = await postMessage('req-decision-hold', { text: 'delete all my calendar events' });
    expect(hold.statusCode).toBe(200);

    decisionMocks.findDecisionByRelatedEntity.mockReturnValue({ decisionId: 'decision-fixed' });
    decisionMocks.performDecisionAction.mockResolvedValue({
      item: { decisionId: 'decision-fixed' },
      actionId: 'action-1',
      idempotent: false,
      verification: { status: 'verified' },
    });

    const res = await postMessage('req-decision-confirm', { text: 'confirm this decision' });
    const capture = captureTurn('decision_confirmation_shortcut', res, 'req-decision-confirm');
    if (!DUMP_MODE) {
      expect(capture.stages ?? []).toEqual(EXPECTED_STAGES.decision_confirmation_shortcut);
      expect(res.statusCode).toBe(200);
      const body = res.body as Record<string, any>;
      expect(body.routeMethod).toBe('decision-center-action');
      expect(body.metadata.type).toBe('decision_center_chat_confirmation_actioned');
      expect(body.metadata.decisionId).toBe('decision-fixed');
      expect(decisionMocks.performDecisionAction).toHaveBeenCalledTimes(1);
    }
  });

  it('pins the domain-shortcut family (content script shortcut) and stage order', async () => {
    mockRouteMessage.mockResolvedValue({
      domain: 'content',
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: 'write a script about morning routines',
    });

    const res = await postMessage('req-domain-shortcut', { text: 'write a script about morning routines' });
    const capture = captureTurn('domain_shortcut', res, 'req-domain-shortcut');
    if (!DUMP_MODE) {
      expect(capture.stages ?? []).toEqual(EXPECTED_STAGES.domain_shortcut);
      expect(res.statusCode).toBe(200);
      const body = res.body as Record<string, any>;
      expect(body.domain).toBe('content');
      expect(body.routeMethod).toBe('content-script');
      expect(mockGetScript).toHaveBeenCalledTimes(1);
    }
  });

  it('pins the action-gateway preview family (202) and stage order', async () => {
    const res = await withChatCoreV2Env({
      CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce',
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      CHAT_CORE_V2_ALLOWED_DOMAINS: 'tasks',
      CHAT_CORE_V2_ALLOW_WRITE_PREVIEWS: 'true',
    }, () => postMessage('req-gateway-preview', { text: 'create a task to buy milk tomorrow' }));

    const capture = captureTurn('action_gateway_preview', res, 'req-gateway-preview');
    if (!DUMP_MODE) {
      expect(capture.stages ?? []).toEqual(EXPECTED_STAGES.action_gateway_preview);
      expect(res.statusCode).toBe(202);
      const body = res.body as Record<string, any>;
      expect(body.routeMethod).toBe('chat-core-v2-command-preview');
      expect(body.metadata.type).toBe('chat_core_v2_command_preview');
    }
  });

  it('pins the action-gateway stop family (202 clarification) and stage order', async () => {
    const res = await withChatCoreV2Env({
      CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce',
    }, () => postMessage('req-gateway-stop', { text: 'cancel that' }));

    const capture = captureTurn('action_gateway_stop', res, 'req-gateway-stop');
    if (!DUMP_MODE) {
      expect(capture.stages ?? []).toEqual(EXPECTED_STAGES.action_gateway_stop);
      expect(res.statusCode).toBe(202);
      const body = res.body as Record<string, any>;
      expect(body.routeMethod).toBe('chat-core-v2-action-gateway');
      expect(body.metadata.type).toBe('chat_core_v2_write_intent_guard');
      expect(body.metadata.gatewayOutcome).toBe('needs_clarification');
    }
  });
});

// ── Inline expected snapshots ───────────────────────────────────────
// Regenerate with CHAT_REPLAY_DUMP=1 (see file header) after INTENTIONAL
// envelope changes only.

const EXPECTED_STAGES: Record<string, string[]> = {
  legacy_route_secretary: ["request_received", "request_validated", "legacy_route", "legacy_response"],
  idempotent_replay: ["request_received", "idempotent_replay"],
  idempotency_conflict: ["request_received", "idempotent_replay_conflict"],
  token_zero_shortcut: ["request_received", "request_validated", "token_zero_shortcut"],
  fast_path_slash_day: ["request_received", "request_validated", "fast_path"],
  cached_command: ["request_received", "request_validated", "cached_command"],
  authenticated_identity: ["request_received", "request_validated", "authenticated_identity"],
  cancel_empty: ["request_received", "request_validated", "pending_work_cancel_empty"],
  cancel_pending: ["request_received", "request_validated", "pending_work_cancelled"],
  planner_confirmation: ["request_received", "request_validated", "action_planner_deterministic"],
  training_plan_shortcut: ["request_received", "request_validated", "training_plan_shortcut"],
  destructive_hold: ["request_received", "request_validated", "destructive_confirmation_hold"],
  unknown_domain: ["request_received", "request_validated", "legacy_route"],
  idempotency_in_progress: ["request_received", "idempotency_in_progress"],
  idempotency_claim_conflict: ["request_received", "idempotency_claim_conflict"],
  decision_confirmation_shortcut: ["request_received", "request_validated", "decision_confirmation_shortcut"],
  domain_shortcut: ["request_received", "request_validated", "legacy_route", "domain_shortcut"],
  action_gateway_preview: ["request_received", "request_validated", "action_gateway_preview"],
  action_gateway_stop: ["request_received", "request_validated", "action_gateway_stop"],
};

const EXPECTED_ENVELOPES: Record<string, unknown> = {
  legacy_route_secretary: {
    "statusCode": 200,
    "body": {
      "id": "msg-<ts>",
      "text": "Secretary handled: hello legacy",
      "domain": "secretary",
      "routeMethod": "keyword",
      "confidence": 0.9,
      "buttons": [
        [
          {
            "text": "📅 Today",
            "callbackData": "cmd:/day"
          },
          {
            "text": "📋 Tasks",
            "callbackData": "cmd:/todo_summary"
          },
          {
            "text": "🗓 Week",
            "callbackData": "cmd:/week"
          }
        ]
      ],
      "metadata": {
        "type": "nexus_answer",
        "chatReasoning": {
          "version": "nexus_answer_contract.v1",
          "intent": "secretary.answer",
          "ownerSkill": "secretary",
          "routeKind": "generic_skill_answer",
          "groundingRequirement": "none",
          "expectedResponseShape": "direct_answer",
          "language": "en",
          "ambiguityReasons": [],
          "routeMethod": "keyword",
          "confidence": 0.9,
          "groundingFacts": [
            {
              "statement": "Authenticated user and tenant scope are present for this chat turn.",
              "source": "auth.scope",
              "field": "userId,tenantId",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            },
            {
              "statement": "Secretary is the current owner skill for this response.",
              "source": "chat.skill_capability_registry",
              "field": "ownerSkill",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            },
            {
              "statement": "Router selected secretary with keyword.",
              "source": "chat.router",
              "field": "route",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            }
          ],
          "missingFacts": [],
          "staleness": "fresh",
          "riskLevel": "low",
          "actionability": "answer_only",
          "verificationStatus": "not_required",
          "fallbackUsed": false,
          "fallback": {
            "fallbackType": "none",
            "retryable": false,
            "sourceFreshness": "fresh",
            "userActionRequired": false,
            "operatorActionRequired": false
          },
          "userFacingSummary": "Secretary handled: hello legacy",
          "nextBestActions": [],
          "traceId": "<traceId>",
          "latency": "<latency>"
        },
        "chatTurnContract": {
          "skill": "secretary",
          "routeKind": "generic_skill_answer",
          "riskClass": "low",
          "groundingRequired": "none",
          "expectedResponseShape": "direct_answer",
          "language": "en",
          "confidence": 0.9,
          "ambiguityReasons": [],
          "telemetryLabel": "chat.skill.secretary",
          "internetEligible": false
        },
        "groundingFacts": [
          {
            "statement": "Authenticated user and tenant scope are present for this chat turn.",
            "source": "auth.scope",
            "field": "userId,tenantId"
          },
          {
            "statement": "Secretary is the current owner skill for this response.",
            "source": "chat.skill_capability_registry",
            "field": "ownerSkill"
          },
          {
            "statement": "Router selected secretary with keyword.",
            "source": "chat.router",
            "field": "route"
          }
        ],
        "finalAnswerComposition": {
          "version": "nexus_final_answer_composer.v1",
          "ok": true,
          "issues": [],
          "mode": "model_constrained",
          "draftSchemaVersion": "nexus_composed_answer_draft.v1"
        },
        "responseQuality": {
          "status": "pass",
          "issues": [],
          "score": 1,
          "qualityGateDisabled": false,
          "qualityGateSkipped": false,
          "qualityGateReason": "pass"
        },
        "fallbackPolicy": {
          "operationKind": "read_only_answer",
          "fallbackAllowed": true,
          "mayUseCachedData": true,
          "requiresFreshnessLabel": false,
          "mayClaimSuccess": false,
          "retryable": false,
          "userActionRequired": false,
          "operatorActionRequired": false,
          "responseMode": "answer",
          "reason": "Read-only answers may use cached or degraded facts when freshness is visible."
        }
      },
      "timestamp": "<ts>"
    }
  },
  idempotent_replay: {
    "statusCode": 200,
    "body": {
      "id": "msg-<ts>",
      "text": "Secretary handled: hello legacy",
      "domain": "secretary",
      "routeMethod": "keyword",
      "confidence": 0.9,
      "buttons": [
        [
          {
            "text": "📅 Today",
            "callbackData": "cmd:/day"
          },
          {
            "text": "📋 Tasks",
            "callbackData": "cmd:/todo_summary"
          },
          {
            "text": "🗓 Week",
            "callbackData": "cmd:/week"
          }
        ]
      ],
      "metadata": {
        "type": "nexus_answer",
        "chatReasoning": {
          "version": "nexus_answer_contract.v1",
          "intent": "secretary.answer",
          "ownerSkill": "secretary",
          "routeKind": "generic_skill_answer",
          "groundingRequirement": "none",
          "expectedResponseShape": "direct_answer",
          "language": "en",
          "ambiguityReasons": [],
          "routeMethod": "keyword",
          "confidence": 0.9,
          "groundingFacts": [
            {
              "statement": "Authenticated user and tenant scope are present for this chat turn.",
              "source": "auth.scope",
              "field": "userId,tenantId",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            },
            {
              "statement": "Secretary is the current owner skill for this response.",
              "source": "chat.skill_capability_registry",
              "field": "ownerSkill",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            },
            {
              "statement": "Router selected secretary with keyword.",
              "source": "chat.router",
              "field": "route",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            }
          ],
          "missingFacts": [],
          "staleness": "fresh",
          "riskLevel": "low",
          "actionability": "answer_only",
          "verificationStatus": "not_required",
          "fallbackUsed": false,
          "fallback": {
            "fallbackType": "none",
            "retryable": false,
            "sourceFreshness": "fresh",
            "userActionRequired": false,
            "operatorActionRequired": false
          },
          "userFacingSummary": "Secretary handled: hello legacy",
          "nextBestActions": [],
          "traceId": "<traceId>",
          "latency": "<latency>"
        },
        "chatTurnContract": {
          "skill": "secretary",
          "routeKind": "generic_skill_answer",
          "riskClass": "low",
          "groundingRequired": "none",
          "expectedResponseShape": "direct_answer",
          "language": "en",
          "confidence": 0.9,
          "ambiguityReasons": [],
          "telemetryLabel": "chat.skill.secretary",
          "internetEligible": false
        },
        "groundingFacts": [
          {
            "statement": "Authenticated user and tenant scope are present for this chat turn.",
            "source": "auth.scope",
            "field": "userId,tenantId"
          },
          {
            "statement": "Secretary is the current owner skill for this response.",
            "source": "chat.skill_capability_registry",
            "field": "ownerSkill"
          },
          {
            "statement": "Router selected secretary with keyword.",
            "source": "chat.router",
            "field": "route"
          }
        ],
        "finalAnswerComposition": {
          "version": "nexus_final_answer_composer.v1",
          "ok": true,
          "issues": [],
          "mode": "model_constrained",
          "draftSchemaVersion": "nexus_composed_answer_draft.v1"
        },
        "responseQuality": {
          "status": "pass",
          "issues": [],
          "score": 1,
          "qualityGateDisabled": false,
          "qualityGateSkipped": false,
          "qualityGateReason": "pass"
        },
        "fallbackPolicy": {
          "operationKind": "read_only_answer",
          "fallbackAllowed": true,
          "mayUseCachedData": true,
          "requiresFreshnessLabel": false,
          "mayClaimSuccess": false,
          "retryable": false,
          "userActionRequired": false,
          "operatorActionRequired": false,
          "responseMode": "answer",
          "reason": "Read-only answers may use cached or degraded facts when freshness is visible."
        },
        "idempotentReplay": true,
        "replayOfUserMessageId": "msg-user-cmid-replay"
      },
      "timestamp": "<ts>"
    }
  },
  idempotency_conflict: {
    "statusCode": 409,
    "body": {
      "error": {
        "code": "CHAT_IDEMPOTENCY_CONFLICT",
        "message": "This chat request id was already used for a different message."
      }
    }
  },
  token_zero_shortcut: {
    "statusCode": 200,
    "body": {
      "id": "msg-<ts>",
      "text": "I do not see any tracked invoice vendors yet. Add them in Fiscal Collection so I can tell you what is still missing each month.",
      "domain": "finance",
      "routeMethod": "finance-state-shortcut",
      "confidence": 0.95,
      "buttons": null,
      "metadata": {
        "type": "finance_missing_bills_snapshot",
        "month": "<month>",
        "trackedVendorCount": 0,
        "filedVendorCount": 0,
        "missingVendors": [],
        "filedVendors": [],
        "chatReasoning": {
          "version": "nexus_answer_contract.v1",
          "intent": "finance.read",
          "ownerSkill": "finance",
          "routeKind": "local_read",
          "groundingRequirement": "local",
          "expectedResponseShape": "finance_summary",
          "language": "en",
          "ambiguityReasons": [],
          "routeMethod": "finance-state-shortcut",
          "confidence": 0.9,
          "groundingFacts": [
            {
              "statement": "Authenticated user and tenant scope are present for this chat turn.",
              "source": "auth.scope",
              "field": "userId,tenantId",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            },
            {
              "statement": "Finance is the current owner skill for this response.",
              "source": "chat.skill_capability_registry",
              "field": "ownerSkill",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            },
            {
              "statement": "Backend returned scoped finance_missing_bills_snapshot metadata for this answer.",
              "source": "chat.context.metadata.finance_missing_bills_snapshot",
              "field": "context",
              "freshness": "fresh",
              "confidence": 0.85,
              "safeForUser": true
            },
            {
              "statement": "Server-side deterministic read produced this response.",
              "source": "chat.token_zero_shortcut",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            }
          ],
          "missingFacts": [],
          "staleness": "fresh",
          "riskLevel": "low",
          "actionability": "answer_only",
          "verificationStatus": "not_required",
          "fallbackUsed": false,
          "fallback": {
            "fallbackType": "none",
            "retryable": false,
            "sourceFreshness": "fresh",
            "userActionRequired": false,
            "operatorActionRequired": false
          },
          "userFacingSummary": "I do not see any tracked invoice vendors yet. Add them in Fiscal Collection so I can tell you what is still missing each month.",
          "nextBestActions": [],
          "traceId": "<traceId>",
          "latency": "<latency>"
        },
        "chatTurnContract": {
          "skill": "finance",
          "routeKind": "local_read",
          "riskClass": "low",
          "groundingRequired": "local",
          "expectedResponseShape": "finance_summary",
          "language": "en",
          "confidence": 0.9,
          "ambiguityReasons": [],
          "telemetryLabel": "chat.skill.finance",
          "internetEligible": false
        },
        "groundingFacts": [
          {
            "statement": "Authenticated user and tenant scope are present for this chat turn.",
            "source": "auth.scope",
            "field": "userId,tenantId"
          },
          {
            "statement": "Finance is the current owner skill for this response.",
            "source": "chat.skill_capability_registry",
            "field": "ownerSkill"
          },
          {
            "statement": "Backend returned scoped finance_missing_bills_snapshot metadata for this answer.",
            "source": "chat.context.metadata.finance_missing_bills_snapshot",
            "field": "context"
          },
          {
            "statement": "Server-side deterministic read produced this response.",
            "source": "chat.token_zero_shortcut"
          }
        ],
        "finalAnswerComposition": {
          "version": "nexus_final_answer_composer.v1",
          "ok": true,
          "issues": [],
          "mode": "templated",
          "draftSchemaVersion": "nexus_composed_answer_draft.v1"
        },
        "responseQuality": {
          "status": "pass",
          "issues": [],
          "score": 1,
          "qualityGateDisabled": false,
          "qualityGateSkipped": false,
          "qualityGateReason": "pass"
        },
        "fallbackPolicy": {
          "operationKind": "read_only_answer",
          "fallbackAllowed": true,
          "mayUseCachedData": true,
          "requiresFreshnessLabel": false,
          "mayClaimSuccess": false,
          "retryable": false,
          "userActionRequired": false,
          "operatorActionRequired": false,
          "responseMode": "answer",
          "reason": "Read-only answers may use cached or degraded facts when freshness is visible."
        }
      },
      "timestamp": "<ts>",
      "responseBlocks": [
        {
          "kind": "paragraph",
          "text": "I do not see any tracked invoice vendors yet. Add them in Fiscal Collection so I can tell you what is still missing each month."
        }
      ]
    }
  },
  fast_path_slash_day: {
    "statusCode": 200,
    "body": {
      "id": "msg-<ts>",
      "text": "Your day: 2 tasks, 1 event.",
      "domain": "secretary",
      "routeMethod": "fast-path",
      "confidence": 1,
      "buttons": null,
      "metadata": {
        "type": "nexus_answer",
        "chatReasoning": {
          "version": "nexus_answer_contract.v1",
          "intent": "secretary.answer",
          "ownerSkill": "secretary",
          "routeKind": "generic_skill_answer",
          "groundingRequirement": "none",
          "expectedResponseShape": "direct_answer",
          "language": "en",
          "ambiguityReasons": [],
          "routeMethod": "fast-path",
          "confidence": 0.9,
          "groundingFacts": [
            {
              "statement": "Authenticated user and tenant scope are present for this chat turn.",
              "source": "auth.scope",
              "field": "userId,tenantId",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            },
            {
              "statement": "Secretary is the current owner skill for this response.",
              "source": "chat.skill_capability_registry",
              "field": "ownerSkill",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            },
            {
              "statement": "Server-side deterministic read produced this response.",
              "source": "chat.fast_path",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            }
          ],
          "missingFacts": [],
          "staleness": "fresh",
          "riskLevel": "low",
          "actionability": "answer_only",
          "verificationStatus": "not_required",
          "fallbackUsed": false,
          "fallback": {
            "fallbackType": "none",
            "retryable": false,
            "sourceFreshness": "fresh",
            "userActionRequired": false,
            "operatorActionRequired": false
          },
          "userFacingSummary": "Your day: 2 tasks, 1 event.",
          "nextBestActions": [],
          "traceId": "<traceId>",
          "latency": "<latency>"
        },
        "chatTurnContract": {
          "skill": "secretary",
          "routeKind": "generic_skill_answer",
          "riskClass": "low",
          "groundingRequired": "none",
          "expectedResponseShape": "direct_answer",
          "language": "en",
          "confidence": 0.9,
          "ambiguityReasons": [],
          "telemetryLabel": "chat.skill.secretary",
          "internetEligible": false
        },
        "groundingFacts": [
          {
            "statement": "Authenticated user and tenant scope are present for this chat turn.",
            "source": "auth.scope",
            "field": "userId,tenantId"
          },
          {
            "statement": "Secretary is the current owner skill for this response.",
            "source": "chat.skill_capability_registry",
            "field": "ownerSkill"
          },
          {
            "statement": "Server-side deterministic read produced this response.",
            "source": "chat.fast_path"
          }
        ],
        "finalAnswerComposition": {
          "version": "nexus_final_answer_composer.v1",
          "ok": true,
          "issues": [],
          "mode": "templated",
          "draftSchemaVersion": "nexus_composed_answer_draft.v1"
        },
        "responseQuality": {
          "status": "pass",
          "issues": [],
          "score": 1,
          "qualityGateDisabled": false,
          "qualityGateSkipped": false,
          "qualityGateReason": "pass"
        },
        "fallbackPolicy": {
          "operationKind": "read_only_answer",
          "fallbackAllowed": true,
          "mayUseCachedData": true,
          "requiresFreshnessLabel": false,
          "mayClaimSuccess": false,
          "retryable": false,
          "userActionRequired": false,
          "operatorActionRequired": false,
          "responseMode": "answer",
          "reason": "Read-only answers may use cached or degraded facts when freshness is visible."
        }
      },
      "timestamp": "<ts>",
      "responseBlocks": [
        {
          "kind": "paragraph",
          "text": "Your day: 2 tasks, 1 event."
        }
      ]
    }
  },
  cached_command: {
    "statusCode": 200,
    "body": {
      "id": "msg-<ts>",
      "text": "Your day: 2 tasks, 1 event.",
      "domain": "secretary",
      "routeMethod": "fast-path",
      "confidence": 1,
      "buttons": null,
      "metadata": {
        "type": "nexus_answer",
        "chatReasoning": {
          "version": "nexus_answer_contract.v1",
          "intent": "secretary.answer",
          "ownerSkill": "secretary",
          "routeKind": "generic_skill_answer",
          "groundingRequirement": "none",
          "expectedResponseShape": "direct_answer",
          "language": "en",
          "ambiguityReasons": [],
          "routeMethod": "fast-path",
          "confidence": 0.9,
          "groundingFacts": [
            {
              "statement": "Authenticated user and tenant scope are present for this chat turn.",
              "source": "auth.scope",
              "field": "userId,tenantId",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            },
            {
              "statement": "Secretary is the current owner skill for this response.",
              "source": "chat.skill_capability_registry",
              "field": "ownerSkill",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            },
            {
              "statement": "Backend returned scoped nexus_answer metadata for this answer.",
              "source": "chat.context.metadata.nexus_answer",
              "field": "context",
              "freshness": "fresh",
              "confidence": 0.85,
              "safeForUser": true
            },
            {
              "statement": "Server-side deterministic read produced this response.",
              "source": "chat.fast_path_cache",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            }
          ],
          "missingFacts": [],
          "staleness": "fresh",
          "riskLevel": "low",
          "actionability": "answer_only",
          "verificationStatus": "not_required",
          "fallbackUsed": false,
          "fallback": {
            "fallbackType": "none",
            "retryable": false,
            "sourceFreshness": "fresh",
            "userActionRequired": false,
            "operatorActionRequired": false
          },
          "userFacingSummary": "Your day: 2 tasks, 1 event.",
          "nextBestActions": [],
          "traceId": "<traceId>",
          "latency": "<latency>"
        },
        "chatTurnContract": {
          "skill": "secretary",
          "routeKind": "generic_skill_answer",
          "riskClass": "low",
          "groundingRequired": "none",
          "expectedResponseShape": "direct_answer",
          "language": "en",
          "confidence": 0.9,
          "ambiguityReasons": [],
          "telemetryLabel": "chat.skill.secretary",
          "internetEligible": false
        },
        "groundingFacts": [
          {
            "statement": "Authenticated user and tenant scope are present for this chat turn.",
            "source": "auth.scope",
            "field": "userId,tenantId"
          },
          {
            "statement": "Secretary is the current owner skill for this response.",
            "source": "chat.skill_capability_registry",
            "field": "ownerSkill"
          },
          {
            "statement": "Backend returned scoped nexus_answer metadata for this answer.",
            "source": "chat.context.metadata.nexus_answer",
            "field": "context"
          },
          {
            "statement": "Server-side deterministic read produced this response.",
            "source": "chat.fast_path_cache"
          }
        ],
        "finalAnswerComposition": {
          "version": "nexus_final_answer_composer.v1",
          "ok": true,
          "issues": [],
          "mode": "templated",
          "draftSchemaVersion": "nexus_composed_answer_draft.v1"
        },
        "responseQuality": {
          "status": "pass",
          "issues": [],
          "score": 1,
          "qualityGateDisabled": false,
          "qualityGateSkipped": false,
          "qualityGateReason": "pass"
        },
        "fallbackPolicy": {
          "operationKind": "read_only_answer",
          "fallbackAllowed": true,
          "mayUseCachedData": true,
          "requiresFreshnessLabel": false,
          "mayClaimSuccess": false,
          "retryable": false,
          "userActionRequired": false,
          "operatorActionRequired": false,
          "responseMode": "answer",
          "reason": "Read-only answers may use cached or degraded facts when freshness is visible."
        }
      },
      "timestamp": "<ts>",
      "responseBlocks": [
        {
          "kind": "paragraph",
          "text": "Your day: 2 tasks, 1 event."
        }
      ]
    }
  },
  authenticated_identity: {
    "statusCode": 200,
    "body": {
      "id": "msg-<ts>",
      "text": "This authenticated session is signed in as Test User. I will only use data tied to this account and tenant.",
      "domain": "secretary",
      "routeMethod": "authenticated-identity",
      "confidence": 1,
      "buttons": null,
      "metadata": {
        "type": "authenticated_identity",
        "userId": 7001,
        "hasDisplayName": true,
        "chatReasoning": {
          "version": "nexus_answer_contract.v1",
          "intent": "secretary.answer",
          "ownerSkill": "secretary",
          "routeKind": "generic_skill_answer",
          "groundingRequirement": "none",
          "expectedResponseShape": "direct_answer",
          "language": "en",
          "ambiguityReasons": [],
          "routeMethod": "authenticated-identity",
          "confidence": 0.9,
          "groundingFacts": [
            {
              "statement": "Authenticated user and tenant scope are present for this chat turn.",
              "source": "auth.scope",
              "field": "userId,tenantId",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            },
            {
              "statement": "Secretary is the current owner skill for this response.",
              "source": "chat.skill_capability_registry",
              "field": "ownerSkill",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            },
            {
              "statement": "Backend returned scoped authenticated_identity metadata for this answer.",
              "source": "chat.context.metadata.authenticated_identity",
              "field": "context",
              "freshness": "fresh",
              "confidence": 0.85,
              "safeForUser": true
            },
            {
              "statement": "Server-side deterministic read produced this response.",
              "source": "auth.session",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            }
          ],
          "missingFacts": [],
          "staleness": "fresh",
          "riskLevel": "low",
          "actionability": "answer_only",
          "verificationStatus": "not_required",
          "fallbackUsed": false,
          "fallback": {
            "fallbackType": "none",
            "retryable": false,
            "sourceFreshness": "fresh",
            "userActionRequired": false,
            "operatorActionRequired": false
          },
          "userFacingSummary": "This authenticated session is signed in as Test User. I will only use data tied to this account and tenant.",
          "nextBestActions": [],
          "traceId": "<traceId>",
          "latency": "<latency>"
        },
        "chatTurnContract": {
          "skill": "secretary",
          "routeKind": "generic_skill_answer",
          "riskClass": "low",
          "groundingRequired": "none",
          "expectedResponseShape": "direct_answer",
          "language": "en",
          "confidence": 0.9,
          "ambiguityReasons": [],
          "telemetryLabel": "chat.skill.secretary",
          "internetEligible": false
        },
        "groundingFacts": [
          {
            "statement": "Authenticated user and tenant scope are present for this chat turn.",
            "source": "auth.scope",
            "field": "userId,tenantId"
          },
          {
            "statement": "Secretary is the current owner skill for this response.",
            "source": "chat.skill_capability_registry",
            "field": "ownerSkill"
          },
          {
            "statement": "Backend returned scoped authenticated_identity metadata for this answer.",
            "source": "chat.context.metadata.authenticated_identity",
            "field": "context"
          },
          {
            "statement": "Server-side deterministic read produced this response.",
            "source": "auth.session"
          }
        ],
        "finalAnswerComposition": {
          "version": "nexus_final_answer_composer.v1",
          "ok": true,
          "issues": [],
          "mode": "templated",
          "draftSchemaVersion": "nexus_composed_answer_draft.v1"
        },
        "responseQuality": {
          "status": "pass",
          "issues": [],
          "score": 1,
          "qualityGateDisabled": false,
          "qualityGateSkipped": false,
          "qualityGateReason": "pass"
        },
        "fallbackPolicy": {
          "operationKind": "read_only_answer",
          "fallbackAllowed": true,
          "mayUseCachedData": true,
          "requiresFreshnessLabel": false,
          "mayClaimSuccess": false,
          "retryable": false,
          "userActionRequired": false,
          "operatorActionRequired": false,
          "responseMode": "answer",
          "reason": "Read-only answers may use cached or degraded facts when freshness is visible."
        }
      },
      "timestamp": "<ts>",
      "responseBlocks": [
        {
          "kind": "paragraph",
          "text": "This authenticated session is signed in as Test User. I will only use data tied to this account and tenant."
        }
      ]
    }
  },
  cancel_empty: {
    "statusCode": 200,
    "body": {
      "id": "msg-<ts>",
      "text": "There is no pending action to cancel.",
      "domain": "secretary",
      "routeMethod": "pending-action-cancel-empty",
      "confidence": 1,
      "buttons": null,
      "metadata": {
        "type": "pending_action_cancel_empty",
        "cancelled": {
          "chatPendingActions": 0,
          "chatActionRuns": 0,
          "chatPendingConfirmation": false,
          "chatCoreV2Commands": 0,
          "decisionDismissed": false
        },
        "mutationBlocked": true,
        "chatReasoning": {
          "version": "nexus_answer_contract.v1",
          "intent": "secretary.destructive",
          "ownerSkill": "secretary",
          "routeKind": "action",
          "groundingRequirement": "local",
          "expectedResponseShape": "agenda_summary",
          "language": "en",
          "ambiguityReasons": [],
          "routeMethod": "pending-action-cancel-empty",
          "confidence": 0.9,
          "groundingFacts": [
            {
              "statement": "Authenticated user and tenant scope are present for this chat turn.",
              "source": "auth.scope",
              "field": "userId,tenantId",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            },
            {
              "statement": "Secretary is the current owner skill for this response.",
              "source": "chat.skill_capability_registry",
              "field": "ownerSkill",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            },
            {
              "statement": "Backend returned scoped pending_action_cancel_empty metadata for this answer.",
              "source": "chat.context.metadata.pending_action_cancel_empty",
              "field": "context",
              "freshness": "fresh",
              "confidence": 0.85,
              "safeForUser": true
            },
            {
              "statement": "Server-side deterministic read produced this response.",
              "source": "chat.pending_work_cancellation.empty",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            }
          ],
          "missingFacts": [
            "date",
            "time",
            "title"
          ],
          "staleness": "fresh",
          "riskLevel": "high",
          "actionability": "answer_only",
          "verificationStatus": "not_required",
          "fallbackUsed": false,
          "fallback": {
            "fallbackType": "none",
            "retryable": false,
            "sourceFreshness": "fresh",
            "userActionRequired": false,
            "operatorActionRequired": false
          },
          "userFacingSummary": "There is no pending action to cancel.",
          "nextBestActions": [
            {
              "id": "clarify_missing_facts",
              "label": "Clarify missing details",
              "kind": "ask",
              "targetSkill": "secretary"
            }
          ],
          "traceId": "<traceId>",
          "latency": "<latency>"
        },
        "chatTurnContract": {
          "skill": "secretary",
          "routeKind": "action",
          "riskClass": "destructive",
          "groundingRequired": "local",
          "expectedResponseShape": "agenda_summary",
          "language": "en",
          "confidence": 0.9,
          "ambiguityReasons": [],
          "telemetryLabel": "chat.skill.secretary",
          "internetEligible": false
        },
        "groundingFacts": [
          {
            "statement": "Authenticated user and tenant scope are present for this chat turn.",
            "source": "auth.scope",
            "field": "userId,tenantId"
          },
          {
            "statement": "Secretary is the current owner skill for this response.",
            "source": "chat.skill_capability_registry",
            "field": "ownerSkill"
          },
          {
            "statement": "Backend returned scoped pending_action_cancel_empty metadata for this answer.",
            "source": "chat.context.metadata.pending_action_cancel_empty",
            "field": "context"
          },
          {
            "statement": "Server-side deterministic read produced this response.",
            "source": "chat.pending_work_cancellation.empty"
          }
        ],
        "finalAnswerComposition": {
          "version": "nexus_final_answer_composer.v1",
          "ok": true,
          "issues": [],
          "mode": "templated",
          "draftSchemaVersion": "nexus_composed_answer_draft.v1"
        },
        "responseQuality": {
          "status": "pass",
          "issues": [],
          "score": 1,
          "qualityGateDisabled": false,
          "qualityGateSkipped": false,
          "qualityGateReason": "pass"
        },
        "fallbackPolicy": {
          "operationKind": "read_only_answer",
          "fallbackAllowed": true,
          "mayUseCachedData": true,
          "requiresFreshnessLabel": false,
          "mayClaimSuccess": false,
          "retryable": false,
          "userActionRequired": false,
          "operatorActionRequired": false,
          "responseMode": "clarify",
          "reason": "Read-only answers may use cached or degraded facts when freshness is visible."
        }
      },
      "timestamp": "<ts>",
      "responseBlocks": [
        {
          "kind": "paragraph",
          "text": "There is no pending action to cancel."
        }
      ]
    }
  },
  cancel_pending: {
    "statusCode": 200,
    "body": {
      "id": "msg-<ts>",
      "text": "Cancelled. I will not continue that pending action.",
      "domain": "secretary",
      "routeMethod": "pending-action-cancelled",
      "confidence": 1,
      "buttons": null,
      "metadata": {
        "type": "pending_action_cancelled",
        "cancelled": {
          "chatPendingActions": 1,
          "chatActionRuns": 0,
          "chatPendingConfirmation": false,
          "chatCoreV2Commands": 0,
          "decisionDismissed": false
        },
        "mutationBlocked": true,
        "chatReasoning": {
          "version": "nexus_answer_contract.v1",
          "intent": "secretary.destructive",
          "ownerSkill": "secretary",
          "routeKind": "action",
          "groundingRequirement": "local",
          "expectedResponseShape": "agenda_summary",
          "language": "en",
          "ambiguityReasons": [],
          "routeMethod": "pending-action-cancelled",
          "confidence": 0.9,
          "groundingFacts": [
            {
              "statement": "Authenticated user and tenant scope are present for this chat turn.",
              "source": "auth.scope",
              "field": "userId,tenantId",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            },
            {
              "statement": "Secretary is the current owner skill for this response.",
              "source": "chat.skill_capability_registry",
              "field": "ownerSkill",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            },
            {
              "statement": "Backend returned scoped pending_action_cancelled metadata for this answer.",
              "source": "chat.context.metadata.pending_action_cancelled",
              "field": "context",
              "freshness": "fresh",
              "confidence": 0.85,
              "safeForUser": true
            },
            {
              "statement": "Server-side deterministic read produced this response.",
              "source": "chat.pending_work_cancellation",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            }
          ],
          "missingFacts": [
            "date",
            "time",
            "title"
          ],
          "staleness": "fresh",
          "riskLevel": "high",
          "actionability": "answer_only",
          "verificationStatus": "not_required",
          "fallbackUsed": false,
          "fallback": {
            "fallbackType": "none",
            "retryable": false,
            "sourceFreshness": "fresh",
            "userActionRequired": false,
            "operatorActionRequired": false
          },
          "userFacingSummary": "Cancelled. I will not continue that pending action.",
          "nextBestActions": [
            {
              "id": "clarify_missing_facts",
              "label": "Clarify missing details",
              "kind": "ask",
              "targetSkill": "secretary"
            }
          ],
          "traceId": "<traceId>",
          "latency": "<latency>"
        },
        "chatTurnContract": {
          "skill": "secretary",
          "routeKind": "action",
          "riskClass": "destructive",
          "groundingRequired": "local",
          "expectedResponseShape": "agenda_summary",
          "language": "en",
          "confidence": 0.9,
          "ambiguityReasons": [],
          "telemetryLabel": "chat.skill.secretary",
          "internetEligible": false
        },
        "groundingFacts": [
          {
            "statement": "Authenticated user and tenant scope are present for this chat turn.",
            "source": "auth.scope",
            "field": "userId,tenantId"
          },
          {
            "statement": "Secretary is the current owner skill for this response.",
            "source": "chat.skill_capability_registry",
            "field": "ownerSkill"
          },
          {
            "statement": "Backend returned scoped pending_action_cancelled metadata for this answer.",
            "source": "chat.context.metadata.pending_action_cancelled",
            "field": "context"
          },
          {
            "statement": "Server-side deterministic read produced this response.",
            "source": "chat.pending_work_cancellation"
          }
        ],
        "finalAnswerComposition": {
          "version": "nexus_final_answer_composer.v1",
          "ok": true,
          "issues": [],
          "mode": "templated",
          "draftSchemaVersion": "nexus_composed_answer_draft.v1"
        },
        "responseQuality": {
          "status": "pass",
          "issues": [],
          "score": 1,
          "qualityGateDisabled": false,
          "qualityGateSkipped": false,
          "qualityGateReason": "pass"
        },
        "fallbackPolicy": {
          "operationKind": "read_only_answer",
          "fallbackAllowed": true,
          "mayUseCachedData": true,
          "requiresFreshnessLabel": false,
          "mayClaimSuccess": false,
          "retryable": false,
          "userActionRequired": false,
          "operatorActionRequired": false,
          "responseMode": "clarify",
          "reason": "Read-only answers may use cached or degraded facts when freshness is visible."
        }
      },
      "timestamp": "<ts>",
      "responseBlocks": [
        {
          "kind": "paragraph",
          "text": "Cancelled. I will not continue that pending action."
        }
      ]
    }
  },
  planner_confirmation: {
    "statusCode": 202,
    "body": {
      "id": "msg-<ts>",
      "text": "Should I delete the task \"old task\"?",
      "domain": "secretary",
      "routeMethod": "action-planner",
      "confidence": 0.92,
      "buttons": null,
      "metadata": {
        "type": "chat_action_plan",
        "actionStatus": "needs_confirmation",
        "pendingConfirmation": {
          "kind": "pending_confirmation",
          "id": "<pendingId>",
          "intent_class": "task_delete",
          "intentClass": "task_delete",
          "summary": {
            "text": "Should I delete the task \"old task\"?",
            "steps": [
              {
                "skill": "tasks",
                "action": "delete_task",
                "risk": "destructive",
                "args": {
                  "taskId": "task-1"
                }
              }
            ]
          },
          "actionSummary": "Should I delete the task \"old task\"?",
          "confirmation_token": "<token>",
          "confirmationToken": "<token>",
          "expires_at": "<ts>",
          "expiresAt": "<ts>",
          "sourceMessageId": "msg-user-<ts>",
          "decisionId": "<decisionId>"
        },
        "actionConfirmation": {
          "variant": "destructive",
          "destructive": true,
          "requiresStrongConfirm": false,
          "intentClass": "task_delete",
          "confirmationToken": "<token>",
          "expiresAt": "<ts>",
          "summary": {
            "text": "Should I delete the task \"old task\"?",
            "steps": [
              {
                "skill": "tasks",
                "action": "delete_task",
                "risk": "destructive",
                "args": {
                  "taskId": "task-1"
                }
              }
            ]
          },
          "actionLabel": "Confirm",
          "cancelLabel": "Cancel"
        }
      },
      "timestamp": "<ts>"
    }
  },
  training_plan_shortcut: {
    "statusCode": 200,
    "body": {
      "id": "msg-<ts>",
      "text": "🏋️ To create a personalized training plan, go to the **Training** tab and tap **Create Plan**.\n\nThe plan will be generated based on your profile and automatically schedule workouts in your calendar.",
      "domain": "triathlon",
      "routeMethod": "plan-shortcut",
      "confidence": 1,
      "buttons": null,
      "metadata": {
        "type": "nexus_answer",
        "chatReasoning": {
          "version": "nexus_answer_contract.v1",
          "intent": "training.create",
          "ownerSkill": "training",
          "routeKind": "action",
          "groundingRequirement": "local",
          "expectedResponseShape": "training_advice",
          "language": "en",
          "ambiguityReasons": [],
          "routeMethod": "plan-shortcut",
          "confidence": 0.9,
          "groundingFacts": [
            {
              "statement": "Authenticated user and tenant scope are present for this chat turn.",
              "source": "auth.scope",
              "field": "userId,tenantId",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            },
            {
              "statement": "Training is the current owner skill for this response.",
              "source": "chat.skill_capability_registry",
              "field": "ownerSkill",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            }
          ],
          "missingFacts": [
            "date",
            "sessionOrPlanReference"
          ],
          "staleness": "fresh",
          "riskLevel": "medium",
          "actionability": "preview",
          "verificationStatus": "not_required",
          "fallbackUsed": false,
          "fallback": {
            "fallbackType": "none",
            "retryable": false,
            "sourceFreshness": "fresh",
            "userActionRequired": false,
            "operatorActionRequired": false
          },
          "userFacingSummary": "🏋️ To create a personalized training plan, go to the **Training** tab and tap **Create Plan**.\n\nThe plan will be generated based on your profile and automatically schedule workouts in your calendar.",
          "nextBestActions": [
            {
              "id": "clarify_missing_facts",
              "label": "Clarify missing details",
              "kind": "ask",
              "targetSkill": "training"
            }
          ],
          "traceId": "<traceId>",
          "latency": "<latency>"
        },
        "chatTurnContract": {
          "skill": "training",
          "routeKind": "action",
          "riskClass": "medium",
          "groundingRequired": "local",
          "expectedResponseShape": "training_advice",
          "language": "en",
          "confidence": 0.9,
          "ambiguityReasons": [],
          "telemetryLabel": "chat.skill.training",
          "internetEligible": false
        },
        "groundingFacts": [
          {
            "statement": "Authenticated user and tenant scope are present for this chat turn.",
            "source": "auth.scope",
            "field": "userId,tenantId"
          },
          {
            "statement": "Training is the current owner skill for this response.",
            "source": "chat.skill_capability_registry",
            "field": "ownerSkill"
          }
        ],
        "finalAnswerComposition": {
          "version": "nexus_final_answer_composer.v1",
          "ok": true,
          "issues": [],
          "mode": "model_constrained",
          "draftSchemaVersion": "nexus_composed_answer_draft.v1"
        },
        "responseQuality": {
          "status": "pass",
          "issues": [],
          "score": 1,
          "qualityGateDisabled": false,
          "qualityGateSkipped": false,
          "qualityGateReason": "pass"
        },
        "fallbackPolicy": {
          "operationKind": "mutating_action",
          "fallbackAllowed": false,
          "mayUseCachedData": false,
          "requiresFreshnessLabel": true,
          "mayClaimSuccess": false,
          "retryable": false,
          "userActionRequired": true,
          "operatorActionRequired": false,
          "responseMode": "blocked",
          "reason": "Mutating actions cannot use fallback as proof of success; read-back verification is required."
        }
      },
      "timestamp": "<ts>",
      "responseBlocks": [
        {
          "kind": "paragraph",
          "text": [
            {
              "kind": "text",
              "text": "🏋️ To create a personalized training plan, go to the "
            },
            {
              "kind": "bold",
              "text": "Training"
            },
            {
              "kind": "text",
              "text": " tab and tap "
            },
            {
              "kind": "bold",
              "text": "Create Plan"
            },
            {
              "kind": "text",
              "text": "."
            }
          ]
        },
        {
          "kind": "paragraph",
          "text": "The plan will be generated based on your profile and automatically schedule workouts in your calendar."
        }
      ]
    }
  },
  destructive_hold: {
    "statusCode": 200,
    "body": {
      "id": "msg-<ts>",
      "text": "Before I make a destructive change, I need explicit confirmation. Please confirm the exact action you want, including the affected item, plan, event, or message. I will not delete, cancel, send, or clear anything without that confirmation.",
      "domain": "secretary",
      "routeMethod": "confirmation-required",
      "confidence": 0.92,
      "buttons": null,
      "metadata": {
        "type": "chat_action_confirmation_required",
        "actionStatus": "needs_confirmation",
        "involvedSkills": [
          "secretary"
        ],
        "reasonCodes": [
          "destructive_or_external_side_effect",
          "explicit_confirmation_missing"
        ],
        "unresolvedBlockers": [
          "target_identity_required",
          "explicit_confirmation_required"
        ],
        "responseSufficiency": {
          "actionStatus": "needs_confirmation",
          "responseSufficient": false,
          "requiresConfirmation": true,
          "needsClarification": false,
          "unresolvedBlockers": [
            "target_identity_required",
            "explicit_confirmation_required"
          ],
          "contextSources": [],
          "weakContextSignals": []
        },
        "actionConfirmation": {
          "title": "Confirmation needed",
          "message": "delete all my calendar events",
          "destructive": true,
          "variant": "destructive",
          "requiresStrongConfirm": false,
          "intentClass": "secretary_write",
          "confirmationToken": "<token>",
          "expiresAt": "<ts>",
          "summary": {
            "text": "delete all my calendar events",
            "involvedSkills": [
              "secretary"
            ],
            "reasonCodes": [
              "destructive_or_external_side_effect",
              "explicit_confirmation_missing"
            ]
          },
          "actionLabel": "Confirm",
          "cancelLabel": "Cancel"
        },
        "chatReasoning": {
          "version": "nexus_answer_contract.v1",
          "intent": "secretary.destructive",
          "ownerSkill": "secretary",
          "routeKind": "action",
          "groundingRequirement": "local",
          "expectedResponseShape": "agenda_summary",
          "language": "en",
          "ambiguityReasons": [],
          "routeMethod": "confirmation-required",
          "confidence": 0.9,
          "groundingFacts": [
            {
              "statement": "Authenticated user and tenant scope are present for this chat turn.",
              "source": "auth.scope",
              "field": "userId,tenantId",
              "freshness": "fresh",
              "confidence": 1,
              "safeForUser": true
            },
            {
              "statement": "Secretary is the current owner skill for this response.",
              "source": "chat.skill_capability_registry",
              "field": "ownerSkill",
              "freshness": "fresh",
              "confidence": 0.9,
              "safeForUser": true
            },
            {
              "statement": "Backend returned scoped chat_action_confirmation_required metadata for this answer.",
              "source": "chat.context.metadata.chat_action_confirmation_required",
              "field": "context",
              "freshness": "fresh",
              "confidence": 0.85,
              "safeForUser": true
            },
            {
              "statement": "Response sufficiency metadata was available.",
              "source": "chat.context.metadata.response_sufficiency",
              "field": "context",
              "freshness": "fresh",
              "confidence": 0.8,
              "safeForUser": true
            }
          ],
          "missingFacts": [
            "date",
            "time",
            "title"
          ],
          "staleness": "fresh",
          "riskLevel": "high",
          "actionability": "preview",
          "verificationStatus": "pending",
          "fallbackUsed": false,
          "fallback": {
            "fallbackType": "none",
            "retryable": false,
            "sourceFreshness": "fresh",
            "userActionRequired": false,
            "operatorActionRequired": false
          },
          "userFacingSummary": "Before I make a destructive change, I need explicit confirmation. Please confirm the exact action you want, including the affected item, plan, event, or message. I will not delete, cancel, send, or clear anything without that confirmation.",
          "nextBestActions": [
            {
              "id": "clarify_missing_facts",
              "label": "Clarify missing details",
              "kind": "ask",
              "targetSkill": "secretary"
            }
          ],
          "traceId": "<traceId>",
          "latency": "<latency>"
        },
        "chatTurnContract": {
          "skill": "secretary",
          "routeKind": "action",
          "riskClass": "destructive",
          "groundingRequired": "local",
          "expectedResponseShape": "agenda_summary",
          "language": "en",
          "confidence": 0.9,
          "ambiguityReasons": [],
          "telemetryLabel": "chat.skill.secretary",
          "internetEligible": false
        },
        "groundingFacts": [
          {
            "statement": "Authenticated user and tenant scope are present for this chat turn.",
            "source": "auth.scope",
            "field": "userId,tenantId"
          },
          {
            "statement": "Secretary is the current owner skill for this response.",
            "source": "chat.skill_capability_registry",
            "field": "ownerSkill"
          },
          {
            "statement": "Backend returned scoped chat_action_confirmation_required metadata for this answer.",
            "source": "chat.context.metadata.chat_action_confirmation_required",
            "field": "context"
          },
          {
            "statement": "Response sufficiency metadata was available.",
            "source": "chat.context.metadata.response_sufficiency",
            "field": "context"
          }
        ],
        "finalAnswerComposition": {
          "version": "nexus_final_answer_composer.v1",
          "ok": true,
          "issues": [],
          "mode": "model_constrained",
          "draftSchemaVersion": "nexus_composed_answer_draft.v1"
        },
        "responseQuality": {
          "status": "pass",
          "issues": [],
          "score": 1,
          "qualityGateDisabled": false,
          "qualityGateSkipped": false,
          "qualityGateReason": "pass"
        },
        "fallbackPolicy": {
          "operationKind": "mutating_action",
          "fallbackAllowed": false,
          "mayUseCachedData": false,
          "requiresFreshnessLabel": true,
          "mayClaimSuccess": false,
          "retryable": false,
          "userActionRequired": true,
          "operatorActionRequired": false,
          "responseMode": "blocked",
          "reason": "Mutating actions cannot use fallback as proof of success; read-back verification is required."
        },
        "pendingConfirmation": {
          "kind": "pending_confirmation",
          "id": "<pendingId>",
          "intent_class": "secretary_write",
          "intentClass": "secretary_write",
          "summary": {
            "text": "delete all my calendar events",
            "involvedSkills": [
              "secretary"
            ],
            "reasonCodes": [
              "destructive_or_external_side_effect",
              "explicit_confirmation_missing"
            ]
          },
          "actionSummary": "delete all my calendar events",
          "confirmation_token": "<token>",
          "confirmationToken": "<token>",
          "expires_at": "<ts>",
          "expiresAt": "<ts>",
          "sourceMessageId": "msg-user-<ts>",
          "decisionId": "<decisionId>"
        }
      },
      "timestamp": "<ts>",
      "responseBlocks": [
        {
          "kind": "paragraph",
          "text": "Before I make a destructive change, I need explicit confirmation. Please confirm the exact action you want, including the affected item, plan, event, or message. I will not delete, cancel, send, or clear anything without that confirmation."
        }
      ]
    }
  },
  unknown_domain: {
    "statusCode": 400,
    "body": {
      "error": {
        "code": "UNKNOWN_DOMAIN",
        "message": "No handler for domain: not_a_domain"
      }
    }
  },
};
