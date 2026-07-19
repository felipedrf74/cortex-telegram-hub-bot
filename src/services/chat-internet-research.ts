// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithSearch } from './gemini-provider';
import type {
  NexusChatExpectedResponseShape,
  NexusChatGroundingRequirement,
  NexusChatLanguage,
  NexusChatOwnerSkill,
} from './chat-answer-contract';
import { buildChatResearchContext } from './chat-context-compiler';
import { createLazyAnthropicClient } from './anthropic-lazy-client';
import { canUseAnthropicRuntimeFallback } from './runtime-flags';
import { logger } from '../utils/logger';
import { completeOneShotWithWebSearch, isOpenAIConfigured } from './openai-provider';
import { isResearchProviderRefusal } from './chat-research-refusal-policy';
import { assessChatResearchAnswerCompleteness } from './chat-research-answer-quality';
import { ApiUsagePersistenceError } from './api-usage-fallback';
import { isPaidAiCostControlsEnforcementEnabled } from './entitlement';

const anthropicWebSearchClient = createLazyAnthropicClient({ maxRetries: 2 });

export interface ChatInternetResearchInput {
  message: string;
  language: NexusChatLanguage;
  skill: NexusChatOwnerSkill;
  expectedResponseShape: NexusChatExpectedResponseShape;
  userId: number;
  tenantId: number;
  groundingRequired?: NexusChatGroundingRequirement;
  localContext?: string | null;
}

export interface ChatInternetResearchResult {
  text: string;
  sources: string[];
  degraded: boolean;
  degradedReason?: string;
  context?: {
    tokenEstimate: number;
    cacheablePrefixHash: string;
    localContextIncluded?: boolean;
    safeQueryPolicy?: 'public_query_only';
  };
}

export type ChatInternetResearchSafeQueryPacket =
  | {
    ok: true;
    publicQuery: string;
    policy: 'public_query_only';
  }
  | {
    ok: false;
    denialReason: 'private_context_disallowed_for_web_search' | 'empty_public_query';
  };

export async function buildChatInternetResearchAnswer(
  input: ChatInternetResearchInput,
): Promise<ChatInternetResearchResult> {
  const localized = researchLocalization(input.language);
  const safeQuery = buildChatInternetResearchSafeQueryPacket(input);
  if (!safeQuery.ok) {
    return {
      text: localized.privateContextBlocked,
      sources: [],
      degraded: true,
      degradedReason: safeQuery.denialReason,
    };
  }
  const compiledContext = buildChatResearchContext({
    ...input,
    message: safeQuery.publicQuery,
    groundingRequired: 'web',
    localContext: null,
  });

  try {
    const result = await completeOneShotWithSearchWithRetry(
      compiledContext.systemPrompt,
      compiledContext.userPrompt,
      'chat_internet_research',
      {
        userId: input.userId,
        tenantId: input.tenantId,
        maxTokens: maxTokensForShape(input.expectedResponseShape),
        temperature: 0.35,
      },
      input.language,
    );
    return {
      text: appendSourceNote(result.text, result.sources, localized.sourceLabel),
      sources: dedupeSources(result.sources).slice(0, 6),
      degraded: false,
      context: {
        tokenEstimate: compiledContext.tokenEstimate,
        cacheablePrefixHash: compiledContext.cacheablePrefixHash,
        localContextIncluded: false,
        safeQueryPolicy: safeQuery.policy,
      },
    };
  } catch (err) {
    rethrowUsagePersistenceFailure(err);
    logger.warn(
      { err, userId: input.userId, tenantId: input.tenantId, skill: input.skill },
      'Chat internet research unavailable',
    );
    return {
      text: localized.webUnavailable,
      sources: [],
      degraded: true,
      degradedReason: 'web_research_unavailable',
    };
  }
}

