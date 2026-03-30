/**
 * AI Provider Tests
 *
 * Tests the AIProvider interface, AnthropicProvider adapter,
 * and FallbackProvider chain logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FallbackProvider, getModelRouting } from '../../src/services/ai-provider';
import type { AIProvider, AICallResult, ProviderModelConfig } from '../../src/services/ai-provider';
import type { ClassificationResult } from '../../src/domains/types';

// ─── Helper: create a mock AIProvider ────────────────────────────────

function createMockProvider(name: string): AIProvider & {
  classify: ReturnType<typeof vi.fn>;
  callDomain: ReturnType<typeof vi.fn>;
  continueWithToolResults: ReturnType<typeof vi.fn>;
} {
  return {
    name,
    classify: vi.fn(),
    callDomain: vi.fn(),
    continueWithToolResults: vi.fn(),
  };
}

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider', () => {
  let primary: ReturnType<typeof createMockProvider>;
  let fallback: ReturnType<typeof createMockProvider>;
  let onFallback: ReturnType<typeof vi.fn>;
  let provider: FallbackProvider;

  beforeEach(() => {
    primary = createMockProvider('primary');
    fallback = createMockProvider('fallback');
    onFallback = vi.fn();
    provider = new FallbackProvider(primary, fallback, onFallback);
  });

  it('has a composite name', () => {
    expect(provider.name).toBe('primary→fallback');
  });

  describe('classify', () => {
    it('uses primary when it succeeds', async () => {
      const expected: ClassificationResult = { domain: 'triathlon', confidence: 0.9 };
      primary.classify.mockResolvedValue(expected);

      const result = await provider.classify('workout plan');
      expect(result).toEqual(expected);
      expect(fallback.classify).not.toHaveBeenCalled();
      expect(onFallback).not.toHaveBeenCalled();
    });

    it('falls back when primary throws', async () => {
      const error = new Error('API rate limit');
      primary.classify.mockRejectedValue(error);
      const expected: ClassificationResult = { domain: 'secretary', confidence: 0.7 };
      fallback.classify.mockResolvedValue(expected);

      const result = await provider.classify('help me');
      expect(result).toEqual(expected);
      expect(onFallback).toHaveBeenCalledWith(error, 'classify');
    });

    it('propagates if both fail', async () => {
      primary.classify.mockRejectedValue(new Error('primary down'));
      fallback.classify.mockRejectedValue(new Error('fallback down'));

      await expect(provider.classify('test')).rejects.toThrow('fallback down');
    });
  });

  describe('callDomain', () => {
    const mockResult: AICallResult = {
      text: 'Hello!',
      toolCalls: [],
      stopReason: 'end_turn',
    };

    it('uses primary when it succeeds', async () => {
      primary.callDomain.mockResolvedValue(mockResult);

      const result = await provider.callDomain('secretary', [], 'hi', '');
      expect(result).toEqual(mockResult);
      expect(fallback.callDomain).not.toHaveBeenCalled();
    });

    it('falls back when primary throws', async () => {
      primary.callDomain.mockRejectedValue(new Error('timeout'));
      fallback.callDomain.mockResolvedValue(mockResult);

      const result = await provider.callDomain('secretary', [], 'hi', '');
      expect(result).toEqual(mockResult);
      expect(onFallback).toHaveBeenCalledWith(expect.any(Error), 'callDomain');
    });
  });

  describe('continueWithToolResults', () => {
    const mockResult: AICallResult = {
      text: 'Done!',
      toolCalls: [],
      stopReason: 'end_turn',
    };

    it('uses primary when it succeeds', async () => {
      primary.continueWithToolResults.mockResolvedValue(mockResult);

      const result = await provider.continueWithToolResults('secretary', [], 'hi', '', []);
      expect(result).toEqual(mockResult);
    });

    it('falls back when primary throws', async () => {
      primary.continueWithToolResults.mockRejectedValue(new Error('500'));
      fallback.continueWithToolResults.mockResolvedValue(mockResult);

      const result = await provider.continueWithToolResults('secretary', [], 'hi', '', []);
      expect(result).toEqual(mockResult);
      expect(onFallback).toHaveBeenCalledWith(expect.any(Error), 'continueWithToolResults');
    });
  });

  describe('without onFallback callback', () => {
    it('still falls back gracefully', async () => {
      const noCallbackProvider = new FallbackProvider(primary, fallback);
      primary.classify.mockRejectedValue(new Error('down'));
      fallback.classify.mockResolvedValue({ domain: 'secretary', confidence: 0.5 });

      const result = await noCallbackProvider.classify('test');
      expect(result.domain).toBe('secretary');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// AnthropicProvider (adapter over existing anthropic.ts)
// ═══════════════════════════════════════════════════════════════════

// Mock the underlying anthropic.ts functions
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
import { classifyMessage, callDomain, continueWithToolResults } from '../../src/services/anthropic';

const mockClassify = vi.mocked(classifyMessage);
const mockCallDomain = vi.mocked(callDomain);
const mockContinue = vi.mocked(continueWithToolResults);

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    provider = new AnthropicProvider();
    mockClassify.mockReset();
    mockCallDomain.mockReset();
    mockContinue.mockReset();
  });

  it('has name "anthropic"', () => {
    expect(provider.name).toBe('anthropic');
  });

  describe('classify', () => {
    it('delegates to classifyMessage', async () => {
      mockClassify.mockResolvedValue({ domain: 'triathlon', confidence: 0.95 });

      const result = await provider.classify('workout plan');
      expect(result).toEqual({ domain: 'triathlon', confidence: 0.95 });
      expect(mockClassify).toHaveBeenCalledWith('workout plan', undefined);
    });

    it('passes context through', async () => {
      mockClassify.mockResolvedValue({ domain: 'content', confidence: 0.8 });
      const ctx = { domain: 'content' as const, lastAssistantMessage: 'Your reel is ready' };

      await provider.classify('thanks', ctx);
      expect(mockClassify).toHaveBeenCalledWith('thanks', ctx);
    });
  });

  describe('callDomain', () => {
    it('delegates and converts tool calls to provider-agnostic format', async () => {
      mockCallDomain.mockResolvedValue({
        text: 'I\'ll create that task',
        toolCalls: [{
          type: 'tool_use',
          id: 'toolu_123',
          name: 'ms_todo_create_task',
          input: { list_id: 'abc', list_name: 'Work', title: 'Deploy' },
        }] as any,
        stopReason: 'tool_use',
      });

      const result = await provider.callDomain('secretary', [], 'create a task', 'state');
      expect(result.text).toBe('I\'ll create that task');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('ms_todo_create_task');
      expect(result.toolCalls[0].id).toBe('toolu_123');
      expect(result.stopReason).toBe('tool_use');
    });

    it('handles responses with no tool calls', async () => {
      mockCallDomain.mockResolvedValue({
        text: 'Here is your plan',
        toolCalls: [],
        stopReason: 'end_turn',
      });

      const result = await provider.callDomain('triathlon', [], 'training plan', '');
      expect(result.toolCalls).toEqual([]);
      expect(result.stopReason).toBe('end_turn');
    });

    it('passes maxTokensOverride through', async () => {
      mockCallDomain.mockResolvedValue({ text: 'ok', toolCalls: [], stopReason: 'end_turn' });

      await provider.callDomain('secretary', [], 'msg', 'ctx', 4096);
      expect(mockCallDomain).toHaveBeenCalledWith('secretary', [], 'msg', 'ctx', 4096);
    });
  });

  describe('continueWithToolResults', () => {
    it('delegates to continueWithToolResults', async () => {
      mockContinue.mockResolvedValue({
        text: 'Task created!',
        toolCalls: [],
        stopReason: 'end_turn',
      });

      const toolConvo = [
        { role: 'assistant' as const, content: 'tool call' },
        { role: 'user' as const, content: 'tool result' },
      ];

      const result = await provider.continueWithToolResults(
        'secretary', [], 'create task', 'state', toolConvo,
      );
      expect(result.text).toBe('Task created!');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Model Routing (shared helper)
// ═══════════════════════════════════════════════════════════════════

describe('getModelRouting', () => {
  const cfg: ProviderModelConfig = {
    model: 'expensive-model',
    classifierModel: 'cheap-model',
    maxTokens: 1024,
    secretaryMaxTokens: 2048,
  };

  it('secretary: expensive model + high token limit', () => {
    const r = getModelRouting(cfg, 'secretary');
    expect(r.model).toBe('expensive-model');
    expect(r.maxTokens).toBe(2048);
  });

  it('triathlon: cheap model + 2048 tokens (tool calls need headroom)', () => {
    const r = getModelRouting(cfg, 'triathlon');
    expect(r.model).toBe('cheap-model');
    expect(r.maxTokens).toBe(2048);
  });

  it('content: cheap model + default token limit', () => {
    const r = getModelRouting(cfg, 'content');
    expect(r.model).toBe('cheap-model');
    expect(r.maxTokens).toBe(1024);
  });
});
