// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Notification priority model.
 *
 * Today priority is a string a producer types by hand: twelve emit sites write
 * `'time_sensitive'` and nothing arbitrates. This module turns intent features
 * into a scored verdict so the producer gets a VOTE, not a veto.
 *
 * SHADOW MODE. Nothing here changes delivery yet. `scoreNotification` is pure —
 * no DB, no env, no clock of its own — and the orchestrator records its verdict
 * alongside the decision it actually took, so the two can be compared over real
 * traffic before the model is allowed to decide anything. Shipping a scoring
 * change blind, on a system with no engagement history, is how you train users
 * to disable notifications.
 *
 * Determinism matters: every term is integer and piecewise rather than
 * exponential, so verdicts are reproducible across platforms and can be pinned
 * in tests.
 */

import type {
  NotificationIntentType,
  NotificationPriority,
  NotificationSourceSkill,
} from './notification-orchestrator';

export const PRIORITY_MODEL_VERSION = 1;

const HOUR_MS = 3_600_000;

export type PriorityTier = 'ambient' | 'low' | 'normal' | 'high' | 'critical';

const TIER_ORDER: PriorityTier[] = ['ambient', 'low', 'normal', 'high', 'critical'];

/** Engagement history for a (user, skill, type). All rates are 0..1. */
export interface EngagementStats {
  surfaced: number;
  openRate: number;
  actionRate: number;
  dismissRate: number;
  snoozeRate: number;
  /** How many times the user explicitly muted this type. */
  mutedCount: number;
}
export const NEUTRAL_ENGAGEMENT: EngagementStats = {
  surfaced: 0, openRate: 0, actionRate: 0, dismissRate: 0, snoozeRate: 0, mutedCount: 0,
};

/**
 * Below this many observations the fatigue term is suppressed entirely. A new
 * notification type must not be buried because its first two sends happened to
 * land badly.
 */
export const COLD_START_MIN_OBSERVATIONS = 5;

export interface PriorityFeatures {
  type: NotificationIntentType;
  sourceSkill: NotificationSourceSkill;
  declaredPriority: NotificationPriority;
  nowMs: number;
  deadlineAtMs: number | null;
  /** When the evidence behind this notification was observed. */
  sourceObservedAtMs: number | null;
  requiresUserAction: boolean;
  hasSourceScope: boolean;
  actionCount: number;
  riskIfIgnored: 'low' | 'medium' | 'high';
  reversibility: 'reversible' | 'undoable_with_cost' | 'irreversible';
  confidence: number;
  engagement: EngagementStats;
  /** True when this decision is waiting on another one. */
  dependencyBlocked: boolean;
  /** How many other decisions this one unblocks. */
  dependencySlack: number;
  /** 0 for a first send; increments on each escalation. */
  escalationGeneration: number;
  snoozed: boolean;
  safeForAPNs: boolean;
}

export interface PriorityVerdict {
  score: number;
  tier: PriorityTier;
  components: Record<string, number>;
  reasonCodes: string[];
  floored: boolean;
  modelVersion: number;
}

/**
 * Intrinsic worth of each intent type, before any situational adjustment.
 * `reflow_suggestion` and `risk_warning` currently have no producers; they are
 * scored anyway so wiring one needs no model change.
 */
export const TYPE_BASE: Record<NotificationIntentType, number> = {
  security_account: 48,
  conflict_detected: 42,
  approval_required: 40,
  decision_required: 38,
  risk_warning: 38,
  reflow_suggestion: 34,
  sync_failure: 32,
  reminder: 28,
  missed_item: 22,
  schedule_changed: 18,
  insight: 10,
  daily_digest: 6,
  weekly_review: 4,
};

/**
 * How fast the evidence behind a type goes stale. A conflict computed from a
 * three-day-old calendar snapshot is not urgent — it is probably wrong.
 */
const STALE_HALFLIFE_HOURS: Partial<Record<NotificationIntentType, number>> = {
  security_account: 2,
  conflict_detected: 6,
  reflow_suggestion: 6,
  schedule_changed: 12,
  sync_failure: 12,
  decision_required: 24,
  reminder: 24,
  approval_required: 48,
};

export function deadlinePressure(deadlineMs: number | null, nowMs: number): number {
  if (deadlineMs == null) return 0;
  const h = (deadlineMs - nowMs) / HOUR_MS;
  // Overdue scores high but NOT maximal: a missed deadline is usually less
  // actionable than an imminent one, not more.
  if (h < 0) return 26;
  if (h <= 1) return 30;
  if (h <= 3) return 28;
  if (h <= 6) return 25;
  if (h <= 12) return 21;
  if (h <= 24) return 17;
  if (h <= 48) return 11;
  if (h <= 72) return 7;
  if (h <= 168) return 3;
  return 0;
}

export function stalenessPenalty(
  observedMs: number | null,
  nowMs: number,
  type: NotificationIntentType,
): number {
  // Unknown freshness is not free — it is the same as mildly stale.
  if (observedMs == null) return 6;
  const halfLife = STALE_HALFLIFE_HOURS[type] ?? 24;
  const halves = Math.floor(((nowMs - observedMs) / HOUR_MS) / halfLife);
  return Math.min(15, Math.max(0, halves * 5));
}

