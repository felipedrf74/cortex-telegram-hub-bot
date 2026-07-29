import { describe, expect, it } from 'vitest';
import { normalizeContentOutputLanguage } from '../../src/services/content-output-language';

describe('content output language', () => {
  it.each([
    ['en', 'en-US'],
    ['English', 'en-US'],
    ['pt', 'pt-BR'],
    ['Brazilian Portuguese', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['European Portuguese', 'pt-PT'],
    ['es-419', 'en-US'],
    ['Spanish', 'en-US'],
    ['Español', 'en-US'],
    ['fr-FR', 'en-US'],
  ])('normalizes explicit selector %s to %s', (input, expected) => {
    expect(normalizeContentOutputLanguage(input)).toBe(expected);
  });

  it('uses a canonical request hint only when the profile selector is missing', () => {
    expect(normalizeContentOutputLanguage('', 'pt-PT')).toBe('pt-PT');
    expect(normalizeContentOutputLanguage(undefined, 'pt-BR')).toBe('pt-BR');
    expect(normalizeContentOutputLanguage('Spanish', 'pt-BR')).toBe('en-US');
    expect(normalizeContentOutputLanguage('fr-FR', 'pt-PT')).toBe('en-US');
  });
});
