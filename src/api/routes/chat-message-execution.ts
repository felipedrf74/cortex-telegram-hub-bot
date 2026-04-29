// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { InlineButton } from '../../adapters/message-adapter';
import type { DomainName } from '../../domains/types';
import type { RouteResult } from '../../router';
import type { ChatDomainHandler } from './chat-message-context';

export const CHAT_DOMAIN_HANDLER_TIMEOUT_MS = 40_000;

export type ChatDomainExecutionResult = {
  text: string;
  domain: DomainName;
};

export type ChatMessageResponseEnvelope = {
  id: string;
  text: string;
  domain: DomainName;
  routeMethod: RouteResult['method'];
  confidence: number;
  buttons: InlineButton[][] | null;
  metadata: null;
  timestamp: string;
};

export async function executeChatDomainHandler(
  handler: ChatDomainHandler,
  message: string,
  userId: number,
  tenantId?: number,
  timeoutMs = CHAT_DOMAIN_HANDLER_TIMEOUT_MS,
): Promise<ChatDomainExecutionResult> {
  const handlerPromise = handler(message, userId, tenantId);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Response timeout — AI is taking too long')), timeoutMs);
  });

  try {
    return await Promise.race([handlerPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function buildChatHandlerResponseEnvelope({
  route,
  result,
  buttons,
  timestamp = new Date().toISOString(),
  id = `msg-${Date.now()}`,
}: {
  route: RouteResult;
  result: ChatDomainExecutionResult;
  buttons: InlineButton[][] | null;
  timestamp?: string;
  id?: string;
}): ChatMessageResponseEnvelope {
  return {
    id,
    text: result.text,
    domain: result.domain || route.domain,
    routeMethod: route.method,
    confidence: route.confidence,
    buttons,
    metadata: null,
    timestamp,
  };
}
