// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response } from 'express';
import { buildAITemporarilyBusyResponse } from '../../domains/ai-unavailable';
import { keywordMatch } from '../../router';
import { logger } from '../../utils/logger';
import { getLastChatActiveDomain } from './chat-message-context';
import { isRetryableAIProviderError } from './chat-content-refinement';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from './chat-persistence';

export async function sendRetryableChatFailureResponseIfNeeded(opts: {
  err: unknown;
  res: Response;
  userId: number;
  normalizedText: string;
  chatRequestId: string;
}): Promise<boolean> {
  const { err, res, userId, normalizedText, chatRequestId } = opts;
  if (!isRetryableAIProviderError(err)) return false;

  const degradedDomain = keywordMatch(normalizedText) || getLastChatActiveDomain(userId) || 'secretary';
  const degraded = await buildAITemporarilyBusyResponse(degradedDomain, userId);
  const timestamp = new Date().toISOString();
  const assistantMessageId = `msg-${Date.now()}`;

  logger.warn(
    { err, platform: 'ios', chatRequestId, userId, degradedDomain },
    'iOS chat/message degraded after retryable AI provider failure',
  );

  const response = {
    id: assistantMessageId,
    text: degraded.text,
    domain: degraded.domain,
    routeMethod: 'degraded',
    confidence: 0.1,
    buttons: null,
    metadata: { degraded: true, retryable: true },
    timestamp,
  };
  persistExchange(userId, `msg-user-${Date.now()}`, normalizedText, assistantMessageId, response);
  syncConversationStateForShortcut(userId, degraded.domain, normalizedText, degraded.text);
  res.json(response);
  return true;
}
