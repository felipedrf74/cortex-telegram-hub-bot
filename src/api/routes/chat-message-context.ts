// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { InlineButton } from '../../adapters/message-adapter';
import { handleContent } from '../../domains/content-creator';
import { handleCooking } from '../../domains/cooking';
import { handleFinance } from '../../domains/finance';
import { getLastCoachState } from '../../domains/domain-handler';
import { handleSecretary } from '../../domains/secretary';
import { handleTriathlon } from '../../domains/triathlon';
import type { DomainName } from '../../domains/types';
import { getChatMessageById } from '../../services/chat-history-store';
import {
  clearActiveChatDomain,
  getActiveChatDomain,
  getDurableChatContinuity,
  rememberActiveChatDomain,
  resetChatConversationStateForTests,
  type ChatContinuityWriteExtras,
} from '../../services/chat-conversation-state';
import { getLastAssistantMessage } from '../../state/conversation';
import {
  buildCoachRecommendationButtons,
  buildSecretaryQuickActionButtons,
  labelsForLanguage,
} from './chat-inline-buttons';

// M13: the active-domain pin is now durable (chat_conversation_state via
// services/chat-conversation-state) with the old in-process Map demoted to a
// private read cache inside that module. The exported interface here stays
// call-compatible; the TTL constant keeps its historical home and value.
export {
  CHAT_ACTIVE_DOMAIN_TTL_MS,
  getDurableChatContinuity,
} from '../../services/chat-conversation-state';
export type {
  ChatAnchorEntity,
  ChatContinuityWriteExtras,
  DurableChatContinuity,
} from '../../services/chat-conversation-state';

export interface ChatActiveContext {
  domain: DomainName;
  lastAssistantMessage: string;
}

export type ChatDomainHandler = (message: string, userId?: number, tenantId?: number) => Promise<{ text: string; domain: DomainName }>;

const domainHandlers: Record<string, ChatDomainHandler> = {
  secretary: handleSecretary,
  triathlon: handleTriathlon,
  content: handleContent,
  finance: handleFinance,
  cooking: handleCooking,
};

export function rememberChatActiveDomain(
  userId: number,
  domain: DomainName,
  timestamp = Date.now(),
  tenantId?: number,
  continuity?: ChatContinuityWriteExtras,
): void {
  rememberActiveChatDomain(userId, domain, timestamp, tenantId, continuity);
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
  clearActiveChatDomain(userId, tenantId);
}

export function getLastChatActiveDomain(userId: number, now = Date.now(), tenantId?: number): DomainName | null {
  return getActiveChatDomain(userId, now, tenantId);
}

export function resolveChatActiveContext(userId: number, now = Date.now(), tenantId?: number): ChatActiveContext | null {
  const domain = getLastChatActiveDomain(userId, now, tenantId);
  if (!domain) return null;

  try {
    const lastAssistantMessage = tenantId
      ? getLastAssistantMessage(userId, domain, tenantId)
      : getLastAssistantMessage(userId, domain);
    if (lastAssistantMessage) return { domain, lastAssistantMessage };
  } catch {
    // Fall through to durable recovery below.
  }

  // M13: after a restart (or when the pruned conversations table misses),
  // recover the last assistant reply from chat-history-store via the durable
  // last_assistant_message_id pointer. Fail closed on any error, matching
  // the historical contract of this function.
  try {
    const continuity = getDurableChatContinuity(userId, tenantId, now);
    const messageId = continuity?.lastAssistantMessageId;
    if (!messageId) return null;
    const message = getChatMessageById(userId, messageId, tenantId);
    if (message && message.role === 'assistant' && message.text) {
      return { domain, lastAssistantMessage: message.text };
    }
    return null;
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

/**
 * Test seam: clears ONLY the in-process read cache — durable
 * chat_conversation_state rows survive, which lets tests simulate a
 * process restart.
 */
export function resetChatMessageContextForTests(): void {
  resetChatConversationStateForTests();
}
