// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { InlineButton } from '../../adapters/message-adapter';
import type { DomainName } from '../../domains/types';
import {
  storeChatMessage,
  updateAssistantMessage,
  type ChatHistoryWrite,
} from '../../services/chat-history-store';
import { runOutboxTransaction } from '../../services/event-outbox';
import {
  addToConversation,
  syncLastAssistantConversationMessage,
} from '../../state/conversation';

type AssistantExchange = {
  text: string;
  domain?: string | null;
  routeMethod?: string | null;
  confidence?: number | null;
  buttons?: unknown;
  metadata?: unknown;
  timestamp: string;
};

type PersistExchangeOptions = {
  clientMessageId?: string | null;
  requestId?: string | null;
};

type AssistantEditInput = {
  tenantId?: number;
  userId: number;
  messageId: string;
  text: string;
  domain: DomainName;
  buttons?: InlineButton[][] | null;
  metadata?: unknown;
  routeMethod?: string | null;
  confidence?: number | null;
  timestamp: string;
};

type CallbackPersistenceInput = Omit<AssistantEditInput, 'messageId'> & {
  messageId?: string | null;
  editOriginal: boolean;
  fallbackMessageId?: string;
};

function updateScopedAssistantMessage(
  input: Pick<AssistantEditInput, 'userId' | 'messageId' | 'tenantId'>,
  patch: Parameters<typeof updateAssistantMessage>[2],
): boolean {
  return input.tenantId
    ? updateAssistantMessage(input.userId, input.messageId, patch, input.tenantId)
    : updateAssistantMessage(input.userId, input.messageId, patch);
}

export function persistExchange(
  userId: number,
  userMessageId: string,
  userText: string,
  assistantMessageId: string,
  assistant: AssistantExchange,
  tenantId?: number,
  options: PersistExchangeOptions = {},
): void {
  const writeExchange = () => {
    storeChatMessage({
      ...(tenantId ? { tenantId } : {}),
      userId,
      messageId: userMessageId,
      role: 'user',
      text: userText,
      timestamp: assistant.timestamp,
      lifecycleState: 'sent',
      clientMessageId: options.clientMessageId ?? null,
      requestId: options.requestId ?? null,
    });
    storeChatMessage({
      ...(tenantId ? { tenantId } : {}),
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
      lifecycleState: 'completed',
      completedAt: assistant.timestamp,
      retryOfMessageId: userMessageId,
      requestId: options.requestId ?? null,
    });
  };
  runOutboxTransaction((emitDomainEvent) => {
    writeExchange();
    emitDomainEvent({
      tenantId: tenantId ?? userId,
      userId,
      sourceSkill: 'chat',
      eventType: 'chat.message.created',
      entityType: 'chat_message',
      entityId: assistantMessageId,
      payload: {
        userMessageId,
        assistantMessageId,
        textLength: userText.length,
        assistantTextLength: assistant.text.length,
        domain: assistant.domain ?? null,
        routeMethod: assistant.routeMethod ?? null,
      },
      privacyClassification: 'private_content',
      idempotencyKey: `chat.message.created:${tenantId ?? userId}:${userId}:${assistantMessageId}`,
      correlationId: options.requestId ?? undefined,
      requestId: options.requestId ?? undefined,
    });
  }, writeExchange);
}

export function syncConversationStateForShortcut(
  userId: number,
  domain: DomainName,
  userText: string,
  assistantText: string,
  tenantId?: number,
): void {
  if (tenantId) {
    addToConversation(userId, domain, 'user', userText, tenantId);
    addToConversation(userId, domain, 'assistant', assistantText, tenantId);
    return;
  }
  addToConversation(userId, domain, 'user', userText);
  addToConversation(userId, domain, 'assistant', assistantText);
}

export function syncConversationAssistantEdit(
  userId: number,
  domain: DomainName,
  assistantText: string,
  tenantId?: number,
): void {
  if (tenantId) {
    syncLastAssistantConversationMessage(userId, domain, assistantText, tenantId);
    return;
  }
  syncLastAssistantConversationMessage(userId, domain, assistantText);
}

export function persistAssistantEdit(input: AssistantEditInput): boolean {
  const updated = updateScopedAssistantMessage(input, {
    text: input.text,
    domain: input.domain,
    buttons: input.buttons ?? null,
    metadata: input.metadata ?? null,
    routeMethod: input.routeMethod ?? null,
    confidence: input.confidence ?? null,
    timestamp: input.timestamp,
  });
  syncConversationAssistantEdit(input.userId, input.domain, input.text, input.tenantId);
  return updated;
}

export function persistCallbackAssistantResponse(input: CallbackPersistenceInput): {
  updatedOriginal: boolean;
  storedFallback: boolean;
} {
  if (input.editOriginal && input.messageId) {
    const updatedOriginal = updateScopedAssistantMessage({ ...input, messageId: input.messageId }, {
      text: input.text,
      domain: input.domain,
      buttons: input.buttons ?? null,
      metadata: input.metadata ?? null,
      routeMethod: input.routeMethod ?? null,
      confidence: input.confidence ?? null,
      timestamp: input.timestamp,
    });
    if (!updatedOriginal) {
      storeCallbackAssistantMessage(input);
    }
    syncConversationAssistantEdit(input.userId, input.domain, input.text, input.tenantId);
    return { updatedOriginal, storedFallback: !updatedOriginal };
  }

  storeCallbackAssistantMessage(input);
  syncConversationAssistantEdit(input.userId, input.domain, input.text, input.tenantId);
  return { updatedOriginal: false, storedFallback: true };
}

function storeCallbackAssistantMessage(input: CallbackPersistenceInput): void {
  const entry: ChatHistoryWrite = {
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    userId: input.userId,
    messageId: input.fallbackMessageId ?? `cb-${Date.now()}`,
    role: 'assistant',
    text: input.text,
    domain: input.domain,
    routeMethod: input.routeMethod,
    confidence: input.confidence,
    buttons: input.buttons,
    metadata: input.metadata,
    timestamp: input.timestamp,
  };
  storeChatMessage(entry);
}
