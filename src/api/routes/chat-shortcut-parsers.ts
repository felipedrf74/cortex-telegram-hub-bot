// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { normalizeSupportedLang } from '../../utils/i18n';

export type ShortcutLanguage = 'pt-BR' | 'pt-PT' | 'en-US';

export type ScriptGenerationMode = 'quick' | 'standard' | 'deep';

export type ContentScriptShortcut = {
  topic: string;
  format: 'Reel' | 'YouTube';
  mode: ScriptGenerationMode;
  maxDurationMinutes: number;
};

export type ContentCreativeShortcut =
  | { operation: 'hooks' | 'titles' | 'caption'; topic: string }
  | { operation: 'thumbnail'; topic: string; title: string }
  | { operation: 'repurpose'; topic: string; sourceContent: string };

export type ContentCreativeShortcutCommand = 'hooks' | 'titles' | 'genthumbnail' | 'gencaption' | 'repurpose';

export type ContentCreativeShortcutValidationReason =
  | 'message_too_long'
  | 'unsupported_control_character'
  | 'subject_required'
  | 'single_line_required'
  | 'subject_too_long';

export type ContentCreativeShortcutInspection =
  | { status: 'not_recognized' }
  | {
    status: 'invalid';
    command: ContentCreativeShortcutCommand;
    reason: ContentCreativeShortcutValidationReason;
  }
  | { status: 'valid'; shortcut: ContentCreativeShortcut };

export type ContentStateShortcut = 'desk' | 'pillars' | 'filming' | 'next_publish' | 'performance' | 'learning';

export type FinanceStateShortcut =
  | 'missing_bills'
  | 'subscription_renewal'
  | 'budget_remaining'
  | 'next_tax_due'
  | 'accountant_bundle'
  | 'monthly_spend'
  | 'filed_invoices';

const MAX_SHORTCUT_PARSE_CHARS = 4_096;

export function normalizeScriptLanguage(language?: string | null): ShortcutLanguage {
  if (typeof language !== 'string' || !language.trim()) return 'pt-BR';
  return normalizeSupportedLang(language, 'en-US');
}

export function resolveRequestedScriptLanguage(message: string, fallbackLanguage?: string | null): ShortcutLanguage {
  const lower = message.toLowerCase();
  if (/(?:\bin english\b|\benglish version\b|\benglish please\b|\bem ingl[eê]s\b)/i.test(lower)) return 'en-US';
  if (/(?:\bpt-pt\b|portugu[eê]s europeu|portugu[eê]s de portugal|portuguese from portugal|european portuguese)/i.test(lower)) return 'pt-PT';
  if (/(?:\bpt-br\b|portugu[eê]s brasileiro|brazilian portuguese)/i.test(lower)) return 'pt-BR';
  return normalizeScriptLanguage(fallbackLanguage);
}

export function resolveContentShortcutLanguage(message: string, fallbackLanguage?: string | null): ShortcutLanguage {
  const fallback = normalizeScriptLanguage(fallbackLanguage);
  const explicit = resolveRequestedScriptLanguage(message, fallbackLanguage);
  if (explicit !== fallback) return explicit;

  const lower = message.trim().toLowerCase();
  if (
    /\b(what|how|which|should|film|filming|desk|pillars|ready|tracking|around|week)\b/.test(lower)
    && !/\b(o|que|como|quais|devo|estou|mesa|pilares|semana)\b/.test(lower)
  ) {
    return 'en-US';
  }

  return fallback;
}

export function resolveFinanceShortcutLanguage(userLanguage: string | null | undefined): ShortcutLanguage {
  if (!userLanguage) return 'en-US';
  if (userLanguage === 'pt-PT') return 'pt-PT';
  if (userLanguage.startsWith('pt')) return 'pt-BR';
  return 'en-US';
}

export function stripTrailingLanguageQualifier(topic: string): string {
  if (topic.length > MAX_SHORTCUT_PARSE_CHARS) return topic.trim();
  return topic
    .replace(/\s+(?:in english|english version|english please)\.?$/i, '')
    .replace(/\s+(?:em ingl[eê]s)\.?$/i, '')
    .replace(/\s+(?:em portugu[eê]s europeu|em portugu[eê]s de portugal|em pt-pt)\.?$/i, '')
    .replace(/\s+(?:em portugu[eê]s brasileiro|em pt-br)\.?$/i, '')
    .trim();
}

