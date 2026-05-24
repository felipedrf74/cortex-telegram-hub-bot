import { describe, expect, it } from 'vitest';
import {
  chatCoreV2Text,
  chooseChatCoreV2Locale,
  formatChatCoreV2DateTime,
  listChatCoreV2TemplateKeys,
  normalizeChatCoreV2TemplateLocale,
  preserveChatCoreV2ExactUserText,
  renderChatCoreV2Template,
} from '../../src/services/chat-core-v2';

describe('Chat Core v2 locale policy', () => {
  it('normalizes supported app and detected-language locales', () => {
    expect(normalizeChatCoreV2TemplateLocale('pt-BR')).toBe('pt-BR');
    expect(normalizeChatCoreV2TemplateLocale('pt_BR')).toBe('pt-BR');
    expect(normalizeChatCoreV2TemplateLocale('pt-PT')).toBe('pt-PT');
    expect(normalizeChatCoreV2TemplateLocale('pt')).toBe('pt-PT');
    expect(normalizeChatCoreV2TemplateLocale('pt-AO')).toBe('pt-PT');
    expect(normalizeChatCoreV2TemplateLocale('es')).toBe('es');
    expect(normalizeChatCoreV2TemplateLocale('en-GB')).toBe('en');
    expect(normalizeChatCoreV2TemplateLocale('fr-FR')).toBe('en');
    expect(normalizeChatCoreV2TemplateLocale(null)).toBe('en');
  });

  it('preserves the latest user language before falling back to conversation and app locale', () => {
    expect(chooseChatCoreV2Locale({
      userLocale: 'en-US',
      previousConversationLocale: 'pt-PT',
      detectedUserLanguage: 'es',
    })).toBe('es');

    expect(chooseChatCoreV2Locale({
      userLocale: 'en-US',
      previousConversationLocale: 'pt-BR',
    })).toBe('pt-BR');

    expect(chooseChatCoreV2Locale({
      userLocale: 'pt-PT',
      detectedUserLanguage: 'es',
      explicitLocaleOverride: 'en-US',
    })).toBe('en');
  });

  it('uses the same PT-PT/PT-BR/EN argument order as existing secretary copy helpers', () => {
    expect(chatCoreV2Text('pt-PT', 'pré-visualização', 'prévia', 'preview')).toBe('pré-visualização');
    expect(chatCoreV2Text('pt-BR', 'pré-visualização', 'prévia', 'preview')).toBe('prévia');
    expect(chatCoreV2Text('en-US', 'pré-visualização', 'prévia', 'preview')).toBe('preview');
    expect(chatCoreV2Text('es-ES', 'pré-visualização', 'prévia', 'preview', 'vista previa')).toBe('vista previa');
  });

  it('renders deterministic templates in EN, PT-PT, PT-BR, and ES', () => {
    expect(renderChatCoreV2Template({
      locale: 'en-US',
      key: 'action_completed',
      params: { summary: 'created "Buy milk"' },
    })).toBe('Done - created "Buy milk"');

    expect(renderChatCoreV2Template({
      locale: 'pt-PT',
      key: 'waiting_for_confirmation',
    })).toBe('Revê a pré-visualização e confirma quando estiveres pronto.');

    expect(renderChatCoreV2Template({
      locale: 'pt-BR',
      key: 'waiting_for_confirmation',
    })).toBe('Revise a prévia e confirme quando estiver pronto.');

    expect(renderChatCoreV2Template({
      locale: 'es-ES',
      key: 'unsupported',
    })).toContain('Todavía no puedo hacerlo directamente');
  });

  it('keeps exact user-provided titles and identifiers out of translation logic', () => {
    const title = 'Review João proposal #A-17';
    const rendered = renderChatCoreV2Template({
      locale: 'pt-BR',
      key: 'action_preview',
      params: { summary: `criar "${preserveChatCoreV2ExactUserText(title)}"` },
    });

    expect(rendered).toBe('Posso fazer isto: criar "Review João proposal #A-17"');
  });

  it('formats dates with the selected locale and timezone', () => {
    const value = '2026-05-24T14:30:00.000Z';

    expect(formatChatCoreV2DateTime(value, 'en-US', 'UTC')).toContain('May');
    expect(formatChatCoreV2DateTime(value, 'pt-PT', 'Europe/Lisbon')).toContain('15:30');
    expect(formatChatCoreV2DateTime(value, 'pt-BR', 'America/Sao_Paulo')).toContain('11:30');
    expect(formatChatCoreV2DateTime(value, 'es-ES', 'Europe/Madrid')).toContain('16:30');
  });

  it('exposes every deterministic template key for coverage and eval generation', () => {
    expect(listChatCoreV2TemplateKeys()).toEqual([
      'action_cancelled',
      'action_completed',
      'action_preview',
      'budget_limited',
      'needs_clarification',
      'stale_preview',
      'unsupported',
      'waiting_for_confirmation',
    ]);
  });

  it('rejects invalid dates before rendering misleading copy', () => {
    expect(() => formatChatCoreV2DateTime('not-a-date', 'en-US')).toThrow(/Invalid date/);
  });
});
