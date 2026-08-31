// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { requireTenantIdParam } from './tenant-scope';
import { stableTrainingRevisionHash } from './training-plan-revision-candidate-builder';

export const TRAINING_COACH_V2_SOAK_SCHEMA_VERSION = 'training-coach-v2-soak.1' as const;
export const TRAINING_COACH_V2_MIN_SOAK_SAMPLES = 100;
export const TRAINING_COACH_V2_MAX_FALSE_POSITIVE_RATE = 0.05;
export const TRAINING_COACH_V2_MAX_CHURN_RATE = 0.25;

const RULE_ID = /^[a-z0-9_+.-]{1,120}$/;

export const TRAINING_COACH_V2_LAUNCH_RULE_SET = Object.freeze({
  contractVersion: 'training-coach-v2-launch-rules.1',
  sciencePolicyVersion: '1.0.0',
  ruleIds: Object.freeze([
    'deload_applied',
    'medical_referral',
    'minimum_viable_week',
    'missed_key_rescheduled',
    'missed_session_drop_never_cram',
    'missed_session_drop_or_merge',
    'missed_session_dropped',
    'missed_session_reschedule_or_shortened_aerobic',
    'post_race_recovery_aerobic_only',
    'race_week_strength_cutoff',
    'return_from_gap_febrile_or_systemic_illness',
    'return_from_gap_injury_localized',
    'return_from_gap_minor_illness_resolved',
    'return_from_gap_post_exertional_symptom_risk',
    'return_from_gap_unknown_conservative',
    'return_from_gap_vacation_or_life_gap',
    'taper_session_never_cram',
    'taper_volume_scaled',
    'travel_equipment_limited',
  ]),
});

const TRAINING_COACH_V2_LAUNCH_RULE_IDS = new Set<string>(
  TRAINING_COACH_V2_LAUNCH_RULE_SET.ruleIds,
);

export const TRAINING_COACH_V2_LAUNCH_RULE_SET_DIGEST = stableTrainingRevisionHash(
  TRAINING_COACH_V2_LAUNCH_RULE_SET,
);

export class TrainingCoachV2SoakMetricError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function extractTrainingCoachV2RuleIds(evidence: Record<string, unknown>): string[] {
  const raw = Array.isArray(evidence.reasonCodes) ? evidence.reasonCodes : [];
  return [...new Set(raw.flatMap((value) =>
    typeof value === 'string' ? value.split('+') : [])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => RULE_ID.test(value) && TRAINING_COACH_V2_LAUNCH_RULE_IDS.has(value)))].sort();
}

/** Persist one content-free firing row per deterministic proposal rule. */
export function recordTrainingCoachV2RuleFirings(input: {
  tenantId: number;
  userId: number;
  proposalId: string;
  evidence: Record<string, unknown>;
  firedAt: string;
  db?: Database.Database;
}): number {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'recordTrainingCoachV2RuleFirings');
  let inserted = 0;
  const statement = db.prepare(`
    INSERT OR IGNORE INTO training_coach_v2_rule_firings (
      tenant_id, user_id, proposal_id, rule_id, fired_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const ruleId of extractTrainingCoachV2RuleIds(input.evidence)) {
    inserted += statement.run(tenantId, input.userId, input.proposalId, ruleId, input.firedAt).changes;
  }
  return inserted;
}

/** Append the single reviewed label for an exact scoped rule firing. */
export function recordTrainingCoachV2RuleReview(input: {
  tenantId: number;
  userId: number;
  proposalId: string;
  ruleId: string;
  outcome: 'correct' | 'incorrect';
  idempotencyKey: string;
  reviewedAt?: string;
  db?: Database.Database;
}): { replayed: boolean } {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'recordTrainingCoachV2RuleReview');
  const ruleId = input.ruleId.trim().toLowerCase();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!RULE_ID.test(ruleId)) {
    throw new TrainingCoachV2SoakMetricError('BAD_RULE_ID', 'ruleId is not a supported Coach V2 rule identifier.');
  }
  if (!idempotencyKey || idempotencyKey.length > 160) {
    throw new TrainingCoachV2SoakMetricError('IDEMPOTENCY_REQUIRED', 'A non-empty Idempotency-Key of at most 160 characters is required.');
  }
  const requestHash = stableTrainingRevisionHash({
    tenantId,
    userId: input.userId,
    proposalId: input.proposalId,
    ruleId,
    outcome: input.outcome,
  });
  const replay = db.prepare(`
    SELECT request_hash
    FROM training_coach_v2_rule_reviews
    WHERE tenant_id = ? AND user_id = ? AND idempotency_key = ?
  `).get(tenantId, input.userId, idempotencyKey) as { request_hash: string } | undefined;
  if (replay) {
    if (replay.request_hash !== requestHash) {
      throw new TrainingCoachV2SoakMetricError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key belongs to another Coach V2 rule review.');
    }
    return { replayed: true };
  }
  const firing = db.prepare(`
    SELECT 1
    FROM training_coach_v2_rule_firings
    WHERE tenant_id = ? AND user_id = ? AND proposal_id = ? AND rule_id = ?
  `).get(tenantId, input.userId, input.proposalId, ruleId);
  if (!firing) {
    throw new TrainingCoachV2SoakMetricError('RULE_FIRING_NOT_FOUND', 'The scoped Coach V2 rule firing was not found.');
  }
  try {
    db.prepare(`
      INSERT INTO training_coach_v2_rule_reviews (
        tenant_id, user_id, proposal_id, rule_id, outcome,
        idempotency_key, request_hash, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId,
      input.userId,
      input.proposalId,
      ruleId,
      input.outcome,
      idempotencyKey,
      requestHash,
      input.reviewedAt ?? new Date().toISOString(),
    );
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) {
      throw new TrainingCoachV2SoakMetricError('RULE_ALREADY_REVIEWED', 'This Coach V2 rule firing already has a reviewed label.');
    }
    throw error;
  }
  return { replayed: false };
}

