// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: installs the res.json wrapper that records ChatV2 completion
 * evidence for every response written from this point onward. Verbatim move
 * — placement in the ordered array is load-bearing (families that respond
 * BEFORE this stage record completion evidence explicitly or not at all,
 * exactly like the original handler).
 */

import type { Response } from 'express';
import { safeRecordChatV2CompletionEvidence } from '../../../../services/chat-v2-completion-evidence';
import {
  isChatV2UnsupportedClaimEvidenceProbe,
  safeGetChatEvidenceLanguage,
  safeGetChatV2ClientFirstProgressMs,
} from '../support';
import type { ChatStage, ChatStageResult, ChatTurnCtx } from '../types';

export const completionEvidenceStage: ChatStage = {
  name: 'completion_evidence_recorder',
  traceStages: [],
  canHandle(): boolean {
    return true;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const { req, res, userId, tenantId, normalizedText, requestStartedAt, chatRequestId } = ctx;
    const originalJson = res.json.bind(res);
    res.json = ((body?: any) => {
      safeRecordChatV2CompletionEvidence({
        tenantId,
        userId,
        requestId: chatRequestId,
        normalizedMessage: normalizedText,
        userLanguage: safeGetChatEvidenceLanguage(req, userId),
        response: body,
        firstProgressMs: safeGetChatV2ClientFirstProgressMs(req) ?? Date.now() - requestStartedAt,
        unsupportedClaimProbe: isChatV2UnsupportedClaimEvidenceProbe(req),
      });
      return originalJson(body);
    }) as Response['json'];
    return { kind: 'continue' };
  },
};
