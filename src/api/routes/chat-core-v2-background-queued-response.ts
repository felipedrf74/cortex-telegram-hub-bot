// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';

/**
 * WP-15 — the "working on it" acknowledgement response returned when a chat write
 * command is queued for background execution. This is the synchronous reply the
 * route sends immediately after `enqueueBackgroundChatCommand` succeeds; the
 * actual execution + result (and any APNs push) happen later in the worker. The
 * route tags this response `actionability='queued'`.
 */

import type { AICommandEnvelope } from '../../services/chat-core-v2';
import type { ChatResponseCard } from '../../services/chat-response-cards';

export interface ChatCoreV2BackgroundQueuedShortcutResponse {
  id: string;
  text: string;
  domain: 'secretary';
  routeMethod: 'chat-core-v2-background-queued';
  confidence: number;
  buttons: null;
  metadata: {
    type: 'chat_core_v2_background_queued';
    chatCoreV2: {
      capabilityId: string;
      jobId: string;
      queued: true;
      command: {
        commandId: string;
        domain: string;
        commandType: string;
        expiresAt: string;
      };
    };
  };
  timestamp: string;
  responseCards: ChatResponseCard[];
}

export interface BuildChatCoreV2BackgroundQueuedShortcutResponseInput {
  command: AICommandEnvelope<Record<string, unknown>>;
  capabilityId: string;
  jobId: string;
  requestStartedAt: number;
  locale?: string | null;
}

export interface BuildChatCoreV2BackgroundQueuedShortcutResponseResult {
  conversationDomain: 'secretary';
  response: ChatCoreV2BackgroundQueuedShortcutResponse;
  logContext: {
    capabilityId: string;
    commandId: string;
    jobId: string;
  };
}

function acknowledgementText(locale: string | null | undefined): string {
  const normalized = String(locale ?? '').toLowerCase();
  if (normalized.startsWith('pt')) return 'Estou a tratar disso — aviso-te assim que terminar.';
  return "I'm on it — I'll let you know as soon as it's done.";
}

export function buildChatCoreV2BackgroundQueuedShortcutResponse(
  input: BuildChatCoreV2BackgroundQueuedShortcutResponseInput,
): BuildChatCoreV2BackgroundQueuedShortcutResponseResult {
  const { command, capabilityId, jobId, requestStartedAt } = input;
  const conversationDomain = 'secretary';
  const text = acknowledgementText(input.locale);
  return {
    conversationDomain,
    response: {
      id: `msg-${randomUUID()}`,
      text,
      domain: conversationDomain,
      routeMethod: 'chat-core-v2-background-queued',
      confidence: 1,
      buttons: null,
      metadata: {
        type: 'chat_core_v2_background_queued',
        chatCoreV2: {
          capabilityId,
          jobId,
          queued: true,
          command: {
            commandId: command.commandId,
            domain: command.domain,
            commandType: command.commandType,
            expiresAt: command.expiresAt,
          },
        },
      },
      timestamp: new Date(requestStartedAt).toISOString(),
      // No card — a queued acknowledgement carries no actionable surface; the
      // real result (and its card) arrives later via the worker + APNs.
      responseCards: [],
    },
    logContext: {
      capabilityId,
      commandId: command.commandId,
      jobId,
    },
  };
}
