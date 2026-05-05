import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider, AICallResult } from '../../src/services/ai-provider';
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

function seedDomainPairCache(
  provider: TaskRoutingProvider,
  domain: string,
  pair: { primary: AIProvider; fallback?: AIProvider },
): void {
  (provider as unknown as { domainPairCache: Map<string, { primary: AIProvider; fallback?: AIProvider }> })
    .domainPairCache
    .set(domain, pair);
}

function createProviderHarness(onFallback = vi.fn()) {
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

const OK_RESULT: AICallResult = { text: 'ok', toolCalls: [], stopReason: 'end_turn' };

describe('model routing observability and safety', () => {
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

  it('preserves operator override visibility for a cached domain pair', async () => {
    const { provider, openai, gemini } = createProviderHarness();
    openai.callDomain.mockResolvedValue(OK_RESULT);
    seedDomainPairCache(provider, 'content', { primary: openai, fallback: gemini });

    await provider.callDomain('content', [], 'draft a post', 'scoped state', {
      userId: 7,
      tenantId: 10,
      modelTier: 'light',
    });

    expect(openai.callDomain).toHaveBeenCalled();
    expect(gemini.callDomain).not.toHaveBeenCalled();
    expect((logger.debug as any).mock.calls).toContainEqual([
      expect.objectContaining({
        provider: 'openai',
        domain: 'content',
        category: 'domain_content',
        modelTier: 'light',
        userId: 7,
        tenantId: 10,
        tenantScope: 'present',
        pairSource: 'domain_cache',
        operatorOverrideApplied: true,
      }),
      'AI provider routing attempt',
    ]);
  });

  it('logs fallback reason and preserves category without leaking raw prompts', async () => {
    const { provider, gemini, openai, onFallback } = createProviderHarness();
    const sensitivePrompt = 'SECRET_PROMPT tenant-B private roadmap';
    const err = Object.assign(new Error(`rate limited after prompt: ${sensitivePrompt}`), { status: 429 });
    gemini.callDomain.mockRejectedValue(err);
    openai.callDomain.mockResolvedValue(OK_RESULT);

    await provider.callDomain('content', [], sensitivePrompt, '<tenant id="10">safe context</tenant>', {
      userId: 7,
      tenantId: 10,
      modelTier: 'light',
    });

    const event = onFallback.mock.calls[0][0];
    expect(event).toEqual(expect.objectContaining({
      taskType: 'chat',
      callKind: 'domain',
      category: 'domain_content',
      domain: 'content',
      userId: 7,
      tenantId: 10,
      modelTier: 'light',
      primaryProvider: 'gemini',
      fallbackProvider: 'openai',
      fallbackReason: 'rate_limited',
      tenantScope: 'present',
    }));
    expect(event.error.message).not.toContain(sensitivePrompt);
    expect(JSON.stringify((logger.warn as any).mock.calls)).not.toContain(sensitivePrompt);
    expect(JSON.stringify((logger.debug as any).mock.calls)).not.toContain(sensitivePrompt);
    expect(JSON.stringify((logger.info as any).mock.calls)).not.toContain(sensitivePrompt);
  });

  it('preserves tool-continuation category and scoped metadata through fallback', async () => {
    const { provider, openai, gemini, onFallback } = createProviderHarness();
    const err = Object.assign(new Error('upstream 500 with no prompt body'), { status: 500 });
    openai.continueWithToolResults.mockRejectedValue(err);
    gemini.continueWithToolResults.mockResolvedValue(OK_RESULT);

    await provider.continueWithToolResults('secretary', [], 'finish it', 'safe scoped state', [], {
      userId: 11,
      tenantId: 22,
      modelTier: 'heavy',
    });

    expect(onFallback.mock.calls[0][0]).toEqual(expect.objectContaining({
      taskType: 'tool-use',
      callKind: 'tool-continuation',
      category: 'tool_continuation',
      domain: 'secretary',
      userId: 11,
      tenantId: 22,
      modelTier: 'heavy',
      fallbackReason: 'provider_server_error',
    }));
  });

  it('uses the configured provider pair instead of a hardcoded provider', async () => {
    const { provider, gemini, openai } = createProviderHarness();
    gemini.callDomain.mockResolvedValue(OK_RESULT);

    await provider.callDomain('content', [], 'hello', 'state');

    expect(gemini.callDomain).toHaveBeenCalled();
    expect(openai.callDomain).not.toHaveBeenCalled();
  });

  it('warns when a model call has user scope but no tenant scope', async () => {
    const { provider, gemini } = createProviderHarness();
    gemini.callDomain.mockResolvedValue(OK_RESULT);

    await provider.callDomain('content', [], 'hello', 'state', { userId: 7 });

    expect((logger.warn as any).mock.calls).toContainEqual([
      expect.objectContaining({
        provider: 'gemini',
        userId: 7,
        userScope: 'present',
        tenantScope: 'missing',
      }),
      'AI provider call has user scope but no tenant scope',
    ]);
  });

  it('detects runaway provider call loops per request without logging prompt text', async () => {
    process.env.AI_PROVIDER_RUNAWAY_CALL_THRESHOLD = '2';
    const { provider, gemini } = createProviderHarness();
    gemini.classify.mockResolvedValue({ domain: 'secretary', confidence: 0.9 });

    await runWithContext({ requestId: 'req-runaway-test', source: 'http', userId: 99 }, async () => {
      await provider.classify('first private prompt');
      await provider.classify('second private prompt');
      await provider.classify('third private prompt');
    });

    expect((logger.warn as any).mock.calls).toContainEqual([
      expect.objectContaining({
        requestId: 'req-runaway-test',
        provider: 'gemini',
        taskType: 'classify',
        category: 'classify_message',
        providerAttemptCount: 3,
        runawayThreshold: 2,
      }),
      'Potential runaway AI provider call loop detected',
    ]);
    expect(JSON.stringify((logger.warn as any).mock.calls)).not.toContain('third private prompt');
  });
});
