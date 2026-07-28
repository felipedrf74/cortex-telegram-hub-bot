import { describe, expect, it } from 'vitest';

import {
  buildChatReplyLanguagePromptBlock,
  getCurrentChatRequestLocale,
  runWithChatRequestLocale,
} from '../../src/services/chat-request-locale-context';

describe('chat request locale context', () => {
  it('scopes a valid request locale and restores the outer context', () => {
    expect(getCurrentChatRequestLocale()).toBeNull();

    runWithChatRequestLocale('es-419', () => {
      expect(getCurrentChatRequestLocale()).toBe('es-419');
      expect(buildChatReplyLanguagePromptBlock()).toContain('Reply only in Spanish');
    });

    expect(getCurrentChatRequestLocale()).toBeNull();
  });

  it('uses Portuguese for pt-BR and rejects unsupported locale values', () => {
    expect(buildChatReplyLanguagePromptBlock('pt-BR')).toContain('Reply only in Portuguese');
    expect(buildChatReplyLanguagePromptBlock('fr-FR')).toBe('');
  });
});
