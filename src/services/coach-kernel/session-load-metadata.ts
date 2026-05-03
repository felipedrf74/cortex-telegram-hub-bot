// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Session load metadata derivation.
 *
 * Plan-level safety rules (long-run protected from heavy-lower the day
 * before, no >2 consecutive leg-heavy days, etc.) need typed metadata
 * about each session: how leg-loaded is it? Is it a key session? What
 * minimum recovery window does it impose on the next day? Which other
 * session types can safely sit next to it?
 *
 * The existing `Session` shape (`coach-kernel/types.ts`) carries
 * `fatigueCost` (enum), `keySession` (bool), `plannedLoad` (number),
 * and `tags` (string[]). That's enough surface to DERIVE richer typed
 * metadata without mutating the schema. This module is a pure derivation
 * pass — call `deriveSessionLoadMetadata(session)` to get the typed
 * `SessionLoadMetadata` for any session, then feed the result to the
 * plan-linter, key-session-protection guardrails, or future spacing
 * logic.
 *
 * Future work could promote these fields to first-class `Session`
 * properties + a migration backfill, but for now derivation is enough
 * to unlock typed safety rules without DB risk.
 */

import type { FatigueCost, Session, SessionType } from './types';

/**
 * 0–10 scale. 0 = no leg load (reading day, upper-body-only strength,
 * pool drills with no kicking). 10 = max leg load (heavy back squat
 * day, max-effort hill repeats, race-pace long run).
 */
export type LoadScore = number;

/**
 * Hard ranking on how protective the next-day spacing must be.
 *   • critical — long run, race-rehearsal, threshold/interval, max
 *     strength. Day before AND day after must be light or
 *     compatible-only.
 *   • high     — tempo run, sub-threshold ride, hypertrophy lift.
 *   • normal   — easy aerobic, recovery, technique.
 *   • optional — mobility, walk, stretching.
 */
export type KeySessionPriority = 'critical' | 'high' | 'normal' | 'optional';

/** Other `SessionType`s that can safely sit on adjacent days. */
export type CompatibleNeighbor =
  | 'easy_run'
  | 'recovery_run'
  | 'recovery_ride'
  | 'recovery_swim'
  | 'mobility'
  | 'rest'
  | 'technique_swim'
  | 'aerobic_swim'
  | 'strength_upper'
  | 'strength_core';

export interface SessionLoadMetadata {
  legLoadScore: LoadScore;
  tendonLoadScore: LoadScore;
  upperBodyLoadScore: LoadScore;
  neuromuscularCost: LoadScore;
  keySessionPriority: KeySessionPriority;
  /** Hours of recovery the next session should respect (0–48). */
  minimumRecoveryHours: number;
  /** Set of session types compatible as next-day neighbors. */
  compatibleNeighbors: ReadonlySet<CompatibleNeighbor>;
  /** Stable signature for spacing-rule logging / decision-trail evidence. */
  signature: string;
}

const NEUTRAL_NEIGHBOR_SET: ReadonlySet<CompatibleNeighbor> = new Set([
  'easy_run',
  'recovery_run',
  'recovery_ride',
  'recovery_swim',
  'mobility',
  'rest',
  'technique_swim',
  'aerobic_swim',
  'strength_upper',
  'strength_core',
]);

const RESTRICTED_NEIGHBOR_SET: ReadonlySet<CompatibleNeighbor> = new Set([
  'recovery_run',
  'recovery_ride',
  'recovery_swim',
  'mobility',
  'rest',
]);

const FATIGUE_TO_NM: Record<FatigueCost, LoadScore> = {
  low: 2,
  medium: 5,
  high: 7,
  very_high: 9,
};

const FATIGUE_TO_HOURS: Record<FatigueCost, number> = {
  low: 8,
  medium: 16,
  high: 24,
  very_high: 36,
};

/** Light wrapper to clamp a derived score to [0, 10]. */
function clamp(value: number): LoadScore {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, Math.round(value)));
}

