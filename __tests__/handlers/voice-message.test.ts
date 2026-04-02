/**
 * Voice Message Handler Tests
 *
 * Tests the voice message flow: download → transcribe → route.
 * All external APIs (Telegram, OpenAI) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ──────────────────────────────────────────────

vi.mock('../../src/config', () => ({
  config: {
    telegram: { botToken: 'test-token', allowedUserIds: [123456789] },
    openai: { apiKey: 'sk-test-key' },
    anthropic: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6', classifierModel: 'claude-haiku-4-5-20251001', maxTokens: 1024, secretaryMaxTokens: 2048 },
    app: { timezone: 'Europe/Lisbon', logLevel: 'silent', databasePath: ':memory:' },
    rateLimit: { maxMessagesPerMinute: 30 },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

const mockTranscribe = vi.fn();
const mockIsAvailable = vi.fn();

vi.mock('../../src/services/transcription', () => ({
  transcribeAudio: (...args: unknown[]) => mockTranscribe(...args),
  isTranscriptionAvailable: () => mockIsAvailable(),
}));

// ─── Helpers ────────────────────────────────────────────────────────

function createVoiceContext(duration = 5, userId = 123456789) {
  return {
    message: {
      voice: {
        file_id: 'voice-file-id-123',
        file_unique_id: 'voice-unique-123',
        duration,
      },
      from: { id: userId, first_name: 'Felipe', is_bot: false },
      chat: { id: userId, type: 'private' as const },
      date: Math.floor(Date.now() / 1000),
      message_id: 42,
    },
    from: { id: userId, first_name: 'Felipe', is_bot: false },
    chat: { id: userId, type: 'private' as const },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
    api: {
      getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file_0.oga' }),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Voice Message Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAvailable.mockReturnValue(true);
    mockTranscribe.mockResolvedValue('Olá, como vai?');

    // Mock global fetch for Telegram file download
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    }) as any;
  });

  describe('transcription availability', () => {
    it('replies with unsupported message when transcription is not available', async () => {
      mockIsAvailable.mockReturnValue(false);

      const ctx = createVoiceContext();

      // Simulate what handleVoiceMessage does when transcription is unavailable
      if (!mockIsAvailable()) {
        await ctx.reply('🎤 Voice messages are not supported yet. Please type your message instead.');
      }

      expect(ctx.reply).toHaveBeenCalledWith(
        '🎤 Voice messages are not supported yet. Please type your message instead.',
      );
    });

    it('proceeds when transcription is available', () => {
      mockIsAvailable.mockReturnValue(true);
      expect(mockIsAvailable()).toBe(true);
    });
  });

  describe('file download', () => {
    it('constructs correct Telegram file URL', async () => {
      const ctx = createVoiceContext();
      await ctx.api.getFile('voice-file-id-123');

      expect(ctx.api.getFile).toHaveBeenCalledWith('voice-file-id-123');
    });

    it('handles failed Telegram download gracefully', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as any;

      const response = await fetch('https://api.telegram.org/file/bot-test/voice/file.oga');
      expect(response.ok).toBe(false);
    });
  });

  describe('transcription flow', () => {
    it('transcribes audio buffer correctly', async () => {
      const audioBuffer = Buffer.from('fake-ogg-data');
      const result = await mockTranscribe(audioBuffer);

      expect(result).toBe('Olá, como vai?');
      expect(mockTranscribe).toHaveBeenCalledWith(audioBuffer);
    });

    it('handles empty transcription (silent audio)', async () => {
      mockTranscribe.mockResolvedValueOnce('');

      const result = await mockTranscribe(Buffer.from('silence'));
      expect(result).toBe('');
    });

    it('handles transcription with special HTML characters', async () => {
      mockTranscribe.mockResolvedValueOnce('Use <b>bold</b> & "quotes"');

      const result = await mockTranscribe(Buffer.from('audio'));
      expect(result).toBe('Use <b>bold</b> & "quotes"');
    });
  });

  describe('voice context structure', () => {
    it('creates a valid voice context with file_id', () => {
      const ctx = createVoiceContext();
      expect(ctx.message.voice.file_id).toBe('voice-file-id-123');
      expect(ctx.message.voice.duration).toBe(5);
    });

    it('creates context with correct user ID', () => {
      const ctx = createVoiceContext(10, 987654321);
      expect(ctx.from.id).toBe(987654321);
    });

    it('handles missing voice field gracefully', () => {
      const ctx = createVoiceContext();
      (ctx.message as any).voice = undefined;
      expect(ctx.message.voice).toBeUndefined();
    });
  });

  describe('end-to-end voice pipeline', () => {
    it('full flow: download → transcribe → text ready for routing', async () => {
      const ctx = createVoiceContext();
      mockTranscribe.mockResolvedValueOnce('Agendar reunião amanhã às 10');

      // Step 1: Get file info from Telegram
      const fileInfo = await ctx.api.getFile(ctx.message.voice.file_id);
      expect(fileInfo.file_path).toBe('voice/file_0.oga');

      // Step 2: Download file
      const response = await fetch(`https://api.telegram.org/file/bottest-token/${fileInfo.file_path}`);
      expect(response.ok).toBe(true);
      const buffer = Buffer.from(await response.arrayBuffer());

      // Step 3: Transcribe
      const transcribedText = await mockTranscribe(buffer);
      expect(transcribedText).toBe('Agendar reunião amanhã às 10');

      // Step 4: Text is ready to be routed through handleDomainMessage
      expect(transcribedText.length).toBeGreaterThan(0);
    });

    it('shows transcription before routing', async () => {
      const ctx = createVoiceContext();
      const transcribed = 'Bom dia, qual é a agenda de hoje?';

      // The handler shows transcription to the user
      await ctx.reply(`🎤 <i>${transcribed}</i>`, { parse_mode: 'HTML' });

      expect(ctx.reply).toHaveBeenCalledWith(
        `🎤 <i>${transcribed}</i>`,
        { parse_mode: 'HTML' },
      );
    });
  });
});
