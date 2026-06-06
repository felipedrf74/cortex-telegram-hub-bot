// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from './logger';

const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
const PROMPT_CONTROL_SEQUENCES = [
  '[Current State]',
  '<<__NEXUS_STATE_',
  '[SYSTEM',
  '[ADMIN',
  '[USER]',
  '[ASSISTANT]',
];
const PROMPT_INJECTION_PATTERNS = [
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /###\s*(Instruction|System|User):/gi,
  /<\/?system>/gi,
  /ignore (the|all|previous|above) /gi,
  /(disregard|forget) (the|all|previous|above) /gi,
  /you are now /gi,
  /role[\s_-]*play/gi,
  /pretend (you|to be) /gi,
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
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    text = text.replace(pattern, '[removed instruction-like text]');
  }
  for (const sequence of PROMPT_CONTROL_SEQUENCES) {
    text = text.split(sequence).join('');
  }
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (text.length > 500) {
    const originalLen = text.length;
    text = `${text.slice(0, 400)} … ${text.slice(-100)}`;
    logger.warn({ originalLen }, 'Prompt input truncated');
  }
  return JSON.stringify(text);
}
