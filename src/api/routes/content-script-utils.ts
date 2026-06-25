// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Lang } from '../../utils/i18n';

const YOUTUBE_SCRIPT_PRESET_SECONDS = [480, 600, 900] as const;
const SHORT_SCRIPT_PRESET_SECONDS = [15, 30, 45, 60] as const;
const TEXT_SCRIPT_PRESET_SECONDS = [300, 480, 600] as const;

export type NormalizedScriptFormat =
  | 'YouTube'
  | 'YouTube Shorts'
  | 'Reel'
  | 'TikTok'
  | 'LinkedIn Post'
  | 'X Thread'
  | 'Newsletter'
  | 'Blog'
  | 'Carousel';

export function parseOptionalPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return null;
}

export function normalizeScriptFormat(value: unknown): NormalizedScriptFormat | null {
  if (typeof value !== 'string' || value.trim().length === 0) return 'YouTube';
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (['youtube', 'youtube_long_form', 'long_form', 'longform'].includes(normalized)) return 'YouTube';
  if (['youtube_shorts', 'youtube_short', 'shorts', 'short'].includes(normalized)) return 'YouTube Shorts';
  if (['reel', 'reels', 'instagram', 'instagram_reel', 'instagram_short', 'instagram_shorts'].includes(normalized)) {
    return 'Reel';
  }
  if (['tiktok', 'tik_tok'].includes(normalized)) return 'TikTok';
  if (['linkedin', 'linkedin_post'].includes(normalized)) return 'LinkedIn Post';
  if (['x', 'twitter', 'x_thread', 'twitter_thread', 'thread'].includes(normalized)) return 'X Thread';
  if (normalized === 'newsletter') return 'Newsletter';
  if (normalized === 'blog') return 'Blog';
  if (normalized === 'carousel') return 'Carousel';
  return null;
}

export function resolveScriptDurationPreset(
  format: NormalizedScriptFormat,
  rawMaxDurationMinutes: unknown,
  rawTargetDurationSeconds: unknown,
): { maxDurationMinutes: number; targetDurationSeconds: number } | { error: string } {
  const parsedTargetDurationSeconds = parseOptionalPositiveInt(rawTargetDurationSeconds);
  const parsedMaxDurationMinutes = parseOptionalPositiveInt(rawMaxDurationMinutes);

  if (isShortFormScriptFormat(format)) {
    if (parsedTargetDurationSeconds != null) {
      if (!SHORT_SCRIPT_PRESET_SECONDS.includes(parsedTargetDurationSeconds as (typeof SHORT_SCRIPT_PRESET_SECONDS)[number])) {
        return { error: `${format} duration must be one of 15, 30, 45, or 60 seconds` };
      }
      return { maxDurationMinutes: 1, targetDurationSeconds: parsedTargetDurationSeconds };
    }
    if (parsedMaxDurationMinutes != null && parsedMaxDurationMinutes !== 1) {
      return { error: `${format} maxDurationMinutes must stay at 1 minute; use targetDurationSeconds for 15/30/45/60-second presets` };
    }
    return { maxDurationMinutes: 1, targetDurationSeconds: 60 };
  }

  if (isTextFirstScriptFormat(format)) {
    if (parsedTargetDurationSeconds != null) {
      if (!TEXT_SCRIPT_PRESET_SECONDS.includes(parsedTargetDurationSeconds as (typeof TEXT_SCRIPT_PRESET_SECONDS)[number])) {
        return { error: `${format} duration must be one of 5, 8, or 10 minutes` };
      }
      return {
        maxDurationMinutes: Math.round(parsedTargetDurationSeconds / 60),
        targetDurationSeconds: parsedTargetDurationSeconds,
      };
    }
    const maxDurationMinutes = parsedMaxDurationMinutes ?? 5;
    if (![5, 8, 10].includes(maxDurationMinutes)) {
      return { error: `${format} maxDurationMinutes must be one of 5, 8, or 10` };
    }
    return {
      maxDurationMinutes,
      targetDurationSeconds: maxDurationMinutes * 60,
    };
  }

  if (parsedTargetDurationSeconds != null) {
    if (!YOUTUBE_SCRIPT_PRESET_SECONDS.includes(parsedTargetDurationSeconds as (typeof YOUTUBE_SCRIPT_PRESET_SECONDS)[number])) {
      return { error: 'YouTube duration must be one of 8, 10, or 15 minutes' };
    }
    return {
      maxDurationMinutes: Math.round(parsedTargetDurationSeconds / 60),
      targetDurationSeconds: parsedTargetDurationSeconds,
    };
  }

  if (parsedMaxDurationMinutes != null) {
    if (![8, 10, 15].includes(parsedMaxDurationMinutes)) {
      return { error: 'YouTube maxDurationMinutes must be one of 8, 10, or 15' };
    }
    return {
      maxDurationMinutes: parsedMaxDurationMinutes,
      targetDurationSeconds: parsedMaxDurationMinutes * 60,
    };
  }

  return { maxDurationMinutes: 8, targetDurationSeconds: 8 * 60 };
}

export function invalidScriptFormatMessage(language: Lang): string {
  if (language === 'pt-BR') return 'o formato deve ser YouTube, Shorts, Reel, TikTok, LinkedIn, X Thread, Newsletter, Blog ou Carousel';
  if (language.startsWith('pt')) return 'o formato tem de ser YouTube, Shorts, Reel, TikTok, LinkedIn, X Thread, Newsletter, Blog ou Carousel';
  return 'format must be YouTube, Shorts, Reel, TikTok, LinkedIn, X Thread, Newsletter, Blog, or Carousel';
}

export function invalidTopicGeneratorFormatMessage(language: Lang): string {
  if (language === 'pt-BR') return 'o formato deve ser "reel" ou "youtube"';
  if (language.startsWith('pt')) return 'o formato tem de ser "reel" ou "youtube"';
  return 'format must be "reel" or "youtube"';
}

export function isShortFormScriptFormat(format: NormalizedScriptFormat): boolean {
  return format === 'Reel' || format === 'TikTok' || format === 'YouTube Shorts';
}

export function isTextFirstScriptFormat(format: NormalizedScriptFormat): boolean {
  return format === 'LinkedIn Post'
    || format === 'X Thread'
    || format === 'Newsletter'
    || format === 'Blog'
    || format === 'Carousel';
}

export function scriptPlatformIdForFormat(format: NormalizedScriptFormat): string {
  switch (format) {
    case 'YouTube':
      return 'youtube';
    case 'YouTube Shorts':
      return 'youtube_shorts';
    case 'Reel':
      return 'instagram';
    case 'TikTok':
      return 'tiktok';
    case 'LinkedIn Post':
      return 'linkedin';
    case 'X Thread':
      return 'x_twitter';
    case 'Newsletter':
      return 'newsletter';
    case 'Blog':
      return 'blog';
    case 'Carousel':
      return 'instagram';
    default:
      return 'generic';
  }
}
