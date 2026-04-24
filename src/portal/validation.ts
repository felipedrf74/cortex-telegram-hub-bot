// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Safely parse a JSON array stored in a TEXT column. Returns `[]`
 *  for null/empty/malformed input — the caller treats the result as
 *  authoritative but defensive. */
export function safeJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Safely parse a JSON object stored in a TEXT column. Returns `{}`
 *  for null/empty/malformed input. */
export function safeJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Lightweight email shape check used by portal admin-mutation routes.
 * Rejects obviously malformed strings without pretending to be a full
 * RFC-5322 validator.
 */
export function isLikelyEmail(candidate: string): boolean {
  if (typeof candidate !== 'string') return false;
  const trimmed = candidate.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return false;
  if (/\s/.test(trimmed)) return false;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false;
  const domain = trimmed.slice(at + 1);
  if (!domain.includes('.')) return false;
  return true;
}
