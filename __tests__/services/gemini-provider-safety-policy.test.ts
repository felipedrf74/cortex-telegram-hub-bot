/**
 * Gemini provider safety policy (App Review guidelines 1.1 / 1.2).
 *
 * Every `getGenerativeModel` call site used to omit `safetySettings`, so
 * every Gemini call ran at whatever the SDK happened to default to, and a
 * completion the provider blocked came back as an empty string that looked
 * like a successful answer.
 *
 * These tests assert the declared policy reaches the SDK on all five call
 * sites and that a safety `finishReason` produces an explicit signal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: mockGenerateContent };
    constructor(_options: unknown) { /* apiKey asserted by config mock */ }
  },
}));

vi.mock('../../src/services/anthropic', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/anthropic')>('../../src/services/anthropic');
  return {
    ...actual,
    getDomainSystemPrompt: vi.fn().mockReturnValue('You are a helpful coach.'),
    getClassifierSystemPrompt: vi.fn().mockReturnValue('Classify into: secretary, triathlon.'),
    getOllamaClassifierSystemPromptCompact: vi.fn().mockReturnValue(null),
    DOMAIN_SYSTEM_PROMPTS: {},
    buildReplyLanguageInstruction: vi.fn().mockReturnValue(''),
    callDomain: vi.fn(),
    classifyAndExtractImage: vi.fn(),
    classifyMessage: vi.fn(),
    continueWithToolResults: vi.fn(),
    getToolsForDomainCached: vi.fn().mockReturnValue([]),
    resolveReplyLanguage: vi.fn().mockReturnValue('en'),
    TOOLS: [],
  };
});

vi.mock('../../src/config', () => ({
  config: {
    aiSafety: { callTimeoutMs: 5000 },
    gemini: {
      apiKey: 'gemini-test-key',
      model: 'gemini-2.0-pro',
      classifierModel: 'gemini-2.0-flash',
      maxTokens: 1024,
      secretaryMaxTokens: 2048,
    },
    openai: { apiKey: '' },
    anthropic: { apiKey: '' },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/cost-guardrail', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/cost-guardrail')>('../../src/services/cost-guardrail');
  return { ...actual, assertAiBudgetReservationForProvider: vi.fn() };
});

vi.mock('../../src/services/database', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database');
  return {
    ...actual,
    getDb: () => ({ prepare: () => ({ run: vi.fn() }) }),
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
    findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
    assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
    withDatabaseForTestAsync: vi.fn(),
  };
});

vi.mock('../../src/portal/telemetry', async () => {
  const actual = await vi.importActual<typeof import('../../src/portal/telemetry')>('../../src/portal/telemetry');
  return {
    ...actual,
    pushEvent: vi.fn(),
    registerJob: vi.fn(),
    wrapJob: vi.fn((_name: string, fn: unknown) => fn),
    setDbProvider: vi.fn(),
  };
});

const mockGetUserLanguageById = vi.fn<(userId: number) => string>();

vi.mock('../../src/services/user-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service');
  return {
    ...actual,
    getUserLanguageById: (userId: number) => mockGetUserLanguageById(userId),
  };
});

import {
  GEMINI_SAFETY_BLOCK_MESSAGE,
  GEMINI_SAFETY_BLOCK_MESSAGE_PT,
  GEMINI_SAFETY_BLOCK_STOP_REASON,
  GEMINI_SAFETY_SETTINGS,
  GeminiProvider,
  completeOneShot,
  completeOneShotWithFallback,
  completeOneShotWithSearch,
  completeVisionOneShot,
  isGeminiSafetyFinishReason,
  renderGeminiSafetyBlockMessage,
  withGeminiSafetySettings,
} from '../../src/services/gemini-provider';
import { assertAiBudgetReservationForProvider } from '../../src/services/cost-guardrail';
import { computeProviderCallCostUpperBoundUsd } from '../../src/services/model-pricing';

