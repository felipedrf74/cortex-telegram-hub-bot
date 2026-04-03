/**
 * QA Validation Tests — TelegramAdapter & MessageAdapter
 *
 * Validates the backend agent's TelegramAdapter implementation covering:
 * - MessageAdapter interface types and contract
 * - Constructor edge cases (missing chat, falsy IDs, negative IDs)
 * - API error propagation (Grammy failures bubble up correctly)
 * - Option mapping correctness (all combinations)
 * - Type coercion (string ↔ number message IDs)
 * - Chat scoping (adapter is bound to specific chat)
 * - sendInlineButtons keyboard construction
 * - editMessage number conversion edge cases
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramAdapter } from '../../src/adapters/telegram-adapter';
import type {
  MessageAdapter,
  SendTextOptions,
  SendFileOptions,
  SendInlineButtonsOptions,
  EditMessageOptions,
  InlineButton,
} from '../../src/adapters/message-adapter';

// ─── Mock Context Factory ─────────────────────────────────────────

function createMockCtx(overrides: {
  chatId?: number | undefined;
  noChat?: boolean;
  sendMessage?: ReturnType<typeof vi.fn>;
  sendDocument?: ReturnType<typeof vi.fn>;
  editMessageText?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    chat: overrides.noChat ? undefined : { id: overrides.chatId ?? 12345 },
    api: {
      sendMessage: overrides.sendMessage ?? vi.fn().mockResolvedValue({ message_id: 100 }),
      sendDocument: overrides.sendDocument ?? vi.fn().mockResolvedValue({ message_id: 101 }),
      editMessageText: overrides.editMessageText ?? vi.fn().mockResolvedValue(true),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════
// QA VALIDATION TESTS
// ═════════════════════════════════════════════════════════════════════

describe('QA Validation: TelegramAdapter', () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    ctx = createMockCtx();
    adapter = new TelegramAdapter(ctx as any);
  });

  // ─── Constructor Edge Cases ─────────────────────────────────────────

  describe('constructor edge cases', () => {
    it('accepts chat ID of 0 (valid Telegram chat ID)', () => {
      const zeroCtx = createMockCtx({ chatId: 0 });
      // chatId 0 is falsy but technically a number — the current implementation
      // checks `=== undefined`, so 0 should be accepted
      const zeroAdapter = new TelegramAdapter(zeroCtx as any);
      expect(zeroAdapter.platform).toBe('telegram');
    });

    it('accepts negative chat IDs (Telegram group chats use negative IDs)', () => {
      const groupCtx = createMockCtx({ chatId: -1001234567890 });
      const groupAdapter = new TelegramAdapter(groupCtx as any);
      expect(groupAdapter.platform).toBe('telegram');
    });

    it('throws when ctx.chat is completely absent (undefined)', () => {
      expect(() => new TelegramAdapter({ api: {} } as any)).toThrow(
        'TelegramAdapter requires a context with a chat',
      );
    });

    it('throws when ctx.chat exists but has no id property', () => {
      expect(() => new TelegramAdapter({ chat: {}, api: {} } as any)).toThrow(
        'TelegramAdapter requires a context with a chat',
      );
    });

    it('stores chatId immutably from construction time', async () => {
      const mutableCtx = createMockCtx({ chatId: 111 });
      const a = new TelegramAdapter(mutableCtx as any);
      // Mutate the context after construction
      mutableCtx.chat!.id = 999;
      await a.sendText('test');
      // Should still use the original chatId 111
      expect(mutableCtx.api.sendMessage).toHaveBeenCalledWith(
        111,
        'test',
        expect.anything(),
      );
    });
  });

  // ─── sendText Validation ────────────────────────────────────────────

  describe('sendText validation', () => {
    it('sends with no options (all undefined)', async () => {
      const id = await adapter.sendText('hello');
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(12345, 'hello', {
        parse_mode: undefined,
        link_preview_options: undefined,
        reply_parameters: undefined,
      });
      expect(id).toBe('100');
    });

    it('sends with all options combined', async () => {
      const id = await adapter.sendText('full opts', {
        parseMode: 'MarkdownV2',
        disableLinkPreview: true,
        replyToMessageId: 55,
      });
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(12345, 'full opts', {
        parse_mode: 'MarkdownV2',
        link_preview_options: { is_disabled: true },
        reply_parameters: { message_id: 55 },
      });
      expect(id).toBe('100');
    });

    it('does not set link_preview_options when disableLinkPreview is false', async () => {
      await adapter.sendText('link', { disableLinkPreview: false });
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        'link',
        expect.objectContaining({ link_preview_options: undefined }),
      );
    });

    it('handles empty string text', async () => {
      await adapter.sendText('');
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(12345, '', expect.anything());
    });

    it('handles very long text (Telegram limit is 4096 chars) by splitting', async () => {
      const longText = 'x'.repeat(5000);
      await adapter.sendText(longText);
      // Message splitting: 5000 chars → 2 chunks (4096 + 904)
      expect(ctx.api.sendMessage).toHaveBeenCalledTimes(2);
      const firstChunk = ctx.api.sendMessage.mock.calls[0][1];
      const secondChunk = ctx.api.sendMessage.mock.calls[1][1];
      expect(firstChunk.length + secondChunk.length).toBe(5000);
    });

    it('handles text with special characters and unicode', async () => {
      const specialText = '🎉 <b>Hello</b> & "world" 你好';
      await adapter.sendText(specialText, { parseMode: 'HTML' });
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        specialText,
        expect.objectContaining({ parse_mode: 'HTML' }),
      );
    });

    it('propagates API errors from sendMessage', async () => {
      const errorCtx = createMockCtx({
        sendMessage: vi.fn().mockRejectedValue(new Error('Telegram API error: chat not found')),
      });
      const errorAdapter = new TelegramAdapter(errorCtx as any);
      await expect(errorAdapter.sendText('fail')).rejects.toThrow('chat not found');
    });

    it('returns string even for large message IDs', async () => {
      const bigIdCtx = createMockCtx({
        sendMessage: vi.fn().mockResolvedValue({ message_id: Number.MAX_SAFE_INTEGER }),
      });
      const bigAdapter = new TelegramAdapter(bigIdCtx as any);
      const id = await bigAdapter.sendText('big');
      expect(id).toBe(String(Number.MAX_SAFE_INTEGER));
      expect(typeof id).toBe('string');
    });
  });

  // ─── sendFile Validation ────────────────────────────────────────────

  describe('sendFile validation', () => {
    it('sends with no options', async () => {
      const id = await adapter.sendFile('/tmp/doc.pdf');
      expect(id).toBe('101');
      expect(ctx.api.sendDocument).toHaveBeenCalledWith(
        12345,
        expect.anything(), // InputFile instance
        {
          caption: undefined,
          parse_mode: undefined,
          reply_parameters: undefined,
        },
      );
    });

    it('sends with all options combined', async () => {
      await adapter.sendFile('/tmp/report.csv', {
        caption: 'Monthly report',
        parseMode: 'HTML',
        replyToMessageId: 33,
      });
      expect(ctx.api.sendDocument).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        {
          caption: 'Monthly report',
          parse_mode: 'HTML',
          reply_parameters: { message_id: 33 },
        },
      );
    });

    it('propagates API errors from sendDocument', async () => {
      const errorCtx = createMockCtx({
        sendDocument: vi.fn().mockRejectedValue(new Error('File too large')),
      });
      const errorAdapter = new TelegramAdapter(errorCtx as any);
      await expect(errorAdapter.sendFile('/tmp/huge.zip')).rejects.toThrow('File too large');
    });

    it('handles file path with spaces', async () => {
      await adapter.sendFile('/tmp/my documents/file name.pdf');
      expect(ctx.api.sendDocument).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.anything(),
      );
    });

    it('passes empty caption correctly', async () => {
      await adapter.sendFile('/tmp/f.txt', { caption: '' });
      expect(ctx.api.sendDocument).toHaveBeenCalledWith(
        12345,
        expect.anything(),
        expect.objectContaining({ caption: '' }),
      );
    });
  });

  // ─── sendInlineButtons Validation ───────────────────────────────────

  describe('sendInlineButtons validation', () => {
    it('sends single row of buttons', async () => {
      const buttons = [
        [
          { text: 'Yes', callbackData: 'cb_yes' },
          { text: 'No', callbackData: 'cb_no' },
        ],
      ];
      const id = await adapter.sendInlineButtons('Choose one:', buttons);
      expect(id).toBe('100');
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        'Choose one:',
        expect.objectContaining({
          reply_markup: expect.anything(),
        }),
      );
    });

    it('sends multiple rows of buttons', async () => {
      const buttons = [
        [{ text: 'Row1-A', callbackData: 'r1a' }, { text: 'Row1-B', callbackData: 'r1b' }],
        [{ text: 'Row2-A', callbackData: 'r2a' }],
        [{ text: 'Row3-A', callbackData: 'r3a' }, { text: 'Row3-B', callbackData: 'r3b' }, { text: 'Row3-C', callbackData: 'r3c' }],
      ];
      const id = await adapter.sendInlineButtons('Grid:', buttons);
      expect(id).toBe('100');
    });

    it('handles empty buttons array (no buttons)', async () => {
      const id = await adapter.sendInlineButtons('No buttons:', []);
      expect(id).toBe('100');
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        'No buttons:',
        expect.objectContaining({ reply_markup: expect.anything() }),
      );
    });

    it('handles empty rows within the button grid', async () => {
      const buttons: { text: string; callbackData: string }[][] = [[]];
      const id = await adapter.sendInlineButtons('Empty row:', buttons);
      expect(id).toBe('100');
    });

    it('passes all options correctly', async () => {
      const buttons = [[{ text: 'OK', callbackData: 'ok' }]];
      await adapter.sendInlineButtons('<b>Pick</b>', buttons, {
        parseMode: 'HTML',
        replyToMessageId: 88,
      });
      expect(ctx.api.sendMessage).toHaveBeenCalledWith(
        12345,
        '<b>Pick</b>',
        expect.objectContaining({
          parse_mode: 'HTML',
          reply_parameters: { message_id: 88 },
        }),
      );
    });

    it('propagates API errors', async () => {
      const errorCtx = createMockCtx({
        sendMessage: vi.fn().mockRejectedValue(new Error('Bad request')),
      });
      const errorAdapter = new TelegramAdapter(errorCtx as any);
      const buttons = [[{ text: 'X', callbackData: 'x' }]];
      await expect(errorAdapter.sendInlineButtons('fail', buttons)).rejects.toThrow('Bad request');
    });

    it('handles buttons with special characters in text and callbackData', async () => {
      const buttons = [
        [{ text: '✅ Confirm & Proceed', callbackData: 'action:confirm&proceed' }],
      ];
      const id = await adapter.sendInlineButtons('Special chars:', buttons);
      expect(id).toBe('100');
    });
  });

  // ─── editMessage Validation ─────────────────────────────────────────

  describe('editMessage validation', () => {
    it('converts string messageId to number for Grammy', async () => {
      await adapter.editMessage('42', 'updated');
      expect(ctx.api.editMessageText).toHaveBeenCalledWith(12345, 42, 'updated', {
        parse_mode: undefined,
      });
    });

    it('handles messageId "0"', async () => {
      await adapter.editMessage('0', 'zero');
      expect(ctx.api.editMessageText).toHaveBeenCalledWith(12345, 0, 'zero', expect.anything());
    });

    it('passes parseMode option correctly', async () => {
      await adapter.editMessage('10', '<i>italic</i>', { parseMode: 'HTML' });
      expect(ctx.api.editMessageText).toHaveBeenCalledWith(12345, 10, '<i>italic</i>', {
        parse_mode: 'HTML',
      });
    });

    it('passes MarkdownV2 parseMode', async () => {
      await adapter.editMessage('10', '*bold*', { parseMode: 'MarkdownV2' });
      expect(ctx.api.editMessageText).toHaveBeenCalledWith(12345, 10, '*bold*', {
        parse_mode: 'MarkdownV2',
      });
    });

    it('propagates API errors from editMessageText', async () => {
      const errorCtx = createMockCtx({
        editMessageText: vi.fn().mockRejectedValue(new Error('Message not found')),
      });
      const errorAdapter = new TelegramAdapter(errorCtx as any);
      await expect(errorAdapter.editMessage('999', 'nope')).rejects.toThrow('Message not found');
    });

    it('returns void (not the API response)', async () => {
      const result = await adapter.editMessage('42', 'new');
      expect(result).toBeUndefined();
    });

    it('converts non-numeric string to NaN (potential issue)', async () => {
      // This tests a potential edge case: what happens if a non-numeric messageId is passed?
      // Number('abc') → NaN. Grammy may reject this, but the adapter doesn't validate.
      await adapter.editMessage('abc', 'text');
      expect(ctx.api.editMessageText).toHaveBeenCalledWith(12345, NaN, 'text', expect.anything());
    });
  });

  // ─── Chat Scoping ──────────────────────────────────────────────────

  describe('chat scoping', () => {
    it('routes sendText to the correct chat ID', async () => {
      const chatA = createMockCtx({ chatId: 111 });
      const chatB = createMockCtx({ chatId: 222 });
      const adapterA = new TelegramAdapter(chatA as any);
      const adapterB = new TelegramAdapter(chatB as any);

      await adapterA.sendText('to A');
      await adapterB.sendText('to B');

      expect(chatA.api.sendMessage).toHaveBeenCalledWith(111, 'to A', expect.anything());
      expect(chatB.api.sendMessage).toHaveBeenCalledWith(222, 'to B', expect.anything());
    });

    it('routes sendFile to the correct chat ID', async () => {
      const groupCtx = createMockCtx({ chatId: -1009876543 });
      const groupAdapter = new TelegramAdapter(groupCtx as any);
      await groupAdapter.sendFile('/tmp/f.txt');
      expect(groupCtx.api.sendDocument).toHaveBeenCalledWith(
        -1009876543,
        expect.anything(),
        expect.anything(),
      );
    });

    it('routes editMessage to the correct chat ID', async () => {
      const otherCtx = createMockCtx({ chatId: 77777 });
      const otherAdapter = new TelegramAdapter(otherCtx as any);
      await otherAdapter.editMessage('1', 'edited');
      expect(otherCtx.api.editMessageText).toHaveBeenCalledWith(
        77777,
        1,
        'edited',
        expect.anything(),
      );
    });
  });

  // ─── MessageAdapter Interface Contract ──────────────────────────────

  describe('MessageAdapter interface compliance', () => {
    it('platform is "telegram" and stays consistent across calls', async () => {
      expect(adapter.platform).toBe('telegram');
      // After various operations, platform should remain unchanged
      await adapter.sendText('test');
      await adapter.editMessage('1', 'edited');
      expect(adapter.platform).toBe('telegram');
    });

    it('sendText returns a Promise<string>', async () => {
      const result = adapter.sendText('test');
      expect(result).toBeInstanceOf(Promise);
      const id = await result;
      expect(typeof id).toBe('string');
    });

    it('sendFile returns a Promise<string>', async () => {
      const result = adapter.sendFile('/tmp/f.txt');
      expect(result).toBeInstanceOf(Promise);
      const id = await result;
      expect(typeof id).toBe('string');
    });

    it('sendInlineButtons returns a Promise<string>', async () => {
      const buttons = [[{ text: 'OK', callbackData: 'ok' }]];
      const result = adapter.sendInlineButtons('text', buttons);
      expect(result).toBeInstanceOf(Promise);
      const id = await result;
      expect(typeof id).toBe('string');
    });

    it('editMessage returns a Promise<void>', async () => {
      const result = adapter.editMessage('1', 'text');
      expect(result).toBeInstanceOf(Promise);
      const val = await result;
      expect(val).toBeUndefined();
    });

    it('can be assigned to MessageAdapter type', () => {
      // This is a compile-time check — if it compiles, TelegramAdapter satisfies MessageAdapter
      const ma: MessageAdapter = adapter;
      expect(ma.platform).toBe('telegram');
      expect(typeof ma.sendText).toBe('function');
      expect(typeof ma.sendFile).toBe('function');
      expect(typeof ma.sendInlineButtons).toBe('function');
      expect(typeof ma.editMessage).toBe('function');
    });
  });

  // ─── Concurrent Operations ──────────────────────────────────────────

  describe('concurrent operations', () => {
    it('handles multiple concurrent sendText calls', async () => {
      let callCount = 0;
      const mockCtx = createMockCtx({
        sendMessage: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve({ message_id: callCount });
        }),
      });
      const a = new TelegramAdapter(mockCtx as any);

      const results = await Promise.all([
        a.sendText('msg1'),
        a.sendText('msg2'),
        a.sendText('msg3'),
      ]);

      expect(results).toHaveLength(3);
      expect(results.every(r => typeof r === 'string')).toBe(true);
      expect(mockCtx.api.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('handles mixed concurrent operations', async () => {
      const [textId, fileId, buttonId] = await Promise.all([
        adapter.sendText('text'),
        adapter.sendFile('/tmp/f.txt'),
        adapter.sendInlineButtons('buttons', [[{ text: 'A', callbackData: 'a' }]]),
      ]);

      expect(typeof textId).toBe('string');
      expect(typeof fileId).toBe('string');
      expect(typeof buttonId).toBe('string');
    });
  });

  // ─── Option Isolation ──────────────────────────────────────────────

  describe('option isolation between calls', () => {
    it('does not carry options from one sendText call to the next', async () => {
      await adapter.sendText('first', { parseMode: 'HTML', disableLinkPreview: true });
      await adapter.sendText('second');

      const calls = ctx.api.sendMessage.mock.calls;
      expect(calls[0][2].parse_mode).toBe('HTML');
      expect(calls[0][2].link_preview_options).toEqual({ is_disabled: true });
      expect(calls[1][2].parse_mode).toBeUndefined();
      expect(calls[1][2].link_preview_options).toBeUndefined();
    });

    it('does not carry options from sendFile to the next call', async () => {
      await adapter.sendFile('/tmp/a.txt', { caption: 'Cap', parseMode: 'HTML' });
      await adapter.sendFile('/tmp/b.txt');

      const calls = ctx.api.sendDocument.mock.calls;
      expect(calls[0][2].caption).toBe('Cap');
      expect(calls[1][2].caption).toBeUndefined();
    });
  });
});

// ─── MessageAdapter Type Exports ──────────────────────────────────────

describe('QA Validation: MessageAdapter types', () => {
  it('exports all expected types from index', async () => {
    const exports = await import('../../src/adapters/index');
    expect(exports.TelegramAdapter).toBeDefined();
    // Type exports don't appear at runtime, but TelegramAdapter class does
  });

  it('TelegramAdapter can be instantiated from barrel export', async () => {
    const { TelegramAdapter: TA } = await import('../../src/adapters/index');
    const ctx = createMockCtx();
    const adapter = new TA(ctx as any);
    expect(adapter.platform).toBe('telegram');
  });
});
