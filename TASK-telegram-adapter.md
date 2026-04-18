# TASK-telegram-adapter.md — Implementation Spec for Claude Code

> Status: decommissioned historical implementation spec.
>
> This file is not a live source of truth. It was a point-in-time execution
> brief for a Claude Code task.
>
> Use the current code, tests, and canonical docs instead:
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/CLAUDE.md`
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/DOCUMENTATION.md`
> - `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/docs/DOCUMENTATION-MAP.md`

> **Branch:** `main` (hot release)  
> **Commit message:** `feat(adapters): TelegramAdapter — rate limiting, message splitting, parse fallback, new methods`  
> **After implementation:** run `npx vitest run && npx tsc --noEmit`, commit, push.

---

## Objective

Upgrade `TelegramAdapter` to production-grade: add missing methods (`deleteMessage`, `sendPhoto`, `sendVoice`), HTML parse mode fallback, message splitting for >4096 chars, per-chat rate limiting (30 msg/sec), and 429 retry with exponential backoff. Update the `MessageAdapter` interface to include the new methods.

---

## Files to Modify

| File | Action |
|------|--------|
| `src/adapters/message-adapter.ts` | Add `deleteMessage`, `sendPhoto`, `sendVoice` to interface + option types |
| `src/adapters/telegram-adapter.ts` | Full rewrite with all features |
| `src/adapters/index.ts` | Export new option types if added |
| `__tests__/adapters/telegram-adapter.test.ts` | Extend with new method tests + rate limit + split + fallback tests |

---

## 1. Update `src/adapters/message-adapter.ts`

Add these to the interface and create supporting option types:

### New option interfaces

```typescript
/** Options for sending a photo */
export interface SendPhotoOptions {
  caption?: string;
  parseMode?: 'HTML' | 'MarkdownV2';
  replyToMessageId?: number;
}

/** Options for sending a voice message */
export interface SendVoiceOptions {
  caption?: string;
  parseMode?: 'HTML' | 'MarkdownV2';
  replyToMessageId?: number;
  duration?: number;
}
```

### New methods on `MessageAdapter` interface

Add these AFTER the existing `editMessage`:

```typescript
  /**
   * Delete a message by its ID.
   * @param messageId - The ID returned by a previous send method.
   */
  deleteMessage(messageId: string): Promise<void>;

  /**
   * Send a photo to the current chat.
   * @param photo - File path, URL, or Buffer.
   * @returns The platform-specific message ID as a string.
   */
  sendPhoto(photo: string | Buffer, options?: SendPhotoOptions): Promise<string>;

  /**
   * Send a voice message to the current chat.
   * @param audio - File path, URL, or Buffer.
   * @returns The platform-specific message ID as a string.
   */
  sendVoice(audio: string | Buffer, options?: SendVoiceOptions): Promise<string>;
```

### Update `src/adapters/index.ts`

Export the new types:

```typescript
export type {
  MessageAdapter,
  SendTextOptions,
  SendFileOptions,
  SendInlineButtonsOptions,
  EditMessageOptions,
  SendPhotoOptions,
  SendVoiceOptions,
  InlineButton,
} from './message-adapter';
```

---

## 2. Rewrite `src/adapters/telegram-adapter.ts`

The existing file is a bare-bones wrapper. Replace it entirely with a production-grade implementation. Keep the copyright header and constructor pattern.

### Architecture

```
TelegramAdapter
├── Rate Limiter (30 msg/sec per chat, token bucket)
├── Retry Logic (429 exponential backoff, max 3 retries)
├── Parse Fallback (HTML → strip tags → plain text on GrammyError parse fail)
├── Message Splitter (split at 4096 chars, prefer newline boundaries)
└── Methods
    ├── sendText(text, options?)
    ├── sendFile(filePath, options?)
    ├── sendInlineButtons(text, buttons, options?)
    ├── editMessage(messageId, newText, options?)
    ├── deleteMessage(messageId)
    ├── sendPhoto(photo, options?)
    └── sendVoice(audio, options?)
```

### Key implementation details

#### Rate Limiter

