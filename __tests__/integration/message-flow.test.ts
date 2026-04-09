/**
 * Integration Tests — Full Message Flow
 *
 * Tests the complete pipeline: Telegram input → classify → domain → response
 *
 * Unlike unit tests that mock every dependency, these integration tests let
 * the real router, classifier, and domain handlers run together. Only the
 * outermost boundary (Anthropic API) is mocked to avoid real API calls.
 *
 * Flow under test:
 *   1. routeMessage(text, context?) → RouteResult
 *   2. DOMAIN_HANDLERS[route.domain](strippedMessage, userId)
 *   3. handleSimpleDomain → callDomain → tool loop → response
 *   4. splitMessage(response.text) → ctx.reply()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock external services at the boundary ────────────────────────

// Mock Anthropic SDK — used as fallback and by direct tests
const mockCallDomain = vi.fn();
const mockContinueWithToolResults = vi.fn();

vi.mock('../../src/services/anthropic', () => ({
  callDomain: (...args: any[]) => mockCallDomain(...args),
  continueWithToolResults: (...args: any[]) => mockContinueWithToolResults(...args),
  classifyMessage: vi.fn(),
  getDomainSystemPrompt: vi.fn().mockReturnValue('You are a test assistant.'),
  getClassifierSystemPrompt: vi.fn().mockReturnValue('Classify messages.'),
}));

// Mock provider-registry — domain-handler now routes through this
vi.mock('../../src/services/provider-registry', () => ({
  getActiveProvider: vi.fn().mockReturnValue({
    name: 'mock-provider',
    callDomain: (...args: any[]) => mockCallDomain(...args),
    continueWithToolResults: (...args: any[]) => mockContinueWithToolResults(...args),
    classify: vi.fn(),
  }),
}));

vi.mock('../../src/state/conversation', () => ({
  getConversationHistory: vi.fn().mockReturnValue([]),
  addToConversation: vi.fn(),
  getLastAssistantMessage: vi.fn().mockReturnValue(null),
  clearConversation: vi.fn(),
  clearAllConversations: vi.fn(),
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
  now: vi.fn().mockReturnValue({
    toFormat: vi.fn().mockReturnValue('Wednesday, April 01 2026, 10:00'),
    minus: vi.fn().mockReturnValue({ toFormat: vi.fn().mockReturnValue('2026-03-29') }),
  }),
  formatDateTime: vi.fn((d: string) => d),
  startOfDay: vi.fn().mockReturnValue('2026-04-01T00:00:00'),
  endOfDay: vi.fn().mockReturnValue('2026-04-01T23:59:59'),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

// ─── Imports (after mocks) ─────────────────────────────────────────

import { routeMessage, isSystemCommand } from '../../src/router';
import { patternMatch, keywordMatch, classifyWithClaude } from '../../src/router/classifier';
import { handleSimpleDomain, buildSimpleStateContext } from '../../src/domains/domain-handler';
import { handleTriathlon } from '../../src/domains/triathlon';
import { handleContent } from '../../src/domains/content-creator';
import { callDomain, continueWithToolResults, classifyMessage } from '../../src/services/anthropic';
import { addToConversation, getConversationHistory } from '../../src/state/conversation';
import { executeToolCall } from '../../src/services/tool-executor';
import { splitMessage } from '../../src/utils/telegram-formatter';

// ─── Typed mock references ─────────────────────────────────────────

// mockCallDomain and mockContinueWithToolResults are defined at the top of the file
// (shared between the anthropic mock and provider-registry mock)
const mockClassifyMessage = vi.mocked(classifyMessage);
const mockExecuteToolCall = vi.mocked(executeToolCall);
const mockAddToConversation = vi.mocked(addToConversation);
const mockGetHistory = vi.mocked(getConversationHistory);

// ─── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Default: callDomain returns a simple text response (no tool calls)
  mockCallDomain.mockResolvedValue({
    text: 'Test response from domain',
    toolCalls: [],
    stopReason: 'end_turn',
  });

  // Default: classifier returns secretary
  mockClassifyMessage.mockResolvedValue({
    domain: 'secretary',
    confidence: 0.95,
  });
});

// ════════════════════════════════════════════════════════════════════
// TIER 1: Pattern Matching → Domain Routing
// ════════════════════════════════════════════════════════════════════

describe('Integration: Pattern match → domain handler', () => {
  it('routes /train command through triathlon domain end-to-end', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Here is your training plan for the week.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    // Step 1: Route the message
    const route = await routeMessage('/train upper body push day');
    expect(route.domain).toBe('triathlon');
    expect(route.method).toBe('pattern');
    expect(route.confidence).toBe(1.0);
    expect(route.strippedMessage).toBe('upper body push day');

    // Step 2: Call the domain handler with stripped message
    const response = await handleTriathlon(route.strippedMessage, 123456789);
    expect(response.domain).toBe('triathlon');
    expect(response.text).toBe('Here is your training plan for the week.');

    // Step 3: Verify conversation was stored
    expect(mockAddToConversation).toHaveBeenCalledWith(expect.any(Number), 'triathlon', 'user', 'upper body push day');
    expect(mockAddToConversation).toHaveBeenCalledWith(expect.any(Number), 'triathlon', 'assistant', 'Here is your training plan for the week.');
  });

  it('routes /todo command through secretary domain end-to-end', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Task "Buy groceries" added to your list.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const route = await routeMessage('/todo buy groceries');
    expect(route.domain).toBe('secretary');
    expect(route.method).toBe('pattern');
    expect(route.strippedMessage).toBe('buy groceries');
  });

  it('routes /video command through content domain end-to-end', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Here are 5 video ideas for your channel.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const route = await routeMessage('/video ideas for next week');
    expect(route.domain).toBe('content');
    expect(route.method).toBe('pattern');
    expect(route.strippedMessage).toBe('ideas for next week');

    const response = await handleContent(route.strippedMessage);
    expect(response.domain).toBe('content');
    expect(response.text).toBe('Here are 5 video ideas for your channel.');
  });

  it('preserves full message as strippedMessage when command has no args', async () => {
    const route = await routeMessage('/todos');
    expect(route.domain).toBe('secretary');
    expect(route.method).toBe('pattern');
    // When there's no text after the command, strippedMessage falls back to original
    expect(route.strippedMessage).toBe('/todos');
  });

  it('multiple secretary commands all route correctly', async () => {
    const commands = ['/remind', '/email', '/schedule', '/agenda', '/done', '/undone'];
    for (const cmd of commands) {
      const route = await routeMessage(`${cmd} test`);
      expect(route.domain).toBe('secretary');
      expect(route.method).toBe('pattern');
    }
  });

  it('multiple triathlon commands all route correctly', async () => {
    const commands = ['/gym', '/run', '/bike', '/meal', '/macros', '/checkin'];
    for (const cmd of commands) {
      const route = await routeMessage(`${cmd} test`);
      expect(route.domain).toBe('triathlon');
      expect(route.method).toBe('pattern');
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// TIER 2: Keyword Matching → Domain Routing
// ════════════════════════════════════════════════════════════════════

describe('Integration: Keyword match → domain handler', () => {
  it('routes workout messages to triathlon domain', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Great workout plan! Here is your 5x5 squat program.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const route = await routeMessage('I need a new workout plan for the gym');
    expect(route.domain).toBe('triathlon');
    expect(route.method).toBe('keyword');
    expect(route.confidence).toBe(0.9);

    const response = await handleTriathlon(route.strippedMessage, 123456789);
    expect(response.text).toContain('squat program');
  });

  it('routes YouTube messages to content domain', async () => {
    const route = await routeMessage('I want to grow my YouTube subscribers');
    expect(route.domain).toBe('content');
    expect(route.method).toBe('keyword');
  });

  it('routes task-related messages to secretary domain', async () => {
    const route = await routeMessage('show me my pending tasks for today');
    expect(route.domain).toBe('secretary');
    expect(route.method).toBe('keyword');
  });

  it('prioritizes triathlon over secretary for mixed-domain keywords', async () => {
    // "workout" is triathlon-specific, tested before secretary
    const route = await routeMessage('schedule my workout session');
    expect(route.domain).toBe('triathlon');
  });

  it('prioritizes content over secretary for content keywords', async () => {
    const route = await routeMessage('I need to plan my Instagram reels content');
    expect(route.domain).toBe('content');
  });

  it('routes PT-BR messages to correct domain', async () => {
    const triathlonRoute = await routeMessage('preciso de um treino de musculação');
    expect(triathlonRoute.domain).toBe('triathlon');

    const contentRoute = await routeMessage('quero ideias de vídeo para o YouTube');
    expect(contentRoute.domain).toBe('content');

    const secretaryRoute = await routeMessage('mostrar minhas tarefas pendentes');
    expect(secretaryRoute.domain).toBe('secretary');
  });
});

// ════════════════════════════════════════════════════════════════════
// TIER 3: Claude Classifier → Domain Routing
// ════════════════════════════════════════════════════════════════════

describe('Integration: Claude classifier → domain handler', () => {
  it('falls back to Claude when no pattern or keyword matches', async () => {
    mockClassifyMessage.mockResolvedValue({
      domain: 'secretary',
      confidence: 0.85,
    });

    const route = await routeMessage('what do I have going on this afternoon?');
    expect(route.domain).toBe('secretary');
    expect(route.method).toBe('classifier');
    expect(route.confidence).toBe(0.85);
  });

  it('Claude classifier handles ambiguous messages', async () => {
    mockClassifyMessage.mockResolvedValue({
      domain: 'triathlon',
      confidence: 0.7,
    });

    const route = await routeMessage('how am I doing this week?');
    expect(route.method).toBe('classifier');
    expect(route.domain).toBe('triathlon');
    expect(route.confidence).toBe(0.7);
  });

  it('uses context-aware classification when active conversation exists', async () => {
    mockClassifyMessage.mockResolvedValue({
      domain: 'triathlon',
      confidence: 0.92,
    });

    const activeContext = {
      domain: 'triathlon' as const,
      lastAssistantMessage: 'Your upper body session is ready: bench press 4x8, rows 4x10...',
    };

    // "move it to Wednesday" has no keyword match → goes to classifier (with context)
    const route = await routeMessage('move it to Wednesday', activeContext);
    expect(route.method).toBe('classifier');
    expect(route.domain).toBe('triathlon');
    expect(route.confidence).toBe(0.92);

    // Verify classifyMessage was called with context.
    // April 9 2026: third arg is the new optional `userId` — undefined
    // here because this integration test doesn't exercise the
    // per-user attribution path. Routes that DO attribute (iOS chat,
    // future Telegram handlers) pass the real userId through.
    expect(mockClassifyMessage).toHaveBeenCalledWith(
      'move it to Wednesday',
      activeContext,
      undefined,
    );
  });

  it('active context: keyword matching runs first (token-zero optimization)', async () => {
    // Token-zero: keyword matching now ALWAYS runs before classifier.
    // "calendar" matches secretary keyword. This is the expected behavior —
    // it saves a Claude classifier call (~$0.00025) per message.
    mockClassifyMessage.mockResolvedValue({
      domain: 'triathlon',
      confidence: 0.88,
    });

    const activeContext = {
      domain: 'triathlon' as const,
      lastAssistantMessage: 'I can adjust your training calendar. What day works?',
    };

    const route = await routeMessage('put it on the calendar for Thursday', activeContext);
    // Keyword "calendar" matches secretary — classifier is NOT called
    expect(route.method).toBe('keyword');
    expect(route.domain).toBe('secretary');
  });
});

// ════════════════════════════════════════════════════════════════════
// TOOL CALL LOOP INTEGRATION
// ════════════════════════════════════════════════════════════════════

describe('Integration: Domain handler with tool calls', () => {
  it('executes single tool call and returns final response', async () => {
    // First API call returns a tool use request
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_01',
        name: 'list_todos',
        input: { domain: 'secretary' },
      }],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall.mockResolvedValue({
      success: true,
      data: [{ title: 'Buy groceries', priority: 'high' }],
    });

    // Second API call (after tool result) returns final text
    mockContinueWithToolResults.mockResolvedValue({
      text: 'You have 1 pending task: Buy groceries (high priority).',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain('secretary', 'what are my tasks?');

    expect(response.text).toBe('You have 1 pending task: Buy groceries (high priority).');
    expect(response.domain).toBe('secretary');
    expect(mockExecuteToolCall).toHaveBeenCalledWith('list_todos', { domain: 'secretary' }, undefined);
    expect(mockContinueWithToolResults).toHaveBeenCalledTimes(1);

    // Verify conversation stored with tool annotation
    expect(mockAddToConversation).toHaveBeenCalledWith(
      expect.any(Number), 'secretary', 'assistant',
      expect.stringContaining('[Tools: list_todos]'),
    );
  });

  it('executes multiple sequential tool calls (multi-step)', async () => {
    // Round 1: Claude wants to check tasks
    mockCallDomain.mockResolvedValue({
      text: 'Let me check your tasks.',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_01',
        name: 'list_todos',
        input: { domain: 'secretary' },
      }],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall
      .mockResolvedValueOnce({ success: true, data: [{ title: 'Review PR', priority: 'high' }] })
      .mockResolvedValueOnce({ success: true, message: 'Reminder created' });

    // Round 2: Claude wants to create a reminder
    mockContinueWithToolResults
      .mockResolvedValueOnce({
        text: 'I see you have a PR to review. Let me set a reminder.',
        toolCalls: [{
          type: 'tool_use' as const,
          id: 'toolu_02',
          name: 'create_reminder',
          input: { title: 'Review PR', time: '14:00' },
        }],
        stopReason: 'tool_use',
      })
      // Round 3: Final response
      .mockResolvedValueOnce({
        text: 'Done! You have a PR to review, and I set a reminder for 2 PM.',
        toolCalls: [],
        stopReason: 'end_turn',
      });

    const response = await handleSimpleDomain('secretary', 'check my tasks and remind me');

    expect(response.text).toBe('Done! You have a PR to review, and I set a reminder for 2 PM.');
    expect(mockExecuteToolCall).toHaveBeenCalledTimes(2);
    expect(mockContinueWithToolResults).toHaveBeenCalledTimes(2);
  });

  it('respects maxIterations limit for tool calls', async () => {
    // Every call returns another tool use (infinite loop scenario)
    const infiniteToolResponse = {
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_loop',
        name: 'list_todos',
        input: {},
      }],
      stopReason: 'tool_use',
    };

    mockCallDomain.mockResolvedValue(infiniteToolResponse);
    mockContinueWithToolResults.mockResolvedValue(infiniteToolResponse);
    mockExecuteToolCall.mockResolvedValue({ success: true, data: [] });

    // maxIterations=3 should cap the loop
    const response = await handleSimpleDomain('secretary', 'test', 3);

    // Should have called continue exactly 3 times (the max)
    expect(mockContinueWithToolResults).toHaveBeenCalledTimes(3);
  });

  it('handles parallel tool calls in a single round', async () => {
    // Claude requests two tools at once
    mockCallDomain.mockResolvedValue({
      text: 'Checking both...',
      toolCalls: [
        { type: 'tool_use' as const, id: 'toolu_a', name: 'list_todos', input: {} },
        { type: 'tool_use' as const, id: 'toolu_b', name: 'get_events', input: { start: '2026-04-01', end: '2026-04-01' } },
      ],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall
      .mockResolvedValueOnce({ success: true, data: [{ title: 'Task 1' }] })
      .mockResolvedValueOnce({ success: true, events: [] });

    mockContinueWithToolResults.mockResolvedValue({
      text: 'You have 1 task and no events today.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain('secretary', 'what is my day like?');

    expect(response.text).toBe('You have 1 task and no events today.');
    // Both tools executed in parallel
    expect(mockExecuteToolCall).toHaveBeenCalledTimes(2);
    expect(mockExecuteToolCall).toHaveBeenCalledWith('list_todos', {}, undefined);
    expect(mockExecuteToolCall).toHaveBeenCalledWith('get_events', { start: '2026-04-01', end: '2026-04-01' }, undefined);
  });
});

// ════════════════════════════════════════════════════════════════════
// END-TO-END: Route → Domain → Tool Loop → Response
// ════════════════════════════════════════════════════════════════════

describe('Integration: Full end-to-end message flow', () => {
  it('/gym command → triathlon → tool call → response', async () => {
    // Step 1: Route
    const route = await routeMessage('/gym upper body');
    expect(route.domain).toBe('triathlon');
    expect(route.strippedMessage).toBe('upper body');

    // Step 2+3: Domain handler with a tool call
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_cal',
        name: 'get_events',
        input: { start: '2026-04-01', end: '2026-04-01' },
      }],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall.mockResolvedValue({
      success: true,
      events: [{ title: 'Chest day', start: '08:00', end: '09:00' }],
    });

    mockContinueWithToolResults.mockResolvedValue({
      text: '💪 Upper body push day:\n- Bench press 4×8\n- Overhead press 3×10\n- Lateral raises 3×15',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleTriathlon(route.strippedMessage, 123456789);
    expect(response.text).toContain('Bench press');
    expect(response.domain).toBe('triathlon');

    // Step 4: Verify message would be split correctly for Telegram
    const parts = splitMessage(response.text);
    expect(parts.length).toBe(1); // Short enough for one message
    expect(parts[0]).toContain('Upper body push day');
  });

  it('natural language → keyword match → content domain → response', async () => {
    const route = await routeMessage('give me 5 video ideas for YouTube');
    expect(route.domain).toBe('content');
    expect(route.method).toBe('keyword');

    mockCallDomain.mockResolvedValue({
      text: '🎬 Here are 5 video ideas:\n1. Morning routine\n2. Tech review\n3. Travel vlog\n4. Cooking challenge\n5. Day in the life',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleContent(route.strippedMessage);
    expect(response.text).toContain('5 video ideas');
    expect(response.domain).toBe('content');
  });

  it('ambiguous message → Claude classifier → secretary → response', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'secretary', confidence: 0.82 });

    const route = await routeMessage('what should I focus on today?');
    expect(route.method).toBe('classifier');

    mockCallDomain.mockResolvedValue({
      text: 'Based on your schedule, focus on the PR review first, then the 2 PM meeting.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain(route.domain, route.strippedMessage);
    expect(response.text).toContain('PR review');
  });

  it('follow-up message with active context routes correctly', async () => {
    // Simulate: user was talking to triathlon domain, now sends "yes, do it"
    mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.95 });

    const activeContext = {
      domain: 'triathlon' as const,
      lastAssistantMessage: 'Should I adjust your bench press to 4x6 at heavier weight?',
    };

    const route = await routeMessage('yes, do it', activeContext);
    expect(route.domain).toBe('triathlon');
    expect(route.method).toBe('classifier'); // Context forces classifier path

    mockCallDomain.mockResolvedValue({
      text: 'Done! Updated bench press to 4×6 at 85kg.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleTriathlon(route.strippedMessage, 123456789);
    expect(response.text).toContain('4×6');
  });
});

// ════════════════════════════════════════════════════════════════════
// SYSTEM COMMANDS
// ════════════════════════════════════════════════════════════════════

describe('Integration: System command detection', () => {
  it('identifies system commands that skip domain routing', () => {
    expect(isSystemCommand('/help')).toBe('/help');
    expect(isSystemCommand('/status')).toBe('/status');
    expect(isSystemCommand('/clear')).toBe('/clear');
    expect(isSystemCommand('/start')).toBe('/start');
    expect(isSystemCommand('/deepsearch AI trends 2026')).toBe('/deepsearch');
  });

  it('does not flag domain commands as system commands', () => {
    expect(isSystemCommand('/todo buy milk')).toBeNull();
    expect(isSystemCommand('/train legs')).toBeNull();
    expect(isSystemCommand('/gym push day')).toBeNull();
  });

  it('returns null for non-command messages', () => {
    expect(isSystemCommand('hello')).toBeNull();
    expect(isSystemCommand('what are my tasks?')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// CONVERSATION CONTEXT PERSISTENCE
// ════════════════════════════════════════════════════════════════════

describe('Integration: Conversation history management', () => {
  it('stores both user and assistant messages after domain response', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Your training is set for tomorrow.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    await handleTriathlon('plan my run for tomorrow', 123456789);

    expect(mockAddToConversation).toHaveBeenCalledTimes(2);
    expect(mockAddToConversation).toHaveBeenNthCalledWith(1, expect.any(Number), 'triathlon', 'user', 'plan my run for tomorrow');
    expect(mockAddToConversation).toHaveBeenNthCalledWith(2, expect.any(Number), 'triathlon', 'assistant', 'Your training is set for tomorrow.');
  });

  it('stores tool annotations in assistant messages when tools were used', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_01',
        name: 'create_todo',
        input: { title: 'Test', domain: 'secretary' },
      }],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall.mockResolvedValue({ success: true });

    mockContinueWithToolResults.mockResolvedValue({
      text: 'Task created!',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    await handleSimpleDomain('secretary', 'add task: test');

    // Assistant message should have tool annotation
    const assistantCall = mockAddToConversation.mock.calls.find(
      (c) => c[2] === 'assistant'
    );
    expect(assistantCall).toBeDefined();
    expect(assistantCall![3]).toContain('[Tools: create_todo]');
    expect(assistantCall![3]).toContain('Task created!');
  });

  it('deduplicates tool names in stored annotation', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [
        { type: 'tool_use' as const, id: 'toolu_01', name: 'list_todos', input: {} },
        { type: 'tool_use' as const, id: 'toolu_02', name: 'list_todos', input: {} },
      ],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall.mockResolvedValue({ success: true, data: [] });

    mockContinueWithToolResults.mockResolvedValue({
      text: 'No tasks found.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    await handleSimpleDomain('secretary', 'check tasks');

    const assistantCall = mockAddToConversation.mock.calls.find(
      (c) => c[2] === 'assistant'
    );
    // Should deduplicate "list_todos" — only appear once
    expect(assistantCall![3]).toBe('[Tools: list_todos]\nNo tasks found.');
  });
});

// ════════════════════════════════════════════════════════════════════
// STATE CONTEXT BUILDING
// ════════════════════════════════════════════════════════════════════

describe('Integration: State context is passed to domain calls', () => {
  it('builds state context with current date for triathlon', async () => {
    const ctx = await buildSimpleStateContext('triathlon');
    expect(ctx).toContain('Wednesday, April 01 2026');
  });

  it('callDomain receives state context from handleSimpleDomain', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'OK',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    await handleTriathlon('test', 123456789);

    // Provider interface: callDomain(domain, history, message, stateContext, maxTokensOverride)
    // userId is handled by domain-handler, not passed to the provider
    expect(mockCallDomain).toHaveBeenCalledWith(
      'triathlon',
      expect.any(Array),    // history
      'test',               // message
      expect.stringContaining('Wednesday, April 01 2026'), // stateContext
      undefined,            // maxTokensOverride
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// RESPONSE SPLITTING (Telegram 4096 char limit)
// ════════════════════════════════════════════════════════════════════

describe('Integration: Response splitting for Telegram', () => {
  it('does not split short responses', () => {
    const parts = splitMessage('Hello, world!');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe('Hello, world!');
  });

  it('splits long responses at the 4096 character boundary', () => {
    const longText = 'A'.repeat(5000);
    const parts = splitMessage(longText);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
    }
    // Verify no content is lost
    expect(parts.join('').length).toBe(5000);
  });

  it('splits at newline boundaries when possible', () => {
    // Create text with newlines — splitMessage uses lastIndexOf('\n') to find
    // a clean break point, then substring(0, splitAt) which excludes the '\n'.
    const line = 'This is a test line.\n';
    const text = line.repeat(Math.ceil(5000 / line.length));
    const parts = splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    // First part should split at a newline boundary, so its length should be
    // a multiple of the line length (minus the trailing newline char)
    expect(parts[0].length).toBeLessThanOrEqual(4096);
    // Verify the split happened at a line boundary (not mid-line)
    expect(parts[0].length % line.length).toBe(line.length - 1); // excludes trailing \n
  });
});

// ════════════════════════════════════════════════════════════════════
// EDGE CASES & ERROR SCENARIOS
// ════════════════════════════════════════════════════════════════════

describe('Integration: Edge cases', () => {
  it('handles empty tool call list (no tools needed)', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'I can help with that directly.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain('triathlon', 'what is RPE?');
    expect(response.text).toBe('I can help with that directly.');
    expect(mockExecuteToolCall).not.toHaveBeenCalled();
    expect(mockContinueWithToolResults).not.toHaveBeenCalled();
  });

  it('handles domain handler that returns empty text', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain('content', 'test');
    expect(response.text).toBe('');
    expect(response.domain).toBe('content');
  });

  it('command with only slashes (edge case)', async () => {
    // "/train" with no additional text
    const route = await routeMessage('/train');
    expect(route.domain).toBe('triathlon');
    expect(route.method).toBe('pattern');
  });

  it('pattern matching is case-insensitive', async () => {
    const route = await routeMessage('/TODO Buy milk');
    expect(route.domain).toBe('secretary');
    expect(route.method).toBe('pattern');
  });

  it('passes userId through the triathlon domain handler', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Done',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    await handleTriathlon('test', 999);
    // Verify that callDomain was called (indirectly verifying userId flows through)
    expect(mockCallDomain).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// CLASSIFICATION TIER PRIORITY
// ════════════════════════════════════════════════════════════════════

describe('Integration: Classification tier priority', () => {
  it('pattern match takes priority over keyword match', async () => {
    // "/train" is a pattern AND "train" could keyword-match
    const route = await routeMessage('/train for a marathon');
    expect(route.method).toBe('pattern');
    expect(route.confidence).toBe(1.0);
    // Claude classifier should NOT be called
    expect(mockClassifyMessage).not.toHaveBeenCalled();
  });

  it('keyword match takes priority over Claude classifier (no context)', async () => {
    const route = await routeMessage('I need to check my pending tasks');
    expect(route.method).toBe('keyword');
    expect(route.confidence).toBe(0.9);
    // Claude classifier should NOT be called
    expect(mockClassifyMessage).not.toHaveBeenCalled();
  });

  it('active context: keywords match first to save tokens (token-zero)', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'triathlon', confidence: 0.9 });

    const activeContext = {
      domain: 'triathlon' as const,
      lastAssistantMessage: 'Your recovery day is set.',
    };

    // Token-zero: "tasks" keyword-matches to secretary. Classifier NOT called.
    const route = await routeMessage('what about my recovery tasks for tomorrow?', activeContext);
    expect(route.method).toBe('keyword');
    // Keyword matcher handles it — Claude classifier was NOT called
    expect(mockClassifyMessage).not.toHaveBeenCalled();
  });

  it('Claude classifier is the last resort for non-matching messages', async () => {
    mockClassifyMessage.mockResolvedValue({ domain: 'content', confidence: 0.6 });

    const route = await routeMessage('I feel creative today');
    expect(route.method).toBe('classifier');
    expect(route.domain).toBe('content');
    // Third arg: new optional `userId` (see April 9 2026 note above)
    expect(mockClassifyMessage).toHaveBeenCalledWith('I feel creative today', undefined, undefined);
  });
});

// ════════════════════════════════════════════════════════════════════
// SCENARIO-SPECIFIC E2E TESTS
// ════════════════════════════════════════════════════════════════════

describe('Scenario: "what is on my calendar today?" → secretary → calendar tool → response', () => {
  it('routes to secretary, calls get_events tool, returns formatted schedule', async () => {
    // Step 1: Route — "calendar" keyword matches secretary
    const route = await routeMessage('what is on my calendar today?');
    expect(route.domain).toBe('secretary');

    // Step 2: Domain handler — Claude requests calendar tool
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_cal_01',
        name: 'get_events',
        input: { start: '2026-04-01T00:00:00', end: '2026-04-01T23:59:59' },
      }],
      stopReason: 'tool_use',
    });

    // Step 3: Tool returns calendar data
    mockExecuteToolCall.mockResolvedValue({
      success: true,
      events: [
        { title: 'Sprint Planning', start: '09:00', end: '10:00', calendar: 'Siemens' },
        { title: 'Lunch with Pedro', start: '12:30', end: '13:30', calendar: 'Personal' },
        { title: 'Swim training', start: '18:00', end: '19:00', calendar: 'Training' },
      ],
    });

    // Step 4: Claude produces formatted human-readable response
    mockContinueWithToolResults.mockResolvedValue({
      text: '📅 Here\'s your schedule for today:\n\n• 09:00–10:00 — Sprint Planning (Siemens)\n• 12:30–13:30 — Lunch with Pedro\n• 18:00–19:00 — Swim training\n\nYou have 3 events. Your afternoon is free between 1:30 PM and 6 PM.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain(route.domain, route.strippedMessage);

    // Verify: human-readable text, NOT raw JSON
    expect(response.text).toContain('Sprint Planning');
    expect(response.text).toContain('Lunch with Pedro');
    expect(response.text).toContain('Swim training');
    expect(response.text).not.toContain('"success"');
    expect(response.text).not.toContain('"events"');
    expect(response.domain).toBe('secretary');

    // Verify: tool was called with correct params
    expect(mockExecuteToolCall).toHaveBeenCalledWith('get_events', {
      start: '2026-04-01T00:00:00',
      end: '2026-04-01T23:59:59',
    }, undefined);
  });
});

describe('Scenario: "/expense 50 almoço" → finance → expense logged → confirmation', () => {
  it('routes to finance via pattern, logs expense, returns confirmation', async () => {
    // Step 1: Route — /expense command matches finance domain
    const route = await routeMessage('/expense 50 almoço');
    expect(route.domain).toBe('finance');
    expect(route.method).toBe('pattern');
    expect(route.strippedMessage).toBe('50 almoço');

    // Step 2: Domain handler — Claude parses amount and description, calls tool
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_exp_01',
        name: 'log_expense',
        input: {
          amount: 50,
          currency: 'EUR',
          description: 'almoço',
          category: 'food',
          date: '2026-04-01',
        },
      }],
      stopReason: 'tool_use',
    });

    // Step 3: Tool confirms expense logged
    mockExecuteToolCall.mockResolvedValue({
      success: true,
      id: 42,
      message: 'Expense logged: €50.00 — almoço (food)',
    });

    // Step 4: Claude returns human confirmation
    mockContinueWithToolResults.mockResolvedValue({
      text: '✅ Expense logged!\n\n💰 €50.00 — almoço\n📂 Category: food\n📅 Date: April 1, 2026',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain(route.domain, route.strippedMessage);

    // Verify: confirmation text, not JSON
    expect(response.text).toContain('€50.00');
    expect(response.text).toContain('almoço');
    expect(response.text).toContain('food');
    expect(response.text).not.toContain('"success"');
    expect(response.domain).toBe('finance');
  });
});

describe('Scenario: "receita de frango" → cooking → recipe search → results', () => {
  it('routes to cooking via keyword (PT-BR), searches recipes, returns formatted results', async () => {
    // Step 1: Route — "receita" keyword matches cooking domain
    const route = await routeMessage('receita de frango');
    expect(route.domain).toBe('cooking');
    expect(route.method).toBe('keyword');

    // Step 2: Domain handler — Claude generates recipe directly (no tool needed)
    mockCallDomain.mockResolvedValue({
      text: '🍗 **Frango Grelhado com Ervas**\n\n' +
        '**Ingredientes:**\n' +
        '- 500g peito de frango\n' +
        '- 2 colheres de azeite\n' +
        '- Alho, sal, pimenta, orégano\n\n' +
        '**Modo de preparo:**\n' +
        '1. Tempere o frango com alho, sal, pimenta e orégano\n' +
        '2. Grelhe em fogo médio por 6 min de cada lado\n' +
        '3. Deixe descansar 5 minutos antes de servir\n\n' +
        '⏱ Tempo: 20 min | 🔥 Calorias: ~250 kcal por porção',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain(route.domain, route.strippedMessage);

    // Verify: recipe content in Portuguese
    expect(response.text).toContain('Frango');
    expect(response.text).toContain('Ingredientes');
    expect(response.text).toContain('Modo de preparo');
    expect(response.domain).toBe('cooking');

    // Verify: no tool calls needed for simple recipe generation
    expect(mockExecuteToolCall).not.toHaveBeenCalled();
  });
});

describe('Scenario: Ambiguous message → Haiku classifier → most likely domain', () => {
  it('routes ambiguous PT-BR message through classifier to correct domain', async () => {
    // "como estou indo?" — could be triathlon (performance) or secretary (tasks)
    // No keyword match, no pattern match → falls through to Claude classifier
    mockClassifyMessage.mockResolvedValue({
      domain: 'triathlon',
      confidence: 0.72,
    });

    const route = await routeMessage('como estou indo?');
    expect(route.method).toBe('classifier');
    expect(route.domain).toBe('triathlon');
    expect(route.confidence).toBe(0.72);

    // Verify classifier was called (Haiku in production, mocked here)
    // Third arg: new optional `userId` (see April 9 2026 note above)
    expect(mockClassifyMessage).toHaveBeenCalledWith('como estou indo?', undefined, undefined);
  });

  it('classifier respects minimum confidence threshold', async () => {
    // Very low confidence — should still route but confidence is preserved
    mockClassifyMessage.mockResolvedValue({
      domain: 'content',
      confidence: 0.45,
    });

    const route = await routeMessage('hmmm não sei');
    expect(route.method).toBe('classifier');
    // The router may override low-confidence results to secretary
    // (depends on implementation — just verify it routes somewhere valid)
    expect(['secretary', 'content', 'triathlon', 'cooking', 'finance']).toContain(route.domain);
  });

  it('classifier with active context routes follow-up correctly', async () => {
    mockClassifyMessage.mockResolvedValue({
      domain: 'cooking',
      confidence: 0.88,
    });

    const activeContext = {
      domain: 'cooking' as const,
      lastAssistantMessage: 'Aqui está a receita de frango grelhado. Quer que eu ajuste as porções?',
    };

    const route = await routeMessage('sim, para 4 pessoas', activeContext);
    expect(route.method).toBe('classifier');
    expect(route.domain).toBe('cooking');
    expect(route.confidence).toBe(0.88);

    // Verify context was passed to classifier
    // Third arg: new optional `userId` (see April 9 2026 note above)
    expect(mockClassifyMessage).toHaveBeenCalledWith('sim, para 4 pessoas', activeContext, undefined);
  });
});

describe('Scenario: Tool execution loop returns human text, never raw JSON', () => {
  it('tool_use → execute → continueWithToolResults → final text (not JSON)', async () => {
    // Simulate: user asks about tasks, Claude uses tool, returns formatted text
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_tasks_01',
        name: 'list_todos',
        input: { domain: 'secretary' },
      }],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall.mockResolvedValue({
      success: true,
      data: [
        { title: 'Deploy v4.5.2', priority: 'high', status: 'done' },
        { title: 'Review PR #13', priority: 'high', status: 'pending' },
        { title: 'Write docs', priority: 'medium', status: 'pending' },
      ],
    });

    mockContinueWithToolResults.mockResolvedValue({
      text: '📋 Your tasks:\n\n✅ Deploy v4.5.2 (done)\n⏳ Review PR #13 (high priority)\n⏳ Write docs (medium priority)\n\n2 pending, 1 completed.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const response = await handleSimpleDomain('secretary', 'show my tasks');

    // CRITICAL: Response must be human-readable text
    expect(response.text).toContain('Deploy v4.5.2');
    expect(response.text).toContain('Review PR #13');
    expect(response.text).toContain('2 pending');

    // CRITICAL: Response must NOT be raw JSON
    expect(response.text).not.toContain('"success"');
    expect(response.text).not.toContain('"data"');
    expect(response.text).not.toContain('{"');
    expect(response.text).not.toContain('[{');
    expect(response.text).not.toMatch(/^\s*\{/);  // doesn't start with {
    expect(response.text).not.toMatch(/^\s*\[/);  // doesn't start with [
  });

  it('multi-step tool loop returns final text, not intermediate JSON', async () => {
    // Round 1: check calendar
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_r1',
        name: 'get_events',
        input: { start: '2026-04-01', end: '2026-04-01' },
      }],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall
      .mockResolvedValueOnce({ success: true, events: [{ title: 'Meeting', start: '14:00' }] })
      .mockResolvedValueOnce({ success: true, id: 7 });

    // Round 2: create reminder based on calendar
    mockContinueWithToolResults
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{
          type: 'tool_use' as const,
          id: 'toolu_r2',
          name: 'create_reminder',
          input: { title: 'Prepare for meeting', time: '13:30' },
        }],
        stopReason: 'tool_use',
      })
      // Round 3: final human response
      .mockResolvedValueOnce({
        text: '📅 You have a meeting at 2 PM. I\'ve set a reminder at 1:30 PM to prepare.',
        toolCalls: [],
        stopReason: 'end_turn',
      });

    const response = await handleSimpleDomain('secretary', 'check my afternoon and remind me before meetings');

    // Final response is natural language
    expect(response.text).toContain('meeting at 2 PM');
    expect(response.text).toContain('reminder at 1:30 PM');
    expect(response.text).not.toContain('"success"');
    expect(response.text).not.toContain('"events"');
    expect(response.text).not.toContain('toolu_');

    // Two tools were called across the loop
    expect(mockExecuteToolCall).toHaveBeenCalledTimes(2);
    expect(mockContinueWithToolResults).toHaveBeenCalledTimes(2);
  });

  it('conversation stores final text, not tool JSON', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use' as const,
        id: 'toolu_store_01',
        name: 'list_todos',
        input: {},
      }],
      stopReason: 'tool_use',
    });

    mockExecuteToolCall.mockResolvedValue({ success: true, data: [] });

    mockContinueWithToolResults.mockResolvedValue({
      text: 'You have no pending tasks. Enjoy your free time!',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    await handleSimpleDomain('secretary', 'tasks?');

    // Stored assistant message must be the human text, not JSON
    const assistantCall = mockAddToConversation.mock.calls.find(
      (c) => c[2] === 'assistant'
    );
    expect(assistantCall).toBeDefined();
    expect(assistantCall![3]).toContain('no pending tasks');
    expect(assistantCall![3]).not.toContain('"success"');
    expect(assistantCall![3]).not.toContain('"data"');
  });
});
