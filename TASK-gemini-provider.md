# TASK-gemini-provider.md — Implementation Spec for Claude Code

> **Branch:** `feature/telegram-adapter` (same branch as adapter work)  
> **Commit message:** `feat(providers): Gemini provider — token tracking, error handling, circuit breaker mapping`  
> **After implementation:** run `npx vitest run && npx tsc --noEmit`, commit.

---

## Objective

Harden the existing Gemini provider (`src/services/gemini-provider.ts`, 297 lines) with: token usage tracking via `response.usageMetadata` logged to the `api_usage` table, structured error handling that catches `GoogleGenerativeAI` errors and maps them to a standard format compatible with the `FallbackProvider` circuit breaker, and defensive format mapping for edge cases. Extend tests to cover all new behavior.

---

## Current State

The provider at `src/services/gemini-provider.ts` already fully implements `AIProvider` with `classify`, `callDomain`, and `continueWithToolResults`. Config exists in `src/config.ts` (lines 41-47) with `GEMINI_API_KEY`, `GEMINI_MODEL` (gemini-2.0-flash), `GEMINI_CLASSIFIER_MODEL` (gemini-2.0-flash). Tests exist at `__tests__/services/gemini-provider.test.ts` (249 lines).

**What's missing:**
- No token usage tracking (`response.usageMetadata` has `promptTokenCount` + `candidatesTokenCount` but is never read)
- No structured error handling (bare `await model.generateContent()` — errors bubble raw to `FallbackProvider`)
- No retry on transient errors (429, 503)
- Tool conversation mapping has no defensive parsing for edge cases
- Synthetic tool call IDs use `Date.now()` — not deterministic for testing

---

## Files to Modify

| File | Action |
|------|--------|
| `src/services/gemini-provider.ts` | Add token tracking, retry, error handling, harden format mapping |
| `__tests__/services/gemini-provider.test.ts` | Extend with token tracking, error handling, format edge case tests |

---

## 1. Add token usage tracking

Gemini responses include `response.usageMetadata` with `promptTokenCount`, `candidatesTokenCount`, and `totalTokenCount`. Log these to the existing `api_usage` table following the same pattern as the OpenAI provider task.

### Add cost calculation and logging helper

```typescript
import { getDb } from './database';
import { pushEvent } from '../portal/telemetry';

// Gemini pricing per million tokens (update when Google changes rates)
const GEMINI_COST_PER_MTK: Record<string, { in: number; out: number }> = {
  'gemini-2.0-flash':  { in: 0.10, out: 0.40 },
  'gemini-1.5-pro':    { in: 1.25, out: 5.00 },
  'gemini-2.0-pro':    { in: 1.25, out: 5.00 },
};

function computeGeminiCost(model: string, usage: { promptTokenCount: number; candidatesTokenCount: number }): number {
  // Match model prefix since version suffixes may vary
  const key = Object.keys(GEMINI_COST_PER_MTK).find(k => model.startsWith(k)) ?? 'gemini-2.0-flash';
  const rates = GEMINI_COST_PER_MTK[key];
  return (usage.promptTokenCount / 1_000_000) * rates.in +
         (usage.candidatesTokenCount / 1_000_000) * rates.out;
}

function logGeminiUsage(
  model: string,
  category: string,
  usage: { promptTokenCount: number; candidatesTokenCount: number },
  durationMs: number,
): void {
  try {
    const cost = computeGeminiCost(model, usage);
    const db = getDb();
    db.prepare(`
      INSERT INTO api_usage (category, model, input_tokens, output_tokens, cost_usd, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(category, model, usage.promptTokenCount, usage.candidatesTokenCount, cost, durationMs);

    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `Gemini ${model}: ${usage.promptTokenCount}+${usage.candidatesTokenCount} tokens ($${cost.toFixed(4)})`,
      durationMs,
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to log Gemini usage');
  }
}
```

### Integrate into every `generateContent` call

```typescript
const start = Date.now();
const result = await model.generateContent({ contents });
const durationMs = Date.now() - start;

const usage = result.response.usageMetadata;
if (usage) {
  logGeminiUsage(routing.model, 'gemini_domain_' + domain, {
    promptTokenCount: usage.promptTokenCount ?? 0,
    candidatesTokenCount: usage.candidatesTokenCount ?? 0,
  }, durationMs);
}
```

**Categories:** Use `'gemini_classify'`, `'gemini_domain_<domain>'`, `'gemini_tool_continuation'`.

---

## 2. Add structured error handling with retry

### Error types from the Gemini SDK

The `@google/generative-ai` SDK throws `GoogleGenerativeAIError` subtypes:
- `GoogleGenerativeAIFetchError` — network/HTTP errors (has `.status` and `.statusText`)
- `GoogleGenerativeAIResponseError` — API returned error in response body
- `GoogleGenerativeAIRequestInputError` — bad request (invalid params)

### Create a retry wrapper

```typescript
private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      // Extract HTTP status from Gemini's error types
      const status = err?.status ?? err?.response?.status;
      const message = err?.message ?? '';

      const isRetryable =
        status === 429 ||
        status === 503 ||
        status === 500 ||
        message.includes('RESOURCE_EXHAUSTED') ||
        message.includes('UNAVAILABLE');

      if (!isRetryable || attempt === maxRetries) {
        // Map to standard error format for FallbackProvider
        const mapped = new Error(`Gemini API error: ${message}`);
        (mapped as any).provider = 'gemini';
        (mapped as any).status = status;
        (mapped as any).retryable = isRetryable;
        throw mapped;
      }

      const backoffMs = 1000 * Math.pow(2, attempt);
      logger.warn({ attempt, status, backoffMs, message: message.slice(0, 100) }, 'Gemini retrying after error');
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw new Error('withRetry: unreachable');
}
```

### Wrap all `generateContent` calls

```typescript
// In classify:
const result = await this.withRetry(() => model.generateContent(userContent));