export function parseContentScriptShortcut(message: string): ContentScriptShortcut | null {
  if (message.length > MAX_SHORTCUT_PARSE_CHARS) return null;
  const normalized = message.trim();
  if (!normalized) return null;

  const hasGenerationVerb = /\b(write|create|make|draft|generate|help|assist|escreve|escreva|cria|crie|gera|gere|faz|faça|ajuda|ajude)\b/i.test(normalized);
  const hasScriptWord = /\b(script|roteiro)\b/i.test(normalized);
  if (!hasGenerationVerb || !hasScriptWord) return null;

  const isShort = /\b(short|brief|quick|reel|short-form|short form|curto|curta|breve)\b/i.test(normalized);
  const format: 'Reel' | 'YouTube' = /\b(reel|short-form|short form)\b/i.test(normalized) || isShort ? 'Reel' : 'YouTube';
  const mode: ScriptGenerationMode = format === 'Reel' ? 'quick' : 'standard';
  const maxDurationMinutes = format === 'Reel' ? 1 : 8;

  const topicMatch = normalized.match(/\b(?:about|on|for|sobre|para|de)\b\s+(.+)$/i);
  let topic = topicMatch?.[1]?.trim() || '';
  if (!topic) {
    const trailingFromKeyword = normalized.match(/\b(?:script|roteiro)\b[:\s-]*(.+)$/i);
    topic = trailingFromKeyword?.[1]?.trim() || '';
  }
  topic = stripTrailingLanguageQualifier(topic).replace(/[.?!]+$/g, '').trim();
  if (!topic || topic.length < 3) return null;

  if (/(?:\bmy script\b|\bthis script\b|\beste roteiro\b|\besse roteiro\b)/i.test(topic)) {
    return null;
  }

  return {
    topic,
    format,
    mode,
    maxDurationMinutes,
  };
}

/**
 * Distinguish unrelated text from a recognized-but-invalid creative command.
 * Callers use the invalid state to terminate at the deterministic chat
 * boundary instead of leaking malformed commands into generic routing.
 */
export function inspectContentCreativeShortcut(message: string): ContentCreativeShortcutInspection {
  const commandMatch = message.trimStart().match(
    /^\/(hooks|titles|genthumbnail|gencaption|repurpose)(?=\s|$)/i,
  );
  if (!commandMatch) return { status: 'not_recognized' };
  const command = commandMatch[1].toLowerCase() as ContentCreativeShortcutCommand;
  if (message.length > MAX_SHORTCUT_PARSE_CHARS) {
    return { status: 'invalid', command, reason: 'message_too_long' };
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(message)) {
    return { status: 'invalid', command, reason: 'unsupported_control_character' };
  }
  if (command !== 'repurpose' && /[\t\r\n]/u.test(message)) {
    return { status: 'invalid', command, reason: 'single_line_required' };
  }
  const match = message.trim().match(
    /^\/(hooks|titles|genthumbnail|gencaption|repurpose)(?=\s|$)\s*(.*)$/is,
  );
  if (!match) return { status: 'invalid', command, reason: 'subject_required' };
  const subject = stripTrailingLanguageQualifier(match[2]).trim();
  if (subject.length < 3) return { status: 'invalid', command, reason: 'subject_required' };
  if (command === 'genthumbnail') {
    if (subject.length > 1_400) return { status: 'invalid', command, reason: 'subject_too_long' };
    return { status: 'valid', shortcut: { operation: 'thumbnail', topic: subject, title: subject } };
  }
  if (command === 'gencaption') {
    if (subject.length > 2_000) return { status: 'invalid', command, reason: 'subject_too_long' };
    return { status: 'valid', shortcut: { operation: 'caption', topic: subject } };
  }
  if (command === 'repurpose') {
    const topic = subject
      .replace(/[\t\r\n]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 240)
      .trim();
    return {
      status: 'valid',
      shortcut: {
        operation: 'repurpose',
        topic,
        sourceContent: subject,
      },
    };
  }
  if (subject.length > 2_000) return { status: 'invalid', command, reason: 'subject_too_long' };
  return { status: 'valid', shortcut: { operation: command, topic: subject } };
}

/** Parse only valid explicit creative slash commands; natural language keeps normal routing. */
export function parseContentCreativeShortcut(message: string): ContentCreativeShortcut | null {
  const inspected = inspectContentCreativeShortcut(message);
  return inspected.status === 'valid' ? inspected.shortcut : null;
}

