// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Coach plan policy — slice A5 of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Per-plan coaching preferences distinct from the athlete's stable
 * identity. The v2.1 critique moved this from C0 (Phase C
 * "adaptability") to Phase A "substrate" because B3 (mesocycle),
 * B4 (intensity distribution), B5 (deload), B7 (taper), and C8
 * (scenario classifier with anti-churn) all read from it.
 *
 * Defaults reflect a sensible "trust the engine but don't get
 * surprised" posture:
 *   - intensityDistributionPreference: 'auto' — let A1b's
 *     defaults pick per (sport, level).
 *   - progressionAggressiveness: 'standard' — neither timid nor
 *     pushy by default.
 *   - deloadStrategy: 'hybrid' — schedule OR data-informed,
 *     whichever fires first.
 *   - missedSessionPolicy: 'drop_low_priority' — never cram.
 *   - taperStrategy: 'auto' — use B7's day-level engine.
 *   - adaptationRateLimits: 1 non-safety reflow per day, 2 per week.
 */

import { getDb } from './database';
import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import type { CoachPlanPolicy } from './coach-kernel/types';

/** Current schema version for persisted CoachPlanPolicy JSON. */
export const COACH_PLAN_POLICY_SCHEMA_VERSION = 1;
export const COACH_PLAN_POLICY_CONTRACT_VERSION = 'coach-plan-policy.v2' as const;

export interface CoachPlanPolicySnapshot {
  contractVersion: typeof COACH_PLAN_POLICY_CONTRACT_VERSION;
  policy: CoachPlanPolicy;
  version: number;
  etag: string;
}

export class CoachPlanPolicyVersionConflictError extends Error {}

/** Default policy applied when a plan has no persisted policy. */
export const DEFAULT_COACH_PLAN_POLICY: CoachPlanPolicy = {
  intensityDistributionPreference: 'auto',
  progressionAggressiveness: 'standard',
  deloadStrategy: 'hybrid',
  missedSessionPolicy: 'drop_low_priority',
  taperStrategy: 'auto',
  adaptationRateLimits: { perDay: 1, perWeek: 2 },
  schemaVersion: COACH_PLAN_POLICY_SCHEMA_VERSION,
};

/**
 * Get the policy for a plan, applying defaults when unset. Returns
 * null when the plan itself doesn't exist.
 */
export function getCoachPlanPolicy(planId: number): CoachPlanPolicy | null {
  return getCoachPlanPolicySnapshot(planId)?.policy ?? null;
}

export function getCoachPlanPolicySnapshot(
  planId: number,
  db: Database.Database = getDb(),
): CoachPlanPolicySnapshot | null {
  const row = db.prepare(
    'SELECT coach_plan_policy_json, coach_plan_policy_version FROM fitness_training_plans WHERE id = ?',
  ).get(planId) as { coach_plan_policy_json: string | null; coach_plan_policy_version: number } | undefined;
  if (!row) return null;
  let policy: CoachPlanPolicy = { ...DEFAULT_COACH_PLAN_POLICY };
  try {
    if (row.coach_plan_policy_json) {
      const parsed = JSON.parse(row.coach_plan_policy_json) as Partial<CoachPlanPolicy>;
      policy = mergeWithDefaults(parsed);
    }
  } catch (err) {
    logger.warn({ planId, err }, 'coach_plan_policy.parse_failed');
  }
  const version = Math.max(1, Number(row.coach_plan_policy_version) || 1);
  return {
    contractVersion: COACH_PLAN_POLICY_CONTRACT_VERSION,
    policy,
    version,
    etag: coachPlanPolicyEtag(version),
  };
}

/**
 * Set the policy for a plan. Validates and persists. Throws on
 * invalid input.
 */
export function setCoachPlanPolicy(planId: number, partial: Partial<CoachPlanPolicy>): CoachPlanPolicy {
  const current = getCoachPlanPolicy(planId);
  if (!current) throw new Error(`Plan ${planId} does not exist`);
  const validated = validateAndMerge(partial, current);
  const db = getDb();
  const result = db.prepare(
    'UPDATE fitness_training_plans SET coach_plan_policy_json = ?, coach_plan_policy_version = COALESCE(coach_plan_policy_version, 1) + 1, updated_at = datetime(\'now\') WHERE id = ?',
  ).run(JSON.stringify(validated), planId);
  if (result.changes === 0) {
    throw new Error(`Plan ${planId} does not exist`);
  }
  return validated;
}

export function setCoachPlanPolicyCas(
  planId: number,
  partial: Partial<CoachPlanPolicy>,
  expectedVersion: number,
  db: Database.Database = getDb(),
): CoachPlanPolicySnapshot {
  const current = getCoachPlanPolicySnapshot(planId, db);
  if (!current) throw new Error(`Plan ${planId} does not exist`);
  if (current.version !== expectedVersion) {
    throw new CoachPlanPolicyVersionConflictError('Coach policy version does not match If-Match.');
  }
  const validated = validateAndMerge(partial, current.policy);
  const result = db.prepare(`
    UPDATE fitness_training_plans
    SET coach_plan_policy_json = ?,
        coach_plan_policy_version = COALESCE(coach_plan_policy_version, 1) + 1,
        updated_at = datetime('now')
    WHERE id = ? AND COALESCE(coach_plan_policy_version, 1) = ?
  `).run(JSON.stringify(validated), planId, expectedVersion);
  if (result.changes !== 1) {
    throw new CoachPlanPolicyVersionConflictError('Coach policy changed before the update could be applied.');
  }
  return getCoachPlanPolicySnapshot(planId, db)!;
}

