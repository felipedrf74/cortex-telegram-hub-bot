import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  modelCallsDisabled: false,
  anthropicEnabled: true,
  openaiConfigured: true,
  geminiConfigured: true,
  ollamaConfigured: true,
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  captureError: vi.fn(),
  operatorAlert: vi.fn(),
  routingInstances: [] as Array<{
    config: Record<string, unknown>;
    onFallback: ((event: Record<string, unknown>) => void) | undefined;
  }>,
  providerRouting: {
    classify: { primary: 'gemini', fallback: 'openai' },
    chat: { primary: 'gemini', fallback: 'openai' },
    toolUse: { primary: 'gemini', fallback: 'openai' },
    scriptGeneration: { primary: 'ollama', fallback: 'approved_cloud_reasoning' },
    localReasoning: { primary: 'ollama', fallback: 'none' },
    circuitBreaker: { failureThreshold: 4, cooldownMs: 12_345 },
  },
}));

class MockAnthropicProvider {
  readonly name = 'anthropic';
}

class MockOpenAIProvider {
  readonly name = 'openai';
}

class MockGeminiProvider {
  readonly name = 'gemini';
}

class MockOllamaProvider {
  readonly name = 'ollama';
}

class MockTaskRoutingProvider {
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly onFallback: ((event: Record<string, unknown>) => void) | undefined;

  constructor(
    config: Record<string, unknown>,
    onFallback?: (event: Record<string, unknown>) => void,
  ) {
    this.config = config;
    this.onFallback = onFallback;
    const classify = config.classify as { primary: { name: string } };
    this.name = `routing(${classify.primary.name})`;
    state.routingInstances.push({ config, onFallback });
  }
}

vi.mock('../../src/config', () => ({
  config: {
    get providerRouting() {
      return state.providerRouting;
    },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: state.logger,
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/error-monitor', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/error-monitor')>(
    '../../src/services/error-monitor',
  );
  return {
    ...actual,
    captureError: (...args: unknown[]) => state.captureError(...args),
  };
});

vi.mock('../../src/services/runtime-flags', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/runtime-flags')>(
    '../../src/services/runtime-flags',
  );
  return {
    ...actual,
    areModelProviderCallsDisabled: () => state.modelCallsDisabled,
    isAnthropicRuntimeEnabled: () => state.anthropicEnabled,
  };
});

vi.mock('../../src/services/anthropic-provider', () => ({
  AnthropicProvider: MockAnthropicProvider,
}));

vi.mock('../../src/services/openai-provider', () => ({
  OPENAI_COST_PER_MTK: {},
  OpenAIProvider: MockOpenAIProvider,
  _sleep: vi.fn(),
  completeOneShot: vi.fn(),
  completeOneShotWithWebSearch: vi.fn(),
  completeVisionOneShot: vi.fn(),
  isOpenAIConfigured: () => state.openaiConfigured,
}));

vi.mock('../../src/services/gemini-provider', () => ({
  GeminiProvider: MockGeminiProvider,
  _sleep: vi.fn(),
  completeOneShot: vi.fn(),
  completeOneShotWithFallback: vi.fn(),
  completeOneShotWithSearch: vi.fn(),
  completeVisionOneShot: vi.fn(),
  completeVisionOneShotWithFallback: vi.fn(),
  computeGeminiCost: vi.fn(),
  isGeminiProviderConfigured: () => state.geminiConfigured,
  resolveGeminiCostModelKey: vi.fn(),
  scrubSearchGroundingPromptForPrivacy: vi.fn(),
}));

vi.mock('../../src/services/ollama-provider', () => ({
  OllamaProvider: MockOllamaProvider,
  _resetLocalReasoningOneShotProviderForTests: vi.fn(),
  completeLocalReasoningOneShot: vi.fn(),
  isOllamaConfigured: () => state.ollamaConfigured,
  normalizeClassificationPayload: vi.fn(),
  stripThinkBlocks: vi.fn(),
}));

vi.mock('../../src/services/provider-fallback', () => ({
  AIProviderTruncatedError: class extends Error {},
  CircuitBreaker: class {},
  CircuitState: {
    CLOSED: 'closed',
    HALF_OPEN: 'half-open',
    OPEN: 'open',
  },
  MidLoopProviderFallbackError: class extends Error {},
  TaskRoutingProvider: MockTaskRoutingProvider,
  resolveTaskType: vi.fn(),
  shouldBypassOllamaForToolOrWrite: vi.fn(),
}));

