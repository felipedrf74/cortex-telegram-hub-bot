// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Data-informed deload recommendation engine — slice B5 of the
 * Week-Level Adaptability + Periodization plan (v2.1).
 *
 * Replaces the hardcoded `weekIndex % 4 === 0` deload trigger in
 * `planner-engine.ts:75` with a composite signal model that respects:
 *
 *   - **Cold-start gating** (B1): when loadModelStatus is 'cold_start'
 *     (<14d completions), ACWR-based signals are disabled. The engine
 *     falls back to scheduled cadence + declared training history
 *     caps.
 *
 *   - **ACWR as soft signal** (Impellizzeri 2020): elevated ACWR
 *     CONTRIBUTES to the risk score but NEVER independently triggers
 *     deload. A deload fires only when scheduled cadence is reached
 *     OR ≥2 independent risk signals concur.
 *
 *   - **HRV pairing rule** (Plews & Buchheit): HRV cannot be the
 *     sole signal. Must pair with ≥1 of {RHR elevated, sleep deficit,
 *     subjective fatigue, performance decline, recent load spike}.
 *
 * Inputs are decoupled from any specific storage layer — caller
 * hydrates a SignalInput from A0c readiness/health + B1 load model +
 * adherence service + plan history.
 */

import {
  getAcwrThresholds,
  getRiskScoreWeights,
  type Principles,
} from './training-principles';
import {
  classifyAcwr,
  type LoadModelStatus,
} from './load-model';

export interface DeloadSignalInput {
  /** From B1 load model. */
  loadModelStatus: LoadModelStatus;
  /** ACWR value (uncoupled preferred per v2.1 critique). */
  acwr?: number;
  /**
   * HRV state over the last 7 days. True when status has been
   * 'low' or 'poor' for ≥3 of the last 7 days (Plews & Buchheit
   * rolling rule).
   */
  hrvDropPersisted?: boolean;
  /** True when last 7d sleep average is <80% of athlete baseline. */
  sleepDeficit?: boolean;
  /** True when RHR is elevated above athlete baseline for ≥3 days. */
  restingHrElevated?: boolean;
  /** True when athlete has reported pain score ≥6 in last 7d. */
  painElevated?: boolean;
  /** True when 2-week rolling adherence has fallen below 0.70. */
  adherenceCollapse?: boolean;
  /** True when subjective fatigue / RPE has been persistently high. */
  subjectiveFatigueHigh?: boolean;
  /** True when recent week-over-week load growth exceeded volume cap. */
  rapidLoadRamp?: boolean;
  /** True when athlete had an illness or training gap in the last 14d. */
  recentGapOrIllness?: boolean;
  /** True when performance has visibly declined (e.g., pace at same RPE). */
  performanceDecline?: boolean;
  /** Weeks since last deload (B3 tracks this in mesocyclePosition). */
  weeksSinceDeload: number;
  /** Scheduled cadence for this athlete level (A1b). */
  scheduledDeloadCadenceWeeks: number;
  /** CoachPlanPolicy.deloadStrategy. */
  deloadStrategy?: 'scheduled' | 'data_informed' | 'hybrid';
}

export type DeloadSignal =
  | 'acwrElevated'
  | 'hrvDropPersisted'
  | 'sleepDeficit'
  | 'painElevated'
  | 'adherenceCollapse'
  | 'rapidLoadRamp'
  | 'recentGapOrIllness'
  | 'subjectiveFatigueHigh'
  | 'performanceDecline'
  | 'restingHrElevated';

export interface DeloadRecommendation {
  triggered: boolean;
  /** When triggered: 'scheduled' (cadence reached) or one of the risk signals. */
  primarySignal: 'scheduled' | DeloadSignal | null;
  contributingSignals: DeloadSignal[];
  /** Composite risk score (sum of weighted signals). */
  riskScore: number;
  /** Confidence in the recommendation. */
  confidence: 'high' | 'medium' | 'low';
  loadModelStatus: LoadModelStatus;
  rationale: string[];
}

/**
 * Generate a deload recommendation from the input signals.
 *
 * Decision logic (in order):
 *   1. If deloadStrategy is 'scheduled' (not hybrid), use cadence only.
 *   2. If cadence reached, deload is triggered.
 *   3. If cold-start status, skip ACWR-based signals.
 *   4. Compute the composite risk score from non-ACWR signals + ACWR.
 *   5. HRV pairing rule: HRV cannot be the sole non-ACWR signal.
 *   6. Deload triggers when ≥2 independent non-ACWR signals concur
 *      AND riskScore ≥ threshold from A1b (default 0.4).
 *   7. Confidence reflects loadModelStatus + signal count.
 */
