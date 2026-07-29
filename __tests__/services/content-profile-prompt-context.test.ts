import { describe, expect, it } from 'vitest';
import { buildCreatorPromptContext } from '../../src/services/content-profile-prompt-context';

describe('content profile prompt context output language', () => {
  it.each([
    ['en', 'en-US'],
    ['pt', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['European Portuguese', 'pt-PT'],
    ['es-419', 'en-US'],
    ['Spanish', 'en-US'],
    ['Español', 'en-US'],
    ['fr-FR', 'en-US'],
  ])('projects %s to canonical output language %s', (storedLanguage, expectedLanguage) => {
    const context = buildCreatorPromptContext({
      languagePreference: storedLanguage,
      audience: 'founders',
      pillars: ['Cost control'],
      niches: ['creator ops'],
    });

    expect(context.language).toBe(expectedLanguage);
    expect(context.block.split('\n')[0]).toBe(`Target language: ${expectedLanguage}`);
  });

  it('defaults a missing creator output language to English', () => {
    const context = buildCreatorPromptContext(null);

    expect(context.language).toBe('en-US');
    expect(context.block).toContain('Target language: en-US');
  });
});
