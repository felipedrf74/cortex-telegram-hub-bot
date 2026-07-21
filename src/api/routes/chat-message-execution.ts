// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';

import type { InlineButton } from '../../adapters/message-adapter';
import type { DomainName } from '../../domains/types';
import type { RouteResult } from '../../router';
import type { ChatDomainHandler } from './chat-message-context';
import type { ChatResponseBlock } from '../../services/chat-response-blocks';
import type { ChatResponseCard } from '../../services/chat-response-cards';

export const CHAT_DOMAIN_HANDLER_TIMEOUT_MS = 40_000;

export type ChatDomainExecutionResult = {
  text: string;
  domain: DomainName;
  metadata?: Record<string, unknown> | null;
};

export type ChatMessageResponseEnvelope = {
  id: string;
  text: string;
  domain: DomainName;
  routeMethod: RouteResult['method'];
  confidence: number;
  buttons: InlineButton[][] | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
  // Phase 16 batch 83 (2026-05-17): typed block + card envelope. Optional
  // for the rollout window; iOS prefers these when present and falls back
  // to `text` + `metadata.type` for older builds. Telegram/WhatsApp
  // adapters consume the legacy `text` field via downgradeBlocksToText.
  responseBlocks?: ChatResponseBlock[];
  responseCards?: ChatResponseCard[];
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
  metadata = null,
  timestamp = new Date().toISOString(),
  // M11: uuid default — `msg-${Date.now()}` collides for envelopes built in
  // the same millisecond (concurrent /message requests).
  id = `msg-${randomUUID()}`,
}: {
  route: RouteResult;
  result: ChatDomainExecutionResult;
  buttons: InlineButton[][] | null;
  metadata?: Record<string, unknown> | null;
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
    metadata,
    timestamp,
  };
}