function tagsLowerSet(tags: ReadonlyArray<string> | undefined): Set<string> {
  return new Set((tags ?? []).map((t) => t.toLowerCase()));
}

function isLowerBodySession(session: Session): boolean {
  if (session.sport !== 'strength') return false;
  const t = tagsLowerSet(session.tags);
  return t.has('lower_body') || t.has('full_body') || t.has('squat') || t.has('hinge');
}

function isUpperBodyStrength(session: Session): boolean {
  if (session.sport !== 'strength') return false;
  const t = tagsLowerSet(session.tags);
  return t.has('upper_body') || t.has('push') || t.has('pull');
}

function legLoadFor(session: Session): LoadScore {
  if (session.sport === 'running') {
    // Long runs and threshold/interval workouts impose major bone +
    // tendon stress on the legs; recovery runs are minimal.
    if (session.sessionType === 'long_run') return 9;
    if (session.sessionType === 'threshold_run' || session.sessionType === 'interval_run') return 8;
    if (session.sessionType === 'recovery_run') return 3;
    if (session.sessionType === 'easy_run') return 5;
    return 6;
  }
  if (session.sport === 'cycling') {
    // Cycling is lower-impact on legs; the tendon score is lower than
    // running for the same intensity zone.
    if (session.sessionType === 'threshold_ride' || session.sessionType === 'vo2_ride') return 6;
    if (session.sessionType === 'recovery_ride') return 2;
    if (session.sessionType === 'endurance_ride') return 4;
    if (session.sessionType === 'tempo_ride') return 5;
    return 4;
  }
  if (session.sport === 'strength') {
    if (isLowerBodySession(session)) {
      // Lower-body lifts: heavy max ≈ 9, hypertrophy ≈ 7, maintenance ≈ 4.
      if (session.sessionType === 'strength_max') return 9;
      if (session.sessionType === 'strength_hypertrophy') return 7;
      if (session.sessionType === 'strength_maintenance') return 4;
      return 6;
    }
    if (isUpperBodyStrength(session)) return 1;
    return 2;
  }
  if (session.sport === 'swimming') {
    return session.sessionType === 'speed_swim' ? 3 : 1;
  }
  return 0;
}

function tendonLoadFor(session: Session, legLoad: LoadScore): LoadScore {
  // Running is the hardest on tendons per leg-load unit; cycling is the
  // softest. Strength scales with leg-load. Swimming is negligible.
  if (session.sport === 'running') return clamp(legLoad + 1);
  if (session.sport === 'strength') return clamp(legLoad - 1);
  if (session.sport === 'cycling') return clamp(legLoad - 2);
  return 0;
}

function upperBodyLoadFor(session: Session): LoadScore {
  if (session.sport !== 'strength') return 1;
  if (isUpperBodyStrength(session)) {
    if (session.sessionType === 'strength_max') return 8;
    if (session.sessionType === 'strength_hypertrophy') return 7;
    return 5;
  }
  // A "full body" or core day still touches the upper body.
  const t = tagsLowerSet(session.tags);
  if (t.has('full_body') || t.has('core')) return 4;
  return 1;
}

function keyPriorityFor(session: Session): KeySessionPriority {
  if (!session.keySession) {
    if (session.sessionType === 'rest' || session.sessionType === 'mobility') return 'optional';
    return 'normal';
  }
  if (
    session.sessionType === 'long_run' ||
    session.sessionType === 'threshold_run' ||
    session.sessionType === 'interval_run' ||
    session.sessionType === 'threshold_ride' ||
    session.sessionType === 'vo2_ride' ||
    session.sessionType === 'strength_max' ||
    session.sessionType === 'brick'
  ) {
    return 'critical';
  }
  return 'high';
}

function neighborsFor(session: Session, key: KeySessionPriority): ReadonlySet<CompatibleNeighbor> {
  if (key === 'critical') return RESTRICTED_NEIGHBOR_SET;
  if (key === 'optional') return NEUTRAL_NEIGHBOR_SET;
  return NEUTRAL_NEIGHBOR_SET;
}

