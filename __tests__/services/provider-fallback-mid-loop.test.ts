/**
 * ADV-2 (chat safety hardening, milestone 1): a tool loop must stay on the
 * provider that issued its tool_use ids. Falling back to a different provider
 * mid-loop hands it tool_use_ids it never issued — providers reject them or,
 * worse, answer around them. The routing layer must pin continuations to the
 * issuing provider and refuse dispatch when that provider is unroutable.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TaskRoutingProvider,
  MidLoopProviderFallbackError,
  type TaskRoutingConfig,
} from '../../src/services/provider-fallback';
import type { AICallResult, AIProvider, AIToolResultMessage } from '../../src/services/ai-provider';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
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
  } as any;
}

function okResult(): AICallResult {
  return { text: 'ok', toolCalls: [], stopReason: 'end_turn' };
}

function retryableError(): Error {
  return Object.assign(new Error('rate limited'), { status: 429 });
}

const TOOL_CONVERSATION: AIToolResultMessage[] = [
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_a1', name: 'get_calendar_events', input: {} } as any,
      { type: 'tool_use', id: 'toolu_a2', name: 'ms_todo_get_tasks', input: {} } as any,
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_a1', content: '{}' },
      { type: 'tool_result', tool_use_id: 'toolu_a2', content: '{}' },
    ],
  },
];

describe('mid-loop provider pinning (ADV-2)', () => {
  let anthropic: ReturnType<typeof createMockProvider>;
  let openai: ReturnType<typeof createMockProvider>;
  let gemini: ReturnType<typeof createMockProvider>;
  let provider: TaskRoutingProvider;

  beforeEach(() => {
    anthropic = createMockProvider('anthropic');
    openai = createMockProvider('openai');
    gemini = createMockProvider('gemini');
    const config: TaskRoutingConfig = {
      classify: { primary: anthropic, fallback: openai },
      chat: { primary: openai, fallback: gemini },
      'tool-use': { primary: anthropic, fallback: gemini },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    };
    provider = new TaskRoutingProvider(config, vi.fn());
    // Seed the per-domain pair cache so dispatch never consults the real
    // domain-provider-router — on a checkout whose .env carries live API
    // keys, that path would construct REAL providers and leak paid calls
    // out of this unit test (same pattern as provider-fallback-domain-routing).
    (provider as unknown as {
      domainPairCache: Map<string, { primary: AIProvider; fallback?: AIProvider }>;
    }).domainPairCache.set('secretary', { primary: anthropic, fallback: gemini });
  });

  it('callDomain stamps which provider actually answered (primary)', async () => {
    anthropic.callDomain.mockImplementation(async () => okResult());
    const result = await provider.callDomain('secretary', [], 'plan my day', 'state');
    expect(result.routedProviderName).toBe('anthropic');
  });

  it('callDomain stamps the fallback provider when the primary fails', async () => {
    anthropic.callDomain.mockRejectedValue(retryableError());
    gemini.callDomain.mockImplementation(async () => okResult());
    const result = await provider.callDomain('secretary', [], 'plan my day', 'state');
    expect(result.routedProviderName).toBe('gemini');
  });

  it('continuation stamps the provider that answered it', async () => {
    anthropic.continueWithToolResults.mockImplementation(async () => okResult());
    const result = await provider.continueWithToolResults(
      'secretary', [], 'plan my day', 'state', TOOL_CONVERSATION,
      { toolLoopProviderName: 'anthropic' },
    );
    expect(result.routedProviderName).toBe('anthropic');
  });

  it('never falls back to a different provider mid-loop — the issuer error surfaces instead', async () => {
    anthropic.continueWithToolResults.mockRejectedValue(retryableError());
    gemini.continueWithToolResults.mockImplementation(async () => okResult());

    await expect(provider.continueWithToolResults(
      'secretary', [], 'plan my day', 'state', TOOL_CONVERSATION,
      { toolLoopProviderName: 'anthropic' },
    )).rejects.toThrow('rate limited');

    expect(gemini.continueWithToolResults).not.toHaveBeenCalled();
  });

  it('dispatches straight to the issuer when the loop opened on the configured fallback', async () => {
    gemini.continueWithToolResults.mockImplementation(async () => okResult());

    const result = await provider.continueWithToolResults(
      'secretary', [], 'plan my day', 'state', TOOL_CONVERSATION,
      { toolLoopProviderName: 'gemini' },
    );

    expect(result.routedProviderName).toBe('gemini');
    expect(anthropic.continueWithToolResults).not.toHaveBeenCalled();
  });

  it('refuses dispatch with a typed error when the issuer is no longer routable', async () => {
    await expect(provider.continueWithToolResults(
      'secretary', [], 'plan my day', 'state', TOOL_CONVERSATION,
      { toolLoopProviderName: 'openai' },
    )).rejects.toBeInstanceOf(MidLoopProviderFallbackError);

    expect(anthropic.continueWithToolResults).not.toHaveBeenCalled();
    expect(gemini.continueWithToolResults).not.toHaveBeenCalled();
  });

  it('reports the open tool_use ids in the typed error for observability', async () => {
    const rejection = await provider.continueWithToolResults(
      'secretary', [], 'plan my day', 'state', TOOL_CONVERSATION,
      { toolLoopProviderName: 'openai' },
    ).then(() => null, (err: unknown) => err) as MidLoopProviderFallbackError;

    expect(rejection).toBeInstanceOf(MidLoopProviderFallbackError);
    expect(rejection.issuerProvider).toBe('openai');
    expect(rejection.openToolUseIds).toEqual(['toolu_a1', 'toolu_a2']);
  });

  it('callers that do not declare an issuer keep the legacy fallback behavior', async () => {
    // Boundary pin: only issuer-aware callers get mid-loop pinning. The
    // domain-handler tool loop passes toolLoopProviderName; legacy/direct
    // callers keep today's semantics until migrated.
    anthropic.continueWithToolResults.mockRejectedValue(retryableError());
    gemini.continueWithToolResults.mockImplementation(async () => okResult());

    const result = await provider.continueWithToolResults(
      'secretary', [], 'plan my day', 'state', TOOL_CONVERSATION,
    );

    expect(result.text).toBe('ok');
    expect(gemini.continueWithToolResults).toHaveBeenCalled();
  });
});