```typescript
// Token bucket per chat: 30 tokens, refill 30/sec
// Before every API call: await this.acquireToken()
// If no tokens available, delay until next refill

class ChatRateLimiter {
  private tokens: number = 30;
  private lastRefill: number = Date.now();
  private readonly maxTokens: number = 30;
  private readonly refillRate: number = 30; // per second

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    // Wait until next token is available
    const waitMs = Math.ceil(1000 / this.refillRate);
    await new Promise(r => setTimeout(r, waitMs));
    this.refill();
    this.tokens--;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}
```

Store rate limiters in a `static` Map keyed by chatId so all adapter instances for the same chat share the limiter:

```typescript
private static rateLimiters = new Map<number, ChatRateLimiter>();
```

#### Retry on 429

```typescript
private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await this.acquireToken();
      return await fn();
    } catch (err: any) {
      // Grammy wraps 429 in GrammyError with error_code 429
      const is429 = err?.error_code === 429 || err?.message?.includes('429');
      if (!is429 || attempt === maxRetries) throw err;

      // Telegram sends retry_after in seconds
      const retryAfter = err?.parameters?.retry_after ?? (2 ** attempt);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
    }
  }
  throw new Error('withRetry: unreachable');
}
```

#### HTML Parse Fallback

When `parseMode` is `'HTML'` and the API call throws a Grammy parse error (error_code 400, description contains "can't parse entities"), retry without parse_mode after stripping HTML tags:

```typescript
private stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

private async sendWithParseFallback(
  chatId: number,
  text: string,
  options: any,
): Promise<any> {
  return this.withRetry(async () => {
    try {
      return await this.ctx.api.sendMessage(chatId, text, options);
    } catch (err: any) {
      const isParseError = err?.error_code === 400 &&
        err?.description?.includes("can't parse entities");
      if (isParseError && options?.parse_mode) {
        // Fallback: strip HTML and send plain
        const plain = this.stripHtmlTags(text);
        return await this.ctx.api.sendMessage(chatId, plain, {
          ...options,
          parse_mode: undefined,
        });
      }
      throw err;
    }
  });
}
```

#### Message Splitting (>4096 chars)

Telegram's limit is 4096 characters per message. Split long text:

```typescript
private splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find a split point: prefer double newline, then single newline, then space
    let splitAt = remaining.lastIndexOf('\n\n', limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt <= 0) splitAt = limit; // hard split

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
```

For `sendText`, split BEFORE sending and send each chunk sequentially. Only the last chunk's message ID is returned. Rate limiting applies per chunk.

#### sendText implementation

```typescript
async sendText(text: string, options?: SendTextOptions): Promise<string> {
  const chunks = this.splitMessage(text);
  let lastMsgId = '';

  for (const chunk of chunks) {
    const apiOptions: any = {
      parse_mode: options?.parseMode,
      link_preview_options: options?.disableLinkPreview ? { is_disabled: true } : undefined,
      reply_parameters: options?.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined,
    };

    const msg = options?.parseMode === 'HTML'
      ? await this.sendWithParseFallback(this.chatId, chunk, apiOptions)
      : await this.withRetry(() => this.ctx.api.sendMessage(this.chatId, chunk, apiOptions));

    lastMsgId = String(msg.message_id);
  }

  return lastMsgId;
}
```

#### deleteMessage

```typescript
async deleteMessage(messageId: string): Promise<void> {
  await this.withRetry(() =>
    this.ctx.api.deleteMessage(this.chatId, Number(messageId))
  );
}
```

#### sendPhoto

```typescript
async sendPhoto(photo: string | Buffer, options?: SendPhotoOptions): Promise<string> {
  const input = typeof photo === 'string' ? new InputFile(photo) : new InputFile(photo);
  const msg = await this.withRetry(() =>
    this.ctx.api.sendPhoto(this.chatId, input, {
      caption: options?.caption,
      parse_mode: options?.parseMode,
      reply_parameters: options?.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined,
    })
  );
  return String(msg.message_id);
}
```

#### sendVoice

