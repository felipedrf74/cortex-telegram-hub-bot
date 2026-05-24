// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { InlineButton } from '../../adapters/message-adapter';
import { handleContent } from '../../domains/content-creator';
import { handleCooking } from '../../domains/cooking';
import { handleFinance } from '../../domains/finance';
import { getLastCoachState } from '../../domains/domain-handler';
import { handleSecretary } from '../../domains/secretary';
import { handleTriathlon } from '../../domains/triathlon';
import type { DomainName } from '../../domains/types';
import { getLastAssistantMessage } from '../../state/conversation';
import {
  buildCoachRecommendationButtons,
  buildSecretaryQuickActionButtons,
  labelsForLanguage,
} from './chat-inline-buttons';

export const CHAT_ACTIVE_DOMAIN_TTL_MS = 5 * 60 * 1000;

export interface ChatActiveContext {
  domain: DomainName;
  lastAssistantMessage: string;
}

export type ChatDomainHandler = (message: string, userId?: number, tenantId?: number) => Promise<{ text: string; domain: DomainName }>;

const lastActiveDomain = new Map<string, { domain: DomainName; timestamp: number }>();

const domainHandlers: Record<string, ChatDomainHandler> = {
  secretary: handleSecretary,
  triathlon: handleTriathlon,
  content: handleContent,
  finance: handleFinance,
  cooking: handleCooking,
};

function activeDomainKey(userId: number, tenantId?: number): string {
  const scopedTenantId = typeof tenantId === 'number' && Number.isFinite(tenantId) && tenantId > 0
    ? tenantId
    : userId;
  return `${scopedTenantId}:${userId}`;
}

export function rememberChatActiveDomain(
  userId: number,
  domain: DomainName,
  timestamp = Date.now(),
  tenantId?: number,
): void {
  lastActiveDomain.set(activeDomainKey(userId, tenantId), { domain, timestamp });
}

/**
 * Scheduler-facing alias for cron-generated assistant messages.
 * Kept here instead of the legacy Telegram shared state so native chat
 * continuity survives the Telegram inbound removal.
 */
export function setLastActiveDomain(userId: number, domain: DomainName, tenantId?: number): void {
  rememberChatActiveDomain(userId, domain, Date.now(), tenantId);
}

export function clearChatActiveDomain(userId: number, tenantId?: number): void {
  lastActiveDomain.delete(activeDomainKey(userId, tenantId));
}

export function getLastChatActiveDomain(userId: number, now = Date.now(), tenantId?: number): DomainName | null {
  const lastState = lastActiveDomain.get(activeDomainKey(userId, tenantId));
  if (!lastState || now - lastState.timestamp >= CHAT_ACTIVE_DOMAIN_TTL_MS) return null;
  return lastState.domain;
}

export function resolveChatActiveContext(userId: number, now = Date.now(), tenantId?: number): ChatActiveContext | null {
  const domain = getLastChatActiveDomain(userId, now, tenantId);
  if (!domain) return null;

  try {
    const lastAssistantMessage = tenantId
      ? getLastAssistantMessage(userId, domain, tenantId)
      : getLastAssistantMessage(userId, domain);
    return lastAssistantMessage ? { domain, lastAssistantMessage } : null;
  } catch {
    return null;
  }
}

export function getChatDomainHandler(domain: string): ChatDomainHandler | undefined {
  return domainHandlers[domain];
}

export function buildDefaultButtonsForChatDomain(
  domain: string,
  lang: string,
  userId?: number,
  requestStartedAt?: number,
  tenantId?: number,
): InlineButton[][] | null {
  if (domain === 'secretary') {
    return buildSecretaryQuickActionButtons(labelsForLanguage(lang));
  }

  if (domain === 'triathlon' && userId && requestStartedAt) {
    const coachState = getLastCoachState(userId);
    if (coachState && coachState.timestamp >= requestStartedAt - 1000) {
      const buttons = buildCoachRecommendationButtons(
        coachState.recommendations,
        labelsForLanguage(lang),
        4,
        { userId, tenantId },
      );
      return buttons.length > 0 ? buttons : null;
    }
  }

  return null;
}

export function resetChatMessageContextForTests(): void {
  lastActiveDomain.clear();
}
