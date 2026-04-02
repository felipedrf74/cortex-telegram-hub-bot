/**
 * QA Validation — P0 Bug Fix: Bot dumps raw JSON tool calls instead of executing them
 *
 * Validates that:
 * 1. callDomainWithToolLoop executes tool_use blocks and returns text, never raw JSON
 * 2. Tool execution results are passed back to the AI via continueWithToolResults
 * 3. Multi-step tool chains resolve correctly
 * 4. Edge cases: empty text, executor errors, parallel tools, maxIterations guard
 * 5. The provider-agnostic types (AIToolCall, AICallResult) are correct
 * 6. FallbackProvider delegates callDomainWithToolLoop correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AIProvider, AICallResult, AIToolCall, ToolExecutorFn } from '../../src/services/ai-provider';
import { FallbackProvider } from '../../src/services/ai-provider';

// Mock anthropic.ts before importing AnthropicProvider
vi.mock('../../src/services/anthropic', () => ({
  classifyMessage: vi.fn(),
  callDomain: vi.fn(),
  continueWithToolResults: vi.fn(),
  getDomainSystemPrompt: vi.fn().mockReturnValue('mock prompt'),
  getClassifierSystemPrompt: vi.fn().mockReturnValue('mock classifier'),
  TOOLS: [],
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

import { AnthropicProvider } from '../../src/services/anthropic-provider';
import { callDomain, continueWithToolResults } from '../../src/services/anthropic';

const mockCallDomain = vi.mocked(callDomain);
const mockContinue = vi.mocked(continueWithToolResults);

// ═══════════════════════════════════════════════════════════════════
// Core bug fix validation: tool_use blocks are NEVER returned as text
// ═══════════════════════════════════════════════════════════════════

describe('P0 Bug Fix: tool_use blocks are executed, not serialized', () => {
  let provider: AnthropicProvider;
  let executor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new AnthropicProvider();
    executor = vi.fn();
    mockCallDomain.mockReset();
    mockContinue.mockReset();
  });

  it('executes get_calendar_events and returns formatted text, not raw JSON', async () => {
    // AI returns a tool_use block — this is the exact scenario that was broken
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use', id: 'toolu_cal_01',
        name: 'get_calendar_events',
        input: { start_date: '2026-04-02', end_date: '2026-04-02' },
      }] as any,
      stopReason: 'tool_use',
    });

    executor.mockResolvedValue({
      events: [
        { title: 'Team Standup', start: '09:00', end: '09:30', location: 'Zoom' },
        { title: 'Lunch with Alex', start: '12:00', end: '13:00' },
      ],
    });

    mockContinue.mockResolvedValue({
      text: 'You have 2 events today:\n1. Team Standup (09:00-09:30, Zoom)\n2. Lunch with Alex (12:00-13:00)',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'what is my schedule today?', 'ctx', executor,
    );

    // The P0 bug was that `result.text` would contain raw JSON like:
    // {"type":"tool_use","id":"toolu_cal_01","name":"get_calendar_events",...}
    // After the fix, it should contain the AI's natural language response
    expect(result.text).toContain('2 events today');
    expect(result.text).not.toContain('tool_use');
    expect(result.text).not.toContain('toolu_');
    expect(result.text).not.toContain('"type"');
    expect(result.toolsUsed).toEqual(['get_calendar_events']);
  });

  it('executes ms_todo_get_tasks and returns formatted text', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use', id: 'toolu_todo_01',
        name: 'ms_todo_get_tasks',
        input: { list_id: 'work_list', list_name: 'Work' },
      }] as any,
      stopReason: 'tool_use',
    });

    executor.mockResolvedValue({
      success: true,
      data: [
        { title: 'Review PR #42', status: 'notStarted' },
        { title: 'Deploy v2.1', status: 'inProgress' },
      ],
    });

    mockContinue.mockResolvedValue({
      text: 'You have 2 tasks in Work:\n- Review PR #42 (not started)\n- Deploy v2.1 (in progress)',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'show my tasks', 'ctx', executor,
    );

    expect(result.text).toContain('2 tasks');
    expect(result.text).not.toContain('tool_use');
    expect(result.text).not.toContain('"name":"ms_todo_get_tasks"');
    expect(result.toolsUsed).toEqual(['ms_todo_get_tasks']);
  });

  it('handles the morning briefing flow (calendar + tasks in sequence)', async () => {
    // First call returns calendar lookup
    mockCallDomain.mockResolvedValue({
      text: 'Let me check your schedule and tasks...',
      toolCalls: [{
        type: 'tool_use', id: 'toolu_01', name: 'get_calendar_events',
        input: { start_date: '2026-04-02', end_date: '2026-04-02' },
      }] as any,
      stopReason: 'tool_use',
    });

    executor
      .mockResolvedValueOnce({ events: [{ title: 'Standup', start: '09:00' }] })
      .mockResolvedValueOnce({ success: true, data: [{ title: 'Fix bug', status: 'notStarted' }] });

    // After calendar, AI also wants tasks
    mockContinue
      .mockResolvedValueOnce({
        text: 'Got your calendar. Now checking tasks...',
        toolCalls: [{
          type: 'tool_use', id: 'toolu_02', name: 'ms_todo_get_tasks',
          input: { list_id: 'inbox', list_name: 'Inbox' },
        }] as any,
        stopReason: 'tool_use',
      })
      .mockResolvedValueOnce({
        text: '📋 Morning Briefing:\n\n**Calendar:** Standup at 9am\n**Tasks:** Fix bug (pending)',
        toolCalls: [],
        stopReason: 'end_turn',
      });

    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'buenos días', 'ctx', executor,
    );

    expect(result.text).toContain('Morning Briefing');
    expect(result.text).not.toContain('tool_use');
    expect(result.toolsUsed).toEqual(['get_calendar_events', 'ms_todo_get_tasks']);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(mockContinue).toHaveBeenCalledTimes(2);
  });

  it('never exposes raw JSON even when tool returns an error object', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use', id: 'toolu_err', name: 'get_calendar_events',
        input: { start_date: '2026-04-02', end_date: '2026-04-02' },
      }] as any,
      stopReason: 'tool_use',
    });

    executor.mockResolvedValue({ error: 'Calendar API unavailable', code: 503 });

    mockContinue.mockResolvedValue({
      text: "I couldn't access your calendar right now. The service seems to be temporarily unavailable. Please try again in a few minutes.",
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'schedule?', '', executor,
    );

    expect(result.text).toContain("couldn't access");
    expect(result.text).not.toContain('tool_use');
    expect(result.text).not.toContain('"error"');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tool conversation structure validation
// ═══════════════════════════════════════════════════════════════════

describe('Tool conversation structure', () => {
  let provider: AnthropicProvider;
  let executor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new AnthropicProvider();
    executor = vi.fn();
    mockCallDomain.mockReset();
    mockContinue.mockReset();
  });

  it('passes tool_use blocks as assistant content and tool_result as user content', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Checking...',
      toolCalls: [{
        type: 'tool_use', id: 'toolu_abc', name: 'set_reminder',
        input: { message: 'Call mom', remind_at: '2026-04-02T18:00:00' },
      }] as any,
      stopReason: 'tool_use',
    });

    executor.mockResolvedValue({ success: true, id: 'rem_123' });

    mockContinue.mockResolvedValue({
      text: 'Reminder set for 6 PM: Call mom',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    await provider.callDomainWithToolLoop('secretary', [], 'remind me', '', executor);

    // Verify the tool conversation structure passed to continueWithToolResults
    expect(mockContinue).toHaveBeenCalledTimes(1);
    const toolConvo = mockContinue.mock.calls[0][4]; // 5th argument

    // Should have 2 messages: assistant (tool_use) + user (tool_result)
    expect(toolConvo).toHaveLength(2);

    // Assistant message contains text + tool_use blocks
    expect(toolConvo[0].role).toBe('assistant');
    const assistantContent = toolConvo[0].content as any[];
    expect(assistantContent).toHaveLength(2); // text + tool_use
    expect(assistantContent[0]).toEqual({ type: 'text', text: 'Checking...' });
    expect(assistantContent[1].type).toBe('tool_use');
    expect(assistantContent[1].name).toBe('set_reminder');

    // User message contains tool_result
    expect(toolConvo[1].role).toBe('user');
    const userContent = toolConvo[1].content as any[];
    expect(userContent).toHaveLength(1);
    expect(userContent[0].type).toBe('tool_result');
    expect(userContent[0].tool_use_id).toBe('toolu_abc');
    expect(JSON.parse(userContent[0].content)).toEqual({ success: true, id: 'rem_123' });
  });

  it('accumulates conversation across multiple tool iterations', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use', id: 'tc1', name: 'tool_a', input: {},
      }] as any,
      stopReason: 'tool_use',
    });

    executor.mockResolvedValue({ ok: true });

    mockContinue
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{
          type: 'tool_use', id: 'tc2', name: 'tool_b', input: {},
        }] as any,
        stopReason: 'tool_use',
      })
      .mockResolvedValueOnce({
        text: 'All done.',
        toolCalls: [],
        stopReason: 'end_turn',
      });

    await provider.callDomainWithToolLoop('secretary', [], 'do things', '', executor);

    // Second continueWithToolResults call should have the full conversation
    const secondCall = mockContinue.mock.calls[1];
    const toolConvo = secondCall[4] as any[];

    // Should have 4 messages: 2 rounds of (assistant + user)
    expect(toolConvo).toHaveLength(4);
    expect(toolConvo[0].role).toBe('assistant');
    expect(toolConvo[1].role).toBe('user');
    expect(toolConvo[2].role).toBe('assistant');
    expect(toolConvo[3].role).toBe('user');
  });

  it('omits text block from assistant content when text is empty', async () => {
    mockCallDomain.mockResolvedValue({
      text: '', // No text, just tool call
      toolCalls: [{
        type: 'tool_use', id: 'tc1', name: 'get_calendar_events',
        input: { start_date: '2026-04-02', end_date: '2026-04-02' },
      }] as any,
      stopReason: 'tool_use',
    });

    executor.mockResolvedValue({ events: [] });

    mockContinue.mockResolvedValue({
      text: 'No events today.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    await provider.callDomainWithToolLoop('secretary', [], 'events?', '', executor);

    const toolConvo = mockContinue.mock.calls[0][4] as any[];
    const assistantContent = toolConvo[0].content as any[];

    // Should only have the tool_use block, no empty text block
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0].type).toBe('tool_use');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Edge cases and safety
// ═══════════════════════════════════════════════════════════════════

describe('Tool loop edge cases', () => {
  let provider: AnthropicProvider;
  let executor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new AnthropicProvider();
    executor = vi.fn();
    mockCallDomain.mockReset();
    mockContinue.mockReset();
  });

  it('handles executor throwing an error (tool fails)', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use', id: 'tc1', name: 'ms_todo_get_tasks',
        input: { list_id: 'x', list_name: 'Y' },
      }] as any,
      stopReason: 'tool_use',
    });

    // Executor throws — this should propagate
    executor.mockRejectedValue(new Error('Microsoft Graph 401'));

    await expect(
      provider.callDomainWithToolLoop('secretary', [], 'tasks', '', executor),
    ).rejects.toThrow('Microsoft Graph 401');
  });

  it('returns final text even if some iterations had text', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Thinking about it...',
      toolCalls: [{
        type: 'tool_use', id: 'tc1', name: 'tool_a', input: {},
      }] as any,
      stopReason: 'tool_use',
    });

    executor.mockResolvedValue({});

    mockContinue.mockResolvedValue({
      text: 'Here is your final answer.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'question', '', executor,
    );

    // Should return the LAST text, not concatenate all
    expect(result.text).toBe('Here is your final answer.');
  });

  it('defaults to maxIterations=5 when not specified', async () => {
    const toolResponse = {
      text: '',
      toolCalls: [{
        type: 'tool_use', id: 'tc_loop', name: 'recursive_tool', input: {},
      }] as any,
      stopReason: 'tool_use',
    };

    mockCallDomain.mockResolvedValue(toolResponse);
    mockContinue.mockResolvedValue(toolResponse);
    executor.mockResolvedValue({});

    await provider.callDomainWithToolLoop('secretary', [], 'loop', '', executor);

    // Default is 5 iterations
    expect(mockContinue).toHaveBeenCalledTimes(5);
  });

  it('handles tool executor returning undefined', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use', id: 'tc1', name: 'some_tool', input: {},
      }] as any,
      stopReason: 'tool_use',
    });

    executor.mockResolvedValue(undefined);

    mockContinue.mockResolvedValue({
      text: 'Done.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'do it', '', executor,
    );

    expect(result.text).toBe('Done.');
    // Verify the tool result was JSON.stringify(undefined) which is undefined/null
    const toolConvo = mockContinue.mock.calls[0][4] as any[];
    const toolResult = (toolConvo[1].content as any[])[0];
    // JSON.stringify(undefined) returns undefined, but in the template literal it becomes "undefined"
    expect(toolResult.type).toBe('tool_result');
  });

  it('returns empty toolsUsed when no tool calls happen', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Simple answer.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await provider.callDomainWithToolLoop(
      'content', [], 'hello', '', executor,
    );

    expect(result.text).toBe('Simple answer.');
    expect(result.toolsUsed).toEqual([]);
    expect(executor).not.toHaveBeenCalled();
    expect(mockContinue).not.toHaveBeenCalled();
  });

  it('handles multiple parallel tool calls in one round', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [
        { type: 'tool_use', id: 'tc_a', name: 'get_calendar_events', input: { start_date: '2026-04-02', end_date: '2026-04-02' } },
        { type: 'tool_use', id: 'tc_b', name: 'ms_todo_get_tasks', input: { list_id: 'work', list_name: 'Work' } },
        { type: 'tool_use', id: 'tc_c', name: 'get_weather', input: { location: 'SP' } },
      ] as any,
      stopReason: 'tool_use',
    });

    executor
      .mockResolvedValueOnce({ events: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ temp: 25, condition: 'sunny' });

    mockContinue.mockResolvedValue({
      text: 'No events, no tasks, 25°C and sunny in SP.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'briefing', '', executor,
    );

    expect(result.text).toContain('25°C');
    expect(result.toolsUsed).toEqual(['get_calendar_events', 'ms_todo_get_tasks', 'get_weather']);
    expect(executor).toHaveBeenCalledTimes(3);

    // All 3 tool results should be in a single user message
    const toolConvo = mockContinue.mock.calls[0][4] as any[];
    const userResults = toolConvo[1].content as any[];
    expect(userResults).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// AIToolCall type validation
// ═══════════════════════════════════════════════════════════════════

describe('AIToolCall type contracts', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider();
    mockCallDomain.mockReset();
  });

  it('converts Anthropic ToolUseBlock to AIToolCall with all fields', async () => {
    mockCallDomain.mockResolvedValue({
      text: '',
      toolCalls: [{
        type: 'tool_use',
        id: 'toolu_complex_123',
        name: 'ms_todo_create_task',
        input: {
          list_id: 'abc-123',
          list_name: 'Work',
          title: 'Deploy v2.1',
          body: 'Release notes: ...',
          importance: 'high',
        },
      }] as any,
      stopReason: 'tool_use',
    });

    const result = await provider.callDomain('secretary', [], 'create task', '');

    expect(result.toolCalls).toHaveLength(1);
    const tc = result.toolCalls[0];
    expect(tc.type).toBe('tool_use');
    expect(tc.id).toBe('toolu_complex_123');
    expect(tc.name).toBe('ms_todo_create_task');
    expect(tc.input).toEqual({
      list_id: 'abc-123',
      list_name: 'Work',
      title: 'Deploy v2.1',
      body: 'Release notes: ...',
      importance: 'high',
    });
  });

  it('returns empty toolCalls array for non-tool responses', async () => {
    mockCallDomain.mockResolvedValue({
      text: 'Just a conversation.',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await provider.callDomain('content', [], 'hello', '');
    expect(result.toolCalls).toEqual([]);
    expect(Array.isArray(result.toolCalls)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider callDomainWithToolLoop delegation
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider tool loop delegation', () => {
  function createMockProvider(name: string) {
    return {
      name,
      classify: vi.fn(),
      callDomain: vi.fn(),
      continueWithToolResults: vi.fn(),
      callDomainWithToolLoop: vi.fn(),
    } as AIProvider & { callDomainWithToolLoop: ReturnType<typeof vi.fn> };
  }

  it('delegates callDomainWithToolLoop to primary when healthy', async () => {
    const primary = createMockProvider('anthropic');
    const fallback = createMockProvider('openai');
    const provider = new FallbackProvider(primary, fallback);

    primary.callDomainWithToolLoop.mockResolvedValue({
      text: 'Briefing ready.',
      toolsUsed: ['get_calendar_events', 'ms_todo_get_tasks'],
    });

    const executor = vi.fn();
    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'briefing', '', executor,
    );

    expect(result.text).toBe('Briefing ready.');
    expect(result.toolsUsed).toEqual(['get_calendar_events', 'ms_todo_get_tasks']);
    expect(fallback.callDomainWithToolLoop).not.toHaveBeenCalled();
  });

  it('falls back when primary callDomainWithToolLoop throws', async () => {
    const primary = createMockProvider('anthropic');
    const fallback = createMockProvider('openai');
    const onFallback = vi.fn();
    const provider = new FallbackProvider(primary, fallback, onFallback);

    primary.callDomainWithToolLoop.mockRejectedValue(new Error('Anthropic 529'));
    fallback.callDomainWithToolLoop.mockResolvedValue({
      text: 'Fallback briefing.',
      toolsUsed: ['get_calendar_events'],
    });

    const executor = vi.fn();
    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'briefing', '', executor,
    );

    expect(result.text).toBe('Fallback briefing.');
    expect(onFallback).toHaveBeenCalledWith(expect.any(Error), 'callDomainWithToolLoop');
  });
});
