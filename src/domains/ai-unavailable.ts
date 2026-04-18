// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DomainName, DomainResponse } from './types';
import { buildDailyContext, getDailyContext } from '../services/context-engine';
import { getLatestByType } from '../services/report-document-store';
import { getUserLanguage } from '../services/user-service';
import { composeDailyBrief } from '../services/daily-brief-orchestrator';
import { getUnreadMailSummaryForUser } from '../services/unified-mail-pressure';
import {
  formatCurrencyAmount,
  getMonthlySummary,
  getPreferredCurrencyForUser,
} from '../services/finance-tracker';
import { getActiveContentPillars, getContentDeskItems } from '../services/content-intelligence';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../services/tenant-scope-observability';

function isPortugalPortuguese(language: string): boolean {
  return language === 'pt-PT';
}

function isEnglish(language: string): boolean {
  return language.toLowerCase().startsWith('en');
}

export function canUseDirectAnthropicFallback(): boolean {
  return process.env.ANTHROPIC_ENABLED === 'true' && !!process.env.ANTHROPIC_API_KEY;
}

function reportInvalidAIUnavailableScope(
  operation: string,
  userId: number,
  details?: Record<string, unknown>,
): void {
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: 'invalid_user_scope',
    userId,
    details,
  });
}

export function buildAIUnavailableResponse(domain: DomainName, userId?: number): DomainResponse {
  let language = 'pt-BR';

  if (typeof userId === 'number' && isValidTenantUserId(userId)) {
    try {
      language = getUserLanguage(userId);
    } catch {
      language = 'pt-BR';
    }
  } else if (typeof userId === 'number') {
    reportInvalidAIUnavailableScope('build_ai_unavailable_response', userId, { domain });
  }

  if (isEnglish(language)) {
    return {
      text: 'AI chat is temporarily unavailable in this environment because no provider is configured. Direct views and other deterministic actions can still work normally.',
      domain,
    };
  }

  if (isPortugalPortuguese(language)) {
    return {
      text: 'O chat com IA está temporariamente indisponível neste ambiente porque não há nenhum fornecedor configurado. As vistas diretas e outras ações determinísticas continuam a funcionar normalmente.',
      domain,
    };
  }

  return {
    text: 'O chat com IA está temporariamente indisponível neste ambiente porque não há nenhum provedor configurado. As visualizações diretas e outras ações determinísticas continuam funcionando normalmente.',
    domain,
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function trimSnippet(value: string, maxLength = 200): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) return normalized;
  const sliced = normalized.slice(0, maxLength);
  const boundary = sliced.lastIndexOf(' ');
  return `${(boundary > 0 ? sliced.slice(0, boundary) : sliced).trim()}...`;
}

