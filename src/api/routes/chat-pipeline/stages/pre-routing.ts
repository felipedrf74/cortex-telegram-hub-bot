// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage: pre-routing orchestration context — active conversation
 * context, skill-orchestration decision, and (flag-gated) turn contract.
 * Never responds. Verbatim move of the block that preceded the internet
 * research / decision shortcut / destructive-hold checkpoints.
 */

import { resolveChatActiveContext } from '../../chat-message-context';
import { analyzeChatSkillOrchestration } from '../../../../services/chat-skill-orchestrator';
import { inferChatTurnContract } from '../../../../services/chat-turn-contract';
import { isChatTurnContractEnabled } from '../../../../services/runtime-flags';
import { preparedChatTurnCtx, type ChatStage, type ChatStageResult, type ChatTurnCtx } from '../types';
import { getDb } from '../../../../services/database';

export const preRoutingStage: ChatStage = {
  name: 'pre_routing',
  traceStages: [],
  canHandle(): boolean {
    return true;
  },
  async handle(ctx: ChatTurnCtx): Promise<ChatStageResult> {
    const { userId, tenantId, normalizedText, chatCoreV2RouteLocale } = preparedChatTurnCtx(ctx);

    const activeContext = resolveChatActiveContext(userId, Date.now(), tenantId);
    // M14: this is THE deciding call for the deterministic routing_clarify
    // terminal — it carries the continuity context (loop prevention), the
    // pipeline locale (template rendering), and the one-per-turn telemetry
    // opt-in. No other analyzeChatSkillOrchestration call site counts.
    const preRoutingDecision = analyzeChatSkillOrchestration({
      message: normalizedText,
      activeContext,
      userId,
      tenantId,
      locale: chatCoreV2RouteLocale,
      countClarifyTelemetry: true,
      clarifyTelemetryDb: getDb(),
    });
    const turnContractEnabled = isChatTurnContractEnabled(process.env, { userId, tenantId });
    const preTurnContract = turnContractEnabled
      ? inferChatTurnContract({
        message: normalizedText,
        activeContextDomain: activeContext?.domain ?? null,
        involvedSkills: preRoutingDecision.involvedSkills,
      })
      : null;

    return {
      kind: 'continue',
      patch: { activeContext, preRoutingDecision, turnContractEnabled, preTurnContract },
    };
  },
};
