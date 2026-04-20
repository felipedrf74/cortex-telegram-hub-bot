import { describe, expect, it } from 'vitest';
import { buildReplyLanguageInstruction, resolveReplyLanguage } from '../../src/services/anthropic';

describe('buildReplyLanguageInstruction', () => {
  it('adds explicit pt-BR regional guidance', () => {
    const instruction = buildReplyLanguageInstruction('pt-BR');

    expect(instruction).toContain('Responda em pt-BR');
    expect(instruction).toContain('Use vocabulário e construções naturais de pt-BR.');
    expect(instruction).toContain('Evite vocabulário típico de português europeu');
    expect(instruction).toContain('"tu", "ti", "contigo"');
    expect(instruction).toContain('Estas regras de idioma têm prioridade');
  });

  it('adds explicit pt-PT regional guidance', () => {
    const instruction = buildReplyLanguageInstruction('pt-PT');

    expect(instruction).toContain('Responda em português europeu');
    expect(instruction).toContain('Use vocabulário e construções naturais de português europeu.');
    expect(instruction).toContain('Evite vocabulário típico do Brasil');
    expect(instruction).toContain('"você", "ônibus", "celular"');
    expect(instruction).toContain('Estas regras de idioma têm prioridade');
  });

  it('tells English replies to override PT-BR prompt defaults', () => {
    const instruction = buildReplyLanguageInstruction('en-US');

    expect(instruction).toContain('Reply in English unless the user explicitly asks to switch languages.');
    expect(instruction).toContain('Do not answer in Portuguese unless the user explicitly asks for Portuguese.');
    expect(instruction).toContain('override any conflicting creator-config');
    expect(instruction).toContain('If the base prompt mentions PT-BR');
    expect(instruction).toContain('keep generated titles, hooks, captions, outlines, and scripts in English too');
    expect(instruction).toContain('rewrite any Portuguese draft text back into English');
    expect(instruction).toContain('Every heading, bullet label, meal name, menu title, and checklist item must be in English too.');
  });
});

describe('resolveReplyLanguage', () => {
  it('switches a pt-BR user to English when the current message is clearly English', () => {
    expect(
      resolveReplyLanguage('pt-BR', "is tomorrow's tempo ride too much after the heavy leg load?"),
    ).toBe('en-US');
  });

  it('keeps explicit pt-PT requests in European Portuguese', () => {
    expect(
      resolveReplyLanguage('en-US', 'podes responder em português europeu?'),
    ).toBe('pt-PT');
  });

  it('keeps explicit pt-BR requests in Brazilian Portuguese', () => {
    expect(
      resolveReplyLanguage('en-US', 'responde em pt-BR por favor'),
    ).toBe('pt-BR');
  });

  it('switches an english-profile user to Brazilian Portuguese when the current message is clearly pt-BR', () => {
    expect(
      resolveReplyLanguage('en-US', 'como conservo cenoura ralada na geladeira por vários dias?'),
    ).toBe('pt-BR');
  });

  it('switches an english-profile user to European Portuguese when the current message is clearly pt-PT', () => {
    expect(
      resolveReplyLanguage('en-US', 'podes rever a minha agenda no telemóvel e mover a reunião para amanhã?'),
    ).toBe('pt-PT');
  });
});
