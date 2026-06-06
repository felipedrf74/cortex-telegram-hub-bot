// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Token estimator (conservative).
 *
 * v2.6 (angry-QA-found): the previous estimator was `chars / 3` only.
 * For English that over-estimates (good). But `String.length` counts
 * UTF-16 code units, so a 500-char Chinese prompt (1500 UTF-8 bytes,
 * ~500-650 Qwen tokens depending on the BPE merges) estimated 167
 * tokens — about 3× under-estimate. The local model would then accept
 * a prompt 3× the cap and either OOM the context or thrash.
 *
 * Fix: take max of `chars / 3` and `utf8_bytes / 3`. UTF-8 byte length
 * is a strict upper bound for Qwen-class BPE on any script (the worst
 * case is one token per byte for unfamiliar code points). For ASCII
 * input both estimators give the same result. For CJK/emoji/Arabic the
 * byte estimate dominates and produces the correct (over-)estimate.
 *
 * Replace with a real tokenizer (e.g., a JS port of Qwen's BPE) when
 * one is available. Plan Revision 4 amendment A10.
 */

const utf8Encoder = new TextEncoder();

/**
 * Returns a conservative upper-bound token count for the given text.
 * For nullish or empty input returns 0.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const charBased = Math.ceil(text.length / 3);
  const byteBased = Math.ceil(utf8Encoder.encode(text).length / 3);
  return Math.max(charBased, byteBased);
}

/**
 * Sum estimated tokens across an array of strings (e.g., a message
 * history). Returns 0 for an empty array.
 */
export function estimateTokensTotal(parts: ReadonlyArray<string | null | undefined>): number {
  let total = 0;
  for (const p of parts) total += estimateTokens(p);
  return total;
}
