// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  MessageAdapter, SendTextOptions, SendFileOptions,
  SendInlineButtonsOptions, EditMessageOptions,
  SendPhotoOptions, SendVoiceOptions, InlineButton,
} from './message-adapter';
import { randomUUID } from 'crypto';

export interface CollectedMessage {
  id: string;
  type: 'text' | 'file' | 'photo' | 'voice' | 'buttons';
  text?: string;
  buttons?: InlineButton[][];
  filePath?: string;
  caption?: string;
  timestamp: string;
}

/**
 * iOS Adapter — collects messages in memory for API response.
 *
 * Unlike TelegramAdapter/WhatsAppAdapter that push messages to a chat,
 * IOSAdapter accumulates messages in a buffer. After the domain handler
 * finishes, the API route reads the buffer and returns it as JSON.
 *
 * Usage:
 *   const adapter = new IOSAdapter();
 *   // Pass to domain handler (they call adapter.sendText(), etc.)
 *   // After processing:
 *   const messages = adapter.getCollectedMessages();
 *   // Return messages in API response
 */
export class IOSAdapter implements MessageAdapter {
  readonly platform = 'ios' as const;
  private messages: CollectedMessage[] = [];

  async sendText(text: string, _options?: SendTextOptions): Promise<string> {
    const id = randomUUID();
    this.messages.push({ id, type: 'text', text, timestamp: new Date().toISOString() });
    return id;
  }

  async sendFile(filePath: string, options?: SendFileOptions): Promise<string> {
    const id = randomUUID();
    this.messages.push({
      id, type: 'file', filePath,
      caption: options?.caption, timestamp: new Date().toISOString(),
    });
    return id;
  }

  async sendInlineButtons(
    text: string, buttons: InlineButton[][],
    _options?: SendInlineButtonsOptions,
  ): Promise<string> {
    const id = randomUUID();
    this.messages.push({ id, type: 'buttons', text, buttons, timestamp: new Date().toISOString() });
    return id;
  }

  async editMessage(messageId: string, newText: string, _options?: EditMessageOptions): Promise<void> {
    const msg = this.messages.find(m => m.id === messageId);
    if (msg) msg.text = newText;
  }

  async deleteMessage(messageId: string): Promise<void> {
    this.messages = this.messages.filter(m => m.id !== messageId);
  }

  async sendPhoto(photo: string | Buffer, options?: SendPhotoOptions): Promise<string> {
    const id = randomUUID();
    const filePath = typeof photo === 'string' ? photo : undefined;
    this.messages.push({
      id, type: 'photo', filePath,
      caption: options?.caption, timestamp: new Date().toISOString(),
    });
    return id;
  }

  async sendVoice(_audio: string | Buffer, _options?: SendVoiceOptions): Promise<string> {
    const id = randomUUID();
    this.messages.push({ id, type: 'voice', timestamp: new Date().toISOString() });
    return id;
  }

  /** Get all collected messages and clear the buffer. */
  getCollectedMessages(): CollectedMessage[] {
    const result = [...this.messages];
    this.messages = [];
    return result;
  }

  /** Get the primary text response (first text or buttons message). */
  getPrimaryResponse(): { text: string; buttons?: InlineButton[][] } | null {
    const msg = this.messages.find(m => m.type === 'text' || m.type === 'buttons');
    if (!msg) return null;
    return { text: msg.text || '', buttons: msg.buttons };
  }
}
