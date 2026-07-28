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
    /** Slice A4 — fever / systemic illness reported. */
    feverPresent?: boolean;
    /** Slice A4 — RED-S risk screening. */
    energyAvailabilityRisk?: 'low' | 'moderate' | 'high';
  };
  /** Direct user question text (free-form). */
  userQuestionText?: string;
  /** Was this triggered from supplement/doping context? */
  fromSupplementContext?: boolean;
  /**
   * R4 P1 fix — Typed red-flag trigger from a structured intake
   * surface (e.g., iOS form). Each value here ALWAYS produces a
   * `block` finding with a domain-specific referral, regardless of
   * whether other input fields are set. Before this field existed,
   * a structured intake of `chest_pain` / `fainting` / `acute_injury`
   * would arrive without any pain-score or fever flag and the
   * evaluation would return `pass` — a paper hard-pause.
   *
   * Inferred (free-text) flags should NOT set this field; they must
   * flow through the existing `acuteSessionPain` / `fatiguePattern`
   * / `selfReportedFlags` paths so the warning-only-from-inference
   * contract holds.
   */
  typedRedFlagTrigger?:
    | 'chest_pain'
    | 'fainting'
    | 'severe_dizziness'
    | 'acute_injury'
    | 'worsening_localized_pain'
    | 'fever_or_systemic_illness'
    | 'red_s_high_risk'
    | 'unexplained_performance_collapse';
  /**
   * Inferred (free-text) red flags — the chat path. Uses the SAME trigger
   * vocabulary as `typedRedFlagTrigger` and the SAME referral copy, but
   * every finding is emitted at `warn`, never `block`. That preserves the
   * safety-wiring v2.1 contract ("typed input hard-pauses, inferred input
   * warns"): an ambiguous sentence in ordinary chat surfaces a referral,
   * it never pauses a prescription.
   *
   * Populated by `detectInferredRedFlagTriggers` / `evaluateChatMessageSafety`.
   * Structured intake must keep using `typedRedFlagTrigger`.
   */
  inferredRedFlagTriggers?: ReadonlyArray<NonNullable<SafetyEvaluationInput['typedRedFlagTrigger']>>;
  /**
   * Which medical-question pattern set applies to `userQuestionText`.
   *
   * `intake` (the default, and the only value the plan-generation path
   * uses) keeps the original broad `MEDICAL_QUESTION_PATTERNS`. That set
   * was written for a structured intake form, where a sentence is already
   * known to be about the athlete's body, so "do i have…" / "should i
   * take…" are safe cues.
   *
   * `chat` swaps in `CHAT_MEDICAL_QUESTION_PATTERNS` — the prescriptive /
   * diagnostic subset. Open chat is full of "should I take a rest day?",
   * "do I have a session tomorrow?" and "scan my week", none of which are
   * medical questions, and surfacing a clinical referral on them is a
   * visible product regression.
   */
  questionTier?: MedicalQuestionTier;
}

