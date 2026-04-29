// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { InlineButton } from '../../adapters/message-adapter';
import type { DomainName } from '../../domains/types';
import { getCached, setCache } from '../../services/cache-store';
import { resolveChatTenantId } from '../../services/chat-tenant-scope';
import { getUserLanguage } from '../../services/user-service';
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
  if (!fastPath) {
    return null;
  }

  const response: ChatMessageRouteResponse = {
    id: `msg-${Date.now()}`,
    text: fastPath.text,
    domain: fastPath.domain,
    routeMethod: 'fast-path',
    confidence: 1.0,
    buttons: fastPath.buttons ?? null,
    metadata: null,
    timestamp: new Date().toISOString(),
  };

  return {
    response,
    conversationDomain: fastPath.domain,
    cacheable: isCacheableChatCommand(normalizedTextLower),
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

  const lang = getUserLanguage(userId);
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
