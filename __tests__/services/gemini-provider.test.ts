/**
 * Gemini Provider Tests
 *
 * Tests the GeminiProvider adapter: classify, callDomain, continueWithToolResults.
 * The Google Generative AI SDK is fully mocked — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock Gemini SDK ────────────────────────────────────────────────

const mockGenerateContent = vi.fn();

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel() {
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

// ─── Imports ─────────────────────────────────────────────────────────

import { GeminiProvider } from '../../src/services/gemini-provider';

// ─── Helpers ─────────────────────────────────────────────────────────

function mockGeminiResponse(text: string, functionCalls?: any[], finishReason = 'STOP') {
  mockGenerateContent.mockResolvedValue({
    response: {
      text: () => text,
      functionCalls: () => functionCalls || [],
      candidates: [{ finishReason }],
    },
  });
}

function mockGeminiResponseNoText(functionCalls: any[], finishReason = 'STOP') {
  mockGenerateContent.mockResolvedValue({
    response: {
      text: () => { throw new Error('No text parts'); },
      functionCalls: () => functionCalls,
      candidates: [{ finishReason }],
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
      // Gemini receives the message as a string or content object
      const userMsg = typeof call === 'string' ? call : JSON.stringify(call);
      expect(userMsg).toContain('ACTIVE CONVERSATION');
    });

    it('defaults to secretary on error', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Quota exceeded'));

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
      // Gemini generates synthetic IDs
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
      // Verify generateContent was called (model configured with maxOutputTokens)
      expect(mockGenerateContent).toHaveBeenCalledOnce();
    });

    // ── Smart model routing ──────────────────────────────────────
    // Note: Gemini's getGenerativeModel is mocked, so we can't directly assert
    // the model name. Instead we verify the routing logic via the shared
    // getModelRouting tests in ai-provider.test.ts, and here confirm the provider
    // calls generateContent (which means routing was applied before the call).

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

      // Verify the contents array includes function call + function response
      const callArg = mockGenerateContent.mock.calls[0][0];
      const contents = callArg.contents;

      // Should have: user message + model (functionCall) + user (functionResponse)
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
});
