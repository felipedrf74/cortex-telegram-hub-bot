// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10 stage-pipeline runner for POST /api/v1/chat/message.
 *
 * A PLAIN ORDERED ARRAY mirroring the original handler's checkpoint
 * sequence exactly — no graph, no dynamic registration (repo rule). The
 * replay corpus pins both response envelopes (byte parity) and the
 * stage-trace ordering, and the stage-order snapshot test pins this
 * array's names + trace emissions.
 *
 * Retirement flags (M20 seam): the runner supports an env-driven per-stage
 * disable check, DEFAULT ENABLED for every stage. M20's retirement campaign
 * will later flip legacy stages off per-route; nothing is flipped here.
 * Structural/safety stages can never be disabled (see
 * NON_RETIRABLE_CHAT_STAGES).
 */

import type { ChatStage, ChatTurnCtx } from './types';
import { idempotentReplayStage } from './stages/idempotent-replay';
import { idempotencyClaimStage } from './stages/idempotency-claim';
import { turnContextStage } from './stages/turn-context';
import { routingSyntheticQaStage } from './stages/routing-synthetic-qa';
import { tokenZeroShortcutStage } from './stages/token-zero-shortcut';
import { createChatCoreV2DeterministicReadStage } from './stages/deterministic-read';
import { shadowRouteStage } from './stages/shadow-route';
import { completionEvidenceStage } from './stages/completion-evidence';
import { pendingWorkCancelStage } from './stages/pending-work-cancel';
import { actionGatewayStage } from './stages/action-gateway';
import { cachedCommandStage } from './stages/cached-command';
import { createActionPlannerStage } from './stages/action-planner';
import { attachmentStage } from './stages/attachment';
import { authenticatedIdentityStage } from './stages/authenticated-identity';
import { fastPathStage } from './stages/fast-path';
import { trainingPlanShortcutStage } from './stages/training-plan-shortcut';
import { preRoutingStage } from './stages/pre-routing';
import { internetResearchStage } from './stages/internet-research';
import { decisionShortcutStage } from './stages/decision-shortcut';
import { destructiveConfirmationHoldStage } from './stages/destructive-confirmation-hold';
import { routingClarifyStage } from './stages/routing-clarify';
import { crossSkillPlanDeclinedStage } from './stages/cross-skill-plan-declined';
import { v2LocalAnswerStage } from './stages/v2-local-answer';
import { unsupportedFallbackStage } from './stages/unsupported-fallback';
import { legacyTailStage } from './stages/legacy-tail';

/**
 * The ordered /message stage sequence. ORDER IS LAW: it mirrors the original
 * monolithic handler's early-return checkpoints one-for-one.
 */
export const CHAT_MESSAGE_STAGES: readonly ChatStage[] = [
  idempotentReplayStage,
  idempotencyClaimStage,
  turnContextStage,
  routingSyntheticQaStage,
  tokenZeroShortcutStage,
  createChatCoreV2DeterministicReadStage('early'),
  shadowRouteStage,
  completionEvidenceStage,
  pendingWorkCancelStage,
  actionGatewayStage,
  createChatCoreV2DeterministicReadStage('gated'),
  cachedCommandStage,
  createActionPlannerStage('deterministic'),
  attachmentStage,
  authenticatedIdentityStage,
  fastPathStage,
  trainingPlanShortcutStage,
  createActionPlannerStage('model'),
  preRoutingStage,
  internetResearchStage,
  decisionShortcutStage,
  destructiveConfirmationHoldStage,
  // M14: deterministic clarify terminal — after the safety hold (which
  // outranks a routing question), before any model-backed owner.
  routingClarifyStage,
  // M19: both planner passes have declined. With cross-skill execution on,
  // stop actionable multi-owner turns deterministically instead of reviving
  // the single-owner legacy prompt bridge.
  crossSkillPlanDeclinedStage,
  v2LocalAnswerStage,
  unsupportedFallbackStage,
  legacyTailStage,
];

/**
 * Stages that must never be disabled: request identity/idempotency,
 * per-turn context assembly, evidence instrumentation, safety cancels, the
 * write firewall, the destructive-confirmation hold, the only attachment
 * owner, and the final terminal.
 */
export const NON_RETIRABLE_CHAT_STAGES: ReadonlySet<string> = new Set([
  'idempotent_replay',
  'idempotency_claim',
  'turn_context',
  'routing_synthetic_qa',
  'completion_evidence_recorder',
  'pending_work_cancel',
  'action_gateway',
  'pre_routing',
  'destructive_confirmation_hold',
  'cross_skill_plan_declined',
  'attachment',
  'legacy_tail',
]);

/**
 * Env-driven retirement table: CHAT_PIPELINE_DISABLED_STAGES is a
 * comma-separated list of stage names. Every stage defaults to ENABLED; only
 * retirable stages honor the flag. Read live per turn so M20's campaign can
 * flip stages without a restart.
 */
export function isChatPipelineStageDisabled(
  stageName: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (NON_RETIRABLE_CHAT_STAGES.has(stageName)) return false;
  const raw = env.CHAT_PIPELINE_DISABLED_STAGES;
  if (!raw || typeof raw !== 'string') return false;
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .includes(stageName);
}

/**
 * Runs the ordered stage array against the turn context. Returns the name of
 * the stage that responded (for logging/tests), or null if no stage did —
 * which cannot happen in practice because legacy_tail always responds.
 */
export async function runChatMessagePipeline(
  ctx: ChatTurnCtx,
  stages: readonly ChatStage[] = CHAT_MESSAGE_STAGES,
): Promise<string | null> {
  for (const stage of stages) {
    if (isChatPipelineStageDisabled(stage.name)) continue;
    if (!await stage.canHandle(ctx)) continue;
    const result = await stage.handle(ctx);
    if (result.kind === 'respond') return stage.name;
    if (result.patch) Object.assign(ctx, result.patch);
  }
  return null;
}
