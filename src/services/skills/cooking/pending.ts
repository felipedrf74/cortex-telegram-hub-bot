// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { getActivePendingChatAction, type PendingChatAction } from '../../chat-action-state';
import type { ChatActionPlan, ChatPlannerInput } from '../../chat/types';
import type { PendingContinuationHelpers } from '../../chat/planner/pending-types';
import { makeStep } from '../step-builder';
import { extractCookingMealSlot, hasCookingMealTitleEvidence, isCookingLegacyToolIntent, parseCookingDeleteStep } from './parser';

const REQUIRED_MEAL_SLOT_FIELDS = ['date', 'mealType', 'title'] as const;

const COOKING_DELETE_REQUIRED_FIELDS = {
  cooking_delete_recipe: ['recipeId'],
  cooking_delete_meal: ['date', 'mealType'],
  cooking_delete_pantry_item: ['itemId'],
} as const;

export function buildPendingCookingContinuation(
  input: ChatPlannerInput,
  helpers: PendingContinuationHelpers,
): ChatActionPlan | null {
  const pending = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: 'cooking',
    nowIso: input.nowIso,
  });
  if (!pending) return null;
  const folded = foldCalendarText(input.text);
  const requestedZone = pending.timezone || input.timezone;
  const parsedNow = DateTime.fromISO(input.nowIso ?? new Date().toISOString(), { setZone: true });
  const now = (parsedNow.isValid ? parsedNow : DateTime.now()).setZone(requestedZone);
  if (pending.action in COOKING_DELETE_REQUIRED_FIELDS) {
    return buildPendingCookingDeleteContinuation(input, helpers, pending, folded, now);
  }
  if (pending.action !== 'cooking_meal_plan') return null;
  if (isCookingLegacyToolIntent(input.text)) return null;
  // A newly issued typed destructive command owns the turn. It must never be
  // reinterpreted as an answer to an older safe-write draft.
  if (parseCookingDeleteStep(input, folded, now)) return null;
  if (pending.missingSlots.includes('constraints')) {
    const constraints = extractCookingConstraints(folded);
    if (constraints.length === 0) return null;
    const step = makeStep(input, {
      skill: 'cooking',
      action: 'cooking_meal_plan',
      risk: 'safe_write',
      provider: 'nexus',
      args: {
        ...pending.collectedSlots,
        constraints,
        pendingActionId: pending.id ?? (pending as unknown as { pendingActionId?: string }).pendingActionId,
      },
      requiredArgsPresent: true,
    });
    return helpers.buildPlanFromSteps(
      input,
      [step],
      ['pending_cooking_meal_plan_continuation', `constraints:${constraints.length}`],
      0.9,
    );
  }
  const extracted = extractCookingMealSlot(input.text, now);
  const collected: Record<string, unknown> = { ...pending.collectedSlots };
  let suppliedMissingSlot = false;
  let suppliedFreeFormTitle = false;
  for (const field of REQUIRED_MEAL_SLOT_FIELDS) {
    const extractedValue = extracted[field];
    if (extractedValue == null || extractedValue === '') continue;
    if (!pending.missingSlots.includes(field)) {
      const collectedValue = collected[field];
      if (collectedValue != null && collectedValue !== '' && String(collectedValue) !== String(extractedValue)) return null;
      continue;
    }
    collected[field] = extractedValue;
    suppliedMissingSlot = true;
  }
  if (!collected.title
    && pending.missingSlots.length === 1
    && pending.missingSlots[0] === 'title') {
    const freeFormTitle = pendingFreeFormMealTitle(input.text, folded);
    if (freeFormTitle) {
      collected.title = freeFormTitle;
      suppliedMissingSlot = true;
      suppliedFreeFormTitle = true;
    }
  }
  // Do not let durable Cooking state hijack unrelated task/calendar/chat
  // commands. A constraint-like answer remains in clarification; all other
  // turns with no newly supplied slot return to normal routing.
  if (!suppliedMissingSlot && !isCookingConstraintReply(folded)) return null;
  // Durable pending state may accept compact slot replies ("tomorrow",
  // "dinner", "vegan chili") but must not capture an unrelated command or
  // question merely because it contains a date or meal word.
  if (suppliedMissingSlot
    && !suppliedFreeFormTitle
    && !isCompactCookingPendingReply(input.text, folded)) return null;
  const missing = REQUIRED_MEAL_SLOT_FIELDS.filter((field) => collected[field] == null || collected[field] === '');
  const step = makeStep(input, {
    skill: 'cooking',
    action: 'cooking_meal_plan',
    risk: 'safe_write',
    provider: 'nexus',
    args: { ...collected, pendingActionId: pending.id },
    requiredArgsPresent: missing.length === 0,
  });
  return helpers.buildPlanFromSteps(
    input,
    [step],
    ['pending_cooking_meal_plan_continuation', `collected:${REQUIRED_MEAL_SLOT_FIELDS.length - missing.length}`],
    0.9,
  );
}

