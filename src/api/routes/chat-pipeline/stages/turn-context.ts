// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: per-turn prepared context (evidence closures, ChatCoreV2 route
 * locale, read-fast-path bypass flags, legacy-fallback sampler). Verbatim
 * move of the helper-closure block that sat between request_validated and
 * the token-zero shortcut; computation ORDER is preserved exactly
 * (shouldGateReadFastPathsForWriteIntent before locale resolution before
 * the natural-language token-zero bypass probe).
 */

import {
  shouldGateReadFastPathsForWriteIntent,
} from '../../../../services/chat-core-v2';
import { safeRecordChatV2CompletionEvidence } from '../../../../services/chat-v2-completion-evidence';
import { safeRecordChatV2DeterministicReadEvidence } from '../../../../services/chat-deterministic-read-evidence';
import {
  isChatV2UnsupportedClaimEvidenceProbe,
  recordChatCoreV2LegacyFallbackSample,
  resolveChatCoreV2RouteLocale,
  safeGetChatEvidenceLanguage,
  safeGetChatV2ClientFirstProgressMs,
  shouldBypassNaturalLanguageTokenZeroForChatCoreV2,
  type ChatCoreV2LegacyFallbackAttribution,
} from '../support';
import type { ChatStage, ChatStageResult, ChatTurnCtx } from '../types';

export const turnContextStage: ChatStage = {
  name: 'turn_context',
  traceStages: [],
  canHandle(): boolean {
    return true;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const {
      req, userId, tenantId, normalizedText, normalizedAttachments,
      requestStartedAt, chatRequestId,
    } = ctx;

    const recordDeterministicReadEvidence = (
      response: Parameters<typeof safeRecordChatV2DeterministicReadEvidence>[0]['response'],
      tokenZeroSurface?: Parameters<typeof safeRecordChatV2DeterministicReadEvidence>[0]['tokenZeroSurface'],
    ) => {
      safeRecordChatV2DeterministicReadEvidence({
        tenantId,
        userId,
        requestId: chatRequestId,
        normalizedMessage: normalizedText,
        response,
        tokenZeroSurface,
        tokenZeroPreserved: tokenZeroSurface ? true : undefined,
        tenantUserIsolationPassed: true,
      });
    };
    const recordChatV2CompletionEvidenceForImmediateResponse = (
      response: Parameters<typeof safeRecordChatV2CompletionEvidence>[0]['response'],
    ) => {
      safeRecordChatV2CompletionEvidence({
        tenantId,
        userId,
        requestId: chatRequestId,
        normalizedMessage: normalizedText,
        userLanguage: safeGetChatEvidenceLanguage(req, userId, chatCoreV2RouteLocale),
        responseLocale: chatCoreV2RouteLocale,
        response,
        firstProgressMs: safeGetChatV2ClientFirstProgressMs(req) ?? Date.now() - requestStartedAt,
        unsupportedClaimProbe: isChatV2UnsupportedClaimEvidenceProbe(req),
      });
    };
    const bypassReadFastPathsForWriteIntent = normalizedText && normalizedAttachments.length === 0
      ? shouldGateReadFastPathsForWriteIntent(normalizedText, process.env, String(tenantId))
      : false;
    const chatCoreV2RouteLocale = resolveChatCoreV2RouteLocale(req, userId, normalizedText);
    const recordLegacyFallbackSample = (
      fellBack: boolean,
      attribution?: ChatCoreV2LegacyFallbackAttribution,
    ) => recordChatCoreV2LegacyFallbackSample({
      tenantId,
      normalizedText,
      hasAttachments: normalizedAttachments.length > 0,
      fellBack,
      now: new Date(requestStartedAt),
      attribution,
    });
    const bypassNaturalLanguageTokenZeroForChatCoreV2 = normalizedText
      ? shouldBypassNaturalLanguageTokenZeroForChatCoreV2(tenantId, normalizedText)
      : false;

    return {
      kind: 'continue',
      patch: {
        recordDeterministicReadEvidence,
        recordChatV2CompletionEvidenceForImmediateResponse,
        bypassReadFastPathsForWriteIntent,
        chatCoreV2RouteLocale,
        recordLegacyFallbackSample,
        bypassNaturalLanguageTokenZeroForChatCoreV2,
      },
    };
  },
};
