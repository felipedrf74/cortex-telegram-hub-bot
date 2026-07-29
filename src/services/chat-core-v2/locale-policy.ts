// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  normalizeChatCoreV2Locale as normalizeChatCoreV2ResponseLocale,
  type ChatCoreV2Locale,
} from './response-contracts';

export const CHAT_CORE_V2_LOCALE_POLICY_VERSION = 'chat_core_v2_locale_policy@1.0.0';

export type ChatCoreV2TemplateKey =
  | 'unsupported'
  | 'needs_clarification'
  | 'action_preview'
  | 'action_completed'
  | 'action_cancelled'
  | 'stale_preview'
  | 'budget_limited'
  | 'waiting_for_confirmation';

export interface ChooseChatCoreV2LocaleInput {
  userLocale?: string | null;
  detectedUserLanguage?: string | null;
  explicitLocaleOverride?: string | null;
  previousConversationLocale?: string | null;
}

export interface ChatCoreV2TemplateRenderInput {
  locale?: string | null;
  key: ChatCoreV2TemplateKey;
  params?: Record<string, string | number | boolean | null | undefined>;
}

type TemplateEntry = Record<ChatCoreV2Locale, string>;

const TEMPLATE_CATALOG: Record<ChatCoreV2TemplateKey, TemplateEntry> = {
  unsupported: {
    en: "I can't do that directly yet. I can help prepare the steps or create a reminder.",
    'pt-PT': 'Ainda não consigo fazer isso diretamente. Posso ajudar a preparar os passos ou criar um lembrete.',
    'pt-BR': 'Ainda não consigo fazer isso diretamente. Posso ajudar a preparar os passos ou criar um lembrete.',
  },
  needs_clarification: {
    en: 'I need one detail before I can continue: {question}',
    'pt-PT': 'Preciso de um detalhe antes de continuar: {question}',
    'pt-BR': 'Preciso de um detalhe antes de continuar: {question}',
  },
  action_preview: {
    en: 'I can do this: {summary}',
    'pt-PT': 'Posso fazer isto: {summary}',
    'pt-BR': 'Posso fazer isto: {summary}',
  },
  action_completed: {
    en: 'Done - {summary}',
    'pt-PT': 'Feito - {summary}',
    'pt-BR': 'Feito - {summary}',
  },
  action_cancelled: {
    en: 'Cancelled. Nothing changed.',
    'pt-PT': 'Cancelado. Nada mudou.',
    'pt-BR': 'Cancelado. Nada mudou.',
  },
  stale_preview: {
    en: 'This changed since I prepared the preview. I refreshed the proposal - please review it again.',
    'pt-PT': 'Isto mudou desde que preparei a pré-visualização. Atualizei a proposta - revê-a outra vez.',
    'pt-BR': 'Isso mudou desde que preparei a prévia. Atualizei a proposta - revise novamente.',
  },
  budget_limited: {
    en: 'I stopped before using more AI budget. Try a narrower request or use a deterministic action.',
    'pt-PT': 'Parei antes de usar mais orçamento de IA. Tenta um pedido mais específico ou uma ação determinística.',
    'pt-BR': 'Parei antes de usar mais orçamento de IA. Tente um pedido mais específico ou uma ação determinística.',
  },
  waiting_for_confirmation: {
    en: 'Review the preview and confirm when you are ready.',
    'pt-PT': 'Revê a pré-visualização e confirma quando estiveres pronto.',
    'pt-BR': 'Revise a prévia e confirme quando estiver pronto.',
  },
};

export function chooseChatCoreV2Locale(input: ChooseChatCoreV2LocaleInput = {}): ChatCoreV2Locale {
  return normalizeChatCoreV2TemplateLocale(
    input.explicitLocaleOverride
      ?? input.detectedUserLanguage
      ?? input.previousConversationLocale
      ?? input.userLocale,
  );
}

export function normalizeChatCoreV2TemplateLocale(locale?: string | null): ChatCoreV2Locale {
  return normalizeChatCoreV2ResponseLocale(typeof locale === 'string' ? locale.replace('_', '-') : locale);
}

export function chatCoreV2Text(
  locale: string | undefined | null,
  ptPt: string,
  ptBr: string,
  en: string,
): string {
  const normalized = normalizeChatCoreV2TemplateLocale(locale);
  if (normalized === 'pt-BR') return ptBr;
  if (normalized === 'pt-PT') return ptPt;
  return en;
}

export function renderChatCoreV2Template(input: ChatCoreV2TemplateRenderInput): string {
  const locale = normalizeChatCoreV2TemplateLocale(input.locale);
  const template = TEMPLATE_CATALOG[input.key]?.[locale];
  if (!template) throw new Error(`Unknown Chat Core v2 template key: ${input.key}`);
  return interpolate(template, input.params ?? {});
}

export function formatChatCoreV2DateTime(
  value: string | Date,
  locale?: string | null,
  timeZone = 'UTC',
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid date for Chat Core v2 date formatting');
  return new Intl.DateTimeFormat(toIntlLocale(normalizeChatCoreV2TemplateLocale(locale)), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}

export function preserveChatCoreV2ExactUserText(value: string): string {
  return value;
}

export function listChatCoreV2TemplateKeys(): ChatCoreV2TemplateKey[] {
  return Object.keys(TEMPLATE_CATALOG).sort() as ChatCoreV2TemplateKey[];
}

function interpolate(template: string, params: Record<string, string | number | boolean | null | undefined>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = params[key];
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

function toIntlLocale(locale: ChatCoreV2Locale): string {
  if (locale === 'en') return 'en-US';
  return locale;
}
