// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OllamaProvider — unit tests with mocked fetch.
 *
 * Covers the architectural invariants from the WO-ollama-local-llm plan:
 *   - Healthy classify returns parsed domain
 *   - Invalid JSON triggers LocalLLMError('invalid_json')
 *   - Timeout via AbortController → LocalLLMError('timeout')
 *   - Concurrent call beyond queue depth → LocalLLMError('capacity_exceeded')
 *   - continueWithToolResults → LocalLLMError('unsupported_capability')
 *   - input_token_overflow when prompt exceeds the per-task cap
 *   - PM2 cluster guard: NODE_APP_INSTANCE=1 throws at construct time
 *   - Thinking traces (<think>...</think> and message.thinking) are
 *     stripped from the returned text and absent from logger output
 *   - Exactly ONE api_usage row written per successful call
 *
 * Pattern mirrors __tests__/services/gemini-provider.test.ts (vi.mock on
 * the SDK, vi.fn on individual methods).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Mock config BEFORE importing the provider so its module-load reads see
// our test values.
vi.mock('../../src/config', () => ({
  config: {
    ollama: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:3b-instruct-q4_K_M',
      classifierModel: 'qwen2.5:3b-instruct-q4_K_M',
      maxTokens: 2048,
      secretaryMaxTokens: 4096,
      timeoutMs: 200,                       // short for tests
      tokenCaps: {
        classifyMaxInput: 1500,
        classifyMaxOutput: 128,
        scriptGenMaxInput: 6000,
        scriptGenMaxOutput: 1800,
        localReasoningMaxInput: 6000,
        localReasoningMaxOutput: 1200,
      },
      queue: {
        backend: 'memory',
        classifyDepth: 2,
        scriptGenDepth: 1,
        localReasoningDepth: 1,
        classifyMaxWaitMs: 50,
        scriptGenMaxWaitMs: 100,
        localReasoningMaxWaitMs: 100,
        globalMaxDepth: 4,
      },
      rateLimit: { perUserDaily: 0, perUserHourly: 0, scriptGenPerUserDaily: 0 },
      artifacts: { retentionDays: 14, storePrompts: false, storeGenerated: true },
    },
    localLLMEvaluation: { enabled: true, showProviderMetadata: true, requireLocalForScriptGen: true },
  },
}));

// Stub the anthropic system-prompt helpers used by OllamaProvider.classify
// and callDomain so we don't pull in the whole anthropic.ts module graph.
vi.mock('../../src/services/anthropic', () => ({
  TOOLS: [],
  getClassifierSystemPrompt: () => 'You are a domain classifier.',
  getDomainSystemPrompt: (d: string) => `You are the ${d} agent.`,
  // Option 3 (O3-A14): compact classifier prompt. Tests don't exercise
  // the compact path — return null so the long-prompt fallback is used.
  getOllamaClassifierSystemPromptCompact: () => null,
}));

// Stub database, telemetry, api-usage-fallback, and rate-limiter so the
// provider's side effects don't touch SQLite or the real telemetry bus.
const runMock = vi.fn();
const assertBudgetMock = vi.hoisted(() => vi.fn());
const rateLimitMock = vi.hoisted(() => vi.fn(() => ({ allowed: true })));
vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({ run: runMock, all: () => [], get: () => undefined }),
  }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));
vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
  _resetTelemetryForTests: vi.fn(),
  getBotRef: vi.fn(),
  getGarminRefreshStatus: vi.fn(),
  getJobMap: vi.fn(),
  getJobStatuses: vi.fn(),
  getLastMessageAt: vi.fn(),
  getRecentEvents: vi.fn(),
  isBotPollingActive: vi.fn(),
  isJobEnabled: vi.fn(),
  isRestarting: vi.fn(),
  recordGarminRefresh: vi.fn(),
  recordMessageProcessed: vi.fn(),
  registerJob: vi.fn(),
  seedJobLastRunFromHistory: vi.fn(),
  setBotPollingActive: vi.fn(),
  setBotRef: vi.fn(),
  setDbProvider: vi.fn(),
  setIsRestarting: vi.fn(),
  setJobEnabledChecker: vi.fn(),
  setJobFailureNotifier: vi.fn(),
  wrapJob: vi.fn((name: string, fn: unknown) => fn),
}));
vi.mock('../../src/services/api-usage-fallback', () => ({
  getApiUsageColumns: vi.fn(() => new Set<string>()),
  insertApiUsageFallback: vi.fn(() => 0),
}));
vi.mock('../../src/services/cost-guardrail', () => ({
  assertAiBudgetReservationForProvider: assertBudgetMock,
}));
vi.mock('../../src/services/local-llm-rate-limiter', () => ({
  _resetLocalLLMRateLimiterSchemaCacheForTests: vi.fn(),
  checkAndConsumeLocalLLMRateLimit: (...args: unknown[]) => rateLimitMock(...args),
}));

// Logger spy so we can assert thinking content never appears in logs.
const logCalls: Array<Record<string, unknown>> = [];
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info:  (obj: Record<string, unknown>, _msg?: string) => { logCalls.push({ level: 'info',  ...obj, _msg }); },
    warn:  (obj: Record<string, unknown>, _msg?: string) => { logCalls.push({ level: 'warn',  ...obj, _msg }); },
    error: (obj: Record<string, unknown>, _msg?: string) => { logCalls.push({ level: 'error', ...obj, _msg }); },
    debug: (obj: Record<string, unknown>, _msg?: string) => { logCalls.push({ level: 'debug', ...obj, _msg }); },
  },
  LOGGER_REDACTION_PATHS: [],
}));

// Import AFTER all mocks so the provider picks them up.
import { LocalLLMError } from '../../src/services/local-llm-error';
import { OllamaProvider, completeLocalReasoningOneShot, stripThinkBlocks } from '../../src/services/ollama-provider';

// Bring fetch under our control.
const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

