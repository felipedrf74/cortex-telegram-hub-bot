// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Staging-only synthetic routing QA terminal.
 *
 * Ordered immediately after turn_context and before every shortcut/model/tool
 * owner. It records exactly one ordinary shadow-route bundle with the validated
 * provenance block, then returns a fixed response. A recorder failure is a
 * terminal 503; it never falls through to a provider or domain path.
 */

import {
  normalizeChatCoreV2TemplateLocale,
  runChatCoreV2ShadowRouteHook,
} from '../../../../services/chat-core-v2';
import { recordChatStage } from '../../../../services/chat-stage-trace';
import { getUserTimezoneById } from '../../../../services/user-service';
import { logger } from '../../../../utils/logger';
import { finalizeChatMessageResponse } from '../../chat-message-finalizer';
import type { ChatStage, ChatStageResult, ChatTurnCtx } from '../types';

const ROUTING_SYNTHETIC_QA_RESPONSE_TEXT =
  'Synthetic staging routing QA evidence was recorded. No provider, external integration, or domain action was run.';

export const routingSyntheticQaStage: ChatStage = {
  name: 'routing_synthetic_qa',
  traceStages: ['routing_synthetic_qa'],
  canHandle(ctx: ChatTurnCtx): boolean {
    return Boolean(ctx.routingSyntheticQa);
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const provenance = ctx.routingSyntheticQa!;
    const {
      res, userId, tenantId, normalizedText, normalizedAttachments,
      scopedClientMessageId, userMessageId, requestStartedAt, chatRequestId,
      latency, chatCoreV2RouteLocale,
    } = ctx;

    if (
      normalizedAttachments.length !== 0
      || chatCoreV2RouteLocale !== normalizeChatCoreV2TemplateLocale(provenance.locale)
    ) {
      res.status(400).json({
        error: {
          code: 'ROUTING_SYNTHETIC_QA_INVALID',
          message: 'Synthetic routing QA locale or attachment scope does not match the validated request.',
        },
      });
      return { kind: 'respond' };
    }

    const shadow = runChatCoreV2ShadowRouteHook({
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      userMessageId,
      clientMessageId: scopedClientMessageId,
      attachmentsCount: normalizedAttachments.length,
      locale: chatCoreV2RouteLocale,
      timezone: getUserTimezoneById(userId),
      now: new Date(requestStartedAt),
      trafficProvenance: provenance,
    });

    if (!shadow.recorded || !shadow.replayBundleId || shadow.trafficProvenanceRecorded !== true) {
      logger.warn(
        { chatRequestId, userId, tenantId, errorCode: shadow.errorCode ?? 'missing_replay_bundle' },
        'Synthetic routing QA shadow evidence failed closed',
      );
      res.status(503).json({
        error: {
          code: 'ROUTING_SYNTHETIC_QA_RECORDING_FAILED',
          message: 'Synthetic routing QA evidence could not be recorded. No provider or domain action was run.',
        },
      });
      return { kind: 'respond' };
    }

    recordChatStage(chatRequestId, 'routing_synthetic_qa');
    const response = finalizeChatMessageResponse({
      id: `msg-routing-synthetic-qa-${provenance.surface}-${String(provenance.ordinal).padStart(3, '0')}`,
      text: ROUTING_SYNTHETIC_QA_RESPONSE_TEXT,
      domain: 'secretary',
      routeMethod: 'routing-synthetic-qa',
      confidence: 1,
      buttons: null,
      metadata: {
        type: 'routing_synthetic_qa_recorded',
        providerCalled: false,
        externalCallPerformed: false,
        domainMutationPerformed: false,
        replayBundleId: shadow.replayBundleId,
        trafficProvenance: provenance,
      },
      timestamp: new Date(requestStartedAt).toISOString(),
    }, {
      normalizedText,
      userId,
      tenantId,
      chatRequestId,
      tracker: latency,
      latencyTier: 'tier1_fast_read',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      compositionMode: 'templated',
      stageFamily: 'routing_synthetic_qa',
      requestStartedAt,
      locale: chatCoreV2RouteLocale,
    });
    logger.info(
      {
        chatRequestId,
        userId,
        tenantId,
        surface: provenance.surface,
        ordinal: provenance.ordinal,
        replayBundleId: shadow.replayBundleId,
      },
      'Synthetic routing QA turn recorded without provider or domain execution',
    );
    res.json(response);
    return { kind: 'respond' };
  },
};