/** Which medical-question vocabulary applies — see `questionTier`. */
export type MedicalQuestionTier = 'intake' | 'chat';

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
  // Slice A4 — fever/systemic illness reported.
  if (input.feverPresent) {
    findings.push({
      domain: 'persistent_fatigue',
      severity: 'block',
      triggerSummary: 'self-reported fever or systemic illness',
      referralCopy:
        `Training with a fever or systemic illness can be dangerous. ` +
        `${REFERRAL_BASE}`,
      recommendedAction:
        'Pause training entirely until at least 24 hours fever-free and symptoms have resolved. ' +
        'Ramp back per the febrile_or_systemic_illness return protocol.',
    });
  }
  // Slice A4 — RED-S risk screening (IOC 2023 framing — screening, NOT diagnosis).
  if (input.energyAvailabilityRisk === 'high') {
    findings.push({
      domain: 'under_fueling_signs',
      severity: 'block',
      triggerSummary: 'high RED-S risk indicators',
      referralCopy:
        `Patterns suggest a high risk of low energy availability (Relative Energy Deficiency ` +
        `in Sport). This is a screening flag, not a diagnosis. ${REFERRAL_BASE} ` +
        `In particular, a registered sports dietitian and a sports-medicine physician can ` +
        `evaluate whether RED-S applies.`,
      recommendedAction:
        'Hold volume flat or reduce. Halt new high-intensity prescription. Surface referral.',
    });
  } else if (input.energyAvailabilityRisk === 'moderate') {
    findings.push({
      domain: 'under_fueling_signs',
      severity: 'warn',
      triggerSummary: 'moderate RED-S risk indicators',
      referralCopy:
        `Some indicators of low energy availability. Consider speaking with a sports dietitian. ` +
        `${REFERRAL_BASE}`,
      recommendedAction:
        'Avoid additional volume growth this cycle. Pay attention to fueling.',
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

/**
 * Chat-tier medical-question vocabulary.
 *
 * `MEDICAL_QUESTION_PATTERNS` above is an INTAKE-form vocabulary: every
 * sentence reaching it is already known to be about the athlete's body, so
 * loose cues are safe there. Open chat is not that surface. Verified
 * against the live patterns, the intake set warns on "should I take a rest
 * day tomorrow?", "should i take an extra gel", "do I have a session
 * tomorrow?", "can you scan my week" and "what treatment temperature for
 * the sous vide?" — five ordinary product turns.
 *
 * So the chat tier keeps only vocabulary that is prescriptive or
 * diagnostic on its own: name a drug, a procedure, a lab, or ask for a
 * diagnosis. Everything softer is dropped — genuine red flags reach the
 * user through `detectInferredRedFlagTriggers`, which matches on the
 * symptom itself ("chest pain", "fainted", "fracture") rather than on the
 * question framing.
 *
 * pt-PT / pt-BR spellings are listed because the chat path folds accents
 * before matching (`foldSafetyText`), and PT is a shipping locale.
 */
const CHAT_MEDICAL_QUESTION_PATTERNS: ReadonlyArray<RegExp> = [
  // Asking for a diagnosis. Also covers pt "diagnóstico" post-folding.
  /\b(diagnos\w+)/i,
  // Asking for a prescription.
  /\b(prescribe[sd]?|prescribing|prescription|receitar|receita medica)\b/i,
  // Naming a drug or drug class.
  /\b(medications?|medicamentos?|antibiotics?|antibioticos?|pain[- ]?killers?|analgesicos?|ibuprofen|ibuprofeno|naproxen|nsaids?|paracetamol|acetaminophen|codeine|codeina|cortisone|cortisona|corticosteroids?|corticoides?)\b/i,
  // Naming a clinical procedure or imaging study.
  /\b(injections?|injecao|injecoes|surgery|surgical|cirurgia|mri|ressonancia|x[- ]?rays?|raios?[- ]?x|ct scans?|tomografia|ultrasound|ecografia)\b/i,
  // Naming a lab investigation.
  /\b(blood tests?|blood work|lab work|analises? (ao|de) sangue)\b/i,
  // "should I take an anti-inflammatory" is a medication question;
  // "add anti-inflammatory foods" is an ordinary nutrition answer. Only
  // the ingestion framing counts, so the word alone never trips a referral.
  /\b(take|taking|took|tomar|tomei|tomo|tomando)\b[^.?!\n]{0,40}\banti[- ]?inflam{1,2}at(ory|ories|orio|orios)\b/i,
];

function buildMedicalQuestionFinding(
  text: string,
  tier: MedicalQuestionTier = 'intake',
): SafetyFinding | null {
  const patterns = tier === 'chat' ? CHAT_MEDICAL_QUESTION_PATTERNS : MEDICAL_QUESTION_PATTERNS;
  for (const pattern of patterns) {
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
/**
 * R4 P1 fix — build a guaranteed `block` SafetyFinding from a typed
 * red-flag trigger. Each trigger maps to a domain-specific referral
 * line. Closes the paper-pause gap where structured intake of
 * chest_pain / fainting / acute_injury produced no finding because
 * the map function emitted nothing block-worthy.
 */
function buildTypedRedFlagFinding(
  trigger: NonNullable<SafetyEvaluationInput['typedRedFlagTrigger']>,
): SafetyFinding {
  switch (trigger) {
    case 'chest_pain':
      return {
        domain: 'acute_pain_during_session',
        severity: 'block',
        triggerSummary: 'structured intake: chest pain reported',
        referralCopy:
          `Chest pain during or after exercise can have serious causes. Please stop training ` +
          `and seek immediate medical evaluation. ${REFERRAL_BASE}`,
        recommendedAction:
          'Halt all training immediately. Surface medical referral. Do not resume until cleared.',
      };
    case 'fainting':
      return {
        domain: 'acute_pain_during_session',
        severity: 'block',
        triggerSummary: 'structured intake: fainting reported',
        referralCopy:
          `Fainting (syncope) during or after exercise requires immediate medical evaluation. ` +
          `${REFERRAL_BASE}`,
        recommendedAction:
          'Halt all training. Surface medical referral. Avoid solo training until cleared.',
      };
    case 'severe_dizziness':
      return {
        domain: 'acute_pain_during_session',
        severity: 'block',
        triggerSummary: 'structured intake: severe dizziness reported',
        referralCopy:
          `Severe dizziness during or after exercise warrants medical evaluation, ` +
          `particularly for cardiac, neurological, and dehydration causes. ${REFERRAL_BASE}`,
        recommendedAction:
          'Pause training pending evaluation. Avoid any activity with fall risk until cleared.',
      };
    case 'acute_injury':
      return {
        domain: 'stress_fracture_warning',
        severity: 'block',
        triggerSummary: 'structured intake: acute injury reported',
        referralCopy:
          `An acute injury reported during structured intake needs proper assessment before ` +
          `returning to training. ${REFERRAL_BASE}`,
        recommendedAction:
          'Halt training on the affected limb/region. Surface medical referral. Hold maintenance ' +
          'volume only on unaffected modalities until cleared.',
      };
    case 'worsening_localized_pain':
      return {
        domain: 'acute_pain_during_session',
        severity: 'block',
        triggerSummary: 'structured intake: worsening localized pain',
        referralCopy:
          `Pain that worsens session-over-session is a stress-injury risk signal. ` +
          `Please pause the affected modality and seek evaluation. ${REFERRAL_BASE}`,
        recommendedAction:
          'Halt the affected modality. Substitute non-loading work. Surface medical referral.',
      };
    case 'fever_or_systemic_illness':
      return {
        domain: 'persistent_fatigue',
        severity: 'block',
        triggerSummary: 'structured intake: fever / systemic illness',
        referralCopy:
          `Training with a fever or systemic illness can be dangerous. ${REFERRAL_BASE}`,
        recommendedAction:
          'Pause training entirely until ≥24 hours fever-free and symptoms have resolved. ' +
          'Ramp back per the febrile_or_systemic_illness return protocol.',
      };
    case 'red_s_high_risk':
      return {
        domain: 'under_fueling_signs',
        severity: 'block',
        triggerSummary: 'structured intake: high RED-S risk indicators',
        referralCopy:
          `Structured intake flagged a high risk of low energy availability (Relative Energy ` +
          `Deficiency in Sport). This is a screening flag, not a diagnosis. ${REFERRAL_BASE} ` +
          `A registered sports dietitian and a sports-medicine physician can evaluate.`,
        recommendedAction:
          'Pause new high-intensity prescription. Hold volume flat or reduce. Surface referral.',
      };
    case 'unexplained_performance_collapse':
      return {
        domain: 'persistent_fatigue',
        severity: 'block',
        triggerSummary: 'structured intake: unexplained performance collapse',
        referralCopy:
          `A sudden, unexplained performance collapse can indicate overtraining, illness, ` +
          `or an underlying medical issue. Please seek medical evaluation. ${REFERRAL_BASE}`,
        recommendedAction:
          'Pause training. Surface medical referral. Resume only after evaluation and a controlled ramp.',
      };
    default: {
      // Exhaustiveness guard — a new HARD_PAUSE_TYPED_TRIGGER added
      // to safety-wiring.ts must extend the switch here.
      const _exhaustive: never = trigger;
      void _exhaustive;
      return {
        domain: 'direct_medical_question',
        severity: 'block',
        triggerSummary: 'unknown typed red flag — defensive block',
        referralCopy:
          `An unrecognized red-flag trigger arrived from structured intake. Defaulting to a ` +
          `safety pause. ${REFERRAL_BASE}`,
        recommendedAction: 'Pause training. Surface medical referral.',
      };
    }
  }
}

/**
 * Inferred-tier counterpart of `buildTypedRedFlagFinding`. Reuses the typed
 * builder verbatim — same domain, same referral copy, same recommended
 * action — and only downgrades severity to `warn` so the free-text path can
 * never hard-pause a plan. Keeping one copy source means a wording fix lands
 * on both tiers at once.
 */
function buildInferredRedFlagFinding(
  trigger: NonNullable<SafetyEvaluationInput['typedRedFlagTrigger']>,
): SafetyFinding {
  const typed = buildTypedRedFlagFinding(trigger);
  return {
    ...typed,
    severity: 'warn',
    triggerSummary: `inferred free text: ${trigger}`,
  };
}

export function evaluateSafetyContext(input: SafetyEvaluationInput): SafetyEvaluationResult {
  const findings: SafetyFinding[] = [];
  // R4 P1 fix — typed red-flag triggers FIRST and unconditional.
  // Every value in `typedRedFlagTrigger` produces a `block` finding
  // with a domain-specific referral; the prior code path required
  // an additional `acuteSessionPain` / `feverPresent` etc. to ever
  // produce a block, which made structured chest-only / fainting-only
  // / acute-injury-only intake silently pass.
  if (input.typedRedFlagTrigger) {
    findings.push(buildTypedRedFlagFinding(input.typedRedFlagTrigger));
  }
  for (const inferred of input.inferredRedFlagTriggers ?? []) {
    findings.push(buildInferredRedFlagFinding(inferred));
  }
  if (input.acuteSessionPain) findings.push(buildAcutePainFinding(input.acuteSessionPain));
  if (input.fatiguePattern) {
    const f = buildFatigueFinding(input.fatiguePattern);
    if (f) findings.push(f);
  }
  if (input.selfReportedFlags) findings.push(...buildSelfReportedFinding(input.selfReportedFlags));
  if (input.userQuestionText) {
    const med = buildMedicalQuestionFinding(input.userQuestionText, input.questionTier ?? 'intake');
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

/** Portuguese rendering of `COACH_NON_DIAGNOSTIC_DISCLAIMER`. */
export const COACH_NON_DIAGNOSTIC_DISCLAIMER_PT =
  'Sou um treinador, não um profissional de saúde. Para sintomas, dores, ou qualquer coisa que ' +
  'preocupe, procure um médico ou profissional de medicina desportiva.';

export type CoachSafetyLocale = 'pt' | 'en';

/** Map any BCP-47-ish language tag to the two disclaimer renderings. */
export function resolveCoachSafetyLocale(language: string | null | undefined): CoachSafetyLocale {
  return typeof language === 'string' && language.trim().toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

export function renderCoachNonDiagnosticDisclaimer(locale: CoachSafetyLocale): string {
  return locale === 'pt' ? COACH_NON_DIAGNOSTIC_DISCLAIMER_PT : COACH_NON_DIAGNOSTIC_DISCLAIMER;
}

// ─── Inferred (free-text) red-flag detection — chat path ─────────────
//
// The deterministic guardrails above were only reachable from structured
// intake and plan generation. Ordinary chat is where an athlete actually
// types "my chest hurt during the run", so the same rules have to be
// reachable from free text. Detection is deliberately phrase-level and
// conservative: a single body-part word ("chest press", "peito") must
// never trip a referral, so every rule requires an explicit symptom
// phrase. Matching runs on accent-folded lowercase text so pt-PT/pt-BR
// spellings hit the same rule.

/** Lowercase + strip diacritics so `dor torácica` and `dor toracica` match one pattern. */
function foldSafetyText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const INFERRED_RED_FLAG_TEXT_RULES: ReadonlyArray<{
  trigger: NonNullable<SafetyEvaluationInput['typedRedFlagTrigger']>;
  pattern: RegExp;
}> = [
  {
    trigger: 'chest_pain',
    pattern:
      /\b(chest pain|pain in (my |the )?chest|chest tightness|tightness in (my |the )?chest|chest pressure|pressure in (my |the )?chest|dor no peito|dor toracica|aperto no peito|pressao no peito)\b/,
  },
  {
    trigger: 'fainting',
    pattern: /\b(fainted|fainting|passed out|blacked out|syncope|desmaiei|desmaio|desmaiar)\b/,
  },
  {
    trigger: 'severe_dizziness',
    pattern:
      /\b(severe dizziness|severely dizzy|very dizzy|room (was |is )?spinning|vertigo|tontura forte|tontura intensa|vertigem)\b/,
  },
  {
    trigger: 'acute_injury',
    pattern:
      /\b(tore (my|a)|torn (acl|mcl|meniscus|muscle|tendon|ligament)|pulled (a )?muscle|sprained|sprain|fractured|fracture|broken bone|rompi|torci o|distensao|lesao aguda)\b/,
  },
  {
    trigger: 'worsening_localized_pain',
    pattern:
      /\b(pain (is |keeps )?(getting|got) worse|worsening pain|pain that keeps getting worse|dor (esta )?piorando|dor piorou|dor cada vez pior)\b/,
  },
  {
    trigger: 'fever_or_systemic_illness',
    pattern: /\b(fever|feverish|febre|febril)\b/,
  },
  {
    trigger: 'red_s_high_risk',
    pattern:
      /\b(red-s\b|relative energy deficiency|low energy availability|amenorrh?ea|amenorreia|lost my period|stopped menstruating|parei de menstruar)\b/,
  },
];

/**
 * Detect inferred red flags in free-text. Returns the deduplicated trigger
 * vocabulary shared with structured intake — see `inferredRedFlagTriggers`.
 */
export function detectInferredRedFlagTriggers(
  text: string,
): Array<NonNullable<SafetyEvaluationInput['typedRedFlagTrigger']>> {
  if (!text || text.trim().length === 0) return [];
  const folded = foldSafetyText(text);
  const triggers: Array<NonNullable<SafetyEvaluationInput['typedRedFlagTrigger']>> = [];
  for (const rule of INFERRED_RED_FLAG_TEXT_RULES) {
    if (rule.pattern.test(folded) && !triggers.includes(rule.trigger)) {
      triggers.push(rule.trigger);
    }
  }
  return triggers;
}

/**
 * Chat-path entry point for the deterministic guardrails.
 *
 * Runs `evaluateSafetyContext` over one or more free-text values (the
 * user's message, and optionally the drafted answer) at the CHAT tier:
 * inferred red flags, the prescriptive/diagnostic medical-question subset
 * (`CHAT_MEDICAL_QUESTION_PATTERNS`, NOT the broad intake set), and the
 * supplement / anti-doping rule. Every finding it can produce is `warn` or
 * `inform`; the free-text tier never emits `block`.
 *
 * Callers attach `buildCoachSafetyNotice(...)` to the answer. They must not
 * feed the result into plan pausing — that stays a structured-intake
 * decision (see safety-wiring.ts).
 */
export function evaluateChatMessageSafety(...values: Array<string | null | undefined>): SafetyEvaluationResult {
  const text = values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
  if (!text) return { status: 'pass', findings: [], topMessage: '' };
  const inferredRedFlagTriggers = detectInferredRedFlagTriggers(text);
  return evaluateSafetyContext({
    // The existing question/supplement patterns are written against folded
    // lowercase text, so folding here also makes them reachable for pt-*.
    userQuestionText: foldSafetyText(text),
    questionTier: 'chat',
    ...(inferredRedFlagTriggers.length > 0 ? { inferredRedFlagTriggers } : {}),
  });
}

/** True when the answer already carries a non-diagnostic / referral line. */
export function answerCarriesNonDiagnosticDisclaimer(text: string): boolean {
  const folded = foldSafetyText(text ?? '');
  return folded.includes('not a clinician')
    || folded.includes('nao um profissional de saude')
    || folded.includes('nao sou medico');
}

/**
 * The highest-severity finding the caller should surface, or null.
 *
 * `inform`-level findings are deliberately NOT surfaced by default. The
 * supplement/anti-doping rule fires on very common nutrition words
 * ("protein", "caffeine"), so promoting it into every answer would train
 * users to ignore the safety block entirely. Genuinely prescriptive
 * supplement questions ("should I take X") still land at `warn` through
 * the direct-medical-question rule.
 */
export function selectSurfacedSafetyFinding(
  evaluation: SafetyEvaluationResult,
  minSeverity: SafetySeverity = 'warn',
): SafetyFinding | null {
  const eligible = evaluation.findings
    .filter((finding) => severityRank(finding.severity) <= severityRank(minSeverity))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return eligible[0] ?? null;
}

/**
 * Build the safety block appended to a coach / training / readiness /
 * nutrition answer. Returns an empty string when there is nothing to add,
 * so callers can concatenate unconditionally.
 *
 * `includeDisclaimer` forces the non-diagnostic line on even when no rule
 * fired — that is how a health-guidance surface satisfies "every coach
 * response carries the disclaimer". `alreadyDisclaimed` suppresses the
 * duplicate when the model already produced its own referral line.
 */
export function buildCoachSafetyNotice(
  evaluation: SafetyEvaluationResult,
  locale: CoachSafetyLocale,
  options?: {
    includeDisclaimer?: boolean;
    alreadyDisclaimed?: boolean;
    minSeverity?: SafetySeverity;
  },
): string {
  const parts: string[] = [];
  const surfaced = selectSurfacedSafetyFinding(evaluation, options?.minSeverity ?? 'warn');
  if (surfaced) parts.push(surfaced.referralCopy);
  const includeDisclaimer = options?.includeDisclaimer ?? surfaced !== null;
  // Every referralCopy already ends with REFERRAL_BASE ("I am not a
  // clinician…"), so a surfaced finding makes the standalone disclaimer
  // redundant.
  const alreadyDisclaimed = options?.alreadyDisclaimed === true
    || (surfaced !== null && answerCarriesNonDiagnosticDisclaimer(surfaced.referralCopy));
  if (includeDisclaimer && !alreadyDisclaimed) {
    parts.push(renderCoachNonDiagnosticDisclaimer(locale));
  }
  return parts.join('\n\n');
}
