// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Lang } from '../../utils/i18n';

const YOUTUBE_SCRIPT_PRESET_SECONDS = [480, 600, 900] as const;
const SHORT_SCRIPT_PRESET_SECONDS = [15, 30, 45, 60] as const;
export const CONTENT_SCRIPT_MAX_TOPIC_CHARS = 2_000;
export const CONTENT_SCRIPT_MAX_NICHE_CHARS = 160;
export const CONTENT_SCRIPT_MAX_REGENERATION_SEED_CHARS = 120;
export const CONTENT_SCRIPT_MAX_HOOK_IDEA_CHARS = 500;
export const CONTENT_SCRIPT_MAX_WHY_NOW_CHARS = 1_000;
export const CONTENT_SCRIPT_MAX_ANGLE_TAG_CHARS = 160;
export const CONTENT_SCRIPT_IDEMPOTENCY_KEY_MIN_CHARS = 8;
export const CONTENT_SCRIPT_IDEMPOTENCY_KEY_MAX_CHARS = 200;

export type ContentScriptSaveIdempotencyResolution =
  | { value: string }
  | { code: string; message: string; status: number; details?: Record<string, unknown> };

export interface ContentScriptRequestContractViolation {
  field: string;
  message: string;
}

const CONTENT_SCRIPT_REQUEST_ENUMS = {
  format: ['YouTube', 'Reel'],
  mode: ['draft', 'quick', 'standard', 'deep'],
  language: ['en-US', 'pt-PT', 'pt-BR'],
  renderMode: ['structured', 'chat'],
  scriptStyle: ['detailed', 'bullets'],
} as const;

const CONTENT_SCRIPT_LEGACY_STYLE_ALIASES = {
  bullet: 'bullets',
  bullets: 'bullets',
  outline: 'bullets',
  pontos: 'bullets',
  detailed: 'detailed',
  full: 'detailed',
  script: 'detailed',
  roteiro: 'detailed',
  completo: 'detailed',
} as const;

/**
 * Validate explicitly supplied public script selectors before legacy
 * normalization. Internal callers may still use the tolerant normalizers, but
 * the HTTP boundary must honor its closed OpenAPI schema instead of silently
 * changing caller intent.
 */
export function validateExplicitContentScriptRequestFields(
  input: Record<string, unknown>,
  options: { booleanFields?: readonly string[]; allowLegacyStyle?: boolean } = {},
): ContentScriptRequestContractViolation | null {
  for (const [field, allowed] of Object.entries(CONTENT_SCRIPT_REQUEST_ENUMS)) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      return {
        field,
        message: `${field} must be one of: ${allowed.join(', ')}.`,
      };
    }
  }

  if (options.allowLegacyStyle && input.style !== undefined) {
    if (
      typeof input.style !== 'string'
      || !Object.prototype.hasOwnProperty.call(CONTENT_SCRIPT_LEGACY_STYLE_ALIASES, input.style)
    ) {
      return {
        field: 'style',
        message: `style must be one of: ${Object.keys(CONTENT_SCRIPT_LEGACY_STYLE_ALIASES).join(', ')}.`,
      };
    }
    if (
      input.scriptStyle !== undefined
      && input.scriptStyle !== CONTENT_SCRIPT_LEGACY_STYLE_ALIASES[
        input.style as keyof typeof CONTENT_SCRIPT_LEGACY_STYLE_ALIASES
      ]
    ) {
      return {
        field: 'style',
        message: 'style and scriptStyle must resolve to the same script style when both are supplied.',
      };
    }
  }

  for (const field of ['maxDurationMinutes', 'targetDurationSeconds'] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      return { field, message: `${field} must be a positive integer.` };
    }
  }

  for (const field of options.booleanFields ?? []) {
    const value = input[field];
    if (value !== undefined && typeof value !== 'boolean') {
      return { field, message: `${field} must be a boolean.` };
    }
  }
  return null;
}

