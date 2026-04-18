// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getUserLanguage } from './user-service';

function preserveCase(template: string, replacement: string): string {
  if (template === template.toUpperCase()) return replacement.toUpperCase();
  if (template[0] && template[0] === template[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function replaceWord(text: string, pattern: RegExp, replacement: string): string {
  return text.replace(pattern, (match) => preserveCase(match, replacement));
}

export function normalizeReplyForLanguage(text: string, language: string): string {
  if (!text || language !== 'pt-BR') return text;

  let normalized = text;

  const phraseReplacements: Array<[RegExp, string]> = [
    [/\bpara ti\b/gi, 'para você'],
    [/\bcom contigo\b/gi, 'com você'],
    [/\bcontigo\b/gi, 'com você'],
    [/pequeno-almoço/gi, 'café da manhã'],
    [/telemóvel/gi, 'celular'],
    [/ecrã/gi, 'tela'],
    [/\bestá a\b/gi, 'está'],
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    normalized = normalized.replace(pattern, (match) => preserveCase(match, replacement));
  }

  const wordReplacements: Array<[RegExp, string]> = [
    [/\bteu\b/gi, 'seu'],
    [/\bteus\b/gi, 'seus'],
    [/\btua\b/gi, 'sua'],
    [/\btuas\b/gi, 'suas'],
  ];

  for (const [pattern, replacement] of wordReplacements) {
    normalized = replaceWord(normalized, pattern, replacement);
  }

  return normalized;
}

export function normalizeReplyForUserLanguage(text: string, userId?: number): string {
  if (!text || typeof userId !== 'number') return text;

  try {
    const language = getUserLanguage(userId);
    return normalizeReplyForLanguage(text, language);
  } catch {
    return text;
  }
}
