/**
 * OpenAI Provider Tests
 *
 * Tests the OpenAIProvider adapter: classify, callDomain, continueWithToolResults.
 * The OpenAI SDK is fully mocked — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock OpenAI SDK ────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class OpenAI {
      chat = { completions: { create: mockCreate } };
    },
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
    openai: { apiKey: 'sk-test-key', model: 'gpt-4o', classifierModel: 'gpt-4o-mini' },
    anthropic: { maxTokens: 1024 },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────

import { OpenAIProvider } from '../../src/services/openai-provider';

// ─── Helpers ─────────────────────────────────────────────────────────

function mockChatResponse(content: string, toolCalls?: any[], finishReason = 'stop') {
  mockCreate.mockResolvedValue({
    choices: [{
      message: {
        content,
        tool_calls: toolCalls || null,
      },
      finish_reason: finishReason,
    }],
  });
}

// ═══════════════════════════════════════════════════════════════════

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider();
  });

  it('has name "openai"', () => {
    expect(provider.name).toBe('openai');
  });

  // ── classify ──────────────────────────────────────────────────────

  describe('classify', () => {
    it('returns domain and confidence from model response', async () => {
      mockChatResponse('{"domain":"triathlon","confidence":0.95}');

      const result = await provider.classify('How was my run?');
      expect(result).toEqual({ domain: 'triathlon', confidence: 0.95 });
    });

    it('strips markdown code fences from response', async () => {
      mockChatResponse('```json\n{"domain":"secretary","confidence":0.9}\n```');

      const result = await provider.classify('Check my email');
      expect(result).toEqual({ domain: 'secretary', confidence: 0.9 });
    });

    it('defaults to secretary with confidence 0 on low confidence', async () => {
      mockChatResponse('{"domain":"content","confidence":0.3}');

      const result = await provider.classify('hmm');
      expect(result).toEqual({ domain: 'secretary', confidence: 0.3 });
    });

    it('passes active context to the classifier prompt', async () => {
      mockChatResponse('{"domain":"secretary","confidence":0.85}');

      await provider.classify('make it weekly', {
        domain: 'secretary',
        lastAssistantMessage: 'I set a reminder for tomorrow.',
      });

      const call = mockCreate.mock.calls[0][0];
      expect(call.messages[1].content).toContain('ACTIVE CONVERSATION');
      expect(call.messages[1].content).toContain('secretary');
    });

    it('defaults to secretary on parse error', async () => {
      mockChatResponse('not valid json at all');

      const result = await provider.classify('???');
      expect(result).toEqual({ domain: 'secretary', confidence: 0 });
    });

    it('defaults to secretary on API error', async () => {
      mockCreate.mockRejectedValue(new Error('Rate limited'));

      const result = await provider.classify('hello');
      expect(result).toEqual({ domain: 'secretary', confidence: 0 });
    });
  });

  // ── callDomain ────────────────────────────────────────────────────

  describe('callDomain', () => {
    it('returns text response when no tool calls', async () => {
      mockChatResponse('You have 3 tasks today.');

      const result = await provider.callDomain('secretary', [], 'What do I have today?', 'Today: Monday');
      expect(result.text).toBe('You have 3 tasks today.');
      expect(result.toolCalls).toEqual([]);
      expect(result.stopReason).toBe('stop');
    });

    it('passes tools for secretary and triathlon domains', async () => {
      mockChatResponse('OK');

      await provider.callDomain('secretary', [], 'Check tasks', '');
      expect(mockCreate.mock.calls[0][0].tools).toBeDefined();
      expect(mockCreate.mock.calls[0][0].tools[0].type).toBe('function');
      expect(mockCreate.mock.calls[0][0].tools[0].function.name).toBe('set_reminder');
    });

    it('does NOT pass tools for content domain', async () => {
      mockChatResponse('Here is a script.');

      await provider.callDomain('content', [], 'Write a hook', '');
      expect(mockCreate.mock.calls[0][0].tools).toBeUndefined();
    });

    it('extracts tool calls from response', async () => {
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: {
                name: 'set_reminder',
                arguments: '{"message":"Call dentist"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      });

      const result = await provider.callDomain('secretary', [], 'Remind me to call dentist', '');
      expect(result.toolCalls).toEqual([{
        type: 'tool_use',
        id: 'call_abc',
        name: 'set_reminder',
        input: { message: 'Call dentist' },
      }]);
    });

    it('passes maxTokensOverride', async () => {
      mockChatResponse('Long response.');

      await provider.callDomain('content', [], 'Full script', '', 4096);
      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(4096);
    });

    it('includes conversation history', async () => {
      mockChatResponse('Noted.');

      await provider.callDomain('secretary', [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ], 'Check tasks', '');

      const messages = mockCreate.mock.calls[0][0].messages;
      // system + 2 history + 1 current = 4
      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe('system');
      expect(messages[1].content).toBe('Hi');
      expect(messages[2].content).toBe('Hello!');
    });

    it('prepends state context to current message', async () => {
      mockChatResponse('OK');

      await provider.callDomain('secretary', [], 'Check tasks', 'Today: Monday');
      const lastMsg = mockCreate.mock.calls[0][0].messages.slice(-1)[0];
      expect(lastMsg.content).toContain('[Current State]');
      expect(lastMsg.content).toContain('Today: Monday');
    });
  });

  // ── continueWithToolResults ───────────────────────────────────────

  describe('continueWithToolResults', () => {
    it('converts tool conversation to OpenAI format', async () => {
      mockChatResponse('Reminder set.');

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
      expect(result.text).toBe('Reminder set.');

      const messages = mockCreate.mock.calls[0][0].messages;
      // system + current msg + assistant (tool_calls) + tool result
      const assistantMsg = messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.tool_calls[0].function.name).toBe('set_reminder');

      const toolMsg = messages.find((m: any) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg.tool_call_id).toBe('tc_1');
    });
  });
});
