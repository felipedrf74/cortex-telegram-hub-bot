// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { DateTime } from 'luxon';
import { AuthenticatedRequest } from '../auth-middleware';
import { routeMessage, isSystemCommand, keywordMatch } from '../../router';
import { logger } from '../../utils/logger';
import { pushEvent } from '../../portal/telemetry';
import { getCached, setCache } from '../../services/cache-store';
import { tryDeterministicChatCommand } from './chat-fastpath';
import { listChatMessages, storeChatMessage, updateAssistantMessage } from '../../services/chat-history-store';
import { classifyAndExtractImage, type ImageClassificationResult } from '../../services/anthropic';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguage, setUserLanguage, getUserById, getUserByTelegramId } from '../../services/user-service';
import { buildQuotaExceededMessage, isUserOverDailyCap } from '../../services/cost-guardrail';
import {
  addToConversation,
  getLastAssistantMessage,
  syncLastAssistantConversationMessage,
} from '../../state/conversation';
import { checkTierAccess } from '../../services/skill-tiers';
import { getCallback } from '../../utils/callback-store';
import { handleSecretary } from '../../domains/secretary';
import { handleTriathlon } from '../../domains/triathlon';
import { handleContent } from '../../domains/content-creator';
import { handleFinance } from '../../domains/finance';
import { handleCooking } from '../../domains/cooking';
import { buildAITemporarilyBusyResponse } from '../../domains/ai-unavailable';
import { formatMsTodoTasks, escapeHtml } from '../../utils/telegram-formatter';
import { getScript, type ScriptResponse } from '../../services/content-engine';
import { completeOneShotWithFallback } from '../../services/gemini-provider';
import { getFilmingRecommendation, getTopics, getUpcomingTopicCount, type ContentTopic } from '../../services/content-scheduler';
import { getLearnedPatterns, getPerformanceSummary } from '../../services/content-learning-store';
import { getAllVendors as getAllInvoiceVendors } from '../../services/invoice-collector';
import { getFilingsForMonth } from '../../state/invoice-filings';
import { getSubscriptionStatus } from '../../services/stripe-service';
import { calculateMonthlyTax, getMonthlySummary, getTaxEvents } from '../../services/finance-tracker';
import { getFiscalCollectionSummary } from '../../services/fiscal-bundle';
import {
  getActiveContentPillars,
  getContentDeskItems,
  localizeFilmingRecommendation,
} from '../../services/content-intelligence';
import { getCurrentRequestId } from '../../utils/request-context';
import {
  buildCoachRecommendationButtons,
  buildDeleteConfirmationButtons,
  buildSecretaryQuickActionButtons,
  buildTaskActionButtons,
  labelsForLanguage,
} from './chat-inline-buttons';
import { getLastCoachState } from '../../domains/domain-handler';
import { applyCoachRecommendations } from '../../services/garmin-coach';
import { sendError } from '../response-helpers';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';

// Commands whose responses can be cached (deterministic for a few minutes)
const CACHEABLE_COMMANDS = new Set([
  '/day', '/today', '/status', '/week', '/todosummary', '/todo_summary',
  '/todo', '/todos', '/tasks', '/lists',
  '/duetoday', '/due_today', '/overdue', '/dueweek', '/due_week', '/alltasks', '/all_tasks',
  '/training today', '/training plan',
]);
const CHAT_CMD_TTL = 60; // 1 minute — short enough to feel fresh, long enough to absorb retry storms
// NOTE: IOSAdapter exists but domain handlers currently don't accept an adapter parameter.
// Messages are processed via handler(message, userId) which returns { text, domain }.
// Buttons sent via Grammy InlineKeyboard are Telegram-specific and not captured here.
// Future: refactor domain handlers to accept MessageAdapter for platform-agnostic responses.
import type { DomainName } from '../../domains/types';

function getDomainHandlers(): Record<string, (message: string, userId?: number) => Promise<{ text: string; domain: DomainName }>> {
  return {
    secretary: handleSecretary,
    triathlon: handleTriathlon,
    content: handleContent,
    finance: handleFinance,
    cooking: handleCooking,
  };
}

// Track last active domain per iOS user (for conversation continuity)
const lastActiveDomain = new Map<number, { domain: DomainName; timestamp: number }>();

function ensureValidChatRouteScope(
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
): userId is number {
  if (isValidTenantUserId(userId)) return true;
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: 'invalid_user_scope',
    userId: typeof userId === 'number' ? userId : null,
    details,
  });
  sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
  return false;
}

type ChatImageAttachment = {
  base64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
};

type ScriptGenerationMode = 'quick' | 'standard' | 'deep';

type ContentScriptShortcut = {
  topic: string;
  format: 'Reel' | 'YouTube';
  mode: ScriptGenerationMode;
  maxDurationMinutes: number;
};

type ContentStateShortcut = 'desk' | 'pillars' | 'filming' | 'next_publish' | 'performance' | 'learning';
type FinanceStateShortcut =
  | 'missing_bills'
  | 'subscription_renewal'
  | 'budget_remaining'
  | 'next_tax_due'
  | 'accountant_bundle'
  | 'monthly_spend'
  | 'filed_invoices';

const CONTENT_REFINEMENT_PATTERNS = [
  /\b(make it|make this|rewrite|shorten|translate|adapt|rework|polish|trim)\b/i,
  /\b(make it shorter|make this shorter|make it punchier|make this punchier)\b/i,
  /\b(vers[aã]o mais curta|mais curto|mais curta|reescreve|reescrever|traduz|traduz isto|adapta|encurta|melhora isto)\b/i,
];

function isRetryableAIProviderError(err: unknown): err is { retryable?: boolean; status?: number } {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { retryable?: boolean; status?: number };
  if (candidate.retryable) return true;
  if (candidate.status === 429) return true;
  return typeof candidate.status === 'number' && candidate.status >= 500;
}

function normalizeChatAttachment(raw: unknown): ChatImageAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const base64 = typeof (raw as any).base64 === 'string' ? (raw as any).base64.trim() : '';
  const mimeType = typeof (raw as any).mimeType === 'string' ? (raw as any).mimeType.trim().toLowerCase() : '';
  if (!base64) return null;
  if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) return null;
  return {
    base64,
    mimeType: (mimeType === 'image/jpg' ? 'image/jpeg' : mimeType) as ChatImageAttachment['mimeType'],
  };
}

function buildAttachmentText(result: ImageClassificationResult, isPT: boolean): { text: string; domain: DomainName; metadata: any } {
  switch (result.type) {
    case 'invoice': {
      const vendor = result.vendor ?? (isPT ? 'fornecedor desconhecido' : 'unknown merchant');
      const amount = result.totalAmount ?? (isPT ? 'valor não encontrado' : 'amount not found');
      const date = result.documentDateRaw ?? result.documentDate ?? (isPT ? 'data não encontrada' : 'date not found');
      return {
        text: isPT
          ? `🧾 Analisei a imagem como recibo/nota.\n\n• Estabelecimento: ${vendor}\n• Valor: ${amount}\n• Data: ${date}\n• Confiança: ${Math.round((result.confidence ?? 0) * 100)}%\n\nPara arquivar ou corrigir os campos, abre Finanças > Capturar recibo.`
          : `🧾 I analyzed the image as a receipt/invoice.\n\n• Merchant: ${vendor}\n• Amount: ${amount}\n• Date: ${date}\n• Confidence: ${Math.round((result.confidence ?? 0) * 100)}%\n\nTo file it or correct any fields, open Finance > Capture Receipt.`,
        domain: 'finance',
        metadata: {
          type: 'invoice_preview',
          invoiceVendor: result.vendor,
          invoiceAmount: result.totalAmount,
        },
      };
    }
    case 'calendar': {
      const visibleEvents = result.events.slice(0, 6);
      const lines = visibleEvents.map((event) => {
        const start = event.start?.slice(11, 16) || '--:--';
        return `• ${start} ${event.title}`;
      });
      const more = result.events.length > visibleEvents.length
        ? (isPT ? `\n_… + ${result.events.length - visibleEvents.length} eventos na imagem._` : `\n_… + ${result.events.length - visibleEvents.length} more events in the image._`)
        : '';
      return {
        text: isPT
          ? `📅 Detetei um horário/agenda nesta imagem.\n\n${lines.join('\n')}${more}\n\nSe quiseres, posso ajudar a transformar isto em eventos do calendário.`
          : `📅 I detected a schedule/calendar in this image.\n\n${lines.join('\n')}${more}\n\nIf you want, I can help turn this into calendar events.`,
        domain: 'secretary',
        metadata: {
          type: 'calendar_preview',
          calendar: visibleEvents.map((event) => ({
            time: event.start?.slice(11, 16) || null,
            title: event.title,
          })),
        },
      };
    }
    case 'task': {
      const subtasks = result.subtasks.slice(0, 6);
      const lines = subtasks.map((item) => `• ${item}`);
      return {
        text: isPT
          ? `✅ Li esta imagem como checklist/tarefa.\n\nTítulo: ${result.title || 'Nova tarefa'}${lines.length > 0 ? `\n\n${lines.join('\n')}` : ''}\n\nSe quiseres, posso transformar isto numa tarefa estruturada.`
          : `✅ I read this image as a checklist/task.\n\nTitle: ${result.title || 'New task'}${lines.length > 0 ? `\n\n${lines.join('\n')}` : ''}\n\nIf you want, I can turn this into a structured task.`,
        domain: 'secretary',
        metadata: {
          type: 'task_preview',
          taskTitle: result.title,
        },
      };
    }
  }
}

function normalizeScriptLanguage(language?: string | null): 'pt-BR' | 'pt-PT' | 'en-US' {
  const normalized = String(language || 'pt-BR').trim().toLowerCase();
  if (normalized.startsWith('en')) return 'en-US';
  if (normalized === 'pt-pt' || normalized.includes('pt-pt') || normalized.includes('portugal') || normalized.includes('europe')) {
    return 'pt-PT';
  }
  return 'pt-BR';
}

function isContentRefinementFollowUp(message: string): boolean {
  return CONTENT_REFINEMENT_PATTERNS.some((pattern) => pattern.test(message));
}

function extractContentRefinementSourceText(previousAssistantMessage: string): string {
  let cleaned = previousAssistantMessage.trim();
  cleaned = cleaned.replace(/^(?:Aviso|Note):[^\n]+(?:\n\n|$)/i, '');
  cleaned = cleaned.replace(/^(?:Roteiro curto|Roteiro|Short script|Script)\s+•[^\n]+(?:\n\n|$)/i, '');
  const refinementSentinels = [
    '\n\nFecho sugerido:',
    '\n\nSuggested closing line:',
    '\n\nTítulos possíveis:',
    '\n\nPossible titles:',
    '\n\nBaseado em ',
    '\n\nGrounded in ',
  ];
  const cutoff = refinementSentinels
    .map((sentinel) => cleaned.indexOf(sentinel))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (typeof cutoff === 'number') {
    cleaned = cleaned.slice(0, cutoff).trim();
  }
  cleaned = sanitizeScriptBody(cleaned);
  return cleaned || previousAssistantMessage.trim();
}

