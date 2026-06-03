// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Safety wiring — slice A4 of the Week-Level Adaptability +
 * Periodization plan (v2.1).
 *
 * Bridges A0c's `HealthSignal` events to the existing
 * `safety-guardrails.ts` module (kept in PR 3 §D1 with 17 dedicated
 * tests and clinical-referral copy) and emits `TrainingDecisionReason`
 * entries that engines and read-models consume.
 *
 * Critical distinction (v2.1 critique):
 *
 *   - **Typed/structured red-flag input** (form-selected chest pain,
 *     fainting, severe dizziness, acute injury, fever, worsening
 *     localized pain): triggers HARD PAUSE with severity 'block' and
 *     a `medical_referral` decision-reason. User-facing copy uses the
 *     gentler `seek_professional_support` phrasing; the internal code
 *     constant remains `medical_referral`.
 *
 *   - **Inferred red-flag input** (free-text mention, weak signals,
 *     symptom clusters): triggers WARNING ONLY with severity 'warning'
 *     and a `safety_warning_inferred` reason. The plan continues; the
 *     coach surfaces a recommendation but does not hard-pause.
 *
 * This prevents two failure modes:
 *   1. False positives from ambiguous text ("my chest hurts a bit
 *      from yesterday's bench press") triggering a real pause.
 *   2. Real medical events being silently ignored because the
 *      intake was free-text.
 *
 * The iOS dependency: structured intake controls for the typed
 * red-flag set are required for the hard-pause path. Until iOS
 * ships them, hard-pause fires only when the backend receives the
 * typed shape via API (`source: 'structured_intake'`).
 */

import type {
  HealthSignal,
  TrainingDecisionReason,
} from './types';
import {
  evaluateSafetyContext,
  type SafetyEvaluationInput,
  type SafetyEvaluationResult,
  type SafetyFinding,
} from './safety-guardrails';

/**
 * User-facing copy template that replaces internal `medical_referral`
 * in any decision-reason surfaced to the athlete. Internal code is
 * kept for analytics + ledger queries; surface text is gentler.
 */
export const SEEK_PROFESSIONAL_SUPPORT_COPY =
  'For your safety, please consult a qualified healthcare professional ' +
  'before continuing with this training plan.';

/**
 * Trigger types considered HARD-PAUSE when they arrive via structured
 * intake. The set is conservative — typed input only; free-text
 * variants fall through to warning-only.
 */
const HARD_PAUSE_TYPED_TRIGGERS: ReadonlySet<string> = new Set([
  'chest_pain',
  'fainting',
  'severe_dizziness',
  'acute_injury',
  'fever_or_systemic_illness',
  'worsening_localized_pain',
  'unexplained_performance_collapse',
  'red_s_high_risk',
]);

export type SafetySource = 'structured_intake' | 'inferred_text' | 'wearable' | 'unknown';

/**
 * R3 P1 fix — derive `{source, triggerType}` from a HealthSignal so
 * the runtime path can actually emit `pause_training` when the
 * athlete reports a typed red flag.
 *
 * Two-tier mapping per the v2.1 contract:
 *
 *   - **Structured intake** (`signal.source === 'structured_intake'`
 *     or the row carries a typed red-flag symptom): produces a
 *     concrete triggerType from `HARD_PAUSE_TYPED_TRIGGERS` so
 *     `wireHealthSignalToSafety` can return `block`.
 *
 *   - **Inferred / wearable / unknown**: produces `source='wearable'`
 *     and `triggerType=undefined`, which yields warning-only output
 *     even on severe pain — the v2.1 plan is explicit that inferred
 *     text never hard-pauses.
 *
 * Recognized red-flag symptoms (case-insensitive substring match on
 * each illness symptom string):
 *   - 'chest_pain'         → triggerType='chest_pain'
 *   - 'fainting'           → 'fainting'
 *   - 'severe_dizziness'   → 'severe_dizziness'
 *   - 'fever'              → 'fever_or_systemic_illness'
 *   - 'acute_injury'       → 'acute_injury'
 *   - 'worsening_pain'     → 'worsening_localized_pain'
 *
 * Also: `signal.energyAvailabilityRisk === 'high'` with
 * `source === 'structured_intake'` → triggerType='red_s_high_risk'.
 *
 * Severe structured pain (`painScore >= 7`) with a typed location is
 * also a hard-pause trigger. Chest locations map to `chest_pain`;
 * other locations map to `worsening_localized_pain`.
 */
export function deriveSafetyTriggerFromSignal(signal: {
  source?: string;
  illnessSymptoms?: readonly string[];
  injuryStatus?: string;
  energyAvailabilityRisk?: string;
  painScore?: number;
  painLocation?: string;
}): { source: SafetySource; triggerType?: string } {
  const isStructured = signal.source === 'structured_intake';
  const baseSource: SafetySource = isStructured ? 'structured_intake' : 'wearable';

  if (!isStructured) return { source: baseSource };

  // Structured intake — derive a concrete triggerType when one of
  // the red-flag symptom markers is present.
  const symptoms = (signal.illnessSymptoms ?? []).map((s) => s.toLowerCase());
  const painLocation = signal.painLocation?.trim().toLowerCase() ?? '';
  if (symptoms.some((s) => s.includes('chest_pain') || s.includes('chest pain'))) {
    return { source: 'structured_intake', triggerType: 'chest_pain' };
  }
  if (symptoms.some((s) => s.includes('fainting'))) {
    return { source: 'structured_intake', triggerType: 'fainting' };
  }
  if (symptoms.some((s) => s.includes('severe_dizziness') || s.includes('severe dizziness'))) {
    return { source: 'structured_intake', triggerType: 'severe_dizziness' };
  }
  if (symptoms.some((s) => s.includes('fever'))) {
    return { source: 'structured_intake', triggerType: 'fever_or_systemic_illness' };
  }
  if (signal.energyAvailabilityRisk === 'high') {
    return { source: 'structured_intake', triggerType: 'red_s_high_risk' };
  }
  if (
    typeof signal.painScore === 'number' &&
    signal.painScore >= 7 &&
    painLocation.length > 0
  ) {
    if (painLocation.includes('chest') || painLocation.includes('peito')) {
      return { source: 'structured_intake', triggerType: 'chest_pain' };
    }
    return { source: 'structured_intake', triggerType: 'worsening_localized_pain' };
  }
  if (signal.injuryStatus === 'acute') {
    return { source: 'structured_intake', triggerType: 'acute_injury' };
  }
  if (
    typeof signal.painScore === 'number' &&
    signal.painScore >= 7 &&
    symptoms.some((s) => s.includes('worsening') || s.includes('worse'))
  ) {
    return { source: 'structured_intake', triggerType: 'worsening_localized_pain' };
  }
  // Structured intake but no red-flag symptom — keep structured
  // source so the wiring still recognizes intake provenance, but
  // emit no triggerType (warning-only path).
  return { source: 'structured_intake' };
}

export interface WireHealthSignalInput {
  /** The athlete's most recent HealthSignal (A0c). */
  signal: HealthSignal;
  /**
   * Where the signal came from. Determines typed-vs-inferred path:
   *   - structured_intake → hard-pause path enabled
   *   - inferred_text / wearable / unknown → warning-only path
   */
  source: SafetySource;
  /**
   * Structured trigger discriminator (e.g., 'chest_pain', 'fever').
   * Required for the hard-pause path; if missing, the wiring falls
   * through to warning-only even when source is structured_intake.
   */
  triggerType?: string;
  /** ISO date of the affected entity (week/session). */
  affectedDate?: string;
}

export interface WireHealthSignalOutput {
  decisionReasons: TrainingDecisionReason[];
  /**
   * Effective severity for the plan. 'block' pauses prescription;
   * 'warning' surfaces but allows the plan to continue.
   */
  effectiveSeverity: 'pass' | 'warning' | 'block';
  /** Underlying safety evaluation for audit/debugging. */
  safetyEvaluation: SafetyEvaluationResult;
}

/**
 * Map a HealthSignal into SafetyEvaluationInput. Conservative: we
 * only fill fields when the corresponding consent scope is present.
 * (The HealthSignal itself was already consent-filtered at A0c, but
 * we re-check here to avoid surprises if the wiring layer ever sees
 * a signal from a non-A0c source.)
 */
/**
 * R4 P1 fix overload — accepts an explicit `triggerType` so the
 * structured-intake path can hand the SafetyEvaluationInput a
 * `typedRedFlagTrigger` value. When the trigger is one of the
 * known HARD_PAUSE_TYPED_TRIGGERS, the resulting evaluation
 * ALWAYS emits a block-level finding (see
 * safety-guardrails.ts:buildTypedRedFlagFinding).
 */
export function mapHealthSignalToSafetyInput(
  signal: HealthSignal,
  triggerType?: string,
): SafetyEvaluationInput {
  const input: SafetyEvaluationInput = {};
  const scopes = new Set(signal.consentScope);

  // R4 P1 — promote the typed trigger to the evaluation input so the
  // guardrails module can emit a domain-specific block finding.
  if (triggerType && HARD_PAUSE_TYPED_TRIGGERS.has(triggerType)) {
    input.typedRedFlagTrigger = triggerType as SafetyEvaluationInput['typedRedFlagTrigger'];
  }

  if (scopes.has('pain') && signal.painScore !== undefined && signal.painLocation) {
    input.acuteSessionPain = {
      bodyArea: signal.painLocation,
      severity:
        signal.painScore >= 7 ? 'high' : signal.painScore >= 4 ? 'moderate' : 'low',
      onset: 'gradual', // sourced text doesn't carry onset; default to gradual.
      weightBearing: true, // conservative default; structured intake should override.
    };
  }

  if (
    scopes.has('illness') &&
    signal.illnessSymptoms &&
    signal.illnessSymptoms.length > 0
  ) {
    if (signal.illnessSymptoms.includes('fever')) {
      input.selfReportedFlags = {
        ...(input.selfReportedFlags ?? {}),
        feverPresent: true,
      };
    } else {
      // Non-fever illness — route through the fatigue pattern path.
      input.fatiguePattern = {
        consecutiveLowEnergyDays: signal.illnessSymptoms.length >= 3 ? 5 : 3,
      };
    }
  }

  if (scopes.has('red_s_screening') && signal.energyAvailabilityRisk) {
    input.selfReportedFlags = {
      ...(input.selfReportedFlags ?? {}),
      energyAvailabilityRisk: signal.energyAvailabilityRisk,
    };
  }

  return input;
}

/**
 * Convert SafetyFindings (from the existing safety-guardrails
 * module) into TrainingDecisionReason entries. Each finding becomes
 * one reason; severity maps:
 *   - SafetyFinding 'block' → TrainingDecisionReason 'block' (hard pause)
 *   - 'warn' → 'warning'
 *   - 'inform' → 'notice'
 */
function findingsToDecisionReasons(
  findings: readonly SafetyFinding[],
  source: SafetySource,
  triggerType: string | undefined,
  affectedDate: string | undefined,
): TrainingDecisionReason[] {
  return findings.map((finding): TrainingDecisionReason => {
    const severity =
      finding.severity === 'block' ? 'block' :
      finding.severity === 'warn' ? 'warning' :
      'notice';

    const isTypedHardPause =
      source === 'structured_intake' &&
      triggerType !== undefined &&
      HARD_PAUSE_TYPED_TRIGGERS.has(triggerType);

    const code = isTypedHardPause
      ? 'medical_referral'
      : finding.severity === 'block'
        ? 'medical_referral'
        : finding.domain === 'acute_pain_during_session'
          ? 'pain_flag'
          : finding.domain === 'persistent_fatigue' ||
            finding.domain === 'under_fueling_signs'
            ? 'illness_flag'
            : 'safety_warning_inferred';

    // User-facing copy distinguishes typed hard-pause from inferred warning.
    const text = code === 'medical_referral'
      ? SEEK_PROFESSIONAL_SUPPORT_COPY
      : finding.referralCopy;

    return {
      code,
      text,
      severity,
      affectedEntity: {
        type: 'week',
        id: affectedDate,
      },
      sourceConstraint: {
        type: 'safety',
        id: finding.domain,
        label: finding.triggerSummary,
      },
      evidence: [
        `source=${source}`,
        triggerType ? `trigger=${triggerType}` : '',
        finding.recommendedAction,
      ].filter((s): s is string => s.length > 0),
    };
  });
}

/**
 * Wire a HealthSignal through the safety guardrails. Returns
 * TrainingDecisionReason entries for any safety findings + the
 * effective severity for the plan.
 *
 * Hard-pause (effectiveSeverity === 'block') occurs when structured
 * intake either carries a typed hard-pause trigger or the underlying
 * safety evaluation produced a block finding from structured inputs.
 *
 * All other paths emit warnings — visible to the athlete, never
 * silently dropped, but the prescription continues.
 */
export function wireHealthSignalToSafety(
  input: WireHealthSignalInput,
): WireHealthSignalOutput {
  // R4 P1 — forward triggerType to the mapper ONLY when source is
  // structured_intake. Inferred / wearable / unknown sources must
  // not produce typed red-flag findings — the v2.1 contract is
  // "typed input hard-pauses, inferred input warns".
  const triggerTypeForMap = input.source === 'structured_intake' ? input.triggerType : undefined;
  const safetyInput = mapHealthSignalToSafetyInput(input.signal, triggerTypeForMap);
  const safetyEvaluation = evaluateSafetyContext(safetyInput);

  if (safetyEvaluation.status === 'pass') {
    return {
      decisionReasons: [],
      effectiveSeverity: 'pass',
      safetyEvaluation,
    };
  }

  const decisionReasons = findingsToDecisionReasons(
    safetyEvaluation.findings,
    input.source,
    input.triggerType,
    input.affectedDate,
  );

  // Determine effective severity: block only when typed-hard-pause path
  // AND an underlying 'block' finding exists.
  const hasTypedHardPause =
    input.source === 'structured_intake' &&
    input.triggerType !== undefined &&
    HARD_PAUSE_TYPED_TRIGGERS.has(input.triggerType);

  const hasBlockFinding = safetyEvaluation.findings.some((f) => f.severity === 'block');
  const hasStructuredBlockFinding =
    input.source === 'structured_intake' && hasBlockFinding;

  const effectiveSeverity: 'pass' | 'warning' | 'block' =
    (hasTypedHardPause && hasBlockFinding) || hasStructuredBlockFinding
      ? 'block'
      : 'warning';

  return {
    decisionReasons,
    effectiveSeverity,
    safetyEvaluation,
  };
}
