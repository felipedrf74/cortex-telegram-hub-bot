// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';

import { listLegacyToolLoopCheckpoints } from '../../services/chat-action-run-store';
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

// ─── M18: typed timeout with checkpointed partial progress ─────────
//
// Spike verdict (recorded in the milestone): resuming a timed-out OPEN legacy
// tool loop by re-injecting checkpointed tool results as prior provider turns
// is NOT provably safe across the process boundary —
//   (1) Promise.race abandons but does NOT cancel the handler; the original
//       loop keeps running detached in-process, so a queued continuation
//       could double-execute tools against it;
//   (2) ADV-2 pins continuations to the ISSUING provider with the fallback
//       stripped (provider-fallback.ts); a later worker where routing /
//       circuit state / operator overrides no longer resolve to the issuer
//       is a non-retryable MidLoopProviderFallbackError by design;
//   (3) continuations must recompute the SAME sliced-history/tool shape
//       (buildOptimizedOptions invariant) — by worker time the conversation
//       state has mutated, breaking open tool_use_id scope;
//   (4) checkpoints are sanitized summaries, not verbatim provider turns.
// The safe continuation therefore consumes only the detached foreground
// result. While that promise is outstanding the durable job is not runnable;
// a definitive failure/deadline fails honestly without another provider call.
// A later user-requested recovery must be newly planned, skip checkpointed
// completed operations, and re-enter M1 confirmation for every write.
//
// The error message intentionally matches the pre-M18 plain Error so the
// zero-checkpoint path keeps the route's degraded behavior byte-identical.
// It must NOT look retryable to isRetryableAIProviderError.

export interface ChatToolLoopCheckpointSummary {
  toolName: string;
  sequence: number;
  completedAt: string;
}

export interface ChatDomainTimeoutContinuationRef {
  jobId: string;
  notificationPolicy: 'apns';
}

export class ChatDomainTimeoutError extends Error {
  readonly code = 'CHAT_DOMAIN_TIMEOUT';
  readonly runId: string | null;
  readonly checkpoints: ChatToolLoopCheckpointSummary[];
  readonly continuation: ChatDomainTimeoutContinuationRef | null;
  constructor(
    runId: string | null,
    checkpoints: ChatToolLoopCheckpointSummary[],
    continuation: ChatDomainTimeoutContinuationRef | null = null,
  ) {
    super('Response timeout — AI is taking too long');
    this.name = 'ChatDomainTimeoutError';
    this.runId = runId;
    this.checkpoints = checkpoints;
    this.continuation = continuation;
  }
}

function readToolLoopCheckpointsFailOpen(
  chatRequestId: string | undefined,
  userId: number,
  tenantId: number | undefined,
): ChatToolLoopCheckpointSummary[] {
  if (!chatRequestId || typeof tenantId !== 'number') return [];
  try {
    // Fail open: callers without a database (pure unit contexts) or a store
    // read error must degrade to zero checkpoints, never to a crash.
    const checkpoints = listLegacyToolLoopCheckpoints({ runId: chatRequestId, userId, tenantId });
    return Array.isArray(checkpoints) ? checkpoints : [];
  } catch {
    return [];
  }
}

/**
 * Deterministic, locale-aware partial-progress template (M18). NO model call
 * is ever made here — the continuation budget rule is "resume, never
 * re-plan", and the no-auto-resume verdict means this turn spends zero
 * further tokens. Tool names are de-duplicated and humanized.
 */
export function buildChatTimeoutPartialReplyText(
  locale: string | null | undefined,
  toolNames: string[],
  queuedContinuation = false,
): string {
  const listed = [...new Set(toolNames)]
    .map((name) => name.replace(/_/g, ' ').trim())
    .filter(Boolean)
    .join(', ');
  const normalized = String(locale ?? '').toLowerCase();
  if (normalized.startsWith('pt')) {
    if (queuedContinuation) {
      return `Fiquei sem tempo antes de terminar, mas já concluí parte do trabalho: ${listed}. O pedido em curso continua em segundo plano; aviso-te se concluir ou parar, sem o iniciar novamente. Qualquer alteração posterior continuará a exigir confirmação.`;
    }
    return `Fiquei sem tempo antes de terminar, mas já concluí parte do trabalho: ${listed}. Pede-me para continuar e retomo a partir daí.`;
  }
  if (normalized.startsWith('es')) {
    if (queuedContinuation) {
      return `Me quedé sin tiempo antes de terminar, pero ya completé parte del trabajo: ${listed}. La solicitud en curso sigue en segundo plano; te avisaré si termina o se detiene, sin iniciarla de nuevo. Cualquier cambio posterior seguirá requiriendo confirmación.`;
    }
    return `Me quedé sin tiempo antes de terminar, pero ya completé parte del trabajo: ${listed}. Pídeme continuar y retomo desde ahí.`;
  }
  if (queuedContinuation) {
    return `I ran out of time before finishing, but I already completed part of the work: ${listed}. The in-flight request is still running in the background; I’ll notify you whether it completes or stops, and I will not start it again. Any later change will still require confirmation.`;
  }
  return `I ran out of time before finishing, but I already completed part of the work: ${listed}. Ask me to continue and I'll pick up from there.`;
}

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
  // M18: the turn's chatRequestId keys the tool-loop checkpoints written by
  // the domain handler; the typed timeout carries them out for the honest
  // partial-progress reply. Absent → zero checkpoints (behavior unchanged).
  chatRequestId?: string,
  continuation?: {
    enqueue(checkpoints: ChatToolLoopCheckpointSummary[]): ChatDomainTimeoutContinuationRef | null;
    attachLateResult(
      reference: ChatDomainTimeoutContinuationRef,
      result: ChatDomainExecutionResult,
    ): void;
    attachLateFailure(
      reference: ChatDomainTimeoutContinuationRef,
      error: unknown,
    ): void;
  },
): Promise<ChatDomainExecutionResult> {
  const handlerPromise = handler(message, userId, tenantId);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const checkpoints = readToolLoopCheckpointsFailOpen(chatRequestId, userId, tenantId);
      let continuationRef: ChatDomainTimeoutContinuationRef | null = null;
      if (checkpoints.length > 0 && continuation) {
        try {
          continuationRef = continuation.enqueue(checkpoints);
        } catch {
          // Queue persistence is fail-open: the caller still receives the
          // honest partial-progress response and can ask to continue.
          continuationRef = null;
        }
      }
      if (continuationRef && continuation) {
        void handlerPromise.then(
          (result) => {
            try {
              continuation.attachLateResult(continuationRef as ChatDomainTimeoutContinuationRef, result);
            } catch {
              // The durable deadline still fails honestly without a re-run.
            }
          },
          (error) => {
            try {
              continuation.attachLateFailure(continuationRef as ChatDomainTimeoutContinuationRef, error);
            } catch {
              // The durable deadline still fails honestly without a re-run.
            }
          },
        );
      }
      reject(new ChatDomainTimeoutError(chatRequestId ?? null, checkpoints, continuationRef));
    }, timeoutMs);
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
