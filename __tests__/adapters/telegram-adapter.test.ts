import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '../../src/adapters/telegram-adapter';

// ─── Mock Grammy (test setup already mocks the module, but we need
//     the full API surface for production-grade adapter) ─────────────

function createMockCtx(chatId = 12345) {
  const keyboard = { text: vi.fn().mockReturnThis(), row: vi.fn().mockReturnThis() };

  return {
    chat: { id: chatId },
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 43 }),
      editMessageText: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 44 }),
      sendVoice: vi.fn().mockResolvedValue({ message_id: 45 }),
    },
    __keyboard: keyboard,
  };
}

describe('TelegramAdapter', () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    ctx = createMockCtx();
    adapter = new TelegramAdapter(ctx as any);
  });

  // ─── Constructor ────────────────────────────────────────────────────

  describe('constructor', () => {
    it('sets platform to "telegram"', () => {
      expect(adapter.platform).toBe('telegram');
    });

    it('throws if context has no chat', () => {
      expect(() => new TelegramAdapter({ chat: undefined } as any)).toThrow(
        'TelegramAdapter requires a context with a chat',
      );
    });

    it('throws if context chat is null', () => {
      expect(() => new TelegramAdapter({ chat: null } as any)).toThrow(
        'TelegramAdapter requires a context with a chat',
      );
    });
  });

  // ─── sendText ───────────────────────────────────────────────────────

  describe('sendText', () => {
    it('sends a plain text message and returns message ID', async () => {
      const id = await adapter.sendText('Hello');
      expect(id).toBe('42');
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(12345, 'Hello', {
        parse_mode: undefined,
        link_preview_options: undefined,
        reply_parameters: undefined,
      });
    });

    it('passes parseMode option', async () => {
      await adapter.sendText('<b>Bold</b>', { parseMode: 'HTML' });
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        '<b>Bold</b>',
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('passes disableLinkPreview option', async () => {
      await adapter.sendText('https://example.com', { disableLinkPreview: true });
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        'https://example.com',
        expect.objectContaining({
          link_preview_options: { is_disabled: true },
        }),
      );
    });

    it('passes replyToMessageId option', async () => {
      await adapter.sendText('reply', { replyToMessageId: 99 });
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        'reply',
        expect.objectContaining({
          reply_parameters: { message_id: 99 },
        }),
      );
    });

    it('returns string message ID even though Telegram returns number', async () => {
      const id = await adapter.sendText('test');
      expect(typeof id).toBe('string');
    });
  });

  // ─── sendFile ───────────────────────────────────────────────────────

  describe('sendFile', () => {
    it('sends a document and returns message ID', async () => {
      const id = await adapter.sendFile('/tmp/report.pdf');
      expect(id).toBe('43');
      expect(ctx.api.sendDocument).toHaveBeenCalledWith(
        12345,
        expect.anything(), // InputFile instance
        expect.objectContaining({
          caption: undefined,
          parse_mode: undefined,
          reply_parameters: undefined,
        }),
      );
    });

    it('passes caption and parseMode', async () => {
      await adapter.sendFile('/tmp/file.csv', {
        caption: '<b>Report</b>',
        parseMode: 'HTML',
      });
      expect(ctx.api.sendDocument).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.objectContaining({
          caption: '<b>Report</b>',
          parse_mode: 'HTML',
        }),
      );
    });

    it('passes replyToMessageId', async () => {
      await adapter.sendFile('/tmp/file.txt', { replyToMessageId: 50 });
      expect(ctx.api.sendDocument).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.objectContaining({
          reply_parameters: { message_id: 50 },
        }),
      );
    });
  });

  // ─── sendInlineButtons ──────────────────────────────────────────────

  describe('sendInlineButtons', () => {
    it('sends a message with inline keyboard and returns message ID', async () => {
      const buttons = [
        [{ text: 'Yes', callbackData: 'yes' }, { text: 'No', callbackData: 'no' }],
      ];
      const id = await adapter.sendInlineButtons('Choose:', buttons);
      expect(id).toBe('42');
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        'Choose:',
        expect.objectContaining({
          reply_markup: expect.anything(),
        }),
      );
    });

    it('passes parseMode for button messages', async () => {
      const buttons = [[{ text: 'OK', callbackData: 'ok' }]];
      await adapter.sendInlineButtons('<b>Pick</b>', buttons, { parseMode: 'HTML' });
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        '<b>Pick</b>',
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('handles multiple rows of buttons', async () => {
      const buttons = [
        [{ text: 'A', callbackData: 'a' }],
        [{ text: 'B', callbackData: 'b' }],
        [{ text: 'C', callbackData: 'c' }],
      ];
      const id = await adapter.sendInlineButtons('Multi-row:', buttons);
      expect(id).toBe('42');
      expect(ctx.api.sendMessage).toHaveBeenCalled();
    });

    it('handles empty button grid', async () => {
      const id = await adapter.sendInlineButtons('No buttons:', []);
      expect(id).toBe('42');
    });

    it('passes replyToMessageId', async () => {
      const buttons = [[{ text: 'OK', callbackData: 'ok' }]];
      await adapter.sendInlineButtons('text', buttons, { replyToMessageId: 77 });
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        'text',
        expect.objectContaining({
          reply_parameters: { message_id: 77 },
        }),
      );
    });
  });

  // ─── editMessage ────────────────────────────────────────────────────

  describe('editMessage', () => {
    it('edits an existing message by ID', async () => {
      await adapter.editMessage('42', 'Updated text');
      expect(ctx.api.editMessageText).toHaveBeenCalledWith(
        12345,
        42,
        'Updated text',
        { parse_mode: undefined },
      );
    });

    it('passes parseMode option', async () => {
      await adapter.editMessage('42', '<i>Updated</i>', { parseMode: 'HTML' });
      expect(ctx.api.editMessageText).toHaveBeenCalledWith(
        12345,
        42,
        '<i>Updated</i>',
        { parse_mode: 'HTML' },
      );
    });

    it('converts string message ID to number for Grammy API', async () => {
      await adapter.editMessage('999', 'new text');
      expect(ctx.api.editMessageText).toHaveBeenCalledWith(
        12345,
        999,
        'new text',
        expect.anything(),
      );
    });
  });

  // ─── deleteMessage ──────────────────────────────────────────────────

  describe('deleteMessage', () => {
    it('calls ctx.api.deleteMessage with correct chatId and messageId', async () => {
      await adapter.deleteMessage('42');
      expect(ctx.api.deleteMessage).toHaveBeenCalledWith(12345, 42);
    });

    it('converts string messageId to number', async () => {
      await adapter.deleteMessage('999');
      expect(ctx.api.deleteMessage).toHaveBeenCalledWith(12345, 999);
    });
  });

  // ─── sendPhoto ──────────────────────────────────────────────────────

  describe('sendPhoto', () => {
    it('sends photo with caption and parse mode', async () => {
      const id = await adapter.sendPhoto('/tmp/photo.jpg', {
        caption: '<b>Nice photo</b>',
        parseMode: 'HTML',
      });
      expect(id).toBe('44');
      expect(ctx.api.sendPhoto).toHaveBeenCalledWith(
        12345,
        expect.anything(), // InputFile
        expect.objectContaining({
          caption: '<b>Nice photo</b>',
          parse_mode: 'HTML',
        }),
      );
    });

    it('returns message ID as string', async () => {
      const id = await adapter.sendPhoto('/tmp/img.png');
      expect(typeof id).toBe('string');
      expect(id).toBe('44');
    });

    it('passes replyToMessageId', async () => {
      await adapter.sendPhoto('/tmp/img.png', { replyToMessageId: 10 });
      expect(ctx.api.sendPhoto).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.objectContaining({
          reply_parameters: { message_id: 10 },
        }),
      );
    });
  });

  // ─── sendVoice ──────────────────────────────────────────────────────

  describe('sendVoice', () => {
    it('sends voice with caption and duration', async () => {
      const id = await adapter.sendVoice('/tmp/audio.ogg', {
        caption: 'Voice note',
        duration: 30,
      });
      expect(id).toBe('45');
      expect(ctx.api.sendVoice).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.objectContaining({
          caption: 'Voice note',
          duration: 30,
        }),
      );
    });

    it('returns message ID as string', async () => {
      const id = await adapter.sendVoice('/tmp/voice.ogg');
      expect(typeof id).toBe('string');
      expect(id).toBe('45');
    });
  });

  // ─── Message Splitting ──────────────────────────────────────────────

  describe('message splitting', () => {
    it('text under 4096 sends as single message', async () => {
      await adapter.sendText('Short message');
      expect(ctx.api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('text over 4096 splits into multiple messages', async () => {
      const longText = 'A'.repeat(5000);
      await adapter.sendText(longText);
      expect(ctx.api.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('splits prefer newline boundaries over mid-word', async () => {
      // Create text with newline at ~4000 chars, total 5000
      const chunk1 = 'A'.repeat(4000);
      const chunk2 = 'B'.repeat(1000);
      const text = chunk1 + '\n' + chunk2;

      await adapter.sendText(text);
      expect(ctx.api.sendMessage).toHaveBeenCalledTimes(2);
      // First chunk should be the part before the newline
      const firstCall = ctx.api.sendMessage.mock.calls[0];
      expect(firstCall[1]).toBe(chunk1);
    });

    it('returns the LAST message ID', async () => {
      ctx.api.sendMessage
        .mockResolvedValueOnce({ message_id: 100 })
        .mockResolvedValueOnce({ message_id: 101 });

      const longText = 'A'.repeat(5000);
      const id = await adapter.sendText(longText);
      expect(id).toBe('101');
    });
  });

  // ─── HTML Parse Fallback ────────────────────────────────────────────

  describe('HTML parse fallback', () => {
    it('sends with HTML parse_mode normally when it works', async () => {
      await adapter.sendText('<b>bold</b>', { parseMode: 'HTML' });
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        '<b>bold</b>',
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('retries without parse_mode when API returns parse error', async () => {
      const parseError = Object.assign(new Error("Bad Request: can't parse entities"), {
        error_code: 400,
        description: "Bad Request: can't parse entities",
      });
      ctx.api.sendMessage
        .mockRejectedValueOnce(parseError)
        .mockResolvedValueOnce({ message_id: 50 });

      const result = await adapter.sendText('<b>bold</b> text', { parseMode: 'HTML' });
      expect(result).toBe('50');
      // Second call should have stripped tags
      const secondCall = ctx.api.sendMessage.mock.calls[1];
      expect(secondCall[1]).toBe('bold text');
      expect(secondCall[2].parse_mode).toBeUndefined();
    });

    it('stripped version has no HTML tags', async () => {
      const parseError = Object.assign(new Error("can't parse entities"), {
        error_code: 400,
        description: "Bad Request: can't parse entities",
      });
      ctx.api.sendMessage
        .mockRejectedValueOnce(parseError)
        .mockResolvedValueOnce({ message_id: 51 });

      await adapter.sendText('<b>Bold</b> <i>Italic</i> <a href="url">Link</a>', { parseMode: 'HTML' });
      const plainText = ctx.api.sendMessage.mock.calls[1][1];
      expect(plainText).toBe('Bold Italic Link');
      expect(plainText).not.toContain('<');
      expect(plainText).not.toContain('>');
    });
  });

  // ─── 429 Retry ──────────────────────────────────────────────────────

  describe('429 retry', () => {
    it('retries on 429 error with backoff', async () => {
      const error429 = Object.assign(new Error('Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 0.01 }, // fast for test
      });
      ctx.api.sendMessage
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({ message_id: 99 });

      const result = await adapter.sendText('hello');
      expect(result).toBe('99');
      expect(ctx.api.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('respects retry_after from error response', async () => {
      const error429 = Object.assign(new Error('Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 0.01 },
      });
      ctx.api.sendMessage
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({ message_id: 88 });

      const start = Date.now();
      await adapter.sendText('test');
      const elapsed = Date.now() - start;
      // Should have waited at least ~10ms (0.01 * 1000)
      expect(elapsed).toBeGreaterThanOrEqual(5);
    });

    it('throws after max retries exceeded', async () => {
      const error429 = Object.assign(new Error('Too Many Requests'), {
        error_code: 429,
        parameters: { retry_after: 0.001 },
      });
      ctx.api.sendMessage.mockRejectedValue(error429);

      await expect(adapter.sendText('test')).rejects.toThrow('Too Many Requests');
      // 1 initial + 3 retries = 4 attempts
      expect(ctx.api.sendMessage).toHaveBeenCalledTimes(4);
    });
  });

  // ─── Rate Limiting ──────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('acquires token before each API call', async () => {
      // Multiple calls should all succeed (bucket starts full at 30 tokens)
      for (let i = 0; i < 5; i++) {
        await adapter.sendText(`msg ${i}`);
      }
      expect(ctx.api.sendMessage).toHaveBeenCalledTimes(5);
    });
  });

  // ─── Different chat IDs ─────────────────────────────────────────────

  describe('chat scoping', () => {
    it('uses the chat ID from the context', async () => {
      const otherCtx = createMockCtx(99999);
      const otherAdapter = new TelegramAdapter(otherCtx as any);
      await otherAdapter.sendText('hello');
      expect(otherCtx.api.sendMessage).toHaveBeenCalledWith(
        99999,
        'hello',
        expect.anything(),
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
      expect(typeof adapter.deleteMessage).toBe('function');
      expect(typeof adapter.sendPhoto).toBe('function');
      expect(typeof adapter.sendVoice).toBe('function');
    });

    it('has a platform property', () => {
      expect(adapter.platform).toBeDefined();
      expect(typeof adapter.platform).toBe('string');
    });
  });
});
