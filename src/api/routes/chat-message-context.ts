// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { InlineButton } from '../../adapters/message-adapter';
import { handleContent } from '../../domains/content-creator';
import { handleCooking } from '../../domains/cooking';
import { handleFinance } from '../../domains/finance';
import { getLastCoachState } from '../../domains/domain-handler';
import { handleSecretary } from '../../domains/secretary';
import { handleTriathlon } from '../../domains/triathlon';
import type { DomainName, DomainResponse } from '../../domains/types';
import { getChatMessageById } from '../../services/chat-history-store';
import { getIntegrationSummary } from '../../services/integration-status';
import { getNotificationProfileIfExists } from '../../services/notification-orchestrator';
import { getDecisionSummary } from '../../services/decision-center';
import { getCurrentChatRequestLocale } from '../../services/chat-request-locale-context';
import { logger } from '../../utils/logger';
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

export type ChatDomainHandler = (
  message: string,
  userId?: number,
  tenantId?: number,
  abortSignal?: AbortSignal,
) => Promise<DomainResponse & { metadata?: Record<string, unknown> | null }>;

function manifestTailLocale(message: string): 'en' | 'pt' {
  const requestLocale = getCurrentChatRequestLocale();
  if (requestLocale?.toLowerCase().startsWith('pt')) return 'pt';
  if (requestLocale?.toLowerCase().startsWith('en')) return 'en';
  // Shared words such as "mostrar" and "estado" cannot distinguish
  // Portuguese from Spanish. Require Portuguese-specific morphology; legacy
  // Spanish text then follows the supported English compatibility contract.
  if (/\b(?:minha|minhas|meu|meus|notifica(?:ção|ções)|decis(?:ão|ões)|conex(?:ão|ões))\b/iu.test(message)) {
    return 'pt';
  }
  return 'en';
}

function manifestTailScope(userId?: number, tenantId?: number): { userId: number; tenantId: number } | null {
  if (!Number.isSafeInteger(userId) || Number(userId) <= 0) return null;
  if (!Number.isSafeInteger(tenantId) || Number(tenantId) <= 0) return null;
  return { userId: Number(userId), tenantId: Number(tenantId) };
}

async function handleConnectionsManifestTail(
  message: string,
  userId?: number,
  tenantId?: number,
): ReturnType<ChatDomainHandler> {
  const scope = manifestTailScope(userId, tenantId);
  const locale = manifestTailLocale(message);
  if (!scope) {
    return {
      domain: 'connections',
      text: locale === 'pt'
        ? 'Não consegui verificar as conexões sem um contexto de conta válido.'
        : 'I could not check Connections without a valid account context.',
      metadata: { type: 'manifest_legacy_domain_fallback', verificationStatus: 'blocked' },
    };
  }
  try {
    const summary = getIntegrationSummary(scope.userId);
    const requested = ['google', 'outlook', 'garmin', 'apple_health']
      .find((provider) => message.toLowerCase().includes(provider.replace('_', ' ')));
    const providers = requested
      ? summary.providers.filter((provider) => provider.provider === requested)
      : summary.providers;
    const stateSummary = providers.length > 0
      ? providers.map((provider) => `${provider.provider}: ${provider.state}`).join(', ')
      : 'no matching provider';
    return {
      domain: 'connections',
      text: locale === 'pt'
        ? `Estado verificado das conexões: ${stateSummary}. Abre Conexões para gerir ou reconectar um provedor.`
        : `Verified connection state: ${stateSummary}. Open Connections to manage or reconnect a provider.`,
      metadata: {
        type: 'manifest_legacy_domain_fallback',
        verificationStatus: 'verified_success',
        providerCount: providers.length,
      },
    };
  } catch {
    return {
      domain: 'connections',
      text: locale === 'pt'
        ? 'As Conexões estão temporariamente indisponíveis. Não alterei nenhum provedor.'
        : 'Connections is temporarily unavailable. I did not change any provider.',
      metadata: { type: 'manifest_legacy_domain_fallback', verificationStatus: 'partial_failure' },
    };
  }
}

