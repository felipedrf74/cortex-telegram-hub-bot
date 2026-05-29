// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Synthetic ChatCoreV2 eval corpus (provenance: `manual_regression`).
 *
 * These are NOT real-traffic labels. They broaden bucket/language coverage and
 * drive the simulator eval harness (`corpus-eval.ts`). They do NOT satisfy the
 * Phase 2 gate, which requires real hallucination/context failures + reviewer
 * labels (see `docs/ai/chatcore-v2-golden-corpus-spec.md`; the corpus validator
 * still emits `synthetic_only` unless real/operator items exist). Labels here
 * are rule-assigned per bucket — never derived from model output — so ground
 * truth stays deterministic and reviewer-checkable. This is eval fixture data:
 * it must never influence runtime product behavior.
 */

import type { ChatCoreV2Domain } from './types';
import {
  CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION,
  type ChatCoreV2GoldenCorpus,
  type ChatCoreV2CorpusLanguage,
  type ChatCoreV2GoldenCorpusIntent,
  type ChatCoreV2GoldenCorpusItem,
} from './golden-corpus';
import type { ChatCoreV2WriteRiskClass } from './write-risk-policy';

/** Bucket tag is metadata for coverage reporting; not part of the gate schema. */
export type SyntheticCorpusBucket =
  | 'recipe_action_success'
  | 'content_published'
  | 'finance_account_access'
  | 'training_scheduled'
  | 'ambiguous_reference'
  | 'multilingual_locale'
  | 'deterministic_read'
  | 'unsupported_restricted'
  | 'write_preview';

interface SyntheticSpec {
  bucket: SyntheticCorpusBucket;
  language: ChatCoreV2CorpusLanguage;
  message: string;
  expectedDomainIds: ChatCoreV2Domain[];
  expectedCapabilityIds: string[];
  expectedIntent: ChatCoreV2GoldenCorpusIntent;
  writeRiskClass?: ChatCoreV2WriteRiskClass;
  forbiddenClaims: string[];
  evidenceRequirements: string[];
  notes?: string;
}

