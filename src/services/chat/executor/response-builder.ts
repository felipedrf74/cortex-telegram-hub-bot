// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';

import { recordChatActionTelemetry } from '../../chat-action-state';
import { buildBlocksFromMarkdown } from '../../chat-response-blocks';
import { buildMultiStepSummary } from '../../chat-multi-step-dag';
import { buildResponseLanguageTelemetry } from '../../chat-language-detector';
import { logger } from '../../../utils/logger';
import type {
  ChatActionPlan,
  ChatActionRouteResponse,
  ChatActionStatus,
  ChatPlannerInput,
  ChatStepExecutionResult,
} from '../types';
import {
  buildResponseCardsFromMetadata,
  domainForPlan,
} from './response-cards';
import {
  finalizeTelemetryForResponse,
  safeTelemetry,
} from './telemetry';

export function multiStepType(plan: ChatActionPlan, fallback: string): string {
  return plan.steps.length > 1 ? 'chat_action_multi_step_result' : fallback;
}

export function multiStepMetadata(plan: ChatActionPlan, results: ChatStepExecutionResult[]): Record<string, unknown> {
  if (plan.steps.length <= 1) return {};
  return { multiStepSummary: buildMultiStepSummary(plan, results) };
}

export function buildActionResponse(
  input: ChatPlannerInput,
  plan: ChatActionPlan,
  status: ChatActionStatus,
  text: string,
  metadata: Record<string, unknown>,
): ChatActionRouteResponse {
  const responseTelemetry = finalizeTelemetryForResponse(plan, status, metadata, input);
  if (input.persistRuns !== false) {
    const firstStep = plan.steps[0];
    try {
      recordChatActionTelemetry({
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        planner: plan.planner,
        status,
        skill: firstStep?.skill ?? null,
        action: firstStep?.action ?? null,
        telemetry: responseTelemetry,
        nowIso: input.nowIso,
      });
    } catch (err) {
      logger.debug({
        err,
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        messageId: input.messageId,
      }, 'chat action telemetry record skipped');
    }
  }

  // Phase 16 batch 84 (2026-05-17): emit responseBlocks alongside `text`.
  // Builds typed blocks from the producer's existing markdown/prose so
  // iOS can render natively instead of falling back to MarkdownRenderer
  // (the bleed-asterisk path). The legacy `text` field stays for older
  // iOS builds + Telegram/WhatsApp adapters during the rollout window.
  // Phase 16 batch 86 (2026-05-17): emit responseCards for the three
  // currently-typed card kinds (refusal, clarification, confirmation)
  // when the metadata indicates them. Card payloads come from the
  // existing metadata fields — no new server-side state.
  const responseBlocks = buildBlocksFromMarkdown(text);
  const responseCards = buildResponseCardsFromMetadata(metadata);

  return {
    id: `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
    text,
    domain: domainForPlan(plan),
    routeMethod: `chat-action-${plan.planner}`,
    confidence: plan.confidence,
    buttons: null,
    metadata: {
      ...metadata,
      schemaVersion: 1,
      // Phase 16 batch 80 (2026-05-16): callers may provide a more specific
      // actionStatus (e.g. 'refused') that should NOT be overwritten by the
      // persisted ChatActionStatus (e.g. 'blocked'). Honor caller-provided
      // metadata.actionStatus when present; fall back to the persisted status
      // otherwise. The persisted status keeps DB schema compatibility.
      actionStatus: (typeof metadata.actionStatus === 'string' && metadata.actionStatus.length > 0) ? metadata.actionStatus : status,
      actionPlanner: plan.planner,
      effectiveConfidence: plan.effectiveConfidence ?? plan.confidence,
      telemetry: safeTelemetry(responseTelemetry),
      involvedSkills: plan.involvedSkills?.length
        ? [...new Set(plan.involvedSkills)]
        : [...new Set(plan.steps.map((step) => step.skill))],
      responseLanguage: buildResponseLanguageTelemetry(input.locale, text),
      // Developer trace is persisted server-side through action runs/logs; normal UI gets only this safe summary.
    },
    timestamp: new Date().toISOString(),
    responseBlocks,
    responseCards,
  };
}
