// ─── WhatsAppAdapter — WhatsApp Cloud API MessageAdapter ────────────

import * as fs from 'fs';
import * as path from 'path';
import type {
  MessageAdapter,
  SendTextOptions,
  SendFileOptions,
  InlineButton,
  SendInlineButtonsOptions,
  EditMessageOptions,
} from './message-adapter';

/** Configuration required to initialise the WhatsApp adapter */
export interface WhatsAppConfig {
  /** WhatsApp Cloud API access token */
  accessToken: string;
  /** Phone number ID from Meta Business settings */
  phoneNumberId: string;
  /** Graph API version (default: 'v21.0') */
  apiVersion?: string;
}

/** Minimal fetch-like function signature (for DI / testing) */
type FetchFn = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/**
 * WhatsApp implementation of MessageAdapter using the Cloud API.
 *
 * Uses Node's built-in fetch (Node 20+) or an injected fetch function.
 * Each instance is scoped to a single recipient phone number.
 *
 * WhatsApp limitations vs Telegram:
 * - Interactive buttons are limited to 3 per message
 * - Messages cannot be edited after sending (editMessage throws)
 * - File sending requires uploading media first, then referencing the media ID
 */
export class WhatsAppAdapter implements MessageAdapter {
  readonly platform = 'whatsapp' as const;

  private readonly recipientPhone: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchFn;

  constructor(
    recipientPhone: string,
    config: WhatsAppConfig,
    fetchFn?: FetchFn,
  ) {
    if (!recipientPhone) {
      throw new Error('WhatsAppAdapter requires a recipient phone number');
    }
    if (!config.accessToken || !config.phoneNumberId) {
      throw new Error('WhatsAppAdapter requires accessToken and phoneNumberId');
    }

    this.recipientPhone = recipientPhone;
    const version = config.apiVersion ?? 'v21.0';
    this.baseUrl = `https://graph.facebook.com/${version}/${config.phoneNumberId}`;
    this.headers = {
      'Authorization': `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    };
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  }

  async sendText(text: string, _options?: SendTextOptions): Promise<string> {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.recipientPhone,
      type: 'text',
      text: { body: text },
    };

    const res = await this.fetchFn(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`WhatsApp API error: ${res.status}`);
    }

    const data = await res.json();
    return data.messages[0].id;
  }

  async sendFile(filePath: string, options?: SendFileOptions): Promise<string> {
    // Step 1: Upload the media
    const mediaId = await this.uploadMedia(filePath);

    // Step 2: Send the document message referencing the media ID
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.recipientPhone,
      type: 'document',
      document: {
        id: mediaId,
        filename: path.basename(filePath),
        caption: options?.caption,
      },
    };

    const res = await this.fetchFn(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`WhatsApp API error: ${res.status}`);
    }

    const data = await res.json();
    return data.messages[0].id;
  }

  async sendInlineButtons(
    text: string,
    buttons: InlineButton[][],
    _options?: SendInlineButtonsOptions,
  ): Promise<string> {
    // WhatsApp interactive buttons: max 3 buttons, no grid layout
    const flatButtons = buttons.flat();
    if (flatButtons.length > 3) {
      throw new Error(
        `WhatsApp supports max 3 interactive buttons, got ${flatButtons.length}`,
      );
    }

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: this.recipientPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: flatButtons.map((btn, i) => ({
            type: 'reply',
            reply: {
              id: btn.callbackData,
              title: btn.text.slice(0, 20), // WhatsApp title limit: 20 chars
            },
          })),
        },
      },
    };

    const res = await this.fetchFn(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`WhatsApp API error: ${res.status}`);
    }

    const data = await res.json();
    return data.messages[0].id;
  }

  async editMessage(
    _messageId: string,
    _newText: string,
    _options?: EditMessageOptions,
  ): Promise<void> {
    throw new Error(
      'WhatsApp does not support editing messages after sending',
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private async uploadMedia(filePath: string): Promise<string> {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const mimeType = this.guessMimeType(fileName);

    // FormData-style upload via JSON with base64 (simplified)
    // In production, use multipart/form-data upload
    const body = {
      messaging_product: 'whatsapp',
      type: mimeType,
      file: fileBuffer.toString('base64'),
      filename: fileName,
    };

    const res = await this.fetchFn(`${this.baseUrl}/media`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`WhatsApp media upload error: ${res.status}`);
    }

    const data = await res.json();
    return data.id;
  }

  private guessMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.csv': 'text/csv',
      '.txt': 'text/plain',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
    };
    return mimeMap[ext] ?? 'application/octet-stream';
  }
}
