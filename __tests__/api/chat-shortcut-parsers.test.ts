// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  parseContentScriptShortcut,
  parseContentStateShortcut,
  parseFinanceStateShortcut,
  resolveContentShortcutLanguage,
  resolveFinanceShortcutLanguage,
  resolveRequestedScriptLanguage,
} from '../../src/api/routes/chat-shortcut-parsers';

describe('chat shortcut parsers', () => {
  it('parses content script generation shortcuts without language qualifiers in the topic', () => {
    expect(parseContentScriptShortcut('Escreve um roteiro curto sobre recuperação depois de intervalos duros em português europeu')).toEqual({
      topic: 'recuperação depois de intervalos duros',
      format: 'Reel',
      mode: 'quick',
      maxDurationMinutes: 1,
    });

    expect(parseContentScriptShortcut('Write a script about budget-friendly meal prep in English')).toEqual({
      topic: 'budget-friendly meal prep',
      format: 'YouTube',
      mode: 'standard',
      maxDurationMinutes: 8,
    });
  });

  it('does not mistake script refinement follow-ups for new generation requests', () => {
    expect(parseContentScriptShortcut('rewrite this script')).toBeNull();
    expect(parseContentScriptShortcut('melhora este roteiro')).toBeNull();
    expect(parseContentScriptShortcut(`Write a script about${' '.repeat(4_097)}x`)).toBeNull();
  });

  it('resolves requested script language explicitly before falling back to user preference', () => {
    expect(resolveRequestedScriptLanguage('gera um roteiro em português europeu', 'en-US')).toBe('pt-PT');
    expect(resolveRequestedScriptLanguage('write a script in English', 'pt-BR')).toBe('en-US');
    expect(resolveRequestedScriptLanguage('gera um roteiro', 'pt-PT')).toBe('pt-PT');
  });

  it('detects content shortcut language from English wording when no explicit qualifier exists', () => {
    expect(resolveContentShortcutLanguage('what content is already ready on my desk?', 'pt-BR')).toBe('en-US');
    expect(resolveContentShortcutLanguage('o que já está pronto na minha mesa?', 'en-US')).toBe('en-US');
  });

  it('classifies content state shortcuts in Portuguese and English', () => {
    expect(parseContentStateShortcut('o que já está pronto na minha mesa?')).toBe('desk');
    expect(parseContentStateShortcut('what format is winning?')).toBe('learning');
    expect(parseContentStateShortcut('qual conteúdo devo publicar a seguir?')).toBe('next_publish');
  });

  it('classifies finance state shortcuts and resolves finance language safely', () => {
    expect(parseFinanceStateShortcut("what's my budget remaining this month?")).toBe('budget_remaining');
    expect(parseFinanceStateShortcut('o que devo enviar ao meu contabilista?')).toBe('accountant_bundle');
    expect(parseFinanceStateShortcut('que faturas registei este mês?')).toBe('filed_invoices');

    expect(resolveFinanceShortcutLanguage(null)).toBe('en-US');
    expect(resolveFinanceShortcutLanguage('pt-PT')).toBe('pt-PT');
    expect(resolveFinanceShortcutLanguage('pt-BR')).toBe('pt-BR');
  });
});
