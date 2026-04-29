/**
 * Gemini Provider Tests
 *
 * Tests the GeminiProvider adapter: classify, callDomain, continueWithToolResults,
 * plus token tracking, cost calculation, error handling with retry, error mapping
 * for FallbackProvider, and format edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Gemini SDK ────────────────────────────────────────────────

const mockGenerateContent = vi.fn();
// Spy on getGenerativeModel so tests can assert on the model name and
// tool list passed in (Layer 4 + Layer 3 verification).
const mockGetGenerativeModel = vi.fn();

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel(...args: unknown[]) {
        mockGetGenerativeModel(...args);
        return { generateContent: mockGenerateContent };
      }
    },
    SchemaType: {
      STRING: 'STRING',
      NUMBER: 'NUMBER',
      INTEGER: 'INTEGER',
      BOOLEAN: 'BOOLEAN',
      ARRAY: 'ARRAY',
      OBJECT: 'OBJECT',
    },
    FunctionCallingMode: { AUTO: 'AUTO' },
  };
});

vi.mock('../../src/services/anthropic', () => ({
  getDomainSystemPrompt: vi.fn().mockReturnValue('You are a helpful secretary.'),
  getClassifierSystemPrompt: vi.fn().mockReturnValue('Classify into: secretary, triathlon, content.'),
  TOOLS: [
    { name: 'set_reminder', description: 'Set a reminder', input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  ],
}));

vi.mock('../../src/config', () => ({
  config: {
    gemini: {
      apiKey: 'gemini-test-key',
      model: 'gemini-2.0-pro',
      classifierModel: 'gemini-2.0-flash',
      maxTokens: 1024,
      secretaryMaxTokens: 2048,
    },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

// ─── Mock database and telemetry ────────────────────────────────────

const mockDbRun = vi.fn();
vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({ run: mockDbRun }),
  }),
}));

vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────

import { GeminiProvider, _sleep } from '../../src/services/gemini-provider';
import { pushEvent } from '../../src/portal/telemetry';

const mockPushEvent = vi.mocked(pushEvent);

// Override sleep to avoid real setTimeout in retry tests
const _origSleep = _sleep.fn;
beforeEach(() => { _sleep.fn = () => Promise.resolve(); });
afterEach(() => { _sleep.fn = _origSleep; });

// ─── Helpers ─────────────────────────────────────────────────────────

function mockGeminiResponse(text: string, functionCalls?: any[], finishReason = 'STOP') {
  mockGenerateContent.mockResolvedValue({
    response: {
      text: () => text,
      functionCalls: () => functionCalls || [],
      candidates: [{ finishReason }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
      },
    },
  });
}

function mockGeminiResponseNoText(functionCalls: any[], finishReason = 'STOP') {
  mockGenerateContent.mockResolvedValue({
    response: {
      text: () => { throw new Error('No text parts'); },
      functionCalls: () => functionCalls,
      candidates: [{ finishReason }],
      usageMetadata: {
        promptTokenCount: 80,
        candidatesTokenCount: 30,
        totalTokenCount: 110,
      },
    },
  });
}

function mockGeminiResponseWithUsage(text: string, promptTokens: number, completionTokens: number) {
  mockGenerateContent.mockResolvedValue({
    response: {
      text: () => text,
      functionCalls: () => [],
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: promptTokens,
        candidatesTokenCount: completionTokens,
        totalTokenCount: promptTokens + completionTokens,
      },
    },
  });
}

// ═══════════════════════════════════════════════════════════════════

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiProvider();
  });

  it('has name "gemini"', () => {
    expect(provider.name).toBe('gemini');
  });

  // ── classify ──────────────────────────────────────────────────────

  describe('classify', () => {
    it('returns domain and confidence from model response', async () => {
      mockGeminiResponse('{"domain":"triathlon","confidence":0.9}');

      const result = await provider.classify('How was my swim?');
      expect(result).toEqual({ domain: 'triathlon', confidence: 0.9 });
    });

    it('strips markdown code fences', async () => {
      mockGeminiResponse('```json\n{"domain":"content","confidence":0.85}\n```');

      const result = await provider.classify('Write a hook');
      expect(result).toEqual({ domain: 'content', confidence: 0.85 });
    });

    it('defaults to secretary on low confidence', async () => {
      mockGeminiResponse('{"domain":"triathlon","confidence":0.4}');

      const result = await provider.classify('maybe');
      expect(result).toEqual({ domain: 'secretary', confidence: 0.4 });
    });

    it('passes active context to prompt', async () => {
      mockGeminiResponse('{"domain":"secretary","confidence":0.9}');

      await provider.classify('make it weekly', {
        domain: 'secretary',
        lastAssistantMessage: 'Reminder set for tomorrow.',
      });

      const call = mockGenerateContent.mock.calls[0][0];
      const userMsg = typeof call === 'string' ? call : JSON.stringify(call);
      expect(userMsg).toContain('ACTIVE CONVERSATION');
    });

    it('defaults to secretary on error', async () => {
      const error = Object.assign(new Error('Quota exceeded'), { status: 400 });
      mockGenerateContent.mockRejectedValue(error);

      const result = await provider.classify('hello');
      expect(result).toEqual({ domain: 'secretary', confidence: 0 });
    });
  });

  // ── callDomain ────────────────────────────────────────────────────

  describe('callDomain', () => {
    it('returns text response when no function calls', async () => {
      mockGeminiResponse('You have a race in 3 weeks.');

      const result = await provider.callDomain('triathlon', [], 'When is my race?', '');
      expect(result.text).toBe('You have a race in 3 weeks.');
      expect(result.toolCalls).toEqual([]);
    });

    it('extracts function calls from response', async () => {
      mockGeminiResponseNoText([
        { name: 'set_reminder', args: { message: 'Call coach' } },
      ]);

      const result = await provider.callDomain('secretary', [], 'Remind me to call coach', '');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('set_reminder');
      expect(result.toolCalls[0].input).toEqual({ message: 'Call coach' });
      expect(result.toolCalls[0].type).toBe('tool_use');
      expect(result.toolCalls[0].id).toMatch(/^gemini_tc_/);
    });

    it('returns empty text when response has no text parts', async () => {
      mockGeminiResponseNoText([
        { name: 'set_reminder', args: { message: 'Test' } },
      ]);

      const result = await provider.callDomain('secretary', [], 'Remind me', '');
      expect(result.text).toBe('');
    });

    it('passes maxTokensOverride', async () => {
      mockGeminiResponse('Long output.');

      await provider.callDomain('content', [], 'Full script', '', 4096);
      expect(mockGenerateContent).toHaveBeenCalledOnce();
    });

    it('routes secretary through expensive model path', async () => {
      mockGeminiResponse('Tasks checked.');
      await provider.callDomain('secretary', [], 'Check tasks', '');
      expect(mockGenerateContent).toHaveBeenCalledOnce();
    });

    it('routes triathlon through cheap model path', async () => {
      mockGeminiResponse('Great swim.');
      await provider.callDomain('triathlon', [], 'How was my swim?', '');
      expect(mockGenerateContent).toHaveBeenCalledOnce();
    });

    // ─── TASK-17 Option B: tier-aware model + filtered tools ──────
    //
    // Verifies that GeminiProvider honors the CallDomainOptions bag
    // computed by TaskRoutingProvider's planSecretaryOptimization()
    // helper. This is what makes Layers 3, 4, and 5 actually fire
    // for Gemini in production (instead of running silently on the
    // Anthropic-only fallback path).

    describe('TASK-17: respects CallDomainOptions from routing layer', () => {
      it('modelTier="light" → uses classifierModel (Haiku-equivalent)', async () => {
        mockGeminiResponse('OK');
        mockGetGenerativeModel.mockClear();

        await provider.callDomain('secretary', [], 'show my tasks', '', {
          modelTier: 'light',
          filteredTools: [],
        });

        expect(mockGetGenerativeModel).toHaveBeenCalledTimes(1);
        const args = mockGetGenerativeModel.mock.calls[0][0];
        // Light tier maps to gemini.classifierModel from the mocked config
        expect(args.model).toBe('gemini-2.0-flash');
      });

      it('modelTier="heavy" → uses gemini.model', async () => {
        mockGeminiResponse('OK');
        mockGetGenerativeModel.mockClear();

        await provider.callDomain('secretary', [], 'plan my week', '', {
          modelTier: 'heavy',
          filteredTools: [],
        });

        expect(mockGetGenerativeModel).toHaveBeenCalledTimes(1);
        const args = mockGetGenerativeModel.mock.calls[0][0];
        expect(args.model).toBe('gemini-2.0-pro');
      });

      it('no modelTier → falls back to legacy per-domain default (gemini-2.0-pro for secretary)', async () => {
        mockGeminiResponse('OK');
        mockGetGenerativeModel.mockClear();

        // No options passed at all — old call style
        await provider.callDomain('secretary', [], 'do something', '');

        const args = mockGetGenerativeModel.mock.calls[0][0];
        // Legacy fallback uses getModelRouting() which returns the
        // per-domain default — gemini.model for secretary
        expect(args.model).toBe('gemini-2.0-pro');
      });

      it('filteredTools narrows the function declarations sent to Gemini', async () => {
        mockGeminiResponse('OK');
        mockGetGenerativeModel.mockClear();

        const filteredTools = [
          { name: 'set_reminder', description: 'Set a reminder', input_schema: { type: 'object', properties: {} } },
        ];

        await provider.callDomain('secretary', [], 'remind me at 3pm', '', {
          modelTier: 'light',
          filteredTools,
        });

        const args = mockGetGenerativeModel.mock.calls[0][0];
        // The functionDeclarations should match the filtered set, not
        // the full TOOLS array
        const declarations = args.tools[0].functionDeclarations;
        expect(declarations).toHaveLength(1);
        expect(declarations[0].name).toBe('set_reminder');
      });

      it('continueWithToolResults: same tier + tools as the initial call', async () => {
        mockGeminiResponse('Continued.');
        mockGetGenerativeModel.mockClear();

        const filteredTools = [
          { name: 'set_reminder', description: 'Set a reminder', input_schema: { type: 'object', properties: {} } },
        ];

        await provider.continueWithToolResults(
          'secretary',
          [],
          'remind me at 3pm',
          '',
          [],
          { modelTier: 'light', filteredTools },
        );

        const args = mockGetGenerativeModel.mock.calls[0][0];
        expect(args.model).toBe('gemini-2.0-flash');
        expect(args.tools[0].functionDeclarations).toHaveLength(1);
      });
    });
  });

  // ── continueWithToolResults ───────────────────────────────────────

  describe('continueWithToolResults', () => {
    it('converts tool conversation to Gemini format and returns response', async () => {
      mockGeminiResponse('Reminder set for tomorrow.');

      const toolConvo = [
        {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use', id: 'tc_1', name: 'set_reminder', input: { message: 'Dentist' } },
          ],
        },
        {
          role: 'user' as const,
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: '{"id":1}' },
          ],
        },
      ];

      const result = await provider.continueWithToolResults(
        'secretary', [], 'Set reminder', '', toolConvo,
      );
      expect(result.text).toBe('Reminder set for tomorrow.');

      const callArg = mockGenerateContent.mock.calls[0][0];
      const contents = callArg.contents;

      const modelMsg = contents.find((c: any) =>
        c.role === 'model' && c.parts.some((p: any) => p.functionCall),
      );
      expect(modelMsg).toBeDefined();

      const responseMsg = contents.find((c: any) =>
        c.role === 'user' && c.parts.some((p: any) => p.functionResponse),
      );
      expect(responseMsg).toBeDefined();
    });
  });

  // ── Token usage tracking ──────────────────────────────────────────

  describe('token usage tracking', () => {
    // April 9 2026: the api_usage INSERT now includes `user_id` at
    // position 2 (between `model` and `input_tokens`). Position shift:
    //   Old: (category, model, input_tokens, output_tokens, cost, duration)
      //   New: (category, model, tenant_id, user_id, input_tokens, output_tokens, cost, duration)
    // All three tests in this describe block updated to match the new
    // shape. When the caller doesn't pass a userId, we expect 0 (the
    // default fallback baked into logGeminiUsage).

    it('logs to api_usage table after classify', async () => {
      mockGeminiResponse('{"domain":"secretary","confidence":0.9}');

      await provider.classify('hello');

      expect(mockDbRun).toHaveBeenCalledWith(
        'gemini_classify',
        'gemini-2.0-flash',
        0, // tenant_id — classifier calls don't carry a tenant
        0, // user_id — classifier calls don't carry a user
        100,
        50,
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('logs to api_usage table after callDomain with correct category', async () => {
      mockGeminiResponse('Tasks done.');

      await provider.callDomain('secretary', [], 'check tasks', '');

      expect(mockDbRun).toHaveBeenCalledWith(
        'gemini_domain_secretary',
        expect.any(String),
        0, // tenant_id — callDomain in this test doesn't pass a tenant
        0, // user_id — callDomain in this test doesn't pass a user
        100,
        50,
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('pushes telemetry event', async () => {
      mockGeminiResponse('ok');

      await provider.callDomain('content', [], 'test', '');

      expect(mockPushEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'api_call',
          summary: expect.stringContaining('Gemini'),
        }),
      );
    });

    it('computes cost correctly for gemini-2.0-flash', async () => {
      mockGeminiResponseWithUsage('ok', 1000000, 0);

      await provider.classify('hello');

      // gemini-2.0-flash: 1M input × $0.10/MTK = $0.10
      // Column positions: 0=category, 1=model, 2=tenant_id, 3=user_id,
      // 4=input, 5=output, 6=cost, 7=duration.
      const costArg = mockDbRun.mock.calls[0]?.[6];
      expect(costArg).toBeCloseTo(0.10, 2);
    });

    it('handles missing usageMetadata gracefully', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => '{"domain":"secretary","confidence":0.9}',
          functionCalls: () => [],
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: undefined,
        },
      });

      const result = await provider.classify('hello');
      expect(result.domain).toBe('secretary');
      // No crash, no DB call
      expect(mockDbRun).not.toHaveBeenCalled();
    });

    it('continues normally if database write fails', async () => {
      mockDbRun.mockImplementationOnce(() => { throw new Error('DB error'); });
      mockGeminiResponse('works');

      const result = await provider.callDomain('content', [], 'test', '');
      expect(result.text).toBe('works');
    });
  });

  // ── Error handling and retry ──────────────────────────────────────

  describe('error handling and retry', () => {
    it('retries on 429 RESOURCE_EXHAUSTED', async () => {
      const error429 = Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
      mockGenerateContent
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({
          response: {
            text: () => 'Recovered',
            functionCalls: () => [],
            candidates: [{ finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 },
          },
        });

      const result = await provider.callDomain('secretary', [], 'hello', '');
      expect(result.text).toBe('Recovered');
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('retries on 503 UNAVAILABLE', async () => {
      const error503 = Object.assign(new Error('UNAVAILABLE'), { status: 503 });
      mockGenerateContent
        .mockRejectedValueOnce(error503)
        .mockResolvedValueOnce({
          response: {
            text: () => 'Back',
            functionCalls: () => [],
            candidates: [{ finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, totalTokenCount: 50 },
          },
        });

      const result = await provider.callDomain('content', [], 'test', '');
      expect(result.text).toBe('Back');
    });

    it('does NOT retry on 400 bad request', async () => {
      const error400 = Object.assign(new Error('Bad request'), { status: 400 });
      mockGenerateContent.mockRejectedValue(error400);

      await expect(provider.callDomain('content', [], 'test', '')).rejects.toThrow('Gemini API error');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('throws mapped error with provider/status/retryable after max retries', async () => {
      const error503 = Object.assign(new Error('UNAVAILABLE'), { status: 503 });
      mockGenerateContent.mockRejectedValue(error503);

      await expect(provider.callDomain('secretary', [], 'hello', ''))
        .rejects.toMatchObject({
          message: expect.stringContaining('Gemini API error'),
          provider: 'gemini',
          status: 503,
          retryable: true,
        });
    });

    it('classify returns secretary fallback after all retries exhausted', async () => {
      const error429 = Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
      mockGenerateContent.mockRejectedValue(error429);

      const result = await provider.classify('hello');
      expect(result).toEqual({ domain: 'secretary', confidence: 0 });
    });
  });

  // ── Format mapping edge cases ─────────────────────────────────────

  describe('format mapping edge cases', () => {
    it('handles plain string assistant messages in toolConversation', async () => {
      mockGeminiResponse('Done.');

      const toolConvo = [
        { role: 'assistant' as const, content: 'Let me think about that...' },
        {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use', id: 'tc_x', name: 'set_reminder', input: { message: 'test' } },
          ],
        },
        {
          role: 'user' as const,
          content: [
            { type: 'tool_result', tool_use_id: 'tc_x', content: '{"ok":true}' },
          ],
        },
      ];

      const result = await provider.continueWithToolResults('secretary', [], 'do it', '', toolConvo);
      expect(result.text).toBe('Done.');

      // Verify the plain text assistant message was included as model role
      const contents = mockGenerateContent.mock.calls[0][0].contents;
      const plainModelMsg = contents.find((c: any) =>
        c.role === 'model' && c.parts.some((p: any) => p.text === 'Let me think about that...'),
      );
      expect(plainModelMsg).toBeDefined();
    });

    it('maps tool_use_id to correct function name in functionResponse', async () => {
      mockGeminiResponse('Reminder set.');

      const toolConvo = [
        {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use', id: 'tc_42', name: 'set_reminder', input: { message: 'Test' } },
          ],
        },
        {
          role: 'user' as const,
          content: [
            { type: 'tool_result', tool_use_id: 'tc_42', content: '{"id":1}' },
          ],
        },
      ];

      await provider.continueWithToolResults('secretary', [], 'remind', '', toolConvo);

      const contents = mockGenerateContent.mock.calls[0][0].contents;
      const responseMsg = contents.find((c: any) =>
        c.role === 'user' && c.parts.some((p: any) => p.functionResponse),
      );
      // Should use the function name 'set_reminder', not the tool_use_id 'tc_42'
      expect(responseMsg.parts[0].functionResponse.name).toBe('set_reminder');
    });

    it('handles missing function args (uses empty object)', async () => {
      mockGeminiResponseNoText([
        { name: 'get_todos', args: undefined },
      ]);

      const result = await provider.callDomain('secretary', [], 'show todos', '');
      expect(result.toolCalls[0].input).toEqual({});
    });

    it('handles malformed tool_result content via safeParse', async () => {
      mockGeminiResponse('OK');

      const toolConvo = [
        {
          role: 'assistant' as const,
          content: [
            { type: 'tool_use', id: 'tc_1', name: 'set_reminder', input: {} },
          ],
        },
        {
          role: 'user' as const,
          content: [
            { type: 'tool_result', tool_use_id: 'tc_1', content: 'not valid json at all' },
          ],
        },
      ];

      await provider.continueWithToolResults('secretary', [], 'test', '', toolConvo);

      const contents = mockGenerateContent.mock.calls[0][0].contents;
      const responseMsg = contents.find((c: any) =>
        c.role === 'user' && c.parts.some((p: any) => p.functionResponse),
      );
      // safeParse wraps non-JSON in { result: ... }
      expect(responseMsg.parts[0].functionResponse.response).toEqual({ result: 'not valid json at all' });
    });

    it('generates deterministic tool call IDs (counter-based)', async () => {
      mockGeminiResponseNoText([{ name: 'set_reminder', args: { message: 'A' } }]);
      const r1 = await provider.callDomain('secretary', [], 'first', '');
      const id1 = r1.toolCalls[0].id;

      mockGeminiResponseNoText([{ name: 'set_reminder', args: { message: 'B' } }]);
      const r2 = await provider.callDomain('secretary', [], 'second', '');
      const id2 = r2.toolCalls[0].id;

      // Counter-based: sequential, not Date.now-based
      expect(id1).toMatch(/^gemini_tc_\d+$/);
      expect(id2).toMatch(/^gemini_tc_\d+$/);
      // IDs should be different and sequential
      const num1 = parseInt(id1.replace('gemini_tc_', ''));
      const num2 = parseInt(id2.replace('gemini_tc_', ''));
      expect(num2).toBe(num1 + 1);
    });
  });
});
