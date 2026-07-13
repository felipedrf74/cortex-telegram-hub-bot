import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config', () => ({
  config: {
    ollama: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.6:35b-a3b-q4_K_M',
      classifierModel: 'qwen2.5:3b-instruct-q4_K_M',
      operationalRollbackModel: 'qwen3.6:27b-q4_K_M',
      maxTokens: 2048,
      secretaryMaxTokens: 4096,
      timeoutMs: 200,
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

const runMock = vi.hoisted(() => vi.fn());
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

vi.mock('../../src/services/anthropic', () => ({
  TOOLS: [],
  getClassifierSystemPrompt: () => 'You are a domain classifier.',
  getDomainSystemPrompt: (d: string) => `You are the ${d} agent.`,
  getOllamaClassifierSystemPromptCompact: () => null,
}));

vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
}));

vi.mock('../../src/services/api-usage-fallback', () => ({
  getApiUsageColumns: vi.fn(() => new Set<string>()),
  insertApiUsageFallback: vi.fn(() => 0),
}));

vi.mock('../../src/services/local-llm-rate-limiter', () => ({
  _resetLocalLLMRateLimiterSchemaCacheForTests: vi.fn(),
  checkAndConsumeLocalLLMRateLimit: vi.fn(() => ({ allowed: true })),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { OllamaProvider } from '../../src/services/ollama-provider';
import { resolveKeepAliveForRole } from '../../src/services/chat-core-v2/model-residency-policy';

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

function makeChatResponse(content = 'ok') {
  return new Response(JSON.stringify({
    model: 'qwen3.6:35b-a3b-q4_K_M',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    total_duration: 1_000_000_000,
    load_duration: 100_000_000,
    prompt_eval_count: 10,
    prompt_eval_duration: 500_000_000,
    eval_count: 5,
    eval_duration: 500_000_000,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function makeTagsResponse() {
  return new Response(JSON.stringify({
    models: [{ name: 'qwen3.6:35b-a3b-q4_K_M', digest: 'sha256:abc' }],
  }), { status: 200 });
}

function lastChatRequestBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/chat'));
  expect(call).toBeTruthy();
  const init = call?.[1] as RequestInit | undefined;
  expect(typeof init?.body).toBe('string');
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
  runMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  delete process.env.NODE_APP_INSTANCE;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ChatCoreV2 keep-alive adapter', () => {
  it('maps residency policy roles to Ollama keep_alive seconds', () => {
    expect(resolveKeepAliveForRole('planner_3b')).toBe(-1);
    expect(resolveKeepAliveForRole('escalation_35b')).toBe(300);
    expect(resolveKeepAliveForRole('operational_rollback')).toBe(0);
    expect(resolveKeepAliveForRole('not_a_role')).toBe(-1);
  });

  it('sends task.keepAliveSeconds to Ollama localReason requests', async () => {
    fetchMock
      .mockResolvedValueOnce(makeChatResponse())
      .mockResolvedValueOnce(makeTagsResponse());

    const provider = new OllamaProvider();
    await provider.localReason({
      prompt: 'Summarize keep-alive policy.',
      systemContext: 'You are a test assistant.',
      keepAliveSeconds: 300,
      think: false,
    });

    expect(lastChatRequestBody()).toEqual(expect.objectContaining({
      keep_alive: 300,
      think: false,
    }));
  });

  it('preserves legacy localReason residency when no task override is supplied', async () => {
    fetchMock
      .mockResolvedValueOnce(makeChatResponse())
      .mockResolvedValueOnce(makeTagsResponse());

    const provider = new OllamaProvider();
    await provider.localReason({
      prompt: 'Use the default local reasoning residency.',
      systemContext: 'You are a test assistant.',
      think: false,
    });

    expect(lastChatRequestBody()).toEqual(expect.objectContaining({
      keep_alive: -1,
      think: false,
    }));
  });
});