function signatureFor(session: Session, leg: number, key: KeySessionPriority): string {
  return `${session.sport}/${session.sessionType}/${session.fatigueCost}/leg${leg}/${key}`;
}

/**
 * Pure: produce typed `SessionLoadMetadata` from a `Session`. No I/O.
 *
 * Intended consumers:
 *   • `plan-linter.ts` — for accurate `isLowerHeavy` + `isLongRun` flags
 *     instead of regex heuristics, AND for spacing rules driven by
 *     `minimumRecoveryHours` / `compatibleNeighbors`.
 *   • Future spacing-aware planner that checks `compatibleNeighbors`
 *     before placing two adjacent sessions.
 *   • Test fixtures that need a deterministic load metric.
 */
export function deriveSessionLoadMetadata(session: Session): SessionLoadMetadata {
  const legLoad = legLoadFor(session);
  const tendonLoad = tendonLoadFor(session, legLoad);
  const upperLoad = upperBodyLoadFor(session);
  const nm = FATIGUE_TO_NM[session.fatigueCost] ?? 5;
  const key = keyPriorityFor(session);
  const minHours = (() => {
    const base = FATIGUE_TO_HOURS[session.fatigueCost] ?? 16;
    if (key === 'critical') return Math.max(base, 24);
    if (key === 'high') return Math.max(base, 16);
    return base;
  })();
  return {
    legLoadScore: legLoad,
    tendonLoadScore: tendonLoad,
    upperBodyLoadScore: upperLoad,
    neuromuscularCost: nm,
    keySessionPriority: key,
    minimumRecoveryHours: minHours,
    compatibleNeighbors: neighborsFor(session, key),
    signature: signatureFor(session, legLoad, key),
  };
}

/**
 * Helper for plan-linter consumers that don't carry a full `Session`
 * object. Maps a (sessionType, sport, isKey) tuple onto the same
 * derivation logic via a synthetic minimal session.
 */
export function deriveSessionLoadMetadataFromShape(shape: {
  sport: Session['sport'];
  sessionType: SessionType;
  fatigueCost?: FatigueCost;
  keySession?: boolean;
  tags?: ReadonlyArray<string>;
}): SessionLoadMetadata {
  const synthetic: Session = {
    id: 'derive-shape',
    sport: shape.sport,
    sessionType: shape.sessionType,
    title: shape.sessionType,
    description: '',
    dayOfWeek: 'monday',
    durationMinutes: 0,
    intensityZone: 'aerobic',
    fatigueCost: shape.fatigueCost ?? 'medium',
    keySession: shape.keySession ?? false,
    plannedLoad: 0,
    tags: [...(shape.tags ?? [])],
  };
  return deriveSessionLoadMetadata(synthetic);
}

/**
 * Spacing rule: are sessions `a` and `b` safe to schedule on adjacent
 * days? Returns false when EITHER session is critical AND BOTH carry
 * a leg-load score >= 7.
 *
 * Why leg-load and not session-type alone:
 *   • An easy_run (legLoad=5) before a long_run (legLoad=9) is a
 *     standard warm-up day — typed compatible.
 *   • A heavy back squat (legLoad=9) before a long_run (legLoad=9) is
 *     a known injury-risk pattern — typed incompatible.
 *   • Recovery/mobility/rest (legLoad ≤ 3) sit next to anything.
 *
 * The `compatibleNeighbors` set on the metadata is kept as informational
 * metadata for decision-trail logging, but it is NOT the spacing source
 * of truth — leg-load comparison is. This avoids the false-negative on
 * easy_run-before-long_run that pure neighbor-set membership produced.
 */
export function isSpacingCompatible(a: Session, b: Session): boolean {
  const am = deriveSessionLoadMetadata(a);
  const bm = deriveSessionLoadMetadata(b);
  const eitherCritical =
    am.keySessionPriority === 'critical' || bm.keySessionPriority === 'critical';
  const bothHeavyLeg = am.legLoadScore >= 7 && bm.legLoadScore >= 7;
  return !(eitherCritical && bothHeavyLeg);
}
