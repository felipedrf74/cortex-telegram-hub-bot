// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Per-skill deterministic parser for the training skill. Extracted from
// chat-action-planner.ts on 2026-05-15 (planner-split, audit implementation
// plan Phase 0). Helpers (slot extraction, validation, step construction)
// live in ./helpers.ts.

import { makeStep, type StepKeyInputs } from '../step-builder';
import {
  extractTrainingPlanSlots,
  makeTrainingPlanStep,
  missingTrainingPlanSlots,
} from './helpers';
import type { ChatPlanStep } from '../../chat/types';

export interface TrainingParserInput extends StepKeyInputs {
  text: string;
  messageId: string;
  nowIso?: string;
  timezone: string;
}

export function parseTrainingActionStep(
  input: TrainingParserInput,
  folded: string,
): ChatPlanStep | null {
  // Phase 5 batch 25 (2026-05-15): distance-plan bigrams ("10K plan", "5K
  // plan", etc.) added to the gate so "Build me a 10K plan in 12 weeks"
  // reaches parseTrainingActionStep. The original gate required an explicit
  // training-domain noun (training/treino/run/...); distance-prefix lacked
  // coverage.
  // Phase 10 batch 51 (2026-05-16): Spanish training vocabulary added —
  // entrenamiento (training), sesión / sesion (session), ajusta/ajustar
  // (adjust), gimnasio (gym), correr (run/running), explica/explicar
  // (explain).
  // Phase 11 batch 58 (2026-05-16): "reorganiza[r]?"/"reorganizado" added
  // to the gate so reflow phrasings like "Aplica el reorganizado al plan"
  // reach the parser even without an explicit training-domain noun.
  if (!/\b(training|entrenamiento[s]?|treino|plano de treino|plan\s+de\s+entrenamiento|coach|corrida|gym|ginasio|ginásio|gimnasio|session|sessao|sessão|sesi[oó]n|reflow|reorganiza[r]?|reorganizado|ajusta[r]?|adjust|workout|run|correr|long\s+run|rodagem|marathon|maratona|race|prova|half[\s-]?marathon|(?:5|10|21|42|3|15)\s*k\s+plan|(?:5|10|21|42|3|15)\s*km\s+plan)\b/.test(folded)) return null;
  // Phase 4 batch 22 (2026-05-15): adjust-plan check moved BEFORE plan-create.
  // The Phase 3 batch 16 extension to plan-create added "plan" as a create-
  // verb, which caused "Adjust my training plan" to claim plan_create
  // (because "plan" matches the verb AND "training plan" matches the object)
  // even though the user clearly wants to adjust an existing plan. Adjust
  // verbs are a more specific match — claim those first.
  // Phase 7 close-out: "tighten up" / "loosen up" English adjust idioms.
  if ((/\b(reflow|remarca|reagenda|reorganiza[r]?|reorganizado|adjust|ajusta|alterar plano|muda o plano)\b/.test(folded)
    || /\b(tighten\s+up|loosen\s+up|dial\s+(?:back|down|up)|scale\s+(?:back|down|up))\b.*\b(training|treino|plan)\b/.test(folded))
    && !/\b(preview|mostra[r]?|muestra[r]?|show\s+me|ver|veja|propose|propoe[r]?|propone[r]?)\b/.test(folded)
    && !/\b(confirm|apply|aplica[r]?|confirma[r]?|aceita[r]?|sim,?\s+aplica)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'training',
      action: 'training_adjust_plan',
      risk: 'safe_write',
      provider: 'nexus',
      args: { changeRequest: input.text, planId: null },
      requiredArgsPresent: false,
    });
  }
  // Phase 3 batch 16: "marathon plan" / "race plan" / "running plan" treated
  // as training_plan_create. The specific-distance prefix is the object;
  // generic "plan" alone is too ambiguous (could be financial plan, business
  // plan, etc.) so we require the running-domain qualifier.
  // Phase 3 batch 17 (2026-05-15): "plan" alone + "training" elsewhere in
  // the message now counts as a training-plan-create intent. The earlier
  // strict adjacency requirement ("training plan") missed "Plan my training
  // for next 12 weeks". The new rule: any create-verb + (training-plan
  // bigram OR training-word AND plan-word AND week-duration) satisfies the
  // gate. Bigram rule keeps backwards compatibility; the second branch
  // catches the "for X weeks" duration idiom.
  // Phase 11 batch 58 (2026-05-16): reflow guard. The plan_create branch
  // accepts the literal verb "plan" — but "plan" also appears as a noun
  // in reflow phrasings like "Aplica el reorganizado al plan". To prevent
  // plan_create from claiming reflow intent, skip this branch when a
  // reflow-class verb is also present. The reflow_preview / reflow_confirm
  // branches downstream will then handle the message.
  const hasReflowSignal = /\b(reflow|remarca[r]?|reagenda[r]?|reorganiza[r]?|reorganizado)\b/.test(folded);
  if (!hasReflowSignal
    && /\b(create|build|generate|make|cria|criar|gera|gerar|monta|montar|faz|fazer|plan)\b/.test(folded)
    && (/\b(training\s+plan|plano\s+de\s+treino|plan[o]?\b|programa\s+de\s+treino|(?:marathon|maratona|race|prova|running|half[\s-]?marathon|10k|5k|21k|42k)\s+plan)\b/.test(folded)
        || (/\b(training|treino|run|marathon|maratona)\b/.test(folded)
            && /\bfor\s+(?:the\s+)?(?:next\s+)?\d+\s+weeks?\b/.test(folded)))) {
    const extracted = extractTrainingPlanSlots(input);
    const missing = missingTrainingPlanSlots(extracted.slots);
    return makeTrainingPlanStep(input, extracted.slots, missing, extracted.provenance);
  }
  // Reflow preview: explicit preview / show-me / mostra cue with reflow noun.
  // Must come BEFORE reflow_confirm and training_adjust_plan because both
  // claim the "reflow" verb and we want preview to win on "show me / preview".
  if (/\b(reflow|remarca[r]?|reagenda[r]?|reorganiza[r]?|reorganizado)\b/.test(folded)
    && /\b(preview|mostra[r]?|muestra[r]?|show\s+me|ver|veja|propose|propoe[r]?|propone[r]?)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'training',
      action: 'training_reflow_preview',
      risk: 'safe_write',
      provider: 'nexus',
      args: { sessionId: null, rawRequest: input.text },
      requiredArgsPresent: false,
    });
  }
  // Reflow confirm: apply / confirm / aplica cue with reflow noun.
  if (/\b(reflow|remarca[r]?|reagenda[r]?|reorganiza[r]?|reorganizado)\b/.test(folded)
    && /\b(confirm|apply|aplica[r]?|confirma[r]?|aceita[r]?|sim,?\s+aplica)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'training',
      action: 'training_reflow_confirm',
      risk: 'safe_write',
      provider: 'nexus',
      args: { sessionId: null, rawRequest: input.text },
      requiredArgsPresent: false,
    });
  }
  // (training_adjust_plan branch moved above to Phase 4 batch 22 position;
  // this fallback handles non-preview/non-confirm reflow phrasings that
  // weren't caught earlier.)
  if (/\b(reflow|remarca|reagenda|reorganiza[r]?|reorganizado|adjust|ajusta|alterar plano|muda o plano)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'training',
      action: 'training_adjust_plan',
      risk: 'safe_write',
      provider: 'nexus',
      args: { changeRequest: input.text, planId: null },
      requiredArgsPresent: false,
    });
  }
  if (/\b(coach|report|relatorio|relatório|briefing)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'training',
      action: 'training_coach_report',
      risk: 'read_only',
      provider: 'nexus',
      args: { dateRange: 'current' },
      requiredArgsPresent: true,
    });
  }
  return makeStep(input, {
    skill: 'training',
    action: 'training_explain_session',
    risk: 'read_only',
    provider: 'nexus',
    args: { sessionId: null, rawRequest: input.text },
    requiredArgsPresent: false,
  });
}
