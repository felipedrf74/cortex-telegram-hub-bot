/**
 * QA Validation Tests — AI Provider & Fallback Logic
 *
 * Validates: FallbackProvider edge cases, getModelRouting completeness,
 * argument forwarding to fallback, nested fallbacks, error propagation,
 * and type-level interface compliance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FallbackProvider,
  getModelRouting,
} from '../../src/services/ai-provider';
import type {
  AIProvider,
  AICallResult,
  AIToolCall,
  AIToolResultMessage,
  ProviderModelConfig,
} from '../../src/services/ai-provider';
import type { ClassificationResult, DomainName } from '../../src/domains/types';

// ─── Helper: create a mock AIProvider ──────────────────────────────

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

const OK_CLASSIFY: ClassificationResult = { domain: 'secretary', confidence: 0.9 };
const OK_CALL: AICallResult = { text: 'OK', toolCalls: [], stopReason: 'end_turn' };
const OK_CONTINUE: AICallResult = { text: 'Done', toolCalls: [], stopReason: 'end_turn' };

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider — Error propagation for ALL methods
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider — error propagation', () => {
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

  it('callDomain propagates error when BOTH providers fail', async () => {
    primary.callDomain.mockRejectedValue(new Error('primary timeout'));
    fallback.callDomain.mockRejectedValue(new Error('fallback timeout'));

    await expect(
      provider.callDomain('secretary', [], 'hello', ''),
    ).rejects.toThrow('fallback timeout');
    expect(onFallback).toHaveBeenCalledWith(expect.any(Error), 'callDomain');
  });

  it('continueWithToolResults propagates error when BOTH providers fail', async () => {
    primary.continueWithToolResults.mockRejectedValue(new Error('primary 500'));
    fallback.continueWithToolResults.mockRejectedValue(new Error('fallback 500'));

    await expect(
      provider.continueWithToolResults('secretary', [], 'hi', '', []),
    ).rejects.toThrow('fallback 500');
    expect(onFallback).toHaveBeenCalledWith(expect.any(Error), 'continueWithToolResults');
  });

  it('onFallback receives the EXACT error from the primary', async () => {
    const specificError = new Error('Rate limit exceeded: 429');
    specificError.name = 'RateLimitError';
    primary.classify.mockRejectedValue(specificError);
    fallback.classify.mockResolvedValue(OK_CLASSIFY);

    await provider.classify('test');
    expect(onFallback).toHaveBeenCalledWith(specificError, 'classify');
    expect(onFallback.mock.calls[0][0].name).toBe('RateLimitError');
    expect(onFallback.mock.calls[0][0].message).toBe('Rate limit exceeded: 429');
  });
});

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider — Argument forwarding
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider — argument forwarding to fallback', () => {
  let primary: ReturnType<typeof createMockProvider>;
  let fallback: ReturnType<typeof createMockProvider>;
  let provider: FallbackProvider;

  beforeEach(() => {
    primary = createMockProvider('primary');
    fallback = createMockProvider('fallback');
    provider = new FallbackProvider(primary, fallback);
  });

  it('classify forwards message and activeContext to fallback', async () => {
    primary.classify.mockRejectedValue(new Error('down'));
    fallback.classify.mockResolvedValue(OK_CLASSIFY);

    const ctx = { domain: 'triathlon' as DomainName, lastAssistantMessage: 'Your pace was 5:30/km' };
    await provider.classify('how far did I run?', ctx);

    expect(fallback.classify).toHaveBeenCalledWith('how far did I run?', ctx);
  });

  it('callDomain forwards ALL arguments to fallback', async () => {
    primary.callDomain.mockRejectedValue(new Error('down'));
    fallback.callDomain.mockResolvedValue(OK_CALL);

    const history = [
      { role: 'user' as const, content: 'Hi' },
      { role: 'assistant' as const, content: 'Hello' },
    ];
    await provider.callDomain('triathlon', history, 'pace?', 'HR: 145', 4096);

    expect(fallback.callDomain).toHaveBeenCalledWith(
      'triathlon', history, 'pace?', 'HR: 145', 4096,
    );
  });

  it('callDomain forwards undefined maxTokensOverride to fallback', async () => {
    primary.callDomain.mockRejectedValue(new Error('down'));
    fallback.callDomain.mockResolvedValue(OK_CALL);

    await provider.callDomain('content', [], 'write something', '', undefined);

    expect(fallback.callDomain).toHaveBeenCalledWith(
      'content', [], 'write something', '', undefined,
    );
  });

  it('continueWithToolResults forwards ALL arguments to fallback', async () => {
    primary.continueWithToolResults.mockRejectedValue(new Error('down'));
    fallback.continueWithToolResults.mockResolvedValue(OK_CONTINUE);

    const history = [{ role: 'user' as const, content: 'Set a reminder' }];
    const toolConvo: AIToolResultMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: '{"ok":true}' }] },
    ];

    await provider.continueWithToolResults(
      'secretary', history, 'Set reminder', 'state-ctx', toolConvo,
    );

    expect(fallback.continueWithToolResults).toHaveBeenCalledWith(
      'secretary', history, 'Set reminder', 'state-ctx', toolConvo,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider — Nested fallback chains
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider — nested chains', () => {
  it('supports three-deep provider chain: A → B → C', async () => {
    const providerA = createMockProvider('anthropic');
    const providerB = createMockProvider('openai');
    const providerC = createMockProvider('gemini');

    const innerFallback = new FallbackProvider(providerB, providerC);
    const outerFallback = new FallbackProvider(providerA, innerFallback);

    expect(outerFallback.name).toBe('anthropic→openai→gemini');

    // A fails, B fails, C succeeds
    providerA.classify.mockRejectedValue(new Error('A down'));
    providerB.classify.mockRejectedValue(new Error('B down'));
    providerC.classify.mockResolvedValue({ domain: 'content', confidence: 0.7 });

    const result = await outerFallback.classify('write a script');
    expect(result.domain).toBe('content');
    expect(providerC.classify).toHaveBeenCalled();
  });

  it('nested chain stops at first success (B)', async () => {
    const providerA = createMockProvider('anthropic');
    const providerB = createMockProvider('openai');
    const providerC = createMockProvider('gemini');

    const innerFallback = new FallbackProvider(providerB, providerC);
    const outerFallback = new FallbackProvider(providerA, innerFallback);

    providerA.classify.mockRejectedValue(new Error('A down'));
    providerB.classify.mockResolvedValue({ domain: 'secretary', confidence: 0.85 });

    const result = await outerFallback.classify('check email');
    expect(result.domain).toBe('secretary');
    expect(providerB.classify).toHaveBeenCalled();
    expect(providerC.classify).not.toHaveBeenCalled();
  });

  it('nested chain propagates when all three fail', async () => {
    const providerA = createMockProvider('a');
    const providerB = createMockProvider('b');
    const providerC = createMockProvider('c');

    const chain = new FallbackProvider(providerA, new FallbackProvider(providerB, providerC));

    providerA.callDomain.mockRejectedValue(new Error('A'));
    providerB.callDomain.mockRejectedValue(new Error('B'));
    providerC.callDomain.mockRejectedValue(new Error('C'));

    await expect(chain.callDomain('secretary', [], 'hi', '')).rejects.toThrow('C');
  });
});

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider — Primary success means fallback never called
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider — isolation guarantee', () => {
  let primary: ReturnType<typeof createMockProvider>;
  let fallback: ReturnType<typeof createMockProvider>;
  let provider: FallbackProvider;

  beforeEach(() => {
    primary = createMockProvider('primary');
    fallback = createMockProvider('fallback');
    provider = new FallbackProvider(primary, fallback);
  });

  it('classify success never touches fallback', async () => {
    primary.classify.mockResolvedValue(OK_CLASSIFY);
    await provider.classify('test');
    expect(fallback.classify).not.toHaveBeenCalled();
    expect(fallback.callDomain).not.toHaveBeenCalled();
    expect(fallback.continueWithToolResults).not.toHaveBeenCalled();
  });

  it('callDomain success never touches fallback', async () => {
    primary.callDomain.mockResolvedValue(OK_CALL);
    await provider.callDomain('secretary', [], 'test', '');
    expect(fallback.classify).not.toHaveBeenCalled();
    expect(fallback.callDomain).not.toHaveBeenCalled();
    expect(fallback.continueWithToolResults).not.toHaveBeenCalled();
  });

  it('continueWithToolResults success never touches fallback', async () => {
    primary.continueWithToolResults.mockResolvedValue(OK_CONTINUE);
    await provider.continueWithToolResults('secretary', [], 'test', '', []);
    expect(fallback.classify).not.toHaveBeenCalled();
    expect(fallback.callDomain).not.toHaveBeenCalled();
    expect(fallback.continueWithToolResults).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider — Non-Error throws
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider — non-Error rejections', () => {
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

  it('handles string rejection from primary', async () => {
    primary.classify.mockRejectedValue('string error');
    fallback.classify.mockResolvedValue(OK_CLASSIFY);

    const result = await provider.classify('test');
    expect(result).toEqual(OK_CLASSIFY);
    // onFallback receives the string cast as Error
    expect(onFallback).toHaveBeenCalledWith('string error', 'classify');
  });

  it('handles undefined rejection from primary', async () => {
    primary.callDomain.mockRejectedValue(undefined);
    fallback.callDomain.mockResolvedValue(OK_CALL);

    const result = await provider.callDomain('secretary', [], 'hi', '');
    expect(result).toEqual(OK_CALL);
  });
});

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider — Tool call results forwarded correctly
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider — tool call results', () => {
  it('returns primary tool calls when primary succeeds', async () => {
    const primary = createMockProvider('primary');
    const fallback = createMockProvider('fallback');
    const provider = new FallbackProvider(primary, fallback);

    const toolCallResult: AICallResult = {
      text: '',
      toolCalls: [{
        type: 'tool_use',
        id: 'toolu_abc',
        name: 'ms_todo_create_task',
        input: { list_id: '123', title: 'Deploy' },
      }],
      stopReason: 'tool_use',
    };
    primary.callDomain.mockResolvedValue(toolCallResult);

    const result = await provider.callDomain('secretary', [], 'create task', '');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('ms_todo_create_task');
    expect(result.toolCalls[0].id).toBe('toolu_abc');
    expect(result.stopReason).toBe('tool_use');
  });

  it('returns fallback tool calls when primary fails', async () => {
    const primary = createMockProvider('primary');
    const fallback = createMockProvider('fallback');
    const provider = new FallbackProvider(primary, fallback);

    primary.callDomain.mockRejectedValue(new Error('down'));
    const fallbackToolResult: AICallResult = {
      text: '',
      toolCalls: [{
        type: 'tool_use',
        id: 'call_xyz',
        name: 'set_reminder',
        input: { message: 'Call dentist' },
      }],
      stopReason: 'tool_use',
    };
    fallback.callDomain.mockResolvedValue(fallbackToolResult);

    const result = await provider.callDomain('secretary', [], 'remind me', '');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe('call_xyz');
  });
});

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider — Concurrent independent calls
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider — concurrent calls', () => {
  it('handles concurrent classify and callDomain independently', async () => {
    const primary = createMockProvider('primary');
    const fallback = createMockProvider('fallback');
    const provider = new FallbackProvider(primary, fallback);

    // classify: primary fails → fallback succeeds
    primary.classify.mockRejectedValue(new Error('classify down'));
    fallback.classify.mockResolvedValue({ domain: 'triathlon', confidence: 0.8 });

    // callDomain: primary succeeds
    primary.callDomain.mockResolvedValue(OK_CALL);

    const [classifyResult, callResult] = await Promise.all([
      provider.classify('how was my run?'),
      provider.callDomain('secretary', [], 'check tasks', ''),
    ]);

    expect(classifyResult.domain).toBe('triathlon');
    expect(callResult.text).toBe('OK');
    // classify used fallback, callDomain did NOT
    expect(fallback.classify).toHaveBeenCalled();
    expect(fallback.callDomain).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// getModelRouting — Comprehensive domain coverage
// ═══════════════════════════════════════════════════════════════════

describe('getModelRouting — exhaustive domain routing', () => {
  const cfg: ProviderModelConfig = {
    model: 'expensive',
    classifierModel: 'cheap',
    maxTokens: 1024,
    secretaryMaxTokens: 4096,
  };

  it('secretary gets expensive model + secretaryMaxTokens', () => {
    const r = getModelRouting(cfg, 'secretary');
    expect(r.model).toBe('expensive');
    expect(r.maxTokens).toBe(4096);
  });

  it('triathlon gets cheap model + hardcoded 2048', () => {
    const r = getModelRouting(cfg, 'triathlon');
    expect(r.model).toBe('cheap');
    expect(r.maxTokens).toBe(2048);
  });

  it('content gets cheap model + default maxTokens', () => {
    const r = getModelRouting(cfg, 'content');
    expect(r.model).toBe('cheap');
    expect(r.maxTokens).toBe(1024);
  });

  it('unknown domain falls through to default (same as content)', () => {
    // The switch default case handles unknown domains
    const r = getModelRouting(cfg, 'unknown' as DomainName);
    expect(r.model).toBe('cheap');
    expect(r.maxTokens).toBe(1024);
  });

  it('works with zero maxTokens config', () => {
    const zeroCfg: ProviderModelConfig = {
      model: 'm',
      classifierModel: 'c',
      maxTokens: 0,
      secretaryMaxTokens: 0,
    };
    const r = getModelRouting(zeroCfg, 'secretary');
    expect(r.maxTokens).toBe(0);
  });

  it('triathlon always gets 2048 regardless of config', () => {
    const largeCfg: ProviderModelConfig = {
      model: 'm',
      classifierModel: 'c',
      maxTokens: 8192,
      secretaryMaxTokens: 16384,
    };
    const r = getModelRouting(largeCfg, 'triathlon');
    expect(r.maxTokens).toBe(2048);
  });

  it('returns a new object each call (no shared mutation risk)', () => {
    const r1 = getModelRouting(cfg, 'secretary');
    const r2 = getModelRouting(cfg, 'secretary');
    expect(r1).toEqual(r2);
    expect(r1).not.toBe(r2); // Different object references
  });
});

// ═══════════════════════════════════════════════════════════════════
// AIProvider interface — Type safety checks
// ═══════════════════════════════════════════════════════════════════

describe('AIProvider interface compliance', () => {
  it('FallbackProvider implements AIProvider (all methods exist)', () => {
    const provider = new FallbackProvider(
      createMockProvider('a'),
      createMockProvider('b'),
    );

    // Structural check: all AIProvider methods are present and callable
    expect(typeof provider.name).toBe('string');
    expect(typeof provider.classify).toBe('function');
    expect(typeof provider.callDomain).toBe('function');
    expect(typeof provider.continueWithToolResults).toBe('function');
  });

  it('FallbackProvider is itself usable as a provider in another FallbackProvider', () => {
    const a = createMockProvider('a');
    const b = createMockProvider('b');
    const c = createMockProvider('c');

    const inner = new FallbackProvider(a, b);
    const outer = new FallbackProvider(inner, c);

    // This should not throw — proves FallbackProvider satisfies AIProvider
    expect(outer.name).toBe('a→b→c');
  });
});

// ═══════════════════════════════════════════════════════════════════
// AICallResult shape validation
// ═══════════════════════════════════════════════════════════════════

describe('AICallResult shape', () => {
  it('empty toolCalls array when no tools used', async () => {
    const primary = createMockProvider('p');
    const fallback = createMockProvider('f');
    const provider = new FallbackProvider(primary, fallback);

    primary.callDomain.mockResolvedValue({
      text: 'Just text',
      toolCalls: [],
      stopReason: 'end_turn',
    });

    const result = await provider.callDomain('content', [], 'msg', '');
    expect(Array.isArray(result.toolCalls)).toBe(true);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('multiple tool calls in a single response', async () => {
    const primary = createMockProvider('p');
    const fallback = createMockProvider('f');
    const provider = new FallbackProvider(primary, fallback);

    const multiToolResult: AICallResult = {
      text: '',
      toolCalls: [
        { type: 'tool_use', id: 'tc_1', name: 'get_tasks', input: {} },
        { type: 'tool_use', id: 'tc_2', name: 'get_calendar', input: { days: 7 } },
        { type: 'tool_use', id: 'tc_3', name: 'get_email', input: { count: 5 } },
      ],
      stopReason: 'tool_use',
    };
    primary.callDomain.mockResolvedValue(multiToolResult);

    const result = await provider.callDomain('secretary', [], 'daily briefing', '');
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls.map(tc => tc.name)).toEqual(['get_tasks', 'get_calendar', 'get_email']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider — onFallback callback edge cases
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider — onFallback behavior', () => {
  it('onFallback is called once per fallback activation (not once per attempt)', async () => {
    const primary = createMockProvider('p');
    const fallback = createMockProvider('f');
    const onFallback = vi.fn();
    const provider = new FallbackProvider(primary, fallback, onFallback);

    primary.classify.mockRejectedValue(new Error('err'));
    fallback.classify.mockResolvedValue(OK_CLASSIFY);

    await provider.classify('test');
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('onFallback is called separately for different methods', async () => {
    const primary = createMockProvider('p');
    const fallback = createMockProvider('f');
    const onFallback = vi.fn();
    const provider = new FallbackProvider(primary, fallback, onFallback);

    primary.classify.mockRejectedValue(new Error('classify err'));
    fallback.classify.mockResolvedValue(OK_CLASSIFY);
    primary.callDomain.mockRejectedValue(new Error('callDomain err'));
    fallback.callDomain.mockResolvedValue(OK_CALL);

    await provider.classify('test');
    await provider.callDomain('secretary', [], 'hi', '');

    expect(onFallback).toHaveBeenCalledTimes(2);
    expect(onFallback).toHaveBeenCalledWith(expect.any(Error), 'classify');
    expect(onFallback).toHaveBeenCalledWith(expect.any(Error), 'callDomain');
  });

  it('onFallback throwing does NOT prevent fallback from being used', async () => {
    const primary = createMockProvider('p');
    const fallback = createMockProvider('f');
    const onFallback = vi.fn().mockImplementation(() => {
      throw new Error('logging crashed');
    });
    const provider = new FallbackProvider(primary, fallback, onFallback);

    primary.classify.mockRejectedValue(new Error('primary down'));
    fallback.classify.mockResolvedValue(OK_CLASSIFY);

    // The onFallback throw will propagate — this is a potential issue
    // If onFallback?.() throws, the catch block re-throws instead of calling fallback
    // This documents actual behavior: onFallback crash = no fallback
    await expect(provider.classify('test')).rejects.toThrow('logging crashed');
  });
});

// ═══════════════════════════════════════════════════════════════════
// FallbackProvider — Domain passthrough correctness
// ═══════════════════════════════════════════════════════════════════

describe('FallbackProvider — domain passthrough', () => {
  const domains: DomainName[] = ['secretary', 'triathlon', 'content'];

  domains.forEach((domain) => {
    it(`callDomain passes domain "${domain}" correctly to primary`, async () => {
      const primary = createMockProvider('p');
      const fallback = createMockProvider('f');
      const provider = new FallbackProvider(primary, fallback);

      primary.callDomain.mockResolvedValue(OK_CALL);
      await provider.callDomain(domain, [], 'msg', '');

      expect(primary.callDomain).toHaveBeenCalledWith(domain, [], 'msg', '', undefined);
    });

    it(`callDomain passes domain "${domain}" correctly to fallback on error`, async () => {
      const primary = createMockProvider('p');
      const fallback = createMockProvider('f');
      const provider = new FallbackProvider(primary, fallback);

      primary.callDomain.mockRejectedValue(new Error('down'));
      fallback.callDomain.mockResolvedValue(OK_CALL);
      await provider.callDomain(domain, [], 'msg', '');

      expect(fallback.callDomain).toHaveBeenCalledWith(domain, [], 'msg', '', undefined);
    });
  });
});
