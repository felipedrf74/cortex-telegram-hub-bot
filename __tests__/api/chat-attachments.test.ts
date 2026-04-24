import { describe, expect, it } from 'vitest';
import {
  buildAttachmentText,
  normalizeChatAttachment,
} from '../../src/api/routes/chat-attachments';

describe('chat attachment helpers', () => {
  it('normalizes supported image attachments and rejects unsupported payloads', () => {
    expect(normalizeChatAttachment({
      base64: '  abc123  ',
      mimeType: 'IMAGE/JPG',
    })).toEqual({
      base64: 'abc123',
      mimeType: 'image/jpeg',
    });

    expect(normalizeChatAttachment({ base64: 'abc123', mimeType: 'image/png' })).toEqual({
      base64: 'abc123',
      mimeType: 'image/png',
    });
    expect(normalizeChatAttachment({ base64: '', mimeType: 'image/png' })).toBeNull();
    expect(normalizeChatAttachment({ base64: 'abc123', mimeType: 'application/pdf' })).toBeNull();
    expect(normalizeChatAttachment(null)).toBeNull();
  });

  it('builds Portuguese invoice previews with finance metadata', () => {
    const result = buildAttachmentText({
      type: 'invoice',
      confidence: 0.84,
      vendor: 'Continente',
      totalAmount: '12,30 €',
      documentDateRaw: '22/04/2026',
    } as any, true);

    expect(result.domain).toBe('finance');
    expect(result.text).toContain('Analisei a imagem como recibo/nota');
    expect(result.text).toContain('Continente');
    expect(result.text).toContain('84%');
    expect(result.metadata).toEqual({
      type: 'invoice_preview',
      invoiceVendor: 'Continente',
      invoiceAmount: '12,30 €',
    });
  });

  it('limits calendar previews to six visible events and keeps a compact metadata list', () => {
    const result = buildAttachmentText({
      type: 'calendar',
      events: Array.from({ length: 7 }, (_, index) => ({
        start: `2026-04-22T1${index}:00:00.000Z`,
        title: `Event ${index}`,
      })),
    } as any, false);

    expect(result.domain).toBe('secretary');
    expect(result.text).toContain('I detected a schedule/calendar');
    expect(result.text).toContain('+ 1 more events');
    expect(result.metadata.calendar).toHaveLength(6);
    expect(result.metadata.calendar[0]).toEqual({ time: '10:00', title: 'Event 0' });
  });

  it('builds task previews with fallback title and subtasks', () => {
    const result = buildAttachmentText({
      type: 'task',
      subtasks: ['Buy carrots', 'Wash jars'],
    } as any, false);

    expect(result.domain).toBe('secretary');
    expect(result.text).toContain('Title: New task');
    expect(result.text).toContain('Buy carrots');
    expect(result.metadata).toEqual({
      type: 'task_preview',
      taskTitle: undefined,
    });
  });
});
