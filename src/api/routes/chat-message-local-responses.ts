// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { InlineButton } from '../../adapters/message-adapter';
import type { DomainName } from '../../domains/types';
import { getCached, setCache } from '../../services/cache-store';
import { resolveChatTenantId } from '../../services/chat-tenant-scope';
import { tryFastpath } from '../../services/secretary-fastpath';
import { getPreferredDisplayNameById, getUserLanguageById } from '../../services/user-service';
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

// Phase 14 batch 76 (2026-05-16): identity-question detector extracted to
// `src/services/identity-question-detector.ts` and re-exported here for
// backwards-compatibility with existing importers. The extracted module
// also adds Spanish identity-question coverage (Phase 14 ES expansion).
import { isAuthenticatedIdentityQuestion } from '../../services/identity-question-detector';
export { isAuthenticatedIdentityQuestion };

function cacheKey(userId: number, normalizedTextLower: string, tenantId?: number): string {
  const scopedTenantId = resolveChatTenantId(userId, tenantId);
  return `chat-cmd:${scopedTenantId}:${userId}:${normalizedTextLower}`;
}

export function isCacheableChatCommand(normalizedTextLower: string): boolean {
  return CACHEABLE_COMMANDS.has(normalizedTextLower);
}

export function getCachedChatCommandResponse(
  userId: number,
  normalizedTextLower: string,
  tenantId?: number,
): ChatMessageRouteResponse | null {
  if (!isCacheableChatCommand(normalizedTextLower)) {
    return null;
  }
  return getCached<ChatMessageRouteResponse>(cacheKey(userId, normalizedTextLower, tenantId)) ?? null;
}

export function maybeCacheChatCommandResponse(
  userId: number,
  normalizedTextLower: string,
  response: ChatMessageRouteResponse,
  tenantId?: number,
): void {
  if (!isCacheableChatCommand(normalizedTextLower)) {
    return;
  }
  setCache(cacheKey(userId, normalizedTextLower, tenantId), response, CHAT_CMD_TTL);
}

export async function tryBuildFastPathChatResponse(
  normalizedText: string,
  normalizedTextLower: string,
  userId: number,
  tenantId?: number,
): Promise<LocalChatResponse | null> {
  const fastPath = await tryDeterministicChatCommand(normalizedText, userId, tenantId);
  const secretaryFastPath = fastPath
    ? null
    : await tryFastpath(userId, normalizedText, getUserLanguageById(userId), tenantId ?? userId);
  const resolvedFastPath = fastPath ?? (
    secretaryFastPath?.matched && secretaryFastPath.response
      ? { text: secretaryFastPath.response.text, domain: secretaryFastPath.response.domain, buttons: undefined }
      : null
  );
  if (!resolvedFastPath) {
    return null;
  }

  const response: ChatMessageRouteResponse = {
    id: `msg-${Date.now()}`,
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

export function tryBuildAuthenticatedIdentityResponse(
  normalizedText: string,
  normalizedTextLower: string,
  userId: number,
): LocalChatResponse | null {
  if (!isAuthenticatedIdentityQuestion(normalizedTextLower || normalizedText)) {
    return null;
  }

  const lang = getUserLanguageById(userId);
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
      id: `msg-${Date.now()}`,
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
): LocalChatResponse | null {
  const planKeywords = [
    'criar plano', 'cria um plano', 'crie um plano', 'novo plano de treino',
    'gerar plano', 'create plan', 'create training plan', 'make me a plan',
    'build a plan', 'generate a plan', 'new training plan',
  ];

  if (!planKeywords.some((keyword) => normalizedTextLower.includes(keyword))) {
    return null;
  }

  const lang = getUserLanguageById(userId);
  const isPT = lang.startsWith('pt');
  const response: ChatMessageRouteResponse = {
    id: `msg-${Date.now()}`,
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
