// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  inspectContentCreativeShortcut,
  parseContentCreativeShortcut,
  parseContentScriptShortcut,
  parseContentStateShortcut,
  parseFinanceStateShortcut,
  resolveContentShortcutLanguage,
  resolveFinanceShortcutLanguage,
  resolveRequestedScriptLanguage,
  normalizeScriptLanguage,
} from '../../src/api/routes/chat-shortcut-parsers';

describe('chat shortcut parsers', () => {
  it('parses each advertised Content creative slash command without losing its subject', () => {
    expect(parseContentCreativeShortcut('/hooks A calm product launch')).toEqual({
      operation: 'hooks',
      topic: 'A calm product launch',
    });
    expect(parseContentCreativeShortcut('/titles A calm product launch')).toEqual({
      operation: 'titles',
      topic: 'A calm product launch',
    });
    expect(parseContentCreativeShortcut('/genthumbnail A calm product launch')).toEqual({
      operation: 'thumbnail',
      topic: 'A calm product launch',
      title: 'A calm product launch',
    });
    expect(parseContentCreativeShortcut('/gencaption A calm product launch')).toEqual({
      operation: 'caption',
      topic: 'A calm product launch',
    });
    expect(parseContentCreativeShortcut('/repurpose A long source draft')).toEqual({
      operation: 'repurpose',
      topic: 'A long source draft',
      sourceContent: 'A long source draft',
    });
  });

  it('does not reinterpret natural-language creative requests as explicit slash commands', () => {
    expect(parseContentCreativeShortcut('Give me hooks for a product launch')).toBeNull();
    expect(parseContentCreativeShortcut('/hooks')).toBeNull();
  });

  it('rejects control-bearing and route-oversized creative slash commands', () => {
    expect(parseContentCreativeShortcut('/hooks safe\u0000hidden')).toBeNull();
    expect(parseContentCreativeShortcut('/hooks first line\nsecond line')).toBeNull();
    expect(parseContentCreativeShortcut(`/hooks ${'x'.repeat(2_001)}`)).toBeNull();
    expect(parseContentCreativeShortcut(`/genthumbnail ${'x'.repeat(1_401)}`)).toBeNull();
    expect(parseContentCreativeShortcut('/repurpose line one\nline two')).toMatchObject({
      operation: 'repurpose',
      topic: 'line one line two',
      sourceContent: 'line one\nline two',
    });
  });

  it('distinguishes malformed advertised commands from unrelated text', () => {
    expect(inspectContentCreativeShortcut('Give me hooks')).toEqual({ status: 'not_recognized' });
    expect(inspectContentCreativeShortcut('/hooks')).toEqual({
      status: 'invalid',
      command: 'hooks',
      reason: 'subject_required',
    });
    expect(inspectContentCreativeShortcut('/titles first line\nsecond line')).toEqual({
      status: 'invalid',
      command: 'titles',
      reason: 'single_line_required',
    });
    expect(inspectContentCreativeShortcut('/hooks-extra topic')).toEqual({ status: 'not_recognized' });
  });

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
    expect(normalizeScriptLanguage('es-419')).toBe('en-US');
    expect(normalizeScriptLanguage('de-DE')).toBe('en-US');
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