function buildContentRefinementSystemPrompt(language: 'pt-BR' | 'pt-PT' | 'en-US'): string {
  const isPT = language.startsWith('pt');
  return [
    'You revise an existing content draft for chat delivery.',
    isPT
      ? `Responda em ${language === 'pt-PT' ? 'português europeu' : 'pt-BR'} sem mudar para inglês por iniciativa própria.`
      : 'Reply in English unless the user explicitly asks to switch languages.',
    'Revise only the provided draft. Do not invent a new content strategy.',
    'Output only the revised final text for the user.',
    'Do not include headings like SUGGESTED TITLES, THUMBNAIL, CTA, HOOK, SCRIPT, or metadata blocks unless the user explicitly asks for them.',
    'Do not include production markers such as [SFX:], [EDIT:], [SHOW ON SCREEN:], [TAKE], or source sections.',
    'Keep the tone direct, premium, and natural. Avoid filler and assistant framing.',
  ].join('\n');
}

function buildContentRefinementUserPrompt(
  originalText: string,
  instruction: string,
  language: 'pt-BR' | 'pt-PT' | 'en-US',
): string {
  return [
    language === 'en-US'
      ? 'Revise the draft below according to the user instruction.'
      : 'Revê o rascunho abaixo de acordo com a instrução do utilizador.',
    '',
    language === 'en-US' ? 'User instruction:' : 'Instrução do utilizador:',
    instruction.trim(),
    '',
    language === 'en-US' ? 'Current draft:' : 'Rascunho atual:',
    originalText.trim(),
  ].join('\n');
}

function buildContentRefinementUnavailableResponse(
  language: 'pt-BR' | 'pt-PT' | 'en-US',
): string {
  if (language === 'en-US') {
    return 'I could not revise that content right now. Please try again in a moment.';
  }
  if (language === 'pt-PT') {
    return 'Não consegui rever esse conteúdo agora. Tenta novamente dentro de um momento.';
  }
  return 'Não consegui revisar esse conteúdo agora. Tenta novamente em instantes.';
}