// In callDomain:
const result = await this.withRetry(() => model.generateContent({ contents }));

// In continueWithToolResults:
const result = await this.withRetry(() => model.generateContent({ contents }));
```

### Update classify error handler

The existing `classify` catch block already defaults to `{ domain: 'secretary', confidence: 0 }`. Keep this behavior — the retry logic handles transient errors before they reach the catch block. Log the mapped error info:

```typescript
} catch (err: any) {
  logger.error({
    err,
    provider: err?.provider,
    status: err?.status,
    retryable: err?.retryable,
  }, 'Gemini classification failed, defaulting to secretary');
  return { domain: 'secretary', confidence: 0 };
}
```

---

## 3. Harden format mapping

### Fix synthetic tool call IDs

Replace `Date.now()` with a deterministic counter to avoid test flakiness:

```typescript
// Module-level counter
let _toolCallCounter = 0;

function extractFunctionCalls(result: GenerateContentResult): AIToolCall[] {
  const calls = result.response.functionCalls();
  if (!calls || calls.length === 0) return [];

  return calls.map((fc) => ({
    type: 'tool_use' as const,
    id: `gemini_tc_${++_toolCallCounter}`,
    name: fc.name,
    input: (fc.args || {}) as Record<string, unknown>,
  }));
}
```

### Defensive tool conversation mapping

In `continueWithToolResults`, add defensive checks matching the OpenAI provider pattern:

```typescript
for (const msg of toolConversation) {
  try {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // ... existing logic (functionCall parts) ...
    } else if (msg.role === 'assistant' && typeof msg.content === 'string') {
      // Plain text assistant message
      contents.push({ role: 'model', parts: [{ text: msg.content }] });
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      // ... existing logic (functionResponse parts) ...
    }
  } catch (err) {
    logger.warn({ err, msgRole: msg.role }, 'Skipping malformed Gemini tool conversation message');
  }
}
```

### Handle `functionResponse` name mapping

Currently `tool_use_id` is used as the function name in `functionResponse`, which is wrong — `tool_use_id` is an opaque ID, not a function name. Fix by tracking the name from the corresponding `tool_use` block:

```typescript
// Build a map of tool_use_id → function_name from assistant messages
const toolNameMap = new Map<string, string>();
for (const msg of toolConversation) {
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    for (const block of msg.content as any[]) {
      if (block.type === 'tool_use' && block.id && block.name) {
        toolNameMap.set(block.id, block.name);
      }
    }
  }
}

// Then in the user/tool_result loop:
for (const result of msg.content as any[]) {
  if (result.type === 'tool_result') {
    const functionName = toolNameMap.get(result.tool_use_id) || result.tool_use_id || 'unknown';
    parts.push({
      functionResponse: {
        name: functionName,
        response: safeParse(result.content),
      },
    } as Part);
  }
}
```

---

## 4. Tests — extend `__tests__/services/gemini-provider.test.ts`

### Add mocks for new dependencies

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

### Update `mockGeminiResponse` to include `usageMetadata`

```typescript
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
```

### New test groups

```
describe('token usage tracking')
  - logs to api_usage table after classify
  - logs to api_usage table after callDomain with correct category
  - computes cost correctly for gemini-2.0-flash
  - handles missing usageMetadata gracefully (no crash)

describe('error handling and retry')
  - retries on 429 (RESOURCE_EXHAUSTED)
  - retries on 503 (UNAVAILABLE)
  - does NOT retry on 400 (bad request)
  - throws mapped error with provider/status/retryable fields after max retries
  - classify returns secretary fallback after all retries exhausted

describe('format mapping edge cases')
  - handles plain string assistant messages in toolConversation
  - maps tool_use_id to correct function name in functionResponse
  - handles missing function args (uses empty object)
  - handles malformed tool_result content (non-JSON) via safeParse
  - generates deterministic tool call IDs (not Date.now based)
```

### Mock pattern for retry test

```typescript
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
```

### Mock pattern for mapped error test

```typescript
it('throws mapped error with provider metadata after max retries', async () => {
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
```

---

## Verification

```bash
npx vitest run __tests__/services/gemini-provider.test.ts
npx vitest run  # full suite
npx tsc --noEmit
```

## Definition of Done

- [ ] Every `generateContent` call logs to `api_usage` table (model, tokens, cost, duration)
- [ ] Cost calculation uses correct Gemini rates (flash: $0.10/$0.40, pro: $1.25/$5.00)
- [ ] Telemetry event pushed per API call
- [ ] Retry on 429/503/500/RESOURCE_EXHAUSTED/UNAVAILABLE with exponential backoff, max 3
- [ ] Non-retryable errors (400, auth) throw immediately with mapped error (provider, status, retryable)
- [ ] `classify` falls back to secretary after retry exhaustion (no crash)
- [ ] `functionResponse.name` correctly maps from tool_use block name, not from tool_use_id
- [ ] Synthetic tool call IDs are deterministic (counter, not `Date.now()`)
- [ ] Tool conversation mapping handles plain string assistant messages and malformed content
- [ ] All existing tests still pass
- [ ] New tests cover: token tracking, retry, error mapping, format edge cases
- [ ] `npx vitest run` — all green
- [ ] `npx tsc --noEmit` — no type errors