export function previewCoachPlanPolicyPatch(
  planId: number,
  partial: Partial<CoachPlanPolicy>,
): CoachPlanPolicySnapshot {
  const current = getCoachPlanPolicySnapshot(planId);
  if (!current) throw new Error(`Plan ${planId} does not exist`);
  return {
    ...current,
    policy: validateAndMerge(partial, current.policy),
  };
}

export function coachPlanPolicyEtag(version: number): string {
  return `"coach-policy-${version}"`;
}

/**
 * Merge a (possibly partial) policy with defaults. Used both on read
 * (to handle older schemas) and write (to fill missing fields).
 */
function mergeWithDefaults(partial: Partial<CoachPlanPolicy>): CoachPlanPolicy {
  return {
    intensityDistributionPreference:
      partial.intensityDistributionPreference ?? DEFAULT_COACH_PLAN_POLICY.intensityDistributionPreference,
    progressionAggressiveness:
      partial.progressionAggressiveness ?? DEFAULT_COACH_PLAN_POLICY.progressionAggressiveness,
    deloadStrategy: partial.deloadStrategy ?? DEFAULT_COACH_PLAN_POLICY.deloadStrategy,
    missedSessionPolicy: partial.missedSessionPolicy ?? DEFAULT_COACH_PLAN_POLICY.missedSessionPolicy,
    taperStrategy: partial.taperStrategy ?? DEFAULT_COACH_PLAN_POLICY.taperStrategy,
    adaptationRateLimits: {
      perDay: partial.adaptationRateLimits?.perDay ?? DEFAULT_COACH_PLAN_POLICY.adaptationRateLimits?.perDay,
      perWeek: partial.adaptationRateLimits?.perWeek ?? DEFAULT_COACH_PLAN_POLICY.adaptationRateLimits?.perWeek,
    },
    schemaVersion: COACH_PLAN_POLICY_SCHEMA_VERSION,
  };
}

const ALLOWED_DISTRIBUTION_PREFS: ReadonlySet<string> = new Set(['auto', 'polarized', 'pyramidal', 'thresholdFocused']);
const ALLOWED_AGGRESSIVENESS: ReadonlySet<string> = new Set(['conservative', 'standard', 'aggressive']);
const ALLOWED_DELOAD: ReadonlySet<string> = new Set(['scheduled', 'data_informed', 'hybrid']);
const ALLOWED_MISSED: ReadonlySet<string> = new Set(['drop_low_priority', 'preserve_key_sessions', 'ask_user']);
const ALLOWED_TAPER: ReadonlySet<string> = new Set(['auto', 'short', 'standard', 'extended']);

function validateAndMerge(
  partial: Partial<CoachPlanPolicy>,
  base: CoachPlanPolicy = DEFAULT_COACH_PLAN_POLICY,
): CoachPlanPolicy {
  if (
    partial.intensityDistributionPreference !== undefined &&
    !ALLOWED_DISTRIBUTION_PREFS.has(partial.intensityDistributionPreference)
  ) {
    throw new Error(`Invalid intensityDistributionPreference: ${partial.intensityDistributionPreference}`);
  }
  if (
    partial.progressionAggressiveness !== undefined &&
    !ALLOWED_AGGRESSIVENESS.has(partial.progressionAggressiveness)
  ) {
    throw new Error(`Invalid progressionAggressiveness: ${partial.progressionAggressiveness}`);
  }
  if (
    partial.deloadStrategy !== undefined &&
    !ALLOWED_DELOAD.has(partial.deloadStrategy)
  ) {
    throw new Error(`Invalid deloadStrategy: ${partial.deloadStrategy}`);
  }
  if (
    partial.missedSessionPolicy !== undefined &&
    !ALLOWED_MISSED.has(partial.missedSessionPolicy)
  ) {
    throw new Error(`Invalid missedSessionPolicy: ${partial.missedSessionPolicy}`);
  }
  if (
    partial.taperStrategy !== undefined &&
    !ALLOWED_TAPER.has(partial.taperStrategy)
  ) {
    throw new Error(`Invalid taperStrategy: ${partial.taperStrategy}`);
  }
  if (partial.adaptationRateLimits) {
    if (
      partial.adaptationRateLimits.perDay !== undefined &&
      (partial.adaptationRateLimits.perDay < 0 || !Number.isInteger(partial.adaptationRateLimits.perDay))
    ) {
      throw new Error(`adaptationRateLimits.perDay must be a non-negative integer`);
    }
    if (
      partial.adaptationRateLimits.perWeek !== undefined &&
      (partial.adaptationRateLimits.perWeek < 0 || !Number.isInteger(partial.adaptationRateLimits.perWeek))
    ) {
      throw new Error(`adaptationRateLimits.perWeek must be a non-negative integer`);
    }
  }
  return mergeWithDefaults({
    ...base,
    ...partial,
    adaptationRateLimits: {
      ...(base.adaptationRateLimits ?? {}),
      ...(partial.adaptationRateLimits ?? {}),
    },
  });
}
