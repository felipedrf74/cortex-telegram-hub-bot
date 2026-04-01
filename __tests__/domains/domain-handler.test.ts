/**
 * Domain Handler Tests
 *
 * Tests the shared domain handler logic:
 * - Coach state (setLastCoachState / getLastCoachState) with TTL expiry
 * - buildSimpleStateContext: assembles context from todos, shared memory, coach recs
 * - handleSimpleDomain: the full tool-use loop with conversation history management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock all dependencies ──────────────────────────────────────────

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
}));

// ─── Imports ─────────────────────────────────────────────────────────

import {
  setLastCoachState,
  getLastCoachState,
  buildSimpleStateContext,
  handleSimpleDomain,
} from '../../src/domains/domain-handler';

import { callDomain, continueWithToolResults } from '../../src/services/anthropic';
import { getConversationHistory, addToConversation } from '../../src/state/conversation';
import { listTodos } from '../../src/state/todos';
import { getSharedMemorySummary } from '../../src/state/shared-memory';
import { executeToolCall } from '../../src/services/tool-executor';
import { now } from '../../src/utils/date-parser';

const mockCallDomain = vi.mocked(callDomain);
const mockContinue = vi.mocked(continueWithToolResults);
const mockExecuteTool = vi.mocked(executeToolCall);

// ─── Shared setup: reset now() mock for every test ──────────────────

beforeEach(() => {
  vi.mocked(now).mockReturnValue({
    toFormat: vi.fn().mockReturnValue('Monday, March 30 2026, 10:00'),
    minus: vi.fn().mockReturnValue({ toFormat: vi.fn().mockReturnValue('2026-03-27') }),
  } as any);
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
    const ctx = await buildSimpleStateContext('triathlon');
    expect(ctx).toContain('Monday, March 30 2026');
  });

  it('includes pending todos for the domain', async () => {
    vi.mocked(listTodos).mockReturnValue([
      { id: 1, title: 'Long run', priority: 'high', due_date: '2026-04-01', domain: 'triathlon', description: null, status: 'pending', tags: null, created_at: '', updated_at: '', completed_at: null },
    ] as any);

    const ctx = await buildSimpleStateContext('triathlon');
    expect(ctx).toContain('Triathlon to-dos (1)');
    expect(ctx).toContain('[high] Long run');
    expect(ctx).toContain('due: 2026-04-01');
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

  it('includes shared memory summary when present', async () => {
    vi.mocked(getSharedMemorySummary).mockReturnValue('[Shared] A-race: Ironman');

    const ctx = await buildSimpleStateContext('triathlon');
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

  it('stores user and assistant messages in conversation history', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Here is your plan.',
      toolCalls: [],
      stopReason: 'end_turn',
    } as any);

    await handleSimpleDomain('content', 'Write a hook');
    expect(addToConversation).toHaveBeenCalledWith('content', 'user', 'Write a hook');
    expect(addToConversation).toHaveBeenCalledWith('content', 'assistant', 'Here is your plan.');
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

    const result = await handleSimpleDomain('triathlon', 'What is on my calendar?');
    expect(result.text).toBe('You have a team call this week.');
    expect(mockExecuteTool).toHaveBeenCalledWith('get_calendar_events', { start_date: '2026-03-30', end_date: '2026-04-06' }, undefined);
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

    await handleSimpleDomain('triathlon', 'Save this note');

    const storedCall = vi.mocked(addToConversation).mock.calls.find(
      (c) => c[1] === 'assistant',
    );
    expect(storedCall![2]).toContain('[Tools: save_note]');
    expect(storedCall![2]).toContain('Note saved.');
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

    await handleSimpleDomain('triathlon', 'Find my notes');

    const storedCall = vi.mocked(addToConversation).mock.calls.find(
      (c) => c[1] === 'assistant',
    );
    // search_notes should appear only once despite being called twice
    expect(storedCall![2]).toBe('[Tools: search_notes]\nFound notes.');
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

    expect(mockCallDomain).toHaveBeenCalledWith(
      'content',
      expect.any(Array),
      'Write a full script',
      expect.any(String),
      4096,
      undefined,
    );
  });
});
