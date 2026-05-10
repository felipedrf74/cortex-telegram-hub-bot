// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
const PROMPT_CONTROL_SEQUENCES = [
  '[Current State]',
  '<<__NEXUS_STATE_',
  '[SYSTEM',
  '[ADMIN',
  '[USER]',
  '[ASSISTANT]',
];

/**
 * Treat untrusted user/provider text as inert prompt data.
 *
 * The return value is JSON-stringified on purpose: prompt builders can embed it
 * directly and the model sees a data literal, not a new instruction block.
 */
export function sanitizeForPromptInterpolation(value: unknown): string {
  let text = String(value ?? '');
  text = text.replace(CONTROL_CHARS, ' ');
  text = text.replace(/<<__NEXUS_STATE_[A-Z_]*__?/gi, '');
  text = text.replace(/\[(SYSTEM|ADMIN|USER|ASSISTANT)\]?/gi, '');
  for (const sequence of PROMPT_CONTROL_SEQUENCES) {
    text = text.split(sequence).join('');
  }
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (text.length > 500) {
    text = text.slice(0, 500);
  }
  return JSON.stringify(text);
}