function okResponse(text: string, finishReason = 'STOP') {
  return {
    text,
    functionCalls: [],
    candidates: [{ finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
}

function safetyBlockedResponse(finishReason = 'SAFETY') {
  return {
    text: '',
    functionCalls: [],
    candidates: [{
      finishReason,
      safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', blocked: true }],
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 },
  };
}

function lastConfig(): any {
  return mockGenerateContent.mock.calls.at(-1)?.[0]?.config;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateContent.mockReset();
  mockGetUserLanguageById.mockReset();
  mockGetUserLanguageById.mockReturnValue('en-US');
});

describe('declared safety policy', () => {
  it('declares an explicit threshold for all four harm categories', () => {
    expect(GEMINI_SAFETY_SETTINGS).toHaveLength(4);
    expect(GEMINI_SAFETY_SETTINGS.map((setting) => setting.category).sort()).toEqual([
      'HARM_CATEGORY_DANGEROUS_CONTENT',
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    ]);
    for (const setting of GEMINI_SAFETY_SETTINGS) {
      expect(setting.threshold).toBe('BLOCK_MEDIUM_AND_ABOVE');
    }
  });

  it('merges the policy into a generation config without dropping existing keys', () => {
    expect(withGeminiSafetySettings({ maxOutputTokens: 128 })).toEqual({
      maxOutputTokens: 128,
      safetySettings: GEMINI_SAFETY_SETTINGS,
    });
  });
});

describe('safety settings reach every Gemini call site', () => {
  it('completeOneShot', async () => {
    mockGenerateContent.mockResolvedValue(okResponse('hello'));
    await completeOneShot('sys', 'user', 'test_category');
    expect(lastConfig().safetySettings).toEqual(GEMINI_SAFETY_SETTINGS);
  });

  it('completeOneShot forwards an exact JSON schema and explicit thinking budget', async () => {
    mockGenerateContent.mockResolvedValue(okResponse('{"score":2}'));
    const responseJsonSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['score'],
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 2 },
      },
    };
    const model = 'gemini-2.5-flash-lite';
    const maxTokens = 700;

    await completeOneShot('sys', 'user', 'test_category', {
      model,
      maxTokens,
      temperature: 0,
      jsonMode: true,
      responseJsonSchema,
      thinkingBudget: 0,
    });

    expect(lastConfig()).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema,
      thinkingConfig: {
        includeThoughts: false,
        thinkingBudget: 0,
      },
    });
    expect(assertAiBudgetReservationForProvider).toHaveBeenCalledWith({
      userId: 0,
      category: 'test_category',
      provider: 'gemini',
      model,
      maxCostUsd: computeProviderCallCostUpperBoundUsd({
        provider: 'gemini',
        model,
        payload: {
          systemPrompt: 'sys',
          userPrompt: 'user',
          maxTokens,
          temperature: 0,
          jsonMode: true,
          responseJsonSchema,
          thinkingBudget: 0,
        },
        maxOutputTokens: maxTokens,
      }),
    });
  });

  it('rejects a response schema unless JSON mode is enabled, before calling Gemini', async () => {
    await expect(completeOneShot('sys', 'user', 'test_category', {
      responseJsonSchema: {
        type: 'object',
        properties: { score: { type: 'integer' } },
      },
    })).rejects.toThrow('responseJsonSchema requires jsonMode');

    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('completeOneShotWithSearch', async () => {
    mockGenerateContent.mockResolvedValue(okResponse('grounded'));
    await completeOneShotWithSearch('sys', 'user', 'test_category');
    expect(lastConfig().safetySettings).toEqual(GEMINI_SAFETY_SETTINGS);
  });

  it('completeVisionOneShot', async () => {
    mockGenerateContent.mockResolvedValue(okResponse('{"total":1}'));
    await completeVisionOneShot('sys', 'user', { base64: 'AAA', mimeType: 'image/png' }, 'test_category');
    expect(lastConfig().safetySettings).toEqual(GEMINI_SAFETY_SETTINGS);
  });

  it('callDomain (buildModel)', async () => {
    mockGenerateContent.mockResolvedValue(okResponse('coach answer'));
    await new GeminiProvider().callDomain('triathlon', [], 'what today?', '', { userId: 7, tenantId: 7, filteredTools: [] });
    expect(lastConfig().safetySettings).toEqual(GEMINI_SAFETY_SETTINGS);
  });

  it('classify', async () => {
    mockGenerateContent.mockResolvedValue(okResponse('{"domain":"triathlon","confidence":0.9}'));
    await new GeminiProvider().classify('what should I run today?', undefined, { userId: 7, tenantId: 7 });
    expect(lastConfig().safetySettings).toEqual(GEMINI_SAFETY_SETTINGS);
  });
});

