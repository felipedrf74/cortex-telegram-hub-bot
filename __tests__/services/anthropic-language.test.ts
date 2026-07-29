import { describe, expect, it } from 'vitest';
import {
  buildReplyLanguageInstruction,
  resolveReplyLanguage,
  resolveReplyLanguageForCurrentRequest,
} from '../../src/services/anthropic';
import { runWithChatRequestLocale } from '../../src/services/chat-request-locale-context';

describe('buildReplyLanguageInstruction', () => {
  it('adds explicit pt-BR regional guidance', () => {
    const instruction = buildReplyLanguageInstruction('pt-BR');

    expect(instruction).toContain('Responda em pt-BR');
    expect(instruction).toContain('Use vocabulário e construções naturais de pt-BR.');
    expect(instruction).toContain('Evite vocabulário típico de português europeu');
    expect(instruction).toContain('"tu", "ti", "contigo"');
    expect(instruction).toContain('Estas regras de idioma têm prioridade');
    expect(instruction).toContain('Espanhol não é um idioma de saída suportado');
    expect(instruction).not.toContain('outra língua');
  });

  it('adds explicit pt-PT regional guidance', () => {
    const instruction = buildReplyLanguageInstruction('pt-PT');

    expect(instruction).toContain('Responda em português europeu');
    expect(instruction).toContain('Use vocabulário e construções naturais de português europeu.');
    expect(instruction).toContain('Evite vocabulário típico do Brasil');
    expect(instruction).toContain('"você", "ônibus", "celular"');
    expect(instruction).toContain('Estas regras de idioma têm prioridade');
    expect(instruction).toContain('Espanhol não é um idioma de saída suportado');
    expect(instruction).not.toContain('outra língua');
  });

  it('tells English replies to override PT-BR prompt defaults', () => {
    const instruction = buildReplyLanguageInstruction('en-US');

    expect(instruction).toContain('Reply in English.');
    expect(instruction).toContain('Only pt-BR and European Portuguese are supported output-language switches.');
    expect(instruction).toContain('Spanish-authored input remains on the English response contract.');
    expect(instruction).not.toContain('asks to switch languages');
    expect(instruction).toContain('override any conflicting creator-config');
    expect(instruction).toContain('If the base prompt mentions PT-BR');
    expect(instruction).toContain('Keep generated titles, hooks, captions, outlines, and scripts in English too');
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

  it.each([
    ['pt-PT', '¿Puedes responder en portugués europeo?', 'pt-PT'],
    ['pt-BR', 'Por favor responde en portugués brasileño.', 'pt-BR'],
    ['pt-PT', 'Responde en portugués, por favor.', 'pt-PT'],
    ['pt-BR', 'Responde en inglés, por favor.', 'en-US'],
  ] as const)(
    'honors an explicit supported output-language request written in Spanish: %s',
    (storedLanguage, message, expected) => {
      expect(resolveReplyLanguage(storedLanguage, message)).toBe(expected);
    },
  );

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

  it.each([
    ['pt-BR', 'minha tarefa se chama Comprar leche mañana', 'pt-BR'],
    ['pt-PT', 'podes mostrar o estado da tarefa Comprar leche mañana?', 'pt-PT'],
    ['en-US', 'esta semana tenho duas tareas', 'pt-BR'],
  ] as const)(
    'keeps Portuguese framing on a Portuguese response contract when an entity contains Spanish: %s',
    (storedLanguage, message, expected) => {
      expect(resolveReplyLanguage(storedLanguage, message)).toBe(expected);
    },
  );

  it.each([
    'Qué contenido está listo para revisar en mi mesa?',
    'Qué sesiones de entrenamiento tengo esta semana?',
    'Tengo tareas para completar hoy?',
    'Dame una idea general para cenar hoy',
    'Descarta la decisión dec_route_gate hasta el lunes',
  ])('keeps retired Spanish-authored input on the English response contract: %s', (message) => {
    expect(resolveReplyLanguage('en-US', message)).toBe('en-US');
    expect(resolveReplyLanguage('es-ES', message)).toBe('en-US');
  });
});

describe('resolveReplyLanguageForCurrentRequest', () => {
  it('keeps the resolved English request contract ahead of a stale Portuguese profile', () => {
    const resolved = runWithChatRequestLocale(
      'en-US',
      () => resolveReplyLanguageForCurrentRequest('pt-BR', '¿Qué tengo para mañana?'),
    );

    expect(resolved).toBe('en-US');
  });

  it('keeps the resolved Portuguese request contract ahead of a stale English profile', () => {
    const resolved = runWithChatRequestLocale(
      'pt-PT',
      () => resolveReplyLanguageForCurrentRequest('en-US', 'Show my priorities'),
    );

    expect(resolved).toBe('pt-PT');
  });

  it('preserves direct-call message detection when no request locale is scoped', () => {
    expect(
      resolveReplyLanguageForCurrentRequest(
        'pt-BR',
        "is tomorrow's tempo ride too much after the heavy leg load?",
      ),
    ).toBe('en-US');
  });
});
