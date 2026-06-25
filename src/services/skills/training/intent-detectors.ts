// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 13 batch 71 (2026-05-16): consolidated training intent detector.
//
// Extracted from `src/domains/domain-handler.ts:114` as part of the Phase 0
// audit MERGE-2 item (inline phrase regexes scattered across the codebase).
// `isTrainingPrescriptionIntent` is broader than the action-registry's
// `training_plan_create` intent — it covers any training prescription
// request including specific exercise mentions (deadlift, bench press,
// 5x5, etc.) and PT-PT training jargon (tempo run, FTP test, plano de
// treino). Those specific surfaces don't live in `readableIntents` on
// any single action, so this detector remains a sibling helper rather
// than getting absorbed into `selectRegistrySubsetForMessage`.

export type TrainingPrescriptionIntentKind =
  | 'plan_create'
  | 'session_prescription'
  | 'benchmark_prescription'
  | 'strength_prescription'
  | 'ambiguous_training_request';

export type TrainingPrescriptionModality =
  | 'strength'
  | 'running'
  | 'cycling'
  | 'swimming'
  | 'triathlon'
  | 'hybrid'
  | 'unknown';

export interface TrainingPrescriptionIntentClassification {
  isTrainingPrescription: boolean;
  kind: TrainingPrescriptionIntentKind | null;
  modality: TrainingPrescriptionModality;
  confidence: number;
  matchedSignals: string[];
  requiresSemanticFallback: boolean;
}

type IntentRule = {
  kind: TrainingPrescriptionIntentKind;
  modality: TrainingPrescriptionModality;
  confidence: number;
  signal: string;
  pattern: RegExp;
};

const TRAINING_PRESCRIPTION_RULES: IntentRule[] = [
  {
    kind: 'plan_create',
    modality: 'hybrid',
    confidence: 0.92,
    signal: 'plan_create',
    pattern: /\b(new\s+training\s+plan|training\s+plan|workout\s+plan|plano\s+de\s+treino|plan\s+de\s+entrenamiento)\b/i,
  },
  {
    kind: 'plan_create',
    modality: 'triathlon',
    confidence: 0.94,
    signal: 'triathlon_plan',
    pattern: /\b(triathlon|triatlo|tríatlo|ironman|70\.3)\b.*\b(plan|plano|training|treino)\b|\b(plan|plano|training|treino)\b.*\b(triathlon|triatlo|tríatlo|ironman|70\.3)\b/i,
  },
  {
    kind: 'benchmark_prescription',
    modality: 'cycling',
    confidence: 0.9,
    signal: 'cycling_benchmark',
    pattern: /\b(ftp\s+test|power\s+test|threshold\s+ride|teste\s+ftp)\b/i,
  },
  {
    kind: 'benchmark_prescription',
    modality: 'swimming',
    confidence: 0.9,
    signal: 'swim_benchmark',
    pattern: /\b(css|critical\s+swim\s+speed|freestyle|threshold\s+swim|teste\s+de\s+nata[cç][aã]o)\b/i,
  },
  {
    kind: 'session_prescription',
    modality: 'running',
    confidence: 0.88,
    signal: 'running_session',
    pattern: /\b(tempo\s+run|long\s+run|easy\s+run|interval\s+run|corrida|rodagem|treino\s+de\s+corrida)\b/i,
  },
  {
    kind: 'strength_prescription',
    modality: 'strength',
    confidence: 0.88,
    signal: 'strength_session',
    pattern: /\b(deadlift|bench\s+press|squat|5x5|strength|gym|hipertrofia|muscula[cç][aã]o|for[cç]a)\b/i,
  },
  {
    kind: 'session_prescription',
    modality: 'unknown',
    confidence: 0.78,
    signal: 'generic_prescription',
    pattern: /\b(create|build|generate|make|design|write|prescribe|give\s+me|what\s+(?:workout|session)\s+should\s+i\s+do|how\s+should\s+i\s+train|cria|crie|gera|gerar|monta|monte|faz|fa[çc]a|prescreve|prescreva|me\s+d[aá]|que\s+treino\s+devo\s+fazer|qual\s+treino\s+devo\s+fazer|como\s+devo\s+treinar)\b/i,
  },
];

const TRAINING_CONTEXT_PATTERN = /\b(training|train|workout|session|coach|treino|treinar|entrenamiento|sess[aã]o|sesi[oó]n)\b/i;

export function isTrainingPrescriptionIntent(message: string): boolean {
  return classifyTrainingPrescriptionIntent(message).isTrainingPrescription;
}

export function classifyTrainingPrescriptionIntent(message: string): TrainingPrescriptionIntentClassification {
  const text = String(message || '').trim();
  if (!text) return emptyClassification();

  const matchedRules = TRAINING_PRESCRIPTION_RULES.filter((rule) => rule.pattern.test(text));
  if (matchedRules.length === 0) {
    return {
      ...emptyClassification(),
      requiresSemanticFallback: TRAINING_CONTEXT_PATTERN.test(text),
    };
  }

  const best = matchedRules
    .slice()
    .sort((left, right) => right.confidence - left.confidence)[0];
  const signals = matchedRules.map((rule) => rule.signal);
  const modalities = new Set(matchedRules.map((rule) => rule.modality).filter((modality) => modality !== 'unknown'));
  return {
    isTrainingPrescription: true,
    kind: best.kind,
    modality: resolveTrainingPrescriptionModality(best, modalities),
    confidence: best.confidence,
    matchedSignals: signals,
    requiresSemanticFallback: best.confidence < 0.82,
  };
}

function resolveTrainingPrescriptionModality(
  best: IntentRule,
  modalities: Set<TrainingPrescriptionModality>,
): TrainingPrescriptionModality {
  if (best.modality !== 'unknown') {
    return best.modality;
  }

  if (modalities.size === 1) {
    return [...modalities][0] ?? 'unknown';
  }

  if (modalities.size > 1) {
    return 'hybrid';
  }

  return 'unknown';
}

function emptyClassification(): TrainingPrescriptionIntentClassification {
  return {
    isTrainingPrescription: false,
    kind: null,
    modality: 'unknown',
    confidence: 0,
    matchedSignals: [],
    requiresSemanticFallback: false,
  };
}
