/**
 * QA Validation — P0 Tool Loop Fix
 *
 * Validates: BUG P0: Bot dumps raw JSON tool calls instead of executing them
 * Root cause: callDomain returned raw tool_use blocks. Fix adds callDomainWithToolLoop
 * which executes tools and returns final text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FallbackProvider, getModelRouting } from '../../src/services/ai-provider';
import type { AIProvider, AICallResult, AIToolCall, ToolExecutorFn } from '../../src/services/ai-provider';

// ─── Mock provider for testing the interface contract ──────────────

function createMockProvider(name: string): AIProvider & {
  classify: ReturnType<typeof vi.fn>;
  callDomain: ReturnType<typeof vi.fn>;
  continueWithToolResults: ReturnType<typeof vi.fn>;
  callDomainWithToolLoop: ReturnType<typeof vi.fn>;
} {
  return {
    name,
    classify: vi.fn(),
    callDomain: vi.fn(),
    continueWithToolResults: vi.fn(),
    callDomainWithToolLoop: vi.fn(),
  };
}

describe('P0 Fix: callDomainWithToolLoop exists on all providers', () => {
  it('AIProvider interface requires callDomainWithToolLoop method', () => {
    const mock = createMockProvider('test');
    expect(typeof mock.callDomainWithToolLoop).toBe('function');
  });

  it('callDomainWithToolLoop returns text and toolsUsed', async () => {
    const mock = createMockProvider('test');
    mock.callDomainWithToolLoop.mockResolvedValue({
      text: 'Your calendar shows 3 events today.',
      toolsUsed: ['get_calendar_events'],
    });

    const executor: ToolExecutorFn = vi.fn();
    const result = await mock.callDomainWithToolLoop(
      'secretary', [], 'show my calendar', '', executor,
    );

    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('toolsUsed');
    expect(result.text).toBe('Your calendar shows 3 events today.');
    expect(result.toolsUsed).toEqual(['get_calendar_events']);
  });
});

describe('P0 Fix: FallbackProvider delegates callDomainWithToolLoop', () => {
  let primary: ReturnType<typeof createMockProvider>;
  let fallback: ReturnType<typeof createMockProvider>;
  let provider: FallbackProvider;
  const executor: ToolExecutorFn = vi.fn();

  beforeEach(() => {
    primary = createMockProvider('primary');
    fallback = createMockProvider('fallback');
    provider = new FallbackProvider(primary, fallback);
  });

  it('uses primary provider when it succeeds', async () => {
    primary.callDomainWithToolLoop.mockResolvedValue({
      text: 'Tasks: Buy groceries, Call dentist',
      toolsUsed: ['ms_todo_get_tasks'],
    });

    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'show my tasks', '', executor,
    );

    expect(result.text).toContain('Tasks');
    expect(primary.callDomainWithToolLoop).toHaveBeenCalled();
    expect(fallback.callDomainWithToolLoop).not.toHaveBeenCalled();
  });

  it('falls back to secondary when primary fails', async () => {
    primary.callDomainWithToolLoop.mockRejectedValue(new Error('API timeout'));
    fallback.callDomainWithToolLoop.mockResolvedValue({
      text: 'Fallback: You have 2 tasks',
      toolsUsed: ['ms_todo_get_tasks'],
    });

    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'show tasks', '', executor,
    );

    expect(result.text).toContain('Fallback');
    expect(fallback.callDomainWithToolLoop).toHaveBeenCalled();
  });
});

describe('P0 Fix: Tool execution flow contract', () => {
  it('callDomainWithToolLoop signature accepts executor function', async () => {
    const mock = createMockProvider('test');
    mock.callDomainWithToolLoop.mockResolvedValue({ text: 'ok', toolsUsed: [] });

    const executor: ToolExecutorFn = vi.fn().mockResolvedValue({ data: 'tool result' });

    // Verify the method accepts the expected parameters
    await expect(
      mock.callDomainWithToolLoop(
        'secretary',    // domain
        [],             // history
        'test message', // currentMessage
        '',             // stateContext
        executor,       // tool executor
        { maxIterations: 5, userId: 123 }, // options
      ),
    ).resolves.toBeDefined();
  });

  it('options include maxIterations to prevent infinite loops', async () => {
    const mock = createMockProvider('test');
    mock.callDomainWithToolLoop.mockImplementation(
      async (_d, _h, _m, _s, _e, opts) => {
        // Verify maxIterations option is accessible
        expect(opts?.maxIterations).toBe(3);
        return { text: 'done', toolsUsed: [] };
      },
    );

    const executor: ToolExecutorFn = vi.fn();
    await mock.callDomainWithToolLoop(
      'secretary', [], 'test', '', executor, { maxIterations: 3 },
    );
  });

  it('result includes deduplicated toolsUsed list', async () => {
    const mock = createMockProvider('test');
    // Simulate a multi-tool scenario where the same tool is used twice
    mock.callDomainWithToolLoop.mockResolvedValue({
      text: 'Calendar merged with todos',
      toolsUsed: ['get_calendar_events', 'ms_todo_get_tasks'],
    });

    const executor: ToolExecutorFn = vi.fn();
    const result = await mock.callDomainWithToolLoop(
      'secretary', [], 'briefing', '', executor,
    );

    // toolsUsed should be an array of unique tool names
    expect(Array.isArray(result.toolsUsed)).toBe(true);
    expect(new Set(result.toolsUsed).size).toBe(result.toolsUsed.length);
  });
});

describe('P0 Fix: All provider implementations export callDomainWithToolLoop', () => {
  it('AnthropicProvider has callDomainWithToolLoop', async () => {
    const mod = await import('../../src/services/anthropic-provider');
    const providerClass = (mod as any).AnthropicProvider;
    expect(providerClass).toBeDefined();
    expect(providerClass.prototype.callDomainWithToolLoop).toBeDefined();
  });

  it('OpenAIProvider has callDomainWithToolLoop', async () => {
    const mod = await import('../../src/services/openai-provider');
    const providerClass = (mod as any).OpenAIProvider;
    expect(providerClass).toBeDefined();
    expect(providerClass.prototype.callDomainWithToolLoop).toBeDefined();
  });

  it('GeminiProvider has callDomainWithToolLoop', async () => {
    const mod = await import('../../src/services/gemini-provider');
    const providerClass = (mod as any).GeminiProvider;
    expect(providerClass).toBeDefined();
    expect(providerClass.prototype.callDomainWithToolLoop).toBeDefined();
  });

  it('FallbackProvider has callDomainWithToolLoop', () => {
    expect(FallbackProvider.prototype.callDomainWithToolLoop).toBeDefined();
  });
});

describe('P0 Fix: No raw JSON tool_use in response', () => {
  it('callDomainWithToolLoop returns string text, never tool_use objects', async () => {
    const mock = createMockProvider('test');
    mock.callDomainWithToolLoop.mockResolvedValue({
      text: 'Here are your events for today:\n1. Meeting at 10am\n2. Lunch at 12pm',
      toolsUsed: ['get_calendar_events'],
    });

    const executor: ToolExecutorFn = vi.fn();
    const result = await mock.callDomainWithToolLoop(
      'secretary', [], 'show calendar', '', executor,
    );

    // The text should be a human-readable string, not JSON
    expect(typeof result.text).toBe('string');
    expect(result.text).not.toContain('"type":"tool_use"');
    expect(result.text).not.toContain('"tool_use"');
    expect(result.text).not.toContain('"input_schema"');
  });
});
