// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Deterministic safety guardrails — non-medical, non-diagnostic.
 *
 * Coach product surfaces (Today screen, Week Plan banner, coach
 * briefing) need to produce SAFE responses to common athlete signals:
 *
 *   • Acute pain reported during a session → halt, simplify, suggest
 *     consultation.
 *   • Persistent fatigue / under-fueling pattern → non-diagnostic
 *     warning + referral.
 *   • Pregnancy / postpartum / menstrual symptoms → professional
 *     consultation referral.
 *   • Stress-fracture warning signs (focal sharp pain on weight-bearing
 *     activity) → stop running + referral.
 *   • Disordered eating risk signals → referral; never coach.
 *   • Direct medical-question prompts → refer to a clinician; never
 *     diagnose.
 *   • Anti-doping / supplement risk → general "consult sports physician
 *     and check WADA list" copy.
 *
 * This module is the deterministic language source for those surfaces.
 * The model/LLM may rephrase or add empathetic context, but the
 * canonical referral phrasing comes from here so we never accidentally
 * pretend to be a clinician.
 *
 * The function `evaluateSafetyContext` accepts a typed input and returns
 * a structured verdict the caller can render as a banner / coach line /
 * structured response. Inputs that don't trigger any rule produce a
 * neutral pass-through, so callers can always invoke it.
 */

export type SafetyDomain =
  | 'acute_pain_during_session'
  | 'persistent_fatigue'
  | 'under_fueling_signs'
  | 'pregnancy_or_postpartum'
  | 'menstrual_symptoms_severe'
  | 'stress_fracture_warning'
  | 'disordered_eating_risk'
  | 'direct_medical_question'
  | 'anti_doping_supplement_question';

export type SafetySeverity = 'block' | 'warn' | 'inform';

export interface SafetyFinding {
  domain: SafetyDomain;
  severity: SafetySeverity;
  /** Human-readable rationale ("knee pain reported during run"). */
  triggerSummary: string;
  /**
   * The canonical safe response copy. NEVER includes a diagnosis or
   * treatment instruction. Always includes a referral line.
   */
  referralCopy: string;
  /** Suggested coach action ("halt session", "swap to mobility", etc.). */
  recommendedAction: string;
}

export interface SafetyEvaluationResult {
  status: 'pass' | 'flag';
  findings: SafetyFinding[];
  /**
   * One-line user-facing copy if any finding has severity 'block' or
   * 'warn'. Empty when status === 'pass'.
   */
  topMessage: string;
}

/** Severity vocabulary for incoming pain-flag signals. */
export type PainSeverity = 'low' | 'moderate' | 'high';

export interface SafetyEvaluationInput {
  /** Pain reported during the most recent session. */
  acuteSessionPain?: {
    bodyArea: string;
    severity: PainSeverity;
    onset: 'gradual' | 'sudden';
    weightBearing: boolean;
  };
  /** Patterns that suggest under-fueling without medical diagnosis. */
  fatiguePattern?: {
    consecutiveLowEnergyDays?: number;
    consecutiveLowAdherenceWeeks?: number;
    sleepDeficitNights?: number;
  };
  /** User-reported flags. We never infer pregnancy/postpartum/etc. */
  selfReportedFlags?: {
    pregnant?: boolean;
    postpartum?: boolean;
    severeMenstrualSymptoms?: boolean;
    disorderedEatingConcern?: boolean;
  };
  /** Direct user question text (free-form). */
  userQuestionText?: string;
  /** Was this triggered from supplement/doping context? */
  fromSupplementContext?: boolean;
}

const REFERRAL_BASE =
  'I can adjust the plan, but I am not a clinician. ' +
  'Please see a qualified medical or sports-medicine professional for evaluation.';

