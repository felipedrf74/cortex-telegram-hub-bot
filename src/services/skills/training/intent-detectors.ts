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

const TRAINING_PRESCRIPTION_PATTERN = /\b(create|build|generate|make|design|write|prescribe|give\s+me|what\s+(?:workout|session)\s+should\s+i\s+do|how\s+should\s+i\s+train|new\s+training\s+plan|training\s+plan|workout\s+plan|tempo\s+run|ftp\s+test|freestyle|deadlift|bench\s+press|squat|5x5|css|cria|crie|gera|gerar|monta|monte|faz|fa[çc]a|prescreve|prescreva|me\s+d[aá]|que\s+treino\s+devo\s+fazer|qual\s+treino\s+devo\s+fazer|como\s+devo\s+treinar|plano\s+de\s+treino)\b/i;

export function isTrainingPrescriptionIntent(message: string): boolean {
  return TRAINING_PRESCRIPTION_PATTERN.test(message);
}
