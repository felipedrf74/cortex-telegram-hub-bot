/**
 * Provider Fallback Tests
 *
 * Tests CircuitBreaker state machine, TaskRoutingProvider per-task-type
 * routing, and auto-switch-on-failure behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitState,
  TaskRoutingProvider,
  TaskProviderPair,
  TaskRoutingConfig,
  resolveTaskType,
  FallbackEvent,
} from '../../src/services/provider-fallback';
import type { AIProvider, AICallResult } from '../../src/services/ai-provider';
import type { ClassificationResult } from '../../src/domains/types';

// ─── Mocks ─────────────────────────────────────────────────────────

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

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

const OK_RESULT: AICallResult = { text: 'ok', toolCalls: [], stopReason: 'end_turn' };
const CLASSIFY_OK: ClassificationResult = { domain: 'secretary', confidence: 0.9 };

// ═══════════════════════════════════════════════════════════════════
// resolveTaskType
// ═══════════════════════════════════════════════════════════════════

describe('resolveTaskType', () => {
  it('secretary → tool-use', () => {
    expect(resolveTaskType('secretary')).toBe('tool-use');
  });

  it('triathlon → tool-use', () => {
    expect(resolveTaskType('triathlon')).toBe('tool-use');
  });

  it('content → chat', () => {
    expect(resolveTaskType('content')).toBe('chat');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CircuitBreaker
// ═══════════════════════════════════════════════════════════════════

describe('CircuitBreaker', () => {
  const opts = { failureThreshold: 3, cooldownMs: 1000 };

  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker('test', opts);
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.canAttempt()).toBe(true);
  });

  it('stays CLOSED below threshold', () => {
    const cb = new CircuitBreaker('test', opts);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.canAttempt()).toBe(true);
    expect(cb.getFailureCount()).toBe(2);
  });

  it('opens after reaching failure threshold', () => {
    const cb = new CircuitBreaker('test', opts);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.canAttempt()).toBe(false);
  });

  it('success resets failure count and closes circuit', () => {
    const cb = new CircuitBreaker('test', opts);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.getFailureCount()).toBe(0);
  });

  it('transitions to HALF_OPEN after cooldown', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 50 });
    cb.recordFailure(); // Opens
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.canAttempt()).toBe(false);

    // Simulate cooldown elapsed by manipulating time
    vi.useFakeTimers();
    vi.advanceTimersByTime(51);
    expect(cb.canAttempt()).toBe(true);
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
    vi.useRealTimers();
  });

  it('HALF_OPEN → CLOSED on success', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 50 });
    cb.recordFailure();
    vi.useFakeTimers();
    vi.advanceTimersByTime(51);
    cb.canAttempt(); // Transitions to HALF_OPEN
    cb.recordSuccess();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    vi.useRealTimers();
  });

  it('HALF_OPEN → OPEN on failure (probe failed)', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 50 });
    cb.recordFailure();
    vi.useFakeTimers();
    vi.advanceTimersByTime(51);
    cb.canAttempt(); // Transitions to HALF_OPEN
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.OPEN);
    vi.useRealTimers();
  });

  it('reset() returns to CLOSED', () => {
    const cb = new CircuitBreaker('test', opts);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.OPEN);
    cb.reset();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.getFailureCount()).toBe(0);
  });

  it('threshold of 1 opens immediately on first failure', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 1000 });
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TaskRoutingProvider
// ═══════════════════════════════════════════════════════════════════

describe('TaskRoutingProvider', () => {
  let anthropic: ReturnType<typeof createMockProvider>;
  let openai: ReturnType<typeof createMockProvider>;
  let gemini: ReturnType<typeof createMockProvider>;
  let onFallback: ReturnType<typeof vi.fn>;
  let provider: TaskRoutingProvider;

  function buildConfig(overrides?: Partial<TaskRoutingConfig>): TaskRoutingConfig {
    return {
      classify: { primary: anthropic, fallback: openai },
      chat: { primary: openai, fallback: gemini },
      'tool-use': { primary: anthropic, fallback: gemini },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
      ...overrides,
    };
  }

  beforeEach(() => {
    anthropic = createMockProvider('anthropic');
    openai = createMockProvider('openai');
    gemini = createMockProvider('gemini');
    onFallback = vi.fn();
    provider = new TaskRoutingProvider(buildConfig(), onFallback);
  });

  it('has a composite name with all providers', () => {
    expect(provider.name).toContain('anthropic');
    expect(provider.name).toContain('openai');
    expect(provider.name).toContain('gemini');
  });

  // ─── classify (routes to "classify" task type) ─────────────────

  describe('classify', () => {
    it('routes to classify primary (anthropic)', async () => {
      anthropic.classify.mockResolvedValue(CLASSIFY_OK);
      const result = await provider.classify('test');
      expect(result).toEqual(CLASSIFY_OK);
      expect(anthropic.classify).toHaveBeenCalled();
      expect(openai.classify).not.toHaveBeenCalled();
    });

    it('falls back to classify fallback (openai) on error', async () => {
      anthropic.classify.mockRejectedValue(new Error('rate limit'));
      openai.classify.mockResolvedValue(CLASSIFY_OK);

      const result = await provider.classify('test');
      expect(result).toEqual(CLASSIFY_OK);
      expect(onFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'classify',
          primaryProvider: 'anthropic',
          fallbackProvider: 'openai',
        }),
      );
    });

    it('throws when both primary and fallback fail', async () => {
      anthropic.classify.mockRejectedValue(new Error('down'));
      openai.classify.mockRejectedValue(new Error('also down'));

      await expect(provider.classify('test')).rejects.toThrow('also down');
    });
  });

  // ─── callDomain (routes based on domain → task type) ────────────

  describe('callDomain', () => {
    it('secretary routes to tool-use primary (anthropic)', async () => {
      anthropic.callDomain.mockResolvedValue(OK_RESULT);
      const result = await provider.callDomain('secretary', [], 'msg', '');
      expect(result).toEqual(OK_RESULT);
      expect(anthropic.callDomain).toHaveBeenCalled();
    });

    it('content routes to chat primary (openai)', async () => {
      openai.callDomain.mockResolvedValue(OK_RESULT);
      const result = await provider.callDomain('content', [], 'msg', '');
      expect(result).toEqual(OK_RESULT);
      expect(openai.callDomain).toHaveBeenCalled();
      expect(anthropic.callDomain).not.toHaveBeenCalled();
    });

    it('triathlon routes to tool-use primary (anthropic)', async () => {
      anthropic.callDomain.mockResolvedValue(OK_RESULT);
      const result = await provider.callDomain('triathlon', [], 'msg', '');
      expect(result).toEqual(OK_RESULT);
      expect(anthropic.callDomain).toHaveBeenCalled();
    });

    it('falls back on error (secretary: anthropic → gemini)', async () => {
      anthropic.callDomain.mockRejectedValue(new Error('timeout'));
      gemini.callDomain.mockResolvedValue(OK_RESULT);

      const result = await provider.callDomain('secretary', [], 'msg', '');
      expect(result).toEqual(OK_RESULT);
      expect(gemini.callDomain).toHaveBeenCalled();
      expect(onFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'tool-use',
          primaryProvider: 'anthropic',
          fallbackProvider: 'gemini',
        }),
      );
    });

    it('passes maxTokensOverride through', async () => {
      anthropic.callDomain.mockResolvedValue(OK_RESULT);
      await provider.callDomain('secretary', [], 'msg', 'ctx', 4096);
      expect(anthropic.callDomain).toHaveBeenCalledWith('secretary', [], 'msg', 'ctx', 4096);
    });
  });

  // ─── continueWithToolResults ────────────────────────────────────

  describe('continueWithToolResults', () => {
    it('routes secretary to tool-use primary', async () => {
      anthropic.continueWithToolResults.mockResolvedValue(OK_RESULT);
      const result = await provider.continueWithToolResults('secretary', [], 'msg', '', []);
      expect(result).toEqual(OK_RESULT);
      expect(anthropic.continueWithToolResults).toHaveBeenCalled();
    });

    it('falls back on failure', async () => {
      anthropic.continueWithToolResults.mockRejectedValue(new Error('500'));
      gemini.continueWithToolResults.mockResolvedValue(OK_RESULT);

      const result = await provider.continueWithToolResults('secretary', [], 'msg', '', []);
      expect(result).toEqual(OK_RESULT);
      expect(gemini.continueWithToolResults).toHaveBeenCalled();
    });
  });

  // ─── Circuit breaker integration ────────────────────────────────

  describe('circuit breaker auto-switch', () => {
    it('skips primary after consecutive failures (circuit opens)', async () => {
      const cfg = buildConfig({
        circuitBreaker: { failureThreshold: 2, cooldownMs: 60000 },
      });
      const p = new TaskRoutingProvider(cfg, onFallback);

      // Fail twice to open circuit
      anthropic.classify.mockRejectedValue(new Error('fail'));
      openai.classify.mockResolvedValue(CLASSIFY_OK);
      await p.classify('msg1');
      await p.classify('msg2');
      expect(anthropic.classify).toHaveBeenCalledTimes(2);

      // Third call — circuit open, skip anthropic entirely
      anthropic.classify.mockClear();
      await p.classify('msg3');
      expect(anthropic.classify).not.toHaveBeenCalled();
      expect(openai.classify).toHaveBeenCalled();

      // Verify fallback event has circuitOpen: true
      const lastCall = onFallback.mock.calls[onFallback.mock.calls.length - 1][0] as FallbackEvent;
      expect(lastCall.circuitOpen).toBe(true);
    });

    it('circuit breaker state is per-provider, not per-task-type', async () => {
      // anthropic is primary for both classify and tool-use
      const cfg = buildConfig({
        circuitBreaker: { failureThreshold: 2, cooldownMs: 60000 },
      });
      const p = new TaskRoutingProvider(cfg, onFallback);

      // Fail anthropic via classify twice
      anthropic.classify.mockRejectedValue(new Error('fail'));
      openai.classify.mockResolvedValue(CLASSIFY_OK);
      await p.classify('msg1');
      await p.classify('msg2');

      // Now callDomain for secretary (also uses anthropic as primary)
      // should skip anthropic because its circuit is open
      gemini.callDomain.mockResolvedValue(OK_RESULT);
      await p.callDomain('secretary', [], 'msg', '');
      expect(anthropic.callDomain).not.toHaveBeenCalled();
      expect(gemini.callDomain).toHaveBeenCalled();
    });

    it('circuit recovery: success in half-open closes circuit', async () => {
      vi.useFakeTimers();

      const cfg = buildConfig({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 100 },
      });
      const p = new TaskRoutingProvider(cfg, onFallback);

      // Open circuit
      anthropic.classify.mockRejectedValue(new Error('fail'));
      openai.classify.mockResolvedValue(CLASSIFY_OK);
      await p.classify('msg1');
      expect(p.getCircuitState('anthropic')).toBe(CircuitState.OPEN);

      // Advance past cooldown
      vi.advanceTimersByTime(101);

      // Next call probes anthropic (half-open) — succeeds
      anthropic.classify.mockResolvedValue(CLASSIFY_OK);
      const result = await p.classify('msg2');
      expect(result).toEqual(CLASSIFY_OK);
      expect(anthropic.classify).toHaveBeenCalled();
      expect(p.getCircuitState('anthropic')).toBe(CircuitState.CLOSED);

      vi.useRealTimers();
    });
  });

  // ─── No fallback configured ─────────────────────────────────────

  describe('no fallback configured', () => {
    it('throws on primary failure when no fallback', async () => {
      const cfg = buildConfig({
        classify: { primary: anthropic },
      });
      const p = new TaskRoutingProvider(cfg);

      anthropic.classify.mockRejectedValue(new Error('API down'));
      await expect(p.classify('test')).rejects.toThrow('API down');
    });

    it('throws when circuit is open and no fallback', async () => {
      const cfg = buildConfig({
        classify: { primary: anthropic },
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60000 },
      });
      const p = new TaskRoutingProvider(cfg);

      anthropic.classify.mockRejectedValue(new Error('fail'));
      await expect(p.classify('msg1')).rejects.toThrow('fail');

      // Circuit is now open — next call throws immediately
      await expect(p.classify('msg2')).rejects.toThrow('no fallback configured');
    });
  });

  // ─── Monitoring ─────────────────────────────────────────────────

  describe('monitoring', () => {
    it('getAllCircuitStates returns all breaker states', async () => {
      anthropic.classify.mockResolvedValue(CLASSIFY_OK);
      openai.callDomain.mockResolvedValue(OK_RESULT);

      await provider.classify('msg');
      await provider.callDomain('content', [], 'msg', '');

      const states = provider.getAllCircuitStates();
      expect(states.anthropic).toEqual({ state: CircuitState.CLOSED, failures: 0 });
      expect(states.openai).toEqual({ state: CircuitState.CLOSED, failures: 0 });
    });

    it('resetCircuit restores provider to healthy', async () => {
      const cfg = buildConfig({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60000 },
      });
      const p = new TaskRoutingProvider(cfg);

      anthropic.classify.mockRejectedValue(new Error('fail'));
      openai.classify.mockResolvedValue(CLASSIFY_OK);
      await p.classify('msg');

      expect(p.getCircuitState('anthropic')).toBe(CircuitState.OPEN);
      p.resetCircuit('anthropic');
      expect(p.getCircuitState('anthropic')).toBe(CircuitState.CLOSED);
    });

    it('getCircuitState returns undefined for unknown provider', () => {
      expect(provider.getCircuitState('unknown')).toBeUndefined();
    });
  });

  // ─── onFallback not provided ────────────────────────────────────

  describe('without onFallback callback', () => {
    it('still falls back gracefully', async () => {
      const p = new TaskRoutingProvider(buildConfig());
      anthropic.classify.mockRejectedValue(new Error('down'));
      openai.classify.mockResolvedValue(CLASSIFY_OK);

      const result = await p.classify('test');
      expect(result.domain).toBe('secretary');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// ProviderMetrics tracking
// ═══════════════════════════════════════════════════════════════════

describe('ProviderMetrics tracking', () => {
  let primary: ReturnType<typeof createMockProvider>;
  let fallback: ReturnType<typeof createMockProvider>;
  let provider: TaskRoutingProvider;

  beforeEach(() => {
    primary = createMockProvider('anthropic');
    fallback = createMockProvider('openai');
    provider = new TaskRoutingProvider({
      classify: { primary, fallback },
      chat: { primary, fallback },
      'tool-use': { primary, fallback },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });
  });

  it('increments usageCount on successful primary call', async () => {
    primary.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('hello');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.usageCount).toBe(1);
    expect(health['anthropic'].metrics.failureCount).toBe(0);
    expect(health['anthropic'].metrics.lastSuccessAt).not.toBeNull();
  });

  it('increments usageCount AND failureCount on primary failure', async () => {
    primary.classify.mockRejectedValue(new Error('API down'));
    fallback.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('hello');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.usageCount).toBe(1);
    expect(health['anthropic'].metrics.failureCount).toBe(1);
    expect(health['anthropic'].metrics.lastFailureAt).not.toBeNull();
  });

  it('increments fallbackTriggerCount when fallback is used', async () => {
    primary.classify.mockRejectedValue(new Error('down'));
    fallback.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('hello');

    const health = provider.getProviderHealth();
    expect(health['openai'].metrics.fallbackTriggerCount).toBe(1);
  });

  it('tracks fallback usageCount when fallback executes', async () => {
    primary.classify.mockRejectedValue(new Error('down'));
    fallback.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('hello');

    const health = provider.getProviderHealth();
    expect(health['openai'].metrics.usageCount).toBe(1);
    expect(health['openai'].metrics.lastSuccessAt).not.toBeNull();
  });

  it('tracks fallback failureCount when fallback also fails', async () => {
    primary.classify.mockRejectedValue(new Error('primary down'));
    fallback.classify.mockRejectedValue(new Error('fallback down'));

    await expect(provider.classify('hello')).rejects.toThrow('fallback down');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.failureCount).toBe(1);
    expect(health['openai'].metrics.failureCount).toBe(1);
    expect(health['openai'].metrics.usageCount).toBe(1);
  });

  it('increments circuitOpenCount when circuit skips to fallback', async () => {
    // Fail 3 times to open circuit
    primary.classify.mockRejectedValue(new Error('down'));
    fallback.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('1');
    await provider.classify('2');
    await provider.classify('3');

    // Circuit now open — 4th call skips primary entirely
    await provider.classify('4');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.circuitOpenCount).toBeGreaterThanOrEqual(1);
    expect(health['anthropic'].circuit.state).toBe('OPEN');
  });

  it('sets lastSuccessAt timestamp on success', async () => {
    primary.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('test');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('sets lastFailureAt timestamp on failure', async () => {
    primary.classify.mockRejectedValue(new Error('fail'));
    fallback.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('test');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.lastFailureAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('getAllMetrics returns all tracked providers', async () => {
    primary.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('test');

    const metrics = provider.getAllMetrics();
    expect(metrics).toHaveProperty('anthropic');
    expect(metrics['anthropic'].usageCount).toBe(1);
  });

  it('getProviderHealth merges circuit state with metrics', async () => {
    primary.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('test');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].circuit).toBeDefined();
    expect(health['anthropic'].circuit.state).toBe('CLOSED');
    expect(health['anthropic'].circuit.failures).toBe(0);
    expect(health['anthropic'].metrics).toBeDefined();
    expect(health['anthropic'].metrics.usageCount).toBe(1);
  });

  it('accumulates metrics across multiple calls', async () => {
    primary.classify.mockResolvedValue(CLASSIFY_OK);
    await provider.classify('1');
    await provider.classify('2');
    await provider.classify('3');

    const health = provider.getProviderHealth();
    expect(health['anthropic'].metrics.usageCount).toBe(3);
  });

  it('tracks metrics independently across task types', async () => {
    primary.classify.mockRejectedValue(new Error('classify fail'));
    fallback.classify.mockResolvedValue(CLASSIFY_OK);
    primary.callDomain.mockResolvedValue(OK_RESULT);

    await provider.classify('test');
    await provider.callDomain('secretary', [], 'msg', '');

    const health = provider.getProviderHealth();
    // Primary failed classify but succeeded callDomain: 2 usage, 1 failure
    expect(health['anthropic'].metrics.usageCount).toBe(2);
    expect(health['anthropic'].metrics.failureCount).toBe(1);
  });
});