function extractContextLine(summary: string, prefix: string): string | null {
  const line = summary
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function getFreshCoachBriefingSnippet(userId: number): string | null {
  try {
    const report = getLatestByType(userId, 'coach_briefing');
    if (!report) return null;

    const createdAtMs = Date.parse(report.createdAt || '');
    if (Number.isNaN(createdAtMs) || Date.now() - createdAtMs > 24 * 60 * 60 * 1000) {
      return null;
    }

    const documentJson = report.documentJson ?? {};
    const message = typeof documentJson.message === 'string' && documentJson.message.trim()
      ? documentJson.message.trim()
      : typeof report.summary === 'string' && report.summary.trim()
        ? report.summary.trim()
        : '';
    const firstRecommendation = Array.isArray(documentJson.recommendations)
      ? documentJson.recommendations.find((item: unknown) => typeof item === 'string' && item.trim())
      : null;

    if (message && typeof firstRecommendation === 'string') {
      return trimSnippet(`${message} Top recommendation: ${firstRecommendation}`);
    }
    if (message) return trimSnippet(message);
    if (typeof firstRecommendation === 'string') return trimSnippet(firstRecommendation);
    return null;
  } catch {
    return null;
  }
}

async function buildTrainingBusyFallback(language: string, userId: number): Promise<string | null> {
  const cachedDailyContext = getDailyContext(userId);
  const dailyContext = cachedDailyContext || await buildDailyContext(userId);
  const trainingLine = dailyContext ? extractContextLine(dailyContext, 'TRAINING:') : null;
  const readinessLine = dailyContext ? extractContextLine(dailyContext, 'READINESS:') : null;
  const briefingSnippet = getFreshCoachBriefingSnippet(userId);
  const contextBits = [trainingLine, readinessLine].filter((value): value is string => !!value);

  if (isEnglish(language)) {
    if (briefingSnippet && contextBits.length > 0) {
      return `AI chat is temporarily busy right now. Your latest coach briefing says: ${briefingSnippet} Saved training context: ${contextBits.join(' ')}`;
    }
    if (briefingSnippet) {
      return `AI chat is temporarily busy right now. Your latest coach briefing says: ${briefingSnippet}`;
    }
    if (contextBits.length > 0) {
      return `AI chat is temporarily busy right now. Your saved training context says: ${contextBits.join(' ')}`;
    }
    return null;
  }

  if (isPortugalPortuguese(language)) {
    if (briefingSnippet && contextBits.length > 0) {
      return `O chat com IA está temporariamente ocupado. O teu último briefing do coach diz: ${briefingSnippet} Contexto de treino guardado: ${contextBits.join(' ')}`;
    }
    if (briefingSnippet) {
      return `O chat com IA está temporariamente ocupado. O teu último briefing do coach diz: ${briefingSnippet}`;
    }
    if (contextBits.length > 0) {
      return `O chat com IA está temporariamente ocupado. O teu contexto de treino guardado diz: ${contextBits.join(' ')}`;
    }
    return null;
  }

  if (briefingSnippet && contextBits.length > 0) {
    return `O chat com IA está temporariamente ocupado agora. O seu último briefing do coach diz: ${briefingSnippet} Contexto salvo de treino: ${contextBits.join(' ')}`;
  }
  if (briefingSnippet) {
    return `O chat com IA está temporariamente ocupado agora. O seu último briefing do coach diz: ${briefingSnippet}`;
  }
  if (contextBits.length > 0) {
    return `O chat com IA está temporariamente ocupado agora. O seu contexto salvo de treino diz: ${contextBits.join(' ')}`;
  }
  return null;
}

async function buildSecretaryBusyFallback(language: string, userId: number): Promise<string | null> {
  try {
    const [brief, mailSummary] = await Promise.all([
      composeDailyBrief({ userId }),
      getUnreadMailSummaryForUser(userId).catch(() => null),
    ]);

    const topPriority = brief.coordination.topPriority ?? brief.day.secretary.priorityNote;
    const executionOrder = brief.coordination.executionOrder.slice(0, 3);
    const watchout = brief.coordination.watchouts[0] ?? brief.day.secretary.tradeoffNote ?? null;
    const unreadLine = mailSummary && mailSummary.totalUnread > 0
      ? (isEnglish(language)
        ? `Inbox pressure: ${mailSummary.totalUnread} unread email(s).`
        : isPortugalPortuguese(language)
          ? `Pressão de inbox: ${mailSummary.totalUnread} e-mail(s) por ler.`
          : `Pressão de inbox: ${mailSummary.totalUnread} e-mail(s) não lido(s).`)
      : null;

    if (!topPriority && executionOrder.length === 0 && !watchout && !unreadLine) {
      return null;
    }

    if (isEnglish(language)) {
      const parts = ['AI chat is temporarily busy right now.'];
      if (topPriority) parts.push(`Top priority: ${topPriority}`);
      if (executionOrder.length > 0) parts.push(`Execution order: ${executionOrder.join(' → ')}`);
      if (watchout) parts.push(`Watchout: ${watchout}`);
      if (unreadLine) parts.push(unreadLine);
      return parts.join(' ');
    }

    if (isPortugalPortuguese(language)) {
      const parts = ['O chat com IA está temporariamente ocupado.'];
      if (topPriority) parts.push(`Prioridade principal: ${topPriority}`);
      if (executionOrder.length > 0) parts.push(`Sequência sugerida: ${executionOrder.join(' → ')}`);
      if (watchout) parts.push(`Atenção: ${watchout}`);
      if (unreadLine) parts.push(unreadLine);
      return parts.join(' ');
    }

    const parts = ['O chat com IA está temporariamente ocupado agora.'];
    if (topPriority) parts.push(`Prioridade principal: ${topPriority}`);
    if (executionOrder.length > 0) parts.push(`Ordem sugerida: ${executionOrder.join(' → ')}`);
    if (watchout) parts.push(`Atenção: ${watchout}`);
    if (unreadLine) parts.push(unreadLine);
    return parts.join(' ');
  } catch {
    return null;
  }
}

async function buildFinanceBusyFallback(language: string, userId: number): Promise<string | null> {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const summary = getMonthlySummary(userId, month);
    const currency = getPreferredCurrencyForUser(userId);

    if (summary.transactionCount === 0 && summary.totalIncome === 0 && summary.totalExpenses === 0) {
      return null;
    }

    const income = formatCurrencyAmount(currency, summary.totalIncome);
    const expenses = formatCurrencyAmount(currency, summary.totalExpenses);
    const net = formatCurrencyAmount(currency, summary.netIncome);

    if (isEnglish(language)) {
      return `AI chat is temporarily busy right now. This month currently shows ${summary.transactionCount} finance entr${summary.transactionCount === 1 ? 'y' : 'ies'}: income ${income}, expenses ${expenses}, net ${net}.`;
    }

    if (isPortugalPortuguese(language)) {
      return `O chat com IA está temporariamente ocupado. Este mês mostra ${summary.transactionCount} registo(s) financeiros: receitas ${income}, despesas ${expenses}, líquido ${net}.`;
    }

    return `O chat com IA está temporariamente ocupado agora. Este mês mostra ${summary.transactionCount} lançamento(s) financeiros: receitas ${income}, despesas ${expenses}, líquido ${net}.`;
  } catch {
    return null;
  }
}

