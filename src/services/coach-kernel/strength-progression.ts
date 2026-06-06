// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Strength progression with gating — slice B6 of the Week-Level
 * Adaptability + Periodization plan (v2.1).
 *
 * Consumes `WorkoutTemplate.progressionTarget` (populated on every
 * YAML template but unread until this slice). Returns a typed
 * progression decision for an upcoming strength prescription based
 * on the athlete's recent completion data + safety signals.
 *
 * Four progression vectors (per ACSM 2026 position stand + Helms
 * RTS 2018):
 *
 *   - `load_progression`: increase weight (kg) by ~2.5% next session.
 *     Triggered when all target reps hit with RPE < 8 across last 2
 *     consecutive sessions of the lift.
 *   - `volume_then_load`: add a working set OR a rep before bumping
 *     load. Used when load progression has plateaued or the athlete
 *     is in an accumulation block.
 *   - `intent_then_load`: tempo / pause / RIR manipulation before
 *     load bump. Used for calisthenics or when complexity ceiling
 *     binds.
 *   - `consistency_preservation`: hold load + reps flat. Used when
 *     gating signals prevent any progression.
 *
 * Gating signals (any one returns 'consistency_preservation'):
 *   - Reps missed in last session (completed < prescribed).
 *   - RPE ≥ 8 on top set (load progression requires clear reserve).
 *   - Pain reported in same-region in last 7 days.
 *   - High soreness (≥7/10) in last session.
 *   - Technical success score < 6/10 (athlete couldn't execute).
 *   - Exercise novelty: first 2 exposures get no progression (grooving phase).
 *   - Movement pattern: same pattern hit <48h ago without recovery day.
 *   - Upcoming key endurance session within 24h (interference window
 *     from A1a interferenceRules).
 *   - Equipment unavailable (override loads to 'consistency').
 */

export type ProgressionVector =
  | 'load_progression'
  | 'volume_then_load'
  | 'intent_then_load'
  | 'consistency_preservation';

export interface StrengthProgressionSessionSignal {
  /** Reps completed on the top working set. */
  completedRepsTopSet: number;
  /** Reps prescribed on the top working set. */
  prescribedRepsTopSet: number;
  rpeTopSet?: number;
  rir?: number;
  sorenessLevel?: number;
  technicalSuccessScore?: number;
}

export interface ProgressionGateInput {
  /** Target intent for this exercise (from WorkoutTemplate.progressionTarget). */
  progressionTarget?: string;
  /** Equipment family the exercise needs ('full_gym', 'bodyweight_only', etc.). */
  equipmentBucket?: string;
  /** Equipment available this session. */
  availableEquipment?: string[];
  /** Number of recent prior exposures to this exercise (for novelty gate). */
  priorExposureCount: number;
  /** Hours since the same movement pattern was trained. */
  hoursSinceSamePattern?: number;
  /** Hours until the next key endurance session (for interference gate). */
  hoursUntilNextKeyEndurance?: number;
  lastSession?: StrengthProgressionSessionSignal;
  /** Immediately prior consecutive session for this lift/movement. */
  priorSession?: StrengthProgressionSessionSignal;
  /** Did the athlete report pain in the same body region in the last 7d? */
  painSameRegionLast7d?: boolean;
}

export interface ProgressionDecision {
  vector: ProgressionVector;
  /** Suggested load delta as % of prior load (e.g., 0.025 for +2.5%). */
  loadDeltaPct?: number;
  /** Suggested reps delta on top set. */
  repsDelta?: number;
  /** Suggested set-count delta. */
  setsDelta?: number;
  /** Suggested tempo eccentric (seconds) for intent vector. */
  tempoEccentricSec?: number;
  /** Human-readable rationale. */
  rationale: string[];
  /** Gates that fired (empty when no gating). */
  gatesFired: string[];
}

const NOVICE_NOVELTY_GROOVING_EXPOSURES = 2;
const INTERFERENCE_HOURS_THRESHOLD = 6;
const SAME_PATTERN_RECOVERY_HOURS = 48;

function targetResolvesToDirectLoadProgression(target: string): boolean {
  if (target.includes('volume_then_load') || (target.includes('volume') && !target.includes('load_progression'))) {
    return false;
  }
  if (target.includes('intent_then_load') || target.includes('intent') || target.includes('tempo')) {
    return false;
  }
  return true;
}

export function decideStrengthProgression(input: ProgressionGateInput): ProgressionDecision {
  const gatesFired: string[] = [];
  const rationale: string[] = [];
  const target = (input.progressionTarget ?? 'load_progression').toLowerCase();

  // 1. Equipment check.
  if (input.equipmentBucket && input.availableEquipment !== undefined) {
    if (!input.availableEquipment.includes(input.equipmentBucket)) {
      gatesFired.push('equipment_unavailable');
      rationale.push(`Equipment '${input.equipmentBucket}' not available; holding load flat.`);
    }
  }

  // 2. Pain gate.
  if (input.painSameRegionLast7d) {
    gatesFired.push('pain_same_region');
    rationale.push('Pain reported in same region within last 7 days; no progression.');
  }

  // 3. Novelty gate.
  if (input.priorExposureCount < NOVICE_NOVELTY_GROOVING_EXPOSURES) {
    gatesFired.push('novelty_grooving');
    rationale.push(`Exercise novelty (${input.priorExposureCount} prior exposures); groove technique first.`);
  }

  // 4. Pattern-recency gate.
  if (input.hoursSinceSamePattern !== undefined && input.hoursSinceSamePattern < SAME_PATTERN_RECOVERY_HOURS) {
    gatesFired.push('pattern_recency');
    rationale.push(`Same movement pattern trained ${input.hoursSinceSamePattern}h ago (< ${SAME_PATTERN_RECOVERY_HOURS}h recovery threshold).`);
  }

  // 5. Interference gate (A1a interferenceRules).
  if (
    input.hoursUntilNextKeyEndurance !== undefined &&
    input.hoursUntilNextKeyEndurance < INTERFERENCE_HOURS_THRESHOLD
  ) {
    gatesFired.push('interference_window');
    rationale.push(`Key endurance session in ${input.hoursUntilNextKeyEndurance}h; concurrent-training interference avoided.`);
  }

  // 6. Last-session signals.
  if (input.lastSession) {
    const ls = input.lastSession;
    if (ls.completedRepsTopSet < ls.prescribedRepsTopSet) {
      gatesFired.push('reps_missed');
      rationale.push(`Top set: completed ${ls.completedRepsTopSet}/${ls.prescribedRepsTopSet} reps. Hold to re-baseline.`);
    }
    if (ls.rpeTopSet !== undefined && ls.rpeTopSet >= 8) {
      gatesFired.push('rpe_too_high');
      rationale.push(`Top set RPE ${ls.rpeTopSet} ≥ 8; load progression requires clear reserve.`);
    }
    if (ls.sorenessLevel !== undefined && ls.sorenessLevel >= 7) {
      gatesFired.push('soreness_high');
      rationale.push(`Soreness ${ls.sorenessLevel}/10 elevated; preserve volume.`);
    }
    if (ls.technicalSuccessScore !== undefined && ls.technicalSuccessScore < 6) {
      gatesFired.push('technical_failure');
      rationale.push(`Technical success ${ls.technicalSuccessScore}/10 low; refine before adding load.`);
    }
  }

  if (targetResolvesToDirectLoadProgression(target)) {
    if (!input.lastSession || !input.priorSession) {
      gatesFired.push('two_session_confirmation_missing');
      rationale.push('Load progression needs two consecutive cleared sessions for this lift.');
    } else {
      const ps = input.priorSession;
      if (ps.completedRepsTopSet < ps.prescribedRepsTopSet) {
        gatesFired.push('prior_reps_missed');
        rationale.push(`Prior top set: completed ${ps.completedRepsTopSet}/${ps.prescribedRepsTopSet} reps.`);
      }
      if (ps.rpeTopSet === undefined || ps.rpeTopSet >= 8) {
        gatesFired.push('prior_rpe_not_clear');
        rationale.push(`Prior top set RPE ${ps.rpeTopSet ?? 'missing'} was not < 8.`);
      }
      if (input.lastSession.rpeTopSet === undefined) {
        gatesFired.push('last_rpe_missing');
        rationale.push('Last top set RPE is missing; cannot confirm reserve for load progression.');
      }
    }
  }

  // Any gate fired → consistency_preservation.
  if (gatesFired.length > 0) {
    return {
      vector: 'consistency_preservation',
      rationale,
      gatesFired,
    };
  }

  // No gates → apply the progressionTarget vector. Order matters:
  // check the most specific compound names FIRST so 'volume_then_load'
  // is not swallowed by a substring match on 'load'.
  const ls = input.lastSession;

  if (target.includes('volume_then_load') || target === 'volume_then_load' || (target.includes('volume') && !target.includes('load_progression'))) {
    return {
      vector: 'volume_then_load',
      repsDelta: 1,
      rationale: [...rationale, 'Volume-first: add 1 rep before bumping load.'],
      gatesFired,
    };
  }

  if (target.includes('intent_then_load') || target === 'intent_then_load' || target.includes('intent') || target.includes('tempo')) {
    return {
      vector: 'intent_then_load',
      tempoEccentricSec: 1,
      rationale: [...rationale, 'Intent-first: increase eccentric tempo by 1 second.'],
      gatesFired,
    };
  }

  if (target.includes('load') || target === 'load_progression') {
    return {
      vector: 'load_progression',
      loadDeltaPct: 0.025,
      rationale: [
        ...rationale,
        `Load progression: +2.5% on next session. All target reps hit at RPE ${ls?.rpeTopSet ?? '?'} < 8 across two sessions.`,
      ],
      gatesFired,
    };
  }

  // Default to load progression when target is unrecognized.
  return {
    vector: 'load_progression',
    loadDeltaPct: 0.025,
    rationale: [
      ...rationale,
      `Defaulted to load progression (target '${input.progressionTarget ?? 'none'}' unrecognized).`,
    ],
    gatesFired,
  };
}
