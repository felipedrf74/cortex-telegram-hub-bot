# TASK-openai-provider.md — Implementation Spec for Claude Code

> Status: decommissioned historical implementation spec.
>
> This file is not a live source of truth. It was a point-in-time execution
> brief for a Claude Code task.
>
> Use the current code, tests, and canonical docs instead:
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/CLAUDE.md`
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/DOCUMENTATION.md`
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/DOCUMENTATION-MAP.md`

> **Branch:** `feature/telegram-adapter` (same branch as adapter work)  
> **Commit message:** `feat(providers): OpenAI provider — token tracking, streaming, error handling`  
> **After implementation:** run `npx vitest run && npx tsc --noEmit`, commit, push.

---

## Objective

Upgrade the existing `OpenAIProvider` (229 lines at `src/services/openai-provider.ts`) with: token usage tracking (persisted to `api_usage` table like the Anthropic provider), optional streaming support, robust error handling with retries on rate limits, and comprehensive tests covering message format mapping and edge cases.

---

## Current State

The provider at `src/services/openai-provider.ts` already implements:
- ✅ `classify` — working, uses gpt-4o-mini
- ✅ `callDomain` — working, translates Anthropic tool format to OpenAI function calls
- ✅ `continueWithToolResults` — working, maps tool_use/tool_result to OpenAI format
- ✅ Tool format conversion (`toOpenAITools`) — Anthropic `input_schema` → OpenAI `parameters`
- ✅ Response parsing (`extractToolCalls`) — OpenAI `tool_calls` → Anthropic `AIToolCall[]`
- ❌ **No token tracking** — `response.usage` is completely ignored
- ❌ **No streaming** — all calls are blocking
- ❌ **No error handling** — no retry on 429, no graceful API error handling
- ❌ **No cost tracking** — unlike Anthropic provider which logs to `api_usage` via `trackedCreate`

Config is already set in `src/config.ts` (line 34): `OPENAI_API_KEY`, model `gpt-4o`, classifier `gpt-4o-mini`.

Existing tests at `__tests__/services/openai-provider.test.ts` (281 lines) cover basic flows but not token tracking, streaming, or error handling.

---

## Files to Modify

| File | Action |
|------|--------|
| `src/services/openai-provider.ts` | Add token tracking, streaming, error handling |
| `__tests__/services/openai-provider.test.ts` | Extend with new test groups |

**No new files needed.** Config and env vars are already in place.

---

## 1. Update `src/services/openai-provider.ts`

### 1.1 Add token tracking

Follow the same pattern as `src/portal/anthropic-hook.ts` — record every API call to the `api_usage` SQLite table and push telemetry events.

Add imports at the top:

```typescript
import { getDb } from './database';
import { pushEvent } from '../portal/telemetry';
```

Add cost-per-token pricing (update when OpenAI changes rates):

```typescript
const OPENAI_COST_PER_MTK: Record<string, { in: number; out: number }> = {
  'gpt-4o':      { in: 2.50, out: 10.00 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
};
```

Create a tracked wrapper (similar to `trackedCreate` in anthropic-hook.ts):

```typescript
/**
 * Wrapper that records usage metrics for every OpenAI API call.
 * Writes to api_usage table and pushes telemetry event.
 */
async function trackedCompletion(
  client: OpenAI,
  params: OpenAI.ChatCompletionCreateParamsNonStreaming,
  category: string,
): Promise<OpenAI.ChatCompletion> {
  const start = Date.now();
  const response = await client.chat.completions.create(params);
  const durationMs = Date.now() - start;

  const usage = response.usage;
  if (usage) {
    const model = response.model || params.model;
    const rates = OPENAI_COST_PER_MTK[model] ?? OPENAI_COST_PER_MTK['gpt-4o'];
    const costUsd =
      (usage.prompt_tokens / 1_000_000) * rates.in +
      (usage.completion_tokens / 1_000_000) * rates.out;

    // Persist to api_usage table
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO api_usage (category, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms)
        VALUES (?, ?, ?, ?, 0, 0, ?, ?)
      `).run(category, model, usage.prompt_tokens, usage.completion_tokens, costUsd, durationMs);
    } catch (e) {
      logger.warn({ err: e }, 'Failed to log OpenAI usage to database');
    }

    // Push telemetry event
    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `OpenAI ${model} [${category}] — ${usage.prompt_tokens}+${usage.completion_tokens} tokens`,
      detail: `$${costUsd.toFixed(4)} in ${durationMs}ms`,
    });
  }

  return response;
}
```

Replace all `getClient().chat.completions.create(...)` calls with `trackedCompletion(getClient(), ..., category)`:

- In `classify`: category = `'openai_classify'`
- In `callDomain`: category = `'openai_domain_' + domain` (e.g. `'openai_domain_secretary'`)
- In `continueWithToolResults`: category = `'openai_tool_continuation'`

### 1.2 Add error handling with retry on 429

Wrap the `trackedCompletion` call in a retry helper:

```typescript
/**
 * Retry on OpenAI rate limit (429) and transient server errors (500, 502, 503).
 * Uses exponential backoff with jitter. Max 3 retries.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503;

      if (!isRetryable || attempt === maxRetries) throw err;

      // Use retry-after header if available, otherwise exponential backoff
      const retryAfter = err?.headers?.['retry-after'];
      const waitMs = retryAfter
        ? Number(retryAfter) * 1000
        : (2 ** attempt) * 1000 + Math.random() * 500;

      logger.warn({ status, attempt, waitMs }, 'OpenAI retryable error, backing off');
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw new Error('withRetry: unreachable');
}
```

Apply `withRetry` around every `trackedCompletion` call in `classify`, `callDomain`, and `continueWithToolResults`:

```typescript
// Example in callDomain:
const response = await withRetry(() =>
  trackedCompletion(getClient(), {
    model: routing.model,
    max_tokens: maxTokensOverride || routing.maxTokens,
    messages,
    ...(useTools ? { tools: toOpenAITools() } : {}),
  }, `openai_domain_${domain}`)
);
```

### 1.3 Add optional streaming support

Add a streaming method that yields chunks. This is a NEW public method on the class (not part of the `AIProvider` interface — streaming is opt-in):

```typescript
/**
 * Stream a domain response. Returns an async generator of text chunks.
 * Token usage is tracked after the stream completes.
 *
 * Usage:
 *   for await (const chunk of provider.streamDomain(...)) {
 *     process.stdout.write(chunk);
 *   }
 */
async *streamDomain(
  domain: DomainName,
  history: DomainMessage[],
  currentMessage: string,
  stateContext: string,
): AsyncGenerator<string, AICallResult, undefined> {
  const routing = getModelRouting(config.openai, domain);
  const systemPrompt = getDomainSystemPrompt(domain);
  const contextPrefix = stateContext ? `[Current State]\n${stateContext}\n\n` : '';

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: `${contextPrefix}${currentMessage}` },
  ];

  const start = Date.now();
  const stream = await getClient().chat.completions.create({
    model: routing.model,
    max_tokens: routing.maxTokens,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  });

  let fullText = '';
  let finishReason = 'stop';
  let usage: { prompt_tokens: number; completion_tokens: number } | null = null;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullText += delta;
      yield delta;
    }
    if (chunk.choices[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason;
    }
    // Usage arrives in the final chunk when stream_options.include_usage is true
    if (chunk.usage) {
      usage = {
        prompt_tokens: chunk.usage.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens,
      };
    }
  }

  const durationMs = Date.now() - start;

  // Track usage after stream completes
  if (usage) {
    const model = routing.model;
    const rates = OPENAI_COST_PER_MTK[model] ?? OPENAI_COST_PER_MTK['gpt-4o'];
    const costUsd =
      (usage.prompt_tokens / 1_000_000) * rates.in +
      (usage.completion_tokens / 1_000_000) * rates.out;

    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO api_usage (category, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms)
        VALUES (?, ?, ?, ?, 0, 0, ?, ?)
      `).run(`openai_stream_${domain}`, model, usage.prompt_tokens, usage.completion_tokens, costUsd, durationMs);
    } catch (e) {
      logger.warn({ err: e }, 'Failed to log OpenAI streaming usage');
    }

    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `OpenAI stream ${model} [${domain}] — ${usage.prompt_tokens}+${usage.completion_tokens} tokens`,
      detail: `$${costUsd.toFixed(4)} in ${durationMs}ms`,
    });
  }

  return {
    text: fullText,
    toolCalls: [],
    stopReason: finishReason,
  };
}
```

---

## 2. Update tests `__tests__/services/openai-provider.test.ts`

The existing test file already mocks the OpenAI SDK. Extend it with the following test groups.

### Add mocks for database and telemetry

Add to the mock section at the top of the file:

```typescript
const mockDbRun = vi.fn();
vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: () => ({ run: mockDbRun }),
  }),
}));

vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
}));
```

### New test: token tracking

```typescript
describe('token tracking', () => {
  it('records usage to api_usage table after successful call', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
      model: 'gpt-4o',
      usage: { prompt_tokens: 150, completion_tokens: 50 },
    });

    await provider.callDomain('secretary', [], 'hi', '');

    expect(mockDbRun).toHaveBeenCalledWith(
      expect.stringContaining('openai_domain_secretary'),
      'gpt-4o',
      150,
      50,
      expect.any(Number), // costUsd
      expect.any(Number), // durationMs
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

  it('continues normally if database write fails', async () => {
    mockDbRun.mockImplementationOnce(() => { throw new Error('DB error'); });
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'works' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const result = await provider.callDomain('content', [], 'test', '');
    expect(result.text).toBe('works');
  });
});
```

### New test: error handling and retry

```typescript
describe('error handling', () => {
  it('retries on 429 rate limit with backoff', async () => {
    const error429 = Object.assign(new Error('Rate limit'), { status: 429 });
    mockCreate
      .mockRejectedValueOnce(error429)
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
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

  it('classify falls back to secretary on API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API down'));

    const result = await provider.classify('hello');
    expect(result.domain).toBe('secretary');
    expect(result.confidence).toBe(0);
  });
});
```

### New test: message format mapping (Anthropic ↔ OpenAI)

```typescript
describe('message format mapping', () => {
  it('converts Anthropic tool_use blocks to OpenAI tool_calls in continueWithToolResults', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }],
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
    // Find the assistant message with tool_calls
    const assistantMsg = messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(assistantMsg.tool_calls[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'set_reminder', arguments: '{"message":"test"}' },
    });
    // Find the tool result message
    const toolMsg = messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.content).toBe('{"ok":true}');
  });

  it('converts Anthropic tool definitions to OpenAI function format', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

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
```

---

## Verification

```bash
npx vitest run __tests__/services/openai-provider.test.ts
npx vitest run  # full suite
npx tsc --noEmit
```

## Definition of Done

- [ ] Every OpenAI API call logs to `api_usage` table (prompt_tokens, completion_tokens, cost_usd, duration_ms)
- [ ] Cost calculation uses correct per-model rates (gpt-4o: $2.50/$10, gpt-4o-mini: $0.15/$0.60)
- [ ] Telemetry events pushed for every call (visible in portal)
- [ ] 429 and 5xx errors trigger exponential backoff retry (max 3)
- [ ] Non-retryable errors (401, 400) throw immediately
- [ ] `streamDomain` method yields text chunks via async generator
- [ ] Stream usage tracked after stream completes (via `stream_options.include_usage`)
- [ ] `classify` still falls back to secretary domain on any error
- [ ] All existing tests still pass
- [ ] New tests cover: token tracking, cost calculation, retry on 429/500, no retry on 401, message format mapping (Anthropic ↔ OpenAI), tool call extraction
- [ ] `npx vitest run` — all green
- [ ] `npx tsc --noEmit` — no type errors