export function recommendDeload(
  input: DeloadSignalInput,
  principles: Principles,
): DeloadRecommendation {
  const strategy = input.deloadStrategy ?? 'hybrid';
  const acwrThresholds = getAcwrThresholds(principles) ?? {
    underTraining: { min: 0, max: 0.8 },
    lowRisk: { min: 0.8, max: 1.3 },
    moderateRisk: { min: 1.3, max: 1.5 },
    highRisk: { min: 1.5, max: 100 },
  };
  const weights = getRiskScoreWeights(principles) ?? {
    acwrElevated: 0.20,
    hrvDropPersisted: 0.20,
    sleepDeficit: 0.15,
    painElevated: 0.30,
    adherenceCollapse: 0.10,
    rapidLoadRamp: 0.15,
    recentGapOrIllness: 0.20,
  };

  // 1. Scheduled cadence reached?
  const cadenceReached = input.weeksSinceDeload >= input.scheduledDeloadCadenceWeeks;
  if (strategy === 'scheduled') {
    return {
      triggered: cadenceReached,
      primarySignal: cadenceReached ? 'scheduled' : null,
      contributingSignals: [],
      riskScore: 0,
      confidence: 'high',
      loadModelStatus: input.loadModelStatus,
      rationale: cadenceReached
        ? [`Scheduled deload — ${input.weeksSinceDeload} weeks since last deload (cadence ${input.scheduledDeloadCadenceWeeks}w).`]
        : [`No deload (scheduled-only strategy, ${input.weeksSinceDeload}/${input.scheduledDeloadCadenceWeeks} weeks).`],
    };
  }

  // 2. Hybrid + data-informed paths: evaluate signals.
  const coldStart = input.loadModelStatus === 'cold_start';
  const contributingSignals: DeloadSignal[] = [];
  let riskScore = 0;
  const rationale: string[] = [];

  // Cadence as one possible primary signal.
  if (cadenceReached) {
    rationale.push(`Scheduled cadence reached: ${input.weeksSinceDeload}/${input.scheduledDeloadCadenceWeeks}w.`);
  }

  // ACWR — soft signal, gated by cold-start.
  if (!coldStart && input.acwr !== undefined) {
    const band = classifyAcwr(input.acwr, acwrThresholds);
    if (band === 'moderateRisk' || band === 'highRisk') {
      contributingSignals.push('acwrElevated');
      riskScore += weights.acwrElevated;
      rationale.push(`ACWR ${input.acwr.toFixed(2)} → ${band} band (soft signal, cold-start guard ok).`);
    }
  } else if (coldStart && input.acwr !== undefined) {
    rationale.push(`ACWR ${input.acwr.toFixed(2)} ignored — cold-start status (<14d completions).`);
  }

  if (input.painElevated) {
    contributingSignals.push('painElevated');
    riskScore += weights.painElevated;
    rationale.push('Pain elevated in last 7 days.');
  }
  if (input.sleepDeficit) {
    contributingSignals.push('sleepDeficit');
    riskScore += weights.sleepDeficit;
    rationale.push('Sleep deficit (<80% baseline) in last 7 days.');
  }
  if (input.adherenceCollapse) {
    contributingSignals.push('adherenceCollapse');
    riskScore += weights.adherenceCollapse;
    rationale.push('2-week adherence below 70%.');
  }
  if (input.rapidLoadRamp) {
    contributingSignals.push('rapidLoadRamp');
    riskScore += weights.rapidLoadRamp;
    rationale.push('Rapid load ramp exceeded volume cap.');
  }
  if (input.recentGapOrIllness) {
    contributingSignals.push('recentGapOrIllness');
    riskScore += weights.recentGapOrIllness;
    rationale.push('Recent training gap or illness.');
  }
  if (input.subjectiveFatigueHigh) {
    contributingSignals.push('subjectiveFatigueHigh');
    riskScore += 0.10;
    rationale.push('Subjective fatigue persistently high.');
  }
  if (input.performanceDecline) {
    contributingSignals.push('performanceDecline');
    riskScore += 0.10;
    rationale.push('Performance decline observed.');
  }
  if (input.restingHrElevated) {
    contributingSignals.push('restingHrElevated');
    riskScore += 0.10;
    rationale.push('Resting HR elevated ≥3 days.');
  }

  // HRV pairing rule (Plews & Buchheit). HRV is only counted as a
  // contributing signal when at least one OTHER signal supports it.
  const pairingPartners: DeloadSignal[] = [
    'restingHrElevated', 'sleepDeficit', 'subjectiveFatigueHigh',
    'performanceDecline', 'rapidLoadRamp',
  ];
  if (input.hrvDropPersisted) {
    const hasPair = pairingPartners.some((p) => contributingSignals.includes(p));
    if (hasPair) {
      contributingSignals.push('hrvDropPersisted');
      riskScore += weights.hrvDropPersisted;
      rationale.push('HRV drop persisted (paired with another signal).');
    } else {
      rationale.push('HRV drop ignored — no paired signal (Plews & Buchheit rule).');
    }
  }

  // Confidence: high when stable + ≥2 signals; medium when warming;
  // low when cold-start.
  const confidence: DeloadRecommendation['confidence'] =
    coldStart ? 'low' :
    input.loadModelStatus === 'warming' ? 'medium' :
    contributingSignals.length >= 2 ? 'high' : 'medium';

  // Trigger logic:
  //   - cadence reached → trigger (hybrid mode)
  //   - OR ≥2 contributing signals AND riskScore ≥ 0.40
  const dataInformedFires = contributingSignals.length >= 2 && riskScore >= 0.40;
  const triggered = cadenceReached || dataInformedFires;

  // Primary signal: cadence wins if reached; else highest-weight signal.
  let primarySignal: DeloadRecommendation['primarySignal'] = null;
  if (triggered) {
    if (cadenceReached) {
      primarySignal = 'scheduled';
    } else {
      // Pick the signal with the highest weight contributed.
      let bestScore = 0;
      const weightLookup = weights as unknown as Record<string, number>;
      for (const sig of contributingSignals) {
        const w = weightLookup[sig] ?? 0.10;
        if (w > bestScore) {
          bestScore = w;
          primarySignal = sig;
        }
      }
    }
  }

  return {
    triggered,
    primarySignal,
    contributingSignals,
    riskScore: Math.round(riskScore * 100) / 100,
    confidence,
    loadModelStatus: input.loadModelStatus,
    rationale,
  };
}
