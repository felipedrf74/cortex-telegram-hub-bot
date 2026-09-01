// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NotificationPriority } from '../notification-orchestrator';

/** Priority tier — deliberately separate from confidence. */
export type DecisionPriorityTier = 'critical' | 'high' | 'normal' | 'low';

/** Multi-signal priority persisted in immutable list rank snapshots. */
export interface DecisionPrioritySnapshot {
  priorityTier: DecisionPriorityTier;
  priorityScore: number;
  reasonCodes: string[];
  computedAt: string;
  rankingVersion: number;
}

export interface DecisionRankingInputs {
  priority: NotificationPriority;
  sourceSkill: string;
  type: string;
  status: string;
  deadlineSoon: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  actionCount: number;
  dependencyBlocked: boolean;
}

export const DECISION_RANKING_VERSION = 1;

/**
 * Versioned baseline extracted from the original ranker. Changing these
 * values requires representative evidence and a ranking-version bump.
 */
export const DECISION_RANKING_POLICY = Object.freeze({
  policyVersion: 'decision_ranking.v1',
  weights: Object.freeze({ urgency: 0.35, impact: 0.25, costOfDelay: 0.2, domainPriority: 0.2 }),
  effortPenaltyMax: 0.15,
  snoozePenalty: 0.25,
  blockedPenalty: 0.2,
  tierThresholds: Object.freeze({ critical: 80, high: 60, normal: 35 }),
  domainPriorityWeights: Object.freeze({
    security: 1,
    finance: 0.9,
    secretary: 0.7,
    training: 0.7,
    chat: 0.6,
    content: 0.5,
    cooking: 0.4,
  } as Record<string, number>),
});

const PRIORITY_TIER_ORDER: readonly DecisionPriorityTier[] = ['low', 'normal', 'high', 'critical'];

/** Pure multi-signal priority calculation with raise-only safety floors. */
export function rankDecisionPriority(
  input: DecisionRankingInputs,
  now: Date = new Date(),
): DecisionPrioritySnapshot {
  const reasonCodes: string[] = [];
  const urgency = input.priority === 'critical'
    ? 1
    : input.priority === 'time_sensitive'
      ? 0.85
      : input.priority === 'active' ? 0.55 : 0.25;
  const impact = input.riskLevel === 'high' ? 1 : input.riskLevel === 'medium' ? 0.6 : 0.3;
  const costOfDelay = input.deadlineSoon ? 0.9 : 0.3;
  const domainPriority = DECISION_RANKING_POLICY.domainPriorityWeights[input.sourceSkill] ?? 0.5;
  const effortPenalty = (Math.min(Math.max(input.actionCount, 0), 4) / 4)
    * DECISION_RANKING_POLICY.effortPenaltyMax;
  const snoozePenalty = input.status === 'snoozed' ? DECISION_RANKING_POLICY.snoozePenalty : 0;
  const blockedPenalty = input.dependencyBlocked ? DECISION_RANKING_POLICY.blockedPenalty : 0;

  const raw = (DECISION_RANKING_POLICY.weights.urgency * urgency)
    + (DECISION_RANKING_POLICY.weights.impact * impact)
    + (DECISION_RANKING_POLICY.weights.costOfDelay * costOfDelay)
    + (DECISION_RANKING_POLICY.weights.domainPriority * domainPriority)
    - effortPenalty - snoozePenalty - blockedPenalty;
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 100);

  if (urgency >= 0.85) reasonCodes.push('high_urgency');
  if (impact >= 1) reasonCodes.push('high_impact');
  if (input.deadlineSoon) reasonCodes.push('deadline_soon');
  if (input.dependencyBlocked) reasonCodes.push('blocked_by_dependency');
  if (input.status === 'snoozed') reasonCodes.push('snoozed');

  let tier: DecisionPriorityTier = score >= DECISION_RANKING_POLICY.tierThresholds.critical
    ? 'critical'
    : score >= DECISION_RANKING_POLICY.tierThresholds.high
      ? 'high'
      : score >= DECISION_RANKING_POLICY.tierThresholds.normal ? 'normal' : 'low';
  const floorTo = (floor: DecisionPriorityTier, code: string): void => {
    if (PRIORITY_TIER_ORDER.indexOf(floor) > PRIORITY_TIER_ORDER.indexOf(tier)) tier = floor;
    reasonCodes.push(code);
  };
  if (input.priority === 'critical' || input.priority === 'time_sensitive') {
    floorTo('critical', 'floor_critical_deadline');
  } else if (input.deadlineSoon) {
    floorTo('high', 'floor_deadline_soon');
  }
  if (input.sourceSkill === 'finance' && input.riskLevel !== 'low') floorTo('high', 'floor_finance_risk');
  if (input.type === 'sync_failure' || input.dependencyBlocked) floorTo('high', 'floor_connection_blocking');
  if (input.sourceSkill === 'training' && input.riskLevel === 'high') floorTo('high', 'floor_training_safety');

  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('Decision ranking clock must be a valid Date.');
  }
  return {
    priorityTier: tier,
    priorityScore: score,
    reasonCodes: [...new Set(reasonCodes)],
    computedAt: now.toISOString(),
    rankingVersion: DECISION_RANKING_VERSION,
  };
}
