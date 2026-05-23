import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PHOTO_EXTRACTION_TIMEOUT_MS,
  buildPhotoExtractionPreview,
  extractPhotoAttachment,
  normalizePhotoExtractionAttachment,
} from '../../src/services/photo-extraction';

describe('photo extraction service', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('normalizes supported app image attachments', () => {
    expect(normalizePhotoExtractionAttachment({
      base64: '  abc123  ',
      mimeType: 'IMAGE/JPG',
    })).toEqual({
      base64: 'abc123',
      mimeType: 'image/jpeg',
    });
    expect(normalizePhotoExtractionAttachment({ base64: 'abc123', mimeType: 'image/webp' })).toEqual({
      base64: 'abc123',
      mimeType: 'image/webp',
    });
    expect(normalizePhotoExtractionAttachment({ base64: '', mimeType: 'image/png' })).toBeNull();
    expect(normalizePhotoExtractionAttachment({ base64: 'abc123', mimeType: 'application/pdf' })).toBeNull();
    expect(normalizePhotoExtractionAttachment(null)).toBeNull();
  });

  it('builds invoice previews without mutating downstream finance state', async () => {
    const classifier = vi.fn().mockResolvedValue({
      type: 'invoice',
      confidence: 0.91,
      vendor: 'Continente',
      totalAmount: '12,30 EUR',
      documentDateRaw: '22/05/2026',
    });

    await expect(extractPhotoAttachment({
      attachment: { base64: 'abc123', mimeType: 'image/jpeg' },
      caption: '',
      userId: 44,
      tenantId: 44,
      language: 'pt-PT',
      classifier,
    })).resolves.toMatchObject({
      userText: 'Analisa esta imagem.',
      conversationDomain: 'finance',
      degraded: false,
      degradedReason: null,
      preview: {
        domain: 'finance',
        confidence: 0.91,
        metadata: {
          type: 'invoice_preview',
          invoiceVendor: 'Continente',
          invoiceAmount: '12,30 EUR',
        },
      },
    });
    expect(classifier).toHaveBeenCalledWith('abc123', 'image/jpeg', 'Analisa esta imagem.', 44, 44);
  });

  it('returns a safe degraded preview when classification times out', async () => {
    vi.useFakeTimers();
    const classifier = vi.fn(() => new Promise<never>(() => {}));

    const result = extractPhotoAttachment({
      attachment: { base64: 'abc123', mimeType: 'image/png' },
      caption: 'Read this checklist',
      userId: 55,
      tenantId: 55,
      language: 'en-US',
      classifier,
    });

    await vi.advanceTimersByTimeAsync(PHOTO_EXTRACTION_TIMEOUT_MS);

    await expect(result).resolves.toMatchObject({
      userText: 'Read this checklist',
      conversationDomain: 'secretary',
      degraded: true,
      degradedReason: 'timeout',
      preview: {
        domain: 'secretary',
        confidence: 0,
        metadata: {
          type: 'attachment_unavailable',
          degraded: true,
          reason: 'timeout',
        },
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps compact calendar and task preview metadata', () => {
    const calendar = buildPhotoExtractionPreview({
      type: 'calendar',
      events: Array.from({ length: 7 }, (_, index) => ({
        title: `Event ${index}`,
        start: `2026-05-23T1${index}:00:00.000Z`,
        end: `2026-05-23T1${index}:30:00.000Z`,
      })),
    } as any, false);
    expect(calendar.text).toContain('+ 1 more events');
    expect((calendar.metadata as any).calendar).toHaveLength(6);

    const task = buildPhotoExtractionPreview({
      type: 'task',
      title: 'Pack race bag',
      subtasks: ['Shoes', 'Bib'],
    } as any, false);
    expect(task.text).toContain('Pack race bag');
    expect(task.text).toContain('Shoes');
    expect(task.metadata).toEqual({
      type: 'task_preview',
      taskTitle: 'Pack race bag',
    });
  });
});
