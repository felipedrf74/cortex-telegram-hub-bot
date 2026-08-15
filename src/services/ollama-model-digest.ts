// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Ollama installations have returned both bare 64-hex digests and
 * `sha256:`-prefixed digests from `/api/tags`. Nexus stores the canonical
 * prefixed form in the signed manifest and at every persistence boundary.
 */
export function normalizeOllamaModelDigest(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/u, '');
  return /^[0-9a-f]{64}$/u.test(hex) ? `sha256:${hex}` : null;
}

export function ollamaModelDigestsEqual(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeOllamaModelDigest(left);
  return normalizedLeft !== null && normalizedLeft === normalizeOllamaModelDigest(right);
}
