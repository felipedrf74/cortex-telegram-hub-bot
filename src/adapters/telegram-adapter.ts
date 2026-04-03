// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

// ─── TelegramAdapter — Production-Grade Grammy-backed MessageAdapter ──

import { Context, InlineKeyboard, InputFile } from 'grammy';
import type {
  MessageAdapter,
  SendTextOptions,
  SendFileOptions,
  SendInlineButtonsOptions,
  EditMessageOptions,
  SendPhotoOptions,
  SendVoiceOptions,
} from './message-adapter';

// ─── Token Bucket Rate Limiter (per chat) ────────────────────────────

class ChatRateLimiter {
  private tokens: number;
  private lastRefill: number = Date.now();
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxTokens = 30, refillRate = 30) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens;
  }

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
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// ─── TelegramAdapter ─────────────────────────────────────────────────

/**
 * Production-grade Telegram implementation of MessageAdapter using Grammy.
 *
 * Features:
 * - Per-chat rate limiting (30 msg/sec token bucket)
 * - 429 retry with exponential backoff (max 3 retries)
 * - HTML parse fallback (strip tags on parse error)
 * - Message splitting (>4096 chars, prefer newline boundaries)
 * - Full method set: sendText, sendFile, sendInlineButtons, editMessage,
 *   deleteMessage, sendPhoto, sendVoice
 */
export class TelegramAdapter implements MessageAdapter {
  readonly platform = 'telegram' as const;

  private readonly ctx: Context;
  private readonly chatId: number;

  /** Shared rate limiters per chat — all adapter instances for same chat share one limiter */
  private static rateLimiters = new Map<number, ChatRateLimiter>();

  constructor(ctx: Context) {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || chatId === null) {
      throw new Error('TelegramAdapter requires a context with a chat');
    }
    this.ctx = ctx;
    this.chatId = chatId;
  }

  // ─── Rate limiting ───────────────────────────────────────────────

  private async acquireToken(): Promise<void> {
    let limiter = TelegramAdapter.rateLimiters.get(this.chatId);
    if (!limiter) {
      limiter = new ChatRateLimiter();
      TelegramAdapter.rateLimiters.set(this.chatId, limiter);
    }
    await limiter.acquire();
  }

  // ─── Retry on 429 ───────────────────────────────────────────────

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.acquireToken();
        return await fn();
      } catch (err: unknown) {
        const e = err as { error_code?: number; message?: string; parameters?: { retry_after?: number } };
        const is429 = e?.error_code === 429 || e?.message?.includes('429');
        if (!is429 || attempt === maxRetries) throw err;

        const retryAfter = e?.parameters?.retry_after ?? (2 ** attempt);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
      }
    }
    throw new Error('withRetry: unreachable');
  }

  // ─── HTML Parse Fallback ────────────────────────────────────────

  private stripHtmlTags(html: string): string {
    return html.replace(/<[^>]*>/g, '');
  }

  private async sendWithParseFallback(
    chatId: number,
    text: string,
    options: Record<string, unknown>,
  ): Promise<{ message_id: number }> {
    return this.withRetry(async () => {
      try {
        return await this.ctx.api.sendMessage(chatId, text, options as any);
      } catch (err: unknown) {
        const e = err as { error_code?: number; description?: string };
        const isParseError = e?.error_code === 400 &&
          e?.description?.includes("can't parse entities");
        if (isParseError && options?.parse_mode) {
          const plain = this.stripHtmlTags(text);
          return await this.ctx.api.sendMessage(chatId, plain, {
            ...(options as any),
            parse_mode: undefined,
          });
        }
        throw err;
      }
    });
  }

  // ─── Message Splitting ──────────────────────────────────────────

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

  // ─── Public API ─────────────────────────────────────────────────

  async sendText(text: string, options?: SendTextOptions): Promise<string> {
    const chunks = this.splitMessage(text);
    let lastMsgId = '';

    for (const chunk of chunks) {
      const apiOptions: Record<string, unknown> = {
        parse_mode: options?.parseMode,
        link_preview_options: options?.disableLinkPreview ? { is_disabled: true } : undefined,
        reply_parameters: options?.replyToMessageId
          ? { message_id: options.replyToMessageId }
          : undefined,
      };

      const msg = options?.parseMode === 'HTML'
        ? await this.sendWithParseFallback(this.chatId, chunk, apiOptions)
        : await this.withRetry(() => this.ctx.api.sendMessage(this.chatId, chunk, apiOptions as any));

      lastMsgId = String(msg.message_id);
    }

    return lastMsgId;
  }

  async sendFile(filePath: string, options?: SendFileOptions): Promise<string> {
    const msg = await this.withRetry(() =>
      this.ctx.api.sendDocument(this.chatId, new InputFile(filePath), {
        caption: options?.caption,
        parse_mode: options?.parseMode,
        reply_parameters: options?.replyToMessageId
          ? { message_id: options.replyToMessageId }
          : undefined,
      })
    );
    return String(msg.message_id);
  }

  async sendInlineButtons(
    text: string,
    buttons: { text: string; callbackData: string }[][],
    options?: SendInlineButtonsOptions,
  ): Promise<string> {
    const keyboard = new InlineKeyboard();
    for (const row of buttons) {
      for (const btn of row) {
        keyboard.text(btn.text, btn.callbackData);
      }
      keyboard.row();
    }

    const msg = await this.withRetry(() =>
      this.ctx.api.sendMessage(this.chatId, text, {
        parse_mode: options?.parseMode,
        reply_markup: keyboard,
        reply_parameters: options?.replyToMessageId
          ? { message_id: options.replyToMessageId }
          : undefined,
      })
    );
    return String(msg.message_id);
  }

  async editMessage(
    messageId: string,
    newText: string,
    options?: EditMessageOptions,
  ): Promise<void> {
    await this.withRetry(() =>
      this.ctx.api.editMessageText(
        this.chatId,
        Number(messageId),
        newText,
        { parse_mode: options?.parseMode },
      )
    );
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.withRetry(() =>
      this.ctx.api.deleteMessage(this.chatId, Number(messageId))
    );
  }

  async sendPhoto(photo: string | Buffer, options?: SendPhotoOptions): Promise<string> {
    const input = new InputFile(photo);
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

  async sendVoice(audio: string | Buffer, options?: SendVoiceOptions): Promise<string> {
    const input = new InputFile(audio);
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
}