async function buildContentBusyFallback(language: string, userId: number): Promise<string | null> {
  try {
    const deskItems = getContentDeskItems(userId, 2);
    const pillars = getActiveContentPillars(userId).slice(0, 3).map((item) => item.name);

    if (deskItems.length === 0 && pillars.length === 0) {
      return null;
    }

    const deskSummary = deskItems.length > 0
      ? deskItems.map((item) => trimSnippet(item.title, 80)).join(' | ')
      : null;
    const pillarSummary = pillars.length > 0 ? pillars.join(', ') : null;

    if (isEnglish(language)) {
      const parts = ['AI chat is temporarily busy right now.'];
      if (deskSummary) parts.push(`Content desk items ready: ${deskSummary}.`);
      if (pillarSummary) parts.push(`Active pillars: ${pillarSummary}.`);
      return parts.join(' ');
    }

    if (isPortugalPortuguese(language)) {
      const parts = ['O chat com IA está temporariamente ocupado.'];
      if (deskSummary) parts.push(`Itens prontos na mesa de conteúdo: ${deskSummary}.`);
      if (pillarSummary) parts.push(`Pilares ativos: ${pillarSummary}.`);
      return parts.join(' ');
    }

    const parts = ['O chat com IA está temporariamente ocupado agora.'];
    if (deskSummary) parts.push(`Itens prontos na mesa de conteúdo: ${deskSummary}.`);
    if (pillarSummary) parts.push(`Pilares ativos: ${pillarSummary}.`);
    return parts.join(' ');
  } catch {
    return null;
  }
}

export async function buildAITemporarilyBusyResponse(domain: DomainName, userId?: number): Promise<DomainResponse> {
  let language = 'pt-BR';

  const hasValidUserScope = typeof userId === 'number' && isValidTenantUserId(userId);

  if (hasValidUserScope) {
    try {
      language = getUserLanguage(userId!);
    } catch {
      language = 'pt-BR';
    }
  } else if (typeof userId === 'number') {
    reportInvalidAIUnavailableScope('build_ai_temporarily_busy_response', userId, { domain });
  }

  if (domain === 'triathlon' && hasValidUserScope) {
    const trainingFallback = await buildTrainingBusyFallback(language, userId);
    if (trainingFallback) {
      return {
        text: trainingFallback,
        domain,
      };
    }
  }

  if (domain === 'secretary' && hasValidUserScope) {
    const secretaryFallback = await buildSecretaryBusyFallback(language, userId);
    if (secretaryFallback) {
      return {
        text: secretaryFallback,
        domain,
      };
    }
  }

  if (domain === 'finance' && hasValidUserScope) {
    const financeFallback = await buildFinanceBusyFallback(language, userId);
    if (financeFallback) {
      return {
        text: financeFallback,
        domain,
      };
    }
  }

  if (domain === 'content' && hasValidUserScope) {
    const contentFallback = await buildContentBusyFallback(language, userId);
    if (contentFallback) {
      return {
        text: contentFallback,
        domain,
      };
    }
  }

  if (isEnglish(language)) {
    return {
      text: 'AI chat is temporarily busy right now. Please try again in a moment.',
      domain,
    };
  }

  if (isPortugalPortuguese(language)) {
    return {
      text: 'O chat com IA está temporariamente ocupado. Tenta novamente dentro de um momento.',
      domain,
    };
  }

  return {
    text: 'O chat com IA está temporariamente ocupado agora. Tenta novamente em instantes.',
    domain,
  };
}
