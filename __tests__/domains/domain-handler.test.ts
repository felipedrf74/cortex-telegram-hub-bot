/**
 * Domain Handler Tests
 *
 * Tests the shared domain handler logic:
 * - Coach state (setLastCoachState / getLastCoachState) with TTL expiry
 * - buildSimpleStateContext: assembles context from todos, shared memory, coach recs
 * - handleSimpleDomain: the full tool-use loop with conversation history management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

// ─── Mock all dependencies ──────────────────────────────────────────

// Mock provider-registry: the routing provider that domain-handler now uses
const mockCallDomainFn = vi.fn();
const mockContinueFn = vi.fn();
const mockGetActiveProvider = vi.fn();
const mockEnsureActiveProvider = vi.fn();

vi.mock('../../src/services/provider-registry', () => ({
  getActiveProvider: (...args: unknown[]) => mockGetActiveProvider(...args),
  ensureActiveProvider: (...args: unknown[]) => mockEnsureActiveProvider(...args),
}));

// Keep backward-compat mock for the fallback path
vi.mock('../../src/services/anthropic', () => ({
  callDomain: vi.fn(),
  continueWithToolResults: vi.fn(),
}));

vi.mock('../../src/state/conversation', () => ({
  getConversationHistory: vi.fn().mockReturnValue([]),
  addToConversation: vi.fn(),
}));

vi.mock('../../src/state/todos', () => ({
  listTodos: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/state/shared-memory', () => ({
  getSharedMemorySummary: vi.fn().mockReturnValue(''),
  getSharedMemory: vi.fn().mockReturnValue([]),
  getSharedMemoryByScope: vi.fn().mockReturnValue({ userPrivate: [], tenantShared: [] }),
}));

vi.mock('../../src/services/tool-executor', () => ({
  executeToolCall: vi.fn(),
}));

vi.mock('../../src/utils/date-parser', () => ({
  now: vi.fn(),
  formatDateTime: vi.fn((d: string) => d),
  startOfDay: vi.fn().mockReturnValue('2026-03-30T00:00:00'),
  endOfDay: vi.fn().mockReturnValue('2026-03-30T23:59:59'),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

// ─── Imports ─────────────────────────────────────────────────────────

import {
  setLastCoachState,
  getLastCoachState,
  buildSimpleStateContext,
  handleSimpleDomain,
  __resetLastCoachStateCacheForTests,
} from '../../src/domains/domain-handler';

import { getConversationHistory, addToConversation } from '../../src/state/conversation';
import { listTodos } from '../../src/state/todos';
import { getSharedMemorySummary } from '../../src/state/shared-memory';
import { executeToolCall } from '../../src/services/tool-executor';
import { now } from '../../src/utils/date-parser';
import { callDomain, continueWithToolResults } from '../../src/services/anthropic';

// Use the provider-routed mocks (domain-handler now calls getActiveProvider().callDomain)
const mockCallDomain = mockCallDomainFn;
const mockContinue = mockContinueFn;
const mockExecuteTool = vi.mocked(executeToolCall);
const mockDirectAnthropicCall = vi.mocked(callDomain);
const mockDirectAnthropicContinue = vi.mocked(continueWithToolResults);

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch {
        // Some migrations depend on runtime-only services; these tests only
        // need the coach/callback schema that applies cleanly in isolation.
      }
    }
  }
}

function ensureUser(userId: number): void {
  testDb.prepare(`
    INSERT OR IGNORE INTO users (
      id,
      telegram_id,
      first_name,
      language,
      timezone,
      tier,
      status,
      auth_provider,
      created_at,
      last_active_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(userId, userId, `Test ${userId}`, 'en-US', 'Europe/Lisbon', 'pro', 'active', 'telegram');
}

// ─── Shared setup: reset now() mock for every test ──────────────────

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
  __resetLastCoachStateCacheForTests();
  delete process.env.ANTHROPIC_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  mockGetActiveProvider.mockReturnValue({
    name: 'mock-provider',
    callDomain: (...args: any[]) => mockCallDomainFn(...args),
    continueWithToolResults: (...args: any[]) => mockContinueFn(...args),
    classify: vi.fn(),
  });
  mockEnsureActiveProvider.mockReturnValue(null);
  vi.mocked(now).mockReturnValue({
    toFormat: vi.fn().mockReturnValue('Monday, March 30 2026, 10:00'),
    minus: vi.fn().mockReturnValue({ toFormat: vi.fn().mockReturnValue('2026-03-27') }),
  } as any);
});

afterEach(() => {
  __resetLastCoachStateCacheForTests();
  testDb?.close();
});

// ═══════════════════════════════════════════════════════════════════
// Coach State
// ═══════════════════════════════════════════════════════════════════

describe('Coach state management', () => {

  it('stores and retrieves coach state by userId', () => {
    const recs = [{ action: 'MODIFY', eventId: 'e1', source: 'outlook', originalTitle: 'Run', summary: 'Reduce intensity', newTitle: 'Easy run', newStart: '', newEnd: '' }];
    setLastCoachState(123, recs as any, 'Reduce training load');
    const state = getLastCoachState(123);
    expect(state).not.toBeNull();
    expect(state!.recommendations).toEqual(recs);
    expect(state!.briefingSummary).toBe('Reduce training load');
  });

  it('returns null for unknown userId', () => {
    expect(getLastCoachState(999)).toBeNull();
  });

  it('returns null when state is expired', () => {
    const recs = [{ action: 'KEEP', eventId: 'e1', source: 'google', originalTitle: 'Swim', summary: 'Good to go' }];
    setLastCoachState(100, recs as any, 'All good');

    // Advance time past TTL (12 hours)
    const realNow = Date.now;
    Date.now = () => realNow() + 13 * 60 * 60 * 1000;
    expect(getLastCoachState(100)).toBeNull();
    Date.now = realNow;
  });

  it('reloads persisted coach state after the in-memory cache is cleared', () => {
    ensureUser(321);
    const recs = [{ action: 'SWAP', eventId: 'evt-cache', source: 'outlook', originalTitle: 'Intervals', summary: 'Swap for easy spin', newTitle: 'Easy spin', newStart: null, newEnd: null }];
    setLastCoachState(321, recs as any, 'Swap intervals for recovery spin');

    __resetLastCoachStateCacheForTests();

    const state = getLastCoachState(321);
    expect(state).not.toBeNull();
    expect(state!.recommendations).toEqual(recs);
    expect(state!.briefingSummary).toBe('Swap intervals for recovery spin');
  });
});

// ═══════════════════════════════════════════════════════════════════
// buildSimpleStateContext
// ═══════════════════════════════════════════════════════════════════

describe('buildSimpleStateContext', () => {
  beforeEach(() => {
    vi.mocked(listTodos).mockReturnValue([]);
    vi.mocked(getSharedMemorySummary).mockReturnValue('');
  });

  it('includes the current date', async () => {
    const ctx = await buildSimpleStateContext('triathlon', 42);
    expect(ctx).toContain('Monday, March 30 2026');
  });

  it('includes pending todos for the domain', async () => {
    vi.mocked(listTodos).mockReturnValue([
      { id: 1, title: 'Long run', priority: 'high', due_date: '2026-04-01', domain: 'triathlon', description: null, status: 'pending', tags: null, created_at: '', updated_at: '', completed_at: null },
    ] as any);

    const ctx = await buildSimpleStateContext('triathlon', 42);
    expect(ctx).toContain('Triathlon to-dos (1)');
    expect(ctx).toContain('[high] Long run');
    expect(ctx).toContain('due: 2026-04-01');
  });

  it('does not attach scoped Nexus context to generic Cooking recipe requests', async () => {
    vi.mocked(listTodos).mockReturnValue([
      { id: 2, title: 'Meal prep local state', priority: 'medium', due_date: null, domain: 'cooking', description: null, status: 'pending', tags: null, created_at: '', updated_at: '', completed_at: null },
    ] as any);
    vi.mocked(getSharedMemorySummary).mockReturnValue('[Shared] local cooking preference');

    const ctx = await buildSimpleStateContext('cooking', 42, 'Me indique uma receita de kibe de forno para 3 pessoas');

    expect(ctx).toContain('Monday, March 30 2026');
    expect(ctx).not.toContain('Cooking to-dos');
    expect(ctx).not.toContain('Meal prep local state');
    expect(ctx).not.toContain('[Shared] local cooking preference');
  });

  it('does not attach scoped Nexus context to generic Finance explanation requests', async () => {
    vi.mocked(listTodos).mockReturnValue([
      { id: 3, title: 'Review local budget', priority: 'high', due_date: null, domain: 'finance', description: null, status: 'pending', tags: null, created_at: '', updated_at: '', completed_at: null },
    ] as any);
    vi.mocked(getSharedMemorySummary).mockReturnValue('[Shared] local finance state');

    const ctx = await buildSimpleStateContext('finance', 42, 'Explain deductible expense categories');

    expect(ctx).toContain('Monday, March 30 2026');
    expect(ctx).not.toContain('Finance to-dos');
    expect(ctx).not.toContain('Review local budget');
    expect(ctx).not.toContain('[Shared] local finance state');
  });

  it('includes scoped Nexus context when Cooking asks for local meal-plan state', async () => {
    vi.mocked(listTodos).mockReturnValue([
      { id: 4, title: 'Plan local meals', priority: 'medium', due_date: null, domain: 'cooking', description: null, status: 'pending', tags: null, created_at: '', updated_at: '', completed_at: null },
    ] as any);
    vi.mocked(getSharedMemorySummary).mockReturnValue('[Shared] local cooking preference');

    const ctx = await buildSimpleStateContext('cooking', 42, 'What meals did I plan this week?');

    expect(ctx).toContain('Cooking to-dos');
    expect(ctx).toContain('Plan local meals');
    expect(ctx).toContain('[Shared] local cooking preference');
  });

  it('marks empty scoped local-read context so the model cannot invent local facts', async () => {
    const ctx = await buildSimpleStateContext('secretary', 42, 'show my latest tasks');

    expect(ctx).toContain('Local grounding rule: answer only from scoped Nexus facts listed above.');
    expect(ctx).toContain('say no matching local records were found instead of inventing it.');
  });

  it('keeps scoped training context for prescription requests even before local grounding is inferred', async () => {
    vi.mocked(listTodos).mockReturnValue([
      { id: 5, title: 'Finish run profile', priority: 'high', due_date: null, domain: 'triathlon', description: null, status: 'pending', tags: null, created_at: '', updated_at: '', completed_at: null },
    ] as any);

    const ctx = await buildSimpleStateContext('triathlon', 42, 'Build me a running workout for tomorrow');

    expect(ctx).toContain('Triathlon to-dos');
    expect(ctx).toContain('Finish run profile');
  });

  it('includes coach recommendations for triathlon domain with userId', async () => {
    const recs = [{
      action: 'MODIFY', eventId: 'evt1', source: 'outlook',
      originalTitle: 'Tempo Run', newTitle: 'Easy Run',
      newStart: '2026-04-01T07:00', newEnd: '2026-04-01T08:00',
      summary: 'Recovery needed',
    }];
    setLastCoachState(42, recs as any, 'Reduce load');

    const ctx = await buildSimpleStateContext('triathlon', 42);
    expect(ctx).toContain('COACH RECOMMENDATIONS');
    expect(ctx).toContain('action: MODIFY');
    expect(ctx).toContain('event_id: "evt1"');
    expect(ctx).toContain('new_title: "Easy Run"');
  });

  it('does NOT include coach state for non-triathlon domain', async () => {
    const recs = [{ action: 'KEEP', eventId: 'e1', source: 'google', originalTitle: 'Swim', summary: 'OK' }];
    setLastCoachState(42, recs as any, 'OK');

    const ctx = await buildSimpleStateContext('secretary', 42);
    expect(ctx).not.toContain('COACH RECOMMENDATIONS');
  });

  it('includes onboarding-pending context for prescriptive training asks when profile data is missing', async () => {
    ensureUser(77);

    const ctx = await buildSimpleStateContext('triathlon', 77, 'build me a running workout for tomorrow');

    expect(ctx).toContain('<onboarding_pending');
    expect(ctx).toContain('Before generating any specific training prescription');
  });

  it('skips onboarding-pending context for existing-plan review and adjustment questions', async () => {
    ensureUser(78);

    const ctx = await buildSimpleStateContext('triathlon', 78, "is tomorrow's tempo ride too much after the heavy leg load?");

    expect(ctx).not.toContain('<onboarding_pending');
  });

  it('includes shared memory summary when present', async () => {
    vi.mocked(getSharedMemorySummary).mockReturnValue('[Shared] A-race: Ironman');

    const ctx = await buildSimpleStateContext('triathlon', 42);
    expect(ctx).toContain('[Shared] A-race: Ironman');
  });
});

// ═══════════════════════════════════════════════════════════════════
// handleSimpleDomain
// ═══════════════════════════════════════════════════════════════════

describe('handleSimpleDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationHistory).mockReturnValue([]);
    vi.mocked(listTodos).mockReturnValue([]);
    vi.mocked(getSharedMemorySummary).mockReturnValue('');
  });

  it('returns text response when no tool calls', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Your next race is in 3 weeks.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSimpleDomain('triathlon', 'When is my next race?');
    expect(result).toEqual({ text: 'Your next race is in 3 weeks.', domain: 'triathlon' });
    expect(mockCallDomain).toHaveBeenCalledOnce();
  });

  it('returns an honest unavailable response when no routed provider exists and Anthropic direct fallback is disabled', async () => {
    mockGetActiveProvider.mockReturnValue(null);
    mockEnsureActiveProvider.mockReturnValue(null);

    const result = await handleSimpleDomain('triathlon', 'Can you adjust my training today?', 5, 15);

    expect(result).toEqual({
      text: 'O chat com IA está temporariamente indisponível neste ambiente porque não há nenhum provedor configurado. As visualizações diretas e outras ações determinísticas continuam funcionando normalmente.',
      domain: 'triathlon',
    });
    expect(mockDirectAnthropicCall).not.toHaveBeenCalled();
  });

  it('stores user and assistant messages in conversation history', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Here is your plan.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    await handleSimpleDomain('content', 'Write a hook', 5, 42);
    expect(addToConversation).toHaveBeenCalledWith(42, 'content', 'user', 'Write a hook');
    expect(addToConversation).toHaveBeenCalledWith(42, 'content', 'assistant', 'Here is your plan.');
  });

  it('lazily initializes the routing provider when the active singleton is cold', async () => {
    mockGetActiveProvider.mockReturnValueOnce(null);
    mockEnsureActiveProvider.mockReturnValue({
      name: 'lazy-provider',
      callDomain: (...args: any[]) => mockCallDomainFn(...args),
      continueWithToolResults: (...args: any[]) => mockContinueFn(...args),
      classify: vi.fn(),
    });
    mockCallDomain.mockResolvedValue({
      text: 'Recovered.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSimpleDomain('triathlon', 'hello', 5, 15);

    expect(result).toEqual({ text: 'Recovered.', domain: 'triathlon' });
    expect(mockEnsureActiveProvider).toHaveBeenCalledOnce();
  });

  it('executes tool calls and returns final text', async () => {
    // First call returns a tool call
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{ type: 'tool_use', id: 'tc_1', name: 'get_calendar_events', input: { start_date: '2026-03-30', end_date: '2026-04-06' } }],
      stopReason: 'tool_use',
    } as any);
    mockExecuteTool.mockResolvedValue([{ id: 'evt1', title: 'Team call' }]);

    // continueWithToolResults returns final text
    mockContinue.mockResolvedValue({
      text: 'You have a team call this week.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSimpleDomain('triathlon', 'What is on my calendar?', 5, 15);
    expect(result.text).toBe('You have a team call this week.');
    expect(mockExecuteTool).toHaveBeenCalledWith('get_calendar_events', { start_date: '2026-03-30', end_date: '2026-04-06' }, 15);
    expect(mockContinue).toHaveBeenCalledOnce();
  });

  it('prefixes stored text with [Tools: ...] when tools are used', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{ type: 'tool_use', id: 'tc_1', name: 'save_note', input: {} }],
      stopReason: 'tool_use',
    } as any);
    mockExecuteTool.mockResolvedValue({ id: 1 });
    mockContinue.mockResolvedValue({
      text: 'Note saved.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    await handleSimpleDomain('triathlon', 'Save this note', 5, 88);

    const storedCall = vi.mocked(addToConversation).mock.calls.find(
      (c) => c[2] === 'assistant',
    );
    expect(storedCall![3]).toContain('[Tools: save_note]');
    expect(storedCall![3]).toContain('Note saved.');
  });

  it('deduplicates tool names in the prefix', async () => {
    // Two iterations, both calling the same tool
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [
        { type: 'tool_use', id: 'tc_1', name: 'search_notes', input: { query: 'swim' } },
        { type: 'tool_use', id: 'tc_2', name: 'search_notes', input: { query: 'run' } },
      ],
      stopReason: 'tool_use',
    } as any);
    mockExecuteTool.mockResolvedValue([]);
    mockContinue.mockResolvedValue({
      text: 'Found notes.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    await handleSimpleDomain('triathlon', 'Find my notes', 5, 88);

    const storedCall = vi.mocked(addToConversation).mock.calls.find(
      (c) => c[2] === 'assistant',
    );
    // search_notes should appear only once despite being called twice
    expect(storedCall![3]).toBe('[Tools: search_notes]\nFound notes.');
  });

  it('stops at maxIterations even if tools keep returning', async () => {
    const toolCall = { type: 'tool_use', id: 'tc_1', name: 'set_reminder', input: {} };

    mockCallDomain.mockResolvedValue({
      text: '', toolCalls: [toolCall], stopReason: 'tool_use',
    } as any);
    mockExecuteTool.mockResolvedValue({ id: 1 });

    // continueWithToolResults always returns more tool calls
    mockContinue.mockResolvedValue({
      text: 'Still working...', toolCalls: [toolCall], stopReason: 'tool_use',
    } as any);

    const result = await handleSimpleDomain('triathlon', 'Do something', 3);

    // 1 initial callDomain + 3 continueWithToolResults = 3 iterations max
    expect(mockContinue).toHaveBeenCalledTimes(3);
    expect(result.text).toBe('Still working...');
  });

  it('passes userId to buildSimpleStateContext', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Done.', toolCalls: [], stopReason: 'end_turn',
    } as any);

    // Set up coach state so we can verify it appears in context
    setLastCoachState(77, [{ action: 'KEEP', eventId: 'e1', source: 'google', originalTitle: 'Test', summary: 'OK' }] as any, 'OK');

    await handleSimpleDomain('triathlon', 'Apply coach recs', 5, 77);

    // callDomain receives the stateContext that includes coach recs
    const stateCtx = mockCallDomain.mock.calls[0][3] as string;
    expect(stateCtx).toContain('COACH RECOMMENDATIONS');
  });

  it('passes maxTokensOverride to callDomain', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Long response.', toolCalls: [], stopReason: 'end_turn',
    } as any);

    await handleSimpleDomain('content', 'Write a full script', 5, undefined, 4096);

    // Provider interface: callDomain(domain, history, message, stateContext, options)
    // The options bag preserves model/fallback metadata while keeping routing provider-agnostic.
    expect(mockCallDomain).toHaveBeenCalledWith(
      'content',
      expect.any(Array),
      'Write a full script',
      expect.any(String),
      expect.objectContaining({ maxTokensOverride: 4096 }),
    );
  });

  it('passes tenant scope into the direct Anthropic fallback path before provider calls', async () => {
    process.env.ANTHROPIC_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    mockGetActiveProvider.mockReturnValue(null);
    mockEnsureActiveProvider.mockReturnValue(null);
    mockDirectAnthropicCall.mockResolvedValue({
      text: 'Fallback answer.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    const result = await handleSimpleDomain('secretary', 'What is today?', 5, 77, undefined, 77);

    expect(result).toEqual({ text: 'Fallback answer.', domain: 'secretary' });
    expect(mockDirectAnthropicCall).toHaveBeenCalledWith(
      'secretary',
      expect.any(Array),
      'What is today?',
      expect.any(String),
      expect.objectContaining({
        userId: 77,
        tenantId: 77,
        maxTokensOverride: undefined,
      }),
    );
    expect(mockDirectAnthropicContinue).not.toHaveBeenCalled();
  });

  it('does not persist conversation history when no user scope is provided', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Scoped nowhere.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    await handleSimpleDomain('content', 'Write a hook');

    expect(addToConversation).not.toHaveBeenCalled();
  });
});
