// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  invalidScriptFormatMessage,
  invalidTopicGeneratorFormatMessage,
  normalizeScriptFormat,
  parseOptionalPositiveInt,
  resolveScriptDurationPreset,
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
    expect(normalizeScriptFormat('shorts')).toBe('YouTube Shorts');
    expect(normalizeScriptFormat('youtube_shorts')).toBe('YouTube Shorts');
    expect(normalizeScriptFormat('instagram short')).toBe('Reel');
    expect(normalizeScriptFormat('tiktok')).toBe('TikTok');
    expect(normalizeScriptFormat('linkedin_post')).toBe('LinkedIn Post');
    expect(normalizeScriptFormat('x thread')).toBe('X Thread');
    expect(normalizeScriptFormat('newsletter')).toBe('Newsletter');
    expect(normalizeScriptFormat('blog')).toBe('Blog');
    expect(normalizeScriptFormat('carousel')).toBe('Carousel');
    expect(normalizeScriptFormat('podcast')).toBeNull();
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
  });

  it('resolves supported text-first duration presets', () => {
    expect(resolveScriptDurationPreset('LinkedIn Post', undefined, undefined)).toEqual({
      maxDurationMinutes: 5,
      targetDurationSeconds: 300,
    });
    expect(resolveScriptDurationPreset('X Thread', undefined, 480)).toEqual({
      maxDurationMinutes: 8,
      targetDurationSeconds: 480,
    });
    expect(resolveScriptDurationPreset('Newsletter', 10, undefined)).toEqual({
      maxDurationMinutes: 10,
      targetDurationSeconds: 600,
    });
    expect(resolveScriptDurationPreset('Blog', 12, undefined)).toEqual({
      error: 'Blog maxDurationMinutes must be one of 5, 8, or 10',
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
  });

  it('localizes script validation messages', () => {
    expect(invalidScriptFormatMessage('pt-BR')).toContain('TikTok');
    expect(invalidScriptFormatMessage('pt-PT')).toContain('Newsletter');
    expect(invalidScriptFormatMessage('en')).toContain('Carousel');
    expect(invalidTopicGeneratorFormatMessage('pt-BR')).toBe('o formato deve ser "reel" ou "youtube"');
    expect(invalidTopicGeneratorFormatMessage('pt-PT')).toBe('o formato tem de ser "reel" ou "youtube"');
    expect(invalidTopicGeneratorFormatMessage('en')).toBe('format must be "reel" or "youtube"');
  });
});
