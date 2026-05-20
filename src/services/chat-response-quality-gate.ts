// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NexusAnswerContract } from './chat-answer-contract';

export type ChatResponseQualityStatus = 'pass' | 'repaired' | 'blocked';

export interface ChatResponseQualityGateResult {
  status: ChatResponseQualityStatus;
  text: string;
  contract: NexusAnswerContract;
  issues: string[];
  score: number;
}

const RAW_DEBUG_PATTERNS = [
  /\bcalendar_busy_blocks\b/i,
  /\bsession_prescription\b/i,
  /\bfueling_gap_risk\b/i,
  /\bmp\d+\b/i,
  /\bprovider_failure:[a-z_]+\b/i,
  /\bCannot read properties of\b/i,
  /\bTypeError\b|\bReferenceError\b|\bSyntaxError\b/i,
  /\bstack trace\b/i,
  /<untrusted_tool_result>/i,
  /\{["']?(?:error|tool|provider|stack)["']?\s*:/i,
];

const SUCCESS_CLAIM_PATTERNS = [
  /\b(done|created|scheduled|booked|moved|updated|completed|sent|deleted|removed|cancell?ed|cleared|eliminated)\b/i,
  /\b(pronto|criei|agendei|marquei|movi|atualizei|conclu[ií]|enviei|apaguei|removi|cancelei|limpei|eliminei|exclu[ií])\b/i,
  /✅/,
];

export function applyChatResponseQualityGate(input: {
  text: string;
  contract: NexusAnswerContract;
}): ChatResponseQualityGateResult {
  const issues = detectChatResponseQualityIssues(input.text, input.contract);
  if (issues.length === 0) {
    return {
      status: 'pass',
      text: input.text,
      contract: input.contract,
      issues,
      score: 1,
    };
  }

  const sanitized = sanitizeUserFacingChatText(input.text);
  const hasFakeSuccess = issues.includes('unverified_success_claim');
  const hasUnsupportedSpecifics = issues.includes('unsupported_specific_state_claim')
    || issues.includes('state_claim_without_grounding');
  const hasRecipeStructureIssue = issues.includes('recipe_missing_structure');
  const contract: NexusAnswerContract = {
    ...input.contract,
    verificationStatus: hasFakeSuccess || hasUnsupportedSpecifics ? 'pending' : input.contract.verificationStatus,
    actionability: hasFakeSuccess || hasUnsupportedSpecifics ? 'clarify' : input.contract.actionability,
    missingFacts: [...new Set([
      ...input.contract.missingFacts,
      ...(hasFakeSuccess ? ['read_back_verification'] : []),
      ...(hasUnsupportedSpecifics ? ['scoped_state_read'] : []),
    ])],
    userFacingSummary: hasFakeSuccess || hasUnsupportedSpecifics
      ? 'Nexus needs fresher scoped state before making that claim.'
      : hasRecipeStructureIssue
        ? 'Nexus repaired the answer into the expected recipe structure.'
        : input.contract.userFacingSummary,
  };

  const repairedText = hasFakeSuccess
    ? 'I understood the request, but I cannot honestly mark it done until Nexus verifies the change. I did not claim success without a read-back.'
    : hasUnsupportedSpecifics
      ? scopedReadRepairText(input.contract.language)
    : hasRecipeStructureIssue
      ? repairRecipeStructure(sanitized, input.contract.language)
    : sanitized;

  return {
    status: hasOnlyRepairableIssues(issues) ? 'repaired' : 'blocked',
    text: repairedText,
    contract,
    issues,
    score: Math.max(0, 1 - issues.length * 0.2),
  };
}

export function detectChatResponseQualityIssues(text: string, contract: NexusAnswerContract): string[] {
  const issues = new Set<string>();
  const trimmed = text.trim();

  if (!trimmed) issues.add('empty_response');
  if (RAW_DEBUG_PATTERNS.some((pattern) => pattern.test(trimmed))) issues.add('raw_internal_content');
  if (contract.actionability === 'execute'
    && SUCCESS_CLAIM_PATTERNS.some((pattern) => pattern.test(trimmed))
    && contract.verificationStatus !== 'verified'
    && contract.verificationStatus !== 'partial_failure') {
    issues.add('unverified_success_claim');
  }
  if (shouldEnforceLocalStateGrounding(contract)
    && !hasScopedStateGrounding(contract)
    && /\b(my|mine|today|this week|calendar|task|meu|minha|hoje|esta semana|agenda|tarefa)\b/i.test(trimmed)) {
    issues.add('state_claim_without_grounding');
  }
  if (shouldEnforceLocalStateGrounding(contract)
    && !hasScopedStateGrounding(contract)
    && hasConcreteStateSpecifics(trimmed)) {
    issues.add('unsupported_specific_state_claim');
  }
  if (contract.expectedResponseShape === 'recipe' && !looksLikeRecipe(trimmed)) {
    issues.add('recipe_missing_structure');
  }
  if (/try again|tenta novamente|tentar novamente/i.test(trimmed)
    && contract.fallback.fallbackType !== 'none'
    && !contract.fallback.fallbackReason) {
    issues.add('generic_retry_without_reason');
  }

  return [...issues];
}

export function sanitizeUserFacingChatText(text: string): string {
  let sanitized = text;
  for (const pattern of RAW_DEBUG_PATTERNS) {
    sanitized = sanitized.replace(pattern, 'internal detail');
  }
  sanitized = sanitized.replace(/\s{3,}/g, ' ').trim();
  return sanitized || 'I could not produce a safe answer for that request.';
}

function hasOnlyRepairableIssues(issues: string[]): boolean {
  return issues.every((issue) => [
    'raw_internal_content',
    'unverified_success_claim',
    'generic_retry_without_reason',
    'state_claim_without_grounding',
    'unsupported_specific_state_claim',
    'recipe_missing_structure',
  ].includes(issue));
}

function shouldEnforceLocalStateGrounding(contract: NexusAnswerContract): boolean {
  if (contract.actionability !== 'answer_only') return false;
  return contract.groundingRequirement === 'local'
    || contract.groundingRequirement === 'local_and_web'
    || contract.routeKind === 'local_read';
}

function hasScopedStateGrounding(contract: NexusAnswerContract): boolean {
  return contract.groundingFacts.some((fact) => {
    if (!fact.safeForUser) return false;
    return ![
      'auth.scope',
      'chat.skill_capability_registry',
      'chat.router',
      'chat.active_context',
    ].includes(fact.source);
  });
}

function hasConcreteStateSpecifics(text: string): boolean {
  return /\b\d{1,2}[:h]\d{0,2}\b/.test(text)
    || /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(text)
    || /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i.test(text)
    || /[$€£]\s?\d|\b\d+[,.]\d{2}\b/.test(text);
}

function looksLikeRecipe(text: string): boolean {
  const hasIngredients = /\b(ingredients?|ingredientes?)\b/i.test(text);
  const hasSteps = /\b(preparation|instructions|method|steps?|modo de preparo|prepara[cç][aã]o|passos?)\b/i.test(text)
    || /(?:^|\n)\s*(?:1[.)-]|1\s)/.test(text);
  const hasServing = /\b(serves?|servings?|por[cç][oõ]es?|pessoas?)\b/i.test(text);
  return hasIngredients && hasSteps && hasServing;
}

function scopedReadRepairText(language: NexusAnswerContract['language']): string {
  if (language === 'pt') {
    return 'Preciso consultar os dados atuais do Nexus antes de afirmar esses detalhes com segurança. Posso verificar a seção certa e responder com base nela.';
  }
  return 'I need a current scoped read before I can state those details confidently. Ask me to check the relevant Nexus section, and I will ground the answer first.';
}

function repairRecipeStructure(text: string, language: NexusAnswerContract['language']): string {
  const title = inferRecipeTitle(text, language);
  const serves = inferRecipeServing(text, language);
  const isPT = language === 'pt' || language === 'mixed';
  const preserved = extractRecipeSeedSections(text);
  if (isPT) {
    return [
      `**${title}**`,
      '',
      `**Rende:** ${serves}`,
      '',
      '**Ingredientes:**',
      ...preserved.ingredients.map((line) => `- ${line}`),
      '',
      '**Modo de preparo:**',
      ...preserved.method.map((line, index) => `${index + 1}. ${line}`),
      '',
      'Observação: preservei os detalhes da resposta original e só reorganizei o formato.',
    ].join('\n');
  }
  return [
    `**${title}**`,
    '',
    `**Serves:** ${serves}`,
    '',
    '**Ingredients:**',
    ...preserved.ingredients.map((line) => `- ${line}`),
    '',
    '**Method:**',
    ...preserved.method.map((line, index) => `${index + 1}. ${line}`),
    '',
    'Note: I preserved the original answer details and only repaired the structure.',
  ].join('\n');
}

function inferRecipeTitle(text: string, language: NexusAnswerContract['language']): string {
  const firstLine = text.split(/\n|[.!?]/).map((line) => line.trim()).find(Boolean);
  if (firstLine && firstLine.length <= 80) {
    return firstLine.replace(/^#+\s*/, '').replace(/\*\*/g, '');
  }
  if (language === 'pt') {
    return 'Receita estruturada';
  }
  return 'Structured recipe';
}

function inferRecipeServing(text: string, language: NexusAnswerContract['language']): string {
  const explicit = text.match(/\b(?:serve|serves|servings?|rende|por[cç][oõ]es?|pessoas?)\s*:?\s*(\d{1,2})\b/i)
    ?? text.match(/\b(?:for|para)\s+(\d{1,2})\s+(?:people|pessoas|servings?|por[cç][oõ]es?)\b/i);
  if (explicit) {
    const count = explicit[1];
    return language === 'pt' || language === 'mixed'
      ? `${count} porções`
      : `${count} servings`;
  }
  return language === 'pt' || language === 'mixed' ? 'porções conforme pedido' : 'as requested';
}

function summarizeRecipeSeed(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Nexus reformatted the answer because the original response did not include recipe sections.';
  return cleaned.length > 180 ? `${cleaned.slice(0, 177).trimEnd()}...` : cleaned;
}

function extractRecipeSeedSections(text: string): { ingredients: string[]; method: string[] } {
  const fallback = summarizeRecipeSeed(text);
  const lines = text
    .split(/\n|[•·]/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean);
  const seedLines = lines.length > 0 ? lines : [fallback];
  const ingredientHints = seedLines.filter((line) => (
    /\b\d+\s?(?:g|kg|ml|l|cup|cups|tbsp|tsp|colher|colheres|xicara|xicaras|chávena|chávenas)\b/i.test(line)
    || /\b(ingredient|ingrediente|carne|trigo|frango|cebola|alho|hortela|hortelã|sal|pimenta|azeite|ovo|farinha|leite|tomate|queijo|beans?|rice|chicken|beef|onion|garlic|mint|salt|pepper|oil|egg|flour|milk|cheese)\b/i.test(line)
  ));
  const methodHints = seedLines.filter((line) => (
    /\b(mix|combine|cook|bake|roast|boil|simmer|season|serve|hydrate|preheat|misture|mistura|cozinhe|cozinhar|asse|assar|tempere|temperar|sirva|hidrate|hidratar|preaqueca|pré-aqueça|leve|coloque)\b/i.test(line)
  ));
  return {
    ingredients: (ingredientHints.length > 0 ? ingredientHints : seedLines).slice(0, 6),
    method: (methodHints.length > 0 ? methodHints : seedLines).slice(0, 6),
  };
}
