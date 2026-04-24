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

export type ChatDomainHandler = (message: string, userId?: number) => Promise<{ text: string; domain: DomainName }>;

const lastActiveDomain = new Map<number, { domain: DomainName; timestamp: number }>();

const domainHandlers: Record<string, ChatDomainHandler> = {
  secretary: handleSecretary,
  triathlon: handleTriathlon,
  content: handleContent,
  finance: handleFinance,
  cooking: handleCooking,
};

export function rememberChatActiveDomain(userId: number, domain: DomainName, timestamp = Date.now()): void {
  lastActiveDomain.set(userId, { domain, timestamp });
}

export function clearChatActiveDomain(userId: number): void {
  lastActiveDomain.delete(userId);
}

export function getLastChatActiveDomain(userId: number, now = Date.now()): DomainName | null {
  const lastState = lastActiveDomain.get(userId);
  if (!lastState || now - lastState.timestamp >= CHAT_ACTIVE_DOMAIN_TTL_MS) return null;
  return lastState.domain;
}

export function resolveChatActiveContext(userId: number, now = Date.now()): ChatActiveContext | null {
  const domain = getLastChatActiveDomain(userId, now);
  if (!domain) return null;

  try {
    const lastAssistantMessage = getLastAssistantMessage(userId, domain);
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
): InlineButton[][] | null {
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

export function resetChatMessageContextForTests(): void {
  lastActiveDomain.clear();
}
