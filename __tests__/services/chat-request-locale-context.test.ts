import { describe, expect, it } from 'vitest';

import {
  buildChatReplyLanguagePromptBlock,
  getCurrentChatRequestLocale,
  runWithChatRequestLocale,
} from '../../src/services/chat-request-locale-context';

describe('chat request locale context', () => {
  it('coerces legacy Spanish to English and restores the outer context', () => {
    expect(getCurrentChatRequestLocale()).toBeNull();

    runWithChatRequestLocale('es-419', () => {
      expect(getCurrentChatRequestLocale()).toBe('en-US');
      expect(buildChatReplyLanguagePromptBlock()).toContain('Reply only in English');
    });

    expect(getCurrentChatRequestLocale()).toBeNull();
  });

  it('uses Portuguese or English for supported locales and rejects unsupported values', () => {
    expect(buildChatReplyLanguagePromptBlock('pt-BR')).toContain('Reply only in Portuguese');
    expect(buildChatReplyLanguagePromptBlock('en-US')).toContain('Reply only in English');
    expect(buildChatReplyLanguagePromptBlock('fr-FR')).toBe('');
  });
});
