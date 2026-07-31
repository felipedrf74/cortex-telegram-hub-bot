// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';

import type { InlineButton } from '../../adapters/message-adapter';
import type { DomainName } from '../../domains/types';
import { getCached, setCache } from '../../services/cache-store';
import { detectChatCoreV2WriteIntent } from '../../services/chat-core-v2/action-gateway';
import {
  MAX_VISIBLE_TRAINING_SESSIONS,
  TRAINING_SESSION_EXPLAIN_CAPABILITY,
} from '../../services/chat-core-v2/deterministic-read/common';
import { normalizeChatCoreV2TemplateLocale } from '../../services/chat-core-v2/locale-policy';
import { classifyShadowRoute } from '../../services/chat-core-v2/shadow-route-classifier';
import { resolveChatTenantId } from '../../services/chat-tenant-scope';
import { tryFastpath } from '../../services/secretary-fastpath';
import {
  isStrictIsoDate,
  resolveTrainingDay,
  trainingWeekdayMatches,
} from '../../services/training-date-utils';
import {
  getActivePlan,
  getSessionsForWeek,
  getWeeksForPlan,
  type TrainingSession,
} from '../../services/training-plans';
import {
  getPreferredDisplayNameById,
  getUserLanguageById,
  getUserTimezoneById,
} from '../../services/user-service';
import { tryDeterministicChatCommand } from './chat-fastpath';

export type ChatMessageRouteResponse = {
  id: string;
  text: string;
  domain: DomainName;
  routeMethod: string;
  confidence: number;
  buttons: InlineButton[][] | null;
  metadata: unknown;
  timestamp: string;
};

export type LocalChatResponse = {
  response: ChatMessageRouteResponse;
  conversationDomain: DomainName;
  cacheable: boolean;
};

// Commands whose responses can be cached (deterministic for a few minutes).
const CACHEABLE_COMMANDS = new Set([
  '/day', '/today', '/status', '/week', '/todosummary', '/todo_summary',
  '/todo', '/todos', '/tasks', '/lists',
  '/duetoday', '/due_today', '/overdue', '/dueweek', '/due_week', '/alltasks', '/all_tasks',
  '/training today', '/training plan',
]);

const CHAT_CMD_TTL = 60; // seconds
const INACTIVE_TRAINING_SESSION_STATUSES = new Set([
  'rest',
  'unscheduled',
  'deferred',
  'dropped',
  'cancelled',
  'superseded',
]);

// Phase 14 batch 76 (2026-05-16): identity-question detector extracted to
// `src/services/identity-question-detector.ts` and re-exported here for
// backwards-compatibility with existing importers. The extracted module
// also adds Spanish identity-question coverage (Phase 14 ES expansion).
import { isAuthenticatedIdentityQuestion } from '../../services/identity-question-detector';
export { isAuthenticatedIdentityQuestion };

function resolveLocalResponseLocale(
  userId: number,
  responseLocale?: string,
): ReturnType<typeof normalizeChatCoreV2TemplateLocale> {
  return normalizeChatCoreV2TemplateLocale(responseLocale ?? getUserLanguageById(userId));
}

function cacheKey(
  userId: number,
  normalizedTextLower: string,
  tenantId?: number,
  responseLocale?: string,
): string {
  const scopedTenantId = resolveChatTenantId(userId, tenantId);
  const locale = resolveLocalResponseLocale(userId, responseLocale);
  return `chat-cmd:${scopedTenantId}:${userId}:${locale}:${normalizedTextLower}`;
}

export function isCacheableChatCommand(normalizedTextLower: string): boolean {
  return CACHEABLE_COMMANDS.has(normalizedTextLower);
}

export function getCachedChatCommandResponse(
  userId: number,
  normalizedTextLower: string,
  tenantId?: number,
  responseLocale?: string,
): ChatMessageRouteResponse | null {
  if (!isCacheableChatCommand(normalizedTextLower)) {
    return null;
  }
  return getCached<ChatMessageRouteResponse>(
    cacheKey(userId, normalizedTextLower, tenantId, responseLocale),
  ) ?? null;
}

