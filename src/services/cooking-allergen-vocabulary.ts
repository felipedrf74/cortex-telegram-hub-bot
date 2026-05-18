// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Shared Cooking safety vocabulary.
 *
 * This intentionally lives outside recipe/assessment code so write guards,
 * plan assessment, and prompt context all use the same Portuguese-aware terms.
 */

const ALLERGEN_CLUSTERS: Record<string, string[]> = {
  peanut: ['peanut', 'peanuts', 'peanut butter', 'amendoim', 'manteiga de amendoim'],
  tree_nut: [
    // English canonical names (FDA Big 9 tree nut group)
    'tree nut', 'tree nuts', 'nuts', 'nut',
    'almond', 'almonds',
    'walnut', 'walnuts',
    'cashew', 'cashews',
    'hazelnut', 'hazelnuts',
    'pistachio', 'pistachios',
    'pecan', 'pecans', 'pecan nut',
    'brazil nut', 'brazil nuts',
    'pine nut', 'pine nuts', 'pignoli',
    'macadamia', 'macadamia nut',
    // Portuguese (PT-PT + PT-BR variants — see docs/finance/portuguese-tax-rules.md style:
    // include both accented and unaccented forms because users may type either; the
    // matcher normalizes via NFD so either form matches the haystack, but having
    // both ensures expansion produces obvious tokens for debugging too)
    'frutos secos', 'fruto seco',
    'amendoa', 'amendoas', 'amêndoa', 'amêndoas',
    'noz', 'nozes',
    'caju',
    'avelã', 'avelas',
    'pistacio', 'pistacios', 'pistache', 'pistaches',
    'pecã', 'peca', 'noz pecan', 'noz-pecan',
    'castanha do para', 'castanha do pará',
    'castanha do brasil', 'castanha-do-pará', 'castanha-do-brasil',
    'pinhão', 'pinhao', 'pinhões', 'pinhoes',
    'macadâmia', 'macadamia',
  ],
  shellfish: [
    'shellfish', 'shrimp', 'prawn', 'prawns', 'crab', 'lobster', 'mussels',
    'clams', 'oysters', 'scallops', 'marisco', 'mariscos', 'camarão', 'camarao',
    'gambas', 'caranguejo', 'lagosta', 'mexilhão', 'mexilhao', 'ameijoa',
    'amêijoa', 'ostras', 'vieiras',
  ],
  fish: ['fish', 'salmon', 'tuna', 'cod', 'sardine', 'sardines', 'peixe', 'salmão', 'salmao', 'atum', 'bacalhau', 'sardinha', 'sardinhas'],
  dairy: [
    'dairy', 'milk', 'lactose', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt',
    'whey', 'casein', 'leite', 'lactose', 'laticinios', 'laticínios', 'queijo',
    'manteiga', 'natas', 'iogurte', 'soro de leite', 'caseina', 'caseína',
  ],
  egg: ['egg', 'eggs', 'ovo', 'ovos', 'clara', 'claras', 'gema', 'gemas'],
  gluten: [
    'gluten', 'wheat', 'flour', 'bread', 'pasta', 'seitan', 'barley', 'rye',
    'trigo', 'farinha', 'pão', 'pao', 'massa', 'seitan', 'cevada', 'centeio',
  ],
  soy: [
    'soy', 'soya', 'soybean', 'soybeans',
    'tofu', 'tempeh', 'natto', 'miso',
    'soy sauce', 'soy lecithin', 'soy protein', 'soy flour', 'soy milk',
    'edamame', 'edamames', 'soya bean', 'soya beans',
    // Portuguese
    'soja', 'feijao soja', 'feijão soja',
    'molho de soja', 'leite de soja', 'farinha de soja',
    'proteina de soja', 'proteína de soja',
    'lecitina de soja',
  ],
  sesame: ['sesame', 'sesame seed', 'sesame seeds', 'tahini', 'sésamo', 'sesamo', 'gergelim', 'tahini'],
};

const MEAT_AND_FISH_TERMS = [
  'beef', 'chicken', 'pork', 'turkey', 'bacon', 'ham', 'fish', 'salmon', 'tuna',
  'cod', 'shrimp', 'prawn', 'crab', 'lobster', 'shellfish',
  'vaca', 'carne', 'frango', 'porco', 'peru', 'bacon', 'fiambre', 'presunto',
  'peixe', 'salmão', 'salmao', 'atum', 'bacalhau', 'camarão', 'camarao',
  'gambas', 'caranguejo', 'lagosta', 'marisco',
];

const ANIMAL_PRODUCT_TERMS = [
  ...MEAT_AND_FISH_TERMS,
  ...ALLERGEN_CLUSTERS.dairy,
  ...ALLERGEN_CLUSTERS.egg,
  'honey', 'mel',
];

export function normalizeCookingSafetyText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function expandAllergenTerms(allergen: string): string[] {
  const normalized = normalizeCookingSafetyText(allergen);
  if (!normalized) return [];

  const terms = new Set<string>([normalized]);
  for (const clusterTerms of Object.values(ALLERGEN_CLUSTERS)) {
    const normalizedCluster = clusterTerms.map(normalizeCookingSafetyText).filter(Boolean);
    if (normalizedCluster.some((term) => containsNormalizedPhrase(normalized, term))) {
      for (const term of normalizedCluster) terms.add(term);
    }
  }

  return [...terms].sort((a, b) => b.length - a.length);
}

export function matchesCookingAllergenText(allergy: string, text: string): boolean {
  const haystack = normalizeCookingSafetyText(text);
  if (!haystack) return false;
  return expandAllergenTerms(allergy).some((term) => containsNormalizedPhrase(haystack, term));
}

export function containsCookingSafetyTerm(haystack: string, term: string): boolean {
  return containsNormalizedPhrase(normalizeCookingSafetyText(haystack), normalizeCookingSafetyText(term));
}

export function containsAnyCookingSafetyTerm(haystack: string, terms: string[]): boolean {
  return terms.some((term) => containsCookingSafetyTerm(haystack, term));
}

export function violatesCookingDietaryRestrictionText(haystack: string, restriction: string): boolean {
  const normalizedRestriction = normalizeCookingSafetyText(restriction);
  if (!normalizedRestriction) return false;
  if (['vegetarian', 'vegetariano', 'vegetariana'].includes(normalizedRestriction)) {
    return containsAnyCookingSafetyTerm(haystack, MEAT_AND_FISH_TERMS);
  }
  if (['vegan', 'vegano', 'vegana', 'plant based', 'plantbased'].includes(normalizedRestriction)) {
    return containsAnyCookingSafetyTerm(haystack, ANIMAL_PRODUCT_TERMS);
  }
  if (['gluten free', 'glutenfree', 'sem gluten', 'celiac', 'celiaco', 'celiaca'].includes(normalizedRestriction)) {
    return expandAllergenTerms('gluten').some((term) => containsCookingSafetyTerm(haystack, term));
  }
  if (['dairy free', 'dairyfree', 'lactose free', 'lactosefree', 'sem lactose', 'sem laticinios', 'sem laticinios'].includes(normalizedRestriction)) {
    return expandAllergenTerms('dairy').some((term) => containsCookingSafetyTerm(haystack, term));
  }
  return containsCookingSafetyTerm(haystack, normalizedRestriction);
}

function containsNormalizedPhrase(normalizedHaystack: string, normalizedNeedle: string): boolean {
  if (!normalizedHaystack || !normalizedNeedle) return false;
  const escaped = normalizedNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i').test(normalizedHaystack);
}

