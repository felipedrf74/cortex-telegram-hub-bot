// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Per-skill deterministic parser for the cooking skill. Extracted from
// chat-action-planner.ts on 2026-05-15 (planner-split, audit implementation
// plan Phase 0).

import type { DateTime } from 'luxon';

import { makeStep, type StepKeyInputs } from '../step-builder';
import type { ChatPlanStep } from '../../chat/types';

export function parseCookingActionStep(
  input: StepKeyInputs & { text: string },
  folded: string,
  now: DateTime,
): ChatPlanStep | null {
  // Phase 10 batch 51 (2026-05-16): Spanish nouns (comida[s], cena,
  // almuerzo, desayuno, menú, compra) and verbs (planea, crea) added.
  // "compra" alone covers "lista de la compra" (ES grocery list idiom)
  // which uses the singular noun form.
  // Phase 11 batch 58 (2026-05-16): Spanish verb infinitive "cenar" +
  // pre-workout context "entrenamiento" added so fueling-support
  // questions reach the parser.
  if (!/\b(cooking|cozinha|meals?|refeic[aã]o|refeicoes|refeic[oõ]es|jantar|almoco|ceia|lanche|grocery|compras?|shopping|comida[s]?|fueling|pre[\s-]?treino|pre[\s-]?workout|pre[\s-]?entrenamiento|antes\s+del?\s+entrenamiento|fuel\s+for|caf[eé]\s+da\s+manh[aã]|cafe\s+da\s+manha|pequeno[\s-]almo[cç]o|que\s+tal|card[aá]pio|ementa|menu|men[uú]|recipe|receita|receitas|cena[s]?|cenar|almorzar|desayunar|almuerzo[s]?|desayuno[s]?|dinner|lunch|breakfast|snack|supper|brunch)\b/.test(folded)) return null;
  // Recipe recommendation is generic skill advice, not a Nexus write/read
  // action. Let the Cooking domain answer directly unless the request also
  // asks to save it into meal planning or grocery state.
  if (/\b(recipe|receita|receitas)\b/.test(folded)
    && !/\b(card[aá]pio|ementa|meal\s+plan|plano\s+de\s+refeic[oõ]es|lista\s+de\s+compras|grocery|shopping|compras|guardar|save|salvar|adiciona|add)\b/.test(folded)) {
    return null;
  }
  const nextWeek = /\b(next week|proxima semana|próxima semana)\b/.test(folded);
  const weekStart = now.plus({ weeks: nextWeek ? 1 : 0 }).startOf('week').toISODate();
  // Phase 10 batch 51: Spanish "lista de la compra" added (the ES form
  // uses "de la" where PT uses "de"). "lista de compras" is preserved
  // for PT-BR compatibility.
  if (/\b(grocery|shopping list|lista de la compra|lista de compras|lista del super|compras)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'cooking',
      action: 'cooking_grocery_list',
      risk: 'safe_write',
      provider: 'nexus',
      args: { weekStart },
      requiredArgsPresent: Boolean(weekStart),
    });
  }
  if (/\b(meals?\s+plan|plano de refeic[oõ]es|ementa|card[aá]pio|men[uú])\b/.test(folded)
    || /\b(planear|planejar|plan|cria|criar|crea[r]?|planea[r]?|gera|gerar|faz(?:er)?|monta[r]?)\b.*\b(jantar|almoco|refeic[aã]o|refeic[oõ]es|meals?|card[aá]pio|ementa|comida[s]?|cena[s]?|almuerzo[s]?|desayuno[s]?|men[uú])\b/.test(folded)) {
    return makeStep(input, {
      skill: 'cooking',
      action: 'cooking_meal_plan',
      risk: 'safe_write',
      provider: 'nexus',
      args: { dateRange: nextWeek ? 'next_week' : 'this_week', rawRequest: input.text },
      requiredArgsPresent: false,
    });
  }
  // Phase 11 batch 58: Spanish pre-workout fueling — "antes del
  // entrenamiento" / "pre-entrenamiento" added alongside PT/EN.
  return makeStep(input, {
    skill: 'cooking',
    action: /\b(fuel|fueling|pre[\s-]?treino|pre[\s-]?workout|pre[\s-]?entrenamiento|antes\s+del?\s+entrenamiento|sugest[aã]o\s+de\s+pre|fuel\s+for)\b/.test(folded) ? 'cooking_fueling_support' : 'cooking_meal_support',
    risk: 'read_only',
    provider: 'nexus',
    args: { mealContext: input.text },
    requiredArgsPresent: true,
  });
}
