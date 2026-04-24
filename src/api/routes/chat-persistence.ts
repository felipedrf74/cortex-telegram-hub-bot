// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { InlineButton } from '../../adapters/message-adapter';
import type { DomainName } from '../../domains/types';
import {
  storeChatMessage,
  updateAssistantMessage,
  type ChatHistoryWrite,
} from '../../services/chat-history-store';
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

type AssistantEditInput = {
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

export function persistExchange(
  userId: number,
  userMessageId: string,
  userText: string,
  assistantMessageId: string,
  assistant: AssistantExchange,
): void {
  storeChatMessage({
    userId,
    messageId: userMessageId,
    role: 'user',
    text: userText,
    timestamp: assistant.timestamp,
  });
  storeChatMessage({
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
  });
}

export function syncConversationStateForShortcut(
  userId: number,
  domain: DomainName,
  userText: string,
  assistantText: string,
): void {
  addToConversation(userId, domain, 'user', userText);
  addToConversation(userId, domain, 'assistant', assistantText);
}

export function syncConversationAssistantEdit(
  userId: number,
  domain: DomainName,
  assistantText: string,
): void {
  syncLastAssistantConversationMessage(userId, domain, assistantText);
}

export function persistAssistantEdit(input: AssistantEditInput): boolean {
  const updated = updateAssistantMessage(input.userId, input.messageId, {
    text: input.text,
    domain: input.domain,
    buttons: input.buttons ?? null,
    metadata: input.metadata ?? null,
    routeMethod: input.routeMethod ?? null,
    confidence: input.confidence ?? null,
    timestamp: input.timestamp,
  });
  syncConversationAssistantEdit(input.userId, input.domain, input.text);
  return updated;
}

export function persistCallbackAssistantResponse(input: CallbackPersistenceInput): {
  updatedOriginal: boolean;
  storedFallback: boolean;
} {
  if (input.editOriginal && input.messageId) {
    const updatedOriginal = updateAssistantMessage(input.userId, input.messageId, {
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
    syncConversationAssistantEdit(input.userId, input.domain, input.text);
    return { updatedOriginal, storedFallback: !updatedOriginal };
  }

  storeCallbackAssistantMessage(input);
  syncConversationAssistantEdit(input.userId, input.domain, input.text);
  return { updatedOriginal: false, storedFallback: true };
}

function storeCallbackAssistantMessage(input: CallbackPersistenceInput): void {
  const entry: ChatHistoryWrite = {
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
