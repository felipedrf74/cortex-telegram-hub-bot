// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ChatResearchAnswerCompleteness =
  | { ok: true }
  | { ok: false; reason: 'empty_answer' | 'too_short' | 'mid_sentence_cutoff' | 'hanging_phrase' };

const TERMINAL_PUNCTUATION_RE = /[.!?。！？)\]"'’”]$/u;
const HANGING_END_RE = /(?:[,;:—-]|\b(?:and|or|of|for|with|to|in|on|at|about|because|when|where|as|the|a|an|e|ou|de|do|da|dos|das|para|por|com|que|quando|onde|como|y|o|del|de la|para|por|con|cuando|donde|como)\b)$/iu;

export function assessChatResearchAnswerCompleteness(text: string): ChatResearchAnswerCompleteness {
  const normalized = normalizeResearchAnswerForQuality(text);
  if (!normalized) return { ok: false, reason: 'empty_answer' };
  const wordCount = countWords(normalized);
  if (wordCount < 5) return { ok: false, reason: 'too_short' };

  const lastLine = lastContentLine(normalized);
  const compact = lastLine.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return { ok: false, reason: 'empty_answer' };
  if (HANGING_END_RE.test(compact)) return { ok: false, reason: 'hanging_phrase' };
  if (!TERMINAL_PUNCTUATION_RE.test(compact)) {
    return { ok: false, reason: 'mid_sentence_cutoff' };
  }

  return { ok: true };
}

export function isChatResearchAnswerIncomplete(text: string): boolean {
  return !assessChatResearchAnswerCompleteness(text).ok;
}

function normalizeResearchAnswerForQuality(text: string): string {
  return text
    .replace(
      /\n{1,3}\s*(?:Sources consulted|Fuentes consultadas|Fontes consultadas|Sources|Fuentes|Fontes)\s*:\s*(?:https?:\/\/\S+(?:\s*,\s*)?)+\s*$/iu,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function lastContentLine(text: string): string {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? text.trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}
