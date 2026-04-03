/**
 * OpenAI Provider Tests
 *
 * Tests the OpenAIProvider adapter: classify, callDomain, continueWithToolResults,
 * plus token tracking, cost calculation, error handling with retry, and message
 * format mapping between Anthropic and OpenAI formats.
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
    openai: {
      apiKey: 'sk-test-key',
      model: 'gpt-4o',
      classifierModel: 'gpt-4o-mini',
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

// ─── Mock database and telemetry for token tracking ─────────────────

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

import { OpenAIProvider, _sleep } from '../../src/services/openai-provider';
import { pushEvent } from '../../src/portal/telemetry';

const mockPushEvent = vi.mocked(pushEvent);

// Override sleep to avoid real setTimeout in retry tests
const _origSleep = _sleep.fn;
beforeEach(() => { _sleep.fn = () => Promise.resolve(); });
afterEach(() => { _sleep.fn = _origSleep; });

// ─── Helpers ─────────────────────────────────────────────────────────

function mockChatResponse(content: string, toolCalls?: any[], finishReason = 'stop', usage?: any) {
  mockCreate.mockResolvedValue({
    choices: [{
      message: {
        content,
        tool_calls: toolCalls || null,
      },
      finish_reason: finishReason,
    }],
    usage: usage ?? { prompt_tokens: 100, completion_tokens: 50 },
    model: 'gpt-4o',
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
        usage: { prompt_tokens: 100, completion_tokens: 30 },
        model: 'gpt-4o',
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

    // ── Smart model routing ──────────────────────────────────────

    it('uses expensive model (gpt-4o) + 2048 tokens for secretary', async () => {
      mockChatResponse('OK');
      await provider.callDomain('secretary', [], 'Check tasks', '');
      expect(mockCreate.mock.calls[0][0].model).toBe('gpt-4o');
      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(2048);
    });

    it('uses cheap model (gpt-4o-mini) + 2048 tokens for triathlon', async () => {
      mockChatResponse('OK');
      await provider.callDomain('triathlon', [], 'My run', '');
      expect(mockCreate.mock.calls[0][0].model).toBe('gpt-4o-mini');
      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(2048);
    });

    it('uses cheap model (gpt-4o-mini) + 1024 tokens for content', async () => {
      mockChatResponse('Here is a hook.');
      await provider.callDomain('content', [], 'Write a hook', '');
      expect(mockCreate.mock.calls[0][0].model).toBe('gpt-4o-mini');
      expect(mockCreate.mock.calls[0][0].max_tokens).toBe(1024);
    });

    it('includes conversation history', async () => {
      mockChatResponse('Noted.');

      await provider.callDomain('secretary', [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ], 'Check tasks', '');

      const messages = mockCreate.mock.calls[0][0].messages;
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
      const assistantMsg = messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg.tool_calls[0].function.name).toBe('set_reminder');

      const toolMsg = messages.find((m: any) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg.tool_call_id).toBe('tc_1');
    });
  });

  // ── Token tracking ────────────────────────────────────────────────

  describe('token tracking', () => {
    it('records usage to api_usage table after successful call', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 150, completion_tokens: 50 },
      });

      await provider.callDomain('secretary', [], 'hi', '');

      expect(mockDbRun).toHaveBeenCalledWith(
        'openai_domain_secretary',
        'gpt-4o',
        150,
        50,
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('pushes telemetry event after successful call', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });

      await provider.callDomain('content', [], 'test', '');

      expect(mockPushEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'api_call',
          summary: expect.stringContaining('OpenAI gpt-4o'),
        }),
      );
    });

    it('calculates cost correctly for gpt-4o-mini', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: '{"domain":"secretary","confidence":0.9}' }, finish_reason: 'stop' }],
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 1000000, completion_tokens: 0 },
      });

      await provider.classify('hello');

      // gpt-4o-mini: 1M input tokens × $0.15/MTK = $0.15
      const costArg = mockDbRun.mock.calls[0]?.[4];
      expect(costArg).toBeCloseTo(0.15, 2);
    });

    it('calculates cost correctly for gpt-4o', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 1000000, completion_tokens: 1000000 },
      });

      await provider.callDomain('secretary', [], 'test', '');

      // gpt-4o: 1M in × $2.50 + 1M out × $10.00 = $12.50
      const costArg = mockDbRun.mock.calls[0]?.[4];
      expect(costArg).toBeCloseTo(12.50, 2);
    });

    it('uses openai_classify category for classify calls', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: '{"domain":"secretary","confidence":0.9}' }, finish_reason: 'stop' }],
        model: 'gpt-4o-mini',
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });

      await provider.classify('hello');
      expect(mockDbRun).toHaveBeenCalledWith(
        'openai_classify',
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('uses openai_tool_continuation category for tool result calls', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 200, completion_tokens: 30 },
      });

      await provider.continueWithToolResults('secretary', [], 'test', '', []);
      expect(mockDbRun).toHaveBeenCalledWith(
        'openai_tool_continuation',
        expect.any(String),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('continues normally if database write fails', async () => {
      mockDbRun.mockImplementationOnce(() => { throw new Error('DB error'); });
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'works' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });

      const result = await provider.callDomain('content', [], 'test', '');
      expect(result.text).toBe('works');
    });
  });

  // ── Error handling and retry ──────────────────────────────────────

  describe('error handling', () => {
    it('retries on 429 rate limit', async () => {
      const error429 = Object.assign(new Error('Rate limit'), { status: 429 });
      mockCreate
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });

      const result = await provider.callDomain('content', [], 'test', '');
      expect(result.text).toBe('ok');
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('retries on 500 server error', async () => {
      const error500 = Object.assign(new Error('Server error'), { status: 500 });
      mockCreate
        .mockRejectedValueOnce(error500)
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });

      const result = await provider.callDomain('secretary', [], 'hi', '');
      expect(result.text).toBe('recovered');
    });

    it('throws after max retries exceeded', async () => {
      const error429 = Object.assign(new Error('Rate limit'), { status: 429 });
      mockCreate.mockRejectedValue(error429);

      await expect(provider.callDomain('content', [], 'test', '')).rejects.toThrow('Rate limit');
      expect(mockCreate).toHaveBeenCalledTimes(4); // initial + 3 retries
    });

    it('does not retry on 401 auth error', async () => {
      const error401 = Object.assign(new Error('Unauthorized'), { status: 401 });
      mockCreate.mockRejectedValue(error401);

      await expect(provider.callDomain('content', [], 'test', '')).rejects.toThrow('Unauthorized');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('does not retry on 400 bad request', async () => {
      const error400 = Object.assign(new Error('Bad request'), { status: 400 });
      mockCreate.mockRejectedValue(error400);

      await expect(provider.callDomain('content', [], 'test', '')).rejects.toThrow('Bad request');
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('classify falls back to secretary on API error', async () => {
      mockCreate.mockRejectedValue(new Error('API down'));

      const result = await provider.classify('hello');
      expect(result.domain).toBe('secretary');
      expect(result.confidence).toBe(0);
    });
  });

  // ── Message format mapping (Anthropic ↔ OpenAI) ───────────────────

  describe('message format mapping', () => {
    it('converts Anthropic tool_use blocks to OpenAI tool_calls in continueWithToolResults', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });

      const toolConversation = [
        {
          role: 'assistant' as const,
          content: [
            { type: 'text', text: 'Let me check...' },
            { type: 'tool_use', id: 'call_1', name: 'set_reminder', input: { message: 'test' } },
          ],
        },
        {
          role: 'user' as const,
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' },
          ],
        },
      ];

      await provider.continueWithToolResults('secretary', [], 'set reminder', '', toolConversation);

      const messages = mockCreate.mock.calls[0][0].messages;
      const assistantMsg = messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
      expect(assistantMsg.tool_calls[0]).toEqual({
        id: 'call_1',
        type: 'function',
        function: { name: 'set_reminder', arguments: '{"message":"test"}' },
      });
      const toolMsg = messages.find((m: any) => m.role === 'tool');
      expect(toolMsg.tool_call_id).toBe('call_1');
      expect(toolMsg.content).toBe('{"ok":true}');
    });

    it('converts Anthropic tool definitions to OpenAI function format', async () => {
      mockChatResponse('ok');

      await provider.callDomain('secretary', [], 'test', '');

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.tools[0]).toEqual({
        type: 'function',
        function: {
          name: 'set_reminder',
          description: 'Set a reminder',
          parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        },
      });
    });

    it('extracts OpenAI tool_calls into Anthropic AIToolCall format', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: { name: 'set_reminder', arguments: '{"message":"buy milk"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      });

      const result = await provider.callDomain('secretary', [], 'remind me', '');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual({
        type: 'tool_use',
        id: 'call_abc',
        name: 'set_reminder',
        input: { message: 'buy milk' },
      });
    });
  });
});
