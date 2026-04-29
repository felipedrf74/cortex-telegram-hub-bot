// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_ATTACHMENT_CLASSIFICATION_TIMEOUT_MS,
  buildChatAttachmentResponse,
} from '../../src/api/routes/chat-message-attachments';

describe('chat message attachment execution helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a stable attachment response from classified invoice data', async () => {
    const classifier = vi.fn().mockResolvedValue({
      type: 'invoice',
      confidence: 0.93,
      vendor: 'Pingo Doce',
      totalAmount: '18,20 €',
      documentDateRaw: '24/04/2026',
    });

    await expect(buildChatAttachmentResponse({
      attachment: { base64: 'abc123', mimeType: 'image/jpeg' },
      normalizedText: '',
      userId: 42,
      tenantId: 42,
      language: 'pt-PT',
      classifier,
      timestamp: '2026-04-24T12:00:00.000Z',
      id: 'msg-test',
    })).resolves.toEqual({
      userText: 'Analisa esta imagem.',
      conversationDomain: 'finance',
      degraded: false,
      degradedReason: null,
      response: {
        id: 'msg-test',
        text: expect.stringContaining('Pingo Doce'),
        domain: 'finance',
        routeMethod: 'attachment',
        confidence: 0.93,
        buttons: null,
        metadata: {
          type: 'invoice_preview',
          invoiceVendor: 'Pingo Doce',
          invoiceAmount: '18,20 €',
        },
        timestamp: '2026-04-24T12:00:00.000Z',
      },
    });

    expect(classifier).toHaveBeenCalledWith('abc123', 'image/jpeg', 'Analisa esta imagem.', 42, 42);
  });

  it('returns a degraded response instead of hanging when classification exceeds the iOS-safe timeout', async () => {
    vi.useFakeTimers();
    const classifier = vi.fn(() => new Promise<never>(() => {}));

    const execution = buildChatAttachmentResponse({
      attachment: { base64: 'abc123', mimeType: 'image/png' },
      normalizedText: 'Can you read this receipt?',
      userId: 99,
      tenantId: 99,
      language: 'en-US',
      classifier,
      timestamp: '2026-04-24T12:30:00.000Z',
      id: 'msg-timeout',
    });

    await vi.advanceTimersByTimeAsync(CHAT_ATTACHMENT_CLASSIFICATION_TIMEOUT_MS);

    await expect(execution).resolves.toMatchObject({
      userText: 'Can you read this receipt?',
      conversationDomain: 'secretary',
      degraded: true,
      degradedReason: 'timeout',
      response: {
        id: 'msg-timeout',
        domain: 'secretary',
        routeMethod: 'attachment_degraded',
        confidence: 0,
        metadata: {
          type: 'attachment_unavailable',
          degraded: true,
          reason: 'timeout',
        },
        timestamp: '2026-04-24T12:30:00.000Z',
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps provider exception text out of degraded user-facing responses', async () => {
    const classifier = vi.fn().mockRejectedValue(new Error('Gemini key tenant secret exploded'));

    const result = await buildChatAttachmentResponse({
      attachment: { base64: 'abc123', mimeType: 'image/webp' },
      normalizedText: '',
      userId: 7,
      tenantId: 7,
      language: 'pt-BR',
      classifier,
      timestamp: '2026-04-24T13:00:00.000Z',
      id: 'msg-failure',
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('classification_failed');
    expect(result.response.text).toContain('Não consegui analisar esta imagem');
    expect(JSON.stringify(result.response)).not.toContain('Gemini key tenant secret exploded');
  });
});