export function fatiguePenalty(e: EngagementStats): number {
  if (e.surfaced < COLD_START_MIN_OBSERVATIONS) return 0;
  // Shrink toward zero while the sample is small, so an unlucky first week
  // cannot bury a type permanently.
  const confidence = Math.min(1, e.surfaced / 20);
  const raw = 25 * (0.6 * e.dismissRate + 0.25 * e.snoozeRate + 0.15 * (1 - e.openRate))
    - 12 * e.actionRate; // a type the user actually acts on earns a rebate
  return Math.round(Math.max(0, Math.min(25, raw * confidence)));
}

export function tierForScore(score: number): PriorityTier {
  if (score >= 85) return 'critical';
  if (score >= 68) return 'high';
  if (score >= 45) return 'normal';
  if (score >= 25) return 'low';
  return 'ambient';
}

function isDeadlineWithin(f: PriorityFeatures, ms: number): boolean {
  if (f.deadlineAtMs == null) return false;
  const delta = f.deadlineAtMs - f.nowMs;
  return delta >= 0 && delta <= ms;
}

export function scoreNotification(f: PriorityFeatures): PriorityVerdict {
  const c: Record<string, number> = {};
  const reasons: string[] = [];

  c.typeBase = TYPE_BASE[f.type] ?? 20;

  // The producer's claim is capped. Today declaring `critical` buys 100 points
  // outright, so a single mis-declared intent instantly outranks everything real.
  c.declaredLift = f.declaredPriority === 'critical' ? 14
    : f.declaredPriority === 'time_sensitive' ? 10
      : f.declaredPriority === 'active' ? 5 : 0;

  c.deadline = deadlinePressure(f.deadlineAtMs, f.nowMs);
  if (c.deadline >= 24) reasons.push('deadline_imminent');

  c.impact = (f.riskIfIgnored === 'high' ? 14 : f.riskIfIgnored === 'medium' ? 7 : 0)
    + (f.reversibility === 'irreversible' ? 8 : f.reversibility === 'undoable_with_cost' ? 4 : 0);

  // A notification the user cannot act on is not a decision. The heavy negative
  // mirrors the orchestrator's existing rule that an actionable intent without a
  // source entity is demoted to passive.
  c.actionability = (f.requiresUserAction && f.hasSourceScope && f.actionCount > 0) ? 10
    : (f.requiresUserAction && !f.hasSourceScope) ? -25 : 0;

  const confidence = Math.max(0, Math.min(1, f.confidence));
  c.confidence = -Math.round(15 * Math.max(0, (0.85 - confidence) / 0.85));

  c.staleness = -stalenessPenalty(f.sourceObservedAtMs, f.nowMs, f.type);

  c.fatigue = -fatiguePenalty(f.engagement);
  if (c.fatigue <= -15) reasons.push('fatigue_low_engagement');

  // A blocker that unblocks three decisions is worth more than any of them.
  c.dependency = f.dependencyBlocked ? -12 : Math.min(10, 3 * Math.max(0, f.dependencySlack));

  c.escalation = Math.min(10, 4 * Math.max(0, f.escalationGeneration));
  c.snooze = f.snoozed ? -20 : 0;

  const raw = Object.values(c).reduce((a, b) => a + b, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  let tier = tierForScore(score);

  // ── Raise-only policy floors ──────────────────────────────────────────
  // Product invariants, not learned behaviour. Mirrors the Decision Center's
  // existing floor discipline.
  const floorTo = (target: PriorityTier, code: string) => {
    if (TIER_ORDER.indexOf(target) > TIER_ORDER.indexOf(tier)) tier = target;
    reasons.push(code);
  };
  if (f.type === 'security_account') floorTo('critical', 'floor_security');
  if (isDeadlineWithin(f, 2 * HOUR_MS) && f.requiresUserAction) floorTo('critical', 'floor_deadline_imminent');
  else if (isDeadlineWithin(f, 24 * HOUR_MS)) floorTo('high', 'floor_deadline_soon');
  if (f.sourceSkill === 'finance' && f.riskIfIgnored !== 'low') floorTo('high', 'floor_finance_risk');
  if (f.type === 'sync_failure' || f.dependencyBlocked) floorTo('high', 'floor_connection_blocking');
  if (f.sourceSkill === 'training' && f.riskIfIgnored === 'high') floorTo('high', 'floor_training_safety');

  // ── Hard ceilings (lower-only; floors cannot escape these) ────────────
  // A floor must never resurrect something the quality gate rejected, and must
  // never override an explicit user mute.
  const lowerTo = (cap: PriorityTier, code: string) => {
    if (TIER_ORDER.indexOf(cap) < TIER_ORDER.indexOf(tier)) tier = cap;
    reasons.push(code);
  };
  if (!f.safeForAPNs) lowerTo('normal', 'ceiling_quality_gate');
  if (f.engagement.mutedCount >= 1 && !reasons.some((r) => r.startsWith('floor_'))) {
    lowerTo('low', 'ceiling_user_muted_type');
  }

  return {
    score,
    tier,
    components: c,
    reasonCodes: [...new Set(reasons)],
    floored: reasons.some((r) => r.startsWith('floor_')),
    modelVersion: PRIORITY_MODEL_VERSION,
  };
}
