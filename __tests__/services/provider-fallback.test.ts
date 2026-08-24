/**
 * Provider Fallback Tests
 *
 * Tests CircuitBreaker state machine, TaskRoutingProvider per-task-type
 * routing, and auto-switch-on-failure behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIUserAbortError } from 'openai';
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
import { LocalLLMError } from '../../src/services/local-llm-error';

const freeTierAssertMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/free-tier-inference-binding', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/free-tier-inference-binding')>(
    '../../src/services/free-tier-inference-binding',
  )),
  assertFreeTierCloudDispatchAllowed: (...args: unknown[]) => freeTierAssertMock(...args),
}));

const optionalCloudMocks = vi.hoisted(() => {
  const provider = {
    name: 'gemini',
    callStructuredGeneration: vi.fn(),
  };
  return {
    provider,
    selectApprovedCloudReasoningProvider: vi.fn(async () => ({
      rejected: false as const,
      provider,
      model: 'gemini-test-model',
      privacyAction: 'sent_raw' as const,
    })),
  };
});

// ─── Mocks ─────────────────────────────────────────────────────────

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/cloud-reasoning-gate', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/cloud-reasoning-gate')>(
    '../../src/services/cloud-reasoning-gate',
  )),
  selectApprovedCloudReasoningProvider: (...args: unknown[]) => optionalCloudMocks.selectApprovedCloudReasoningProvider(...args),
}));

vi.mock('../../src/services/provider-registry', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/provider-registry')>(
    '../../src/services/provider-registry',
  )),
  getProvider: () => optionalCloudMocks.provider,
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
    optionalCloudMocks.provider.callStructuredGeneration.mockReset();
    optionalCloudMocks.provider.callStructuredGeneration.mockResolvedValue({
      text: 'cloud answer',
      stopReason: 'stop',
    });
    optionalCloudMocks.selectApprovedCloudReasoningProvider.mockClear();
    freeTierAssertMock.mockReset();
    provider = new TaskRoutingProvider(buildConfig(), onFallback);
  });

  it('has a composite name with all providers', () => {
    expect(provider.name).toContain('anthropic');
    expect(provider.name).toContain('openai');
    expect(provider.name).toContain('gemini');
  });

  it('runs explicit classifier shadow work through the shared provider circuit without fallback', async () => {
    const ollama = createMockProvider('ollama');
    ollama.classify.mockRejectedValue(new LocalLLMError('timeout'));
    const routed = new TaskRoutingProvider(buildConfig({
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    }), onFallback);

    await expect(routed.classifyShadowWithProvider(ollama, 'classify this', undefined, {
      source: 'shadow',
    })).rejects.toMatchObject({ kind: 'timeout' });
    expect(routed.getCircuitState('ollama')).toBe(CircuitState.OPEN);

    await expect(routed.classifyShadowWithProvider(ollama, 'classify this', undefined, {
      source: 'shadow',
    })).rejects.toMatchObject({ code: 'circuit_open' });
    expect(ollama.classify).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('does not mark classifier shadow queue pressure as provider-health failure', async () => {
    const ollama = createMockProvider('ollama');
    ollama.classify.mockRejectedValue(new LocalLLMError('capacity_exceeded'));
    const routed = new TaskRoutingProvider(buildConfig({
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    }), onFallback);

    await expect(routed.classifyShadowWithProvider(ollama, 'classify this', undefined, {
      source: 'shadow',
    })).rejects.toMatchObject({ kind: 'capacity_exceeded' });
    expect(routed.getCircuitState('ollama')).toBe(CircuitState.CLOSED);
  });

  it('never escalates a skill-inference request when its signed authority denies cloud', async () => {
    const localFailure = Object.assign(new Error('local timeout'), { code: 'ETIMEDOUT' });
    const ollama = {
      ...createMockProvider('ollama'),
      localReason: vi.fn().mockRejectedValue(localFailure),
    };
    const cloudBoundary = vi.fn(async (call: () => Promise<unknown>) => call());
    const localPrimary = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: ollama, fallback: 'approved_cloud_reasoning' },
    }));

    await expect(localPrimary.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'redacted content request',
      containsPrivateData: false,
      allowCloudEscalation: false,
      localAdmission: 'eligible',
      cloudFallbackBoundary: cloudBoundary,
    })).rejects.toMatchObject({ code: 'SKILL_INFERENCE_CLOUD_ESCALATION_NOT_AUTHORIZED' });
    expect(cloudBoundary).not.toHaveBeenCalled();
  });

  it('does not count or route around caller cancellation from optional local reasoning', async () => {
    const cancelled = new APIUserAbortError();
    const ollama = {
      ...createMockProvider('ollama'),
      localReason: vi.fn().mockRejectedValue(cancelled),
    };
    const cloudBoundary = vi.fn(async (call: () => Promise<unknown>) => call());
    const localPrimary = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: ollama, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    }));

    await expect(localPrimary.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'cancel this local operation',
      containsPrivateData: false,
      allowCloudEscalation: true,
      localAdmission: 'eligible',
      cloudFallbackBoundary: cloudBoundary,
    })).rejects.toBe(cancelled);

    expect(cloudBoundary).not.toHaveBeenCalled();
    expect(localPrimary.getProviderHealth().ollama).toEqual({
      circuit: { state: CircuitState.CLOSED, failures: 0 },
      metrics: {
        usageCount: 0,
        failureCount: 0,
        fallbackTriggerCount: 0,
        circuitOpenCount: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
      },
    });
  });

  it('surfaces a typed circuit-open reason for a local-only skill-inference attempt', async () => {
    const ollama = {
      ...createMockProvider('ollama'),
      localReason: vi.fn().mockRejectedValue(Object.assign(new Error('local timeout'), {
        code: 'ETIMEDOUT',
      })),
    };
    const localPrimary = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: ollama, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    }));
    const task = {
      workloadRole: 'skill_inference' as const,
      prompt: 'private local work',
      containsPrivateData: true,
      allowCloudEscalation: false,
      localAdmission: 'local_only' as const,
    };

    await expect(localPrimary.dispatchLocalReasoning(task)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await expect(localPrimary.dispatchLocalReasoning(task)).rejects.toMatchObject({ code: 'circuit_open' });
    expect(ollama.localReason).toHaveBeenCalledTimes(1);
  });

  it.each(['local_only', 'eligible'] as const)(
    'fails %s skill inference closed when routing primary is not Ollama',
    async (localAdmission) => {
      const cloudPrimary = {
        ...createMockProvider('gemini'),
        localReason: vi.fn().mockResolvedValue({ text: 'must not run' }),
      };
      const drifted = new TaskRoutingProvider(buildConfig({
        localReasoning: { primary: cloudPrimary, fallback: 'approved_cloud_reasoning' },
      }));

      await expect(drifted.dispatchLocalReasoning({
        workloadRole: 'skill_inference',
        prompt: 'private request',
        containsPrivateData: true,
        allowCloudEscalation: false,
        localAdmission,
      })).rejects.toMatchObject({ code: 'SKILL_INFERENCE_LOCAL_PRIMARY_REQUIRED' });
      expect(cloudPrimary.localReason).not.toHaveBeenCalled();
    },
  );

  it('requires the approved cloud sentinel before force-cloud skill inference', async () => {
    const ollama = {
      ...createMockProvider('ollama'),
      localReason: vi.fn().mockResolvedValue({ text: 'must not run' }),
    };
    const drifted = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: ollama, fallback: 'none' },
    }));

    await expect(drifted.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'public request',
      containsPrivateData: false,
      allowCloudEscalation: true,
      localAdmission: 'force_cloud',
      cloudFallbackBoundary: vi.fn(),
    })).rejects.toMatchObject({ code: 'SKILL_INFERENCE_APPROVED_CLOUD_FALLBACK_REQUIRED' });
    expect(ollama.localReason).not.toHaveBeenCalled();
  });

  it('acquires the cloud budget boundary only after the local optional method fails', async () => {
    const callOrder: string[] = [];
    const ollama = {
      ...createMockProvider('ollama'),
      localReason: vi.fn(async () => {
        callOrder.push('local_failed');
        throw Object.assign(new Error('local timeout'), { code: 'ETIMEDOUT' });
      }),
    };
    optionalCloudMocks.provider.callStructuredGeneration.mockImplementationOnce(async () => {
      callOrder.push('cloud_called');
      return { text: 'cloud answer', stopReason: 'stop' };
    });
    const cloudBoundary = vi.fn(async (providerCall: () => Promise<unknown>) => {
      callOrder.push('budget_acquired');
      return providerCall();
    });
    const localPrimary = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: ollama, fallback: 'approved_cloud_reasoning' },
    }));

    await expect(localPrimary.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'public content request',
      systemContext: 'Return plain text.',
      userId: 42,
      tenantId: 84,
      containsPrivateData: false,
      allowCloudEscalation: true,
      localAdmission: 'eligible',
      cloudFallbackBoundary: cloudBoundary,
    })).resolves.toMatchObject({ text: 'cloud answer' });

    expect(callOrder).toEqual(['local_failed', 'budget_acquired', 'cloud_called']);
    expect(cloudBoundary).toHaveBeenCalledTimes(1);
  });

  it('forwards a valid script delivery class to the cloud gate and strips an invalid one', async () => {
    const failingOllama = () => ({
      ...createMockProvider('ollama'),
      localReason: vi.fn().mockRejectedValue(Object.assign(new Error('local timeout'), { code: 'ETIMEDOUT' })),
    });
    const localPrimary = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: failingOllama(), fallback: 'approved_cloud_reasoning' },
    }));
    const boundary = async (providerCall: () => Promise<unknown>) => providerCall();

    await expect(localPrimary.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'scheduled script section',
      containsPrivateData: false,
      allowCloudEscalation: true,
      scriptDeliveryMode: 'scheduled',
      localAdmission: 'eligible',
      cloudFallbackBoundary: boundary,
    })).resolves.toMatchObject({ text: expect.any(String) });
    expect(optionalCloudMocks.selectApprovedCloudReasoningProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ scriptDeliveryMode: 'scheduled' }),
      expect.anything(),
      null,
    );

    await expect(localPrimary.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'scheduled OpenAI-only script section',
      containsPrivateData: false,
      allowCloudEscalation: true,
      scriptDeliveryMode: 'scheduled',
      requiredCloudProvider: 'openai',
      localAdmission: 'eligible',
      cloudFallbackBoundary: boundary,
    })).resolves.toMatchObject({ text: expect.any(String) });
    expect(optionalCloudMocks.selectApprovedCloudReasoningProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scriptDeliveryMode: 'scheduled',
        requiredCloudProvider: 'openai',
      }),
      expect.anything(),
      null,
    );

    optionalCloudMocks.selectApprovedCloudReasoningProvider.mockResolvedValueOnce({
      rejected: false as const,
      provider: optionalCloudMocks.provider,
      model: 'gpt-5.6-luna',
      serviceTier: 'flex' as const,
      privacyAction: 'sent_raw' as const,
    });
    await expect(localPrimary.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'scheduled script section with a bound provider tier',
      containsPrivateData: false,
      allowCloudEscalation: true,
      scriptDeliveryMode: 'scheduled',
      localAdmission: 'eligible',
      cloudFallbackBoundary: boundary,
    })).resolves.toMatchObject({
      text: expect.any(String),
      providerMetadata: { serviceTierUsed: 'flex' },
    });
    expect(optionalCloudMocks.provider.callStructuredGeneration).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: 'gpt-5.6-luna',
        serviceTier: 'flex',
      }),
    );

    const secondDispatch = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: failingOllama(), fallback: 'approved_cloud_reasoning' },
    }));
    await expect(secondDispatch.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'forged delivery class',
      containsPrivateData: false,
      allowCloudEscalation: true,
      // Not one of the three classes: the gate request must not carry it.
      scriptDeliveryMode: 'bogus' as never,
      localAdmission: 'eligible',
      cloudFallbackBoundary: boundary,
    })).resolves.toMatchObject({ text: expect.any(String) });
    const lastRequest = optionalCloudMocks.selectApprovedCloudReasoningProvider.mock.lastCall?.[0] as Record<string, unknown>;
    expect(lastRequest).toBeDefined();
    expect('scriptDeliveryMode' in lastRequest).toBe(false);
  });

  it('types a script-only cloud-gate rejection as bounded infrastructure failure', async () => {
    const ollama = {
      ...createMockProvider('ollama'),
      localReason: vi.fn().mockRejectedValue(
        Object.assign(new Error('local timeout'), { code: 'ETIMEDOUT' }),
      ),
    };
    optionalCloudMocks.selectApprovedCloudReasoningProvider.mockResolvedValueOnce({
      rejected: true as const,
      reason: 'disabled' as const,
      warning: 'cloud_reasoning_fallback_disabled',
    });
    const routed = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: ollama, fallback: 'approved_cloud_reasoning' },
    }));

    await expect(routed.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'standard script section',
      containsPrivateData: false,
      allowCloudEscalation: true,
      scriptDeliveryMode: 'standard',
      localAdmission: 'force_cloud',
      cloudFallbackBoundary: async (providerCall) => providerCall(),
    })).rejects.toMatchObject({ code: 'CONTENT_SCRIPT_CLOUD_GATE_UNAVAILABLE' });
  });

  it('returns a truncated cloud script stage to its bounded continuation owner', async () => {
    const ollama = {
      ...createMockProvider('ollama'),
      localReason: vi.fn().mockRejectedValue(
        Object.assign(new Error('local timeout'), { code: 'ETIMEDOUT' }),
      ),
    };
    optionalCloudMocks.provider.callStructuredGeneration.mockResolvedValueOnce({
      text: 'One complete prefix sentence.',
      stopReason: 'length',
    });
    const routed = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: ollama, fallback: 'approved_cloud_reasoning' },
    }));

    await expect(routed.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'standard script section',
      containsPrivateData: false,
      allowCloudEscalation: true,
      scriptDeliveryMode: 'standard',
      localAdmission: 'force_cloud',
      cloudFallbackBoundary: async (providerCall) => providerCall(),
    })).resolves.toMatchObject({
      text: 'One complete prefix sentence.',
      stopReason: 'length',
    });
  });

  it('admits Batch transport only for a complete durable control and forwards that exact control', async () => {
    const failingOllama = () => ({
      ...createMockProvider('ollama'),
      localReason: vi.fn().mockRejectedValue(Object.assign(new Error('local timeout'), { code: 'ETIMEDOUT' })),
    });
    const boundary = async (providerCall: () => Promise<unknown>) => providerCall();
    optionalCloudMocks.selectApprovedCloudReasoningProvider.mockResolvedValue({
      rejected: false as const,
      provider: optionalCloudMocks.provider,
      model: 'gpt-5.6-luna',
      serviceTier: 'batch' as const,
      privacyAction: 'sent_raw' as const,
    });

    const invalidControls: unknown[] = [
      undefined,
      'not-an-object',
      {},
      { stageKey: 7 },
      { stageKey: 'not-a-digest' },
      { stageKey: 'a'.repeat(64) },
      { stageKey: 'a'.repeat(64), load: vi.fn() },
      { stageKey: 'a'.repeat(64), load: vi.fn(), persist: 'not-a-function' },
    ];
    for (const durableBatch of invalidControls) {
      const routed = new TaskRoutingProvider(buildConfig({
        localReasoning: { primary: failingOllama(), fallback: 'approved_cloud_reasoning' },
      }));
      await expect(routed.dispatchLocalReasoning({
        workloadRole: 'skill_inference',
        prompt: 'scheduled batch script section',
        containsPrivateData: false,
        allowCloudEscalation: true,
        scriptDeliveryMode: 'scheduled',
        localAdmission: 'eligible',
        cloudFallbackBoundary: boundary,
        durableBatch: durableBatch as never,
      })).resolves.toMatchObject({ text: expect.any(String) });
      expect(optionalCloudMocks.selectApprovedCloudReasoningProvider).toHaveBeenLastCalledWith(
        expect.objectContaining({ batchTransportAvailable: false }),
        expect.anything(),
        null,
      );
      const providerRequest = optionalCloudMocks.provider.callStructuredGeneration.mock.lastCall?.[0] as Record<string, unknown>;
      expect(providerRequest).toBeDefined();
      expect('durableBatch' in providerRequest).toBe(false);
    }

    const durableBatch = {
      stageKey: 'b'.repeat(64),
      load: vi.fn(() => null),
      persist: vi.fn(),
    };
    const routed = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: failingOllama(), fallback: 'approved_cloud_reasoning' },
    }));
    await expect(routed.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'durable scheduled batch script section',
      containsPrivateData: false,
      allowCloudEscalation: true,
      scriptDeliveryMode: 'scheduled',
      localAdmission: 'eligible',
      cloudFallbackBoundary: boundary,
      durableBatch,
    })).resolves.toMatchObject({ text: expect.any(String) });
    expect(optionalCloudMocks.selectApprovedCloudReasoningProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ batchTransportAvailable: true }),
      expect.anything(),
      null,
    );
    expect(optionalCloudMocks.provider.callStructuredGeneration).toHaveBeenLastCalledWith(
      expect.objectContaining({ serviceTier: 'batch', durableBatch }),
    );
  });

  describe('free-tier local-only dispatch guard (NH-0040)', () => {
    class BindingBlocked extends Error {
      readonly code = 'FREE_TIER_LOCAL_ONLY';
    }

    it('consults the binding for cloud chat and tool-use dispatch with the caller identity', async () => {
      openai.callDomain.mockResolvedValue(OK_RESULT);
      anthropic.callDomain.mockResolvedValue(OK_RESULT);
      await provider.callDomain('content', [], 'msg', '', { userId: 77 });
      expect(freeTierAssertMock).toHaveBeenCalledWith(expect.objectContaining({
        userId: 77,
        surface: 'legacy_chat_cloud_dispatch',
      }));
      freeTierAssertMock.mockClear();
      await provider.callDomain('secretary', [], 'msg', '', { userId: 77 });
      expect(freeTierAssertMock).toHaveBeenCalledWith(expect.objectContaining({
        userId: 77,
        surface: 'legacy_chat_cloud_dispatch',
      }));
    });

    it('blocks a bound account before any cloud provider runs, including the fallback leg', async () => {
      freeTierAssertMock.mockImplementation(() => { throw new BindingBlocked('blocked'); });
      await expect(provider.callDomain('content', [], 'msg', '', { userId: 77 }))
        .rejects.toMatchObject({ code: 'FREE_TIER_LOCAL_ONLY' });
      expect(openai.callDomain).not.toHaveBeenCalled();
      expect(gemini.callDomain).not.toHaveBeenCalled();
    });

    it('never records a policy refusal as provider health (QA5 P1-4)', async () => {
      // A per-user policy refusal used to fall through isRetryableError's
      // "assume retryable" default, so three free-plan turns opened the
      // shared circuit and degraded every other tenant for the cooldown.
      const routed = new TaskRoutingProvider(buildConfig({
        circuitBreaker: { failureThreshold: 3, cooldownMs: 60_000 },
      }), onFallback);
      freeTierAssertMock.mockImplementation(() => { throw new BindingBlocked('blocked'); });

      for (let i = 0; i < 3; i += 1) {
        await expect(routed.callDomain('content', [], 'msg', '', { userId: 77 }))
          .rejects.toMatchObject({ code: 'FREE_TIER_LOCAL_ONLY' });
      }

      expect(routed.getCircuitState('openai')).toBe(CircuitState.CLOSED);
      // The fallback leg is never reached, so gemini has no breaker at all.
      expect(routed.getCircuitState('gemini')).toBeUndefined();
      expect(onFallback).not.toHaveBeenCalled();
      expect(openai.callDomain).not.toHaveBeenCalled();
      expect(gemini.callDomain).not.toHaveBeenCalled();

      // The healthy primary still serves the very next paid-user turn.
      freeTierAssertMock.mockReset();
      openai.callDomain.mockResolvedValue(OK_RESULT);
      await expect(routed.callDomain('content', [], 'msg', '', { userId: 88 }))
        .resolves.toMatchObject({ text: 'ok' });
      expect(openai.callDomain).toHaveBeenCalledTimes(1);
    });

    it('does not blame the fallback provider when the primary circuit is open (QA5 P1-4)', async () => {
      // With the primary circuit open the guard first runs on the FALLBACK
      // leg, so the refusal must be hoisted out there too.
      const routed = new TaskRoutingProvider(buildConfig({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
      }), onFallback);
      openai.callDomain.mockRejectedValueOnce(Object.assign(new Error('upstream 503'), { status: 503 }));
      gemini.callDomain.mockResolvedValue(OK_RESULT);
      await expect(routed.callDomain('content', [], 'msg', '', { userId: 88 }))
        .resolves.toMatchObject({ text: 'ok' });
      expect(routed.getCircuitState('openai')).toBe(CircuitState.OPEN);

      freeTierAssertMock.mockImplementation(() => { throw new BindingBlocked('blocked'); });
      await expect(routed.callDomain('content', [], 'msg', '', { userId: 77 }))
        .rejects.toMatchObject({ code: 'FREE_TIER_LOCAL_ONLY' });

      // The fallback provider stayed healthy: a policy refusal is not its
      // fault, and it was never dispatched for the refused turn.
      expect(routed.getCircuitState('gemini')).not.toBe(CircuitState.OPEN);
      // Only the first (allowed) turn reached the fallback provider; the
      // refused turn never dispatched it.
      expect(gemini.callDomain).toHaveBeenCalledTimes(1);
    });

    it('lets a local ollama chat leg run unguarded so the binding never blocks local inference', async () => {
      const ollama = createMockProvider('ollama');
      ollama.callDomain.mockResolvedValue(OK_RESULT);
      freeTierAssertMock.mockImplementation(() => { throw new BindingBlocked('blocked'); });
      const localChat = new TaskRoutingProvider(buildConfig({
        chat: { primary: ollama, fallback: undefined },
      }), onFallback);
      await expect(localChat.callDomain('content', [], 'msg', '', { userId: 77 }))
        .resolves.toBeTruthy();
      expect(ollama.callDomain).toHaveBeenCalledTimes(1);
      expect(freeTierAssertMock).not.toHaveBeenCalled();
    });

    it('guards tool continuations the same way', async () => {
      freeTierAssertMock.mockImplementation(() => { throw new BindingBlocked('blocked'); });
      await expect(provider.continueWithToolResults('content', [], 'msg', '', [], { userId: 77 }))
        .rejects.toMatchObject({ code: 'FREE_TIER_LOCAL_ONLY' });
      expect(freeTierAssertMock).toHaveBeenCalledWith(expect.objectContaining({
        surface: 'legacy_chat_cloud_tool_continuation',
      }));
    });
  });

  it('forwards cancellation into approved structured cloud generation and records no provider outcome after abort', async () => {
    const controller = new AbortController();
    const accountDeletion = Object.assign(new Error('account deletion started'), {
      name: 'AbortError',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    const ollama = {
      ...createMockProvider('ollama'),
      localReason: vi.fn().mockRejectedValue(Object.assign(new Error('local timeout'), {
        code: 'ETIMEDOUT',
      })),
    };
    optionalCloudMocks.provider.callStructuredGeneration.mockImplementationOnce(async (
      request: { abortSignal?: AbortSignal },
    ) => {
      expect(request.abortSignal).toBe(controller.signal);
      controller.abort(accountDeletion);
      // Simulate an SDK that resolves despite the native signal. The routing
      // boundary must still reject before success metrics or delivery.
      return { text: 'must not be delivered', stopReason: 'stop' };
    });
    const cloudBoundary = vi.fn(async (providerCall: () => Promise<unknown>) => providerCall());
    const localPrimary = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: ollama, fallback: 'approved_cloud_reasoning' },
    }));

    await expect(localPrimary.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'public content request',
      systemContext: 'Return plain text.',
      userId: 42,
      tenantId: 84,
      containsPrivateData: false,
      allowCloudEscalation: true,
      localAdmission: 'eligible',
      cloudFallbackBoundary: cloudBoundary,
      abortSignal: controller.signal,
    })).rejects.toBe(accountDeletion);

    expect(cloudBoundary).toHaveBeenCalledTimes(1);
    expect(localPrimary.getProviderHealth().gemini.metrics).toMatchObject({
      usageCount: 0,
      failureCount: 0,
      fallbackTriggerCount: 1,
    });
  });

  it('surfaces primary_optional_method_unavailable without touching cloud when fallback is none', async () => {
    const ollamaWithoutLocalReason = createMockProvider('ollama');
    const localOnly = new TaskRoutingProvider(buildConfig({
      localReasoning: { primary: ollamaWithoutLocalReason, fallback: 'none' },
    }));

    await expect(localOnly.dispatchLocalReasoning({
      workloadRole: 'skill_inference',
      prompt: 'private local request',
      containsPrivateData: true,
      allowCloudEscalation: false,
      localAdmission: 'local_only',
    })).rejects.toMatchObject({ code: 'primary_optional_method_unavailable' });
    expect(optionalCloudMocks.provider.callStructuredGeneration).not.toHaveBeenCalled();
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

    // ─── Option 3 (O3-A7): low-confidence escalation ─────────────
    // When the primary classifier returns a result with confidence
    // below the per-domain threshold, TaskRoutingProvider.classify
    // retries via the fallback provider WITHOUT marking the primary
    // unhealthy. Tool-bearing domains (secretary, triathlon) require
    // a higher confidence bar (0.80) than the default (0.65).

    it('O3-A7: escalates to fallback when primary classify confidence is low (non-tool domain)', async () => {
      const lowConfCooking: ClassificationResult = { domain: 'cooking', confidence: 0.4 };
      const highConfCooking: ClassificationResult = { domain: 'cooking', confidence: 0.95 };
      anthropic.classify.mockResolvedValue(lowConfCooking);
      openai.classify.mockResolvedValue(highConfCooking);

      const result = await provider.classify('test');

      expect(anthropic.classify).toHaveBeenCalledTimes(1);
      expect(openai.classify).toHaveBeenCalledTimes(1);
      expect(result).toEqual(highConfCooking);
    });

    it('O3-A7: tool-domain (secretary) escalates at higher threshold (0.80) than non-tool (0.65)', async () => {
      const borderlineSecretary: ClassificationResult = { domain: 'secretary', confidence: 0.75 };
      const confidentSecretary: ClassificationResult = { domain: 'secretary', confidence: 0.99 };
      anthropic.classify.mockResolvedValue(borderlineSecretary);
      openai.classify.mockResolvedValue(confidentSecretary);

      const result = await provider.classify('schedule meeting');

      expect(openai.classify).toHaveBeenCalledTimes(1);
      expect(result).toEqual(confidentSecretary);
    });

    it('O3-A7: returns primary low-confidence result when fallback also fails', async () => {
      const lowConfCooking: ClassificationResult = { domain: 'cooking', confidence: 0.4 };
      anthropic.classify.mockResolvedValue(lowConfCooking);
      openai.classify.mockRejectedValue(new Error('fallback unavailable'));

      const result = await provider.classify('test');

      expect(anthropic.classify).toHaveBeenCalledTimes(1);
      expect(openai.classify).toHaveBeenCalledTimes(1);
      expect(result).toEqual(lowConfCooking);
    });

    it('O3-A7: preserves cancellation from the low-confidence fallback classifier', async () => {
      const lowConfCooking: ClassificationResult = { domain: 'cooking', confidence: 0.4 };
      const cancelled = Object.assign(new Error('request cancelled'), {
        name: 'AbortError',
        code: 'CHAT_REQUEST_CANCELLED',
      });
      anthropic.classify.mockResolvedValue(lowConfCooking);
      openai.classify.mockRejectedValue(cancelled);

      await expect(provider.classify('test', undefined, {
        abortSignal: new AbortController().signal,
      })).rejects.toBe(cancelled);
    });

    it.each(['clarify', 'none'] as const)(
      'does not replace a low-confidence manifest %s terminal outcome with a fallback classification',
      async (domain) => {
        const savedFlag = process.env.AI_CLASSIFY_MANIFEST_PROMPT;
        const savedKill = process.env.AI_ROUTING_MANIFEST_KILL;
        process.env.AI_CLASSIFY_MANIFEST_PROMPT = 'true';
        delete process.env.AI_ROUTING_MANIFEST_KILL;
        const terminal: ClassificationResult = { domain, confidence: 0.3 };
        anthropic.classify.mockResolvedValue(terminal);
        openai.classify.mockResolvedValue({ domain: 'secretary', confidence: 0.99 });
        try {
          await expect(provider.classify('ambiguous request')).resolves.toEqual(terminal);
          expect(openai.classify).not.toHaveBeenCalled();
        } finally {
          if (savedFlag === undefined) delete process.env.AI_CLASSIFY_MANIFEST_PROMPT;
          else process.env.AI_CLASSIFY_MANIFEST_PROMPT = savedFlag;
          if (savedKill === undefined) delete process.env.AI_ROUTING_MANIFEST_KILL;
          else process.env.AI_ROUTING_MANIFEST_KILL = savedKill;
        }
      },
    );

    it('does not escalate a normalized terminal carried on disposition rather than domain', async () => {
      // This is the shape the runtime actually produces: classifier.ts rewrites
      // an explicit abstention to the non-executable `chat` envelope and moves
      // the outcome to `disposition`. The domain operand is therefore always
      // falsy here, and only the disposition operand can stop the fallback.
      const savedFlag = process.env.AI_CLASSIFY_MANIFEST_PROMPT;
      const savedKill = process.env.AI_ROUTING_MANIFEST_KILL;
      process.env.AI_CLASSIFY_MANIFEST_PROMPT = 'true';
      delete process.env.AI_ROUTING_MANIFEST_KILL;
      const terminal: ClassificationResult = {
        domain: 'chat',
        confidence: 0.2,
        disposition: 'clarify',
      };
      anthropic.classify.mockResolvedValue(terminal);
      openai.classify.mockResolvedValue({ domain: 'secretary', confidence: 0.99 });
      try {
        await expect(provider.classify('ambiguous request')).resolves.toEqual(terminal);
        expect(openai.classify).not.toHaveBeenCalled();
      } finally {
        if (savedFlag === undefined) delete process.env.AI_CLASSIFY_MANIFEST_PROMPT;
        else process.env.AI_CLASSIFY_MANIFEST_PROMPT = savedFlag;
        if (savedKill === undefined) delete process.env.AI_ROUTING_MANIFEST_KILL;
        else process.env.AI_ROUTING_MANIFEST_KILL = savedKill;
      }
    });

    it('keeps the pre-manifest flag-off confidence escalation unchanged', async () => {
      const savedFlag = process.env.AI_CLASSIFY_MANIFEST_PROMPT;
      delete process.env.AI_CLASSIFY_MANIFEST_PROMPT;
      const stray: ClassificationResult = { domain: 'clarify', confidence: 0.3 };
      const fallback: ClassificationResult = { domain: 'secretary', confidence: 0.99 };
      anthropic.classify.mockResolvedValue(stray);
      openai.classify.mockResolvedValue(fallback);
      try {
        await expect(provider.classify('ambiguous request')).resolves.toEqual(fallback);
        expect(openai.classify).toHaveBeenCalledTimes(1);
      } finally {
        if (savedFlag === undefined) delete process.env.AI_CLASSIFY_MANIFEST_PROMPT;
        else process.env.AI_CLASSIFY_MANIFEST_PROMPT = savedFlag;
      }
    });
  });

  // ─── callDomain (routes based on domain → task type) ────────────

  describe('callDomain', () => {
    it('does not fall back or advance the breaker for repeated budget denials', async () => {
      const denial = Object.assign(new Error('daily limit'), {
        name: 'AiBudgetError',
        decision: { code: 'AI_DAILY_LIMIT_REACHED' },
      });
      anthropic.callDomain.mockRejectedValue(denial);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(provider.callDomain('secretary', [], 'msg', '')).rejects.toBe(denial);
      }

      expect(anthropic.callDomain).toHaveBeenCalledTimes(3);
      expect(gemini.callDomain).not.toHaveBeenCalled();
      expect(onFallback).not.toHaveBeenCalled();
      expect(provider.getAllCircuitStates().anthropic).toEqual({
        state: CircuitState.CLOSED,
        failures: 0,
      });
    });

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

    it('accepts provider-certified bounded content from Ollama without invoking fallback', async () => {
      const ollama = createMockProvider('ollama');
      const boundedResult: AICallResult = {
        text: 'A complete bounded answer.',
        toolCalls: [],
        stopReason: 'bounded_complete',
        providerMetadata: {
          providerUsed: 'ollama',
          modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
          fallbackUsed: false,
          outputBoundApplied: true,
          originalStopReason: 'length',
          completePrefixKept: true,
        },
      };
      ollama.callDomain.mockResolvedValue(boundedResult);
      const localProvider = new TaskRoutingProvider(buildConfig({
        chat: { primary: ollama, fallback: gemini },
      }), onFallback);

      const result = await localProvider.callDomain('content', [], 'msg', '');

      expect(result).toMatchObject(boundedResult);
      expect(ollama.callDomain).toHaveBeenCalledTimes(1);
      expect(gemini.callDomain).not.toHaveBeenCalled();
      expect(onFallback).not.toHaveBeenCalled();
    });

    it('rejects a bounded-content certificate without Ollama provenance', async () => {
      openai.callDomain.mockResolvedValue({
        text: 'A provider-claimed bounded answer.',
        toolCalls: [],
        stopReason: 'bounded_complete',
        providerMetadata: {
          providerUsed: 'openai',
          modelUsed: 'test-model',
          fallbackUsed: false,
          outputBoundApplied: true,
          originalStopReason: 'length',
          completePrefixKept: true,
        },
      } satisfies AICallResult);
      gemini.callDomain.mockResolvedValue({ ...OK_RESULT });

      const result = await provider.callDomain('content', [], 'msg', '');

      expect(result.text).toBe('ok');
      expect(gemini.callDomain).toHaveBeenCalledTimes(1);
      expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
        taskType: 'chat',
        primaryProvider: 'openai',
        fallbackProvider: 'gemini',
      }));
    });

    it('rejects an incomplete bounded-content certificate from Ollama', async () => {
      const ollama = createMockProvider('ollama');
      ollama.callDomain.mockResolvedValue({
        text: 'A claimed bounded answer without the complete-prefix certificate.',
        toolCalls: [],
        stopReason: 'bounded_complete',
        providerMetadata: {
          providerUsed: 'ollama',
          modelUsed: 'qwen2.5:3b-instruct-q4_K_M',
          fallbackUsed: false,
          outputBoundApplied: true,
          originalStopReason: 'length',
          completePrefixKept: false,
        },
      } satisfies AICallResult);
      gemini.callDomain.mockResolvedValue({ ...OK_RESULT });
      const localProvider = new TaskRoutingProvider(buildConfig({
        chat: { primary: ollama, fallback: gemini },
      }), onFallback);

      const result = await localProvider.callDomain('content', [], 'msg', '');

      expect(result.text).toBe('ok');
      expect(gemini.callDomain).toHaveBeenCalledTimes(1);
      expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
        taskType: 'chat',
        primaryProvider: 'ollama',
        fallbackProvider: 'gemini',
      }));
    });

    it('keeps raw length truncation governed by fallback refusal', async () => {
      openai.callDomain.mockResolvedValue({
        text: 'An unfinished provider answer',
        toolCalls: [],
        stopReason: 'length',
      } satisfies AICallResult);
      gemini.callDomain.mockResolvedValue({ ...OK_RESULT });

      const result = await provider.callDomain('content', [], 'msg', '');

      expect(result.text).toBe('ok');
      expect(gemini.callDomain).toHaveBeenCalledTimes(1);
      expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
        taskType: 'chat',
        primaryProvider: 'openai',
        fallbackProvider: 'gemini',
      }));
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

    it('passes maxTokensOverride through (now wrapped in CallDomainOptions)', async () => {
      anthropic.callDomain.mockResolvedValue(OK_RESULT);
      await provider.callDomain('secretary', [], 'msg', 'ctx', 4096);
      // After TASK-17 Option B, TaskRoutingProvider computes the
      // SecretaryOptimization decision (filteredTools, modelTier) and
      // bundles the caller-supplied maxTokensOverride into the same
      // CallDomainOptions bag. Caller-supplied values still win, so
      // maxTokensOverride === 4096 is preserved verbatim — but it
      // arrives at the provider inside an object, not as a bare number.
      expect(anthropic.callDomain).toHaveBeenCalledWith(
        'secretary',
        [],
        'msg',
        'ctx',
        expect.objectContaining({ maxTokensOverride: 4096 }),
      );
    });

    it('preserves the caller current-turn-only privacy decision through optimization', async () => {
      openai.callDomain.mockResolvedValue(OK_RESULT);
      const savedHistory = [
        { role: 'user' as const, content: 'PRIVATE_SAVED_HISTORY' },
      ];

      await provider.callDomain(
        'content',
        savedHistory,
        'Explain a comparison without saved data.',
        'PRIVATE_SAVED_STATE',
        { userId: 42, tenantId: 42, currentTurnOnly: true },
      );

      expect(openai.callDomain).toHaveBeenCalledWith(
        'content',
        [],
        'Explain a comparison without saved data.',
        '',
        expect.objectContaining({ currentTurnOnly: true, filteredTools: [] }),
      );
    });

    it('centrally strips saved history and state from a current-turn-only continuation', async () => {
      openai.continueWithToolResults.mockResolvedValue(OK_RESULT);
      const savedHistory = [
        { role: 'user' as const, content: 'PRIVATE_SAVED_HISTORY' },
      ];
      const currentTurnToolConversation = [
        {
          role: 'user' as const,
          content: [{
            type: 'tool_result' as const,
            tool_use_id: 'tool_current_turn',
            content: 'CURRENT_TURN_TOOL_RESULT',
          }],
        },
      ];

      await provider.continueWithToolResults(
        'content',
        savedHistory,
        'Explain a comparison without saved data.',
        'PRIVATE_SAVED_STATE',
        currentTurnToolConversation,
        { userId: 42, tenantId: 42, currentTurnOnly: true },
      );

      expect(openai.continueWithToolResults).toHaveBeenCalledWith(
        'content',
        [],
        'Explain a comparison without saved data.',
        '',
        currentTurnToolConversation,
        expect.objectContaining({ currentTurnOnly: true, filteredTools: [] }),
      );
    });

    // ─── TASK-17 Option B: provider-agnostic optimization wiring ───
    //
    // These tests prove the dispatch layer computes the optimization
    // decision ONCE and forwards it to whichever provider runs. The
    // assertions check the EXACT shape of the options bag passed to
    // the provider, so any future regression in the wiring will fail
    // here loudly with a useful diff.

    describe('TASK-17 Option B: passes optimization through to provider', () => {
      it('secretary + simple query → light tier + filtered tools + sliced history', async () => {
        anthropic.callDomain.mockResolvedValue(OK_RESULT);
        const fullHistory = Array.from({ length: 10 }, (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `m${i}`,
        }));

        await provider.callDomain('secretary', fullHistory, 'show my tasks', 'state-ctx');

        const call = anthropic.callDomain.mock.calls[0];
        // arg 1: history should be sliced to last 4 (Layer 5)
        expect(call[1].length).toBe(4);
        // arg 2: currentMessage unchanged
        expect(call[2]).toBe('show my tasks');
        // arg 4: options bag with light tier + filteredTools narrower than full
        const opts = call[4];
        expect(opts).toBeDefined();
        expect(opts.modelTier).toBe('light');
        expect(Array.isArray(opts.filteredTools)).toBe(true);
        // Filtered tool list should be smaller than the full TOOLS array
        // (we don't know the exact size since TOOLS is real, but it should
        // be in the 5-10 range for "show my tasks" — a strict upper bound
        // catches accidental no-op filtering)
        expect(opts.filteredTools.length).toBeLessThan(15);
        expect(opts.filteredTools.length).toBeGreaterThan(0);
      });

      it('secretary + complex query → heavy tier + full history kept', async () => {
        anthropic.callDomain.mockResolvedValue(OK_RESULT);
        const fullHistory = Array.from({ length: 10 }, (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `m${i}`,
        }));

        await provider.callDomain(
          'secretary',
          fullHistory,
          'plan my week considering my training and content schedule',
          'state-ctx',
        );

        const call = anthropic.callDomain.mock.calls[0];
        // arg 1: full history kept (Layer 5 only triggers on light tier)
        expect(call[1].length).toBe(10);
        const opts = call[4];
        expect(opts.modelTier).toBe('heavy');
      });

      it('non-secretary domain → no-op optimization (full tools, heavy, full history)', async () => {
        // Triathlon is also a tool-use task type but optimization only
        // applies to secretary. Other tool-use domains should pass through.
        anthropic.callDomain.mockResolvedValue(OK_RESULT);
        const fullHistory = Array.from({ length: 6 }, (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `m${i}`,
        }));

        await provider.callDomain('triathlon', fullHistory, 'plan my week', 'state-ctx');

        const call = anthropic.callDomain.mock.calls[0];
        // History should NOT be sliced for non-secretary domains
        expect(call[1].length).toBe(6);
        const opts = call[4];
        // Optimization is a no-op: heavy tier, all tools
        expect(opts.modelTier).toBe('heavy');
      });

      it('continueWithToolResults: same optimization applied for tool loop continuity', async () => {
        // CRITICAL — the tool loop must see the same tool set on every
        // iteration, otherwise the model will reference a tool that's
        // no longer in scope and the API will reject the request.
        anthropic.callDomain.mockResolvedValue(OK_RESULT);
        anthropic.continueWithToolResults.mockResolvedValue(OK_RESULT);
        const history = Array.from({ length: 10 }, (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `m${i}`,
        }));

        await provider.callDomain('secretary', history, 'show my tasks', 'state-ctx');
        await provider.continueWithToolResults('secretary', history, 'show my tasks', 'state-ctx', []);

        const callArgs = anthropic.callDomain.mock.calls[0];
        const continueArgs = anthropic.continueWithToolResults.mock.calls[0];
        // Both calls must receive the same tier
        expect(continueArgs[5]?.modelTier).toBe(callArgs[4]?.modelTier);
        // Both calls must receive the same number of filtered tools
        expect(continueArgs[5]?.filteredTools?.length).toBe(callArgs[4]?.filteredTools?.length);
      });
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
    it('does not count or route around an OpenAI SDK caller cancellation', async () => {
      const cfg = buildConfig({
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60000 },
      });
      const p = new TaskRoutingProvider(cfg, onFallback);
      const cancelled = new APIUserAbortError();
      openai.callDomain.mockRejectedValue(cancelled);

      await expect(p.callDomain('content', [], 'cancel this turn', ''))
        .rejects.toBe(cancelled);

      expect(gemini.callDomain).not.toHaveBeenCalled();
      expect(onFallback).not.toHaveBeenCalled();
      expect(p.getProviderHealth().openai).toEqual({
        circuit: { state: CircuitState.CLOSED, failures: 0 },
        metrics: {
          usageCount: 0,
          failureCount: 0,
          fallbackTriggerCount: 0,
          circuitOpenCount: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
        },
      });
    });

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

  it('reports configured provider circuits before the first routed call', () => {
    const gemini = createMockProvider('gemini');
    const ollama = createMockProvider('ollama');
    const freshProvider = new TaskRoutingProvider({
      classify: { primary: gemini },
      chat: { primary: gemini },
      'tool-use': { primary: gemini },
      scriptGeneration: { primary: ollama, fallback: 'approved_cloud_reasoning' },
      localReasoning: { primary: ollama, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    expect(freshProvider.getProviderHealth()).toEqual({
      gemini: {
        circuit: { state: 'CLOSED', failures: 0 },
        metrics: {
          usageCount: 0,
          failureCount: 0,
          fallbackTriggerCount: 0,
          circuitOpenCount: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
        },
      },
      ollama: {
        circuit: { state: 'CLOSED', failures: 0 },
        metrics: {
          usageCount: 0,
          failureCount: 0,
          fallbackTriggerCount: 0,
          circuitOpenCount: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
        },
      },
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