async function handleNotificationsManifestTail(
  message: string,
  userId?: number,
  tenantId?: number,
): ReturnType<ChatDomainHandler> {
  const scope = manifestTailScope(userId, tenantId);
  const locale = manifestTailLocale(message);
  if (!scope) {
    return {
      domain: 'notifications',
      text: locale === 'pt'
        ? 'Não consegui verificar as notificações sem um contexto de conta válido.'
        : 'I could not check Notifications without a valid account context.',
      metadata: { type: 'manifest_legacy_domain_fallback', verificationStatus: 'blocked' },
    };
  }
  try {
    const profile = getNotificationProfileIfExists(scope.userId, scope.tenantId);
    return {
      domain: 'notifications',
      text: locale === 'pt'
        ? profile
          ? 'Verifiquei as tuas preferências atuais. Abre Notificações para ver ou alterar os canais com confirmação.'
          : 'Ainda não tens preferências personalizadas. Abre Notificações para configurar os canais.'
        : profile
          ? 'I checked your current preferences. Open Notifications to review or change channels with confirmation.'
          : 'You do not have custom notification preferences yet. Open Notifications to configure channels.',
      metadata: {
        type: 'manifest_legacy_domain_fallback',
        verificationStatus: 'verified_success',
        customProfile: Boolean(profile),
      },
    };
  } catch {
    return {
      domain: 'notifications',
      text: locale === 'pt'
        ? 'As Notificações estão temporariamente indisponíveis. Não alterei nenhuma preferência.'
        : 'Notifications is temporarily unavailable. I did not change any preference.',
      metadata: { type: 'manifest_legacy_domain_fallback', verificationStatus: 'partial_failure' },
    };
  }
}

async function handleDecisionCenterManifestTail(
  message: string,
  userId?: number,
  tenantId?: number,
): ReturnType<ChatDomainHandler> {
  const scope = manifestTailScope(userId, tenantId);
  const locale = manifestTailLocale(message);
  if (!scope) {
    return {
      domain: 'decision_center',
      text: locale === 'pt'
        ? 'Não consegui verificar as decisões sem um contexto de conta válido.'
        : 'I could not check Decision Center without a valid account context.',
      metadata: { type: 'manifest_legacy_domain_fallback', verificationStatus: 'blocked' },
    };
  }
  try {
    const summary = getDecisionSummary(scope.userId, scope.tenantId);
    return {
      domain: 'decision_center',
      text: locale === 'pt'
        ? `Verifiquei o Centro de Decisões: ${summary.openCount} decisão(ões) em aberto. Abre o Centro de Decisões para agir.`
        : `I checked Decision Center: ${summary.openCount} open decision(s). Open Decision Center to take action.`,
      metadata: {
        type: 'manifest_legacy_domain_fallback',
        verificationStatus: 'verified_success',
        openDecisionCount: summary.openCount,
      },
    };
  } catch {
    return {
      domain: 'decision_center',
      text: locale === 'pt'
        ? 'O Centro de Decisões está temporariamente indisponível. Não alterei nenhuma decisão.'
        : 'Decision Center is temporarily unavailable. I did not change any decision.',
      metadata: { type: 'manifest_legacy_domain_fallback', verificationStatus: 'partial_failure' },
    };
  }
}

const domainHandlers: Record<string, ChatDomainHandler> = {
  secretary: handleSecretary,
  triathlon: handleTriathlon,
  content: handleContent,
  finance: handleFinance,
  cooking: handleCooking,
  // Manifest-only domains use deterministic local reads in the legacy tail.
  // Mutations remain owned by the earlier confirmation-gated action planner;
  // these handlers prevent an UNKNOWN_DOMAIN dead end without adding LLM spend.
  connections: handleConnectionsManifestTail,
  notifications: handleNotificationsManifestTail,
  decision_center: handleDecisionCenterManifestTail,
};

/**
 * Response-envelope domains that must never become routing continuity. `chat`
 * is what the manifest classifier's terminal `clarify`/`none` outcome returns;
 * pinning it makes the next turn short-circuit to UNKNOWN_DOMAIN.
 *
 * Scoped deliberately to envelope domains rather than "anything without a
 * legacy REST handler": Chat Core v2's deterministic read legitimately pins
 * conversation domains such as `tasks` and `training`, which have no entry in
 * `domainHandlers` and whose continuity must survive with every flag off.
 */
const NON_ROUTABLE_CONTINUITY_DOMAINS = new Set<string>(['chat']);

function isNonRoutableContinuityDomain(domain: DomainName): boolean {
  return NON_ROUTABLE_CONTINUITY_DOMAINS.has(domain);
}

export function rememberChatActiveDomain(
  userId: number,
  domain: DomainName,
  timestamp = Date.now(),
  tenantId?: number,
  continuity?: ChatContinuityWriteExtras,
): void {
  if (isNonRoutableContinuityDomain(domain)) {
    logger.warn({ userId, tenantId, domain }, 'Refusing non-routable active chat domain');
    return;
  }
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
  const domain = getActiveChatDomain(userId, now, tenantId);
  if (!domain) return null;
  if (!isNonRoutableContinuityDomain(domain)) return domain;

  // Defensive cleanup for an envelope domain persisted by an older release.
  // Clear before pre-routing can expose one as active context.
  logger.warn({ userId, tenantId, domain }, 'Dropping non-routable active chat domain');
  clearActiveChatDomain(userId, tenantId);
  return null;
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
    const coachState = getLastCoachState(userId, tenantId ?? userId);
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
