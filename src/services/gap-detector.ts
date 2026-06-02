// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Gap detector with ReturnProtocol classification — slice C4 of the
 * Week-Level Adaptability + Periodization plan (v2.1).
 *
 * Replaces v1's "illness < injury < vacation" ordinal ranking with
 * a typed `ReturnProtocol` discriminator. The protocol is INFERRED
 * from concurrent A0c health signals during the gap window (illness
 * symptoms, fever, injury status), or DECLARED by the athlete.
 *
 * Protocols (per CSCCa/NSCA safe return-to-training guidance):
 *   - vacation_or_life_gap: clean break, fastest ramp.
 *   - minor_illness_resolved: light cold without fever; moderate ramp.
 *   - febrile_or_systemic_illness: fever / COVID / GI distress; slow ramp.
 *   - injury_localized: structural injury to a specific area; medium ramp.
 *   - post_exertional_symptom_risk: post-viral / long COVID; slowest ramp.
 *   - unknown_conservative: default when no signal supports inference.
 *
 * Each protocol has its own ramp coefficients in A1b's
 * `returnFromGapRamps`. The engine reads `protocol` from this
 * detector and uses A1b to apply the right week-1 % and weekly
 * increase.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { findIllnessSignalsInRange, findPainSignalsInRange } from './health-signals';
import type { ReturnProtocol } from './coach-kernel/training-principles';

export interface GapSignal {
  userId: number;
  gapDays: number;
  lastCompletionDate: string | null;
  protocol: ReturnProtocol;
  inferenceRationale: string;
}

export interface DetectTrainingGapInput {
  userId: number;
  /** ISO date "now" — caller-controllable. */
  asOfISODate: string;
  /** Minimum gap (days) to consider noteworthy. Default 7. */
  minGapDays?: number;
  /**
   * Look-back window (days) for concurrent health signals when
   * classifying the protocol. Default 30.
   */
  signalLookbackDays?: number;
  /** Explicit override from the user — wins over inference. */
  declaredProtocol?: ReturnProtocol;
}

const FEVER_OR_SYSTEMIC_SYMPTOMS = new Set([
  'fever', 'covid', 'gi_distress', 'systemic_fatigue', 'chest_congestion', 'shortness_of_breath',
]);

const POST_EXERTIONAL_SYMPTOMS = new Set([
  'post_exertional_malaise', 'post_viral_fatigue', 'long_covid',
]);

/**
 * Detect a training gap + classify the return protocol.
 *
 * Algorithm:
 *   1. Find the most recent training_completions row for the user.
 *   2. If the gap (now - lastCompletion) ≥ minGapDays, classify.
 *   3. Classification precedence:
 *      a. Explicit declaredProtocol wins.
 *      b. Post-exertional symptoms → post_exertional_symptom_risk.
 *      c. Fever or systemic illness symptoms → febrile_or_systemic_illness.
 *      d. Any pain reported in gap window → injury_localized.
 *      e. Non-fever illness symptoms → minor_illness_resolved.
 *      f. No signals at all → vacation_or_life_gap.
 *      g. Falls through → unknown_conservative.
 *
 * Returns null when no gap is detected (lastCompletion within minGapDays).
 */
export function detectTrainingGap(input: DetectTrainingGapInput): GapSignal | null {
  const minGap = input.minGapDays ?? 7;
  const lookback = input.signalLookbackDays ?? 30;
  const db = getDb();

  const latest = db.prepare(`
    SELECT MAX(completed_at) AS last_completion
    FROM training_completions tc
    JOIN fitness_training_plans p ON p.id = tc.plan_id
    WHERE p.user_id = ?
  `).get(input.userId) as { last_completion: string | null } | undefined;

  const lastCompletion = latest?.last_completion ?? null;
  const nowMs = Date.parse(input.asOfISODate);
  if (!Number.isFinite(nowMs)) return null;

  const gapDays = lastCompletion
    ? Math.floor((nowMs - Date.parse(lastCompletion)) / (24 * 3600 * 1000))
    : 999; // no completion ever → very large gap

  if (gapDays < minGap) return null;

  // Collect concurrent health signals.
  const lookbackStart = new Date(nowMs - lookback * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const lookbackEnd = input.asOfISODate.slice(0, 10);
  const illnessSignals = findIllnessSignalsInRange(input.userId, lookbackStart, lookbackEnd);
  const painSignals = findPainSignalsInRange(input.userId, lookbackStart, lookbackEnd);

  let protocol: ReturnProtocol = 'unknown_conservative';
  let rationale = `${gapDays}-day gap, no concurrent signals — defaulting to conservative ramp.`;

  // Declared override wins.
  if (input.declaredProtocol) {
    protocol = input.declaredProtocol;
    rationale = `User-declared protocol: ${input.declaredProtocol}`;
  } else {
    // Inspect symptoms from illness signals.
    const allSymptoms = new Set<string>();
    for (const s of illnessSignals) {
      if (!s.illness_symptoms_json) continue;
      try {
        const arr = JSON.parse(s.illness_symptoms_json) as string[];
        for (const sym of arr) allSymptoms.add(sym.toLowerCase());
      } catch (err) {
        // R8 P1-3 — corrupt illness_symptoms_json was silently
        // skipped, which downgrades an illness gap to "vacation"
        // and applies the wrong return-from-gap ramp (the safety
        // ramp for febrile/systemic illness is much more
        // conservative). Log so SRE can spot recurring corruption
        // and so an operator can correlate a misclassified gap.
        logger.warn(
          { userId: input.userId, signalId: s.id, err },
          'gap_detector.illness_symptoms_parse_failed',
        );
      }
    }

    const hasPostExertional = Array.from(allSymptoms).some((s) => POST_EXERTIONAL_SYMPTOMS.has(s));
    const hasFeverOrSystemic = Array.from(allSymptoms).some((s) => FEVER_OR_SYSTEMIC_SYMPTOMS.has(s));
    const hasOtherIllness = illnessSignals.length > 0 && !hasFeverOrSystemic && !hasPostExertional;
    const hasInjuryOrPain = painSignals.length > 0;

    if (hasPostExertional) {
      protocol = 'post_exertional_symptom_risk';
      rationale = `${gapDays}-day gap with post-exertional symptoms in the look-back window.`;
    } else if (hasFeverOrSystemic) {
      protocol = 'febrile_or_systemic_illness';
      rationale = `${gapDays}-day gap with fever / systemic illness symptoms.`;
    } else if (hasInjuryOrPain) {
      protocol = 'injury_localized';
      rationale = `${gapDays}-day gap with localized pain signals.`;
    } else if (hasOtherIllness) {
      protocol = 'minor_illness_resolved';
      rationale = `${gapDays}-day gap with non-fever illness symptoms (treated as resolved).`;
    } else if (illnessSignals.length === 0 && painSignals.length === 0) {
      protocol = 'vacation_or_life_gap';
      rationale = `${gapDays}-day gap with no concurrent health signals; treating as vacation / life gap.`;
    }
  }

  logger.info({ userId: input.userId, gapDays, protocol }, 'gap_detector.classified');
  return {
    userId: input.userId,
    gapDays,
    lastCompletionDate: lastCompletion,
    protocol,
    inferenceRationale: rationale,
  };
}