async function completeOneShotWithSearchWithRetry(
  systemPrompt: string,
  userPrompt: string,
  category: string,
  options: { maxTokens: number; temperature: number; userId: number; tenantId: number },
  language: NexusChatLanguage,
): Promise<{ text: string; sources: string[] }> {
  const maxAttempts = researchProviderMaxAttempts();
  let lastError: unknown;
  let openAiAttempted = false;
  if (isPaidAiCostControlsEnforcementEnabled() && isOpenAIConfigured()) {
    openAiAttempted = true;
    try {
      return ensureUsableResearchResult(
        await completeOneShotWithWebSearch(systemPrompt, userPrompt, `${category}_openai_web_search`, options),
        language,
      );
    } catch (err) {
      // A denial or metering failure on the cheapest grounded provider is
      // terminal. Availability/quality failures may still compare Gemini.
      rethrowUsagePersistenceFailure(err);
      lastError = err;
      logger.warn(
        { err, userId: options.userId, tenantId: options.tenantId },
        'Enforced bounded OpenAI web search failed; trying Gemini grounding',
      );
    }
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return ensureUsableResearchResult(
        await completeOneShotWithSearch(systemPrompt, userPrompt, category, options),
        language,
      );
    } catch (err) {
      if (isProviderHeadroomDenial(err)) {
        // This is a pre-network denial for Gemini's concrete maximum, not a
        // failed paid call. Stop retrying the unaffordable provider and try the
        // cheaper bounded search route below under the same reservation.
        lastError = err;
        break;
      }
      rethrowUsagePersistenceFailure(err);
      lastError = err;
      if (attempt >= maxAttempts) break;
      logger.warn(
        { err, attempt, maxAttempts, userId: options.userId, tenantId: options.tenantId },
        'Chat internet research attempt failed; retrying',
      );
      await sleep(researchProviderRetryDelayMs(attempt));
    }
  }
  if (isProviderHeadroomDenial(lastError) && !openAiAttempted && isOpenAIConfigured()) {
    try {
      logger.info(
        { userId: options.userId, tenantId: options.tenantId },
        'Gemini grounded maximum does not fit current headroom; trying bounded OpenAI web search',
      );
      return ensureUsableResearchResult(
        await completeOneShotWithWebSearch(systemPrompt, userPrompt, `${category}_openai_web_search`, options),
        language,
      );
    } catch (fallbackErr) {
      rethrowUsagePersistenceFailure(fallbackErr);
      logger.warn(
        { err: fallbackErr, userId: options.userId, tenantId: options.tenantId },
        'Cost-aware OpenAI web-search fallback failed',
      );
    }
  }
  if (isProviderHeadroomDenial(lastError) && openAiAttempted) throw lastError;
  if (canUseAnthropicRuntimeFallback()) {
    try {
      logger.warn(
        { err: lastError, userId: options.userId, tenantId: options.tenantId },
        'Chat internet research primary search provider exhausted; trying Anthropic web search fallback',
      );
      return ensureUsableResearchResult(
        await completeOneShotWithAnthropicWebSearch(systemPrompt, userPrompt, category, options),
        language,
      );
    } catch (fallbackErr) {
      rethrowUsagePersistenceFailure(fallbackErr);
      logger.warn(
        { err: fallbackErr, userId: options.userId, tenantId: options.tenantId },
        'Chat internet research Anthropic web search fallback failed',
      );
    }
  }
  if (canUseOpenAIWebSearchFallback()) {
    try {
      logger.warn(
        { err: lastError, userId: options.userId, tenantId: options.tenantId },
        'Chat internet research primary search provider exhausted; trying OpenAI web search fallback',
      );
      return ensureUsableResearchResult(
        await completeOneShotWithWebSearch(systemPrompt, userPrompt, `${category}_openai_web_search`, options),
        language,
      );
    } catch (fallbackErr) {
      rethrowUsagePersistenceFailure(fallbackErr);
      logger.warn(
        { err: fallbackErr, userId: options.userId, tenantId: options.tenantId },
        'Chat internet research OpenAI web search fallback failed',
      );
    }
  }
  throw lastError;
}

function isProviderHeadroomDenial(error: unknown): boolean {
  const candidate = error as { name?: string; decision?: { code?: string } } | null;
  return candidate?.name === 'AiBudgetError'
    && (candidate.decision?.code === 'AI_DAILY_LIMIT_REACHED'
      || candidate.decision?.code === 'AI_MONTHLY_LIMIT_REACHED');
}