```typescript
async sendVoice(audio: string | Buffer, options?: SendVoiceOptions): Promise<string> {
  const input = typeof audio === 'string' ? new InputFile(audio) : new InputFile(audio);
  const msg = await this.withRetry(() =>
    this.ctx.api.sendVoice(this.chatId, input, {
      caption: options?.caption,
      parse_mode: options?.parseMode,
      duration: options?.duration,
      reply_parameters: options?.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined,
    })
  );
  return String(msg.message_id);
}
```

#### Also update: sendFile, sendInlineButtons, editMessage

Wrap all existing methods with `this.withRetry()` and rate limiter. Apply parse fallback where applicable (sendFile caption, sendInlineButtons text).

---

## 3. Tests — `__tests__/adapters/telegram-adapter.test.ts`

Extend the existing test file. Keep the existing `createMockCtx` helper but add mock methods for the new API calls.

### New mock methods needed on `ctx.api`:

```typescript
deleteMessage: vi.fn().mockResolvedValue(true),
sendPhoto: vi.fn().mockResolvedValue({ message_id: 44 }),
sendVoice: vi.fn().mockResolvedValue({ message_id: 45 }),
```

### Test groups to add:

```
describe('deleteMessage')
  - calls ctx.api.deleteMessage with correct chatId and messageId
  - converts string messageId to number

describe('sendPhoto')
  - sends photo with caption and parse mode
  - returns message ID as string

describe('sendVoice')
  - sends voice with caption and duration
  - returns message ID as string

describe('message splitting')
  - text under 4096 sends as single message
  - text over 4096 splits into multiple messages
  - splits prefer newline boundaries over mid-word
  - returns the LAST message's ID

describe('HTML parse fallback')
  - sends with HTML parse_mode normally when it works
  - retries without parse_mode when API returns parse error (error_code 400)
  - stripped version has no HTML tags

describe('rate limiting')
  - acquires token before each API call
  - multiple rapid calls don't exceed 30/sec rate
  // NOTE: rate limit tests may need vi.useFakeTimers()

describe('429 retry')
  - retries on 429 error with backoff
  - respects retry_after from error response
  - throws after max retries exceeded
```

### Pattern for 429 test:

```typescript
it('retries on 429 with exponential backoff', async () => {
  const error429 = Object.assign(new Error('Too Many Requests'), {
    error_code: 429,
    parameters: { retry_after: 0.01 }, // fast for test
  });
  ctx.api.sendMessage
    .mockRejectedValueOnce(error429)
    .mockResolvedValueOnce({ message_id: 99 });

  const result = await adapter.sendText('hello');
  expect(result).toBe('99');
  expect(ctx.api.sendMessage).toHaveBeenCalledTimes(2);
});
```

### Pattern for parse fallback test:

```typescript
it('falls back to plain text on HTML parse error', async () => {
  const parseError = Object.assign(new Error("Bad Request: can't parse entities"), {
    error_code: 400,
    description: "Bad Request: can't parse entities",
  });
  ctx.api.sendMessage
    .mockRejectedValueOnce(parseError)
    .mockResolvedValueOnce({ message_id: 50 });

  const result = await adapter.sendText('<b>bold</b> text', { parseMode: 'HTML' });
  expect(result).toBe('50');
  // Second call should be plain text without parse_mode
  const secondCall = ctx.api.sendMessage.mock.calls[1];
  expect(secondCall[1]).toBe('bold text'); // stripped HTML
  expect(secondCall[2].parse_mode).toBeUndefined();
});
```

---

## Verification

```bash
npx vitest run __tests__/adapters/telegram-adapter.test.ts
npx vitest run  # full suite — must not break anything
npx tsc --noEmit
```

## Definition of Done

- [ ] `MessageAdapter` interface has `deleteMessage`, `sendPhoto`, `sendVoice`
- [ ] `TelegramAdapter` implements all 7 methods
- [ ] HTML parse fallback: on parse error, strips tags and retries plain
- [ ] Message splitting: text >4096 chars splits at newline boundaries
- [ ] Rate limiting: token bucket 30 msg/sec per chat
- [ ] 429 retry: exponential backoff, respects `retry_after`, max 3 retries
- [ ] All existing adapter tests still pass
- [ ] New tests cover: new methods, splitting, fallback, rate limit, 429
- [ ] `npx vitest run` — all green
- [ ] `npx tsc --noEmit` — no type errors
