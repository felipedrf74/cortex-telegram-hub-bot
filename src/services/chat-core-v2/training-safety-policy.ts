// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { HumanReviewReason } from './types';

export const CHAT_CORE_V2_TRAINING_SAFETY_POLICY_VERSION = 'chat_core_v2_training_safety_policy@1.0.0';

export type TrainingSafetyOperation = 'read' | 'preview' | 'execute';

export type TrainingChangeType =
  | 'explain_session'
  | 'move_session'
  | 'reduce_intensity'
  | 'increase_intensity'
  | 'replace_exercise'
  | 'delete_exercise'
  | 'reflow_week'
  | 'create_plan'
  | 'adjust_plan_from_feedback';

export type TrainingSafetyDecision =
  | 'allowed'
  | 'needs_clarification'
  | 'requires_human_review'
  | 'blocked';

export type TrainingSafetyReason =
  | 'read_only_allowed'
  | 'safe_preview_allowed'
  | 'execution_not_enabled'
  | 'missing_change_type'
  | 'missing_target_session'
  | 'injury_conflict'
  | 'equipment_unavailable'
  | 'rest_window_violation'
  | 'rest_day_violation'
  | 'volume_spike_requires_review'
  | 'intensity_increase_requires_review'
  | 'multi_session_change_requires_review'
  | 'goal_change_requires_review';

export interface TrainingSafetyPolicyInput {
  operation: TrainingSafetyOperation;
  changeTypes: TrainingChangeType[];
  affectedSessionCount: number;
  targetSessionIds?: string[];
  increasesIntensity?: boolean;
  increasesVolumePercent?: number;
  removesRestDay?: boolean;
  minRestHoursBefore?: number;
  minRestHoursAfter?: number;
  conflictsWithInjury?: boolean;
  injuryConflictLabels?: string[];
  requiresUnavailableEquipment?: boolean;
  unavailableEquipmentLabels?: string[];
  affectsPlanGoal?: boolean;
  userConfirmedGoalChange?: boolean;
}

export interface TrainingSafetyPolicyVerdict {
  ok: boolean;
  decision: TrainingSafetyDecision;
  policyVersion: string;
  maxAllowedOperation: 'read' | 'preview';
  reasons: TrainingSafetyReason[];
  humanReviewReason?: HumanReviewReason;
  blockedLabels?: string[];
}

export function evaluateChatCoreV2TrainingSafetyPolicy(
  input: TrainingSafetyPolicyInput,
): TrainingSafetyPolicyVerdict {
  if (input.operation === 'read') {
    return verdict('allowed', ['read_only_allowed']);
  }

  if (input.operation === 'execute') {
    return verdict('blocked', ['execution_not_enabled']);
  }

  const clarificationReasons = needsClarification(input);
  if (clarificationReasons.length > 0) {
    return verdict('needs_clarification', clarificationReasons);
  }

  const blocked = blockingReasons(input);
  if (blocked.reasons.length > 0) {
    return verdict('blocked', blocked.reasons, undefined, blocked.labels);
  }

  const reviewReasons = humanReviewReasons(input);
  if (reviewReasons.length > 0) {
    return verdict('requires_human_review', reviewReasons, humanReviewReasonFor(reviewReasons));
  }

  return verdict('allowed', ['safe_preview_allowed']);
}

function needsClarification(input: TrainingSafetyPolicyInput): TrainingSafetyReason[] {
  const reasons: TrainingSafetyReason[] = [];
  if (input.changeTypes.length === 0) reasons.push('missing_change_type');
  if (input.affectedSessionCount <= 0 || (input.targetSessionIds && input.targetSessionIds.length === 0)) {
    reasons.push('missing_target_session');
  }
  return reasons;
}

function blockingReasons(input: TrainingSafetyPolicyInput): {
  reasons: TrainingSafetyReason[];
  labels: string[];
} {
  const reasons: TrainingSafetyReason[] = [];
  const labels: string[] = [];

  if (input.conflictsWithInjury) {
    reasons.push('injury_conflict');
    labels.push(...(input.injuryConflictLabels ?? []));
  }
  if (input.requiresUnavailableEquipment) {
    reasons.push('equipment_unavailable');
    labels.push(...(input.unavailableEquipmentLabels ?? []));
  }
  if (input.removesRestDay) {
    reasons.push('rest_day_violation');
  }
  if (restHoursTooLow(input.minRestHoursBefore) || restHoursTooLow(input.minRestHoursAfter)) {
    reasons.push('rest_window_violation');
  }

  return { reasons, labels };
}

function humanReviewReasons(input: TrainingSafetyPolicyInput): TrainingSafetyReason[] {
  const reasons: TrainingSafetyReason[] = [];
  const multiSessionChange = input.affectedSessionCount > 1
    || input.changeTypes.includes('reflow_week')
    || input.changeTypes.includes('create_plan');

  if (multiSessionChange) {
    reasons.push('multi_session_change_requires_review');
  }
  if (input.affectsPlanGoal && !input.userConfirmedGoalChange) {
    reasons.push('goal_change_requires_review');
  }
  if (input.increasesIntensity || input.changeTypes.includes('increase_intensity')) {
    reasons.push('intensity_increase_requires_review');
  }
  if ((input.increasesVolumePercent ?? 0) > 10) {
    reasons.push('volume_spike_requires_review');
  }

  return reasons;
}

function restHoursTooLow(hours: number | undefined): boolean {
  return hours !== undefined && hours < 20;
}

function humanReviewReasonFor(reasons: TrainingSafetyReason[]): HumanReviewReason {
  if (reasons.includes('multi_session_change_requires_review')) return 'training_plan_rewrite';
  return 'policy_uncertainty';
}

function verdict(
  decision: TrainingSafetyDecision,
  reasons: TrainingSafetyReason[],
  humanReviewReason?: HumanReviewReason,
  blockedLabels?: string[],
): TrainingSafetyPolicyVerdict {
  return {
    ok: decision === 'allowed',
    decision,
    policyVersion: CHAT_CORE_V2_TRAINING_SAFETY_POLICY_VERSION,
    maxAllowedOperation: decision === 'allowed' && reasons.includes('read_only_allowed') ? 'read' : 'preview',
    reasons,
    humanReviewReason,
    blockedLabels: blockedLabels && blockedLabels.length > 0 ? blockedLabels : undefined,
  };
}