function buildPendingCookingDeleteContinuation(
  input: ChatPlannerInput,
  helpers: PendingContinuationHelpers,
  pending: PendingChatAction,
  folded: string,
  now: DateTime,
): ChatActionPlan | null {
  const action = pending.action as keyof typeof COOKING_DELETE_REQUIRED_FIELDS;
  const directDelete = parseCookingDeleteStep(input, folded, now);
  if (directDelete && directDelete.action !== action) return null;
  if (isCookingLegacyToolIntent(input.text) && !directDelete) return null;
  const collected: Record<string, unknown> = { ...pending.collectedSlots };
  let suppliedMissingSlot = false;

  if (action === 'cooking_delete_recipe') {
    const compactId = input.text.match(/^\s*(?:(?:recipe|receita|receta)\s*)?#?\s*(\d+)\s*$/i)?.[1];
    const recipeId = Number(directDelete?.args.recipeId ?? compactId);
    if (Number.isSafeInteger(recipeId) && recipeId > 0 && pending.missingSlots.includes('recipeId')) {
      collected.recipeId = recipeId;
      suppliedMissingSlot = true;
    }
  } else if (action === 'cooking_delete_pantry_item') {
    const compactId = input.text.match(/^\s*(?:(?:pantry(?:\s+item)?|item|despensa)\s*)?#?\s*(\d+)\s*$/i)?.[1];
    const itemId = Number(directDelete?.args.itemId ?? compactId);
    if (Number.isSafeInteger(itemId) && itemId > 0 && pending.missingSlots.includes('itemId')) {
      collected.itemId = itemId;
      suppliedMissingSlot = true;
    }
  } else {
    const extracted = directDelete?.args ?? extractCookingMealSlot(input.text, now);
    if (!directDelete && !isCompactCookingPendingReply(input.text, folded)) return null;
    for (const field of COOKING_DELETE_REQUIRED_FIELDS.cooking_delete_meal) {
      const value = extracted[field];
      if (value == null || value === '') continue;
      if (!pending.missingSlots.includes(field)) {
        const existing = collected[field];
        if (existing != null && existing !== '' && String(existing) !== String(value)) return null;
        continue;
      }
      collected[field] = value;
      suppliedMissingSlot = true;
    }
  }
  if (!suppliedMissingSlot) return null;
  const requiredFields = COOKING_DELETE_REQUIRED_FIELDS[action];
  const missing = requiredFields.filter((field) => collected[field] == null || collected[field] === '');
  const step = makeStep(input, {
    skill: 'cooking',
    action,
    risk: 'destructive',
    provider: 'nexus',
    args: { ...collected, pendingActionId: pending.id },
    requiredArgsPresent: missing.length === 0,
  });
  return helpers.buildPlanFromSteps(
    input,
    [step],
    ['pending_cooking_delete_continuation', `collected:${requiredFields.length - missing.length}`],
    0.96,
  );
}

function isCompactCookingPendingReply(text: string, folded: string): boolean {
  if (/[?]/.test(text)) return false;
  if (/\b(?:task|meeting|calendar|email|mail|reminder|invoice|payment|workout|training|evento|tarefa|lembrete|fatura|pagamento|treino|reuniao)\b/.test(folded)) {
    return false;
  }
  if (hasCookingMealTitleEvidence(text)) return true;
  if (/^(?:title|meal|dish|titulo|refeicao|prato|nombre|comida|plato)\b/.test(folded)) return true;

  const residual = folded
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(?:day\s+after\s+tomorrow|depois\s+de\s+amanha|pasado\s+manana|tomorrow|amanha|manana|today|tonight|hoje|esta\s+noite|hoy|esta\s+noche)\b/g, ' ')
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|segunda(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sabado|domingo|lunes|martes|miercoles|jueves|viernes)\b/g, ' ')
    .replace(/\b(?:breakfast|cafe\s+da\s+manha|pequeno[\s-]?almoco|desayuno|lunch|almoco|almuerzo|dinner|supper|jantar|cena|snack|lanche|merienda|ceia)\b/g, ' ')
    .replace(/\b\d{1,2}(?:(?::|h)\d{2})?\s*(?:am|pm|h)?\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!residual) return true;
  const fillerWords = new Set([
    'please', 'yes', 'yeah', 'ok', 'okay', 'sure', 'on', 'for', 'at', 'the',
    'date', 'meal', 'it', 'is', 'make', 'set', 'put', 'works', 'that', 'do',
    'lets', 'me', 'por', 'favor', 'sim', 'em', 'para', 'a', 'o', 'data',
    'refeicao', 'isso', 'e', 'faz', 'coloca', 'vale', 'la', 'fecha', 'comida',
  ]);
  return residual.split(/\s+/).every((word) => fillerWords.has(word));
}

