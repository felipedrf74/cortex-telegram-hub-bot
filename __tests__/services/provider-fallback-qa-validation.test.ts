/**
 * QA Validation — Provider Fallback with Circuit Breaker
 *
 * Validates the TaskRoutingProvider and CircuitBreaker logic:
 * 1. Per-task-type routing (classify, chat, tool-use)
 * 2. Circuit breaker transitions: CLOSED → OPEN → HALF_OPEN → CLOSED
 * 3. Cooldown-based recovery probing
 * 4. Fallback delegation when circuit is open
 * 5. resolveTaskType mapping
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitState,
  TaskRoutingProvider,
  resolveTaskType,
  type TaskRoutingConfig,
  type FallbackEvent,
} from '../../src/services/provider-fallback';
import type { AIProvider, AICallResult } from '../../src/services/ai-provider';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

function createMockProvider(name: string) {
  return {
    name,
    classify: vi.fn(),
    callDomain: vi.fn(),
    continueWithToolResults: vi.fn(),
    callDomainWithToolLoop: vi.fn(),
  } as AIProvider & {
    classify: ReturnType<typeof vi.fn>;
    callDomain: ReturnType<typeof vi.fn>;
    continueWithToolResults: ReturnType<typeof vi.fn>;
    callDomainWithToolLoop: ReturnType<typeof vi.fn>;
  };
}

// ═══════════════════════════════════════════════════════════════════
// resolveTaskType
// ═══════════════════════════════════════════════════════════════════

describe('resolveTaskType', () => {
  it('maps secretary to tool-use', () => {
    expect(resolveTaskType('secretary')).toBe('tool-use');
  });

  it('maps triathlon to tool-use', () => {
    expect(resolveTaskType('triathlon')).toBe('tool-use');
  });

  it('maps content to chat', () => {
    expect(resolveTaskType('content')).toBe('chat');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CircuitBreaker
// ═══════════════════════════════════════════════════════════════════

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test-provider', {
      failureThreshold: 3,
      cooldownMs: 5000,
    });
  });

  it('starts in CLOSED state', () => {
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getFailureCount()).toBe(0);
    expect(breaker.canAttempt()).toBe(true);
  });

  it('stays CLOSED after fewer failures than threshold', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getFailureCount()).toBe(2);
    expect(breaker.canAttempt()).toBe(true);
  });

  it('opens after reaching failure threshold', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(breaker.canAttempt()).toBe(false);
  });

  it('resets failure count on success', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getFailureCount()).toBe(0);
  });

  it('transitions to HALF_OPEN after cooldown', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Simulate cooldown elapsed by using a breaker with 0ms cooldown
    const fastBreaker = new CircuitBreaker('fast', {
      failureThreshold: 1,
      cooldownMs: 0,
    });
    fastBreaker.recordFailure();
    expect(fastBreaker.getState()).toBe(CircuitState.OPEN);

    // After cooldown, canAttempt transitions to HALF_OPEN
    expect(fastBreaker.canAttempt()).toBe(true);
    expect(fastBreaker.getState()).toBe(CircuitState.HALF_OPEN);
  });

  it('closes on success during HALF_OPEN', () => {
    const fastBreaker = new CircuitBreaker('fast', {
      failureThreshold: 1,
      cooldownMs: 0,
    });
    fastBreaker.recordFailure();
    fastBreaker.canAttempt(); // trigger HALF_OPEN
    fastBreaker.recordSuccess();
    expect(fastBreaker.getState()).toBe(CircuitState.CLOSED);
    expect(fastBreaker.getFailureCount()).toBe(0);
  });

  it('re-opens on failure during HALF_OPEN', () => {
    const fastBreaker = new CircuitBreaker('fast', {
      failureThreshold: 1,
      cooldownMs: 0,
    });
    fastBreaker.recordFailure();
    fastBreaker.canAttempt(); // trigger HALF_OPEN
    fastBreaker.recordFailure();
    expect(fastBreaker.getState()).toBe(CircuitState.OPEN);
  });

  it('can be manually reset', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    breaker.reset();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getFailureCount()).toBe(0);
    expect(breaker.canAttempt()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TaskRoutingProvider
// ═══════════════════════════════════════════════════════════════════

describe('TaskRoutingProvider', () => {
  let anthropic: ReturnType<typeof createMockProvider>;
  let openai: ReturnType<typeof createMockProvider>;
  let onFallback: ReturnType<typeof vi.fn>;
  let provider: TaskRoutingProvider;

  beforeEach(() => {
    anthropic = createMockProvider('anthropic');
    openai = createMockProvider('openai');
    onFallback = vi.fn();

    const config: TaskRoutingConfig = {
      classify: { primary: anthropic, fallback: openai },
      chat: { primary: anthropic, fallback: openai },
      'tool-use': { primary: anthropic, fallback: openai },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60000 },
    };

    provider = new TaskRoutingProvider(config, onFallback);
  });

  it('has a composite name from unique providers', () => {
    expect(provider.name).toContain('anthropic');
    expect(provider.name).toContain('openai');
  });

  it('routes classify to primary when healthy', async () => {
    anthropic.classify.mockResolvedValue({ domain: 'secretary', confidence: 0.95 });

    const result = await provider.classify('hello');
    expect(result.domain).toBe('secretary');
    expect(openai.classify).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('falls back on classify failure', async () => {
    anthropic.classify.mockRejectedValue(new Error('429'));
    openai.classify.mockResolvedValue({ domain: 'secretary', confidence: 0.7 });

    const result = await provider.classify('hello');
    expect(result.domain).toBe('secretary');
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
      taskType: 'classify',
      primaryProvider: 'anthropic',
      fallbackProvider: 'openai',
      circuitOpen: false,
    }));
  });

  it('routes secretary callDomain as tool-use task type', async () => {
    const mockResult: AICallResult = { text: 'ok', toolCalls: [], stopReason: 'end_turn' };
    anthropic.callDomain.mockResolvedValue(mockResult);

    await provider.callDomain('secretary', [], 'hi', '');
    expect(anthropic.callDomain).toHaveBeenCalled();
  });

  it('routes content callDomain as chat task type', async () => {
    const mockResult: AICallResult = { text: 'ok', toolCalls: [], stopReason: 'end_turn' };
    anthropic.callDomain.mockResolvedValue(mockResult);

    await provider.callDomain('content', [], 'hi', '');
    expect(anthropic.callDomain).toHaveBeenCalled();
  });

  it('opens circuit after threshold failures and routes directly to fallback', async () => {
    const mockResult: AICallResult = { text: 'fallback', toolCalls: [], stopReason: 'end_turn' };
    anthropic.callDomain.mockRejectedValue(new Error('timeout'));
    openai.callDomain.mockResolvedValue(mockResult);

    // First failure
    await provider.callDomain('secretary', [], 'msg1', '');
    // Second failure — hits threshold (2)
    await provider.callDomain('secretary', [], 'msg2', '');

    // Third call — circuit should be open, goes directly to fallback
    const result = await provider.callDomain('secretary', [], 'msg3', '');
    expect(result.text).toBe('fallback');

    // Verify the third call triggered a circuit-open fallback event
    const lastFallbackCall = onFallback.mock.calls[onFallback.mock.calls.length - 1][0] as FallbackEvent;
    expect(lastFallbackCall.circuitOpen).toBe(true);
  });

  it('delegates callDomainWithToolLoop correctly', async () => {
    anthropic.callDomainWithToolLoop.mockResolvedValue({
      text: 'Briefing done.',
      toolsUsed: ['get_calendar_events'],
    });

    const executor = vi.fn();
    const result = await provider.callDomainWithToolLoop(
      'secretary', [], 'briefing', '', executor,
    );

    expect(result.text).toBe('Briefing done.');
    expect(result.toolsUsed).toEqual(['get_calendar_events']);
  });

  it('provides circuit state monitoring', async () => {
    anthropic.classify.mockRejectedValue(new Error('down'));
    openai.classify.mockResolvedValue({ domain: 'secretary', confidence: 0.5 });

    await provider.classify('test');
    await provider.classify('test2');

    const states = provider.getAllCircuitStates();
    expect(states['anthropic']).toBeDefined();
    expect(states['anthropic'].failures).toBe(2);
    expect(states['anthropic'].state).toBe(CircuitState.OPEN);
  });

  it('allows manual circuit reset', async () => {
    anthropic.classify.mockRejectedValue(new Error('down'));
    openai.classify.mockResolvedValue({ domain: 'secretary', confidence: 0.5 });

    await provider.classify('test');
    await provider.classify('test');

    expect(provider.getCircuitState('anthropic')).toBe(CircuitState.OPEN);

    provider.resetCircuit('anthropic');
    expect(provider.getCircuitState('anthropic')).toBe(CircuitState.CLOSED);
  });

  it('throws when circuit is open and no fallback configured', async () => {
    const config: TaskRoutingConfig = {
      classify: { primary: anthropic }, // no fallback!
      chat: { primary: anthropic },
      'tool-use': { primary: anthropic },
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60000 },
    };
    const noFallbackProvider = new TaskRoutingProvider(config);

    anthropic.classify.mockRejectedValue(new Error('down'));

    // First call fails and opens circuit
    await expect(noFallbackProvider.classify('test')).rejects.toThrow('down');

    // Second call — circuit open, no fallback
    await expect(noFallbackProvider.classify('test2')).rejects.toThrow(
      'circuit is open and no fallback',
    );
  });
});