export function maybeCacheChatCommandResponse(
  userId: number,
  normalizedTextLower: string,
  response: ChatMessageRouteResponse,
  tenantId?: number,
  responseLocale?: string,
): void {
  if (!isCacheableChatCommand(normalizedTextLower)) {
    return;
  }
  setCache(
    cacheKey(userId, normalizedTextLower, tenantId, responseLocale),
    response,
    CHAT_CMD_TTL,
  );
}

export async function tryBuildFastPathChatResponse(
  normalizedText: string,
  normalizedTextLower: string,
  userId: number,
  tenantId?: number,
  responseLocale?: string,
): Promise<LocalChatResponse | null> {
  const locale = resolveLocalResponseLocale(userId, responseLocale);
  const secretaryLocale = locale === 'en' ? 'en-US' : locale;
  const fastPath = await tryDeterministicChatCommand(normalizedText, userId, tenantId);
  if (!fastPath) {
    const trainingTodayRead = tryBuildTrainingTodayReadResponse({
      normalizedText,
      userId,
      tenantId: resolveChatTenantId(userId, tenantId),
      locale,
    });
    if (trainingTodayRead) return trainingTodayRead;
  }
  const secretaryFastPath = fastPath
    ? null
    : await tryFastpath(userId, normalizedText, secretaryLocale, tenantId ?? userId);
  const resolvedFastPath = fastPath ?? (
    secretaryFastPath?.matched && secretaryFastPath.response
      ? { text: secretaryFastPath.response.text, domain: secretaryFastPath.response.domain, buttons: undefined }
      : null
  );
  if (!resolvedFastPath) {
    return null;
  }

  const response: ChatMessageRouteResponse = {
    id: `msg-${randomUUID()}`,
    text: resolvedFastPath.text,
    domain: resolvedFastPath.domain,
    routeMethod: 'fast-path',
    confidence: 1.0,
    buttons: resolvedFastPath.buttons ?? null,
    metadata: secretaryFastPath?.matched ? { patternId: secretaryFastPath.patternId ?? null } : null,
    timestamp: new Date().toISOString(),
  };

  return {
    response,
    conversationDomain: resolvedFastPath.domain,
    cacheable: isCacheableChatCommand(normalizedTextLower),
  };
}

function tryBuildTrainingTodayReadResponse(input: {
  normalizedText: string;
  userId: number;
  tenantId: number;
  locale: ReturnType<typeof normalizeChatCoreV2TemplateLocale>;
}): LocalChatResponse | null {
  if (!isDirectTrainingTodayRead(input.normalizedText)) return null;

  const timezone = getUserTimezoneById(input.userId);
  const now = new Date();
  const today = resolveTrainingDay({ now, timezone });
  const localDate = today.date;
  const plan = getActivePlan(input.userId, input.tenantId);
  if (
    !plan
    || plan.user_id !== input.userId
    || plan.tenant_id !== input.tenantId
  ) {
    return buildTrainingTodayReadResponse(
      noTrainingTodayText(input.locale, 'no_plan'),
      input,
      localDate,
      0,
    );
  }

  const planStart = String(plan.start_date ?? '').slice(0, 10);
  const planEnd = String(plan.end_date ?? '').slice(0, 10);
  if (
    !isStrictIsoDate(planStart)
    || !isStrictIsoDate(planEnd)
    || localDate < planStart
    || localDate > planEnd
  ) {
    return buildTrainingTodayReadResponse(
      noTrainingTodayText(input.locale, 'outside_plan'),
      input,
      localDate,
      0,
    );
  }

  const weekNumber = Math.floor(
    (Date.parse(`${localDate}T00:00:00.000Z`) - Date.parse(`${planStart}T00:00:00.000Z`))
      / (7 * 24 * 60 * 60 * 1000),
  ) + 1;
  const currentWeek = getWeeksForPlan(plan.id)
    .find((week) => week.plan_id === plan.id && week.week_number === weekNumber);
  if (!currentWeek) {
    return buildTrainingTodayReadResponse(
      noTrainingTodayText(input.locale, 'no_session'),
      input,
      localDate,
      0,
    );
  }

  const todaySessions = getSessionsForWeek(currentWeek.id)
    .filter((session) => (
      session.plan_id === plan.id
      && session.tenant_id === input.tenantId
      && trainingWeekdayMatches(session.day_of_week, today)
      && !INACTIVE_TRAINING_SESSION_STATUSES.has(normalizeSessionStatus(session.status))
    ));
  if (todaySessions.length === 0) {
    return buildTrainingTodayReadResponse(
      noTrainingTodayText(input.locale, 'no_session'),
      input,
      localDate,
      0,
    );
  }

  return buildTrainingTodayReadResponse(
    trainingTodayText(
      todaySessions.slice(0, MAX_VISIBLE_TRAINING_SESSIONS),
      todaySessions.length,
      input.locale,
    ),
    input,
    localDate,
    todaySessions.length,
  );
}

