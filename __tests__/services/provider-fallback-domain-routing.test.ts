import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider, AICallResult } from '../../src/services/ai-provider';

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

function seedDomainPairCache(
  provider: unknown,
  domain: string,
  pair: { primary: AIProvider; fallback?: AIProvider },
): void {
  (provider as { domainPairCache: Map<string, { primary: AIProvider; fallback?: AIProvider }> })
    .domainPairCache
    .set(domain, pair);
}

describe('TaskRoutingProvider domain-specific routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses the resolved domain-specific provider pair for chat domain calls', async () => {
    const anthropic = createMockProvider('anthropic');
    const openai = createMockProvider('openai');
    const gemini = createMockProvider('gemini');

    vi.doMock('../../src/utils/logger', () => ({
      logger: {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        trace: vi.fn(), child: vi.fn().mockReturnThis(),
      },
    }));
    vi.doMock('../../src/services/secretary-tools', () => ({
      planSecretaryOptimization: vi.fn(() => ({
        filteredTools: [],
        modelTier: 'heavy',
        slicedHistory: [],
        optimized: true,
      })),
    }));
    vi.doMock('../../src/services/anthropic', () => ({
      TOOLS: [],
    }));

    const { TaskRoutingProvider } = await import('../../src/services/provider-fallback');
    openai.callDomain.mockResolvedValue(OK_RESULT);

    const provider = new TaskRoutingProvider({
      classify: { primary: anthropic, fallback: gemini },
      chat: { primary: gemini, fallback: openai },
      'tool-use': { primary: anthropic, fallback: gemini },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });
    seedDomainPairCache(provider, 'secretary', { primary: openai, fallback: gemini });

    const result = await provider.callDomain('secretary', [], 'plan my day', 'state');

    expect(result).toEqual(OK_RESULT);
    expect(openai.callDomain).toHaveBeenCalledWith(
      'secretary',
      [],
      'plan my day',
      'state',
      expect.objectContaining({ modelTier: 'heavy' }),
    );
    expect(anthropic.callDomain).not.toHaveBeenCalled();
    expect(gemini.callDomain).not.toHaveBeenCalled();
  });

  it('uses the same domain-specific provider pair for tool continuations', async () => {
    const anthropic = createMockProvider('anthropic');
    const openai = createMockProvider('openai');
    const gemini = createMockProvider('gemini');

    vi.doMock('../../src/utils/logger', () => ({
      logger: {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        trace: vi.fn(), child: vi.fn().mockReturnThis(),
      },
    }));
    vi.doMock('../../src/services/secretary-tools', () => ({
      planSecretaryOptimization: vi.fn(() => ({
        filteredTools: [],
        modelTier: 'heavy',
        slicedHistory: [],
        optimized: true,
      })),
    }));
    vi.doMock('../../src/services/anthropic', () => ({
      TOOLS: [],
    }));

    const { TaskRoutingProvider } = await import('../../src/services/provider-fallback');
    openai.continueWithToolResults.mockResolvedValue(OK_RESULT);

    const provider = new TaskRoutingProvider({
      classify: { primary: anthropic, fallback: gemini },
      chat: { primary: gemini, fallback: openai },
      'tool-use': { primary: anthropic, fallback: gemini },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });
    seedDomainPairCache(provider, 'secretary', { primary: openai, fallback: gemini });

    const result = await provider.continueWithToolResults('secretary', [], 'do it', 'state', []);

    expect(result).toEqual(OK_RESULT);
    expect(openai.continueWithToolResults).toHaveBeenCalledWith(
      'secretary',
      [],
      'do it',
      'state',
      [],
      expect.objectContaining({ modelTier: 'heavy' }),
    );
    expect(anthropic.continueWithToolResults).not.toHaveBeenCalled();
    expect(gemini.continueWithToolResults).not.toHaveBeenCalled();
  });

  it('passes the same scoped state context to fallback instead of rebuilding prompt context', async () => {
    const anthropic = createMockProvider('anthropic');
    const openai = createMockProvider('openai');
    const gemini = createMockProvider('gemini');

    vi.doMock('../../src/utils/logger', () => ({
      logger: {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        trace: vi.fn(), child: vi.fn().mockReturnThis(),
      },
    }));
    vi.doMock('../../src/services/secretary-tools', () => ({
      planSecretaryOptimization: vi.fn(() => ({
        filteredTools: [],
        modelTier: 'heavy',
        slicedHistory: [],
        optimized: true,
      })),
    }));
    vi.doMock('../../src/services/anthropic', () => ({
      TOOLS: [],
    }));

    const { TaskRoutingProvider } = await import('../../src/services/provider-fallback');
    const scopedContext = '<chat_reasoning_context tenant_id="10" user_id="7">safe scoped context</chat_reasoning_context>';
    openai.callDomain.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
    gemini.callDomain.mockResolvedValue(OK_RESULT);

    const provider = new TaskRoutingProvider({
      classify: { primary: anthropic, fallback: gemini },
      chat: { primary: openai, fallback: gemini },
      'tool-use': { primary: anthropic, fallback: gemini },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });
    seedDomainPairCache(provider, 'content', { primary: openai, fallback: gemini });

    const result = await provider.callDomain('content', [], 'use my normal workflow', scopedContext);

    expect(result).toEqual(OK_RESULT);
    expect(openai.callDomain).toHaveBeenCalledWith('content', [], 'use my normal workflow', scopedContext, expect.any(Object));
    expect(gemini.callDomain).toHaveBeenCalledWith('content', [], 'use my normal workflow', scopedContext, expect.any(Object));
  });
});