/** Record one accepted plan-week exactly once inside the activation transaction. */
export function recordTrainingCoachV2AcceptedPlanWeek(input: {
  tenantId: number;
  userId: number;
  proposalId: string;
  planId: number;
  weekId: number | null;
  evidence: Record<string, unknown>;
  acceptedAt: string;
  db?: Database.Database;
}): boolean {
  if (input.weekId == null) return false;
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'recordTrainingCoachV2AcceptedPlanWeek');
  const scenario = input.evidence.scenario;
  const safetyRelated = Boolean(
    scenario && typeof scenario === 'object' && !Array.isArray(scenario)
      && (scenario as Record<string, unknown>).kind === 'safety',
  ) || extractTrainingCoachV2RuleIds(input.evidence).includes('medical_referral');
  return db.prepare(`
    INSERT OR IGNORE INTO training_coach_v2_adaptation_observations (
      proposal_id, tenant_id, user_id, plan_id, week_id, safety_related, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.proposalId,
    tenantId,
    input.userId,
    input.planId,
    input.weekId,
    safetyRelated ? 1 : 0,
    input.acceptedAt,
  ).changes === 1;
}

export interface TrainingCoachV2SoakSnapshot {
  schemaVersion: typeof TRAINING_COACH_V2_SOAK_SCHEMA_VERSION;
  generatedAt: string;
  window: { from: string; to: string };
  ruleSet: {
    contractVersion: string;
    sciencePolicyVersion: string;
    configurationDigest: string;
    ruleIds: readonly string[];
  };
  rules: Array<{
    ruleId: string;
    firings: number;
    reviewedFirings: number;
    incorrectReviewedFirings: number;
    falsePositiveRate: number | null;
    sampleReady: boolean;
    thresholdPassed: boolean;
    verdict: 'GO' | 'NO_GO';
  }>;
  churn: {
    adaptedPlanWeeks: number;
    churnedPlanWeeks: number;
    churnRate: number | null;
    sampleReady: boolean;
    thresholdPassed: boolean;
    verdict: 'GO' | 'NO_GO';
  };
  verdict: 'GO' | 'NO_GO';
}

export function getTrainingCoachV2SoakSnapshot(input: {
  from?: string;
  to?: string;
  db?: Database.Database;
} = {}): TrainingCoachV2SoakSnapshot {
  const db = input.db ?? getDb();
  const to = validTimestamp(input.to) ?? new Date().toISOString();
  const from = validTimestamp(input.from)
    ?? new Date(Date.parse(to) - 14 * 86_400_000).toISOString();
  if (Date.parse(from) > Date.parse(to)) {
    throw new TrainingCoachV2SoakMetricError('BAD_SOAK_WINDOW', 'from must be on or before to.');
  }
  const rows = db.prepare(`
    SELECT firing.rule_id AS ruleId,
           COUNT(*) AS firings,
           COUNT(review.id) AS reviewedFirings,
           SUM(CASE WHEN review.outcome = 'incorrect' THEN 1 ELSE 0 END) AS incorrectReviewedFirings
    FROM training_coach_v2_rule_firings firing
    LEFT JOIN training_coach_v2_rule_reviews review
      ON review.tenant_id = firing.tenant_id
     AND review.user_id = firing.user_id
     AND review.proposal_id = firing.proposal_id
     AND review.rule_id = firing.rule_id
    WHERE firing.fired_at >= ? AND firing.fired_at <= ?
    GROUP BY firing.rule_id
    ORDER BY firing.rule_id
  `).all(from, to) as Array<{
    ruleId: string;
    firings: number;
    reviewedFirings: number;
    incorrectReviewedFirings: number;
  }>;
  const rowsByRule = new Map(rows.map((row) => [row.ruleId, row]));
  const rules = TRAINING_COACH_V2_LAUNCH_RULE_SET.ruleIds.map((ruleId) => {
    const row = rowsByRule.get(ruleId);
    const reviewedFirings = Number(row?.reviewedFirings ?? 0);
    const incorrectReviewedFirings = Number(row?.incorrectReviewedFirings ?? 0);
    const falsePositiveRate = reviewedFirings > 0
      ? incorrectReviewedFirings / reviewedFirings
      : null;
    const sampleReady = reviewedFirings >= TRAINING_COACH_V2_MIN_SOAK_SAMPLES;
    const thresholdPassed = falsePositiveRate !== null
      && falsePositiveRate < TRAINING_COACH_V2_MAX_FALSE_POSITIVE_RATE;
    return {
      ruleId,
      firings: Number(row?.firings ?? 0),
      reviewedFirings,
      incorrectReviewedFirings,
      falsePositiveRate,
      sampleReady,
      thresholdPassed,
      verdict: sampleReady && thresholdPassed ? 'GO' as const : 'NO_GO' as const,
    };
  });
  const churn = db.prepare(`
    WITH ranked AS (
      SELECT observation.*,
             ROW_NUMBER() OVER (
               PARTITION BY tenant_id, user_id, plan_id, week_id
               ORDER BY datetime(accepted_at) ASC, proposal_id ASC
             ) AS sequence
      FROM training_coach_v2_adaptation_observations observation
    )
    SELECT COUNT(*) AS adaptedPlanWeeks,
           SUM(CASE WHEN base.safety_related = 0 AND EXISTS (
             SELECT 1
             FROM training_coach_v2_adaptation_observations later
             WHERE later.tenant_id = base.tenant_id
               AND later.user_id = base.user_id
               AND later.plan_id = base.plan_id
               AND later.week_id = base.week_id
               AND datetime(later.accepted_at) > datetime(base.accepted_at)
               AND datetime(later.accepted_at) <= datetime(base.accepted_at, '+7 days')
               AND datetime(later.accepted_at) <= datetime(?)
           ) THEN 1 ELSE 0 END) AS churnedPlanWeeks
    FROM ranked base
    WHERE base.sequence = 1
      AND datetime(base.accepted_at) >= datetime(?)
      AND datetime(base.accepted_at) <= datetime(?, '-7 days')
  `).get(to, from, to) as { adaptedPlanWeeks: number; churnedPlanWeeks: number };
  const adaptedPlanWeeks = Number(churn.adaptedPlanWeeks);
  const churnedPlanWeeks = Number(churn.churnedPlanWeeks);
  const churnRate = adaptedPlanWeeks > 0 ? churnedPlanWeeks / adaptedPlanWeeks : null;
  const churnSampleReady = adaptedPlanWeeks >= TRAINING_COACH_V2_MIN_SOAK_SAMPLES;
  const churnThresholdPassed = churnRate !== null && churnRate < TRAINING_COACH_V2_MAX_CHURN_RATE;
  const churnVerdict = churnSampleReady && churnThresholdPassed ? 'GO' as const : 'NO_GO' as const;
  return {
    schemaVersion: TRAINING_COACH_V2_SOAK_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    window: { from, to },
    ruleSet: {
      contractVersion: TRAINING_COACH_V2_LAUNCH_RULE_SET.contractVersion,
      sciencePolicyVersion: TRAINING_COACH_V2_LAUNCH_RULE_SET.sciencePolicyVersion,
      configurationDigest: TRAINING_COACH_V2_LAUNCH_RULE_SET_DIGEST,
      ruleIds: TRAINING_COACH_V2_LAUNCH_RULE_SET.ruleIds,
    },
    rules,
    churn: {
      adaptedPlanWeeks,
      churnedPlanWeeks,
      churnRate,
      sampleReady: churnSampleReady,
      thresholdPassed: churnThresholdPassed,
      verdict: churnVerdict,
    },
    verdict: rules.length > 0 && rules.every((rule) => rule.verdict === 'GO') && churnVerdict === 'GO'
      ? 'GO'
      : 'NO_GO',
  };
}

function validTimestamp(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new TrainingCoachV2SoakMetricError('BAD_SOAK_WINDOW', 'Soak timestamps must be valid ISO-8601 values.');
  }
  return new Date(Date.parse(value)).toISOString();
}
