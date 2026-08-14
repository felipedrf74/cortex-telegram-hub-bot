// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export function normalizeOllamaModelDigest(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/u, '');
  return /^[0-9a-f]{64}$/u.test(hex) ? `sha256:${hex}` : null;
}

export function ollamaModelDigestsEqual(left, right) {
  const normalizedLeft = normalizeOllamaModelDigest(left);
  return normalizedLeft !== null && normalizedLeft === normalizeOllamaModelDigest(right);
}
