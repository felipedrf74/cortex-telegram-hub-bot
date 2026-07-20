// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ChatResearchAnswerCompleteness =
  | { ok: true }
  | { ok: false; reason: 'empty_answer' | 'too_short' | 'mid_sentence_cutoff' | 'hanging_phrase' };

const TERMINAL_PUNCTUATION_RE = /[.!?。！？)\]"'’”]$/u;
const HANGING_END_RE = /(?:[,;:—-]|\b(?:and|or|of|for|with|to|in|on|at|about|because|when|where|as|the|a|an|e|ou|de|do|da|dos|das|para|por|com|que|quando|onde|como|y|o|del|de la|para|por|con|cuando|donde|como)\b)$/iu;
const RESEARCH_SOURCE_FOOTER_LABELS = new Set([
  'sources consulted',
  'fuentes consultadas',
  'fontes consultadas',
  'sources',
  'fuentes',
  'fontes',
]);

/**
 * Remove the single-line source footer emitted by a research provider.
 *
 * Parsing from the final line keeps this operation linear in the response
 * length and avoids a nested, user-controlled URL regex. Nexus appends its own
 * normalized source footer after this step.
 */
export function stripResearchSourceFooter(text: string): string {
  const trimmedEnd = text.trimEnd();
  const footerStart = trimmedEnd.lastIndexOf('\n');
  if (footerStart < 0) return text;

  const footer = trimmedEnd.slice(footerStart + 1).trim();
  const separator = footer.indexOf(':');
  if (separator <= 0) return text;

  const label = footer.slice(0, separator).trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  if (!RESEARCH_SOURCE_FOOTER_LABELS.has(label)) return text;

  const sources = footer
    .slice(separator + 1)
    .split(/,\s*(?=https?:\/\/)/iu)
    .map((source) => source.trim())
    .filter(Boolean);
  if (
    sources.length === 0
    || sources.some((source) => {
      const normalizedSource = source.toLocaleLowerCase('en-US');
      const schemeLength = normalizedSource.startsWith('https://')
        ? 'https://'.length
        : normalizedSource.startsWith('http://')
          ? 'http://'.length
          : 0;
      return schemeLength === 0 || source.length <= schemeLength || /\s/u.test(source);
    })
  ) {
    return text;
  }

  return trimmedEnd.slice(0, footerStart).trimEnd();
}

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
  return stripResearchSourceFooter(text)
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
