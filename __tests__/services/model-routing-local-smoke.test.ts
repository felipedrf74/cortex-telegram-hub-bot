import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider, AICallResult } from '../../src/services/ai-provider';
import type { ClassificationResult } from '../../src/domains/types';
import { runWithContext } from '../../src/utils/request-context';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/secretary-tools', () => ({
  planSecretaryOptimization: vi.fn((_domain, _message, history, tools) => ({
    filteredTools: tools,
    modelTier: 'heavy',
    slicedHistory: history,
    optimized: false,
  })),
}));

vi.mock('../../src/services/anthropic', () => ({
  TOOLS: [
    { name: 'create_calendar_event', description: 'create event', input_schema: { type: 'object' } },
    { name: 'delete_calendar_event', description: 'delete event', input_schema: { type: 'object' } },
  ],
}));

import { logger } from '../../src/utils/logger';
import { TaskRoutingProvider } from '../../src/services/provider-fallback';

type MockProvider = AIProvider & {
  classify: ReturnType<typeof vi.fn>;
  callDomain: ReturnType<typeof vi.fn>;
  continueWithToolResults: ReturnType<typeof vi.fn>;
};

function createMockProvider(name: string): MockProvider {
  return {
    name,
    classify: vi.fn(),
    callDomain: vi.fn(),
    continueWithToolResults: vi.fn(),
  };
}

function createHarness(onFallback = vi.fn()) {
  const gemini = createMockProvider('gemini');
  const openai = createMockProvider('openai');
  const anthropic = createMockProvider('anthropic');
  const provider = new TaskRoutingProvider({
    classify: { primary: gemini, fallback: openai },
    chat: { primary: gemini, fallback: openai },
    'tool-use': { primary: openai, fallback: gemini },
    circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
  }, onFallback);

  return { provider, gemini, openai, anthropic, onFallback };
}

function seedDomainPairCache(
  provider: TaskRoutingProvider,
  domain: string,
  pair: { primary: AIProvider; fallback?: AIProvider },
): void {
  (provider as unknown as { domainPairCache: Map<string, { primary: AIProvider; fallback?: AIProvider }> })
    .domainPairCache
    .set(domain, pair);
}

function logPayload(): string {
  return JSON.stringify({
    debug: (logger.debug as any).mock.calls,
    info: (logger.info as any).mock.calls,
    warn: (logger.warn as any).mock.calls,
    error: (logger.error as any).mock.calls,
  });
}

const OK_RESULT: AICallResult = { text: 'ok', toolCalls: [], stopReason: 'end_turn' };
const CLASSIFY_OK: ClassificationResult = { domain: 'content', confidence: 0.93 };