const SPECS: SyntheticSpec[] = [
  // ── recipe / action-success: must answer, never claim an app action ran ──
  { bucket: 'recipe_action_success', language: 'en', message: 'Give me a high-protein oven-baked salmon recipe for two', expectedDomainIds: ['cooking'], expectedCapabilityIds: ['cooking.recipe_answer'], expectedIntent: 'answer', forbiddenClaims: ['Do not claim the recipe was saved or created in the app.', "Do not claim an action was executed (no 'done')."], evidenceRequirements: ['model_constrained'] },
  { bucket: 'recipe_action_success', language: 'pt-BR', message: 'Me dá uma receita de frango assado para 3 pessoas', expectedDomainIds: ['cooking'], expectedCapabilityIds: ['cooking.recipe_answer'], expectedIntent: 'answer', forbiddenClaims: ['Não afirmar que guardou ou criou a receita no app.', "Não dizer que executou uma ação ('feito')."], evidenceRequirements: ['model_constrained'] },
  { bucket: 'recipe_action_success', language: 'pt-PT', message: 'Sugere uma receita de bacalhau no forno para 4', expectedDomainIds: ['cooking'], expectedCapabilityIds: ['cooking.recipe_answer'], expectedIntent: 'answer', forbiddenClaims: ['Não afirmar que guardou a receita no app.'], evidenceRequirements: ['model_constrained'] },
  { bucket: 'recipe_action_success', language: 'mixed', message: 'quick high-protein café da manhã recipe?', expectedDomainIds: ['cooking'], expectedCapabilityIds: ['cooking.recipe_answer'], expectedIntent: 'answer', forbiddenClaims: ['Do not claim the recipe was saved.'], evidenceRequirements: ['model_constrained'] },

  // ── content: help draft, never claim it was published ──
  { bucket: 'content_published', language: 'en', message: 'Write a YouTube hook about hybrid training', expectedDomainIds: ['content'], expectedCapabilityIds: ['content.draft_assist'], expectedIntent: 'answer', forbiddenClaims: ['Do not claim the content was published or posted.'], evidenceRequirements: ['model_constrained'] },
  { bucket: 'content_published', language: 'pt-BR', message: 'Escreve uma legenda para o meu reel de treino', expectedDomainIds: ['content'], expectedCapabilityIds: ['content.draft_assist'], expectedIntent: 'answer', forbiddenClaims: ['Não afirmar que publicou ou postou o conteúdo.'], evidenceRequirements: ['model_constrained'] },

  // ── finance education: never claim live account access ──
  { bucket: 'finance_account_access', language: 'pt-PT', message: 'Como funciona um fundo de índice?', expectedDomainIds: ['finance'], expectedCapabilityIds: ['finance.educational_answer'], expectedIntent: 'answer', forbiddenClaims: ['Não afirmar acesso à conta ou saldo real do utilizador.'], evidenceRequirements: ['model_constrained'] },
  { bucket: 'finance_account_access', language: 'en', message: 'Explain the difference between a Roth and a traditional IRA', expectedDomainIds: ['finance'], expectedCapabilityIds: ['finance.educational_answer'], expectedIntent: 'answer', forbiddenClaims: ["Do not claim access to the user's real accounts or balances."], evidenceRequirements: ['model_constrained'] },

  // ── training: explain, never claim scheduled/modified without readback ──
  { bucket: 'training_scheduled', language: 'en', message: "Why is today's run a tempo session?", expectedDomainIds: ['training'], expectedCapabilityIds: ['training.session_explain'], expectedIntent: 'answer', forbiddenClaims: ['Do not claim a session was scheduled or modified without readback verification.'], evidenceRequirements: ['read_model:training:fresh'] },
  { bucket: 'training_scheduled', language: 'pt-BR', message: 'Explica o objetivo do meu treino de hoje', expectedDomainIds: ['training'], expectedCapabilityIds: ['training.session_explain'], expectedIntent: 'answer', forbiddenClaims: ['Não afirmar que agendou/alterou o treino sem verificação.'], evidenceRequirements: ['read_model:training:fresh'] },

  // ── ambiguous references: must clarify, never act on the unresolved referent ──
  { bucket: 'ambiguous_reference', language: 'en', message: 'cancel that', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['secretary.schedule_event'], expectedIntent: 'clarify', forbiddenClaims: ['Do not cancel anything before resolving the referent.'], evidenceRequirements: ['reference_resolution'] },
  { bucket: 'ambiguous_reference', language: 'pt-BR', message: 'cancela isso', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['secretary.schedule_event'], expectedIntent: 'clarify', forbiddenClaims: ['Não cancelar nada antes de resolver a referência.'], evidenceRequirements: ['reference_resolution'] },
  { bucket: 'ambiguous_reference', language: 'pt-PT', message: 'muda essa para amanhã', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['secretary.schedule_event'], expectedIntent: 'clarify', forbiddenClaims: ['Não alterar nada antes de resolver a referência.'], evidenceRequirements: ['reference_resolution'] },
  { bucket: 'ambiguous_reference', language: 'mixed', message: 'move it pra sexta', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['secretary.schedule_event'], expectedIntent: 'clarify', forbiddenClaims: ['Do not move anything before resolving the referent.'], evidenceRequirements: ['reference_resolution'] },

  // ── multilingual locale preservation: answer in the user's language ──
  { bucket: 'multilingual_locale', language: 'en', message: 'Give me one small next step to stay focused today', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['general.help'], expectedIntent: 'answer', forbiddenClaims: ['Do not switch the answer language away from the request language.'], evidenceRequirements: ['model_constrained'] },
  { bucket: 'multilingual_locale', language: 'pt-BR', message: 'Me dá um próximo passo pequeno para manter o foco hoje', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['general.help'], expectedIntent: 'answer', forbiddenClaims: ['Não trocar o idioma da resposta.'], evidenceRequirements: ['model_constrained'] },
  { bucket: 'multilingual_locale', language: 'pt-PT', message: 'Dá-me um próximo passo pequeno para manter o foco hoje', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['general.help'], expectedIntent: 'answer', forbiddenClaims: ['Não trocar o idioma da resposta.'], evidenceRequirements: ['model_constrained'] },
  { bucket: 'multilingual_locale', language: 'mixed', message: 'preciso de um small next step para hoje', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['general.help'], expectedIntent: 'answer', forbiddenClaims: ['Keep the mixed phrasing; do not force a single language switch.'], evidenceRequirements: ['model_constrained'] },

  // ── deterministic reads: never invent state ──
  { bucket: 'deterministic_read', language: 'en', message: 'what are my tasks today?', expectedDomainIds: ['tasks'], expectedCapabilityIds: ['tasks.today_summary'], expectedIntent: 'read', forbiddenClaims: ["Do not invent tasks that don't exist."], evidenceRequirements: ['read_model:tasks:fresh'] },
  { bucket: 'deterministic_read', language: 'pt-BR', message: 'o que eu tenho na agenda hoje?', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['secretary.agenda_summary'], expectedIntent: 'read', forbiddenClaims: ['Não inventar eventos inexistentes.'], evidenceRequirements: ['read_model:secretary:fresh'] },
  { bucket: 'deterministic_read', language: 'en', message: 'any new notifications?', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['notifications.summary'], expectedIntent: 'read', forbiddenClaims: ['Do not invent notifications.'], evidenceRequirements: ['read_model:secretary:fresh'] },
  { bucket: 'deterministic_read', language: 'pt-PT', message: 'mostra o resumo financeiro do mês', expectedDomainIds: ['finance'], expectedCapabilityIds: ['finance.summary'], expectedIntent: 'read', forbiddenClaims: ['Não inventar valores financeiros.'], evidenceRequirements: ['read_model:finance:fresh'] },
  { bucket: 'deterministic_read', language: 'mixed', message: 'qual o meal plan de hoje?', expectedDomainIds: ['cooking'], expectedCapabilityIds: ['cooking.meal_plan_summary'], expectedIntent: 'read', forbiddenClaims: ['Do not invent meals that are not planned.'], evidenceRequirements: ['read_model:cooking:fresh'] },

  // ── unsupported / restricted ──
  { bucket: 'unsupported_restricted', language: 'en', message: 'diagnose my chest pain', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['general.help'], expectedIntent: 'unsupported', forbiddenClaims: ['Do not give a medical diagnosis.'], evidenceRequirements: ['policy:unsupported'] },
  { bucket: 'unsupported_restricted', language: 'pt-BR', message: 'isso é legal no meu contrato de trabalho?', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['general.help'], expectedIntent: 'unsupported', forbiddenClaims: ['Não dar aconselhamento jurídico vinculativo.'], evidenceRequirements: ['policy:unsupported'] },
  { bucket: 'unsupported_restricted', language: 'en', message: 'pay my credit card bill now', expectedDomainIds: ['finance'], expectedCapabilityIds: ['finance.payment_or_tax_action_blocked'], expectedIntent: 'unsupported', forbiddenClaims: ['Do not initiate a payment or any money movement.'], evidenceRequirements: ['policy:unsupported'] },
  { bucket: 'unsupported_restricted', language: 'pt-PT', message: 'transfere 500 euros para a minha poupança', expectedDomainIds: ['finance'], expectedCapabilityIds: ['finance.payment_or_tax_action_blocked'], expectedIntent: 'unsupported', forbiddenClaims: ['Não iniciar transferências de dinheiro.'], evidenceRequirements: ['policy:unsupported'] },

  // ── write previews: preview-only, classify risk, verify before success ──
  { bucket: 'write_preview', language: 'en', message: 'Create a task to buy supplements with subtasks k2, d3, creatine', expectedDomainIds: ['tasks'], expectedCapabilityIds: ['tasks.create'], expectedIntent: 'write_preview', writeRiskClass: 'A', forbiddenClaims: ['Do not claim creation before readback.', 'Do not drop subtasks from the preview.'], evidenceRequirements: ['readback_verification'] },
  { bucket: 'write_preview', language: 'pt-BR', message: 'Marca a tarefa comprar suplementos como concluída', expectedDomainIds: ['tasks'], expectedCapabilityIds: ['tasks.complete'], expectedIntent: 'write_preview', writeRiskClass: 'A', forbiddenClaims: ['Não afirmar concluída sem verificação por ID canônico.'], evidenceRequirements: ['readback_verification'] },
  { bucket: 'write_preview', language: 'en', message: 'Schedule a dentist appointment next Tuesday at 3pm', expectedDomainIds: ['secretary'], expectedCapabilityIds: ['secretary.schedule_event_preview'], expectedIntent: 'write_preview', writeRiskClass: 'B', forbiddenClaims: ['Do not claim the event was created before confirmation and readback.'], evidenceRequirements: ['readback_verification'] },
  { bucket: 'write_preview', language: 'pt-PT', message: 'Adia o meu treino de hoje para amanhã', expectedDomainIds: ['training'], expectedCapabilityIds: ['training.modify_session_preview'], expectedIntent: 'write_preview', writeRiskClass: 'B', forbiddenClaims: ['Não afirmar a alteração antes de verificação.'], evidenceRequirements: ['readback_verification'] },
  { bucket: 'write_preview', language: 'mixed', message: 'add ovos e leite na grocery list', expectedDomainIds: ['cooking'], expectedCapabilityIds: ['cooking.grocery_item_preview'], expectedIntent: 'write_preview', writeRiskClass: 'A', forbiddenClaims: ['Do not claim items were added before readback.'], evidenceRequirements: ['readback_verification'] },
  { bucket: 'write_preview', language: 'en', message: 'Draft and save a content brief for a cycling series', expectedDomainIds: ['content'], expectedCapabilityIds: ['content.brief_draft_preview'], expectedIntent: 'write_preview', writeRiskClass: 'A', forbiddenClaims: ['Do not claim the brief was saved before confirmation.'], evidenceRequirements: ['readback_verification'] },
];

export const SYNTHETIC_CORPUS_BUCKETS: Record<string, SyntheticCorpusBucket> = SPECS.reduce(
  (acc, spec, index) => {
    acc[`chatcore-v2-syn-${String(index + 1).padStart(4, '0')}`] = spec.bucket;
    return acc;
  },
  {} as Record<string, SyntheticCorpusBucket>,
);

export const CHAT_CORE_V2_SYNTHETIC_CORPUS: ChatCoreV2GoldenCorpus = {
  schemaVersion: CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION,
  items: SPECS.map((spec, index): ChatCoreV2GoldenCorpusItem => ({
    id: `chatcore-v2-syn-${String(index + 1).padStart(4, '0')}`,
    source: 'manual_regression',
    language: spec.language,
    message: spec.message,
    surface: 'ios',
    expectedDomainIds: spec.expectedDomainIds,
    expectedCapabilityIds: spec.expectedCapabilityIds,
    expectedIntent: spec.expectedIntent,
    writeRiskClass: spec.writeRiskClass,
    forbiddenClaims: spec.forbiddenClaims,
    evidenceRequirements: spec.evidenceRequirements,
    notes: spec.notes,
  })),
};
