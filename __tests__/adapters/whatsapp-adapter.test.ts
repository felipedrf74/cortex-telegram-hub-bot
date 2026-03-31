import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhatsAppAdapter } from '../../src/adapters/whatsapp-adapter';
import type { WhatsAppConfig } from '../../src/adapters/whatsapp-adapter';

// ─── Mock fs.readFileSync for file upload tests ─────────────────────
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-file-content')),
}));

// ─── Helpers ────────────────────────────────────────────────────────

const defaultConfig: WhatsAppConfig = {
  accessToken: 'test-token',
  phoneNumberId: '123456',
  apiVersion: 'v21.0',
};

function createMockFetch(responseData: any = { messages: [{ id: 'wamid.abc123' }] }) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(responseData),
  });
}

function createErrorFetch(status = 401) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: vi.fn().mockResolvedValue({ error: { message: 'Unauthorized' } }),
  });
}

describe('WhatsAppAdapter', () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    mockFetch = createMockFetch();
    adapter = new WhatsAppAdapter('+351912345678', defaultConfig, mockFetch);
  });

  // ─── Constructor ────────────────────────────────────────────────────

  describe('constructor', () => {
    it('sets platform to "whatsapp"', () => {
      expect(adapter.platform).toBe('whatsapp');
    });

    it('throws if recipient phone is empty', () => {
      expect(() => new WhatsAppAdapter('', defaultConfig, mockFetch)).toThrow(
        'WhatsAppAdapter requires a recipient phone number',
      );
    });

    it('throws if accessToken is missing', () => {
      expect(
        () => new WhatsAppAdapter('+351912345678', { ...defaultConfig, accessToken: '' }, mockFetch),
      ).toThrow('WhatsAppAdapter requires accessToken and phoneNumberId');
    });

    it('throws if phoneNumberId is missing', () => {
      expect(
        () => new WhatsAppAdapter('+351912345678', { ...defaultConfig, phoneNumberId: '' }, mockFetch),
      ).toThrow('WhatsAppAdapter requires accessToken and phoneNumberId');
    });

    it('defaults apiVersion to v21.0', () => {
      const adapterNoVersion = new WhatsAppAdapter(
        '+351912345678',
        { accessToken: 'tok', phoneNumberId: '123' },
        mockFetch,
      );
      // Verify by sending a message and checking the URL
      adapterNoVersion.sendText('test');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('v21.0'),
        expect.anything(),
      );
    });
  });

  // ─── sendText ───────────────────────────────────────────────────────

  describe('sendText', () => {
    it('sends a text message and returns WhatsApp message ID', async () => {
      const id = await adapter.sendText('Hello WhatsApp');
      expect(id).toBe('wamid.abc123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://graph.facebook.com/v21.0/123456/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('sends correct message body structure', async () => {
      await adapter.sendText('Hi there');
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(callBody).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '+351912345678',
        type: 'text',
        text: { body: 'Hi there' },
      });
    });

    it('throws on API error', async () => {
      const errorAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, createErrorFetch(500));
      await expect(errorAdapter.sendText('fail')).rejects.toThrow('WhatsApp API error: 500');
    });
  });

  // ─── sendFile ───────────────────────────────────────────────────────

  describe('sendFile', () => {
    it('uploads media then sends document message', async () => {
      // First call = media upload, second call = send document
      const fetchSequence = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ id: 'media-id-123' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.doc456' }] }) });

      const fileAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      const id = await fileAdapter.sendFile('/tmp/report.pdf');

      expect(id).toBe('wamid.doc456');
      expect(fetchSequence).toHaveBeenCalledTimes(2);

      // First call: media upload
      expect(fetchSequence.mock.calls[0][0]).toContain('/media');

      // Second call: document message
      const docBody = JSON.parse(fetchSequence.mock.calls[1][1].body as string);
      expect(docBody.type).toBe('document');
      expect(docBody.document.id).toBe('media-id-123');
      expect(docBody.document.filename).toBe('report.pdf');
    });

    it('passes caption in document message', async () => {
      const fetchSequence = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ id: 'media-1' }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.x' }] }) });

      const fileAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      await fileAdapter.sendFile('/tmp/file.csv', { caption: 'Monthly report' });

      const docBody = JSON.parse(fetchSequence.mock.calls[1][1].body as string);
      expect(docBody.document.caption).toBe('Monthly report');
    });

    it('throws on media upload error', async () => {
      const errorAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, createErrorFetch(413));
      await expect(errorAdapter.sendFile('/tmp/big.zip')).rejects.toThrow('WhatsApp media upload error: 413');
    });
  });

  // ─── sendInlineButtons ──────────────────────────────────────────────

  describe('sendInlineButtons', () => {
    it('sends interactive button message', async () => {
      const buttons = [
        [{ text: 'Yes', callbackData: 'yes' }, { text: 'No', callbackData: 'no' }],
      ];
      const id = await adapter.sendInlineButtons('Choose:', buttons);
      expect(id).toBe('wamid.abc123');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.type).toBe('interactive');
      expect(body.interactive.type).toBe('button');
      expect(body.interactive.body.text).toBe('Choose:');
      expect(body.interactive.action.buttons).toHaveLength(2);
    });

    it('maps button text and callbackData correctly', async () => {
      const buttons = [[{ text: 'OK', callbackData: 'action_ok' }]];
      await adapter.sendInlineButtons('Confirm?', buttons);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      const btn = body.interactive.action.buttons[0];
      expect(btn.type).toBe('reply');
      expect(btn.reply.id).toBe('action_ok');
      expect(btn.reply.title).toBe('OK');
    });

    it('truncates button titles to 20 chars (WhatsApp limit)', async () => {
      const buttons = [[{ text: 'This is a very long button title', callbackData: 'x' }]];
      await adapter.sendInlineButtons('Pick:', buttons);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.interactive.action.buttons[0].reply.title).toBe('This is a very long ');
    });

    it('throws if more than 3 buttons', async () => {
      const buttons = [
        [{ text: 'A', callbackData: 'a' }],
        [{ text: 'B', callbackData: 'b' }],
        [{ text: 'C', callbackData: 'c' }],
        [{ text: 'D', callbackData: 'd' }],
      ];
      await expect(adapter.sendInlineButtons('Too many:', buttons)).rejects.toThrow(
        'WhatsApp supports max 3 interactive buttons, got 4',
      );
    });

    it('handles 3 buttons across multiple rows (flattened)', async () => {
      const buttons = [
        [{ text: 'A', callbackData: 'a' }, { text: 'B', callbackData: 'b' }],
        [{ text: 'C', callbackData: 'c' }],
      ];
      const id = await adapter.sendInlineButtons('Choose:', buttons);
      expect(id).toBe('wamid.abc123');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.interactive.action.buttons).toHaveLength(3);
    });
  });

  // ─── editMessage ────────────────────────────────────────────────────

  describe('editMessage', () => {
    it('throws because WhatsApp does not support message editing', async () => {
      await expect(adapter.editMessage('wamid.abc', 'new text')).rejects.toThrow(
        'WhatsApp does not support editing messages after sending',
      );
    });
  });

  // ─── Interface compliance ───────────────────────────────────────────

  describe('MessageAdapter contract', () => {
    it('implements all required methods', () => {
      expect(typeof adapter.sendText).toBe('function');
      expect(typeof adapter.sendFile).toBe('function');
      expect(typeof adapter.sendInlineButtons).toBe('function');
      expect(typeof adapter.editMessage).toBe('function');
    });

    it('has a platform property', () => {
      expect(adapter.platform).toBe('whatsapp');
    });
  });
});
