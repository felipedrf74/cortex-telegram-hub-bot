import { describe, expect, it } from 'vitest';
import { normalizeReplyForLanguage } from '../../src/services/reply-language-normalizer';

describe('normalizeReplyForLanguage', () => {
  it('normalizes common PT-PT wording into PT-BR', () => {
    const raw = [
      'Boa! Aproveita a tua energia e leva o telemóvel contigo.',
      'Se estiveres no pequeno-almoço, olha para o ecrã e manda isso para ti.',
    ].join(' ');

    const normalized = normalizeReplyForLanguage(raw, 'pt-BR');

    expect(normalized).toContain('sua energia');
    expect(normalized).toContain('celular');
    expect(normalized).toContain('com você');
    expect(normalized).toContain('café da manhã');
    expect(normalized).toContain('tela');
    expect(normalized).toContain('para você');
  });

  it('does not rewrite non-Brazilian languages', () => {
    const raw = 'Leva o telemóvel contigo para o pequeno-almoço.';

    expect(normalizeReplyForLanguage(raw, 'pt-PT')).toBe(raw);
    expect(normalizeReplyForLanguage(raw, 'en-US')).toBe(raw);
  });
});