export function parseContentStateShortcut(message: string): ContentStateShortcut | null {
  const normalized = normalizeShortcutText(message);
  if (!normalized) return null;

  if (
    normalized.includes('what content is already ready on my desk')
    || normalized.includes('what is already on my desk')
    || normalized.includes('what s ready on my desk')
    || normalized.includes('what is ready on my desk')
    || normalized.includes('o que ja esta pronto na minha mesa')
    || normalized.includes('o que esta pronto na minha mesa')
  ) {
    return 'desk';
  }
  if (
    /(?:what|which)\s+pillars?\s+am\s+i\s+tracking/.test(normalized)
    || /quais?\s+pilares?\s+estou\s+(?:a\s+)?acompanh(?:ar|ando)/.test(normalized)
  ) {
    return 'pillars';
  }
  if (
    normalized.includes('how should i schedule filming around my week')
    || normalized.includes('what should i film this week')
    || normalized.includes('como devo agendar as filmagens na semana')
    || normalized.includes('como devo agendar as filmagens na minha semana')
    || normalized.includes('o que devo filmar esta semana')
  ) {
    return 'filming';
  }
  if (
    normalized.includes('what should i publish next')
    || normalized.includes('what should i work on next for content')
    || normalized.includes('what is the next content priority')
    || normalized.includes('qual conteudo devo publicar a seguir')
    || normalized.includes('qual video devo publicar a seguir')
    || normalized.includes('qual e a proxima prioridade de conteudo')
    || normalized.includes('no que devo trabalhar a seguir em conteudo')
  ) {
    return 'next_publish';
  }
  if (
    normalized.includes('what performed best')
    || normalized.includes('what is performing best')
    || normalized.includes('which video performed best')
    || normalized.includes('what content performed best')
    || normalized.includes('o que performou melhor')
    || normalized.includes('qual video performou melhor')
    || normalized.includes('qual conteudo performou melhor')
  ) {
    return 'performance';
  }
  if (
    normalized.includes('what are we learning')
    || normalized.includes('what are we learning this week')
    || normalized.includes('what are the biggest learnings')
    || normalized.includes('what hook is working')
    || normalized.includes('what hooks are working')
    || normalized.includes('what format is winning')
    || normalized.includes('what format is working')
    || normalized.includes('o que estamos aprendendo')
    || normalized.includes('o que estamos a aprender')
    || normalized.includes('qual hook esta funcionando')
    || normalized.includes('quais hooks estao funcionando')
    || normalized.includes('qual formato esta vencendo')
    || normalized.includes('qual formato esta funcionando')
  ) {
    return 'learning';
  }
  return null;
}

export function parseFinanceStateShortcut(message: string): FinanceStateShortcut | null {
  const normalized = normalizeShortcutText(message);
  if (!normalized) return null;

  if (
    normalized.includes('what bills are still missing this month')
    || normalized.includes('which bills are still missing this month')
    || normalized.includes('what invoices are still missing this month')
    || normalized.includes('que contas faltam este mes')
    || normalized.includes('que faturas faltam este mes')
    || normalized.includes('quais contas faltam este mes')
    || normalized.includes('quais faturas faltam este mes')
  ) {
    return 'missing_bills';
  }

  if (
    normalized.includes('what subscriptions renew soon')
    || normalized.includes('which subscriptions renew soon')
    || normalized.includes('what renews soon')
    || normalized.includes('quais assinaturas renovam em breve')
    || normalized.includes('que assinaturas renovam em breve')
    || normalized.includes('o que renova em breve')
  ) {
    return 'subscription_renewal';
  }

  if (
    normalized.includes('what s my budget remaining this month')
    || normalized.includes('what is my budget remaining this month')
    || normalized.includes('what budget is left this month')
    || normalized.includes('quanto sobra do meu orcamento este mes')
    || normalized.includes('qual e o meu orcamento restante este mes')
  ) {
    return 'budget_remaining';
  }

  if (
    normalized.includes('what tax is due next')
    || normalized.includes('which tax is due next')
    || normalized.includes('what tax do i owe next')
    || normalized.includes('qual imposto vence a seguir')
    || normalized.includes('qual imposto vence depois')
    || normalized.includes('que imposto vence a seguir')
  ) {
    return 'next_tax_due';
  }

  if (
    normalized.includes('what should i send to my accountant')
    || normalized.includes('what do i send to my accountant')
    || normalized.includes('what should go to my accountant')
    || normalized.includes('what should i send for my fiscal bundle')
    || normalized.includes('o que devo enviar ao meu contabilista')
    || normalized.includes('o que devo mandar ao meu contabilista')
    || normalized.includes('o que devo enviar para o meu contador')
    || normalized.includes('o que devo mandar para o meu contador')
  ) {
    return 'accountant_bundle';
  }

  if (
    normalized.includes('how much did i spend this month')
    || normalized.includes('what did i spend this month')
    || normalized.includes('quanto gastei este mes')
    || normalized.includes('quanto foi gasto este mes')
  ) {
    return 'monthly_spend';
  }

  if (
    normalized.includes('what invoices did i file this month')
    || normalized.includes('which invoices did i file this month')
    || normalized.includes('what receipts did i file this month')
    || normalized.includes('que faturas registei este mes')
    || normalized.includes('quais faturas registei este mes')
    || normalized.includes('que recibos registei este mes')
  ) {
    return 'filed_invoices';
  }

  return null;
}

function normalizeShortcutText(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