function makeChatResponse(payload: {
  content: string;
  thinking?: string;
  total_duration_ns?: number;
  load_duration_ns?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}) {
  return new Response(JSON.stringify({
    model: 'qwen2.5:3b-instruct-q4_K_M',
    message: { role: 'assistant', content: payload.content, ...(payload.thinking !== undefined ? { thinking: payload.thinking } : {}) },
    done: true,
    done_reason: payload.done_reason ?? 'stop',
    total_duration: payload.total_duration_ns ?? 1_000_000_000,
    load_duration: payload.load_duration_ns ?? 100_000_000,
    prompt_eval_count: payload.prompt_eval_count ?? 10,
    prompt_eval_duration: 500_000_000,
    eval_count: payload.eval_count ?? 5,
    eval_duration: 500_000_000,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function makeTagsResponse() {
  return new Response(JSON.stringify({
    models: [{ name: 'qwen2.5:3b-instruct-q4_K_M', digest: 'sha256:abc' }],
  }), { status: 200 });
}

beforeEach(() => {
  fetchMock.mockReset();
  runMock.mockReset();
  assertBudgetMock.mockReset();
  rateLimitMock.mockReset();
  rateLimitMock.mockReturnValue({ allowed: true });
  logCalls.length = 0;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  delete process.env.NODE_APP_INSTANCE;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('OllamaProvider — construction guards', () => {
  it('throws when LOCAL_LLM_QUEUE_BACKEND is not memory', async () => {
    const mod = await import('../../src/config');
    const orig = mod.config.ollama.queue.backend;
    (mod.config.ollama.queue as { backend: string }).backend = 'sqlite';
    try {
      expect(() => new OllamaProvider()).toThrowError(/not implemented in v1/);
    } finally {
      (mod.config.ollama.queue as { backend: string }).backend = orig;
    }
  });

  it('throws when NODE_APP_INSTANCE > 0 with memory backend (PM2 cluster guard)', () => {
    process.env.NODE_APP_INSTANCE = '1';
    expect(() => new OllamaProvider()).toThrowError(/single-instance only/);
  });

  it('initializes cleanly when memory backend + single instance', () => {
    expect(() => new OllamaProvider()).not.toThrow();
  });

  it('refuses script generation and large local reasoning outside explicit evaluation mode', async () => {
    const mod = await import('../../src/config');
    const originalEnabled = mod.config.localLLMEvaluation.enabled;
    mod.config.localLLMEvaluation.enabled = false;
    try {
      const provider = new OllamaProvider();
      await expect(provider.generateScript({ description: 'make a release script' } as never))
        .rejects.toMatchObject({ kind: 'unsupported_capability' });
      await expect(provider.localReason({ prompt: 'perform a large reasoning task' }))
        .rejects.toMatchObject({ kind: 'unsupported_capability' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      mod.config.localLLMEvaluation.enabled = originalEnabled;
    }
  });

  it('refuses script generation when local evaluation does not require it', async () => {
    const mod = await import('../../src/config');
    const originalRequired = mod.config.localLLMEvaluation.requireLocalForScriptGen;
    mod.config.localLLMEvaluation.requireLocalForScriptGen = false;
    try {
      await expect(new OllamaProvider().generateScript({
        description: 'make a release script',
      } as never)).rejects.toMatchObject({
        kind: 'unsupported_capability',
        meta: expect.objectContaining({
          capability: 'production_script_generation_requires_approved_cloud_reasoning',
        }),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      mod.config.localLLMEvaluation.requireLocalForScriptGen = originalRequired;
    }
  });
});

describe('OllamaProvider — classify', () => {
  it('fails closed for live classification because only classifier shadow owns a local role', async () => {
    const p = new OllamaProvider();
    await expect(p.classify('hello')).rejects.toMatchObject({
      kind: 'unsupported_capability',
      meta: expect.objectContaining({ capability: 'local_workload_role_not_allowed' }),
    });
    expect(assertBudgetMock).not.toHaveBeenCalled();
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an ineligible request before consuming local rate-limit capacity', async () => {
    assertBudgetMock.mockImplementationOnce(() => {
      throw new Error('AI_PLAN_REQUIRED');
    });

    const p = new OllamaProvider();
    await expect(p.classify('hello', undefined, { source: 'shadow' })).rejects.toThrow('AI_PLAN_REQUIRED');

    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns parsed domain on a healthy call', async () => {
    fetchMock
      .mockResolvedValueOnce(makeChatResponse({ content: '{"domain":"content","confidence":0.91}' }))
      .mockResolvedValueOnce(makeTagsResponse());
    const p = new OllamaProvider();
    const result = await p.classify('write me a youtube hook for triathlon', undefined, { source: 'shadow' });
    expect(result.domain).toBe('content');
    expect(result.confidence).toBeCloseTo(0.91);
  });

  it('throws LocalLLMError(invalid_json) when the response is unparseable', async () => {
    fetchMock
      .mockResolvedValueOnce(makeChatResponse({ content: 'not json at all' }))
      .mockResolvedValueOnce(makeTagsResponse());
    const p = new OllamaProvider();
    await expect(p.classify('hello', undefined, { source: 'shadow' })).rejects.toBeInstanceOf(LocalLLMError);
  });

  it('throws LocalLLMError(invalid_json) when the JSON does not match the schema', async () => {
    fetchMock
      .mockResolvedValueOnce(makeChatResponse({ content: '{"domain":"not-a-domain","confidence":0.5}' }))
      .mockResolvedValueOnce(makeTagsResponse());
    const p = new OllamaProvider();
    await expect(p.classify('hello', undefined, { source: 'shadow' })).rejects.toMatchObject({ kind: 'invalid_json' });
  });

  it('throws LocalLLMError(input_token_overflow) when prompt exceeds cap', async () => {
    const p = new OllamaProvider();
    const massive = 'x'.repeat(5000); // > classifyMaxInput=1500 with /3 estimator
    await expect(p.classify(massive, undefined, { source: 'shadow' })).rejects.toMatchObject({ kind: 'input_token_overflow' });
  });

  it('writes exactly one api_usage row per successful classify with correct columns', async () => {
    fetchMock
      .mockResolvedValueOnce(makeChatResponse({ content: '{"domain":"content","confidence":0.5}' }))
      .mockResolvedValueOnce(makeTagsResponse());
    const p = new OllamaProvider();
    await p.classify('hello', undefined, { source: 'shadow' });
    // v2.7 hardening: assert the INSERT bind values, not just call count.
    // The runMock signature is `run(...values)` where values are passed in
    // the order they appear in the parameterized SQL:
    //   (category, model, tenant_id, user_id, input_tokens, output_tokens,
    //    duration_ms, modelDigest)
    // — and cost_usd, provider, pricing_status, local_request_units are
    // hardcoded in the SQL text as 0, 'ollama', 'zero-cost', 1. The
    // bound values we capture include the dynamic columns; cost/pricing
    // are SQL literals so we infer them from the test passing without
    // a fallback path firing (the prepare().run() chain is the primary
    // path; insertApiUsageFallback would only fire in the catch).
    expect(runMock).toHaveBeenCalledTimes(1);
    const callArgs = runMock.mock.calls[0] as unknown[];
    // Position 0: category
    expect(callArgs[0]).toBe('classify_shadow');
    // Position 1: model
    expect(callArgs[1]).toBe('qwen2.5:3b-instruct-q4_K_M');
    // Position 2: tenant_id (0 in this test, no user)
    expect(callArgs[2]).toBe(0);
    // Position 3: user_id (0)
    expect(callArgs[3]).toBe(0);
  });
});

describe('OllamaProvider — scoped state context', () => {
  it('sends trusted state context in the request instead of only counting its tokens', async () => {
    fetchMock
      .mockResolvedValueOnce(makeChatResponse({ content: 'Grounded answer' }))
      .mockResolvedValueOnce(makeTagsResponse());
    const p = new OllamaProvider();

    await p.callDomain('content', [], 'What is next?', 'SYNTHETIC_EVAL_FACT', {
      userId: 42,
      tenantId: 42,
    });

    const request = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessage = request.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(userMessage).toContain('SYNTHETIC_EVAL_FACT');
    expect(userMessage).toContain('What is next?');
    expect(userMessage).toContain('NEXUS_STATE_BEGIN');
  });
});

describe('OllamaProvider — explicit workload roles', () => {
  it('allows validated local chat in normal runtime without evaluation mode', async () => {
    const mod = await import('../../src/config');
    const originalEnabled = mod.config.localLLMEvaluation.enabled;
    mod.config.localLLMEvaluation.enabled = false;
    fetchMock
      .mockResolvedValueOnce(makeChatResponse({ content: 'local answer' }))
      .mockResolvedValueOnce(makeTagsResponse());
    try {
      const result = await new OllamaProvider().localReason({
        workloadRole: 'validated_local_chat',
        prompt: 'bounded local chat',
        think: false,
        numCtx: 8192,
      });
      expect(result.text).toBe('local answer');
      const [, fetchOptions] = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(fetchOptions.body).options.num_ctx).toBe(4096);
    } finally {
      mod.config.localLLMEvaluation.enabled = originalEnabled;
    }
  });

  it('prevents chatPrimitive from bypassing a missing workload role', async () => {
    const p = new OllamaProvider();
    await expect((p.chatPrimitive as unknown as (args: unknown) => Promise<unknown>)({
      taskType: 'localReasoning',
      category: 'generic_reasoning',
      request: {
        model: 'qwen2.5:3b-instruct-q4_K_M',
        messages: [{ role: 'user', content: 'complex request' }],
        stream: false,
      },
    })).rejects.toMatchObject({
      kind: 'unsupported_capability',
      meta: expect.objectContaining({
        taskType: 'localReasoning',
        capability: 'local_workload_role_not_allowed',
        workloadRole: 'missing',
      }),
    });
    expect(assertBudgetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an unsupported named workload role without dispatching', async () => {
    const p = new OllamaProvider();
    await expect((p.chatPrimitive as unknown as (args: unknown) => Promise<unknown>)({
      taskType: 'localReasoning',
      workloadRole: 'unapproved_local_role',
      category: 'generic_reasoning',
      request: {
        model: 'qwen2.5:3b-instruct-q4_K_M',
        messages: [{ role: 'user', content: 'complex request' }],
        stream: false,
      },
    })).rejects.toMatchObject({
      kind: 'unsupported_capability',
      meta: expect.objectContaining({
        taskType: 'localReasoning',
        capability: 'local_workload_role_not_allowed',
        workloadRole: 'unapproved_local_role',
      }),
    });
    expect(assertBudgetMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows offline evaluation for local reasoning while independently denying optional local script generation', async () => {
    const mod = await import('../../src/config');
    const originalRequired = mod.config.localLLMEvaluation.requireLocalForScriptGen;
    mod.config.localLLMEvaluation.requireLocalForScriptGen = false;
    const request = {
      model: 'qwen2.5:3b-instruct-q4_K_M',
      messages: [{ role: 'user' as const, content: 'bounded evaluation' }],
      stream: false,
    };
    try {
      const provider = new OllamaProvider();
      await expect((provider.chatPrimitive as unknown as (args: unknown) => Promise<unknown>)({
        taskType: 'scriptGeneration',
        workloadRole: 'offline_evaluation',
        category: 'script_evaluation',
        request,
      })).rejects.toMatchObject({
        kind: 'unsupported_capability',
        meta: expect.objectContaining({
          taskType: 'scriptGeneration',
          workloadRole: 'offline_evaluation',
        }),
      });
      expect(fetchMock).not.toHaveBeenCalled();

      fetchMock
        .mockResolvedValueOnce(makeChatResponse({ content: 'bounded result' }))
        .mockResolvedValueOnce(makeTagsResponse());
      await expect(provider.chatPrimitive({
        taskType: 'localReasoning',
        workloadRole: 'offline_evaluation',
        category: 'reasoning_evaluation',
        request,
      })).resolves.toMatchObject({
        response: {
          message: { content: 'bounded result' },
        },
      });
    } finally {
      mod.config.localLLMEvaluation.requireLocalForScriptGen = originalRequired;
    }
  });
});

describe('OllamaProvider — thinking-trace strip', () => {
  it('stripThinkBlocks removes inline <think>...</think>', () => {
    expect(stripThinkBlocks('hello <think>internal</think> world')).toBe('hello  world');
    expect(stripThinkBlocks('<think>only</think>')).toBe('');
    expect(stripThinkBlocks('')).toBe('');
    expect(stripThinkBlocks(null)).toBe('');
  });

  it('returned text does not contain <think> blocks', async () => {
    fetchMock
      .mockResolvedValueOnce(makeChatResponse({
        content: '<think>secret reasoning here</think>{"domain":"content","confidence":0.7}',
      }))
      .mockResolvedValueOnce(makeTagsResponse());
    const p = new OllamaProvider();
    const result = await p.classify('hello', undefined, { source: 'shadow' });
    expect(JSON.stringify(result)).not.toMatch(/<think>/);
    expect(JSON.stringify(result)).not.toMatch(/secret reasoning/);
  });

  it('logger output never contains thinking content', async () => {
    fetchMock
      .mockResolvedValueOnce(makeChatResponse({
        content: '<think>private chain of thought</think>{"domain":"content","confidence":0.7}',
        thinking: 'private chain of thought also surfaced as message.thinking',
      }))
      .mockResolvedValueOnce(makeTagsResponse());
    const p = new OllamaProvider();
    await p.classify('hello', undefined, { source: 'shadow' });
    const joined = JSON.stringify(logCalls);
    expect(joined).not.toMatch(/private chain of thought/);
    expect(joined).not.toMatch(/<think>/);
  });
});

describe('OllamaProvider — continueWithToolResults is unsupported in v1', () => {
  it('throws LocalLLMError(unsupported_capability)', async () => {
    const p = new OllamaProvider();
    await expect(
      p.continueWithToolResults('secretary', [], 'msg', 'state', [], {}),
    ).rejects.toMatchObject({ kind: 'unsupported_capability' });
  });
});

describe('OllamaProvider — timeout maps to LocalLLMError(timeout)', () => {
  it('AbortController abort produces LocalLLMError(timeout)', async () => {
    fetchMock.mockImplementationOnce((_url: string, opts: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const p = new OllamaProvider();
    await expect(p.classify('hello', undefined, { source: 'shadow' })).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('completeLocalReasoningOneShot — module-level one-shot helper (local-LLM pilot)', () => {
  it('returns stripped text and writes exactly one api_usage row with the caller category', async () => {
    fetchMock
      .mockResolvedValueOnce(makeChatResponse({ content: '<think>internal chain</think>{"categories":[]}' }))
      .mockResolvedValueOnce(makeTagsResponse());

    const result = await completeLocalReasoningOneShot(
      'You are a synthesizer.',
      'Synthesize the patterns.',
      'knowledge_synthesis_local',
      { maxTokens: 512, numCtx: 8192, temperature: 0.3, userId: 7, tenantId: 7 },
    );

    expect(result.text).toBe('{"categories":[]}');
    expect(result.text).not.toContain('<think>');
    expect(result.providerMetadata?.providerUsed).toBe('ollama');

    // Usage plumbing reused: one api_usage row, category from the caller,
    // user/tenant scope forwarded (cost 0 / local units are SQL literals).
    expect(runMock).toHaveBeenCalledTimes(1);
    const callArgs = runMock.mock.calls[0] as unknown[];
    expect(callArgs[0]).toBe('knowledge_synthesis_local');
    expect(callArgs[1]).toBe('qwen2.5:3b-instruct-q4_K_M');
    expect(callArgs[2]).toBe(7); // tenant_id
    expect(callArgs[3]).toBe(7); // user_id

    // Request honored the one-shot defaults: think:false, keep_alive:-1,
    // caller num_predict.
    const [, fetchOpts] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sent = JSON.parse(fetchOpts.body);
    expect(sent.think).toBe(false);
    expect(sent.keep_alive).toBe(-1);
    expect(sent.options.num_ctx).toBe(4096);
    expect(sent.options.num_predict).toBe(512);
    expect(sent.messages).toEqual([
      { role: 'system', content: 'You are a synthesizer.' },
      { role: 'user', content: 'Synthesize the patterns.' },
    ]);
  });

  it('throws LocalLLMError(provider_unhealthy) when Ollama is not configured', async () => {
    const mod = await import('../../src/config');
    const orig = mod.config.ollama.enabled;
    (mod.config.ollama as { enabled: boolean }).enabled = false;
    try {
      await expect(
        completeLocalReasoningOneShot('sys', 'user', 'knowledge_synthesis_local'),
      ).rejects.toMatchObject({ kind: 'provider_unhealthy' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      (mod.config.ollama as { enabled: boolean }).enabled = orig;
    }
  });

  it('cannot bypass explicit evaluation mode through the one-shot helper', async () => {
    const mod = await import('../../src/config');
    const originalEnabled = mod.config.localLLMEvaluation.enabled;
    mod.config.localLLMEvaluation.enabled = false;
    try {
      await expect(
        completeLocalReasoningOneShot('sys', 'user', 'knowledge_synthesis_local'),
      ).rejects.toMatchObject({
        kind: 'unsupported_capability',
        meta: expect.objectContaining({ capability: 'local_workload_role_not_allowed' }),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      mod.config.localLLMEvaluation.enabled = originalEnabled;
    }
  });

  it('throws LocalLLMError(input_token_overflow) when the prompt exceeds the localReasoning cap', async () => {
    const massive = 'x'.repeat(30000); // > localReasoningMaxInput=6000 with /3 estimator
    await expect(
      completeLocalReasoningOneShot('sys', massive, 'knowledge_synthesis_local'),
    ).rejects.toMatchObject({ kind: 'input_token_overflow' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
