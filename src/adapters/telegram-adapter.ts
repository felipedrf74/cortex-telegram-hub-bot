// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

// ─── TelegramAdapter — Grammy-backed MessageAdapter ─────────────────

import { Context, InlineKeyboard, InputFile } from 'grammy';
import type {
  MessageAdapter,
  SendTextOptions,
  SendFileOptions,
  SendInlineButtonsOptions,
  EditMessageOptions,
} from './message-adapter';

/**
 * Telegram implementation of MessageAdapter using Grammy.
 *
 * Wraps a Grammy `Context` so that skills and the Hub Core can send
 * messages through a platform-agnostic interface. Each incoming message
 * creates a fresh adapter instance scoped to that context.
 *
 * @example
 * ```ts
 * const adapter = new TelegramAdapter(ctx);
 * const msgId = await adapter.sendText('Hello!', { parseMode: 'HTML' });
 * await adapter.editMessage(msgId, 'Updated!');
 * ```
 */
export class TelegramAdapter implements MessageAdapter {
  readonly platform = 'telegram' as const;

  private readonly ctx: Context;
  private readonly chatId: number;

  constructor(ctx: Context) {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      throw new Error('TelegramAdapter requires a context with a chat');
    }
    this.ctx = ctx;
    this.chatId = chatId;
  }

  async sendText(text: string, options?: SendTextOptions): Promise<string> {
    const msg = await this.ctx.api.sendMessage(this.chatId, text, {
      parse_mode: options?.parseMode,
      link_preview_options: options?.disableLinkPreview
        ? { is_disabled: true }
        : undefined,
      reply_parameters: options?.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined,
    });
    return String(msg.message_id);
  }

  async sendFile(filePath: string, options?: SendFileOptions): Promise<string> {
    const msg = await this.ctx.api.sendDocument(this.chatId, new InputFile(filePath), {
      caption: options?.caption,
      parse_mode: options?.parseMode,
      reply_parameters: options?.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined,
    });
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

    const msg = await this.ctx.api.sendMessage(this.chatId, text, {
      parse_mode: options?.parseMode,
      reply_markup: keyboard,
      reply_parameters: options?.replyToMessageId
        ? { message_id: options.replyToMessageId }
        : undefined,
    });
    return String(msg.message_id);
  }

  async editMessage(
    messageId: string,
    newText: string,
    options?: EditMessageOptions,
  ): Promise<void> {
    await this.ctx.api.editMessageText(
      this.chatId,
      Number(messageId),
      newText,
      { parse_mode: options?.parseMode },
    );
  }
}
