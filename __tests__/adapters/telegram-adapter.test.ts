import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '../../src/adapters/telegram-adapter';

// ─── Mock Grammy (test setup already mocks the module, but we need
//     sendDocument which isn't in the global mock) ────────────────────

function createMockCtx(chatId = 12345) {
  const keyboard = { text: vi.fn().mockReturnThis(), row: vi.fn().mockReturnThis() };

  return {
    chat: { id: chatId },
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 43 }),
      editMessageText: vi.fn().mockResolvedValue(true),
    },
    // Grammy InlineKeyboard is mocked globally — we just verify sendMessage receives reply_markup
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
    });

    it('has a platform property', () => {
      expect(adapter.platform).toBeDefined();
      expect(typeof adapter.platform).toBe('string');
    });
  });
});
