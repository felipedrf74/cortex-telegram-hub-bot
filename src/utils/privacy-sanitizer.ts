// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Shared privacy-bounded object sanitizer for event payloads, decision logs,
 * and app-facing sync summaries. It intentionally redacts by key at every
 * nesting level because Nexus event emitters conventionally place data under
 * payload.summary.
 */

const SENSITIVE_PAYLOAD_KEY_PATTERN =
  /token|secret|password|prompt|raw|draft|script|calendar|calendarTitle|merchant|vendor|amount|taxDue|category|body|text|title|description|notes|email|phone|address|transcript|journalEntry|messageContent|destinationEmail/i;

export function sanitizePrivacyValue(
  value: unknown,
  opts: { depth?: number; maxDepth?: number; maxStringLength?: number } = {},
): unknown {
  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? 4;
  const maxStringLength = opts.maxStringLength ?? 500;

  if (typeof value === 'string') {
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}...`
      : value;
  }

  if (value == null || typeof value !== 'object') return value;
  if (depth >= maxDepth) return '[redacted]';

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePrivacyValue(item, { ...opts, depth: depth + 1 }));
  }

  const out: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_PAYLOAD_KEY_PATTERN.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitizePrivacyValue(candidate, { ...opts, depth: depth + 1 });
  }
  return out;
}

export function sanitizePrivacyObject(
  value: Record<string, unknown>,
  opts: { maxDepth?: number; maxStringLength?: number } = {},
): Record<string, unknown> {
  const sanitized = sanitizePrivacyValue(value, opts);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
}

