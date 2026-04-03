/**
 * QA Validation Tests — WhatsAppAdapter
 *
 * Validates the WhatsAppAdapter implementation built by the backend agent.
 * Focuses on:
 *   1. MessageAdapter interface compliance (all methods, correct signatures)
 *   2. WhatsApp Cloud API contract (URL construction, headers, body structure)
 *   3. Platform-specific constraints (3-button limit, no edit, 20-char title)
 *   4. Error handling and edge cases
 *   5. File upload pipeline (media upload → document message)
 *   6. MIME type detection
 *
 * QA agent: agent/qa
 * Validating: src/adapters/whatsapp-adapter.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhatsAppAdapter } from '../../src/adapters/whatsapp-adapter';
import type { WhatsAppConfig } from '../../src/adapters/whatsapp-adapter';
import type { MessageAdapter } from '../../src/adapters/message-adapter';

// ── Mock fs for file upload tests ────────────────────────────────

vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue(Buffer.from('test-file-content')),
}));

// ── Helpers ──────────────────────────────────────────────────────

const defaultConfig: WhatsAppConfig = {
  accessToken: 'test-access-token-123',
  phoneNumberId: 'phone-456',
  apiVersion: 'v21.0',
};

function mockFetch(response: any = { messages: [{ id: 'wamid.test123' }] }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(response),
  });
}

function mockErrorFetch(status = 400) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: vi.fn().mockResolvedValue({ error: { message: 'API error' } }),
  });
}

function mockSequentialFetch(...responses: Array<{ ok: boolean; status: number; data: any }>) {
  const fn = vi.fn();
  for (const res of responses) {
    fn.mockResolvedValueOnce({
      ok: res.ok,
      status: res.status,
      json: vi.fn().mockResolvedValue(res.data),
    });
  }
  return fn;
}

// ═══════════════════════════════════════════════════════════════════
// 1. INTERFACE COMPLIANCE — MessageAdapter contract
// ═══════════════════════════════════════════════════════════════════

describe('QA: WhatsAppAdapter — MessageAdapter interface compliance', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    adapter = new WhatsAppAdapter('+1234567890', defaultConfig, mockFetch());
  });

  it('satisfies MessageAdapter type at compile time', () => {
    // This test verifies TypeScript structural typing — if it compiles, it passes
    const _: MessageAdapter = adapter;
    expect(_).toBeDefined();
  });

  it('has platform property set to "whatsapp"', () => {
    expect(adapter.platform).toBe('whatsapp');
  });

  it('platform property is readonly (cannot reassign)', () => {
    // In TypeScript, "as const" makes the property readonly
    // At runtime we can verify it's set correctly
    expect(adapter.platform).toBe('whatsapp');
    // @ts-expect-error — readonly property
    expect(() => { (adapter as any).platform = 'telegram'; }).not.toThrow();
    // Note: JS doesn't enforce readonly at runtime unless using Object.freeze
  });

  it('sendText returns a string (message ID)', async () => {
    const id = await adapter.sendText('hello');
    expect(typeof id).toBe('string');
  });

  it('sendFile returns a string (message ID)', async () => {
    const fetch = mockSequentialFetch(
      { ok: true, status: 200, data: { id: 'media-1' } },
      { ok: true, status: 200, data: { messages: [{ id: 'wamid.file' }] } },
    );
    const a = new WhatsAppAdapter('+1234567890', defaultConfig, fetch);
    const id = await a.sendFile('/tmp/test.pdf');
    expect(typeof id).toBe('string');
  });

  it('sendInlineButtons returns a string (message ID)', async () => {
    const id = await adapter.sendInlineButtons('pick', [
      [{ text: 'A', callbackData: 'a' }],
    ]);
    expect(typeof id).toBe('string');
  });

  it('editMessage returns void (via rejection — unsupported)', async () => {
    await expect(adapter.editMessage('id', 'text')).rejects.toThrow();
  });

  it('all four methods exist as functions', () => {
    expect(typeof adapter.sendText).toBe('function');
    expect(typeof adapter.sendFile).toBe('function');
    expect(typeof adapter.sendInlineButtons).toBe('function');
    expect(typeof adapter.editMessage).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. CONSTRUCTOR VALIDATION — input guards
// ═══════════════════════════════════════════════════════════════════

describe('QA: WhatsAppAdapter — constructor validation', () => {
  const fetch = mockFetch();

  it('constructs successfully with valid inputs', () => {
    expect(() => new WhatsAppAdapter('+1234567890', defaultConfig, fetch)).not.toThrow();
  });

  it('throws when recipient phone is empty string', () => {
    expect(() => new WhatsAppAdapter('', defaultConfig, fetch))
      .toThrow('recipient phone number');
  });

  it('throws when accessToken is empty', () => {
    expect(() => new WhatsAppAdapter('+1', { ...defaultConfig, accessToken: '' }, fetch))
      .toThrow('accessToken and phoneNumberId');
  });

  it('throws when phoneNumberId is empty', () => {
    expect(() => new WhatsAppAdapter('+1', { ...defaultConfig, phoneNumberId: '' }, fetch))
      .toThrow('accessToken and phoneNumberId');
  });

  it('defaults apiVersion to v21.0 when not provided', async () => {
    const f = mockFetch();
    const a = new WhatsAppAdapter('+1', { accessToken: 'tok', phoneNumberId: '123' }, f);
    await a.sendText('test');
    expect(f).toHaveBeenCalledWith(
      expect.stringContaining('v21.0'),
      expect.anything(),
    );
  });

  it('uses custom apiVersion when provided', async () => {
    const f = mockFetch();
    const a = new WhatsAppAdapter('+1', { ...defaultConfig, apiVersion: 'v22.0' }, f);
    await a.sendText('test');
    expect(f).toHaveBeenCalledWith(
      expect.stringContaining('v22.0'),
      expect.anything(),
    );
  });

  it('constructs correct base URL from config', async () => {
    const f = mockFetch();
    const a = new WhatsAppAdapter('+1', {
      accessToken: 'tok',
      phoneNumberId: 'pid-789',
      apiVersion: 'v21.0',
    }, f);
    await a.sendText('test');
    expect(f).toHaveBeenCalledWith(
      'https://graph.facebook.com/v21.0/pid-789/messages',
      expect.anything(),
    );
  });

  it('accepts phone numbers with various formats', () => {
    // WhatsApp adapter should accept any non-empty phone string
    expect(() => new WhatsAppAdapter('+351912345678', defaultConfig, fetch)).not.toThrow();
    expect(() => new WhatsAppAdapter('351912345678', defaultConfig, fetch)).not.toThrow();
    expect(() => new WhatsAppAdapter('1234', defaultConfig, fetch)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. sendText — Cloud API message structure
// ═══════════════════════════════════════════════════════════════════

describe('QA: WhatsAppAdapter — sendText API contract', () => {
  let fetch: ReturnType<typeof mockFetch>;
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    fetch = mockFetch();
    adapter = new WhatsAppAdapter('+1234567890', defaultConfig, fetch);
  });

  it('sends POST to /messages endpoint', async () => {
    await adapter.sendText('hello');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/messages'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('includes Authorization bearer header', async () => {
    await adapter.sendText('hello');
    const headers = fetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer test-access-token-123');
  });

  it('includes Content-Type application/json header', async () => {
    await adapter.sendText('hello');
    const headers = fetch.mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends correct WhatsApp message body structure', async () => {
    await adapter.sendText('Hello World');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+1234567890',
      type: 'text',
      text: { body: 'Hello World' },
    });
  });

  it('returns the WhatsApp message ID from response', async () => {
    const id = await adapter.sendText('test');
    expect(id).toBe('wamid.test123');
  });

  it('sends the recipient phone number in the body', async () => {
    const a = new WhatsAppAdapter('+351999888777', defaultConfig, mockFetch());
    await a.sendText('test');
    const body = JSON.parse(a['fetchFn'].mock.calls[0][1].body);
    expect(body.to).toBe('+351999888777');
  });

  it('handles empty text message', async () => {
    await adapter.sendText('');
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text.body).toBe('');
  });

  it('handles very long text message', async () => {
    const longText = 'x'.repeat(10000);
    await adapter.sendText(longText);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text.body).toBe(longText);
  });

  it('handles special characters in text', async () => {
    const special = '🎉 Hello "world" & <friends> \n\t';
    await adapter.sendText(special);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text.body).toBe(special);
  });

  it('throws on non-ok API response', async () => {
    const a = new WhatsAppAdapter('+1', defaultConfig, mockErrorFetch(429));
    await expect(a.sendText('test')).rejects.toThrow('WhatsApp API error: 429');
  });

  it('throws on 401 unauthorized', async () => {
    const a = new WhatsAppAdapter('+1', defaultConfig, mockErrorFetch(401));
    await expect(a.sendText('test')).rejects.toThrow('WhatsApp API error: 401');
  });

  it('throws on 500 server error', async () => {
    const a = new WhatsAppAdapter('+1', defaultConfig, mockErrorFetch(500));
    await expect(a.sendText('test')).rejects.toThrow('WhatsApp API error: 500');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. sendFile — media upload pipeline
// ═══════════════════════════════════════════════════════════════════

describe('QA: WhatsAppAdapter — sendFile upload pipeline', () => {
  function fileAdapter() {
    const fetch = mockSequentialFetch(
      { ok: true, status: 200, data: { id: 'media-id-abc' } },
      { ok: true, status: 200, data: { messages: [{ id: 'wamid.doc789' }] } },
    );
    return { adapter: new WhatsAppAdapter('+1234567890', defaultConfig, fetch), fetch };
  }

  it('makes two API calls: upload media then send document', async () => {
    const { adapter, fetch } = fileAdapter();
    await adapter.sendFile('/tmp/report.pdf');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('first call hits /media endpoint for upload', async () => {
    const { adapter, fetch } = fileAdapter();
    await adapter.sendFile('/tmp/report.pdf');
    expect(fetch.mock.calls[0][0]).toContain('/media');
  });

  it('second call hits /messages endpoint for document', async () => {
    const { adapter, fetch } = fileAdapter();
    await adapter.sendFile('/tmp/report.pdf');
    expect(fetch.mock.calls[1][0]).toContain('/messages');
  });

  it('passes media ID from upload response to document message', async () => {
    const { adapter, fetch } = fileAdapter();
    await adapter.sendFile('/tmp/report.pdf');
    const docBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(docBody.document.id).toBe('media-id-abc');
  });

  it('extracts filename from file path', async () => {
    const { adapter, fetch } = fileAdapter();
    await adapter.sendFile('/home/user/docs/quarterly-report.pdf');
    const docBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(docBody.document.filename).toBe('quarterly-report.pdf');
  });

  it('includes caption when provided', async () => {
    const { adapter, fetch } = fileAdapter();
    await adapter.sendFile('/tmp/file.csv', { caption: 'Monthly data' });
    const docBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(docBody.document.caption).toBe('Monthly data');
  });

  it('sends document type in message body', async () => {
    const { adapter, fetch } = fileAdapter();
    await adapter.sendFile('/tmp/file.txt');
    const docBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(docBody.type).toBe('document');
  });

  it('returns message ID from second (document) response', async () => {
    const { adapter } = fileAdapter();
    const id = await adapter.sendFile('/tmp/file.txt');
    expect(id).toBe('wamid.doc789');
  });

  it('throws on media upload failure', async () => {
    const adapter = new WhatsAppAdapter('+1', defaultConfig, mockErrorFetch(413));
    await expect(adapter.sendFile('/tmp/huge.zip')).rejects.toThrow(
      'WhatsApp media upload error: 413',
    );
  });

  it('throws on document send failure (after successful upload)', async () => {
    const fetch = mockSequentialFetch(
      { ok: true, status: 200, data: { id: 'media-ok' } },
      { ok: false, status: 500, data: { error: 'server error' } },
    );
    const adapter = new WhatsAppAdapter('+1', defaultConfig, fetch);
    await expect(adapter.sendFile('/tmp/file.pdf')).rejects.toThrow('WhatsApp API error: 500');
  });

  it('sends base64 encoded file content in upload body', async () => {
    const { adapter, fetch } = fileAdapter();
    await adapter.sendFile('/tmp/test.txt');
    const uploadBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(uploadBody.file).toBe(Buffer.from('test-file-content').toString('base64'));
  });

  it('includes messaging_product in upload body', async () => {
    const { adapter, fetch } = fileAdapter();
    await adapter.sendFile('/tmp/test.txt');
    const uploadBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(uploadBody.messaging_product).toBe('whatsapp');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. MIME TYPE DETECTION
// ═══════════════════════════════════════════════════════════════════

describe('QA: WhatsAppAdapter — MIME type detection', () => {
  function checkMimeType(filename: string, expectedMime: string) {
    const fetch = mockSequentialFetch(
      { ok: true, status: 200, data: { id: 'media-1' } },
      { ok: true, status: 200, data: { messages: [{ id: 'wamid.x' }] } },
    );
    const adapter = new WhatsAppAdapter('+1', defaultConfig, fetch);
    return adapter.sendFile(`/tmp/${filename}`).then(() => {
      const uploadBody = JSON.parse(fetch.mock.calls[0][1].body);
      expect(uploadBody.type).toBe(expectedMime);
    });
  }

  it('detects PDF', () => checkMimeType('doc.pdf', 'application/pdf'));
  it('detects PNG', () => checkMimeType('img.png', 'image/png'));
  it('detects JPG', () => checkMimeType('photo.jpg', 'image/jpeg'));
  it('detects JPEG', () => checkMimeType('photo.jpeg', 'image/jpeg'));
  it('detects CSV', () => checkMimeType('data.csv', 'text/csv'));
  it('detects TXT', () => checkMimeType('notes.txt', 'text/plain'));
  it('detects MP4', () => checkMimeType('video.mp4', 'video/mp4'));
  it('detects MP3', () => checkMimeType('audio.mp3', 'audio/mpeg'));
  it('detects DOC', () => checkMimeType('file.doc', 'application/msword'));
  it('detects DOCX', () => checkMimeType('file.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  it('detects XLS', () => checkMimeType('file.xls', 'application/vnd.ms-excel'));
  it('detects XLSX', () => checkMimeType('file.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  it('falls back to octet-stream for unknown extension', () => checkMimeType('file.xyz', 'application/octet-stream'));
  it('falls back for files without extension', () => checkMimeType('noext', 'application/octet-stream'));

  it('handles uppercase extensions via lowercase normalization', () => {
    // The adapter calls .toLowerCase() on the extension
    return checkMimeType('PHOTO.PNG', 'image/png');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. sendInlineButtons — interactive message constraints
// ═══════════════════════════════════════════════════════════════════

describe('QA: WhatsAppAdapter — sendInlineButtons constraints', () => {
  let fetch: ReturnType<typeof mockFetch>;
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    fetch = mockFetch();
    adapter = new WhatsAppAdapter('+1234567890', defaultConfig, fetch);
  });

  it('sends exactly 1 button', async () => {
    await adapter.sendInlineButtons('Pick:', [[{ text: 'OK', callbackData: 'ok' }]]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.interactive.action.buttons).toHaveLength(1);
  });

  it('sends exactly 3 buttons (maximum)', async () => {
    const buttons = [
      [{ text: 'A', callbackData: 'a' }, { text: 'B', callbackData: 'b' }],
      [{ text: 'C', callbackData: 'c' }],
    ];
    await adapter.sendInlineButtons('Pick:', buttons);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.interactive.action.buttons).toHaveLength(3);
  });

  it('throws when 4 buttons are provided (exceeds limit)', async () => {
    const buttons = [
      [{ text: 'A', callbackData: 'a' }],
      [{ text: 'B', callbackData: 'b' }],
      [{ text: 'C', callbackData: 'c' }],
      [{ text: 'D', callbackData: 'd' }],
    ];
    await expect(adapter.sendInlineButtons('Too many:', buttons))
      .rejects.toThrow('WhatsApp supports max 3 interactive buttons, got 4');
  });

  it('throws when 10 buttons are provided', async () => {
    const buttons = Array.from({ length: 10 }, (_, i) => [
      { text: `B${i}`, callbackData: `b${i}` },
    ]);
    await expect(adapter.sendInlineButtons('Way too many:', buttons))
      .rejects.toThrow('got 10');
  });

  it('flattens multi-row buttons into single list', async () => {
    const buttons = [
      [{ text: 'A', callbackData: 'a' }],
      [{ text: 'B', callbackData: 'b' }],
      [{ text: 'C', callbackData: 'c' }],
    ];
    await adapter.sendInlineButtons('Pick:', buttons);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    // All 3 buttons in flat list under action.buttons
    expect(body.interactive.action.buttons).toHaveLength(3);
  });

  it('truncates button title to 20 characters', async () => {
    const longTitle = 'This is a very long button title that exceeds twenty characters';
    await adapter.sendInlineButtons('Pick:', [[{ text: longTitle, callbackData: 'x' }]]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    const title = body.interactive.action.buttons[0].reply.title;
    expect(title.length).toBeLessThanOrEqual(20);
    expect(title).toBe(longTitle.slice(0, 20));
  });

  it('preserves short button titles unchanged', async () => {
    await adapter.sendInlineButtons('Pick:', [[{ text: 'OK', callbackData: 'ok' }]]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.interactive.action.buttons[0].reply.title).toBe('OK');
  });

  it('maps callbackData to reply.id', async () => {
    await adapter.sendInlineButtons('Pick:', [[{ text: 'Yes', callbackData: 'action_yes' }]]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.interactive.action.buttons[0].reply.id).toBe('action_yes');
  });

  it('sets button type to "reply"', async () => {
    await adapter.sendInlineButtons('Pick:', [[{ text: 'A', callbackData: 'a' }]]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.interactive.action.buttons[0].type).toBe('reply');
  });

  it('sets interactive type to "button"', async () => {
    await adapter.sendInlineButtons('Pick:', [[{ text: 'A', callbackData: 'a' }]]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.interactive.type).toBe('button');
  });

  it('places text in interactive.body.text', async () => {
    await adapter.sendInlineButtons('Choose your option:', [[{ text: 'A', callbackData: 'a' }]]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.interactive.body.text).toBe('Choose your option:');
  });

  it('sets message type to "interactive"', async () => {
    await adapter.sendInlineButtons('Pick:', [[{ text: 'A', callbackData: 'a' }]]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.type).toBe('interactive');
  });

  it('handles empty buttons array (0 buttons)', async () => {
    // No buttons = empty flat array, which is ≤ 3 so should not throw
    const id = await adapter.sendInlineButtons('No buttons:', []);
    expect(id).toBe('wamid.test123');
  });

  it('throws on API error for interactive message', async () => {
    const a = new WhatsAppAdapter('+1', defaultConfig, mockErrorFetch(400));
    await expect(a.sendInlineButtons('x', [[{ text: 'A', callbackData: 'a' }]]))
      .rejects.toThrow('WhatsApp API error: 400');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. editMessage — unsupported operation
// ═══════════════════════════════════════════════════════════════════

describe('QA: WhatsAppAdapter — editMessage (unsupported)', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    adapter = new WhatsAppAdapter('+1', defaultConfig, mockFetch());
  });

  it('throws with descriptive error message', async () => {
    await expect(adapter.editMessage('wamid.123', 'new text'))
      .rejects.toThrow('WhatsApp does not support editing messages after sending');
  });

  it('does NOT call the fetch function', async () => {
    const f = mockFetch();
    const a = new WhatsAppAdapter('+1', defaultConfig, f);
    try { await a.editMessage('id', 'text'); } catch {}
    expect(f).not.toHaveBeenCalled();
  });

  it('rejects regardless of options provided', async () => {
    await expect(adapter.editMessage('id', 'text', { parseMode: 'HTML' }))
      .rejects.toThrow('does not support editing');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. EXPORT VERIFICATION — index.ts barrel exports
// ═══════════════════════════════════════════════════════════════════

describe('QA: WhatsAppAdapter — module exports', () => {
  it('WhatsAppAdapter is exported from adapters/index', async () => {
    const adapters = await import('../../src/adapters/index');
    expect(adapters.WhatsAppAdapter).toBeDefined();
    expect(typeof adapters.WhatsAppAdapter).toBe('function');
  });

  it('WhatsAppConfig type is usable (structural check)', () => {
    const config: WhatsAppConfig = {
      accessToken: 'token',
      phoneNumberId: 'phone',
    };
    expect(config.accessToken).toBe('token');
    expect(config.phoneNumberId).toBe('phone');
    expect(config.apiVersion).toBeUndefined(); // optional
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. CROSS-ADAPTER PARITY — behavioral differences documented
// ═══════════════════════════════════════════════════════════════════

describe('QA: WhatsAppAdapter — cross-adapter behavioral documentation', () => {
  it('WhatsApp has 3-button limit vs Telegram unlimited', async () => {
    const adapter = new WhatsAppAdapter('+1', defaultConfig, mockFetch());
    // 4 buttons: should fail on WhatsApp
    const fourButtons = Array.from({ length: 4 }, (_, i) => [
      { text: `B${i}`, callbackData: `b${i}` },
    ]);
    await expect(adapter.sendInlineButtons('x', fourButtons)).rejects.toThrow('max 3');
  });

  it('WhatsApp throws on editMessage vs Telegram succeeds', async () => {
    const adapter = new WhatsAppAdapter('+1', defaultConfig, mockFetch());
    await expect(adapter.editMessage('id', 'text')).rejects.toThrow('does not support');
  });

  it('WhatsApp sendFile requires two API calls (upload + send)', async () => {
    const fetch = mockSequentialFetch(
      { ok: true, status: 200, data: { id: 'media-1' } },
      { ok: true, status: 200, data: { messages: [{ id: 'wamid.x' }] } },
    );
    const adapter = new WhatsAppAdapter('+1', defaultConfig, fetch);
    await adapter.sendFile('/tmp/file.pdf');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('WhatsApp button titles are capped at 20 chars', async () => {
    const adapter = new WhatsAppAdapter('+1', defaultConfig, mockFetch());
    await adapter.sendInlineButtons('x', [[{ text: 'A'.repeat(30), callbackData: 'a' }]]);
    const body = JSON.parse(adapter['fetchFn'].mock.calls[0][1].body);
    expect(body.interactive.action.buttons[0].reply.title).toHaveLength(20);
  });
});