function rethrowUsagePersistenceFailure(error: unknown): void {
  if (error instanceof ApiUsagePersistenceError || (error as { name?: string; code?: string })?.name === 'ApiUsagePersistenceError'
    || (error as { name?: string })?.name === 'AiBudgetError'
    || (error as { code?: string })?.code === 'AI_USAGE_PERSISTENCE_FAILED') {
    throw error;
  }
}

function ensureUsableResearchResult(
  result: { text: string; sources: string[] },
  language: NexusChatLanguage,
): { text: string; sources: string[] } {
  const text = normalizeResearchAnswerText(result.text, language);
  if (isResearchProviderRefusal(text)) {
    throw new Error('research_provider_refusal');
  }
  const completeness = assessChatResearchAnswerCompleteness(text);
  if (!completeness.ok) {
    throw new Error(`research_provider_incomplete_answer:${completeness.reason}`);
  }
  return {
    ...result,
    text,
  };
}

function canUseOpenAIWebSearchFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK ?? '').trim().toLowerCase();
  return (raw === 'true' || raw === '1' || raw === 'on') && isOpenAIConfigured();
}

async function completeOneShotWithAnthropicWebSearch(
  systemPrompt: string,
  userPrompt: string,
  category: string,
  options: { maxTokens: number; temperature: number; userId: number; tenantId: number },
): Promise<{ text: string; sources: string[] }> {
  const response = await trackedCreate(anthropicWebSearchClient.get(), {
    model: config.anthropic.classifierModel,
    max_tokens: Math.max(256, Math.min(options.maxTokens, 1_200)),
    temperature: options.temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [{ type: 'web_search_20250305' as any, name: 'web_search', max_uses: 5 } as any],
  } as any, `${category}_anthropic_web_search`, {
    userId: options.userId,
    tenantId: options.tenantId,
  });
  return extractAnthropicWebSearchResult(response);
}

function extractAnthropicWebSearchResult(response: Anthropic.Message): { text: string; sources: string[] } {
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const sources = collectHttpUrlsFromUnknown(response.content);
  if (!text) {
    throw new Error('anthropic_web_search_empty_response');
  }
  return { text, sources };
}

function collectHttpUrlsFromUnknown(value: unknown, urls = new Set<string>()): string[] {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/https?:\/\/[^\s)"'<>]+/gi)) {
      urls.add(match[0].replace(/[),.;\]]+$/g, ''));
    }
    return [...urls];
  }
  if (!value || typeof value !== 'object') return [...urls];
  if (Array.isArray(value)) {
    for (const entry of value) collectHttpUrlsFromUnknown(entry, urls);
    return [...urls];
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectHttpUrlsFromUnknown(entry, urls);
  }
  return [...urls];
}

function researchProviderMaxAttempts(): number {
  const parsed = Number.parseInt(process.env.CHAT_INTERNET_RESEARCH_MAX_ATTEMPTS ?? '2', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 3);
}

