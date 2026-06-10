// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  buildCookingPreferenceReadModel,
} from './cooking-preferences';
import {
  buildCookingPreferenceMemorySummary,
  type CookingPreferenceProfile,
} from './cooking-intelligence';
import {
  containsCookingSafetyTerm,
  matchesCookingAllergenText,
  violatesCookingDietaryRestrictionText,
} from './cooking-allergen-vocabulary';

export type CookingSafetySurface =
  | 'recipe'
  | 'meal_plan'
  | 'meal_plan_substitution'
  | 'legacy_domain_answer'
  | 'chat_core_v2_recipe'
  | 'chat_core_v2_cooking';

export type CookingSafetyIssueCode =
  | 'ALLERGY_CONFLICT'
  | 'DIETARY_RESTRICTION_CONFLICT'
  | 'SAFETY_PROFILE_UNAVAILABLE';

export interface CookingSafetyIssue {
  code: CookingSafetyIssueCode;
  severity: 'blocker';
  surface: CookingSafetySurface;
  term: string;
  source: 'cooking_preference_profile' | 'compound_food_alias' | 'safety_profile_unavailable';
}

export interface CookingSafetyEvaluation {
  blocked: boolean;
  surface: CookingSafetySurface;
  issues: CookingSafetyIssue[];
}

const COMPOUND_FOOD_ALLERGEN_HINTS: Array<{
  triggers: string[];
  allergenTerms: string[];
}> = [
  {
    triggers: ['pesto', 'pesto sauce', 'molho pesto'],
    allergenTerms: ['tree nut', 'pine nut', 'cashew', 'walnut', 'frutos secos', 'pinhao'],
  },
  {
    triggers: ['worcestershire', 'worcestershire sauce', 'molho ingles'],
    allergenTerms: ['fish', 'anchovy', 'anchovies', 'peixe'],
  },
];

export function evaluateCookingSafetyText(
  userId: number,
  tenantId: number,
  surface: CookingSafetySurface,
  values: Array<string | null | undefined>,
): CookingSafetyEvaluation {
  if (!isValidCookingSafetyScopeId(userId) || !isValidCookingSafetyScopeId(tenantId)) {
    return cookingSafetyProfileUnavailable(surface);
  }
  try {
    const profile = buildCookingPreferenceReadModel(userId, tenantId).profile;
    // A successfully loaded empty profile is a valid no-preference user. The
    // preference storage layer must throw for unavailable/corrupt reads.
    return evaluateCookingSafetyTextForProfile(profile, surface, values);
  } catch {
    return cookingSafetyProfileUnavailable(surface);
  }
}

export function hasCookingSafetyPreferences(userId: number, tenantId: number): boolean {
  if (!isValidCookingSafetyScopeId(userId) || !isValidCookingSafetyScopeId(tenantId)) {
    return true;
  }
  try {
    const profile = buildCookingPreferenceReadModel(userId, tenantId).profile;
    return normalizedTerms(profile.allergies).length > 0
      || normalizedTerms(profile.dietaryRestrictions).length > 0;
  } catch {
    return true;
  }
}

export function evaluateCookingSafetyTextForProfile(
  profile: CookingPreferenceProfile,
  surface: CookingSafetySurface,
  values: Array<string | null | undefined>,
): CookingSafetyEvaluation {
  const haystacks = values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  const issues: CookingSafetyIssue[] = [];

  for (const allergy of normalizedTerms(profile.allergies)) {
    if (haystacks.some((haystack) => matchesCookingAllergenText(allergy, haystack))) {
      issues.push({
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        surface,
        term: allergy,
        source: 'cooking_preference_profile',
      });
      continue;
    }

    if (haystacks.some((haystack) => compoundFoodMayContainAllergen(haystack, allergy))) {
      issues.push({
        code: 'ALLERGY_CONFLICT',
        severity: 'blocker',
        surface,
        term: allergy,
        source: 'compound_food_alias',
      });
    }
  }

  for (const restriction of normalizedTerms(profile.dietaryRestrictions)) {
    if (haystacks.some((haystack) => violatesCookingDietaryRestrictionText(haystack, restriction))) {
      issues.push({
        code: 'DIETARY_RESTRICTION_CONFLICT',
        severity: 'blocker',
        surface,
        term: restriction,
        source: 'cooking_preference_profile',
      });
    }
  }

  return {
    blocked: issues.length > 0,
    surface,
    issues: dedupeIssues(issues),
  };
}

export function assertCookingSafetyText(
  userId: number,
  tenantId: number,
  surface: CookingSafetySurface,
  values: Array<string | null | undefined>,
): void {
  const evaluation = evaluateCookingSafetyText(userId, tenantId, surface, values);
  if (!evaluation.blocked) return;
  const issue = evaluation.issues[0];
  if (!issue) return;
  if (issue.code === 'SAFETY_PROFILE_UNAVAILABLE') {
    throw new Error(`COOKING_SAFETY_BLOCKED: ${surface} safety profile unavailable`);
  }
  const reason = issue.code === 'ALLERGY_CONFLICT' ? 'allergy' : 'dietary restriction';
  throw new Error(`COOKING_SAFETY_BLOCKED: ${surface} contains ${reason} "${issue.term}"`);
}