vi.mock('../../src/services/operator-alerts', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/operator-alerts')>(
    '../../src/services/operator-alerts',
  );
  return {
    ...actual,
    recordOperatorAlert: (...args: unknown[]) => state.operatorAlert(...args),
  };
});

type RegistryModule = typeof import('../../src/services/provider-registry');

async function loadRegistry(): Promise<RegistryModule> {
  return import('../../src/services/provider-registry');
}

function latestRoutingConfig(): Record<string, unknown> {
  const latest = state.routingInstances.at(-1);
  if (!latest) throw new Error('expected routing provider construction');
  return latest.config;
}

function pair(
  config: Record<string, unknown>,
  key: string,
): { primary: { name: string }; fallback?: { name: string } | string } | undefined {
  return config[key] as
    | { primary: { name: string }; fallback?: { name: string } | string }
    | undefined;
}

describe('provider registry behavior ownership', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.routingInstances.length = 0;
    state.modelCallsDisabled = false;
    state.anthropicEnabled = true;
    state.openaiConfigured = true;
    state.geminiConfigured = true;
    state.ollamaConfigured = true;
    Object.assign(state.providerRouting, {
      classify: { primary: 'gemini', fallback: 'openai' },
      chat: { primary: 'gemini', fallback: 'openai' },
      toolUse: { primary: 'gemini', fallback: 'openai' },
      scriptGeneration: { primary: 'ollama', fallback: 'approved_cloud_reasoning' },
      localReasoning: { primary: 'ollama', fallback: 'none' },
      circuitBreaker: { failureThreshold: 4, cooldownMs: 12_345 },
    });
    process.env = {
      ...originalEnv,
      AI_ALLOW_CLOUD_FALLBACK_WHEN_LOCAL_DISABLED: 'false',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('resolves, caches, clears, and rejects named providers exactly', async () => {
    const registry = await loadRegistry();

    const anthropic = registry.getProvider('anthropic');
    const openai = registry.getProvider('openai');
    const gemini = registry.getProvider('gemini');
    const ollama = registry.getProvider('ollama');
    expect(anthropic).toBeInstanceOf(MockAnthropicProvider);
    expect(openai).toBeInstanceOf(MockOpenAIProvider);
    expect(gemini).toBeInstanceOf(MockGeminiProvider);
    expect(ollama).toBeInstanceOf(MockOllamaProvider);
    expect(registry.getProvider('anthropic')).toBe(anthropic);
    expect(registry.getProvider('openai')).toBe(openai);
    expect(registry.getProvider('gemini')).toBe(gemini);
    expect(registry.getProvider('ollama')).toBe(ollama);

    expect(registry.getProvider('not-a-provider')).toBeNull();
    expect(state.logger.warn).toHaveBeenCalledWith(
      { name: 'not-a-provider' },
      'Unknown provider name in config — skipping',
    );

    registry.clearProviderCache();
    expect(registry.getActiveProvider()).toBeNull();
    expect(registry.getProvider('anthropic')).not.toBe(anthropic);
  });

  it('reports each unavailable configured provider and returns null', async () => {
    state.openaiConfigured = false;
    state.geminiConfigured = false;
    state.ollamaConfigured = false;
    const registry = await loadRegistry();

    expect(registry.getProvider('openai')).toBeNull();
    expect(registry.getProvider('gemini')).toBeNull();
    expect(registry.getProvider('ollama')).toBeNull();
    expect(state.logger.debug.mock.calls).toEqual(expect.arrayContaining([
      ['OpenAI provider requested but OPENAI_API_KEY not set — skipping'],
      ['Gemini provider requested but GEMINI_API_KEY not set — skipping'],
      ['Ollama provider requested but OLLAMA_ENABLED=false — skipping'],
    ]));
  });

  it('builds exact configured pairs, circuit breaker, and custom fallback callback', async () => {
    const customFallback = vi.fn();
    const registry = await loadRegistry();

    const provider = registry.createRoutingProvider(customFallback);
    const config = latestRoutingConfig();

    expect(registry.getActiveProvider()).toBe(provider);
    expect(registry.ensureActiveProvider()).toBe(provider);
    expect(pair(config, 'classify')?.primary.name).toBe('gemini');
    expect(pair(config, 'classify')?.fallback).toMatchObject({ name: 'openai' });
    expect(pair(config, 'chat')?.primary.name).toBe('gemini');
    expect(pair(config, 'tool-use')?.fallback).toMatchObject({ name: 'openai' });
    expect(pair(config, 'scriptGeneration')).toEqual({
      primary: expect.objectContaining({ name: 'ollama' }),
      fallback: 'approved_cloud_reasoning',
    });
    expect(pair(config, 'localReasoning')).toEqual({
      primary: expect.objectContaining({ name: 'ollama' }),
      fallback: 'none',
    });
    expect(config.circuitBreaker).toEqual({ failureThreshold: 4, cooldownMs: 12_345 });
    expect(state.routingInstances.at(-1)?.onFallback).toBe(customFallback);
    expect(state.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        classify: 'gemini→openai',
        chat: 'gemini→openai',
        'tool-use': 'gemini→openai',
        scriptGeneration: 'ollama→approved_cloud_reasoning',
        localReasoning: 'ollama→none',
        circuitBreaker: { failureThreshold: 4, cooldownMs: 12_345 },
        fixtureMode: false,
      }),
      'Provider routing initialized',
    );
  });

  it('uses all deterministic fixture classifications and completions when calls are disabled', async () => {
    state.modelCallsDisabled = true;
    const registry = await loadRegistry();
    const provider = registry.createRoutingProvider();
    const config = latestRoutingConfig();
    const fixture = pair(config, 'classify')?.primary;

    expect(provider.name).toBe('routing(fixture)');
    expect(pair(config, 'classify')?.fallback).toBeUndefined();
    expect(pair(config, 'chat')?.primary).toBe(fixture);
    expect(pair(config, 'tool-use')?.primary).toBe(fixture);
    expect(pair(config, 'scriptGeneration')).toBeUndefined();
    expect(pair(config, 'localReasoning')).toBeUndefined();
    expect(await fixture?.classify?.('write a LinkedIn caption')).toEqual({
      domain: 'content',
      confidence: 0.8,
    });
    expect(await fixture?.classify?.('plan my bike recovery')).toEqual({
      domain: 'triathlon',
      confidence: 0.8,
    });
    expect(await fixture?.classify?.('review an invoice expense')).toEqual({
      domain: 'finance',
      confidence: 0.8,
    });
    expect(await fixture?.classify?.('cook a grocery recipe')).toEqual({
      domain: 'cooking',
      confidence: 0.8,
    });
    expect(await fixture?.classify?.('hello there')).toEqual({
      domain: 'secretary',
      confidence: 0.6,
    });
    await expect(fixture?.callDomain?.('finance', [], '', '', 200)).resolves.toEqual({
      text: 'Local model fixture response for finance. Real provider calls are disabled for this local run.',
      toolCalls: [],
      stopReason: 'fixture',
    });
    await expect(fixture?.continueWithToolResults?.('content', [], '', '', [])).resolves.toEqual({
      text: 'Local model fixture continuation for content. Real provider calls are disabled for this local run.',
      toolCalls: [],
      stopReason: 'fixture',
    });
  });

  it('skips disabled Anthropic and selects available providers in priority order', async () => {
    state.anthropicEnabled = false;
    state.providerRouting.classify = { primary: 'anthropic', fallback: 'openai' };
    state.providerRouting.chat = { primary: 'missing', fallback: 'gemini' };
    state.providerRouting.toolUse = { primary: 'missing', fallback: 'missing-too' };
    const registry = await loadRegistry();

    registry.createRoutingProvider();
    const config = latestRoutingConfig();

    expect(pair(config, 'classify')?.primary.name).toBe('openai');
    expect(pair(config, 'classify')?.fallback).toMatchObject({ name: 'gemini' });
    expect(pair(config, 'chat')?.primary.name).toBe('gemini');
    expect(pair(config, 'tool-use')?.primary.name).toBe('gemini');
    expect(state.logger.debug).toHaveBeenCalledWith(
      'Anthropic provider requested while ANTHROPIC_ENABLED is false — skipping',
    );
  });

  it('fails when every governed cloud provider is unavailable', async () => {
    state.anthropicEnabled = false;
    state.openaiConfigured = false;
    state.geminiConfigured = false;
    state.ollamaConfigured = false;
    state.providerRouting.classify = { primary: 'missing', fallback: 'also-missing' };
    const registry = await loadRegistry();

    expect(() => registry.createRoutingProvider()).toThrow(
      "No AI providers available for primary='missing' fallback='also-missing'. " +
      'Set GEMINI_API_KEY or OPENAI_API_KEY, or explicitly re-enable Anthropic.',
    );
  });

  it('alerts when an unavailable local primary silently selects cloud', async () => {
    state.ollamaConfigured = false;
    state.providerRouting.classify = { primary: 'ollama', fallback: 'gemini' };
    const registry = await loadRegistry();

    registry.createRoutingProvider();

    expect(pair(latestRoutingConfig(), 'classify')?.primary.name).toBe('gemini');
    expect(state.logger.error).toHaveBeenCalledWith(
      {
        requested: 'ollama',
        selected: 'gemini',
        isLocalPrimary: true,
        allowSilentCloudFallback: false,
      },
      expect.stringContaining('CONFIG ERROR: AI_*_PRIMARY=ollama'),
    );
  });

  it('uses a warning when local-to-cloud fallback is explicitly acknowledged', async () => {
    process.env.AI_ALLOW_CLOUD_FALLBACK_WHEN_LOCAL_DISABLED = 'true';
    state.ollamaConfigured = false;
    state.providerRouting.classify = { primary: 'ollama', fallback: 'gemini' };
    const registry = await loadRegistry();

    registry.createRoutingProvider();

    expect(state.logger.warn).toHaveBeenCalledWith(
      {
        requested: 'ollama',
        selected: 'gemini',
        isLocalPrimary: true,
        allowSilentCloudFallback: true,
      },
      'Configured primary provider unavailable — using first available provider instead',
    );
    expect(state.operatorAlert).not.toHaveBeenCalled();
  });

  it('preserves the optional cloud sentinel when Ollama is disabled', async () => {
    state.ollamaConfigured = false;
    const registry = await loadRegistry();

    registry.createRoutingProvider();
    const scriptPair = pair(latestRoutingConfig(), 'scriptGeneration');
    const unavailable = scriptPair?.primary;

    expect(unavailable?.name).toBe('unavailable:ollama');
    expect(scriptPair?.fallback).toBe('approved_cloud_reasoning');
    await expect(unavailable?.classify?.('hello')).rejects.toMatchObject({
      message: 'ollama_disabled',
      code: 'OLLAMA_DISABLED',
    });
    await expect(unavailable?.callDomain?.('content', [], '', '')).rejects.toMatchObject({
      message: 'ollama_disabled',
      code: 'OLLAMA_DISABLED',
    });
    await expect(unavailable?.continueWithToolResults?.('content', [], '', '', [])).rejects.toMatchObject({
      message: 'ollama_disabled',
      code: 'OLLAMA_DISABLED',
    });
    expect(pair(latestRoutingConfig(), 'localReasoning')).toBeUndefined();
    expect(state.logger.info).toHaveBeenCalledWith(
      { primaryName: 'ollama', fallbackName: 'approved_cloud_reasoning' },
      'Ollama disabled — preserving optional task route through approved cloud gate',
    );
    expect(state.logger.info).toHaveBeenCalledWith(
      { primaryName: 'ollama', fallbackName: 'none' },
      'New task-type primary unavailable — skipping pair build',
    );
  });

  it('resolves real sentinel fallbacks and fails closed when unavailable', async () => {
    state.providerRouting.scriptGeneration = { primary: 'ollama', fallback: 'openai' };
    state.providerRouting.localReasoning = { primary: 'ollama', fallback: 'missing' };
    const registry = await loadRegistry();

    registry.createRoutingProvider();
    const config = latestRoutingConfig();

    expect(pair(config, 'scriptGeneration')?.fallback).toMatchObject({ name: 'openai' });
    expect(pair(config, 'localReasoning')?.fallback).toBe('none');
    expect(state.logger.info).toHaveBeenCalledWith(
      { primaryName: 'ollama', fallbackName: 'missing' },
      'New task-type fallback provider unavailable — falling back to sentinel "none"',
    );
  });

  it('reports every disabled Anthropic position without breaking initialization', async () => {
    state.anthropicEnabled = false;
    state.providerRouting.classify = { primary: 'anthropic', fallback: 'anthropic' };
    state.providerRouting.chat = { primary: 'anthropic', fallback: 'anthropic' };
    state.providerRouting.toolUse = { primary: 'anthropic', fallback: 'anthropic' };
    state.captureError.mockImplementationOnce(() => {
      throw new Error('monitor unavailable');
    });
    const registry = await loadRegistry();

    expect(() => registry.createRoutingProvider()).not.toThrow();
    const disabledWarnings = state.logger.warn.mock.calls.filter(
      ([context]) => (
        typeof context === 'object'
        && context !== null
        && 'configuredProvider' in context
      ),
    );
    expect(disabledWarnings).toHaveLength(6);
    expect(state.captureError).toHaveBeenCalledTimes(6);
    expect(state.captureError.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Anthropic provider configured while disabled for classify primary' }),
      expect.objectContaining({ message: 'Anthropic provider configured while disabled for classify fallback' }),
      expect.objectContaining({ message: 'Anthropic provider configured while disabled for chat primary' }),
      expect.objectContaining({ message: 'Anthropic provider configured while disabled for chat fallback' }),
      expect.objectContaining({ message: 'Anthropic provider configured while disabled for tool-use primary' }),
      expect.objectContaining({ message: 'Anthropic provider configured while disabled for tool-use fallback' }),
    ]));
  });

  it('installs and exercises the default fallback observer', async () => {
    const registry = await loadRegistry();
    registry.createRoutingProvider();
    const callback = state.routingInstances.at(-1)?.onFallback;
    const event = {
      taskType: 'chat',
      primaryProvider: 'gemini',
      fallbackProvider: 'openai',
      circuitOpen: false,
      fallbackReason: 'provider_error',
      errorSummary: 'upstream failed',
      category: 'transient',
      domain: 'secretary',
      modelTier: 'fast',
      requestId: 'request-1',
      requestSource: 'chat',
      tenantId: 70,
      userId: 7,
      tenantScope: 'tenant',
      operatorOverrideApplied: false,
      pairSource: 'configured',
    };

    expect(callback).toBeTypeOf('function');
    callback?.(event);
    expect(state.logger.warn).toHaveBeenCalledWith(
      {
        taskType: 'chat',
        from: 'gemini',
        to: 'openai',
        circuitOpen: false,
        fallbackReason: 'provider_error',
        error: 'upstream failed',
        category: 'transient',
        domain: 'secretary',
        modelTier: 'fast',
        requestId: 'request-1',
        requestSource: 'chat',
        tenantId: 70,
        userId: 7,
        tenantScope: 'tenant',
        operatorOverrideApplied: false,
        pairSource: 'configured',
      },
      'AI provider fallback triggered',
    );
    expect(state.captureError).toHaveBeenCalledWith(
      {
        level: 'warning',
        source: 'job',
        message: 'AI provider fallback: gemini → openai for chat',
        context: {
          taskType: 'chat',
          primaryProvider: 'gemini',
          fallbackProvider: 'openai',
          circuitOpen: false,
          fallbackReason: 'provider_error',
          error: 'upstream failed',
          category: 'transient',
          domain: 'secretary',
          modelTier: 'fast',
          requestId: 'request-1',
          requestSource: 'chat',
          tenantId: 70,
          userId: 7,
          tenantScope: 'tenant',
          operatorOverrideApplied: false,
          pairSource: 'configured',
        },
      },
      false,
    );

    state.captureError.mockImplementationOnce(() => {
      throw new Error('monitor unavailable');
    });
    expect(() => callback?.(event)).not.toThrow();
  });

  it('lazily initializes once and safely returns null on construction failure', async () => {
    const registry = await loadRegistry();
    const first = registry.ensureActiveProvider();

    expect(first).toBe(registry.getActiveProvider());
    expect(state.routingInstances).toHaveLength(1);
    expect(registry.ensureActiveProvider()).toBe(first);
    expect(state.routingInstances).toHaveLength(1);

    registry.clearProviderCache();
    state.anthropicEnabled = false;
    state.openaiConfigured = false;
    state.geminiConfigured = false;
    state.ollamaConfigured = false;
    state.providerRouting.classify = { primary: 'missing', fallback: 'missing' };
    expect(registry.ensureActiveProvider()).toBeNull();
    expect(state.logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Failed to lazily initialize AI provider routing',
    );
  });
});