/** Reject non-printing C0/C1 input before it reaches prompts, logs, or keys. */
export function hasUnsupportedContentControlCharacters(
  value: string,
  options: { allowFormattingWhitespace?: boolean } = {},
): boolean {
  return options.allowFormattingWhitespace
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)
    : /[\u0000-\u001F\u007F-\u009F]/u.test(value);
}

export function resolveContentScriptSaveIdempotencyKey(
  saveToIdeas: unknown,
  bodyValue: unknown,
  headerValue: string | undefined,
): ContentScriptSaveIdempotencyResolution | null {
  if (bodyValue !== undefined && typeof bodyValue !== 'string') {
    return {
      code: 'CONTENT_VALIDATION_FAILED',
      message: 'idempotencyKey must be a string.',
      status: 400,
      details: { field: 'idempotencyKey' },
    };
  }

  const bodyKey = typeof bodyValue === 'string' ? bodyValue.trim() : '';
  const headerKey = (headerValue ?? '').trim();
  const suppliedKeys = [
    ...(bodyValue !== undefined ? [bodyKey] : []),
    ...(headerValue !== undefined ? [headerKey] : []),
  ];
  if (suppliedKeys.some((value) => (
    value.length < CONTENT_SCRIPT_IDEMPOTENCY_KEY_MIN_CHARS
    || value.length > CONTENT_SCRIPT_IDEMPOTENCY_KEY_MAX_CHARS
  ))) {
    return {
      code: 'CONTENT_VALIDATION_FAILED',
      message: `idempotencyKey must contain ${CONTENT_SCRIPT_IDEMPOTENCY_KEY_MIN_CHARS}-${CONTENT_SCRIPT_IDEMPOTENCY_KEY_MAX_CHARS} characters.`,
      status: 400,
      details: { field: 'idempotencyKey' },
    };
  }
  if (suppliedKeys.some((value) => hasUnsupportedContentControlCharacters(value))) {
    return {
      code: 'CONTENT_VALIDATION_FAILED',
      message: 'idempotencyKey contains unsupported control characters.',
      status: 400,
      details: { field: 'idempotencyKey', reason: 'unsupported_control_characters' },
    };
  }
  if (bodyKey && headerKey && bodyKey !== headerKey) {
    return {
      code: 'CONTENT_IDEMPOTENCY_KEY_CONFLICT',
      message: 'Body and header idempotency keys must match.',
      status: 409,
      details: { field: 'idempotencyKey' },
    };
  }
  if (saveToIdeas !== true) return null;

  const value = bodyKey || headerKey;
  if (!value) {
    return {
      code: 'CONTENT_IDEMPOTENCY_KEY_REQUIRED',
      message: 'An idempotency key is required when saveToIdeas is true.',
      status: 400,
      details: { field: 'idempotencyKey' },
    };
  }
  return { value };
}

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
    if (parsedMaxDurationMinutes != null && parsedMaxDurationMinutes !== 1) {
      return { error: 'Reel maxDurationMinutes must stay at 1 minute; use targetDurationSeconds for 15/30/45/60-second presets' };
    }
    if (parsedTargetDurationSeconds != null) {
      if (!SHORT_SCRIPT_PRESET_SECONDS.includes(parsedTargetDurationSeconds as (typeof SHORT_SCRIPT_PRESET_SECONDS)[number])) {
        return { error: 'Reel duration must be one of 15, 30, 45, or 60 seconds' };
      }
      return { maxDurationMinutes: 1, targetDurationSeconds: parsedTargetDurationSeconds };
    }
    return { maxDurationMinutes: 1, targetDurationSeconds: 60 };
  }

  if (parsedMaxDurationMinutes != null && ![8, 10, 15].includes(parsedMaxDurationMinutes)) {
    return { error: 'YouTube maxDurationMinutes must be one of 8, 10, or 15' };
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
