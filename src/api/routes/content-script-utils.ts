// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Lang } from '../../utils/i18n';

const YOUTUBE_SCRIPT_PRESET_SECONDS = [480, 600, 900] as const;
const SHORT_SCRIPT_PRESET_SECONDS = [15, 30, 45, 60] as const;

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

export function normalizeScriptFormat(value: unknown): 'YouTube' | 'Reel' | null {
  if (typeof value !== 'string' || value.trim().length === 0) return 'YouTube';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'youtube') return 'YouTube';
  if (['reel', 'short', 'shorts', 'instagram', 'instagram short', 'instagram shorts'].includes(normalized)) {
    return 'Reel';
  }
  return null;
}

export function resolveScriptDurationPreset(
  format: 'YouTube' | 'Reel',
  rawMaxDurationMinutes: unknown,
  rawTargetDurationSeconds: unknown,
): { maxDurationMinutes: number; targetDurationSeconds: number } | { error: string } {
  const parsedTargetDurationSeconds = parseOptionalPositiveInt(rawTargetDurationSeconds);
  const parsedMaxDurationMinutes = parseOptionalPositiveInt(rawMaxDurationMinutes);

  if (format === 'Reel') {
    if (parsedTargetDurationSeconds != null) {
      if (!SHORT_SCRIPT_PRESET_SECONDS.includes(parsedTargetDurationSeconds as (typeof SHORT_SCRIPT_PRESET_SECONDS)[number])) {
        return { error: 'Reel duration must be one of 15, 30, 45, or 60 seconds' };
      }
      return { maxDurationMinutes: 1, targetDurationSeconds: parsedTargetDurationSeconds };
    }
    if (parsedMaxDurationMinutes != null && parsedMaxDurationMinutes !== 1) {
      return { error: 'Reel maxDurationMinutes must stay at 1 minute; use targetDurationSeconds for 15/30/45/60-second presets' };
    }
    return { maxDurationMinutes: 1, targetDurationSeconds: 60 };
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
  if (language === 'pt-BR') return 'o formato deve ser YouTube ou Reel';
  if (language.startsWith('pt')) return 'o formato tem de ser YouTube ou Reel';
  return 'format must be YouTube or Reel';
}

export function invalidTopicGeneratorFormatMessage(language: Lang): string {
  if (language === 'pt-BR') return 'o formato deve ser "reel" ou "youtube"';
  if (language.startsWith('pt')) return 'o formato tem de ser "reel" ou "youtube"';
  return 'format must be "reel" or "youtube"';
}
