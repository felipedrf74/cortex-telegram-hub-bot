/**
 * Transcription Service Tests
 *
 * Tests the voice-to-text transcription service that uses OpenAI Whisper.
 * The OpenAI SDK is fully mocked — no real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock OpenAI SDK ────────────────────────────────────────────────

const mockTranscriptionCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class OpenAI {
      audio = { transcriptions: { create: mockTranscriptionCreate } };
    },
    toFile: vi.fn().mockImplementation(async (buffer: Buffer, name: string) => ({
      name,
      buffer,
    })),
  };
});

vi.mock('../../src/config', () => ({
  config: {
    openai: { apiKey: 'sk-test-key' },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

// ─── Imports (after mocks) ──────────────────────────────────────────

import { transcribeAudio, isTranscriptionAvailable } from '../../src/services/transcription';

// ─── Tests ──────────────────────────────────────────────────────────

describe('Transcription Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isTranscriptionAvailable()', () => {
    it('returns true when OpenAI API key is configured', () => {
      expect(isTranscriptionAvailable()).toBe(true);
    });
  });

  describe('transcribeAudio()', () => {
    it('transcribes an audio buffer and returns text', async () => {
      mockTranscriptionCreate.mockResolvedValueOnce({ text: 'Olá, como vai?' });

      const audioBuffer = Buffer.from('fake-ogg-audio-data');
      const result = await transcribeAudio(audioBuffer);

      expect(result).toBe('Olá, como vai?');
      expect(mockTranscriptionCreate).toHaveBeenCalledOnce();
      expect(mockTranscriptionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'whisper-1',
          language: 'pt',
        }),
      );
    });

    it('handles transcription object response', async () => {
      mockTranscriptionCreate.mockResolvedValueOnce({ text: 'Adicionar leite à lista' });

      const result = await transcribeAudio(Buffer.from('audio'));
      expect(result).toBe('Adicionar leite à lista');
    });

    it('trims whitespace from transcription', async () => {
      mockTranscriptionCreate.mockResolvedValueOnce({ text: '  some text with spaces  ' });

      const result = await transcribeAudio(Buffer.from('audio'));
      expect(result).toBe('some text with spaces');
    });

    it('returns empty string for silent audio', async () => {
      mockTranscriptionCreate.mockResolvedValueOnce({ text: '' });

      const result = await transcribeAudio(Buffer.from('silence'));
      expect(result).toBe('');
    });

    it('uses custom filename when provided', async () => {
      mockTranscriptionCreate.mockResolvedValueOnce({ text: 'test' });
      const { toFile } = await import('openai');

      await transcribeAudio(Buffer.from('audio'), 'message.ogg');

      expect(toFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        'message.ogg',
        { type: 'audio/ogg' },
      );
    });

    it('throws when Whisper API fails', async () => {
      mockTranscriptionCreate.mockRejectedValueOnce(new Error('API rate limit'));

      await expect(transcribeAudio(Buffer.from('audio'))).rejects.toThrow('API rate limit');
    });
  });
});

describe('Transcription Service — no API key', () => {
  it('isTranscriptionAvailable() returns false when key is missing', async () => {
    vi.resetModules();

    vi.doMock('../../src/config', () => ({
      config: { openai: { apiKey: '' } },
    }));
    vi.doMock('../../src/utils/logger', () => ({
      logger: {
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
        trace: vi.fn(), child: vi.fn().mockReturnThis(),
      },
    }));

    const { isTranscriptionAvailable: check } = await import('../../src/services/transcription');
    expect(check()).toBe(false);
  });
});