function buildAcutePainFinding(input: NonNullable<SafetyEvaluationInput['acuteSessionPain']>): SafetyFinding {
  const block =
    input.severity === 'high' ||
    (input.severity === 'moderate' && input.weightBearing && input.onset === 'sudden');
  const stressFractureSuspect =
    input.weightBearing &&
    input.onset === 'sudden' &&
    /\b(shin|tibia|foot|metatarsal|hip|femur|pelvis)\b/i.test(input.bodyArea);
  if (stressFractureSuspect) {
    return {
      domain: 'stress_fracture_warning',
      severity: 'block',
      triggerSummary: `${input.bodyArea} sudden weight-bearing pain (${input.severity})`,
      referralCopy:
        `Sharp, sudden, weight-bearing pain in the ${input.bodyArea} can be a stress-related ` +
        `bone or tendon injury. Stop weight-bearing training immediately and consult a sports-medicine ` +
        `professional before resuming. ${REFERRAL_BASE}`,
      recommendedAction:
        'Halt running and high-impact training. Substitute non-weight-bearing modalities (pool, bike) ' +
        'only after a medical evaluation clears it.',
    };
  }
  return {
    domain: 'acute_pain_during_session',
    severity: block ? 'block' : 'warn',
    triggerSummary: `${input.bodyArea} pain (${input.severity}, ${input.onset})`,
    referralCopy:
      `You reported ${input.severity} pain in your ${input.bodyArea} during the session. ` +
      `Pain is information — please don't push through it. ${REFERRAL_BASE}`,
    recommendedAction: block
      ? 'Halt the session. Swap to mobility, stretching, or rest until evaluated.'
      : 'Reduce intensity, finish gentle, and skip the next hard session if pain persists.',
  };
}

function buildFatigueFinding(
  input: NonNullable<SafetyEvaluationInput['fatiguePattern']>,
): SafetyFinding | null {
  const lowEnergy = input.consecutiveLowEnergyDays ?? 0;
  const lowAdherence = input.consecutiveLowAdherenceWeeks ?? 0;
  const sleepDeficit = input.sleepDeficitNights ?? 0;
  if (lowEnergy < 5 && lowAdherence < 2 && sleepDeficit < 5) return null;
  return {
    domain: 'persistent_fatigue',
    severity: 'warn',
    triggerSummary: `low energy ${lowEnergy}d / low adherence ${lowAdherence}w / sleep deficit ${sleepDeficit}n`,
    referralCopy:
      `You've been showing persistent fatigue signals. This can come from many things — ` +
      `under-fueling, insufficient sleep, life stress, illness, hormonal shifts, or training overload. ` +
      `${REFERRAL_BASE}`,
    recommendedAction:
      'Reduce volume and intensity for 1–2 weeks, prioritize sleep + fueling, and consider ' +
      'a medical check if the pattern persists.',
  };
}

function buildSelfReportedFinding(input: NonNullable<SafetyEvaluationInput['selfReportedFlags']>): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  if (input.pregnant || input.postpartum) {
    findings.push({
      domain: 'pregnancy_or_postpartum',
      severity: 'block',
      triggerSummary: input.pregnant ? 'self-reported pregnancy' : 'self-reported postpartum',
      referralCopy:
        `Training during pregnancy and the postpartum period requires individualized guidance ` +
        `from your obstetric and pelvic-health providers. ${REFERRAL_BASE}`,
      recommendedAction:
        'Coach in maintenance / gentle-return mode only after medical clearance. Swap any high-impact ' +
        'or breath-hold work for low-impact alternatives until cleared.',
    });
  }
  if (input.severeMenstrualSymptoms) {
    findings.push({
      domain: 'menstrual_symptoms_severe',
      severity: 'warn',
      triggerSummary: 'self-reported severe menstrual symptoms',
      referralCopy:
        `Severe period pain or heavy bleeding that interferes with training is worth investigating. ` +
        `${REFERRAL_BASE}`,
      recommendedAction:
        'Reduce intensity for 1–3 days and consider seeing a healthcare professional if the pattern is recurrent.',
    });
  }
  if (input.disorderedEatingConcern) {
    findings.push({
      domain: 'disordered_eating_risk',
      severity: 'block',
      triggerSummary: 'self-reported disordered-eating concern',
      referralCopy:
        `Eating concerns deserve specialist support. I am not the right tool for this. ` +
        `Please reach out to a registered dietitian, sports-medicine doctor, or mental-health ` +
        `professional. ${REFERRAL_BASE}`,
      recommendedAction:
        'Halt new performance-prescription. Hold maintenance volume only. Surface this referral ' +
        'message and stop coaching.',
    });
  }
  return findings;
}

