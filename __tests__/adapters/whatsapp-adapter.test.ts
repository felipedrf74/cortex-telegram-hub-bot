import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhatsAppAdapter } from '../../src/adapters/whatsapp-adapter';
import type { WhatsAppConfig } from '../../src/adapters/whatsapp-adapter';

// ─── Mock fs for file upload tests ────────────────────────────────
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-file-content')),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
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

/** Creates a two-step fetch mock: first call uploads media, second sends message */
function createMediaThenMessageFetch(mediaId = 'media-id-123', messageId = 'wamid.photo789') {
  return vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ id: mediaId }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ messages: [{ id: messageId }] }) });
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
      adapterNoVersion.sendText('test');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('v21.0'),
        expect.anything(),
      );
    });

    it('uses an explicitly configured Graph API version', async () => {
      const customVersionFetch = createMockFetch();
      const customVersionAdapter = new WhatsAppAdapter(
        '+351912345678',
        { ...defaultConfig, apiVersion: 'v22.0' },
        customVersionFetch,
      );

      await customVersionAdapter.sendText('test');

      expect(customVersionFetch).toHaveBeenCalledWith(
        'https://graph.facebook.com/v22.0/123456/messages',
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
      const fetchSequence = createMediaThenMessageFetch('media-id-123', 'wamid.doc456');
      const fileAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      const id = await fileAdapter.sendFile('/tmp/report.pdf');

      expect(id).toBe('wamid.doc456');
      expect(fetchSequence).toHaveBeenCalledTimes(2);
      expect(fetchSequence.mock.calls[0][0]).toContain('/media');

      const docBody = JSON.parse(fetchSequence.mock.calls[1][1].body as string);
      expect(docBody.type).toBe('document');
      expect(docBody.document.id).toBe('media-id-123');
      expect(docBody.document.filename).toBe('report.pdf');
    });

    it('passes caption in document message', async () => {
      const fetchSequence = createMediaThenMessageFetch();
      const fileAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      await fileAdapter.sendFile('/tmp/file.csv', { caption: 'Monthly report' });

      const docBody = JSON.parse(fetchSequence.mock.calls[1][1].body as string);
      expect(docBody.document.caption).toBe('Monthly report');
    });

    it('throws on media upload error', async () => {
      const errorAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, createErrorFetch(413));
      await expect(errorAdapter.sendFile('/tmp/big.zip')).rejects.toThrow('WhatsApp media upload error: 413');
    });

    it('throws when document delivery fails after a successful upload', async () => {
      const fetchSequence = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({ id: 'media-ok' }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: vi.fn().mockResolvedValue({ error: { message: 'Unavailable' } }),
        });
      const fileAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);

      await expect(fileAdapter.sendFile('/tmp/report.pdf')).rejects.toThrow(
        'WhatsApp API error: 503',
      );
    });

    it('maps supported file extensions and unknown files to their upload MIME contracts', async () => {
      const mimeContracts = [
        ['report.pdf', 'application/pdf'],
        ['document.doc', 'application/msword'],
        ['document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        ['sheet.xls', 'application/vnd.ms-excel'],
        ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        ['data.csv', 'text/csv'],
        ['notes.txt', 'text/plain'],
        ['image.png', 'image/png'],
        ['photo.jpg', 'image/jpeg'],
        ['photo.jpeg', 'image/jpeg'],
        ['animation.gif', 'image/gif'],
        ['image.webp', 'image/webp'],
        ['video.mp4', 'video/mp4'],
        ['audio.mp3', 'audio/mpeg'],
        ['audio.ogg', 'audio/ogg'],
        ['audio.amr', 'audio/amr'],
        ['PHOTO.PNG', 'image/png'],
        ['unknown.bin', 'application/octet-stream'],
        ['no-extension', 'application/octet-stream'],
      ] as const;

      for (const [filename, expectedMime] of mimeContracts) {
        const fetchSequence = createMediaThenMessageFetch();
        const fileAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
        await fileAdapter.sendFile(`/tmp/${filename}`);
        const uploadBody = JSON.parse(fetchSequence.mock.calls[0][1].body as string);
        expect(uploadBody.type, filename).toBe(expectedMime);
      }
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

    it('propagates an API error for an interactive message', async () => {
      const errorAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, createErrorFetch(400));
      await expect(errorAdapter.sendInlineButtons(
        'Choose:',
        [[{ text: 'A', callbackData: 'a' }]],
      )).rejects.toThrow('WhatsApp API error: 400');
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

  // ─── deleteMessage ──────────────────────────────────────────────────

  describe('deleteMessage', () => {
    it('throws descriptive error (WhatsApp limitation)', async () => {
      await expect(adapter.deleteMessage('wamid.abc')).rejects.toThrow(
        'WhatsApp Cloud API does not support deleting messages',
      );
    });

    it('error message suggests correction message as alternative', async () => {
      await expect(adapter.deleteMessage('wamid.abc')).rejects.toThrow(
        'Consider sending a correction message instead',
      );
    });
  });

  // ─── sendPhoto ──────────────────────────────────────────────────────

  describe('sendPhoto', () => {
    it('uploads media then sends image message', async () => {
      const fetchSequence = createMediaThenMessageFetch('img-media-1', 'wamid.photo1');
      const photoAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      const id = await photoAdapter.sendPhoto('/tmp/photo.jpg');

      expect(id).toBe('wamid.photo1');
      expect(fetchSequence).toHaveBeenCalledTimes(2);

      // First call: media upload
      expect(fetchSequence.mock.calls[0][0]).toContain('/media');

      // Second call: image message
      const body = JSON.parse(fetchSequence.mock.calls[1][1].body as string);
      expect(body.type).toBe('image');
      expect(body.image.id).toBe('img-media-1');
    });

    it('returns WhatsApp message ID', async () => {
      const fetchSequence = createMediaThenMessageFetch('m1', 'wamid.photo42');
      const photoAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      const id = await photoAdapter.sendPhoto('/tmp/pic.png');
      expect(id).toBe('wamid.photo42');
    });

    it('includes caption in image message', async () => {
      const fetchSequence = createMediaThenMessageFetch();
      const photoAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      await photoAdapter.sendPhoto('/tmp/pic.png', { caption: 'Check this out' });

      const body = JSON.parse(fetchSequence.mock.calls[1][1].body as string);
      expect(body.image.caption).toBe('Check this out');
    });

    it('handles Buffer input', async () => {
      const fetchSequence = createMediaThenMessageFetch('buf-media', 'wamid.bufphoto');
      const photoAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      const buf = Buffer.from('fake-image-data');
      const id = await photoAdapter.sendPhoto(buf);
      expect(id).toBe('wamid.bufphoto');
      expect(fetchSequence).toHaveBeenCalledTimes(2);
    });

    it('throws on API error', async () => {
      const errorAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, createErrorFetch(500));
      await expect(errorAdapter.sendPhoto('/tmp/fail.jpg')).rejects.toThrow('WhatsApp media upload error: 500');
    });
  });

  // ─── sendVoice ──────────────────────────────────────────────────────

  describe('sendVoice', () => {
    it('uploads media then sends audio message', async () => {
      const fetchSequence = createMediaThenMessageFetch('voice-media-1', 'wamid.voice1');
      const voiceAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      const id = await voiceAdapter.sendVoice('/tmp/voice.ogg');

      expect(id).toBe('wamid.voice1');
      const body = JSON.parse(fetchSequence.mock.calls[1][1].body as string);
      expect(body.type).toBe('audio');
      expect(body.audio.id).toBe('voice-media-1');
    });

    it('returns WhatsApp message ID', async () => {
      const fetchSequence = createMediaThenMessageFetch('v1', 'wamid.v42');
      const voiceAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      const id = await voiceAdapter.sendVoice('/tmp/audio.mp3');
      expect(id).toBe('wamid.v42');
    });

    it('handles Buffer input', async () => {
      const fetchSequence = createMediaThenMessageFetch('buf-voice', 'wamid.bufvoice');
      const voiceAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, fetchSequence);
      const buf = Buffer.from('fake-audio-data');
      const id = await voiceAdapter.sendVoice(buf);
      expect(id).toBe('wamid.bufvoice');
    });
  });

  // ─── sendTemplate ───────────────────────────────────────────────────

  describe('sendTemplate', () => {
    it('sends template with name and language code', async () => {
      const id = await adapter.sendTemplate('hello_world', 'en_US');
      expect(id).toBe('wamid.abc123');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.type).toBe('template');
      expect(body.template.name).toBe('hello_world');
      expect(body.template.language.code).toBe('en_US');
    });

    it('sends template with component parameters', async () => {
      const components = [{
        type: 'body' as const,
        parameters: [{ type: 'text' as const, text: 'Felipe' }],
      }];
      await adapter.sendTemplate('welcome', 'pt_BR', components);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.template.components).toEqual(components);
      expect(body.template.language.code).toBe('pt_BR');
    });

    it('returns message ID', async () => {
      const id = await adapter.sendTemplate('test_template');
      expect(id).toBe('wamid.abc123');
    });

    it('throws on API error with details', async () => {
      const errorFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: vi.fn().mockResolvedValue({ error: { message: 'Template not found', code: 132000 } }),
      });
      const errorAdapter = new WhatsAppAdapter('+351912345678', defaultConfig, errorFetch);
      await expect(errorAdapter.sendTemplate('nonexistent')).rejects.toThrow('WhatsApp template error: 400');
    });

    it('defaults language to en_US', async () => {
      await adapter.sendTemplate('hello_world');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.template.language.code).toBe('en_US');
    });
  });

  // ─── Interface compliance ───────────────────────────────────────────

  describe('MessageAdapter contract', () => {
    it('has a platform property', () => {
      expect(adapter.platform).toBe('whatsapp');
    });
  });
});
