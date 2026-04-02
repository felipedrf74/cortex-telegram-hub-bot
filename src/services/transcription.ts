// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Voice Transcription Service — Converts voice messages to text using OpenAI Whisper.
 *
 * Grammy delivers Telegram voice messages as OGG/Opus files. OpenAI's Whisper
 * model accepts OGG natively, so no format conversion is needed.
 */

import OpenAI, { toFile } from 'openai';
import { config } from '../config';
import { logger } from '../utils/logger';

// ─── Client (lazy init — reuses openai-provider pattern) ──────────

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    if (!config.openai.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured — voice transcription requires OpenAI Whisper');
    }
    _client = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return _client;
}

/** Check whether voice transcription is available (OpenAI key configured). */
export function isTranscriptionAvailable(): boolean {
  return !!config.openai.apiKey;
}

/**
 * Transcribe an audio buffer to text using OpenAI Whisper.
 *
 * @param audioBuffer - Raw audio bytes (OGG/Opus from Telegram)
 * @param filename    - Filename hint for Whisper (must include extension)
 * @returns Transcribed text, or empty string if audio is silent/unintelligible
 */
export async function transcribeAudio(audioBuffer: Buffer, filename = 'voice.ogg'): Promise<string> {
  const client = getClient();

  logger.debug({ size: audioBuffer.length, filename }, 'Transcribing voice message');

  const file = await toFile(audioBuffer, filename, { type: 'audio/ogg' });

  const transcription = await client.audio.transcriptions.create({
    model: 'whisper-1',
    file,
    language: 'pt',       // Primary language hint (Felipe speaks PT-BR)
  });

  const text = transcription.text.trim();

  logger.info({ chars: text.length }, 'Voice transcription complete');
  return text;
}
