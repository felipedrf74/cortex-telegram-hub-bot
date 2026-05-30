// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getDecisionFeedbackSignals,
  getDecisionMetricsDaily,
  getDecisionOutcomeMetrics,
  getDecisionReleaseGateStatus,
  type DecisionFeedbackSignal,
  type DecisionMetricsDailyRow,
  type DecisionReleaseGateStatus,
} from './decision-center';

/**
 * T14 — operator dashboard snapshot for the Decision Center (READ-ONLY).
 *
 * COMPOSES already-built reads rather than running new aggregation, so it inherits their scoping (each
 * user-scoped callee does its own assertScope). Three of the four reads are cheap on the request path:
 * getDecisionReleaseGateStatus is a bounded indexed COUNT, getDecisionMetricsDaily is a single
 * pre-aggregated rollup ROW, getDecisionFeedbackSignals is a per-user indexed GROUP BY.
 * getDecisionOutcomeMetrics, by contrast, materializes the user's FULL outcome-ledger partition
 * (indexed by user/tenant, but NOT pruned today — the 180-day retention policy is declared yet has no
 * prune job), so it is bounded only by that partition's row count. That is acceptable while this route
 * is admin-only + flag-gated + low-frequency, but a ledger-prune job must land before enabling it at
 * scale (tracked separately). Live by-status/by-domain breakdowns and quotas/backpressure are deferred.
 */
export interface DecisionDashboardSnapshot {
  userId: number;
  tenantId: number;
  generatedAt: string;
  /** Release-gate invariants: expired-but-visible sweep health + the unimplemented-CTA tripwire. */
  releaseGate: DecisionReleaseGateStatus;
  /** Today's pre-aggregated rollup (decision_metrics_daily '*' row), or null if it has not run today. */
  today: DecisionMetricsDailyRow | null;
  /** Per-source-skill feedback signals (C3b): dismiss rates, top reasons, dont_show_type counts. */
  feedbackBySkill: DecisionFeedbackSignal[];
  /** Headline outcome rates from the user's outcome-ledger partition (per-user indexed; not yet pruned — see the module note). */
  outcomes: {
    totalOutcomes: number;
    decisionQualityScore: number | null;
    primaryActionRate: number;
    dismissRate: number;
    snoozeRate: number;
    failedActionRate: number;
    genericBlockedRate: number;
  };
}

/**
 * Build the operator dashboard snapshot by composing the existing decision-center reads. Pure
 * read-only; no writes. Scoping is inherited from the composed reads (called with the same
 * userId/tenantId). `today` is null until the daily rollup job has run for the current date.
 */
export function buildDecisionDashboardSnapshot(userId: number, tenantId = userId): DecisionDashboardSnapshot {
  const outcomes = getDecisionOutcomeMetrics(userId, tenantId);
  return {
    userId,
    tenantId,
    generatedAt: new Date().toISOString(),
    releaseGate: getDecisionReleaseGateStatus(userId, tenantId),
    today: getDecisionMetricsDaily(tenantId),
    feedbackBySkill: getDecisionFeedbackSignals(userId, tenantId),
    outcomes: {
      totalOutcomes: outcomes.totalOutcomes,
      decisionQualityScore: outcomes.decisionQualityScore,
      primaryActionRate: outcomes.primaryActionRate,
      dismissRate: outcomes.dismissRate,
      snoozeRate: outcomes.snoozeRate,
      failedActionRate: outcomes.failedActionRate,
      genericBlockedRate: outcomes.genericBlockedRate,
    },
  };
}
