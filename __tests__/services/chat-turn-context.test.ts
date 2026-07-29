// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { buildChatTurnContext } from '../../src/services/chat-turn-context';

describe('buildChatTurnContext (Phase 16 batch 89)', () => {
  it('folds the text once and exposes both raw and folded forms', () => {
    const ctx = buildChatTurnContext({
      text: 'Cria um EVENTO chamado Reunião às 10h',
      locale: 'pt-BR',
    });
    expect(ctx.text).toBe('Cria um EVENTO chamado Reunião às 10h');
    expect(ctx.folded).toContain('reuniao');
    expect(ctx.folded).toBe(ctx.folded.toLowerCase());
  });

  it('exposes supported locale cohorts and coerces legacy Spanish to English', () => {
    expect(buildChatTurnContext({ text: 'oi', locale: 'pt-BR' }).isPortuguese).toBe(true);
    expect(buildChatTurnContext({ text: 'oi', locale: 'pt-PT' }).isPortuguese).toBe(true);
    expect(buildChatTurnContext({ text: 'hi', locale: 'en-US' }).isEnglish).toBe(true);
    const legacySpanish = buildChatTurnContext({ text: 'hola', locale: 'es-ES' });
    expect(legacySpanish.locale).toBe('en-US');
    expect(legacySpanish.isEnglish).toBe(true);
    expect(legacySpanish).not.toHaveProperty('isSpanish');
  });

  it('defaults locale to pt-BR when not provided', () => {
    const ctx = buildChatTurnContext({ text: 'algo' });
    expect(ctx.locale).toBe('pt-BR');
    expect(ctx.isPortuguese).toBe(true);
  });

  it('freezes recentTurns and pendingActionIds to enforce read-only semantics', () => {
    const ctx = buildChatTurnContext({
      text: 'x',
      recentTurns: [{ role: 'user', text: 'hello' }],
      pendingActionIds: ['p1', 'p2'],
    });
    expect(Object.isFrozen(ctx.recentTurns)).toBe(true);
    expect(Object.isFrozen(ctx.pendingActionIds)).toBe(true);
    expect(ctx.recentTurns).toHaveLength(1);
    expect(ctx.pendingActionIds).toEqual(['p1', 'p2']);
  });

  it('handles empty/undefined inputs gracefully', () => {
    const ctx = buildChatTurnContext({ text: '' });
    expect(ctx.text).toBe('');
    expect(ctx.folded).toBe('');
    expect(ctx.recentTurns).toHaveLength(0);
    expect(ctx.pendingActionIds).toHaveLength(0);
  });
});
