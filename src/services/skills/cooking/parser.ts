// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Per-skill deterministic parser for the cooking skill. Extracted from
// chat-action-planner.ts on 2026-05-15 (planner-split, audit implementation
// plan Phase 0).

import { DateTime } from 'luxon';

import { makeStep, type StepKeyInputs } from '../step-builder';
import type { ChatPlanStep } from '../../chat/types';
import { parseCookingSubstitution } from './substitution';

export type CookingMealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface CookingMealSlot {
  date?: string;
  mealType?: CookingMealType;
  title?: string;
}

export type CookingDeleteAction =
  | 'cooking_delete_recipe'
  | 'cooking_delete_meal'
  | 'cooking_delete_pantry_item';

export interface CookingDeleteTarget {
  action: CookingDeleteAction;
  args: Record<string, unknown>;
  requiredArgsPresent: boolean;
}

const COOKING_MEAL_TYPE_PATTERNS: Array<[CookingMealType, RegExp]> = [
  ['breakfast', /\b(?:breakfast|cafe\s+da\s+manha|pequeno[\s-]?almoco|desayuno)\b/],
  ['lunch', /\b(?:lunch|almoco|almuerzo)\b/],
  ['dinner', /\b(?:dinner|supper|jantar|cena)\b/],
  ['snack', /\b(?:snack|lanche|merienda|ceia)\b/],
];

/** Extract one executable, dated meal slot. This intentionally does not
 * manufacture a weekly plan: Cooking's safe-write contract persists one
 * concrete meal at a time. */
export function extractCookingMealSlot(text: string, now: DateTime): CookingMealSlot {
  const folded = foldCookingText(text);
  const mealType = COOKING_MEAL_TYPE_PATTERNS.find(([, pattern]) => pattern.test(folded))?.[0];
  const date = extractCookingMealDate(text, folded, now);
  const title = extractCookingMealTitle(text, folded, Boolean(mealType), Boolean(date));
  return {
    ...(date ? { date } : {}),
    ...(mealType ? { mealType } : {}),
    ...(title ? { title } : {}),
  };
}

