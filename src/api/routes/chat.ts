// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { routeMessage, isSystemCommand } from '../../router';
import { logger } from '../../utils/logger';
import { pushEvent } from '../../portal/telemetry';
import { getCached, setCache } from '../../services/cache-store';
import { tryDeterministicChatCommand } from './chat-fastpath';
import { listChatMessages, storeChatMessage, updateAssistantMessage } from '../../services/chat-history-store';
import { classifyAndExtractImage, type ImageClassificationResult } from '../../services/anthropic';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguage, setUserLanguage, getUserById, getUserByTelegramId } from '../../services/user-service';
import { buildQuotaExceededMessage, isUserOverDailyCap } from '../../services/cost-guardrail';
import { addToConversation, getLastAssistantMessage } from '../../state/conversation';
import { checkTierAccess } from '../../services/skill-tiers';
import { getCallback } from '../../utils/callback-store';
import { handleSecretary } from '../../domains/secretary';
import { handleTriathlon } from '../../domains/triathlon';
import { handleContent } from '../../domains/content-creator';
import { handleFinance } from '../../domains/finance';
import { handleCooking } from '../../domains/cooking';
import { formatMsTodoTasks, escapeHtml } from '../../utils/telegram-formatter';
import { getScript, type ScriptResponse } from '../../services/content-engine';
import { completeOneShotWithFallback } from '../../services/gemini-provider';
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

const CONTENT_REFINEMENT_PATTERNS = [
  /\b(make it|make this|rewrite|shorten|translate|adapt|rework|polish|trim)\b/i,
  /\b(make it shorter|make this shorter|make it punchier|make this punchier)\b/i,
  /\b(vers[aã]o mais curta|mais curto|mais curta|reescreve|reescrever|traduz|traduz isto|adapta|encurta|melhora isto)\b/i,
];

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
  const hasGenerationVerb = /\b(write|create|make|draft|generate|escreve|escreva|cria|crie|gera|gere|faz|faça)\b/i.test(normalized);
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

function getUserBrandVoice(userId: number): string | null {
  try {
    const db = require('../../services/database').getDb();
    const row = db.prepare(
      `SELECT synthesized_text FROM content_knowledge
       WHERE category = 'brand_voice' AND user_id IN (0, ?)
       ORDER BY user_id DESC LIMIT 1`,
    ).get(userId) as { synthesized_text?: string } | undefined;
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
            buttons: fastPath.buttons ?? null,
            metadata: null,
            routeMethod: 'fast-path',
            timestamp,
          });
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
              buttons: null,
              metadata: null,
              timestamp: new Date().toISOString(),
            });
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
            buttons: null,
            metadata: null,
            timestamp: new Date().toISOString(),
          });
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
            timestamp,
          });
        }
      } else {
        storeChatMessage({
          userId,
          messageId: `cb-${Date.now()}`,
          role: 'assistant',
          text: responseText,
          timestamp,
        });
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

    try {
      res.json(listChatMessages(userId, limit, before));
    } catch (err: any) {
      logger.debug({ err }, 'iOS chat history query failed');
      res.json({ messages: [], cursor: null, hasMore: false });
    }
  });

  return router;
}
