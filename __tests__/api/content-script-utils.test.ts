// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  invalidScriptFormatMessage,
  invalidTopicGeneratorFormatMessage,
  hasUnsupportedContentControlCharacters,
  normalizeScriptFormat,
  parseOptionalPositiveInt,
  resolveContentScriptSaveIdempotencyKey,
  resolveScriptDurationPreset,
  validateExplicitContentScriptRequestFields,
} from '../../src/api/routes/content-script-utils';

describe('content script route utilities', () => {
  it('parses positive integers from number or string inputs only', () => {
    expect(parseOptionalPositiveInt(12.2)).toBe(12);
    expect(parseOptionalPositiveInt('15')).toBe(15);
    expect(parseOptionalPositiveInt('0')).toBeNull();
    expect(parseOptionalPositiveInt(-1)).toBeNull();
    expect(parseOptionalPositiveInt('bad')).toBeNull();
  });

  it('normalizes supported script formats', () => {
    expect(normalizeScriptFormat(undefined)).toBe('YouTube');
    expect(normalizeScriptFormat('youtube')).toBe('YouTube');
    expect(normalizeScriptFormat('shorts')).toBe('Reel');
    expect(normalizeScriptFormat('instagram short')).toBe('Reel');
    expect(normalizeScriptFormat('podcast')).toBeNull();
  });

  it('rejects inherited object keys as legacy script style aliases', () => {
    for (const style of ['toString', 'constructor', '__proto__']) {
      expect(validateExplicitContentScriptRequestFields(
        { style },
        { allowLegacyStyle: true },
      )).toMatchObject({ field: 'style' });
    }
    expect(validateExplicitContentScriptRequestFields(
      { style: 'bullet' },
      { allowLegacyStyle: true },
    )).toBeNull();
  });

  it('resolves supported Reel duration presets', () => {
    expect(resolveScriptDurationPreset('Reel', undefined, 30)).toEqual({
      maxDurationMinutes: 1,
      targetDurationSeconds: 30,
    });
    expect(resolveScriptDurationPreset('Reel', undefined, undefined)).toEqual({
      maxDurationMinutes: 1,
      targetDurationSeconds: 60,
    });
    expect(resolveScriptDurationPreset('Reel', 8, undefined)).toEqual({
      error: 'Reel maxDurationMinutes must stay at 1 minute; use targetDurationSeconds for 15/30/45/60-second presets',
    });
    expect(resolveScriptDurationPreset('Reel', undefined, 20)).toEqual({
      error: 'Reel duration must be one of 15, 30, 45, or 60 seconds',
    });
    expect(resolveScriptDurationPreset('Reel', 1, 30)).toEqual({
      maxDurationMinutes: 1,
      targetDurationSeconds: 30,
    });
    expect(resolveScriptDurationPreset('Reel', 8, 30)).toEqual({
      error: 'Reel maxDurationMinutes must stay at 1 minute; use targetDurationSeconds for 15/30/45/60-second presets',
    });
  });

  it('resolves supported YouTube duration presets', () => {
    expect(resolveScriptDurationPreset('YouTube', undefined, 600)).toEqual({
      maxDurationMinutes: 10,
      targetDurationSeconds: 600,
    });
    expect(resolveScriptDurationPreset('YouTube', 15, undefined)).toEqual({
      maxDurationMinutes: 15,
      targetDurationSeconds: 900,
    });
    expect(resolveScriptDurationPreset('YouTube', undefined, undefined)).toEqual({
      maxDurationMinutes: 8,
      targetDurationSeconds: 480,
    });
    expect(resolveScriptDurationPreset('YouTube', 12, undefined)).toEqual({
      error: 'YouTube maxDurationMinutes must be one of 8, 10, or 15',
    });
    expect(resolveScriptDurationPreset('YouTube', 8, 900)).toEqual({
      maxDurationMinutes: 15,
      targetDurationSeconds: 900,
    });
    expect(resolveScriptDurationPreset('YouTube', 12, 900)).toEqual({
      error: 'YouTube maxDurationMinutes must be one of 8, 10, or 15',
    });
  });

  it('validates every supplied idempotency key and requires one matching key for script saves', () => {
    expect(resolveContentScriptSaveIdempotencyKey(false, undefined, undefined)).toBeNull();
    expect(resolveContentScriptSaveIdempotencyKey(false, 123, undefined)).toMatchObject({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
    });
    expect(resolveContentScriptSaveIdempotencyKey(false, 'short', undefined)).toMatchObject({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
    });
    expect(resolveContentScriptSaveIdempotencyKey(false, undefined, 'short')).toMatchObject({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
    });
    expect(resolveContentScriptSaveIdempotencyKey(false, 'body-key-001', 'header-key-001')).toMatchObject({
      code: 'CONTENT_IDEMPOTENCY_KEY_CONFLICT',
      status: 409,
    });
    expect(resolveContentScriptSaveIdempotencyKey(true, undefined, undefined)).toMatchObject({
      code: 'CONTENT_IDEMPOTENCY_KEY_REQUIRED',
      status: 400,
    });
    expect(resolveContentScriptSaveIdempotencyKey(true, 'body-key-001', 'header-key-001')).toMatchObject({
      code: 'CONTENT_IDEMPOTENCY_KEY_CONFLICT',
      status: 409,
    });
    expect(resolveContentScriptSaveIdempotencyKey(true, 123, undefined)).toMatchObject({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
    });
    expect(resolveContentScriptSaveIdempotencyKey(true, '', 'header-key-001')).toMatchObject({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
    });
    expect(resolveContentScriptSaveIdempotencyKey(true, 'short', undefined)).toMatchObject({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
    });
    expect(resolveContentScriptSaveIdempotencyKey(true, 'save\u0000script-001', undefined)).toMatchObject({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
      details: { field: 'idempotencyKey', reason: 'unsupported_control_characters' },
    });
    expect(resolveContentScriptSaveIdempotencyKey(true, ' save-script-001 ', 'save-script-001')).toEqual({
      value: 'save-script-001',
    });
  });

  it('rejects C0/C1 controls while allowing script formatting whitespace explicitly', () => {
    expect(hasUnsupportedContentControlCharacters('safe topic')).toBe(false);
    expect(hasUnsupportedContentControlCharacters('line one\nline two')).toBe(true);
    expect(hasUnsupportedContentControlCharacters('line one\n\tline two', {
      allowFormattingWhitespace: true,
    })).toBe(false);
    expect(hasUnsupportedContentControlCharacters('unsafe\u0000value', {
      allowFormattingWhitespace: true,
    })).toBe(true);
    expect(hasUnsupportedContentControlCharacters('unsafe\u0085value', {
      allowFormattingWhitespace: true,
    })).toBe(true);
  });

  it('localizes script validation messages', () => {
    expect(invalidScriptFormatMessage('pt-BR')).toBe('o formato deve ser YouTube ou Reel');
    expect(invalidScriptFormatMessage('pt-PT')).toBe('o formato tem de ser YouTube ou Reel');
    expect(invalidScriptFormatMessage('en')).toBe('format must be YouTube or Reel');
    expect(invalidTopicGeneratorFormatMessage('pt-BR')).toBe('o formato deve ser "reel" ou "youtube"');
    expect(invalidTopicGeneratorFormatMessage('pt-PT')).toBe('o formato tem de ser "reel" ou "youtube"');
    expect(invalidTopicGeneratorFormatMessage('en')).toBe('format must be "reel" or "youtube"');
  });
});