export function parseCookingActionStep(
  input: StepKeyInputs & { text: string },
  folded: string,
  now: DateTime,
): ChatPlanStep | null {
  const deleteStep = parseCookingDeleteStep(input, folded, now);
  if (deleteStep) return deleteStep;
  if (isCookingLegacyToolIntent(input.text)) return null;
  const substitution = parseCookingSubstitution(input.text, now);
  if (substitution) {
    return makeStep(input, {
      skill: 'cooking',
      action: 'cooking_substitute_ingredient',
      risk: 'safe_write',
      provider: 'nexus',
      args: { ...substitution },
      requiredArgsPresent: Boolean(
        substitution.date
          && substitution.mealType
          && substitution.originalIngredient
          && substitution.suggestedIngredient,
      ),
    });
  }

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
    && !/\b(card[aá]pio|ementa|meal\s+plan|plano\s+de\s+refeic[oõ]es|lista\s+de\s+compras|grocery|shopping|compras)\b/.test(folded)) {
    return null;
  }
  // Phase 10 batch 51: Spanish "lista de la compra" added (the ES form
  // uses "de la" where PT uses "de"). "lista de compras" is preserved
  // for PT-BR compatibility.
  if (/\b(grocery|shopping list|lista de la compra|lista de compras|lista del super|compras)\b/.test(folded)) {
    const groceryReadIntent = /^(?:please\s+)?(?:show|list|open|view|read|display|what(?:'s|\s+is)?|mostra[r]?|lista[r]?|abre|ver|qual|quais|o\s+que|muestra|lee|que\s+hay)\b/.test(folded);
    const groceryWriteIntent = !groceryReadIntent && (
      /\b(?:generate|create|make|build|prepare|regenerate|gera[r]?|cria[r]?|faz(?:er)?|monta[r]?|prepara[r]?|crea[r]?|genera[r]?|arma[r]?)\b\s+(?:(?:me|us|a|an|the|my|our|this|weekly|uma?|o|a|minha|nossa|la|mi|una|del|de)\s+){0,4}(?:(?:last|next|this|current)\s+week'?s?\s+)?(?:grocery(?:\s+list)?|shopping\s+list|lista\s+de\s+la\s+compra|lista\s+de\s+compras|lista\s+del\s+super|compras)\b/.test(folded)
      || /\b(?:grocery(?:\s+list)?|shopping\s+list|lista\s+de\s+la\s+compra|lista\s+de\s+compras|lista\s+del\s+super|compras)\b\s*[,;:\-]?\s*(?:please\s+)?(?:regenerate|rebuild|regenera[r]?|refaz(?:er)?|recria[r]?)\b/.test(folded)
    );
    if (!groceryWriteIntent) {
      return makeStep(input, {
        skill: 'cooking',
        action: 'cooking_meal_support',
        risk: 'read_only',
        provider: 'nexus',
        args: { mealContext: input.text, supportMode: 'shopping_list_read' },
        requiredArgsPresent: true,
      });
    }
    const weekStart = extractCookingGroceryWeekStart(input.text, now);
    return makeStep(input, {
      skill: 'cooking',
      action: 'cooking_grocery_list',
      risk: 'safe_write',
      provider: 'nexus',
      args: { weekStart },
      requiredArgsPresent: Boolean(weekStart),
    });
  }
  const englishPlanVerb = /^(?:please\s+)?plan\b/.test(folded)
    || /^(?:can|could|would)\s+you\s+plan\b/.test(folded);
  const hasMealMutationIntent = (englishPlanVerb
    || /\b(planear|planejar|planeia[r]?|planeja[r]?|cria|criar|crea[r]?|planea[r]?|gera|gerar|faz(?:er)?|monta[r]?|set|save|add|adiciona|agenda|schedule|programa)\b/.test(folded))
    && /\b(jantar|almoco|refeic[aã]o|refeic[oõ]es|meals?|meal\s+plan|plano\s+de\s+refeic[oõ]es|card[aá]pio|ementa|comida[s]?|cena[s]?|almuerzo[s]?|desayuno[s]?|breakfast|lunch|dinner|snack|men[uú])\b/.test(folded);
  const mealSlot = extractCookingMealSlot(input.text, now);
  if (hasMealMutationIntent && Boolean(mealSlot.date || mealSlot.mealType)) {
    return makeStep(input, {
      skill: 'cooking',
      action: 'cooking_meal_plan',
      risk: 'safe_write',
      provider: 'nexus',
      args: { ...mealSlot },
      requiredArgsPresent: Boolean(mealSlot.date && mealSlot.mealType && mealSlot.title),
    });
  }
  if (hasMealMutationIntent) {
    // Bulk weekly generation is not a Cooking write capability. Route the
    // request to local advisory support instead of persisting an unexecutable
    // weekly-plan draft that can never satisfy the single-slot contract.
    return makeStep(input, {
      skill: 'cooking',
      action: 'cooking_meal_support',
      risk: 'read_only',
      provider: 'nexus',
      args: {
        mealContext: input.text,
        capabilityBoundary: 'single_meal_slot_only',
      },
      requiredArgsPresent: true,
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

export function parseCookingDeleteStep(
  input: StepKeyInputs & { text: string },
  _folded: string,
  now: DateTime,
): ChatPlanStep | null {
  const target = extractCookingDeleteTarget(input.text, now);
  if (!target) return null;
  return makeStep(input, {
    skill: 'cooking',
    action: target.action,
    risk: 'destructive',
    provider: 'nexus',
    args: target.args,
    requiredArgsPresent: target.requiredArgsPresent,
  });
}

/** Canonical, side-effect-free extractor shared by deterministic planning and
 * the runtime typed-slot registry. It recognizes only direct delete commands,
 * so ingredient/constraint phrases cannot be misclassified as destructive
 * Cooking actions. */
export function extractCookingDeleteTarget(text: string, now: DateTime): CookingDeleteTarget | null {
  const targetKind = cookingDeleteCommandTarget(foldCookingText(text));
  if (!targetKind) return null;
  if (targetKind === 'recipe') {
    const recipeId = Number(text.match(/\b(?:recipe|receita|receta)\s*#?\s*(\d+)\b/i)?.[1]);
    const valid = Number.isSafeInteger(recipeId) && recipeId > 0;
    return {
      action: 'cooking_delete_recipe',
      args: valid ? { recipeId } : {},
      requiredArgsPresent: valid,
    };
  }
  if (targetKind === 'pantry') {
    const itemId = Number(
      text.match(/\b(?:pantry(?:\s+item)?|item\s+(?:from\s+)?(?:the\s+)?pantry|despensa)\s*#?\s*(\d+)\b/i)?.[1]
      ?? text.match(/\bitem\s*#?\s*(\d+)\s+(?:from|in)\s+(?:the\s+)?pantry\b/i)?.[1],
    );
    const valid = Number.isSafeInteger(itemId) && itemId > 0;
    return {
      action: 'cooking_delete_pantry_item',
      args: valid ? { itemId } : {},
      requiredArgsPresent: valid,
    };
  }
  const slot = extractCookingMealSlot(text, now);
  const args = {
    ...(slot.date ? { date: slot.date } : {}),
    ...(slot.mealType ? { mealType: slot.mealType } : {}),
  };
  return {
    action: 'cooking_delete_meal',
    args,
    requiredArgsPresent: Boolean(slot.date && slot.mealType),
  };
}

function cookingDeleteCommandTarget(folded: string): 'recipe' | 'pantry' | 'meal' | null {
  const command = folded.match(
    /^(?:(?:please|por\s+favor)\s+)?(?:(?:can|could|would)\s+you\s+|(?:podes?|pode)\s+|(?:puedes?|puede)\s+)?(?:delete|remove|apaga[r]?|remove[r]?|elimina[r]?)\s+(.+)$/,
  );
  const target = command?.[1]?.trim();
  if (!target) return null;
  if (/^(?:(?:the|my|a|o|a|minha?|meu|la|mi|saved|guardad[oa])\s+)*(?:recipe|receita|receta)\b/.test(target)) {
    return 'recipe';
  }
  if (/^(?:(?:the|my|a|o|a|minha?|meu|la|mi)\s+)*(?:pantry(?:\s+item)?|despensa|item\s+(?:from|in)\s+(?:the\s+)?pantry|item\s*#?\s*\d+\s+(?:from|in)\s+(?:the\s+)?pantry)\b/.test(target)) {
    return 'pantry';
  }
  if (/\b(?:event|evento|meeting|reuniao|reunion|appointment|compromisso|cita)\b/.test(target)
    || /\b(?:from|in|on)\s+(?:my|the)?\s*(?:calendar|agenda)\b/.test(target)) {
    return null;
  }
  const mealPrefix = /^(?:(?:the|my|a|o|a|minha?|meu|la|mi|planned|planead[oa])\s+)*(?:(?:today|tonight|tomorrow'?s?|hoje|amanha|hoy|manana|\d{4}-\d{2}-\d{2})\s+)*(?:breakfast|cafe\s+da\s+manha|pequeno[\s-]?almoco|desayuno|lunch|almoco|almuerzo|dinner|supper|jantar|cena|snack|lanche|merienda|ceia|meal|refeicao|comida)\b/;
  return mealPrefix.test(target) ? 'meal' : null;
}

/** Cooking CRUD already has tenant-scoped, confirmation-aware legacy tools.
 * Leave those requests on the tool-capable chat path until an equivalent
 * typed action exists; the deterministic meal-support action must not swallow
 * or reinterpret them. */
export function isCookingLegacyToolIntent(text: string): boolean {
  const folded = foldCookingText(text);
  const crudVerb = /\b(?:add|create|save|update|edit|delete|remove|show|list|get|remember|set|adiciona[r]?|cria[r]?|guarda[r]?|atualiza[r]?|edita[r]?|apaga[r]?|remove[r]?|mostra[r]?|lista[r]?|lembra[r]?|define|crea[r]?|guarda[r]?|actualiza[r]?|edita[r]?|elimina[r]?|muestra|recuerda|establece)\b/.test(folded);
  if (!crudVerb) return false;
  const typedDelete = cookingDeleteCommandTarget(folded) !== null;
  if (typedDelete) return false;
  if (/\b(?:recipe|recipes|receita|receitas|receta|recetas|pantry|despensa|despensas)\b/.test(folded)) return true;
  if (/\b(?:allergy|allergies|dietary restriction|food preference|cooking preference|alergia|alergias|restricao alimentar|preferencia culinaria|restriccion alimentaria|preferencia de cocina)\b/.test(folded)) return true;
  return false;
}

export function extractCookingGroceryWeekStart(text: string, now: DateTime): string | undefined {
  const explicit = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (explicit) {
    const parsed = DateTime.fromISO(explicit, { zone: now.zoneName ?? 'UTC' });
    return parsed.isValid && parsed.toISODate() === explicit && parsed.weekday === 1 ? explicit : undefined;
  }
  const folded = foldCookingText(text);
  if (/\b(?:last week|semana passada|semana anterior|la semana pasada)\b/.test(folded)) {
    return now.minus({ weeks: 1 }).startOf('week').toISODate() ?? undefined;
  }
  if (/\b(?:next week|proxima semana|semana que vem|la proxima semana)\b/.test(folded)) {
    return now.plus({ weeks: 1 }).startOf('week').toISODate() ?? undefined;
  }
  if (/\b(?:this week|esta semana)\b/.test(folded)) return now.startOf('week').toISODate() ?? undefined;
  if (cookingNamedWeekday(folded) != null
    || /\b(?:yesterday|ontem|ayer|last month|next month|mes passado|proximo mes|mes que vem|mes pasado)\b/.test(folded)) {
    return undefined;
  }
  return now.startOf('week').toISODate() ?? undefined;
}

function extractCookingMealDate(text: string, folded: string, now: DateTime): string | undefined {
  const explicit = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (explicit) {
    const parsed = DateTime.fromISO(explicit, { zone: now.zoneName ?? 'UTC' });
    if (parsed.isValid && parsed.toISODate() === explicit) return explicit;
  }
  if (/\b(?:day after tomorrow|depois de amanha|pasado manana)\b/.test(folded)) {
    return now.plus({ days: 2 }).toISODate() ?? undefined;
  }
  if (/\b(?:tomorrow|amanha|manana)\b/.test(folded)) {
    return now.plus({ days: 1 }).toISODate() ?? undefined;
  }
  if (/\b(?:today|tonight|hoje|esta noite|hoy|esta noche)\b/.test(folded)) return now.toISODate() ?? undefined;
  return undefined;
}

function extractCookingMealTitle(text: string, folded: string, hasMealType: boolean, hasDate: boolean): string | undefined {
  if (!hasMealType && !hasDate) return undefined;
  const afterSeparator = text.match(/(?:\s*:(?!\s*\d)\s*|\s+[–—-]\s+|\b(?:called|named|titled|chamad[oa]|llamad[oa])\b\s*)([^:]+)$/i)?.[1];
  const direct = normalizeMealTitle(afterSeparator);
  if (direct && !isCookingConstraintOnlyTitle(direct)) return direct;
  if (direct) return undefined;

  let candidate = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gi, ' ')
    .replace(/\b(?:day\s+after\s+tomorrow|depois\s+de\s+amanh[aã]|pasado\s+ma[nñ]ana|tomorrow|amanh[aã]|ma[nñ]ana|today|tonight|hoje|esta\s+noite|hoy|esta\s+noche)\b/gi, ' ')
    .replace(/\b(?:breakfast|caf[eé]\s+da\s+manh[aã]|pequeno[\s-]?almo[cç]o|desayuno|lunch|almo[cç]o|almuerzo|dinner|supper|jantar|cena|snack|lanche|merienda|ceia)\b/gi, ' ')
    .replace(/\b(?:please|por\s+favor|plan|planejar|planeja[r]?|planeia[r]?|planea[rs]?|schedule|programa[rs]?|set|save|guarda[r]?|add|adiciona[r]?|cria[r]?|create|make|faz(?:er)?|meal|refei[cç][aã]o)\b/gi, ' ')
    .replace(/\b(?:for|on|at|as|to|my|the|para|na|ao|a|o|um|uma|de|do|da|en|el|la|al|mi)\b/gi, ' ')
    .replace(/[,:;.!?()\[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (candidate === folded) return undefined;
  const inferredTitle = normalizeMealTitle(candidate);
  return inferredTitle
    && !isCookingConstraintOnlyTitle(inferredTitle)
    && hasCookingMealTitleEvidence(inferredTitle)
    ? inferredTitle
    : undefined;
}

function normalizeMealTitle(value: string | undefined): string | undefined {
  const title = value?.replace(/\s+/g, ' ').replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '').trim();
  if (!title || title.length > 160) return undefined;
  const folded = foldCookingText(title);
  if (!/[\p{L}]/u.test(title)) return undefined;
  if (/^(?:this|next)?\s*week$/.test(folded)) return undefined;
  if (/^\d{1,2}(?:(?::|h)\d{2})?\s*(?:am|pm|h)?$/.test(folded)) return undefined;
  return title;
}

export function hasCookingMealTitleEvidence(value: string): boolean {
  const folded = foldCookingText(value);
  return /\b(?:grilled|roasted|baked|fried|steamed|stewed|salmon|chicken|turkey|beef|pork|fish|tuna|cod|egg|eggs|tofu|tempeh|beans|lentils|rice|pasta|noodles|potato|vegetable|vegetables|salad|soup|stew|curry|bowl|sandwich|wrap|toast|oats|yogurt|fruit|quinoa|couscous|risotto|chili|omelet|omelette|pancakes?|smoothie|pizza|burger|tacos?|burrito|lasagna|moussaka|paella|shakshuka|casserole|pie|coffee|espresso|grelhado|assado|cozido|salmao|frango|peru|carne|porco|peixe|atum|bacalhau|ovo|ovos|feijao|lentilhas|arroz|massa|batata|legumes|salada|sopa|caril|taca|sanduiche|tosta|aveia|iogurte|fruta|omelete|panquecas?|batido|cafe|parrilla|asado|horneado|pollo|pavo|cerdo|pescado|huevos|frijoles|lentejas|verduras|ensalada|guiso|tazon|yogur)\b/.test(folded);
}

function isCookingConstraintOnlyTitle(value: string): boolean {
  const folded = foldCookingText(value);
  return /^(?:with\s+)?(?:no|without|sem|sin)\s+(?:fish|meat|pork|beef|chicken|dairy|milk|cheese|gluten|nuts?|peanuts?|eggs?|soy|shellfish|peixe|carne|porco|frango|leite|queijo|ovos?|amendoim|marisco|pescado|cerdo|pollo|lacteos?|leche|queso|huevos?|cacahuetes?|mariscos?)$/.test(folded)
    || /^(?:vegetarian|vegan|keto|paleo|gluten[\s-]?free|dairy[\s-]?free|high[\s-]?protein|low[\s-]?carb|vegetariano|vegano|sem\s+gluten|sem\s+lactose|rico\s+em\s+proteina|baixo\s+em\s+carbo|sin\s+gluten|sin\s+lactosa|alto\s+en\s+proteina|bajo\s+en\s+carbo)$/.test(folded);
}

export function cookingNamedWeekday(foldedText: string): number | null {
  const patterns: Array<[number, RegExp]> = [
    [1, /\b(?:monday|segunda(?:-feira)?|lunes)\b/],
    [2, /\b(?:tuesday|terca(?:-feira)?|martes)\b/],
    [3, /\b(?:wednesday|quarta(?:-feira)?|miercoles)\b/],
    [4, /\b(?:thursday|quinta(?:-feira)?|jueves)\b/],
    [5, /\b(?:friday|sexta(?:-feira)?|viernes)\b/],
    [6, /\b(?:saturday|sabado)\b/],
    [7, /\b(?:sunday|domingo)\b/],
  ];
  return patterns.find(([, pattern]) => pattern.test(foldedText))?.[0] ?? null;
}

function foldCookingText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