const MEDICAL_QUESTION_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(diagnos\w+)/i,
  /\b(should i take|prescribe|medication|drug|antibiotic|painkiller)/i,
  /\b(injection|surgery|x[- ]ray|mri|imaging|scan|treatment)/i,
  /\b(do i have|am i (going to )?(have|getting)|is this serious)/i,
  /\b(blood test|lab work|labs?)\b/i,
];

function buildMedicalQuestionFinding(text: string): SafetyFinding | null {
  for (const pattern of MEDICAL_QUESTION_PATTERNS) {
    if (pattern.test(text)) {
      return {
        domain: 'direct_medical_question',
        severity: 'warn',
        triggerSummary: `medical-question phrasing matched ${pattern.source}`,
        referralCopy:
          `That's a medical question I can't answer responsibly. ${REFERRAL_BASE}`,
        recommendedAction:
          'Decline the diagnostic / prescriptive question. Offer only non-medical training adjustments ' +
          'while waiting for the clinical answer.',
      };
    }
  }
  return null;
}

function buildSupplementFinding(input: SafetyEvaluationInput): SafetyFinding | null {
  if (!input.fromSupplementContext && !input.userQuestionText) return null;
  const matchesSupplementText = input.userQuestionText
    ? /\b(supplement|creatine|protein|caffeine|beta[- ]alanine|nitrate|sarms|peptide|tren|test\w+|epo|hgh|stimulant|preworkout|fat[- ]burner)\b/i.test(input.userQuestionText)
    : false;
  if (!input.fromSupplementContext && !matchesSupplementText) return null;
  return {
    domain: 'anti_doping_supplement_question',
    severity: 'inform',
    triggerSummary: 'supplement / anti-doping context',
    referralCopy:
      `Supplements are highly individual and have anti-doping risk in tested sports. ` +
      `Please consult a sports physician or registered dietitian and verify any product against ` +
      `current WADA / competition-body rules. ${REFERRAL_BASE}`,
    recommendedAction:
      'Do not endorse, recommend, or program any specific supplement. Surface the referral copy and stop.',
  };
}

/**
 * Run every guardrail rule against the input and produce a structured
 * verdict. The caller decides whether to render `topMessage` as a UI
 * banner, log to decision-trail, or attach to the coach response.
 */
export function evaluateSafetyContext(input: SafetyEvaluationInput): SafetyEvaluationResult {
  const findings: SafetyFinding[] = [];
  if (input.acuteSessionPain) findings.push(buildAcutePainFinding(input.acuteSessionPain));
  if (input.fatiguePattern) {
    const f = buildFatigueFinding(input.fatiguePattern);
    if (f) findings.push(f);
  }
  if (input.selfReportedFlags) findings.push(...buildSelfReportedFinding(input.selfReportedFlags));
  if (input.userQuestionText) {
    const med = buildMedicalQuestionFinding(input.userQuestionText);
    if (med) findings.push(med);
  }
  const supp = buildSupplementFinding(input);
  if (supp) findings.push(supp);
  if (findings.length === 0) {
    return { status: 'pass', findings: [], topMessage: '' };
  }
  // Pick the top message: blocker > warn > inform; on tie, the first one wins.
  const sortedBySeverity = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return {
    status: 'flag',
    findings,
    topMessage: sortedBySeverity[0].referralCopy,
  };
}

function severityRank(s: SafetySeverity): number {
  switch (s) {
    case 'block':
      return 0;
    case 'warn':
      return 1;
    case 'inform':
      return 2;
  }
}

/**
 * Convenience: deterministic disclaimer line every coach surface should
 * append once per response when ANY clinical / safety topic is touched.
 * Keep it short — the model often shortens or expands; this is the
 * canonical baseline.
 */
export const COACH_NON_DIAGNOSTIC_DISCLAIMER =
  'I am a training coach, not a clinician. For symptoms, pain, or anything that worries you, ' +
  'please consult a qualified medical or sports-medicine professional.';
