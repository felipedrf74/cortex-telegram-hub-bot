// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  recordChatActionTelemetry,
  type ChatActionRiskClass,
  type ChatActionTelemetry,
} from '../../chat-action-state';
import { riskClassForRisk } from '../registry';
import type {
  ChatActionPlan,
  ChatActionStatus,
  ChatPlannerInput,
  ChatPlanStep,
} from '../types';
import { logger } from '../../../utils/logger';

export function recordShadowTelemetry(plan: ChatActionPlan, input: ChatPlannerInput, routeStartedAtMs: number): void {
  if (input.persistRuns === false) return;
  const firstStep = plan.steps[0];
  try {
    recordChatActionTelemetry({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      planner: plan.planner,
      status: 'shadow_only',
      skill: firstStep?.skill ?? null,
      action: firstStep?.action ?? null,
      telemetry: {
        ...(plan.telemetry ?? {
          routeTier: 'tier0_deterministic',
          candidates: firstStep ? [{ skill: firstStep.skill, action: firstStep.action, score: plan.effectiveConfidence ?? plan.confidence }] : [],
          calibratedScore: plan.effectiveConfidence ?? plan.confidence,
          threshold: thresholdForSteps(plan.steps),
        }),
        latencyMs: Date.now() - routeStartedAtMs,
        outcome: 'shadow_only',
        predictedActionHash: firstStep?.idempotencyKey,
        slotProvenanceSummary: summarizeSlotProvenance(plan),
      },
      nowIso: input.nowIso,
    });
  } catch (err) {
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'chat action shadow telemetry skipped');
  }
}

export function safeTelemetry(telemetry: ChatActionTelemetry): Record<string, unknown> {
  return {
    routeTier: telemetry.routeTier,
    candidates: telemetry.candidates.slice(0, 4),
    calibratedScore: telemetry.calibratedScore,
    threshold: telemetry.threshold,
    modelProvider: telemetry.modelProvider,
    model: telemetry.model,
    estimatedTokenCostUsd: telemetry.estimatedTokenCostUsd,
    verifierStatus: telemetry.verifierStatus,
    latencyMs: telemetry.latencyMs,
    outcome: telemetry.outcome,
    failureReason: telemetry.failureReason,
    slotProvenanceSummary: telemetry.slotProvenanceSummary,
  };
}

export function finalizeTelemetryForResponse(
  plan: ChatActionPlan,
  status: ChatActionStatus,
  metadata: Record<string, unknown>,
  input: ChatPlannerInput,
): ChatActionTelemetry {
  const base = plan.telemetry ?? {
    routeTier: 'tier0_deterministic' as const,
    candidates: plan.steps.map((step) => ({
      skill: step.skill,
      action: step.action,
      score: plan.effectiveConfidence ?? plan.confidence,
    })),
    calibratedScore: plan.effectiveConfidence ?? plan.confidence,
    threshold: thresholdForSteps(plan.steps),
  };
  return {
    ...base,
    verifierStatus: verifierStatusForActionStatus(status, plan),
    latencyMs: input.routeStartedAtMs ? Math.max(0, Date.now() - input.routeStartedAtMs) : base.latencyMs,
    outcome: status,
    failureReason: failureReasonForTelemetry(status, metadata) ?? base.failureReason,
    slotProvenanceSummary: summarizeSlotProvenance(plan),
  };
}

export function summarizeSlotProvenance(plan: ChatActionPlan): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const step of plan.steps) {
    if (!step.slotProvenance) continue;
    const stepSummary: Record<string, unknown> = {};
    for (const [slot, provenance] of Object.entries(step.slotProvenance)) {
      stepSummary[slot] = {
        sourceType: provenance.sourceType,
        normalizer: provenance.normalizer,
        confidence: provenance.confidence,
        validation: provenance.validation,
      };
    }
    if (Object.keys(stepSummary).length > 0) {
      summary[`${step.skill}.${step.action}.${step.stepId}`] = stepSummary;
    }
  }
  return summary;
}

export function thresholdForSteps(steps: ChatPlanStep[]): number {
  const riskiest = steps.reduce<ChatActionRiskClass>((current, step) => {
    const candidate = step.riskClass ?? riskClassForRisk(step.risk);
    return riskRank(candidate) > riskRank(current) ? candidate : current;
  }, 'R0');
  if (riskiest === 'R3') return 0.98;
  if (riskiest === 'R2') return 0.96;
  if (riskiest === 'R1') return 0.9;
  if (riskiest === 'R4') return 1;
  return 0.75;
}

function verifierStatusForActionStatus(status: ChatActionStatus, plan: ChatActionPlan): ChatActionTelemetry['verifierStatus'] {
  const requiresVerification = plan.steps.some((step) => step.verification.required);
  if (!requiresVerification) return 'not_required';
  if (status === 'verified_success') return 'verified';
  if (status === 'verified_pending' || status === 'needs_confirmation' || status === 'needs_clarification' || status === 'planned' || status === 'executing' || status === 'verifying') return 'pending';
  if (status === 'partial_success') return 'mismatch';
  return 'failed';
}

function failureReasonForTelemetry(status: ChatActionStatus, metadata: Record<string, unknown>): string | undefined {
  if (status === 'verified_success' || status === 'verified_pending' || status === 'needs_confirmation' || status === 'needs_clarification') return undefined;
  const actionResults = metadata.actionResults;
  if (Array.isArray(actionResults)) {
    const firstError = actionResults
      .map((result) => result && typeof result === 'object' ? (result as Record<string, unknown>).error : null)
      .find((error): error is string => typeof error === 'string' && error.length > 0);
    if (firstError) return firstError.slice(0, 120);
  }
  const error = metadata.error;
  if (typeof error === 'string') return error.slice(0, 120);
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code.slice(0, 120);
  }
  const reason = metadata.reason;
  if (typeof reason === 'string') return reason.slice(0, 120);
  return status;
}

function riskRank(risk: ChatActionRiskClass): number {
  return { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 }[risk];
}
