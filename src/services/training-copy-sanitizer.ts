// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Central display-copy guard for Training read models.
 *
 * Normal user-facing strings should never leak debug JSON, selector traces,
 * feature flags, provider IDs, or raw health/calendar internals. Machine fields
 * remain available under meta/debug-like paths so clients can still drive
 * navigation, icons, analytics buckets, and support tooling.
 */

type JsonLike = null | string | number | boolean | JsonLike[] | { [key: string]: JsonLike };

const MACHINE_FIELD_KEYS = new Set([
  'id',
  'target',
  'icon',
  'tint',
  'priority',
  'state',
  'statusTint',
  'source',
  'timestamp',
  'confidence',
  'sessionType',
  'reasonCodes',
  'meta',
  'durationMinutes',
  'adherencePercent',
  'ok',
  'cached',
  'pagination',
  'generatedAt',
  'isFallback',
  'isPartial',
  'isStale',
]);

const UNSAFE_COPY_PATTERNS: RegExp[] = [
  /^\s*[\[{]/,
  /"\s*[^"]+\s*"\s*:/,
  /\[object Object\]/i,
  /\b(?:undefined|null|NaN)\b/,
  /\b(?:selector_trace|selector_policy|raw_validation|validation_result|stack_trace|stacktrace)\b/i,
  /\b(?:feature_flag|featureFlags|catalog_version|support_debug|debug_payload)\b/i,
  /\b(?:database_id|db_id|provider_event_id|calendar_event_id|owner_id|tenant_id|user_id)\b/i,
  /\b(?:conflict_event_title|conflict_event_location|raw_calendar|private_calendar)\b/i,
  /\b(?:illness_symptoms_json|pain_location|pain_score|medical_referral|health_signal)\b/i,
];

const SNAKE_ENUM_TOKEN = /\b[a-z][a-z0-9]+(?:_[a-z0-9]+){1,}\b/g;

const TRAINING_THRESHOLD_TOKENS = new Set([
  'ATL', 'CP', 'CSS', 'CTL', 'FTP', 'HRMAX', 'LTHR', 'MAP', 'MAS', 'MLSS', 'RPE', 'TSS', 'WPRIME',
]);

export interface TrainingCopySanitizerOptions {
  fallback?: string;
}

export function sanitizeTrainingDisplayCopy(
  value: string | null | undefined,
  options: TrainingCopySanitizerOptions = {},
): string {
  const fallback = options.fallback ?? 'Training update';
  const trimmed = typeof value === 'string'
    ? stripTrainingHtmlLikeMarkup(value).replace(/\s+/g, ' ').trim()
    : '';
  if (!trimmed) return fallback;
  if (UNSAFE_COPY_PATTERNS.some((pattern) => pattern.test(trimmed))) return fallback;
  return humanizeRawEnumTokens(trimmed);
}

export function sanitizeTrainingDisplayCopyOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  return sanitizeTrainingDisplayCopy(value);
}

/**
 * Remove HTML-like spans without treating compact Training thresholds as
 * markup. The character scanner cannot reveal a new tag through deletion,
 * while the token exception preserves copy such as "<LT1" and paired
 * comparisons such as "<LT1 ... > 85 rpm".
 */
export function stripTrainingHtmlLikeMarkup(text: string): string {
  let output = '';
  let insideMarkup = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!insideMarkup && character === '<' && startsTrainingHtmlLikeMarkup(text, index)) {
      insideMarkup = true;
      continue;
    }
    if (insideMarkup) {
      if (character === '>') {
        insideMarkup = false;
        output += ' ';
      }
      continue;
    }
    output += character;
  }

  return output.trim();
}

function startsTrainingHtmlLikeMarkup(text: string, openingIndex: number): boolean {
  const firstCharacter = text[openingIndex + 1];
  if (!firstCharacter) return false;
  if (firstCharacter === '/' || firstCharacter === '!' || firstCharacter === '?' || firstCharacter === '<') {
    return true;
  }
  if (!isAsciiLetter(firstCharacter)) return false;

  let cursor = openingIndex + 1;
  while (cursor < text.length && isHtmlTagNameCharacter(text[cursor])) cursor += 1;
  const token = text.slice(openingIndex + 1, cursor);
  const closingIndex = text.indexOf('>', cursor);
  const remainder = text.slice(cursor, closingIndex >= 0 ? closingIndex : text.length);
  if (isTrainingThresholdToken(token) && !hasHtmlAttributeSyntax(remainder)) return false;
  return true;
}

function isTrainingThresholdToken(token: string): boolean {
  const upper = token.toUpperCase();
  return TRAINING_THRESHOLD_TOKENS.has(upper)
    || /^(?:LT|VT|Z|RPE)\d+$/.test(upper)
    || /^VO2(?:MAX)?$/.test(upper);
}

function hasHtmlAttributeSyntax(value: string): boolean {
  return value.includes('=')
    || value.includes('"')
    || value.includes("'")
    || value.includes('`')
    || value.includes('/');
}

function isHtmlTagNameCharacter(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return isAsciiLetter(character) || (code >= 48 && code <= 57) || character === '-';
}

function isAsciiLetter(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function containsUnsafeTrainingDisplayCopy(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return UNSAFE_COPY_PATTERNS.some((pattern) => pattern.test(value));
}

export function sanitizeTrainingUserFacingPayload<T>(payload: T): T {
  return sanitizeValue(payload, null) as T;
}

function sanitizeValue(value: unknown, key: string | null): JsonLike | undefined {
  if (key && MACHINE_FIELD_KEYS.has(key)) return value as JsonLike;
  if (value == null) return value as null;
  if (typeof value === 'string') {
    return sanitizeTrainingDisplayCopy(value, { fallback: fallbackForKey(key) });
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, null) as JsonLike);
  }
  if (typeof value === 'object') {
    const output: { [key: string]: JsonLike } = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = sanitizeValue(childValue, childKey) as JsonLike;
    }
    return output;
  }
  return undefined;
}

function fallbackForKey(key: string | null): string {
  switch (key) {
    case 'title':
    case 'label':
      return 'Training update';
    case 'subtitle':
    case 'summary':
    case 'detail':
    case 'coachSentence':
    case 'effect':
    case 'tip':
      return 'The coach updated this message for display.';
    case 'changedFrom':
    case 'changedTo':
      return 'Updated session';
    default:
      return 'Training update';
  }
}

function humanizeRawEnumTokens(value: string): string {
  return value.replace(SNAKE_ENUM_TOKEN, (token) => token.replace(/_/g, ' '));
}
