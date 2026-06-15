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

export interface TrainingCopySanitizerOptions {
  fallback?: string;
}

export function sanitizeTrainingDisplayCopy(
  value: string | null | undefined,
  options: TrainingCopySanitizerOptions = {},
): string {
  const fallback = options.fallback ?? 'Training update';
  const trimmed = typeof value === 'string'
    ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (!trimmed) return fallback;
  if (UNSAFE_COPY_PATTERNS.some((pattern) => pattern.test(trimmed))) return fallback;
  return humanizeRawEnumTokens(trimmed);
}

export function sanitizeTrainingDisplayCopyOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  return sanitizeTrainingDisplayCopy(value);
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