function isDirectTrainingTodayRead(text: string): boolean {
  const normalized = normalizeComparableText(text);
  if (!normalized || normalized.startsWith('/')) return false;
  if (detectChatCoreV2WriteIntent(text).mayMutate) return false;
  if (isExternalResearchRequest(normalized) || isTrainingHealthAdviceRequest(normalized)) return false;
  if (!isTrainingTodayStateReadShape(normalized)) return false;

  const routeGuess = classifyShadowRoute(text);
  return routeGuess.intent === 'app_question'
    && routeGuess.domains.length === 1
    && routeGuess.domains[0] === 'training'
    && routeGuess.capabilityIds.includes(TRAINING_SESSION_EXPLAIN_CAPABILITY);
}

function isTrainingTodayStateReadShape(normalized: string): boolean {
  const shape = normalized
    .replace(/[’]/g, "'")
    .replace(/[?!.,]+$/g, '')
    .replace(/\s+/g, ' ');
  const englishShapes = [
    /^what(?:'s| is)\s+(?:my\s+)?today'?s\s+(?:workouts?|training(?:\s+sessions?)?|sessions?)$/,
    /^what(?:'s| is)\s+(?:my\s+)?(?:workouts?|training(?:\s+sessions?)?|sessions?)\s+(?:for\s+)?today$/,
    /^what\s+(?:workouts?|training\s+sessions?|sessions?)\s+do\s+i\s+have\s+(?:for\s+)?today$/,
    /^(?:show|list)(?:\s+me)?\s+(?:my\s+)?today'?s\s+(?:workouts?|training(?:\s+sessions?)?|sessions?)$/,
    /^(?:show|list)(?:\s+me)?\s+(?:my\s+)?(?:workouts?|training\s+sessions?|sessions?)\s+(?:for\s+)?today$/,
    /^(?:do\s+i\s+have|are\s+there)\s+(?:any\s+)?(?:workouts?|training\s+sessions?|sessions?)\s+(?:for\s+)?today$/,
    /^tell\s+me\s+(?:about\s+)?(?:my\s+)?today'?s\s+(?:workouts?|training(?:\s+sessions?)?|sessions?)$/,
  ];
  const portugueseShapes = [
    /^qual(?:\s+e|\s+seria)?\s+(?:o\s+meu\s+|o\s+)?(?:treino|sessao)\s+de\s+hoje$/,
    /^quais(?:\s+sao)?\s+(?:os\s+meus\s+|os\s+)?(?:treinos|sessoes)\s+de\s+hoje$/,
    /^que\s+(?:treino|sessao|treinos|sessoes)\s+(?:eu\s+)?tenho\s+hoje$/,
    /^(?:mostra|mostre|lista|liste)(?:-me)?\s+(?:o\s+meu\s+|os\s+meus\s+|meu\s+|meus\s+|o\s+|os\s+)?(?:treino|sessao|treinos|sessoes)\s+de\s+hoje$/,
  ];
  return [...englishShapes, ...portugueseShapes].some((pattern) => pattern.test(shape));
}

function isExternalResearchRequest(normalized: string): boolean {
  const hasResearchVerb = /\b(search|research|find|look\s+up|compare|pesquisa(?:r)?|procura(?:r)?|busca(?:r)?|investiga(?:r)?)\b/.test(normalized);
  const hasExternalSignal = /\b(recent|recentes|current|atuais|sources?|fontes|scientific|cientificas?|medical|medicas?|public|publicas?|official|oficiais|news|noticias|web|internet|2026)\b/.test(normalized);
  return hasResearchVerb && hasExternalSignal;
}

function isTrainingHealthAdviceRequest(normalized: string): boolean {
  const hasHealthSignal = /\b(knee|joelho|pain|dor|dores|injury|injuries|lesao|lesoes|hurt|hurts|sore|soreness|ache|aches|symptom|sintoma|sintomas|ill|sick|doente)\b/.test(normalized);
  if (!hasHealthSignal) return false;
  return /\b(should|devo|deveria|posso|can\s+i|train|training|workout|exercise|exercicio|treinar|treino|run|correr)\b/.test(normalized);
}

function buildTrainingTodayReadResponse(
  text: string,
  input: {
    locale: ReturnType<typeof normalizeChatCoreV2TemplateLocale>;
  },
  localDate: string,
  sessionCount: number,
): LocalChatResponse {
  return {
    conversationDomain: 'triathlon',
    cacheable: false,
    response: {
      id: `msg-${randomUUID()}`,
      text,
      domain: 'triathlon',
      routeMethod: 'training-today-read-shortcut',
      confidence: 1,
      buttons: null,
      metadata: {
        type: 'training_today_read',
        involvedSkills: ['training'],
        capabilityId: TRAINING_SESSION_EXPLAIN_CAPABILITY,
        localDate,
        sessionCount,
      },
      timestamp: new Date().toISOString(),
    },
  };
}

function trainingTodayText(
  sessions: TrainingSession[],
  totalSessionCount: number,
  locale: ReturnType<typeof normalizeChatCoreV2TemplateLocale>,
): string {
  const lines = sessions.map((session) => {
    const title = String(session.title ?? '').trim() || (locale === 'en' ? 'Scheduled session' : 'Sessão agendada');
    const details = [
      session.duration_minutes != null ? `${session.duration_minutes} min` : null,
      String(session.intensity_text ?? '').trim() || null,
      localizedTrainingStatus(session.status, locale),
    ].filter((value): value is string => Boolean(value));
    return details.length > 0 ? `${title} (${details.join(', ')})` : title;
  });
  if (locale === 'en') {
    const visible = lines.length === 1
      ? `Your workout for today is ${lines[0]}.`
      : `Here are your workouts for today:\n${lines.map((line) => `- ${line}`).join('\n')}`;
    const remaining = totalSessionCount - lines.length;
    return remaining > 0 ? `${visible}\n- ${remaining} more scheduled today` : visible;
  }
  const visible = lines.length === 1
    ? `Treino de hoje: ${lines[0]}`
    : `Treinos de hoje:\n${lines.map((line) => `- ${line}`).join('\n')}`;
  const remaining = totalSessionCount - lines.length;
  if (remaining <= 0) return visible;
  return locale === 'pt-BR'
    ? `${visible}\n- Mais ${remaining} treino(s) agendado(s) para hoje`
    : `${visible}\n- Mais ${remaining} treino(s) marcado(s) para hoje`;
}

function noTrainingTodayText(
  locale: ReturnType<typeof normalizeChatCoreV2TemplateLocale>,
  reason: 'no_plan' | 'outside_plan' | 'no_session',
): string {
  if (locale === 'en') {
    if (reason === 'no_plan') {
      return 'No workout is planned for today because you do not have an active training plan.';
    }
    if (reason === 'outside_plan') {
      return 'No workout is scheduled for today because the active training plan does not cover this date.';
    }
    return 'No workout is scheduled for today in your active training plan.';
  }
  if (locale === 'pt-BR') {
    if (reason === 'no_plan') {
      return 'Não há treino planejado para hoje porque você não tem um plano de treino ativo.';
    }
    if (reason === 'outside_plan') {
      return 'Não há treino programado para hoje porque o plano de treino ativo não abrange esta data.';
    }
    return 'Não há treino programado para hoje no seu plano de treino ativo.';
  }
  if (reason === 'no_plan') {
    return 'Não há treino planeado para hoje porque não tens um plano de treino ativo.';
  }
  if (reason === 'outside_plan') {
    return 'Não há treino marcado para hoje porque o plano de treino ativo não abrange esta data.';
  }
  return 'Não há treino marcado para hoje no teu plano de treino ativo.';
}

function localizedTrainingStatus(
  status: unknown,
  locale: ReturnType<typeof normalizeChatCoreV2TemplateLocale>,
): string | null {
  const normalized = normalizeSessionStatus(status);
  if (normalized === 'completed') return locale === 'en' ? 'completed' : 'concluído';
  if (normalized === 'skipped') return locale === 'en' ? 'skipped' : 'ignorado';
  if (['pending', 'scheduled', 'reflowed', 'moved'].includes(normalized)) {
    return locale === 'en' ? 'pending' : 'pendente';
  }
  return null;
}

function normalizeComparableText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase();
}

function normalizeSessionStatus(value: unknown): string {
  return normalizeComparableText(value || 'pending');
}

export function tryBuildAuthenticatedIdentityResponse(
  normalizedText: string,
  normalizedTextLower: string,
  userId: number,
  responseLocale?: string,
): LocalChatResponse | null {
  if (!isAuthenticatedIdentityQuestion(normalizedTextLower || normalizedText)) {
    return null;
  }

  const lang = resolveLocalResponseLocale(userId, responseLocale);
  const isPT = lang.startsWith('pt');
  const displayName = getPreferredDisplayNameById(userId);
  const hasDisplayName = Boolean(displayName);
  const text = isPT
    ? hasDisplayName
      ? `A sessão autenticada está em nome de ${displayName}. Vou usar apenas os dados ligados a esta conta e a este tenant.`
      : 'Consigo ver a tua sessão autenticada, mas não há um nome de perfil guardado. Vou usar apenas os dados ligados ao teu utilizador autenticado e a este tenant.'
    : hasDisplayName
      ? `This authenticated session is signed in as ${displayName}. I will only use data tied to this account and tenant.`
      : 'I can see the authenticated session, but there is no saved profile name. I will only use data tied to this authenticated user and tenant.';

  return {
    conversationDomain: 'secretary',
    cacheable: false,
    response: {
      id: `msg-${randomUUID()}`,
      text,
      domain: 'secretary',
      routeMethod: 'authenticated-identity',
      confidence: 1,
      buttons: null,
      metadata: {
        type: 'authenticated_identity',
        userId,
        hasDisplayName,
      },
      timestamp: new Date().toISOString(),
    },
  };
}

export function tryBuildTrainingPlanShortcutResponse(
  normalizedText: string,
  normalizedTextLower: string,
  userId: number,
  responseLocale?: string,
): LocalChatResponse | null {
  const planKeywords = [
    'criar plano', 'cria um plano', 'crie um plano', 'novo plano de treino',
    'gerar plano', 'create plan', 'create training plan', 'make me a plan',
    'build a plan', 'generate a plan', 'new training plan',
  ];

  if (!planKeywords.some((keyword) => normalizedTextLower.includes(keyword))) {
    return null;
  }

  const lang = resolveLocalResponseLocale(userId, responseLocale);
  const isPT = lang.startsWith('pt');
  const response: ChatMessageRouteResponse = {
    id: `msg-${randomUUID()}`,
    text: isPT
      ? '🏋️ Para criar um plano de treino personalizado, vá à aba **Treino** e toque em **Criar plano**.\n\nO plano será gerado com base no seu perfil e agenda os treinos automaticamente no calendário.'
      : '🏋️ To create a personalized training plan, go to the **Training** tab and tap **Create Plan**.\n\nThe plan will be generated based on your profile and automatically schedule workouts in your calendar.',
    domain: 'triathlon',
    routeMethod: 'plan-shortcut',
    confidence: 1.0,
    buttons: null,
    metadata: null,
    timestamp: new Date().toISOString(),
  };

  return {
    response,
    conversationDomain: 'triathlon',
    cacheable: false,
  };
}