function pendingFreeFormMealTitle(text: string, folded: string): string | null {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  const explicitAnswer = normalizedText.match(
    /^(?:title|meal|dish|titulo|título|refeicao|refeição|prato|nombre|comida|plato)(?::\s*|\s+(?:is|e|é|es)\s+)(.+)$/iu,
  )?.[1] ?? normalizedText.match(/^(?:call\s+it|name\s+it|chama(?:r)?|llama(?:r)?)\s+(.+)$/iu)?.[1];
  const labeledAnswer = explicitAnswer ?? normalizedText.match(
    /^(?:title|meal|dish|titulo|título|refeicao|refeição|prato|nombre|comida|plato)\s+(.+)$/iu,
  )?.[1];
  const title = (labeledAnswer ?? normalizedText).replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '').trim();
  if (!title || title.length > 160) return null;
  if (/^(?:yes|no|sim|nao|não|ok|okay|sure|maybe|talvez)$/.test(folded)) return null;
  if (/^(?:breakfast|cafe\s+da\s+manha|pequeno[\s-]?almoco|desayuno|lunch|almoco|almuerzo|dinner|supper|jantar|cena|snack|lanche|merienda|ceia|today|hoje|hoy|tomorrow|amanha|manana|day\s+after\s+tomorrow|depois\s+de\s+amanha|pasado\s+manana|\d{4}-\d{2}-\d{2})$/.test(folded)) return null;
  const foodEvidence = hasCookingMealTitleEvidence(title);
  // A dietary adjective alone is a constraint, but it is also perfectly
  // valid inside a concrete dish title (for example "vegan chili"). Keep
  // pure constraints in clarification while accepting named dishes.
  if (isCookingConstraintReply(folded) && !foodEvidence) return null;
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length > 12 || /[?]/.test(title)) return null;
  if (/\b(?:show|list|open|find|search|create|add|delete|remove|complete|schedule|send|email|calendar|task|reminder|finance|invoice|workout|training|meeting|mostra|listar?|abre|procura|cria|adiciona|apaga|remove|completa|agenda|envia|correio|calendario|tarefa|lembrete|fatura|treino|reuniao)\b/.test(folded)) return null;
  if (/^(?:hello|hi|hey|ola|bom\s+dia|boa\s+tarde|boa\s+noite)$/.test(folded)) return null;
  if (!explicitAnswer && !foodEvidence) return null;
  return title;
}

function isCookingConstraintReply(folded: string): boolean {
  return /\b(?:vegetarian|vegan|high[\s-]?protein|low[\s-]?carb|keto|paleo|mediterranean|gluten[\s-]?free|dairy[\s-]?free|nut[\s-]?free|no\s+|vegetariano|vegano|rico\s+em\s+proteina|baixo\s+em\s+carbo|sem\s+|alto\s+en\s+proteina|bajo\s+en\s+carbo|sin\s+)\b/.test(folded);
}

function extractCookingConstraints(folded: string): string[] {
  const pattern = /\b(vegetarian|vegan|high[\s-]?protein|low[\s-]?carb|keto|paleo|mediterranean|mediterranea?|whole30|gluten[\s-]?free|dairy[\s-]?free|nut[\s-]?free|no\s+(?:fish|pork|beef|red\s+meat|dairy|gluten|sugar|carbs?)|vegetarian[oa]|vegan[oa]|rico\s+em\s+proteina|alt[oa]\s+en\s+proteina|baixo\s+em\s+carbo|baj[oa]\s+en\s+carbo|sem\s+(?:peixe|carne|gluten|laticinios?|lactose|acucar)|sin\s+(?:pescado|carne|gluten|lacteos?|lactosa|azucar))\b/gi;
  return [...new Set((folded.match(pattern) ?? []).map((value) => value.trim().toLowerCase()))].slice(0, 8);
}
