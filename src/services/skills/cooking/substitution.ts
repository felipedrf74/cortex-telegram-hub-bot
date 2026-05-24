// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { DateTime } from 'luxon';
import type { CookingSubstitutionReason } from '../../cooking-chef';

export interface CookingSubstitutionSlots {
  date?: string;
  mealType?: string;
  originalIngredient?: string;
  suggestedIngredient?: string;
  reason?: CookingSubstitutionReason;
  updateShoppingList?: boolean;
}

const COOKING_CONTEXT = /\b(meal|recipe|ingredient|food|dinner|lunch|breakfast|snack|supper|jantar|almo[cç]o|pequeno[\s-]almo[cç]o|caf[eé]\s+da\s+manh[aã]|lanche|refei[cç][aã]o|receita|ingrediente|comida|cena|almuerzo|desayuno|merienda|receta|ingrediente)\b/i;
const SUBSTITUTION_VERB = /\b(replace|substitute|swap|troca[r]?|substitui[r]?|muda[r]?|reemplaza[r]?|sustituye[r]?|cambia[r]?)\b/i;

export function parseCookingSubstitution(text: string, now: DateTime): CookingSubstitutionSlots | null {
  if (!SUBSTITUTION_VERB.test(text) || !COOKING_CONTEXT.test(text)) return null;

  const fullText = text.trim();
  const mealType = extractMealType(fullText);
  const date = extractMealDate(fullText, now);
  const reason = inferSubstitutionReason(fullText);

  const withMatch = fullText.match(/\b(?:replace|substitute|swap|troca[r]?|substitui[r]?|muda[r]?|reemplaza[r]?|sustituye[r]?|cambia[r]?)\b\s+(?:the\s+|o\s+|a\s+|os\s+|as\s+|el\s+|la\s+|los\s+|las\s+)?(.+?)\s+(?:with|for|por|com|con)\s+(.+?)(?:\s+(?:in|on|for|no|na|nos|nas|en|para)\s+.+)?$/i);
  if (withMatch) {
    const originalIngredient = cleanIngredientText(withMatch[1]);
    const suggestedIngredient = cleanIngredientText(withMatch[2]);
    if (!originalIngredient || !suggestedIngredient) return null;
    return {
      date,
      mealType,
      originalIngredient,
      suggestedIngredient,
      reason,
      updateShoppingList: true,
    };
  }

  const missingCandidateMatch = fullText.match(/\b(?:replace|substitute|swap|troca[r]?|substitui[r]?|muda[r]?|reemplaza[r]?|sustituye[r]?|cambia[r]?)\b\s+(?:the\s+|o\s+|a\s+|os\s+|as\s+|el\s+|la\s+|los\s+|las\s+)?(.+?)(?:\s+(?:in|on|for|no|na|nos|nas|en|para)\s+.+)?$/i);
  if (!missingCandidateMatch) return null;
  const originalIngredient = cleanIngredientText(missingCandidateMatch[1]);
  if (!originalIngredient) return null;
  return {
    date,
    mealType,
    originalIngredient,
    reason,
    updateShoppingList: true,
  };
}

function extractMealType(text: string): string | undefined {
  if (/\b(dinner|supper|jantar|cena)\b/i.test(text)) return 'dinner';
  if (/\b(lunch|almo[cç]o|almuerzo)\b/i.test(text)) return 'lunch';
  if (/\b(breakfast|pequeno[\s-]almo[cç]o|caf[eé]\s+da\s+manh[aã]|desayuno)\b/i.test(text)) return 'breakfast';
  if (/\b(snack|lanche|merienda)\b/i.test(text)) return 'snack';
  return undefined;
}

function extractMealDate(text: string, now: DateTime): string | undefined {
  const explicit = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (explicit) return explicit[1];
  if (/\b(tomorrow|amanh[aã]|ma[nñ]ana)\b/i.test(text)) return now.plus({ days: 1 }).toISODate() ?? undefined;
  if (/\b(today|tonight|hoje|hoy|esta\s+noite)\b/i.test(text)) return now.toISODate() ?? undefined;
  return undefined;
}

function inferSubstitutionReason(text: string): CookingSubstitutionReason {
  if (/\b(allergy|allergic|alergia|al[eé]rgic[oa]|al[eé]rgico|al[eé]rgica)\b/i.test(text)) return 'allergy';
  if (/\b(dietary|restriction|vegetarian|vegan|sem\s+gl[uú]ten|gluten[\s-]?free|restri[cç][aã]o|restricci[oó]n)\b/i.test(text)) return 'dietary_restriction';
  if (/\b(expired|out\s+of\s+date|vencid[oa]|caducad[oa]|passad[oa])\b/i.test(text)) return 'expired_pantry';
  return 'disliked_ingredient';
}

function cleanIngredientText(value: string): string {
  return value
    .replace(/\b(?:in|on|for|no|na|nos|nas|en|para)\s+(?:my\s+|the\s+|o\s+|a\s+|el\s+|la\s+)?(?:meal|recipe|dinner|lunch|breakfast|snack|jantar|almo[cç]o|cena|almuerzo|desayuno|receita|receta)\b.*$/i, '')
    .replace(/\b(?:today|tonight|tomorrow|hoje|amanh[aã]|hoy|ma[nñ]ana)\b/gi, '')
    .replace(/[.,;!?]+$/g, '')
    .trim();
}