describe('local model-routing smoke (fixture mode)', () => {
  const originalRunawayThreshold = process.env.AI_PROVIDER_RUNAWAY_CALL_THRESHOLD;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalRunawayThreshold === undefined) {
      delete process.env.AI_PROVIDER_RUNAWAY_CALL_THRESHOLD;
    } else {
      process.env.AI_PROVIDER_RUNAWAY_CALL_THRESHOLD = originalRunawayThreshold;
    }
  });

  it('validates classify, chat, tool-use, and tool-continuation fixture paths', async () => {
    const { provider, gemini, openai } = createHarness();
    gemini.classify.mockResolvedValue(CLASSIFY_OK);
    gemini.callDomain.mockResolvedValue(OK_RESULT);
    openai.callDomain.mockResolvedValue(OK_RESULT);
    openai.continueWithToolResults.mockResolvedValue(OK_RESULT);

    await runWithContext({ requestId: 'smoke-routing-fixture', source: 'local-smoke', userId: 7 }, async () => {
      const classified = await provider.classify('Classify this ordinary tenant-safe message');
      expect(classified).toEqual(CLASSIFY_OK);

      await provider.callDomain('content', [], 'Draft a tenant A content note', '<tenant id="10">content state</tenant>', {
        userId: 7,
        tenantId: 10,
        modelTier: 'light',
      });

      await provider.callDomain('secretary', [], 'Schedule a tenant A planning block', '<tenant id="10">agenda state</tenant>', {
        userId: 7,
        tenantId: 10,
        modelTier: 'heavy',
      });

      await provider.continueWithToolResults('secretary', [], 'Finish the scheduling action', '<tenant id="10">agenda state</tenant>', [], {
        userId: 7,
        tenantId: 10,
        modelTier: 'heavy',
      });
    });

    expect(gemini.classify).toHaveBeenCalledTimes(1);
    expect(gemini.callDomain).toHaveBeenCalledWith(
      'content',
      [],
      'Draft a tenant A content note',
      '<tenant id="10">content state</tenant>',
      expect.objectContaining({ userId: 7, tenantId: 10, modelTier: 'light' }),
    );
    expect(openai.callDomain).toHaveBeenCalledWith(
      'secretary',
      [],
      'Schedule a tenant A planning block',
      '<tenant id="10">agenda state</tenant>',
      expect.objectContaining({ userId: 7, tenantId: 10, modelTier: 'heavy' }),
    );
    expect(openai.continueWithToolResults).toHaveBeenCalledWith(
      'secretary',
      [],
      'Finish the scheduling action',
      '<tenant id="10">agenda state</tenant>',
      [],
      expect.objectContaining({ userId: 7, tenantId: 10, modelTier: 'heavy' }),
    );
    expect(logPayload()).toContain('"category":"classify_message"');
    expect(logPayload()).toContain('"category":"domain_content"');
    expect(logPayload()).toContain('"category":"domain_secretary"');
    expect(logPayload()).toContain('"category":"tool_continuation"');
  });

  it('simulates fallback with safe metadata, provider health metrics, and no raw prompt leakage', async () => {
    const { provider, gemini, openai, onFallback } = createHarness();
    const sensitivePrompt = 'SECRET_PROMPT tenant-B private payroll schedule';
    const tenantBContext = 'TENANT_B_PRIVATE_MEMORY_SHOULD_NEVER_BE_SENT';
    const tenantAContext = '<tenant id="10">Tenant A scoped agenda only</tenant>';
    const upstreamError = Object.assign(new Error(`rate limited after prompt ${sensitivePrompt}`), { status: 429 });

    gemini.callDomain.mockRejectedValue(upstreamError);
    openai.callDomain.mockImplementation(async (_domain, _history, _message, stateContext) => {
      expect(stateContext).toBe(tenantAContext);
      expect(stateContext).not.toContain(tenantBContext);
      return OK_RESULT;
    });

    await runWithContext({ requestId: 'smoke-fallback-fixture', source: 'local-smoke', userId: 7 }, async () => {
      await provider.callDomain('content', [], sensitivePrompt, tenantAContext, {
        userId: 7,
        tenantId: 10,
        modelTier: 'light',
      });
    });

    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
      taskType: 'chat',
      callKind: 'domain',
      category: 'domain_content',
      domain: 'content',
      userId: 7,
      tenantId: 10,
      requestId: 'smoke-fallback-fixture',
      requestSource: 'local-smoke',
      primaryProvider: 'gemini',
      fallbackProvider: 'openai',
      fallbackReason: 'rate_limited',
      tenantScope: 'present',
      userScope: 'present',
      modelTier: 'light',
    }));

    const health = provider.getProviderHealth();
    expect(health.gemini.metrics.failureCount).toBe(1);
    expect(health.gemini.metrics.lastFailureAt).toEqual(expect.any(String));
    expect(health.openai.metrics.fallbackTriggerCount).toBe(1);
    expect(health.openai.metrics.usageCount).toBe(1);
    expect(health.openai.metrics.lastSuccessAt).toEqual(expect.any(String));
    expect(onFallback.mock.calls[0][0].error.message).toBe('provider_failure:rate_limited');
    expect(logPayload()).not.toContain(sensitivePrompt);
    expect(logPayload()).not.toContain(tenantBContext);
  });

  it('simulates an operator/domain override without forcing a global provider', async () => {
    const { provider, gemini, openai } = createHarness();
    seedDomainPairCache(provider, 'content', { primary: openai, fallback: gemini });
    openai.callDomain.mockResolvedValue(OK_RESULT);

    await provider.callDomain('content', [], 'Use the operator pinned provider', '<tenant id="10">safe state</tenant>', {
      userId: 7,
      tenantId: 10,
      modelTier: 'light',
    });

    expect(openai.callDomain).toHaveBeenCalledTimes(1);
    expect(gemini.callDomain).not.toHaveBeenCalled();
    expect((logger.debug as any).mock.calls).toContainEqual([
      expect.objectContaining({
        provider: 'openai',
        taskType: 'chat',
        domain: 'content',
        pairSource: 'domain_cache',
        operatorOverrideApplied: true,
        tenantScope: 'present',
        userScope: 'present',
      }),
      'AI provider routing attempt',
    ]);
  });

  it('hard-stops runaway fixture provider loops without logging message text', async () => {
    process.env.AI_PROVIDER_RUNAWAY_CALL_THRESHOLD = '2';
    const { provider, gemini } = createHarness();
    gemini.classify.mockResolvedValue(CLASSIFY_OK);

    await expect(runWithContext({ requestId: 'smoke-runaway-fixture', source: 'local-smoke', userId: 7 }, async () => {
      await provider.classify('first private classification prompt');
      await provider.classify('second private classification prompt');
      await provider.classify('third private classification prompt');
    })).rejects.toMatchObject({
      code: 'AI_PROVIDER_RUNAWAY_LIMIT',
      statusCode: 502,
    });

    expect((logger.warn as any).mock.calls).toContainEqual([
      expect.objectContaining({
        requestId: 'smoke-runaway-fixture',
        provider: 'gemini',
        taskType: 'classify',
        category: 'classify_message',
        providerAttemptCount: 3,
        runawayThreshold: 2,
      }),
      'Potential runaway AI provider call loop detected',
    ]);
    expect(logPayload()).not.toContain('third private classification prompt');
    expect(gemini.classify).toHaveBeenCalledTimes(2);
  });
});