function researchProviderRetryDelayMs(attempt = 1): number {
  const parsed = Number.parseInt(process.env.CHAT_INTERNET_RESEARCH_RETRY_DELAY_MS ?? '150', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const multiplierRaw = Number.parseFloat(process.env.CHAT_INTERNET_RESEARCH_RETRY_BACKOFF_MULTIPLIER ?? '2');
  const multiplier = Number.isFinite(multiplierRaw) && multiplierRaw >= 1 ? Math.min(multiplierRaw, 4) : 1;
  const safeAttempt = Math.max(1, Math.min(attempt, 5));
  const backoff = parsed * Math.pow(multiplier, safeAttempt - 1);
  return Math.min(Math.round(backoff), 10_000);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildChatInternetResearchSafeQueryPacket(
  input: Pick<ChatInternetResearchInput, 'message' | 'skill' | 'groundingRequired' | 'localContext' | 'expectedResponseShape'>,
): ChatInternetResearchSafeQueryPacket {
  if (input.localContext?.trim() || input.groundingRequired === 'local_and_web') {
    if (!canUseGenericPublicQuery(input.message, input.skill)) {
      return { ok: false, denialReason: 'private_context_disallowed_for_web_search' };
    }
  }
  const publicQuery = toGenericPublicQuery(input.message, input.skill, input.expectedResponseShape);
  if (!publicQuery) return { ok: false, denialReason: 'empty_public_query' };
  return {
    ok: true,
    publicQuery,
    policy: 'public_query_only',
  };
}

function appendSourceNote(text: string, sources: string[], sourceLabel: string): string {
  const trimmed = stripProviderSourceFooter(text).trim();
  const uniqueSources = dedupeSources(sources).slice(0, 3);
  if (uniqueSources.length === 0) return trimmed;
  return `${trimmed}\n\n${sourceLabel}: ${uniqueSources.join(', ')}`;
}

export function normalizeResearchAnswerText(text: string, language: NexusChatLanguage): string {
  return stripProviderSourceFooter(text)
    .replace(/\s{3,}/g, ' ')
    .trim();
}

export { isResearchProviderRefusal } from './chat-research-refusal-policy';

function stripProviderSourceFooter(text: string): string {
  return text
    .replace(
      /\n{1,3}\s*(?:Sources consulted|Fuentes consultadas|Fontes consultadas|Sources|Fuentes|Fontes)\s*:\s*(?:https?:\/\/\S+(?:\s*,\s*)?)+\s*$/iu,
      '',
    )
    .trim();
}

function researchLocalization(language: NexusChatLanguage): {
  sourceLabel: string;
  privateContextBlocked: string;
  webUnavailable: string;
} {
  if (language === 'es') {
    return {
      sourceLabel: 'Fuentes consultadas',
      privateContextBlocked: 'No puedo enviar contexto privado de Nexus a la búsqueda web. Puedo responder con datos locales verificados o reformular la búsqueda sin esos detalles.',
      webUnavailable: 'Necesito consultar fuentes web actuales para responder con confianza, pero la búsqueda web no está disponible ahora. Inténtalo de nuevo en unos instantes o pide una respuesta general sin datos actuales.',
    };
  }
  if (language === 'pt') {
    return {
      sourceLabel: 'Fontes consultadas',
      privateContextBlocked: 'Não posso enviar contexto privado do Nexus para pesquisa web. Posso responder com dados locais verificados ou reformular a pesquisa sem esses detalhes.',
      webUnavailable: 'Eu precisaria consultar fontes atuais para responder isso com confiança, mas a pesquisa web não está disponível agora. Tente novamente em instantes ou peça uma resposta geral sem dados atuais.',
    };
  }
  if (language === 'mixed') {
    return {
      sourceLabel: 'Sources consulted',
      privateContextBlocked: 'I cannot send private Nexus context to web search. I can answer from verified local data or reformulate the research without those details.',
      webUnavailable: 'I need current web sources to answer that confidently, but web research is unavailable right now. Try again shortly, or ask for a general answer without current data.',
    };
  }
  return {
    sourceLabel: 'Sources consulted',
    privateContextBlocked: 'I cannot send private Nexus context to web search. I can answer from verified local data or reformulate the research without those details.',
    webUnavailable: 'I need current web sources to answer that confidently, but web research is unavailable right now. Try again shortly, or ask for a general answer without current data.',
  };
}

function dedupeSources(sources: string[]): string[] {
  return [...new Set(sources.filter((source) => /^https?:\/\//i.test(source)))];
}

function maxTokensForShape(shape: NexusChatExpectedResponseShape): number {
  if (shape === 'recipe') return 3_000;
  if (shape === 'finance_summary' || shape === 'training_advice') return 3_000;
  return 2_400;
}

const EMAIL_RE = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MAX_PUBLIC_QUERY_PARSE_CHARS = 20_000;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;
const PRIVATE_CONTEXT_RE = /\b(my|meu|minha|minhas|meus|mi|mis|mine|our|nosso|nossa)\b.{0,80}\b(calendar|agenda|task|tasks|tarefa|tarefas|email|e-mail|mail|inbox|conta|account|saldo|balance|invoice|fatura|client|cliente|meeting|reuni[aã]o|evento|event|treino|training plan|plano de treino)\b/i;
const HEALTH_TRAINING_RE = /\b(knee|joelho|pain|dor|injury|les[aã]o|train|treinar|workout|treino|exercise|exerc[ií]cio)\b/i;
const PRIVATE_CONTEXT_CLAUSE_RE = /\b(?:my|meu|minha|minhas|meus|mi|mis|mine|our|nosso|nossa)\b[^.?!;\n]{0,120}\b(?:calendar|agenda|tasks?|tarefas?|email|e-mail|mail|inbox|conta|account|saldo|balance|invoice|fatura|client|cliente|meeting|reuni[aã]o|evento|event|workout|training plan|plano de treino|treino|plan|plano)\b[^.?!;\n]{0,120}/giu;
const PRIVATE_TRAINING_RESIDUE_RE = /\b(?:on|from|in|during|no|na|en)\s+[\p{L}\p{N}\s-]{0,80}\b(?:plan|plano|workout|treino)\b/giu;
const PERSONAL_HEALTH_PHRASE_RE = /\b(?:i\s+(?:have|am having|feel)|i'm\s+having|eu\s+(?:tenho|sinto|estou com)|tenho|sinto|estou com|yo\s+(?:tengo|siento|estoy con)|tengo|siento|estoy con)\b/giu;
const PERSONAL_PRONOUN_RE = /\b(?:i|me|my|mine|eu|meu|minha|minhas|meus|yo|mi|mis)\b/giu;
const QUESTION_WORD_RE = /\b(?:should|can|could|devo|posso|puedo|deber[ií]a)\b/giu;

function canUseGenericPublicQuery(message: string, skill: NexusChatOwnerSkill): boolean {
  if (message.length > MAX_PUBLIC_QUERY_PARSE_CHARS) return false;
  if (EMAIL_RE.test(message) || PHONE_RE.test(message)) return false;
  if (skill === 'training' && HEALTH_TRAINING_RE.test(message)) {
    return Boolean(buildPublicHealthTrainingQuery(message));
  }
  if (skill === 'cooking') return true;
  return !PRIVATE_CONTEXT_RE.test(message);
}

function toGenericPublicQuery(
  message: string,
  skill: NexusChatOwnerSkill,
  shape: NexusChatExpectedResponseShape,
): string {
  if (message.length > MAX_PUBLIC_QUERY_PARSE_CHARS) return '';
  const normalized = message
    .replace(EMAIL_RE, ' ')
    .replace(PHONE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (skill === 'training' && HEALTH_TRAINING_RE.test(normalized)) {
    return buildPublicHealthTrainingQuery(normalized);
  }
  if (skill === 'finance' && /\b(my|meu|minha|mi|account|conta|balance|saldo)\b/i.test(normalized)) {
    return '';
  }
  if (shape === 'recipe') {
    return normalized.slice(0, 220);
  }
  if (PRIVATE_CONTEXT_RE.test(normalized)) return '';
  return normalized.slice(0, 220);
}

function buildPublicHealthTrainingQuery(message: string): string {
  if (message.length > MAX_PUBLIC_QUERY_PARSE_CHARS) return '';
  const topic = message
    .replace(EMAIL_RE, ' ')
    .replace(PHONE_RE, ' ')
    .replace(PRIVATE_CONTEXT_CLAUSE_RE, ' ')
    .replace(PERSONAL_HEALTH_PHRASE_RE, ' person has ')
    .replace(PERSONAL_PRONOUN_RE, ' ')
    .replace(PRIVATE_TRAINING_RESIDUE_RE, ' ')
    .replace(QUESTION_WORD_RE, ' ')
    .replace(/[?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  if (!topic || PRIVATE_CONTEXT_RE.test(topic)) return '';
  return `public health and training guidance for ${topic}; when to stop and seek professional care`;
}