describe('safety finishReason handling', () => {
  it('recognizes the provider block vocabulary', () => {
    expect(isGeminiSafetyFinishReason('SAFETY')).toBe(true);
    expect(isGeminiSafetyFinishReason('prohibited_content')).toBe(true);
    expect(isGeminiSafetyFinishReason('BLOCKLIST')).toBe(true);
    expect(isGeminiSafetyFinishReason('STOP')).toBe(false);
    expect(isGeminiSafetyFinishReason(undefined)).toBe(false);
  });

  it('returns an explanatory answer instead of empty text on the chat path', async () => {
    mockGenerateContent.mockResolvedValue(safetyBlockedResponse('SAFETY'));

    const result = await new GeminiProvider().callDomain(
      'triathlon', [], 'blocked question', '', { userId: 7, tenantId: 7, filteredTools: [] },
    );

    expect(result.text).toBe(GEMINI_SAFETY_BLOCK_MESSAGE);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe(GEMINI_SAFETY_BLOCK_STOP_REASON);
  });

  it('detects a prompt-level block with no candidate at all', async () => {
    mockGenerateContent.mockResolvedValue({
      text: '',
      functionCalls: [],
      candidates: [],
      promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', blocked: true }] },
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 },
    });

    const result = await new GeminiProvider().callDomain(
      'triathlon', [], 'blocked prompt', '', { userId: 7, tenantId: 7, filteredTools: [] },
    );

    expect(result.stopReason).toBe(GEMINI_SAFETY_BLOCK_STOP_REASON);
  });

  it('throws a mapped non-retryable error from the one-shot path', async () => {
    mockGenerateContent.mockResolvedValue(safetyBlockedResponse('PROHIBITED_CONTENT'));

    await expect(completeOneShot('sys', 'user', 'test_category')).rejects.toMatchObject({
      provider: 'gemini',
      code: 'AI_SAFETY_BLOCKED',
      finishReason: 'PROHIBITED_CONTENT',
      safetyBlocked: true,
      retryable: false,
    });
  });

  it('leaves an ordinary STOP response alone', async () => {
    mockGenerateContent.mockResolvedValue(okResponse('normal answer'));

    const result = await new GeminiProvider().callDomain(
      'triathlon', [], 'normal question', '', { userId: 7, tenantId: 7, filteredTools: [] },
    );

    expect(result.text).toBe('normal answer');
    expect(result.stopReason).toBe('STOP');
  });
});

// ═══════════════════════════════════════════════════════════════════
// A safety block is a decision, not an outage. Cascading it through the
// fallback chain would re-ask the same blocked prompt on the Gemini
// fallback model, then OpenAI, then Anthropic — none of which detect a
// peer provider's refusal — so the block would prevent nothing and cost
// three extra paid calls.
// ═══════════════════════════════════════════════════════════════════

describe('a provider safety block does not cascade to other providers', () => {
  it('rethrows from completeOneShotWithFallback without trying any fallback', async () => {
    mockGenerateContent.mockResolvedValue(safetyBlockedResponse('SAFETY'));
    const anthropicFallback = vi.fn(async () => 'anthropic text');

    await expect(completeOneShotWithFallback(
      'sys', 'user', 'test_category', anthropicFallback,
    )).rejects.toMatchObject({
      provider: 'gemini',
      code: 'AI_SAFETY_BLOCKED',
      safetyBlocked: true,
      retryable: false,
    });

    // Exactly one provider call: no Gemini fallback model hop, and the
    // Anthropic thunk is never reached.
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect(anthropicFallback).not.toHaveBeenCalled();
  });

  it('still cascades to the Gemini fallback model on an ordinary failure', async () => {
    mockGenerateContent
      .mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }))
      .mockResolvedValueOnce(okResponse('fallback model text'));
    const anthropicFallback = vi.fn(async () => 'anthropic text');

    const result = await completeOneShotWithFallback(
      'sys', 'user', 'test_category', anthropicFallback,
    );

    expect(result).toEqual({ text: 'fallback model text', provider: 'gemini' });
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-2.0-pro');
    expect(mockGenerateContent.mock.calls[1][0].model).toBe('gemini-2.0-flash');
  });
});

// ═══════════════════════════════════════════════════════════════════
// The refusal text IS the answer the user reads — nothing downstream
// re-renders it — and the app ships EN, pt-PT and pt-BR.
// ═══════════════════════════════════════════════════════════════════

describe('safety refusal copy is localized', () => {
  it('renders both locales', () => {
    expect(renderGeminiSafetyBlockMessage('en')).toBe(GEMINI_SAFETY_BLOCK_MESSAGE);
    expect(renderGeminiSafetyBlockMessage('pt')).toBe(GEMINI_SAFETY_BLOCK_MESSAGE_PT);
    expect(GEMINI_SAFETY_BLOCK_MESSAGE_PT).not.toBe(GEMINI_SAFETY_BLOCK_MESSAGE);
  });

  it('returns the Portuguese refusal to a pt user on the chat path', async () => {
    mockGetUserLanguageById.mockReturnValue('pt-PT');
    mockGenerateContent.mockResolvedValue(safetyBlockedResponse('SAFETY'));

    const result = await new GeminiProvider().callDomain(
      'triathlon', [], 'pergunta bloqueada', '', { userId: 7, tenantId: 7, filteredTools: [] },
    );

    expect(result.text).toBe(GEMINI_SAFETY_BLOCK_MESSAGE_PT);
    expect(mockGetUserLanguageById).toHaveBeenCalledWith(7);
  });

  it('falls back to English when the language lookup throws', async () => {
    mockGetUserLanguageById.mockImplementation(() => { throw new Error('db down'); });
    mockGenerateContent.mockResolvedValue(safetyBlockedResponse('SAFETY'));

    const result = await new GeminiProvider().callDomain(
      'triathlon', [], 'blocked question', '', { userId: 7, tenantId: 7, filteredTools: [] },
    );

    expect(result.text).toBe(GEMINI_SAFETY_BLOCK_MESSAGE);
  });
});
