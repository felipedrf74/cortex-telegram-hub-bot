// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { AsyncLocalStorage } from 'node:async_hooks';

const activeLocale = new AsyncLocalStorage<string | null>();

function normalizeChatRequestLocale(locale: string | null | undefined): string | null {
  const normalized = String(locale ?? '').trim();
  if (/^es(?:-[a-z0-9]{2,3})?$/i.test(normalized)) return 'en-US';
  return /^(?:en|pt)(?:-[a-z0-9]{2,3})?$/i.test(normalized)
    ? normalized
    : null;
}

export function runWithChatRequestLocale<T>(
  locale: string | null | undefined,
  fn: () => T,
): T {
  return activeLocale.run(normalizeChatRequestLocale(locale), fn);
}

export function getCurrentChatRequestLocale(): string | null {
  return activeLocale.getStore() ?? null;
}

export function buildChatReplyLanguagePromptBlock(
  locale = getCurrentChatRequestLocale(),
): string {
  const normalized = normalizeChatRequestLocale(locale);
  if (!normalized) return '';
  const primary = normalized.split('-')[0]?.toLowerCase();
  const instruction = primary === 'pt'
    ? 'Reply only in Portuguese. Use the requested regional variety when one is specified.'
    : 'Reply only in English.';
  return [
    `<reply_language requested_locale="${normalized}">`,
    instruction,
    'This request-level language contract overrides stored profile defaults for this reply only.',
    '</reply_language>',
  ].join('\n');
}