export function renderCookingSafetyPromptBlock(
  profile: CookingPreferenceProfile,
  locale: string | null | undefined = 'en',
): string {
  const summary = buildCookingPreferenceMemorySummary(profile);
  const safetyRules = cookingSafetyPromptRules(locale);
  if (!summary && safetyRules.length === 0) return '';
  return [
    '<cooking_safety_preferences>',
    summary,
    'Treat these as hard constraints: allergies and dietary restrictions. Do not suggest, cook, buy, or substitute ingredients that conflict with them.',
    'Treat disliked ingredients as preferences, not safety blockers.',
    ...safetyRules,
    '</cooking_safety_preferences>',
  ].filter(Boolean).join('\n');
}

export function renderCookingSafetyPromptBlockForUser(
  userId: number,
  tenantId: number,
  locale: string | null | undefined = 'en',
): string {
  if (!isValidCookingSafetyScopeId(userId) || !isValidCookingSafetyScopeId(tenantId)) {
    throw new Error('COOKING_SAFETY_PROFILE_UNAVAILABLE: invalid user or tenant scope');
  }
  const profile = buildCookingPreferenceReadModel(userId, tenantId).profile;
  return renderCookingSafetyPromptBlock(profile, locale);
}

export function renderCookingSafetyBlockedResponse(
  locale: string | null | undefined,
): string {
  const normalizedLocale = String(locale ?? 'en').toLowerCase();
  if (normalizedLocale.startsWith('pt')) {
    return [
      'Não posso sugerir essa opção porque ela conflita com uma preferência de segurança culinária guardada.',
      'Posso ajudar com uma alternativa segura que preserve o objetivo da refeição sem usar o ingrediente em conflito.',
    ].join('\n');
  }
  if (normalizedLocale.startsWith('es')) {
    return [
      'No puedo sugerir esa opción porque entra en conflicto con una preferencia de seguridad culinaria guardada.',
      'Puedo ayudar con una alternativa segura que mantenga el objetivo de la comida sin usar el ingrediente en conflicto.',
    ].join('\n');
  }
  return [
    'I cannot suggest that option because it conflicts with a saved cooking safety preference.',
    'I can help with a safe alternative that keeps the meal goal without using the conflicting ingredient.',
  ].join('\n');
}

export function cookingSafetyLogPayload(evaluation: CookingSafetyEvaluation): {
  surface: CookingSafetySurface;
  issueCodes: CookingSafetyIssueCode[];
  issueSources: CookingSafetyIssue['source'][];
  issueCount: number;
} {
  return {
    surface: evaluation.surface,
    issueCodes: [...new Set(evaluation.issues.map((issue) => issue.code))],
    issueSources: [...new Set(evaluation.issues.map((issue) => issue.source))],
    issueCount: evaluation.issues.length,
  };
}

function cookingSafetyPromptRules(locale: string | null | undefined): string[] {
  const normalizedLocale = String(locale ?? 'en').toLowerCase();
  if (normalizedLocale.startsWith('pt')) {
    return [
      'Inclui orientações de segurança alimentar quando houver carne, peixe, ovos, sobras, alimentos crus ou ingredientes vencidos: temperatura/doneness, armazenamento, reaquecimento e quando descartar.',
      'Para gravidez, bebés/crianças pequenas, idosos ou pessoas imunocomprometidas, evita alimentos de alto risco ou adiciona cautela clara.',
      'Não afirmes curar, tratar, reverter ou diagnosticar condições médicas; nutrição é orientação geral e casos clínicos devem ir para profissionais de saúde.',
    ];
  }
  if (normalizedLocale.startsWith('es')) {
    return [
      'Incluye seguridad alimentaria cuando haya carne, pescado, huevos, sobras, alimentos crudos o ingredientes vencidos: temperatura/cocción, almacenamiento, recalentado y cuándo descartar.',
      'Para embarazo, bebés/niños pequeños, personas mayores o inmunocomprometidas, evita alimentos de alto riesgo o añade una cautela clara.',
      'No afirmes curar, tratar, revertir ni diagnosticar condiciones médicas; la nutrición es orientación general y los casos clínicos van con profesionales de salud.',
    ];
  }
  return [
    'Include food-safety guidance when relevant: safe doneness/temperature, raw meat/egg/seafood handling, leftover storage, reheating, and when expired or room-temperature food should be discarded.',
    'For pregnancy, infants, older adults, or immunocompromised people, avoid standard high-risk foods or add a clear caution.',
    'Do not claim to cure, treat, reverse, or diagnose medical conditions. Nutrition guidance is general; clinical decisions belong with qualified clinicians.',
  ];
}

function isValidCookingSafetyScopeId(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function cookingSafetyProfileUnavailable(surface: CookingSafetySurface): CookingSafetyEvaluation {
  return {
    blocked: true,
    surface,
    issues: [{
      code: 'SAFETY_PROFILE_UNAVAILABLE',
      severity: 'blocker',
      surface,
      term: 'cooking_safety_profile',
      source: 'safety_profile_unavailable',
    }],
  };
}

function normalizedTerms(values: string[] | undefined): string[] {
  return [...new Set(
    (values ?? [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )];
}

function compoundFoodMayContainAllergen(haystack: string, allergy: string): boolean {
  return COMPOUND_FOOD_ALLERGEN_HINTS.some((hint) => (
    hint.triggers.some((trigger) => containsCookingSafetyTerm(haystack, trigger))
    && hint.allergenTerms.some((term) => matchesCookingAllergenText(allergy, term))
  ));
}

function dedupeIssues(issues: CookingSafetyIssue[]): CookingSafetyIssue[] {
  const seen = new Set<string>();
  const deduped: CookingSafetyIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}:${issue.surface}:${issue.term}:${issue.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}
