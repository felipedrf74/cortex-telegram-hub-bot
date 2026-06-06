// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Builds an opaque per-request state-context envelope for model prompts.
 *
 * The delimiter intentionally does not reuse human-readable markers like
 * "[Current State]". A user can type that literal string in their message; it
 * must never be interpreted as the trusted state block boundary.
 */
export function buildScopedStateContextPrefix(stateContext: string | null | undefined): string {
  const trimmed = stateContext?.trim();
  if (!trimmed) return '';
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `<<__NEXUS_STATE_BEGIN__-${nonce}>>\n${trimmed}\n<<__NEXUS_STATE_END__-${nonce}>>\n\n`;
}
