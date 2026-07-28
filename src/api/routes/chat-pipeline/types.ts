// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage-pipeline types for POST /api/v1/chat/message.
 *
 * The former ~25-checkpoint monolithic handler is decomposed into an ordered
 * array of ChatStage modules (see ./runner.ts). Each stage mirrors one
 * early-return checkpoint family of the original handler and calls
 * recordChatStage with EXACTLY the same trace names in the same order — the
 * replay corpus (__tests__/api/chat-message-replay.test.ts) pins both the
 * response envelopes (byte parity) and the stage-trace ordering.
 */

import type { Request, Response } from 'express';
import type { ChatImageAttachment } from '../chat-attachments';
import type { ChatLatencyTracker } from '../../../services/chat-answer-contract';
import type { ChatActiveContext } from '../chat-message-context';
import type { ChatSkillRoutingDecision } from '../../../services/chat-skill-orchestrator';
import type { ChatTurnContract } from '../../../services/chat-turn-contract';
import type { safeRecordChatV2DeterministicReadEvidence } from '../../../services/chat-deterministic-read-evidence';
import type { safeRecordChatV2CompletionEvidence } from '../../../services/chat-v2-completion-evidence';
import type { ChatCoreV2LegacyFallbackAttribution } from './support';

export type RecordDeterministicReadEvidenceFn = (
  response: Parameters<typeof safeRecordChatV2DeterministicReadEvidence>[0]['response'],
  tokenZeroSurface?: Parameters<typeof safeRecordChatV2DeterministicReadEvidence>[0]['tokenZeroSurface'],
) => void;

export type RecordCompletionEvidenceFn = (
  response: Parameters<typeof safeRecordChatV2CompletionEvidence>[0]['response'],
) => void;

export type RecordLegacyFallbackSampleFn = (
  fellBack: boolean,
  attribution?: ChatCoreV2LegacyFallbackAttribution,
) => void;

/**
 * Per-turn context threaded through the stage pipeline.
 *
 * Base fields are assembled by the route before the runner is invoked.
 * The optional fields are accumulated by the early context stages
 * (idempotency_claim, turn_context, pre_routing) via `continue` patches;
 * later stages access them through `preparedChatTurnCtx()` which narrows
 * the type after turn_context has run.
 */
export interface ChatTurnCtx {
  req: Request;
  res: Response;
  userId: number;
  tenantId: number;
  normalizedText: string;
  normalizedTextLower: string;
  normalizedAttachments: ChatImageAttachment[];
  scopedClientMessageId: string | null;
  userMessageId: string;
  requestStartedAt: number;
  chatRequestId: string;
  latency: ChatLatencyTracker;
  /** Lazily acquires the per-user AI budget reservation (route-owned). */
  ensureModelBudget: (logMessage: string) => Promise<boolean>;

  // ── Accumulated by idempotency_claim ────────────────────────────
  isNewUserFlow?: boolean;

  // ── Accumulated by turn_context ─────────────────────────────────
  recordDeterministicReadEvidence?: RecordDeterministicReadEvidenceFn;
  recordChatV2CompletionEvidenceForImmediateResponse?: RecordCompletionEvidenceFn;
  bypassReadFastPathsForWriteIntent?: boolean;
  chatCoreV2RouteLocale?: string;
  recordLegacyFallbackSample?: RecordLegacyFallbackSampleFn;
  bypassNaturalLanguageTokenZeroForChatCoreV2?: boolean;

  // ── Accumulated by pre_routing ──────────────────────────────────
  activeContext?: ChatActiveContext | null;
  preRoutingDecision?: ChatSkillRoutingDecision;
  turnContractEnabled?: boolean;
  preTurnContract?: ChatTurnContract | null;
}

/** ChatTurnCtx after turn_context has populated the prepared fields. */
export type PreparedChatTurnCtx = ChatTurnCtx & {
  isNewUserFlow: boolean;
  recordDeterministicReadEvidence: RecordDeterministicReadEvidenceFn;
  recordChatV2CompletionEvidenceForImmediateResponse: RecordCompletionEvidenceFn;
  bypassReadFastPathsForWriteIntent: boolean;
  chatCoreV2RouteLocale: string;
  recordLegacyFallbackSample: RecordLegacyFallbackSampleFn;
  bypassNaturalLanguageTokenZeroForChatCoreV2: boolean;
};

/** PreparedChatTurnCtx after pre_routing has populated routing fields. */
export type RoutedChatTurnCtx = PreparedChatTurnCtx & {
  activeContext: ChatActiveContext | null;
  preRoutingDecision: ChatSkillRoutingDecision;
  turnContractEnabled: boolean;
  preTurnContract: ChatTurnContract | null;
};

/**
 * Narrows a ChatTurnCtx to its prepared form. Stages that run after
 * turn_context in the ordered array may call this at the top of handle();
 * the plain ordered array (no graph, no dynamic registration) makes the
 * ordering guarantee auditable in one file.
 */
export function preparedChatTurnCtx(ctx: ChatTurnCtx): PreparedChatTurnCtx {
  return ctx as PreparedChatTurnCtx;
}

/** Narrows to the post-pre_routing form (legacy tail + research stages). */
export function routedChatTurnCtx(ctx: ChatTurnCtx): RoutedChatTurnCtx {
  return ctx as RoutedChatTurnCtx;
}

export type ChatStageResult =
  | { kind: 'respond' }
  | { kind: 'continue'; patch?: Partial<ChatTurnCtx> };

export interface ChatStage {
  /** Stable stage identity (used by the retirement flag table + tests). */
  name: string;
  /**
   * The recordChatStage trace names this stage can emit, in emission order.
   * Load-bearing for the stage-order snapshot test: the flattened array
   * across the runner's ordered stages must match the stage-trace pins.
   */
  traceStages: readonly string[];
  /** Cheap static gate mirroring the original checkpoint's `if` guard. */
  canHandle(ctx: ChatTurnCtx): boolean | Promise<boolean>;
  /**
   * Runs the checkpoint. `respond` means the stage wrote the HTTP response
   * (exactly like the original early return); `continue` proceeds to the
   * next stage, optionally patching accumulated context fields.
   */
  handle(ctx: ChatTurnCtx): Promise<ChatStageResult>;
}