function buildHeuristicContentRefinementFallback(
  sourceText: string,
  instruction: string,
  language: 'pt-BR' | 'pt-PT' | 'en-US',
): string | null {
  if (!/\b(shorter|shorten|trim|condense|mais curt[ao]|encurta|resume)\b/i.test(instruction)) {
    return null;
  }

  const normalized = sourceText
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();
  if (!normalized) return null;

  const sentences = normalized
    .match(/[^.!?]+[.!?]?/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [normalized];

  let compact = '';
  for (const sentence of sentences) {
    const next = compact ? `${compact} ${sentence}` : sentence;
    if (next.length > 260 && compact) break;
    compact = next;
    if (compact.length >= 170 && /[.!?]$/.test(compact)) break;
  }

  compact = compact || normalized.slice(0, 260).trim();
  compact = compact.replace(/\s+/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim();

  if (language === 'en-US') {
    return `Note: live rewrite was unavailable, so this is a conservative shorter version.\n\n${compact}`;
  }
  if (language === 'pt-PT') {
    return `Aviso: a revisão em tempo real ficou indisponível, por isso deixei uma versão mais curta e conservadora.\n\n${compact}`;
  }
  return `Aviso: a revisão em tempo real ficou indisponível, então deixei uma versão mais curta e conservadora.\n\n${compact}`;
}

function resolveRequestedScriptLanguage(message: string, fallbackLanguage?: string | null): 'pt-BR' | 'pt-PT' | 'en-US' {
  const lower = message.toLowerCase();
  if (/(?:\bin english\b|\benglish version\b|\benglish please\b|\bem ingl[eê]s\b)/i.test(lower)) return 'en-US';
  if (/(?:\bpt-pt\b|portugu[eê]s europeu|portugu[eê]s de portugal|portuguese from portugal|european portuguese)/i.test(lower)) return 'pt-PT';
  if (/(?:\bpt-br\b|portugu[eê]s brasileiro|brazilian portuguese)/i.test(lower)) return 'pt-BR';
  return normalizeScriptLanguage(fallbackLanguage);
}

function resolveContentShortcutLanguage(message: string, fallbackLanguage?: string | null): 'pt-BR' | 'pt-PT' | 'en-US' {
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

function stripTrailingLanguageQualifier(topic: string): string {
  return topic
    .replace(/\s+(?:in english|english version|english please)\.?$/i, '')
    .replace(/\s+(?:em ingl[eê]s)\.?$/i, '')
    .replace(/\s+(?:em portugu[eê]s europeu|em portugu[eê]s de portugal|em pt-pt)\.?$/i, '')
    .replace(/\s+(?:em portugu[eê]s brasileiro|em pt-br)\.?$/i, '')
    .trim();
}

function parseContentScriptShortcut(message: string): ContentScriptShortcut | null {
  const normalized = message.trim();
  if (!normalized) return null;

  const lower = normalized.toLowerCase();
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

function parseContentStateShortcut(message: string): ContentStateShortcut | null {
  const normalized = message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function parseFinanceStateShortcut(message: string): FinanceStateShortcut | null {
  const normalized = message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function getUserBrandVoice(userId: number): string | null {
  try {
    const { getKnowledgeByCategory } = require('../../state/content-references');
    const row = getKnowledgeByCategory('brand_voice', userId);
    return row?.synthesized_text || null;
  } catch {
    return null;
  }
}

function localizeScriptWarning(
  warning: string,
  language: 'pt-BR' | 'pt-PT' | 'en-US',
): string {
  if (language === 'en-US') {
    return warning;
  }

  const lower = warning.trim().toLowerCase();
  if (lower === 'ai synthesis was unavailable; returning search-based fallback briefs.') {
    return 'A síntese por IA ficou indisponível; devolvi uma versão degradada baseada na pesquisa disponível.';
  }

  if (lower === 'ai generation was unavailable; returned a templated degraded script grounded in the available research.') {
    return 'A geração do roteiro por IA ficou indisponível; devolvi uma versão conservadora baseada na pesquisa disponível.';
  }

  if (lower === 'no strong research sources were found; returning conservative fallback briefs.') {
    return 'Não encontrei fontes de pesquisa suficientemente fortes; devolvi uma versão conservadora.';
  }

  if (lower === 'content engine unavailable') {
    return 'O motor de conteúdo está temporariamente indisponível.';
  }

  return warning;
}

function buildScriptShortcutText(result: ScriptResponse, language: 'pt-BR' | 'pt-PT' | 'en-US', format: 'Reel' | 'YouTube'): string {
  const isPT = language.startsWith('pt');
  const sections: string[] = [];
  const sanitizedScript = sanitizeScriptBody(result.script || '');
  const normalizedScript = sanitizedScript || result.hook?.trim() || '';
  const normalizedCta = result.cta?.trim() || '';
  const lowerScript = normalizedScript.toLowerCase();

  if (result.degraded) {
    const localizedWarnings = Array.isArray(result.warnings)
      ? Array.from(new Set(result.warnings.map((warning) => localizeScriptWarning(warning, language)).filter(Boolean)))
      : [];
    const warnings = localizedWarnings.length > 0
      ? ` ${isPT ? 'Motivos' : 'Reasons'}: ${localizedWarnings.join(' · ')}`
      : '';
    sections.push(
      isPT
        ? `Aviso: este roteiro foi gerado em modo degradado.${warnings}`
        : `Note: this script was generated in degraded mode.${warnings}`,
    );
  }

  const header = isPT
    ? `${format === 'Reel' ? 'Roteiro curto' : 'Roteiro'} • Duração estimada: ${result.estimated_duration}`
    : `${format === 'Reel' ? 'Short script' : 'Script'} • Estimated duration: ${result.estimated_duration}`;
  sections.push(header);

  if (normalizedScript) {
    sections.push(normalizedScript);
  }

  if (normalizedCta && !lowerScript.includes(normalizedCta.toLowerCase())) {
    sections.push(isPT ? `Fecho sugerido: ${normalizedCta}` : `Suggested closing line: ${normalizedCta}`);
  }

  return sections.filter(Boolean).join('\n\n');
}

function buildScriptUnavailableResponse(language: 'pt-BR' | 'pt-PT' | 'en-US'): string {
  if (language === 'en-US') {
    return 'I could not generate the structured script right now because the content engine is temporarily unavailable. Please try again in a minute.';
  }
  if (language === 'pt-PT') {
    return 'Não consegui gerar o roteiro estruturado agora porque o motor de conteúdo está temporariamente indisponível. Tenta novamente dentro de um minuto.';
  }
  return 'Não consegui gerar o roteiro estruturado agora porque o motor de conteúdo está temporariamente indisponível. Tenta de novo em um minuto.';
}

function formatContentShortcutDate(date: string, language: 'pt-BR' | 'pt-PT' | 'en-US'): string {
  const locale = language === 'en-US' ? 'en-US' : language === 'pt-PT' ? 'pt-PT' : 'pt-BR';
  const formatter = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
  return formatter.format(new Date(`${date}T12:00:00Z`));
}

function describeDeskItemType(type: string, language: 'pt-BR' | 'pt-PT' | 'en-US'): string {
  switch (type) {
    case 'script_ready':
      return language === 'en-US' ? 'Script ready' : 'Roteiro pronto';
    case 'topic_candidates_ready':
      return language === 'en-US' ? 'Ideas ready' : 'Ideias prontas';
    case 'weekly_package_ready':
      return language === 'en-US' ? 'Weekly package ready' : 'Pacote semanal pronto';
    default:
      return language === 'en-US' ? 'Ready item' : 'Item pronto';
  }
}

function formatOptionalTopicDate(
  date: string | null,
  language: 'pt-BR' | 'pt-PT' | 'en-US',
): string | null {
  if (!date) return null;
  return formatContentShortcutDate(date, language);
}

function chooseNextContentPriority(
  topics: ContentTopic[],
): ContentTopic | null {
  const rankedStatuses: Array<ContentTopic['status']> = ['ready', 'drafting', 'planned'];
  for (const status of rankedStatuses) {
    const scheduled = topics.find((topic) => topic.status === status && topic.scheduled_date);
    if (scheduled) return scheduled;
    const unscheduled = topics.find((topic) => topic.status === status);
    if (unscheduled) return unscheduled;
  }
  return null;
}

function formatViews(value: number, language: 'pt-BR' | 'pt-PT' | 'en-US'): string {
  const locale = language === 'en-US' ? 'en-US' : language;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

function localizeContentPatternCategory(category: string, language: 'pt-BR' | 'pt-PT' | 'en-US'): string {
  const labels: Record<string, { en: string; pt: string }> = {
    hook_effectiveness: { en: 'Hook performance', pt: 'Performance dos hooks' },
    pillar_performance: { en: 'Pillar performance', pt: 'Performance dos pilares' },
    learning_digest: { en: 'Weekly learning', pt: 'Aprendizagem semanal' },
    content_formula: { en: 'Winning format', pt: 'Formato vencedor' },
    retention_pattern: { en: 'Retention pattern', pt: 'Padrão de retenção' },
    voice_pattern: { en: 'Voice pattern', pt: 'Padrão de voz' },
  };
  const label = labels[category.trim().toLowerCase()];
  if (label) return language === 'en-US' ? label.en : label.pt;
  return category.replace(/_/g, ' ');
}

function resolveFinanceShortcutLanguage(userLanguage: string | null | undefined): 'pt-BR' | 'pt-PT' | 'en-US' {
  if (!userLanguage) return 'en-US';
  if (userLanguage === 'pt-PT') return 'pt-PT';
  if (userLanguage.startsWith('pt')) return 'pt-BR';
  return 'en-US';
}

function formatFinanceMonthLabel(month: string, language: 'pt-BR' | 'pt-PT' | 'en-US'): string {
  const date = DateTime.fromFormat(month, 'yyyy-MM').startOf('month');
  const locale = language === 'en-US' ? 'en-US' : language;
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(date.toJSDate());
}

function formatFinanceDate(value: string, language: 'pt-BR' | 'pt-PT' | 'en-US'): string {
  const date = DateTime.fromISO(value);
  const locale = language === 'en-US' ? 'en-US' : language;
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' }).format(date.toJSDate());
}

function formatFiscalProviderLabel(provider: string): string {
  switch (provider) {
    case 'gmail':
      return 'Gmail';
    case 'outlook':
      return 'Outlook';
    default:
      return provider;
  }
}

async function buildContentStateShortcutResponse(
  shortcut: ContentStateShortcut,
  userId: number,
  language: 'pt-BR' | 'pt-PT' | 'en-US',
): Promise<{ text: string; metadata: Record<string, unknown> }> {
  switch (shortcut) {
    case 'desk': {
      const items = getContentDeskItems(userId, 3);
      if (items.length === 0) {
        return {
          text: language === 'en-US'
            ? 'There is nothing desk-ready right now. The content desk is still warming up.'
            : 'Não há nada pronto na sua mesa agora. A mesa de conteúdo ainda está aquecendo.',
          metadata: { type: 'content_desk_snapshot', deskReadyCount: 0, deskItems: [] },
        };
      }

      const lines = items.map((item) => `• ${describeDeskItemType(item.type, language)} — ${item.title}`);
      return {
        text: language === 'en-US'
          ? `This is already on your desk right now:\n\n${lines.join('\n')}\n\nOpen Content to review, refine, or move these items forward.`
          : `Isto já está na sua mesa agora:\n\n${lines.join('\n')}\n\nAbra Conteúdo para revisar, lapidar, ou empurrar estes itens no pipeline.`,
        metadata: { type: 'content_desk_snapshot', deskReadyCount: items.length, deskItems: items },
      };
    }
    case 'pillars': {
      const pillars = getActiveContentPillars(userId);
      if (pillars.length === 0) {
      return {
        text: language === 'en-US'
          ? 'I do not see any active content pillars yet. Configure them in Content so discovery can stay focused.'
          : 'Ainda não vejo pilares de conteúdo ativos. Configure isso em Conteúdo para a descoberta ficar focada.',
          metadata: { type: 'content_pillars_snapshot', monitoredPillars: [] },
        };
      }

      const lines = pillars.map((pillar) => `• ${pillar.name} (${pillar.keywordCount} ${language === 'en-US' ? 'keywords' : 'palavras-chave'})`);
      return {
        text: language === 'en-US'
          ? `These are the pillars you are actively tracking right now:\n\n${lines.join('\n')}`
          : `Estes são os pilares que você está acompanhando agora:\n\n${lines.join('\n')}`,
        metadata: { type: 'content_pillars_snapshot', monitoredPillars: pillars },
      };
    }
    case 'filming': {
      const recommendation = localizeFilmingRecommendation(await getFilmingRecommendation(userId), language);
      const upcomingCount = getUpcomingTopicCount(userId, 7);
      if (!recommendation) {
        return {
          text: language === 'en-US'
            ? `I do not have a strong filming recommendation yet. You have ${upcomingCount} scheduled content item(s) in the next 7 days.`
            : `Ainda não tenho uma recomendação forte de filmagem. Há ${upcomingCount} item(ns) de conteúdo agendado(s) para os próximos 7 dias.`,
          metadata: { type: 'content_filming_snapshot', filmingRecommendation: null, upcomingCount },
        };
      }

      const block = recommendation.blockStart && recommendation.blockEnd
        ? (language === 'en-US'
          ? `• Suggested block: ${recommendation.blockStart.slice(11, 16)}-${recommendation.blockEnd.slice(11, 16)}`
          : `• Bloco sugerido: ${recommendation.blockStart.slice(11, 16)}-${recommendation.blockEnd.slice(11, 16)}`)
        : null;
      const reservation = recommendation.calendarReservationMessage
        ? `• ${recommendation.calendarReservationMessage}`
        : null;
      const lines = [
        language === 'en-US'
          ? `• Best day: ${formatContentShortcutDate(recommendation.date, language)}`
          : `• Melhor dia: ${formatContentShortcutDate(recommendation.date, language)}`,
        language === 'en-US'
          ? `• Confidence: ${recommendation.confidence}`
          : `• Confiança: ${recommendation.confidence}`,
        block,
        `• ${recommendation.reason}`,
        language === 'en-US'
          ? `• Upcoming scheduled topics: ${upcomingCount}`
          : `• Tópicos agendados para os próximos 7 dias: ${upcomingCount}`,
        reservation,
      ].filter((line): line is string => Boolean(line));

      return {
        text: language === 'en-US'
          ? `This is the best filming window I can see for your week:\n\n${lines.join('\n')}`
          : `Esta é a melhor janela de filmagem que vejo para esta semana:\n\n${lines.join('\n')}`,
        metadata: {
          type: 'content_filming_snapshot',
          filmingRecommendation: recommendation,
          upcomingCount,
        },
      };
    }
    case 'next_publish': {
      const topics = getTopics(userId, { includeTerminal: false, limit: 50 });
      const nextTopic = chooseNextContentPriority(topics);
      const deskItems = getContentDeskItems(userId, 3);
      const scriptReady = deskItems.find((item) => item.type === 'script_ready');

      if (nextTopic) {
        const dateLabel = formatOptionalTopicDate(nextTopic.scheduled_date, language);
        const statusLabel = language === 'en-US'
          ? nextTopic.status
          : nextTopic.status === 'ready'
            ? 'pronto'
            : nextTopic.status === 'drafting'
              ? 'em rascunho'
              : 'planejado';
        const nextStep = nextTopic.status === 'ready'
          ? (language === 'en-US'
            ? 'This is the strongest next publish candidate in your pipeline.'
            : 'Este é o candidato mais forte para publicar a seguir no seu pipeline.')
          : (language === 'en-US'
            ? 'This is the clearest next content priority, but it still needs work before publish.'
            : 'Esta é a prioridade mais clara de conteúdo, mas ainda precisa de trabalho antes de publicar.');
        const scheduleLine = dateLabel
          ? (language === 'en-US'
            ? `• Scheduled for: ${dateLabel}`
            : `• Agendado para: ${dateLabel}`)
          : null;

        return {
          text: language === 'en-US'
            ? `${nextStep}\n\n• ${nextTopic.title}\n• Status: ${statusLabel}${scheduleLine ? `\n${scheduleLine}` : ''}`
            : `${nextStep}\n\n• ${nextTopic.title}\n• Status: ${statusLabel}${scheduleLine ? `\n${scheduleLine}` : ''}`,
          metadata: {
            type: 'content_next_publish_snapshot',
            nextTopic: {
              id: nextTopic.id,
              title: nextTopic.title,
              status: nextTopic.status,
              scheduledDate: nextTopic.scheduled_date,
            },
            deskReadyCount: deskItems.length,
          },
        };
      }

      if (scriptReady) {
        return {
          text: language === 'en-US'
            ? `The clearest next publish candidate is already on your desk:\n\n• ${scriptReady.title}\n\nOpen Content to review the script and move it forward.`
            : `O candidato mais claro para publicar a seguir já está na sua mesa:\n\n• ${scriptReady.title}\n\nAbra Conteúdo para rever o roteiro e avançar com ele.`,
          metadata: {
            type: 'content_next_publish_snapshot',
            nextDeskItem: scriptReady,
            deskReadyCount: deskItems.length,
          },
        };
      }

      return {
        text: language === 'en-US'
          ? 'I do not see a clear next publish candidate yet. Open Content to promote a topic into drafting or generate a fresh script package.'
          : 'Ainda não vejo um próximo candidato claro para publicar. Abra Conteúdo para promover um tema para rascunho ou gerar um novo pacote de roteiro.',
        metadata: {
          type: 'content_next_publish_snapshot',
          nextTopic: null,
          deskReadyCount: deskItems.length,
        },
      };
    }
    case 'performance': {
      const summary = getPerformanceSummary(userId, 30);
      if (summary.count === 0) {
        return {
          text: language === 'en-US'
            ? 'I do not have any logged content performance yet. Publish something first, then I can tell you what is actually winning.'
            : 'Ainda não tenho performance de conteúdo registada. Publique algo primeiro e depois consigo dizer o que está a ganhar.',
          metadata: {
            type: 'content_performance_snapshot',
            count: 0,
            bestByViews: null,
            bestByRetention: null,
          },
        };
      }

      const bestByViews = summary.entries.reduce((best, current) => current.views > best.views ? current : best, summary.entries[0]);
      const bestByRetention = summary.entries.reduce((best, current) => current.retentionPct > best.retentionPct ? current : best, summary.entries[0]);
      const sameEntryLeads = bestByViews.id === bestByRetention.id;
      const viewsLine = language === 'en-US'
        ? `• Best by views: ${bestByViews.videoUrl || 'Logged video'} (${formatViews(bestByViews.views, language)} views)`
        : `• Melhor em views: ${bestByViews.videoUrl || 'Vídeo registado'} (${formatViews(bestByViews.views, language)} views)`;
      const retentionLine = language === 'en-US'
        ? `• Best by retention: ${bestByRetention.videoUrl || 'Logged video'} (${bestByRetention.retentionPct}% retention)`
        : `• Melhor em retenção: ${bestByRetention.videoUrl || 'Vídeo registado'} (${bestByRetention.retentionPct}% de retenção)`;
      const averageLine = language === 'en-US'
        ? `• 30-day average: ${formatViews(summary.avgViews, language)} views · ${summary.avgRetention}% retention`
        : `• Média de 30 dias: ${formatViews(summary.avgViews, language)} views · ${summary.avgRetention}% de retenção`;
      const headline = sameEntryLeads
        ? (language === 'en-US'
          ? 'One content piece is clearly leading your recent performance.'
          : 'Uma peça de conteúdo está claramente a liderar a tua performance recente.')
        : (language === 'en-US'
          ? 'Your recent performance has a clear winner by views and another by retention.'
          : 'A tua performance recente tem um vencedor claro em views e outro em retenção.');

      return {
        text: `${headline}\n\n${viewsLine}\n${retentionLine}\n${averageLine}`,
        metadata: {
          type: 'content_performance_snapshot',
          count: summary.count,
          avgViews: summary.avgViews,
          avgRetention: summary.avgRetention,
          bestByViews: {
            id: bestByViews.id,
            videoUrl: bestByViews.videoUrl,
            views: bestByViews.views,
            retentionPct: bestByViews.retentionPct,
          },
          bestByRetention: {
            id: bestByRetention.id,
            videoUrl: bestByRetention.videoUrl,
            views: bestByRetention.views,
            retentionPct: bestByRetention.retentionPct,
          },
        },
      };
    }
    case 'learning': {
      const patterns = getLearnedPatterns(userId).slice(0, 3);
      if (patterns.length === 0) {
        const summary = getPerformanceSummary(userId, 30);
        if (summary.count > 0) {
          return {
            text: language === 'en-US'
              ? `There is already performance history, but not a strong enough pattern yet to count as durable learning.\n\n• 30-day average: ${formatViews(summary.avgViews, language)} views · ${summary.avgRetention}% retention\n• Next step: log the hooks used and post-publish notes so the system can lock in what is working.`
              : `Já existe histórico de performance, mas ainda não há um padrão forte o suficiente para virar aprendizagem durável.\n\n• Média de 30 dias: ${formatViews(summary.avgViews, language)} views · ${summary.avgRetention}% de retenção\n• Próximo passo: registar os hooks usados e as notas pós-publicação para consolidar o que está funcionando.`,
            metadata: {
              type: 'content_learning_snapshot',
              count: 0,
              avgViews: summary.avgViews,
              avgRetention: summary.avgRetention,
              patterns: [],
            },
          };
        }

        return {
          text: language === 'en-US'
            ? 'There is not enough logged learning yet to answer this confidently. As new results and patterns come in, I will summarize what is working across hooks, format, and retention.'
            : 'Ainda não existe aprendizagem suficiente registada para responder com confiança. À medida que novos resultados e padrões entram, eu resumo o que está funcionando em hook, formato e retenção.',
          metadata: {
            type: 'content_learning_snapshot',
            count: 0,
            patterns: [],
          },
        };
      }

      const lines = patterns.map((pattern) => {
        const label = localizeContentPatternCategory(pattern.category, language);
        const confidence = Math.round(pattern.confidence * 100);
        return language === 'en-US'
          ? `• ${label}: ${pattern.patternText} (${confidence}% confidence, seen ${pattern.frequency}x)`
          : `• ${label}: ${pattern.patternText} (${confidence}% de confiança, visto ${pattern.frequency}x)`;
      });

      return {
        text: language === 'en-US'
          ? `Here is what the learning loop is picking up right now:\n\n${lines.join('\n')}`
          : `Isto é o que o loop de aprendizagem está vendo agora:\n\n${lines.join('\n')}`,
        metadata: {
          type: 'content_learning_snapshot',
          count: patterns.length,
          patterns: patterns.map((pattern) => ({
            id: pattern.id,
            category: pattern.category,
            patternText: pattern.patternText,
            confidence: pattern.confidence,
            frequency: pattern.frequency,
          })),
        },
      };
    }
  }
}

function buildFinanceStateShortcutResponse(
  shortcut: FinanceStateShortcut,
  userId: number,
  language: 'pt-BR' | 'pt-PT' | 'en-US',
): { text: string; metadata: Record<string, unknown> } {
  switch (shortcut) {
    case 'missing_bills': {
      const now = DateTime.now().setZone('Europe/Lisbon');
      const vendors = getAllInvoiceVendors(userId);
      const filings = getFilingsForMonth(now.year, now.month, userId).filter((filing) => filing.status === 'filed');
      const filedVendors = [...new Set(filings.map((filing) => filing.vendor.trim()))];
      const filedVendorNames = new Set(filedVendors.map((vendor) => vendor.toLowerCase()));
      const missingVendors = vendors
        .filter((vendor) => !filedVendorNames.has(vendor.name.toLowerCase()))
        .map((vendor) => vendor.name);
      const monthLabel = formatFinanceMonthLabel(now.toFormat('yyyy-MM'), language);

      if (vendors.length === 0) {
        return {
          text: language === 'en-US'
            ? 'I do not see any tracked invoice vendors yet. Add them in Fiscal Collection so I can tell you what is still missing each month.'
            : 'Ainda não vejo fornecedores acompanhados na recolha fiscal. Adicione-os em Recolha fiscal para eu dizer o que ainda falta em cada mês.',
          metadata: {
            type: 'finance_missing_bills_snapshot',
            month: now.toFormat('yyyy-MM'),
            trackedVendorCount: 0,
            filedVendorCount: 0,
            missingVendors: [],
            filedVendors: [],
          },
        };
      }

      if (missingVendors.length === 0) {
        return {
          text: language === 'en-US'
            ? `Nothing looks missing for ${monthLabel} across your tracked invoice vendors.\n\n• Tracked vendors: ${vendors.length}\n• Filed this month: ${filedVendors.length}`
            : `Nada parece estar em falta para ${monthLabel} nos seus fornecedores acompanhados.\n\n• Fornecedores acompanhados: ${vendors.length}\n• Com fatura registada este mês: ${filedVendors.length}`,
          metadata: {
            type: 'finance_missing_bills_snapshot',
            month: now.toFormat('yyyy-MM'),
            trackedVendorCount: vendors.length,
            filedVendorCount: filedVendors.length,
            missingVendors: [],
            filedVendors,
          },
        };
      }

      const preview = missingVendors.slice(0, 5).map((vendor) => `• ${vendor}`).join('\n');
      const remainder = missingVendors.length > 5
        ? (language === 'en-US'
          ? `\n• +${missingVendors.length - 5} more tracked vendors`
          : `\n• +${missingVendors.length - 5} fornecedores acompanhados`)
        : '';

      return {
        text: language === 'en-US'
          ? `These tracked bills still look missing for ${monthLabel}:\n\n${preview}${remainder}\n\n• Filed this month: ${filedVendors.length} of ${vendors.length}`
          : `Estas contas acompanhadas ainda parecem em falta em ${monthLabel}:\n\n${preview}${remainder}\n\n• Registadas este mês: ${filedVendors.length} de ${vendors.length}`,
        metadata: {
          type: 'finance_missing_bills_snapshot',
          month: now.toFormat('yyyy-MM'),
          trackedVendorCount: vendors.length,
          filedVendorCount: filedVendors.length,
          missingVendors,
          filedVendors,
        },
      };
    }
    case 'subscription_renewal': {
      const subscription = getSubscriptionStatus(userId);
      if (!subscription.isActive || !subscription.currentPeriodEnd) {
        return {
          text: language === 'en-US'
            ? 'Right now the durable renewal tracker only has Nexus Hub subscription state, and I do not see an active renewal scheduled.'
            : 'Neste momento o rastreador durável de renovações só tem o estado da subscrição do Nexus Hub, e eu não vejo nenhuma renovação ativa agendada.',
          metadata: {
            type: 'finance_subscription_snapshot',
            trackedSubscriptions: 0,
            renewalDueSoon: false,
            subscription: null,
          },
        };
      }

      const renewalDate = DateTime.fromISO(subscription.currentPeriodEnd);
      const daysUntil = Math.ceil(renewalDate.diffNow('days').days);
      const renewalDueSoon = daysUntil <= 14;
      const planLabel = `${subscription.plan} ${subscription.period}`;
      const statusLine = subscription.cancelAtPeriodEnd
        ? (language === 'en-US' ? 'Scheduled to end at period close' : 'Agendada para terminar no fecho do período')
        : (language === 'en-US' ? 'Auto-renew is still on' : 'A renovação automática continua ativa');

      return {
        text: language === 'en-US'
          ? `Right now the durable renewal tracker only includes Nexus Hub.\n\n• Plan: ${planLabel}\n• ${renewalDueSoon ? 'Renews soon' : 'Next renewal'}: ${formatFinanceDate(subscription.currentPeriodEnd, language)} (${daysUntil} day${daysUntil === 1 ? '' : 's'})\n• ${statusLine}`
          : `Neste momento o rastreador durável de renovações inclui apenas o Nexus Hub.\n\n• Plano: ${planLabel}\n• ${renewalDueSoon ? 'Renova em breve' : 'Próxima renovação'}: ${formatFinanceDate(subscription.currentPeriodEnd, language)} (${daysUntil} dia${daysUntil === 1 ? '' : 's'})\n• ${statusLine}`,
        metadata: {
          type: 'finance_subscription_snapshot',
          trackedSubscriptions: 1,
          renewalDueSoon,
          subscription: {
            plan: subscription.plan,
            period: subscription.period,
            status: subscription.status,
            provider: subscription.provider,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          },
        },
      };
    }
    case 'budget_remaining': {
      const now = DateTime.now().setZone('Europe/Lisbon');
      const month = now.toFormat('yyyy-MM');
      const monthLabel = formatFinanceMonthLabel(month, language);
      const summary = getMonthlySummary(userId, month);
      const remaining = Math.max(summary.totalIncome - summary.totalExpenses, 0);
      const remainingRatio = summary.totalIncome > 0
        ? Math.round((remaining / summary.totalIncome) * 100)
        : 0;

      if (summary.totalIncome <= 0) {
        return {
          text: language === 'en-US'
            ? `I do not have any logged income for ${monthLabel} yet, so I cannot compute a real remaining budget from your actual numbers.\n\n• Logged expenses so far: ${formatViews(summary.totalExpenses, language)}\n• Logged transactions: ${summary.transactionCount}`
            : `Ainda não tenho rendimento registado para ${monthLabel}, por isso não consigo calcular um orçamento restante real a partir dos seus números.\n\n• Despesas registadas até agora: ${formatViews(summary.totalExpenses, language)}\n• Transações registadas: ${summary.transactionCount}`,
          metadata: {
            type: 'finance_budget_snapshot',
            month,
            totalIncome: summary.totalIncome,
            totalExpenses: summary.totalExpenses,
            remaining,
            remainingRatio,
            transactionCount: summary.transactionCount,
            derived: false,
          },
        };
      }

      return {
        text: language === 'en-US'
          ? `This is your remaining budget view for ${monthLabel} based on logged income vs expenses.\n\n• Income logged: ${formatViews(summary.totalIncome, language)}\n• Expenses logged: ${formatViews(summary.totalExpenses, language)}\n• Remaining: ${formatViews(remaining, language)} (${remainingRatio}% left)`
          : `Esta é a sua visão de orçamento restante para ${monthLabel}, com base no rendimento e nas despesas registadas.\n\n• Rendimento registado: ${formatViews(summary.totalIncome, language)}\n• Despesas registadas: ${formatViews(summary.totalExpenses, language)}\n• Restante: ${formatViews(remaining, language)} (${remainingRatio}% disponível)`,
        metadata: {
          type: 'finance_budget_snapshot',
          month,
          totalIncome: summary.totalIncome,
          totalExpenses: summary.totalExpenses,
          remaining,
          remainingRatio,
          transactionCount: summary.transactionCount,
          derived: true,
        },
      };
    }
    case 'next_tax_due': {
      const pendingEvent = getTaxEvents(userId, { limit: 24 }).find((event) => String(event.status).toLowerCase() !== 'paid') ?? null;
      if (pendingEvent) {
        return {
          text: language === 'en-US'
            ? `The next stored tax due is the ${pendingEvent.month} Carnê-Leão / DARF 0190 entry.\n\n• Tax due: ${formatViews(pendingEvent.tax_due, language)}\n• INSS due: ${formatViews(pendingEvent.inss_due, language)}\n• Status: ${pendingEvent.status}`
            : `O próximo imposto registado em aberto é a entrada de Carnê-Leão / DARF 0190 de ${pendingEvent.month}.\n\n• Imposto devido: ${formatViews(pendingEvent.tax_due, language)}\n• INSS devido: ${formatViews(pendingEvent.inss_due, language)}\n• Estado: ${pendingEvent.status}`,
          metadata: {
            type: 'finance_tax_snapshot',
            month: pendingEvent.month,
            taxDue: pendingEvent.tax_due,
            inssDue: pendingEvent.inss_due,
            status: pendingEvent.status,
            derived: false,
          },
        };
      }

      const now = DateTime.now().setZone('Europe/Lisbon');
      const month = now.toFormat('yyyy-MM');
      const summary = getMonthlySummary(userId, month);
      if (summary.totalIncome > 0 || summary.totalDeductions > 0) {
        const preview = calculateMonthlyTax(summary.totalIncome, summary.totalDeductions);
        return {
          text: language === 'en-US'
            ? `I do not see a stored pending tax event, but the current ${month} numbers point to this preview.\n\n• Gross income: ${formatViews(summary.totalIncome, language)}\n• Deductions: ${formatViews(summary.totalDeductions, language)}\n• Estimated DARF 0190: ${formatViews(preview.taxDue, language)}`
            : `Não vejo um evento fiscal pendente já registado, mas os números atuais de ${month} apontam para esta prévia.\n\n• Rendimento bruto: ${formatViews(summary.totalIncome, language)}\n• Deduções: ${formatViews(summary.totalDeductions, language)}\n• DARF 0190 estimado: ${formatViews(preview.taxDue, language)}`,
          metadata: {
            type: 'finance_tax_snapshot',
            month,
            taxDue: preview.taxDue,
            inssDue: preview.inssDue,
            status: 'preview',
            derived: true,
          },
        };
      }

      return {
        text: language === 'en-US'
          ? 'I do not see any stored pending tax event right now, and there is not enough logged income yet to preview the next DARF confidently.'
          : 'Não vejo nenhum evento fiscal pendente registado neste momento, e ainda não há rendimento suficiente registado para prever o próximo DARF com confiança.',
        metadata: {
          type: 'finance_tax_snapshot',
          month: null,
          taxDue: null,
          inssDue: null,
          status: 'none',
          derived: false,
        },
      };
    }
    case 'accountant_bundle': {
      const summary = getFiscalCollectionSummary(userId);
      const connectedProviders = summary.providers
        .filter((provider) => provider.connected)
        .map((provider) => formatFiscalProviderLabel(provider.provider));
      const warningSet = new Set(summary.warnings);
      const destinationLine = summary.destinationEmail
        ? summary.destinationEmail
        : (language === 'en-US' ? 'Missing destination email' : 'E-mail de destino em falta');
      const cadenceLine = summary.profile.cadence === 'twice_monthly'
        ? (language === 'en-US' ? 'Twice monthly' : 'Duas vezes por mês')
        : (language === 'en-US' ? 'Monthly' : 'Mensal');
      const lastBundleLine = summary.profile.last_bundle_sent_at
        ? formatFinanceDate(summary.profile.last_bundle_sent_at, language)
        : (language === 'en-US' ? 'No bundle sent yet' : 'Ainda não foi enviado nenhum bundle');
      const nextRunLine = summary.nextRunAt
        ? formatFinanceDate(summary.nextRunAt, language)
        : (language === 'en-US' ? 'No send date scheduled yet' : 'Ainda não há data de envio agendada');

      const blockers: string[] = [];
      if (warningSet.has('DESTINATION_EMAIL_MISSING')) {
        blockers.push(language === 'en-US'
          ? 'Add the destination email for your accountant.'
          : 'Defina o e-mail de destino do seu contabilista.');
      }
      if (warningSet.has('NO_MAIL_PROVIDER_CONNECTED')) {
        blockers.push(language === 'en-US'
          ? 'Connect Gmail or Outlook so Nexus can scan the source invoices.'
          : 'Ligue o Gmail ou o Outlook para o Nexus analisar as faturas de origem.');
      }
      if (warningSet.has('BUNDLE_DELIVERY_NOT_CONFIGURED')) {
        blockers.push(language === 'en-US'
          ? 'Bundle delivery is not configured on this server yet.'
          : 'O envio do bundle ainda não está configurado neste servidor.');
      }

      const headline = summary.warnings.length === 0
        ? (language === 'en-US'
          ? 'Your accountant handoff is ready.'
          : 'A entrega ao contabilista está pronta.')
        : (language === 'en-US'
          ? 'Your accountant handoff still needs a couple of pieces.'
          : 'A entrega ao contabilista ainda precisa de alguns ajustes.');

      const providerLine = connectedProviders.length > 0
        ? connectedProviders.join(', ')
        : (language === 'en-US' ? 'None connected yet' : 'Ainda sem fornecedores ligados');

      const blockerText = blockers.length > 0
        ? `\n\n${blockers.slice(0, 3).map((line) => `• ${line}`).join('\n')}`
        : '';

      return {
        text: language === 'en-US'
          ? `${headline}\n\n• Destination: ${destinationLine}\n• Cadence: ${cadenceLine}\n• Mail sources connected: ${providerLine}\n• Vendor rules tracked: ${summary.ruleCount}\n• Last bundle sent: ${lastBundleLine}\n• Next scheduled send: ${nextRunLine}${blockerText}`
          : `${headline}\n\n• Destino: ${destinationLine}\n• Cadência: ${cadenceLine}\n• Fontes de e-mail ligadas: ${providerLine}\n• Regras de fornecedores acompanhadas: ${summary.ruleCount}\n• Último bundle enviado: ${lastBundleLine}\n• Próximo envio agendado: ${nextRunLine}${blockerText}`,
        metadata: {
          type: 'finance_accountant_bundle_snapshot',
          destinationEmail: summary.destinationEmail,
          cadence: summary.profile.cadence,
          connectedProviders,
          ruleCount: summary.ruleCount,
          customRuleCount: summary.customRuleCount,
          warnings: summary.warnings,
          nextRunAt: summary.nextRunAt,
          lastBundleSentAt: summary.profile.last_bundle_sent_at,
          lastBundleDocumentCount: summary.profile.last_bundle_document_count,
          deliveryAvailable: summary.deliveryAvailable,
        },
      };
    }
    case 'monthly_spend': {
      const now = DateTime.now().setZone('Europe/Lisbon');
      const month = now.toFormat('yyyy-MM');
      const monthLabel = formatFinanceMonthLabel(month, language);
      const summary = getMonthlySummary(userId, month);
      return {
        text: language === 'en-US'
          ? `This is your logged spending for ${monthLabel}.\n\n• Total spending: ${formatViews(summary.totalExpenses, language)}\n• Logged transactions: ${summary.transactionCount}`
          : `Esta é a sua despesa registada em ${monthLabel}.\n\n• Gasto total: ${formatViews(summary.totalExpenses, language)}\n• Transações registadas: ${summary.transactionCount}`,
        metadata: {
          type: 'finance_monthly_spend_snapshot',
          month,
          totalExpenses: summary.totalExpenses,
          transactionCount: summary.transactionCount,
        },
      };
    }
    case 'filed_invoices': {
      const now = DateTime.now().setZone('Europe/Lisbon');
      const month = now.toFormat('yyyy-MM');
      const monthLabel = formatFinanceMonthLabel(month, language);
      const filings = getFilingsForMonth(now.year, now.month, userId).filter((filing) => filing.status === 'filed');
      if (filings.length === 0) {
        return {
          text: language === 'en-US'
            ? `I do not see any filed invoices for ${monthLabel} yet.`
            : `Ainda não vejo nenhuma fatura registada em ${monthLabel}.`,
          metadata: {
            type: 'finance_filed_invoices_snapshot',
            month,
            filedCount: 0,
            vendors: [],
          },
        };
      }

      const vendors = [...new Set(filings.map((filing) => filing.vendor.trim()).filter(Boolean))];
      const preview = vendors.slice(0, 5).map((vendor) => `• ${vendor}`).join('\n');
      const remainder = vendors.length > 5
        ? (language === 'en-US'
          ? `\n• +${vendors.length - 5} more vendors`
          : `\n• +${vendors.length - 5} fornecedores`)
        : '';

      return {
        text: language === 'en-US'
          ? `These invoices are already filed for ${monthLabel}:\n\n${preview}${remainder}\n\n• Filed documents: ${filings.length}`
          : `Estas faturas já estão registadas em ${monthLabel}:\n\n${preview}${remainder}\n\n• Documentos registados: ${filings.length}`,
        metadata: {
          type: 'finance_filed_invoices_snapshot',
          month,
          filedCount: filings.length,
          vendors,
        },
      };
    }
  }
}

function sanitizeScriptBody(script: string): string {
  let cleaned = script.trim();
  const sentinels = [
    '\n📋 FONTES VERIFICADAS:',
    '\nFONTES VERIFICADAS:',
    '\nCTA:\n',
    '\nCAPTION:\n',
    '\nCaption:\n',
    '\nHASHTAGS:\n',
    '\nHashtags:\n',
    '\n---METADATA---',
  ];
  const cutoff = sentinels
    .map((sentinel) => cleaned.indexOf(sentinel))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (typeof cutoff === 'number') {
    cleaned = cleaned.slice(0, cutoff).trim();
  }
  const filteredLines = cleaned
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !/^\s*={3,}.*={3,}\s*$/i.test(line))
    .filter((line) => !/^\s*(hook|gancho|setup|payoff|script|roteiro|body(?:\s*[-—]\s*point\s*\d+)?|cta|caption|hashtags?|title options|titles|t[ií]tulos?)\s*:?\s*$/i.test(line))
    .filter((line) => !/^\s*(cta|caption|hashtags?|title options|titles|t[ií]tulos?)\s*:/i.test(line));
  cleaned = filteredLines.join('\n').trim();
  cleaned = cleaned
    .replace(/\[(?:SHOW ON SCREEN|ON SCREEN|VISUAL|B-ROLL):[^\]]+\]/gi, '')
    .replace(/\[(?:SFX|EDIT|CUT TO|PLAY CLIP):[^\]]+\]/gi, '')
    .replace(/\[(?:PAUSE|BEAT)\]/gi, '')
    .replace(/\[(?:TAKE)\]/gi, '')
    .replace(/\[(?:VERIFIED|NEEDS VERIFICATION):[^\]]+\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/([!?])\./g, '$1');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

function persistExchange(
  userId: number,
  userMessageId: string,
  userText: string,
  assistantMessageId: string,
  assistant: {
    text: string;
    domain?: string | null;
    routeMethod?: string | null;
    confidence?: number | null;
    buttons?: unknown;
    metadata?: unknown;
    timestamp: string;
  },
): void {
  storeChatMessage({
    userId,
    messageId: userMessageId,
    role: 'user',
    text: userText,
    timestamp: assistant.timestamp,
  });
  storeChatMessage({
    userId,
    messageId: assistantMessageId,
    role: 'assistant',
    text: assistant.text,
    domain: assistant.domain,
    routeMethod: assistant.routeMethod,
    confidence: assistant.confidence,
    buttons: assistant.buttons,
    metadata: assistant.metadata,
    timestamp: assistant.timestamp,
  });
}

function syncConversationStateForShortcut(
  userId: number,
  domain: DomainName,
  userText: string,
  assistantText: string,
): void {
  addToConversation(userId, domain, 'user', userText);
  addToConversation(userId, domain, 'assistant', assistantText);
}

function syncConversationAssistantEdit(
  userId: number,
  domain: DomainName,
  assistantText: string,
): void {
  syncLastAssistantConversationMessage(userId, domain, assistantText);
}

function defaultButtonsForDomain(
  domain: string,
  lang: string,
  userId?: number,
  requestStartedAt?: number,
): { text: string; callbackData: string }[][] | null {
  if (domain === 'secretary') {
    return buildSecretaryQuickActionButtons(labelsForLanguage(lang));
  }
  if (domain === 'triathlon' && userId && requestStartedAt) {
    const coachState = getLastCoachState(userId);
    if (coachState && coachState.timestamp >= requestStartedAt - 1000) {
      const buttons = buildCoachRecommendationButtons(coachState.recommendations, labelsForLanguage(lang));
      return buttons.length > 0 ? buttons : null;
    }
  }
  return null;
}

function buildScriptShortcutMetadata(result: ScriptResponse, format: 'Reel' | 'YouTube'): Record<string, unknown> {
  return {
    type: 'content_script',
    topic: result.topic,
    format,
    hook: result.hook,
    titleOptions: result.title_options ?? [],
    hashtags: result.hashtags ?? [],
    caption: result.caption ?? '',
    cta: result.cta ?? '',
    estimatedDuration: result.estimated_duration,
    degraded: result.degraded ?? false,
    warnings: result.warnings ?? [],
    sourcesUsed: (result.sources_used || []).map((source) => ({
      title: source.title,
      url: source.url,
      sourceType: source.source_type,
      relevanceNote: source.relevance_note,
    })),
  };
}

export function chatRoutes(): Router {
  const router = Router();

  /**
   * POST /api/v1/chat/message
   * Send a message — equivalent to typing in Telegram.
   * Routes through Router → Domain Handler → returns AI response.
   *
   * For system commands (/day, /tasks, etc.), we route them through the
   * domain handler as natural language since the handler functions
   * accept the raw message text including the / prefix.
   */
  router.post('/message', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { text, attachments } = req.body;
    const normalizedText = typeof text === 'string' ? text.trim() : '';
    const normalizedAttachments = Array.isArray(attachments)
      ? attachments.map(normalizeChatAttachment).filter(Boolean) as ChatImageAttachment[]
      : [];

    if (!ensureValidChatRouteScope(res, userId, 'chat_route_message', {
      hasAttachments: normalizedAttachments.length > 0,
      textLength: normalizedText.length,
    })) {
      return;
    }

    if (!normalizedText && normalizedAttachments.length === 0) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'text or attachments are required' },
      });
      return;
    }

    // ── X-Language header handling (April 2026) ─────────────────
    // The iOS app's `LanguageRouter` auto-detects the user's
    // language from the chat input and sends the result as an
    // X-Language header ("pt-BR" / "en"). We normalize it and
    // write through to `setUserLanguage` at the REQUEST boundary
    // so every downstream caller (`handleSecretary` → fastpath →
    // prompt injection) reads the most recent language via the
    // same `getUserLanguage` call they already use.
    //
    // Writing to the DB instead of threading `lang` through every
    // function signature means:
    //   (a) The Telegram handler keeps working unchanged — it
    //       reads the same user row as the iOS route.
    //   (b) The preference survives across sessions and devices.
    //   (c) Future features (notifications, email templates,
    //       briefings) read the current language without needing
    //       to know whether the request came from iOS or Telegram.
    //
    // Wrapped in try/catch because a missing user row or a
    // transient DB lock should never block the chat flow.
    try {
      const headerValue = req.header('x-language');
      if (headerValue) {
        const lang = normalizeLangHeader(headerValue);
        // Only write if the language actually changed — spares a
        // DB write on every request from apps that send the
        // header unconditionally.
        const current = getUserLanguage(userId);
        if (current !== lang) {
          setUserLanguage(userId, lang);
          logger.debug(
            { userId, from: current, to: lang, platform: 'ios' },
            'iOS X-Language header flipped user language preference',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'iOS X-Language header handling failed — continuing with existing preference');
    }

    try {
      const requestStartedAt = Date.now();
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;
      const isNewUserFlow = listChatMessages(userId, 1).messages.length === 0;
      logger.info(
        {
          chatRequestId,
          userId,
          platform: 'ios',
          isNewUserFlow,
          hasAttachments: normalizedAttachments.length > 0,
          textLength: normalizedText.length,
        },
        'iOS chat request started',
      );
      // Check cache for known deterministic commands (saves $0.02-0.05 per hit)
      const normalizedTextLower = normalizedText.toLowerCase();
      if (normalizedText && normalizedAttachments.length === 0 && CACHEABLE_COMMANDS.has(normalizedTextLower)) {
        const cacheKey = `chat-cmd:${userId}:${normalizedTextLower}`;
        const cached = getCached(cacheKey);
        if (cached) {
          logger.debug({ cmd: normalizedText, platform: 'ios' }, 'Returning cached chat command');
          res.json(cached);
          return;
        }
      }

      if (normalizedAttachments.length > 0) {
        const quota = isUserOverDailyCap(userId);
        if (quota.over) {
          logger.warn(
            { userId, spentUsd: quota.spentUsd, capUsd: quota.capUsd, platform: 'ios' },
            'iOS chat attachment blocked by quota',
          );
          sendError(
            res as Response,
            'QUOTA_EXCEEDED',
            buildQuotaExceededMessage(quota),
            402,
            { plan: quota.plan, resetAt: quota.resetAt },
          );
          return;
        }

        const attachment = normalizedAttachments[0];
        const lang = getUserLanguage?.(userId) || 'pt-BR';
        const isPT = lang.startsWith('pt');
        const userText = normalizedText || (isPT ? 'Analisa esta imagem.' : 'Analyze this image.');
        const classified = await classifyAndExtractImage(attachment.base64, attachment.mimeType, userText, userId);
        const attachmentReply = buildAttachmentText(classified, isPT);
        const timestamp = new Date().toISOString();
        const userMessageId = `msg-user-${Date.now()}`;
        const assistantMessageId = `msg-${Date.now()}`;
        const response = {
          id: assistantMessageId,
          text: attachmentReply.text,
          domain: attachmentReply.domain,
          routeMethod: 'attachment',
          confidence: classified.type === 'invoice' ? classified.confidence ?? 0.8 : 1.0,
          buttons: null,
          metadata: attachmentReply.metadata,
          timestamp,
        };
        lastActiveDomain.set(userId, { domain: attachmentReply.domain, timestamp: Date.now() });
        persistExchange(userId, userMessageId, userText, assistantMessageId, response);
        syncConversationStateForShortcut(userId, attachmentReply.domain, userText, response.text);
        res.json(response);
        return;
      }

      // ── Token-zero fast-path ─────────────────────────────────────
      // Slash commands like /todo, /day, /overdue are pure data lookups.
      // Handle them directly without ever touching the AI pipeline.
      // This is the difference between an instant ~200ms response and a
      // 30-50 second Claude tool-use loop. See specs/08-TOKEN-ZERO-ARCHITECTURE.md.
      const fastPath = await tryDeterministicChatCommand(normalizedText, userId);
      if (fastPath) {
        const timestamp = new Date().toISOString();
        const fastResponse = {
          id: `msg-${Date.now()}`,
          text: fastPath.text,
          domain: fastPath.domain,
          routeMethod: 'fast-path' as const,
          confidence: 1.0,
          buttons: fastPath.buttons ?? null,
          metadata: null,
          timestamp,
        };
        // Track domain for conversation continuity even on fast-path.
        lastActiveDomain.set(userId, { domain: fastPath.domain, timestamp: Date.now() });
        // Cache deterministic responses for the next 60 seconds.
        if (CACHEABLE_COMMANDS.has(normalizedTextLower)) {
          setCache(`chat-cmd:${userId}:${normalizedTextLower}`, fastResponse, CHAT_CMD_TTL);
        }
        persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, fastResponse.id, fastResponse);
        syncConversationStateForShortcut(userId, fastPath.domain, normalizedText, fastResponse.text);
        logger.info({ cmd: normalizedText, platform: 'ios', mode: 'fast-path' }, 'iOS chat fast-path hit');
        res.json(fastResponse);
        return;
      }

      // ── Natural language plan-creation shortcut ───────────────────
      // Intercept "criar plano" / "create training plan" before the AI
      // pipeline. Returns a token-zero response directing the user to
      // the Training tab's one-shot plan generator ($0.01 vs $0.15).
      const planKeywords = [
        'criar plano', 'cria um plano', 'crie um plano', 'novo plano de treino',
        'gerar plano', 'create plan', 'create training plan', 'make me a plan',
        'build a plan', 'generate a plan', 'new training plan',
      ];
      const lowerText = normalizedTextLower;
      if (planKeywords.some(kw => lowerText.includes(kw))) {
        const lang = require('../../services/user-service').getUserLanguage?.(userId) || 'pt-BR';
        const isPT = lang.startsWith('pt');
        const timestamp = new Date().toISOString();
        const planResponse = {
          id: `msg-${Date.now()}`,
          text: isPT
            ? '🏋️ Para criar um plano de treino personalizado, vá à aba **Treino** e toque em **Criar plano**.\n\nO plano será gerado com base no seu perfil e agenda os treinos automaticamente no calendário.'
            : '🏋️ To create a personalized training plan, go to the **Training** tab and tap **Create Plan**.\n\nThe plan will be generated based on your profile and automatically schedule workouts in your calendar.',
          domain: 'triathlon',
          routeMethod: 'plan-shortcut',
          confidence: 1.0,
          buttons: null, metadata: null,
          timestamp,
        };
        persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, planResponse.id, planResponse);
        syncConversationStateForShortcut(userId, 'triathlon', normalizedText, planResponse.text);
        res.json(planResponse);
        return;
      }

      // ── Cost cap enforcement ─────────────────────────────────────
      // Per-user daily AI cap. Reject before invoking the AI pipeline if
      // the user is over their plan quota. Token-zero routes above remain
      // available; this only protects paid AI traffic from runaway spend.
      const cap = isUserOverDailyCap(userId);
      if (cap.over) {
        logger.warn(
          { userId, spentUsd: cap.spentUsd, capUsd: cap.capUsd, platform: 'ios' },
          'iOS chat: user over daily cost cap',
        );
        sendError(
          res as Response,
          'QUOTA_EXCEEDED',
          buildQuotaExceededMessage(cap),
          402,
          { plan: cap.plan, resetAt: cap.resetAt },
        );
        return;
      }

      // Build active conversation context
      let activeContext = null;
      const lastState = lastActiveDomain.get(userId);
      if (lastState && Date.now() - lastState.timestamp < 5 * 60 * 1000) {
        try {
          const lastMsg = getLastAssistantMessage(userId, lastState.domain);
          if (lastMsg) {
            activeContext = { domain: lastState.domain, lastAssistantMessage: lastMsg };
          }
        } catch { /* conversation state not available */ }
      }

      // Route the message (handles both commands and natural language).
      // April 9 2026: thread userId into routeMessage so the classifier
      // cost row in api_usage attributes this call to the real user
      // instead of user_id=0. Without this, every iOS chat message's
      // classification cost was orphaned under user_id=0 and the
      // per-user cap (isUserOverDailyCap) couldn't see the spend.
      const route = await routeMessage(normalizedText, activeContext, userId);
      logger.info(
        {
          chatRequestId,
          domain: route.domain,
          method: route.method,
          confidence: route.confidence,
          platform: 'ios',
        },
        'iOS message routed',
      );

      // Track domain for continuity
      lastActiveDomain.set(userId, { domain: route.domain, timestamp: Date.now() });

      // ─── Phase 1 Slice C — Tier gate for iOS chat entrypoint ───
      // Same two-layer check as the Telegram handler: explicit disable
      // first, then tier requirement. Fail-open on errors so a bus of
      // signal service issue never locks users out of their data.
      try {
        const user = getUserById(userId) || getUserByTelegramId(userId);
        if (user) {
          const tierResult = checkTierAccess({ id: user.id, tier: user.tier }, route.domain);
          if (!tierResult.allowed) {
            logger.info(
              { userId, domain: route.domain, userTier: tierResult.userTier, requiredTier: tierResult.requiredTier, reason: tierResult.reason },
              'iOS tier gate blocked message',
            );
            res.status(403).json({
              error: {
                code: 'TIER_REQUIRED',
                message: `This feature requires the ${tierResult.requiredTier} tier. Your current tier: ${tierResult.userTier}.`,
                details: {
                  domain: route.domain,
                  userTier: tierResult.userTier,
                  requiredTier: tierResult.requiredTier,
                },
              },
            });
            return;
          }
        }
      } catch (err) {
        logger.warn({ err }, 'iOS tier gate check failed — falling through (fail-open)');
      }

      // Execute domain handler
      const handlers = getDomainHandlers();
      const handler = handlers[route.domain];
      if (!handler) {
        res.status(400).json({
          error: { code: 'UNKNOWN_DOMAIN', message: `No handler for domain: ${route.domain}` },
        });
        return;
      }

      if (route.domain === 'content') {
        const contentStateShortcut = parseContentStateShortcut(normalizedText);
        if (contentStateShortcut) {
          const requestedLanguage = resolveContentShortcutLanguage(normalizedText, getUserLanguage(userId));
          const shortcut = await buildContentStateShortcutResponse(contentStateShortcut, userId, requestedLanguage);
          const timestamp = new Date().toISOString();
          const response = {
            id: `msg-${Date.now()}`,
            text: shortcut.text,
            domain: 'content',
            routeMethod: 'content-intelligence-shortcut',
            confidence: route.confidence,
            buttons: null,
            metadata: shortcut.metadata,
            timestamp,
          };

          persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, response.id, response);
          syncConversationStateForShortcut(userId, 'content', normalizedText, response.text);
          res.json(response);
          return;
        }

        const scriptShortcut = parseContentScriptShortcut(normalizedText);
        if (scriptShortcut) {
          const requestedLanguage = resolveRequestedScriptLanguage(normalizedText, getUserLanguage(userId));
          try {
            const brandVoice = getUserBrandVoice(userId);
            const scriptResult = await getScript(
              scriptShortcut.topic,
              'general',
              scriptShortcut.maxDurationMinutes,
              scriptShortcut.format,
              scriptShortcut.mode,
              brandVoice,
              requestedLanguage,
              'chat',
              userId,
            );

            const timestamp = new Date().toISOString();
            const response = {
              id: `msg-${Date.now()}`,
              text: buildScriptShortcutText(scriptResult, requestedLanguage, scriptShortcut.format),
              domain: 'content',
              routeMethod: 'content-script',
              confidence: route.confidence,
              buttons: null,
              metadata: buildScriptShortcutMetadata(scriptResult, scriptShortcut.format),
              timestamp,
            };

            persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, response.id, response);
            syncConversationStateForShortcut(userId, 'content', normalizedText, response.text);
            res.json(response);
            return;
          } catch (err) {
            logger.warn({ err, userId, text: normalizedText }, 'content-script shortcut failed — falling back to generic content handler');
            const timestamp = new Date().toISOString();
            const response = {
              id: `msg-${Date.now()}`,
              text: buildScriptUnavailableResponse(requestedLanguage),
              domain: 'content',
              routeMethod: 'content-script-unavailable',
              confidence: route.confidence,
              buttons: null,
              metadata: {
                type: 'content_script_unavailable',
                format: scriptShortcut.format,
                degraded: true,
                warnings: [err instanceof Error ? err.message : 'content engine unavailable'],
              },
              timestamp,
            };
            persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, response.id, response);
            syncConversationStateForShortcut(userId, 'content', normalizedText, response.text);
            res.json(response);
            return;
          }
        }

        if (route.method === 'context' && isContentRefinementFollowUp(normalizedText) && activeContext?.lastAssistantMessage) {
          const requestedLanguage = resolveRequestedScriptLanguage(normalizedText, getUserLanguage(userId));
          const sourceText = extractContentRefinementSourceText(activeContext.lastAssistantMessage);
          try {
            const { text: refinedText } = await completeOneShotWithFallback(
              buildContentRefinementSystemPrompt(requestedLanguage),
              buildContentRefinementUserPrompt(sourceText, normalizedText, requestedLanguage),
              'content_chat_refine',
              async () => {
                throw new Error('Anthropic fallback disabled');
              },
              {
                maxTokens: 1200,
                temperature: 0.5,
                userId,
              },
            );

            const responseText = refinedText.trim();
            const timestamp = new Date().toISOString();
            const response = {
              id: `msg-${Date.now()}`,
              text: responseText,
              domain: 'content',
              routeMethod: 'content-refine',
              confidence: route.confidence,
              buttons: null,
              metadata: {
                type: 'content_refine',
                sourceLength: sourceText.length,
                degraded: false,
              },
              timestamp,
            };

            persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, response.id, response);
            syncConversationStateForShortcut(userId, 'content', normalizedText, response.text);
            res.json(response);
            return;
          } catch (err) {
            logger.warn({ err, userId, text: normalizedText }, 'content refine shortcut failed — returning degraded message');
            const heuristicFallback = buildHeuristicContentRefinementFallback(sourceText, normalizedText, requestedLanguage);
            if (heuristicFallback) {
              const timestamp = new Date().toISOString();
              const response = {
                id: `msg-${Date.now()}`,
                text: heuristicFallback,
                domain: 'content',
                routeMethod: 'content-refine-fallback',
                confidence: route.confidence,
                buttons: null,
                metadata: {
                  type: 'content_refine_fallback',
                  degraded: true,
                  warnings: [err instanceof Error ? err.message : 'content refine unavailable'],
                },
                timestamp,
              };

              persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, response.id, response);
              syncConversationStateForShortcut(userId, 'content', normalizedText, response.text);
              res.json(response);
              return;
            }

            const timestamp = new Date().toISOString();
            const response = {
              id: `msg-${Date.now()}`,
              text: buildContentRefinementUnavailableResponse(requestedLanguage),
              domain: 'content',
              routeMethod: 'content-refine-unavailable',
              confidence: route.confidence,
              buttons: null,
              metadata: {
                type: 'content_refine_unavailable',
                degraded: true,
                warnings: [err instanceof Error ? err.message : 'content refine unavailable'],
              },
              timestamp,
            };

            persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, response.id, response);
            syncConversationStateForShortcut(userId, 'content', normalizedText, response.text);
            res.json(response);
            return;
          }
        }
      }

      if (route.domain === 'finance') {
        const financeStateShortcut = parseFinanceStateShortcut(normalizedText);
        if (financeStateShortcut) {
          const requestedLanguage = resolveFinanceShortcutLanguage(getUserLanguage(userId));
          const shortcut = buildFinanceStateShortcutResponse(financeStateShortcut, userId, requestedLanguage);
          const timestamp = new Date().toISOString();
          const response = {
            id: `msg-${Date.now()}`,
            text: shortcut.text,
            domain: 'finance',
            routeMethod: 'finance-state-shortcut',
            confidence: route.confidence,
            buttons: null,
            metadata: shortcut.metadata,
            timestamp,
          };

          persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, response.id, response);
          syncConversationStateForShortcut(userId, 'finance', normalizedText, response.text);
          res.json(response);
          return;
        }
      }

      // Execute with a 40-second timeout (iOS client times out at 45s)
      // Secretary tool-use commands (/todo, /day) can take 15-30s with Claude Sonnet
      const handlerPromise = handler(route.strippedMessage, userId);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Response timeout — AI is taking too long')), 40000),
      );
      const result = await Promise.race([handlerPromise, timeoutPromise]);

      // Extract buttons from the response text if present.
      // Secretary fast-path messages expose deterministic command buttons.
      // Triathlon coach replies can expose real "apply recommendation"
      // actions when the current request produced fresh coach state.
      const lang = getUserLanguage(userId);
      const buttons = defaultButtonsForDomain(result.domain || route.domain, lang, userId, requestStartedAt);

      const timestamp = new Date().toISOString();
      const response = {
        id: `msg-${Date.now()}`,
        text: result.text,
        domain: result.domain || route.domain,
        routeMethod: route.method,
        confidence: route.confidence,
        buttons,
        metadata: null,
        timestamp,
      };

      if (isNewUserFlow) {
        logger.debug(
          {
            chatRequestId,
            userId,
            domain: response.domain,
            routeMethod: response.routeMethod,
            hasButtons: Array.isArray(response.buttons) && response.buttons.length > 0,
            metadataType: (response.metadata as { type?: string } | null)?.type || null,
            textPreview: response.text.slice(0, 160),
          },
          'iOS new-user chat response envelope',
        );
      }

      // Cache the response if it was a deterministic command
      if (CACHEABLE_COMMANDS.has(normalizedTextLower)) {
        setCache(`chat-cmd:${userId}:${normalizedTextLower}`, response, CHAT_CMD_TTL);
      }

      persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, response.id, response);
      logger.info(
        {
          chatRequestId,
          userId,
          domain: response.domain,
          durationMs: Date.now() - requestStartedAt,
        },
        'iOS chat request completed',
      );
      res.json(response);
    } catch (err: any) {
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;
      if (isRetryableAIProviderError(err)) {
        const degradedDomain = keywordMatch(typeof text === 'string' ? text : '') || lastActiveDomain.get(userId)?.domain || 'secretary';
        const degraded = await buildAITemporarilyBusyResponse(degradedDomain, userId);
        const timestamp = new Date().toISOString();
        const assistantMessageId = `msg-${Date.now()}`;
        logger.warn(
          { err, platform: 'ios', chatRequestId, userId, degradedDomain },
          'iOS chat/message degraded after retryable AI provider failure',
        );
        const response = {
          id: assistantMessageId,
          text: degraded.text,
          domain: degraded.domain,
          routeMethod: 'degraded',
          confidence: 0.1,
          buttons: null,
          metadata: { degraded: true, retryable: true },
          timestamp,
        };
        persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, assistantMessageId, response);
        syncConversationStateForShortcut(userId, degraded.domain, normalizedText, degraded.text);
        res.json(response);
        return;
      }
      pushEvent({
        ts: new Date().toISOString(),
        type: 'error',
        summary: `chat failed (${chatRequestId})`,
        detail: err?.message || 'unknown chat failure',
        domain: 'secretary',
      });
      logger.error({ err, text, platform: 'ios', chatRequestId, userId }, 'iOS chat/message failed');
      res.status(500).json({
        error: { code: 'INTERNAL', message: err.message || 'Failed to process message' },
      });
    }
  });

  /**
   * POST /api/v1/chat/callback
   * Handle inline button presses (equivalent to Telegram callback queries).
   */
  router.post('/callback', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const { callbackData, messageId } = req.body;

    if (!ensureValidChatRouteScope(res, userId, 'chat_route_callback', {
      callbackPrefix: typeof callbackData === 'string' ? callbackData.split(':').slice(0, 2).join(':') : null,
      hasMessageId: Boolean(messageId),
    })) {
      return;
    }

    if (!callbackData) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'callbackData is required' },
      });
      return;
    }

    try {
      const labels = labelsForLanguage(getUserLanguage(userId));

      if (callbackData.startsWith('cmd:')) {
        const command = callbackData.slice(4);
        const fastPath = await tryDeterministicChatCommand(command, userId);
        if (!fastPath) {
          res.status(400).json({
            error: { code: 'UNSUPPORTED_CALLBACK', message: `Command callback "${command}" is not available.` },
          });
          return;
        }

        const timestamp = new Date().toISOString();
        const payload = {
          text: fastPath.text,
          editOriginal: true,
          newButtons: fastPath.buttons ?? null,
        };

        if (messageId) {
          updateAssistantMessage(userId, messageId, {
            text: fastPath.text,
            domain: fastPath.domain,
            buttons: fastPath.buttons ?? null,
            metadata: null,
            routeMethod: 'fast-path',
            timestamp,
          });
          syncConversationAssistantEdit(userId, fastPath.domain, fastPath.text);
        }

        res.json(payload);
        return;
      }

      if (callbackData.startsWith('coach:')) {
        const lang = getUserLanguage(userId);
        const isPT = lang.toLowerCase().startsWith('pt');
        const [, action, ref] = callbackData.split(':');

        if (action === 'dismiss') {
          const payload = {
            text: isPT ? '👍 Mantive o plano atual.' : '👍 Kept the current plan.',
            editOriginal: true,
            newButtons: null,
          };

          if (messageId) {
            updateAssistantMessage(userId, messageId, {
              text: payload.text,
              domain: 'triathlon',
              buttons: null,
              metadata: null,
              timestamp: new Date().toISOString(),
            });
            syncConversationAssistantEdit(userId, 'triathlon', payload.text);
          }

          res.json(payload);
          return;
        }

        const cbData = ref ? getCallback(ref) : null;
        const recommendationIds = Array.isArray(cbData?.recommendationIds)
          ? cbData.recommendationIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
          : [];

        if (recommendationIds.length === 0) {
          res.status(410).json({
            error: {
              code: 'CALLBACK_EXPIRED',
              message: isPT
                ? 'Esta ação expirou. Gere um novo coach briefing.'
                : 'This action expired. Generate a new coach briefing.',
            },
          });
          return;
        }

        const applied = await applyCoachRecommendations(userId, recommendationIds);
        const summaryLines = applied.appliedRecommendations.slice(0, 4).map((rec) => `• ${rec.summary}`);
        const suffix = applied.appliedRecommendations.length > summaryLines.length
          ? isPT
            ? `\n• … + ${applied.appliedRecommendations.length - summaryLines.length} alterações`
            : `\n• … + ${applied.appliedRecommendations.length - summaryLines.length} more changes`
          : '';
        const responseText = isPT
          ? `✅ ${applied.count} recomendação(ões) aplicada(s) ao calendário.\n\n${summaryLines.join('\n')}${suffix}`
          : `✅ Applied ${applied.count} recommendation(s) to your calendar.\n\n${summaryLines.join('\n')}${suffix}`;
        const payload = {
          text: responseText,
          editOriginal: true,
          newButtons: null,
        };

        if (messageId) {
          updateAssistantMessage(userId, messageId, {
            text: responseText,
            domain: 'triathlon',
            buttons: null,
            metadata: null,
            timestamp: new Date().toISOString(),
          });
          syncConversationAssistantEdit(userId, 'triathlon', responseText);
        }

        res.json(payload);
        return;
      }

      // Resolve the callback data from the store
      const cbData = getCallback(callbackData);

      // The callback-query handler in the existing system processes these
      // For iOS, we need to handle the most common callback patterns:
      // td:tc:ref — todo complete
      // td:ls:ref — list select
      // td:dy:ref / td:dn:ref — delete yes/no
      const prefix = callbackData.split(':').slice(0, 2).join(':');
      if (!cbData && prefix !== 'td:dn') {
        res.status(410).json({
          error: { code: 'CALLBACK_EXPIRED', message: 'This action expired. Please run the command again.' },
        });
        return;
      }

      let responseText = 'Action processed';
      let editOriginal = false;
      let newButtons: { text: string; callbackData: string }[][] | null = null;

      switch (prefix) {
        case 'td:ls': {
          if (cbData?.listId && cbData?.listName) {
            const todo = require('../../services/microsoft-todo');
            const result = await todo.getTasks(cbData.listId, cbData.listName, { status: 'notStarted' });
            if (!result.success) {
              responseText = `⚠️ Failed to fetch tasks: ${result.error || 'unknown error'}`;
              editOriginal = true;
              break;
            }
            responseText = formatMsTodoTasks(result.data, cbData.listName);
            newButtons = buildTaskActionButtons(result.data, labels);
            editOriginal = true;
          }
          break;
        }
        case 'td:tc': {
          // Complete a task
          if (cbData?.listId && cbData?.taskId) {
            const todo = require('../../services/microsoft-todo');
            await todo.completeTask(cbData.listId, cbData.taskId);
            responseText = `✅ Completed: ${cbData.title || 'task'}`;
            editOriginal = true;
          }
          break;
        }
        case 'td:dy': {
          // Delete confirmed
          if (cbData?.listId && cbData?.taskId) {
            const todo = require('../../services/microsoft-todo');
            await todo.deleteTask(cbData.listId, cbData.taskId);
            responseText = `🗑️ Deleted: ${cbData.title || 'task'}`;
            editOriginal = true;
          } else if (cbData?.listId && cbData?.type === 'list') {
            const todo = require('../../services/microsoft-todo');
            await todo.deleteList(cbData.listId);
            responseText = `🗑️ Deleted list: ${cbData.listName || 'list'}`;
            editOriginal = true;
          }
          break;
        }
        case 'td:tx': {
          if (cbData?.listId && (cbData?.taskId || cbData?.type === 'list')) {
            const confirmRef = callbackData.split(':')[2];
            responseText = cbData.type === 'list'
              ? `🗑 Delete "<b>${escapeHtml(cbData.listName || 'list')}</b>"?`
              : `🗑 Delete "<b>${escapeHtml(cbData.title || 'task')}</b>"?`;
            newButtons = buildDeleteConfirmationButtons(confirmRef, labels);
            editOriginal = true;
          }
          break;
        }
        case 'td:dn': {
          responseText = 'Cancelled.';
          editOriginal = true;
          break;
        }
        default: {
          res.status(400).json({
            error: { code: 'UNSUPPORTED_CALLBACK', message: `Callback "${prefix}" is not supported in iOS chat yet.` },
          });
          return;
        }
      }

      const timestamp = new Date().toISOString();
      const payload = {
        text: responseText,
        editOriginal,
        newButtons,
      };

      if (editOriginal && messageId) {
        const updated = updateAssistantMessage(userId, messageId, {
          text: responseText,
          domain: 'secretary',
          buttons: newButtons,
          metadata: null,
          timestamp,
        });
        if (!updated) {
          storeChatMessage({
            userId,
            messageId: `cb-${Date.now()}`,
            role: 'assistant',
            text: responseText,
            domain: 'secretary',
            timestamp,
          });
        }
        syncConversationAssistantEdit(userId, 'secretary', responseText);
      } else {
        storeChatMessage({
          userId,
          messageId: `cb-${Date.now()}`,
          role: 'assistant',
          text: responseText,
          domain: 'secretary',
          timestamp,
        });
        syncConversationAssistantEdit(userId, 'secretary', responseText);
      }

      res.json(payload);
    } catch (err: any) {
      logger.error({ err, callbackData, platform: 'ios' }, 'iOS callback failed');
      res.status(500).json({
        error: { code: 'INTERNAL', message: err.message || 'Failed to process callback' },
      });
    }
  });

  /**
   * GET /api/v1/chat/history?limit=50&before=<cursor>
   * Fetch conversation history.
   */
  router.get('/history', async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100);
    const before = req.query.before as string | undefined;

    if (!ensureValidChatRouteScope(res, userId, 'chat_route_history', {
      limit,
      hasBefore: Boolean(before),
    })) {
      return;
    }

    try {
      res.json(listChatMessages(userId, limit, before));
    } catch (err: any) {
      logger.debug({ err }, 'iOS chat history query failed');
      res.json({ messages: [], cursor: null, hasMore: false });
    }
  });

  return router;
}
