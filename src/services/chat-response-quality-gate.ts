// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NexusAnswerContract, NexusChatOwnerSkill } from './chat-answer-contract';

export type ChatResponseQualityStatus = 'pass' | 'repaired' | 'blocked';

export interface ChatResponseQualityGateResult {
  status: ChatResponseQualityStatus;
  text: string;
  contract: NexusAnswerContract;
  issues: string[];
  score: number;
  // Phase K (2026-05-26) — observability fields so audit_trail can
  // record whether the second-tier `unverified_success_claim` check
  // was suppressed for a creative-text owner (cooking / content).
  qualityGateSkipped?: boolean;
  qualityGateReason?: string;
}

// Phase K (Operator A3 + amendment item 3 in second review pass):
// domains where the model legitimately uses past-tense narrative
// ("Criei uma receita...") in answer-only contexts. The first-tier
// check (actionability='execute') still fires for these — only the
// second-tier `answer_only` fallback is relaxed.
//
// `training` is EXCLUDED — "Programei seu bloco Z2" is a scheduling
// claim. If a contract were accidentally marked answer_only, the
// exemption would hide a real false-success-claim.
//
// `finance` is EXCLUDED — finance answers can assert backend numbers,
// and the gate must catch unverified backend claims even on
// answer_only turns.
const CREATIVE_TEXT_OWNERS: ReadonlySet<NexusChatOwnerSkill> = new Set<NexusChatOwnerSkill>([
  'cooking',
  'content',
]);

// Phase K (Amendment item 4): within CREATIVE_TEXT_OWNERS, content can
// still claim external side effects ("Publiquei o reel", "Agendei os
// posts", "Enviei o roteiro"). Those MUST still trigger the gate —
// the creative-text skip only applies when none of these verbs appear.
const SIDE_EFFECT_SUCCESS_VERBS: ReadonlyArray<RegExp> = [
  // English
  /\b(published|posted|uploaded|submitted)\b/i,
  /\bsent (the|your|it)\b/i,
  /\b(scheduled (the|your)|saved to|added to (the|your) calendar)\b/i,
  // Portuguese
  /\b(publiquei|postei|subi|cadastrei|programei)\b/i,
  /\benviei (o|a|os|as|isso|para)\b/i,
  /\b(agendei (o|a|os|as)|atualizei (o|a)|adicionei ao calend[áa]rio)\b/i,
];

function containsSideEffectSuccessVerb(text: string): boolean {
  return SIDE_EFFECT_SUCCESS_VERBS.some((re) => re.test(text));
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

// Codex QA round 6: a STATE-ASSERTION pattern set is distinct from a
// success claim. "You have a meeting at 09:30" doesn't claim a write
// happened, but DOES assert backend state. When concrete state
// specifics show up alongside an assertion like this on an unground
// answer_only turn, the gate must still fire — even though no verb
// from SUCCESS_CLAIM_PATTERNS appears.
const STATE_ASSERTION_PATTERNS = [
  /\b(you|your)\s+(?:have|has|got|are|will\s+have|already\s+have)\b/i,
  /\b(is|are|was|were)\s+(?:scheduled|booked|on|at|for|set|planned)\b/i,
  // Codex QA round 7: PT informal second-person (`tens`, `tem`,
  // `tinhas`) without explicit `você`. Common in pt-PT. Round 8
  // added plural nouns (reuniões/chamadas/etc).
  /\b(j[aá]\s+)?(?:tens|tem|tinhas|tinha)\s+(?:uma?s?\s+)?(?:reuni(?:[aã]o|[oõ]es)|chamadas?|consultas?|liga[cç](?:[aã]o|[oõ]es)|eventos?|compromissos?|encontros?|sess(?:[aã]o|[oõ]es)|treinos?|aulas?|tarefas?|lembretes?)/i,
  /\bvoc[eê]\s+(?:tem|j[aá]\s+tem|est[aá]|tem\s+agendado|tem\s+marcado)\b/i,
  /\b(?:o|a|os|as)\s+\w+\s+(?:est[aá]|est[aã]o|s[aã]o)\s+(?:agendado|agendada|agendados|agendadas|marcado|marcada)/i,
  // Codex QA round 7/8: flipped ownership — "the 2pm slot is yours",
  // "your 2pm meeting is locked/booked/scheduled". Round 8 added
  // "your X is locked/booked/...".
  /\bis\s+(?:yours?|in\s+your\s+(?:calendar|agenda|schedule))\b/i,
  /\byour\s+(?:\w+\s+){0,4}(?:slot|meeting|call|event|appointment|reservation|session|block)(?:\s+\w+){0,7}\s+is\s+(?:locked|booked|scheduled|set|reserved|on\s+the\s+books|confirmed)\b/i,
  /\b(?:[eé]\s+(?:seu|sua)|est[aá]\s+(?:na\s+sua|no\s+seu)\s+(?:agenda|calend[aá]rio|cronograma))\b/i,
  // Codex QA round 10 P2: PT possessive form "A tua reunião ... está
  // marcada" — possessive-prefixed scheduling noun + status verb.
  // Article variants: "A tua / A sua / O teu / O seu / A minha / O meu".
  // Spans up to 8 tokens between noun and status verb. Uses \S+ for
  // token spacing because PT words contain accented chars (`às`,
  // `manhã`) that JS `\w` does not match.
  /(?:^|\s)(?:a|o)\s+(?:tua|sua|minha|nossa|teu|seu|meu|nosso)\s+(?:\S+\s+){0,8}(?:reuni(?:[aã]o|[oõ]es)|chamadas?|consultas?|liga[cç](?:[aã]o|[oõ]es)|eventos?|compromissos?|encontros?|sess(?:[aã]o|[oõ]es)|treinos?|aulas?|tarefas?|lembretes?)(?:\s+\S+){0,8}\s+(?:est[aá]|[eé]|fica)\s+(?:marcad[oa]s?|agendad[oa]s?|reservad[oa]s?|confirmad[oa]s?|definid[oa]s?|bloqueada?s?)/i,
];

function hasStateAssertion(text: string): boolean {
  return STATE_ASSERTION_PATTERNS.some((pattern) => pattern.test(text));
}

// Past-tense completion verbs only. `noted` and bare `set` are
// excluded because they collide with acknowledgments ("Noted, I'll
// let you know") and future-tense periphrasis ("I'll set up a
// reminder"). Codex QA produced failing tests for both — keep the
// list to unambiguous past-tense completions and add explicit
// past-tense forms ("set up", "have set") in IMPLIED_SUCCESS_PATTERNS
// where the auxiliary disambiguates.
const SUCCESS_CLAIM_PATTERNS = [
  /\b(done|created|scheduled|booked|moved|updated|completed|sent|deleted|removed|cancell?ed|cleared|eliminated|added|saved|logged|marked|filed|recorded)\b/i,
  /\b(pronto|criei|agendei|marquei|movi|atualizei|conclu[ií]|enviei|apaguei|removi|cancelei|limpei|eliminei|exclu[ií]|adicionei|guardei|salvei|anotei|registei|registrei|defini|gravei|lancei|lan[çc]ei|fiz isso|est[aá] feito|tudo certo)\b/i,
  /✅/,
];

// Hedged or auxiliary-anchored past tense. Requires "I've" / "I have"
// / "já" so a future "I will set up" / "vou agendar" never matches.
const IMPLIED_SUCCESS_PATTERNS = [
  /\b(i(?:'ve| have)\s+(?:just\s+)?(?:created|scheduled|booked|moved|added|saved|sent|deleted|cancell?ed|updated|set\s+up|logged|noted\s+(?:down|that)|marked|filed))\b/i,
  /\b(j[aá]\s+(?:criei|agendei|marquei|movi|adicionei|enviei|apaguei|cancelei|atualizei|defini|lancei|lan[çc]ei|registei|registrei|anotei))\b/i,
  // Sentence-initial "Set the X for HH:MM" — elided subject form of
  // "[I] set the X for HH:MM". Codex QA round 2 noted this wasn't
  // caught after I removed bare `set`. Requires a definite article so
  // imperative "Set a reminder" doesn't trigger.
  /^(set|marked)\s+the\s+\w+\s+(?:for|at|to)\s+\d/i,
];

export function applyChatResponseQualityGate(input: {
  text: string;
  contract: NexusAnswerContract;
}): ChatResponseQualityGateResult {
  const detect = detectChatResponseQualityIssuesWithSkipInfo(input.text, input.contract);
  const issues = detect.issues;
  const phaseKSkipReason = detect.creativeTextOwnerSkipReason;
  if (issues.length === 0) {
    return {
      status: 'pass',
      text: input.text,
      contract: input.contract,
      issues,
      score: 1,
      qualityGateSkipped: !!phaseKSkipReason,
      qualityGateReason: phaseKSkipReason ?? 'pass',
    };
  }

  const sanitized = sanitizeUserFacingChatText(input.text);
  const hasFakeSuccess = issues.includes('unverified_success_claim');
  const hasUnsupportedSpecifics = issues.includes('unsupported_specific_state_claim')
    || issues.includes('state_claim_without_grounding');
  const hasRecipeStructureIssue = issues.includes('recipe_missing_structure');
  const unusableRecipeSeed = hasRecipeStructureIssue && isUnusableRecipeSeed(sanitized);
  const contract: NexusAnswerContract = {
    ...input.contract,
    verificationStatus: hasFakeSuccess || hasUnsupportedSpecifics ? 'pending' : input.contract.verificationStatus,
    actionability: hasFakeSuccess || hasUnsupportedSpecifics ? 'clarify' : input.contract.actionability,
    missingFacts: [...new Set([
      ...input.contract.missingFacts,
      ...(hasFakeSuccess ? ['read_back_verification'] : []),
      ...(hasUnsupportedSpecifics ? ['scoped_state_read'] : []),
      ...(unusableRecipeSeed ? ['usable_recipe_content'] : []),
    ])],
    userFacingSummary: hasFakeSuccess || hasUnsupportedSpecifics
      ? 'Nexus needs fresher scoped state before making that claim.'
      : unusableRecipeSeed
        ? 'Nexus could not safely repair the recipe because the answer did not contain recipe content.'
      : hasRecipeStructureIssue
        ? 'Nexus repaired the answer into the expected recipe structure.'
        : input.contract.userFacingSummary,
  };

  const repairedText = hasFakeSuccess
    ? 'I understood the request, but I cannot honestly mark it done until Nexus verifies the change. I did not claim success without a read-back.'
    : hasUnsupportedSpecifics
      ? scopedReadRepairText(input.contract.language)
    : hasRecipeStructureIssue
      ? unusableRecipeSeed
        ? recipeSeedUnavailableText(input.contract.language)
        : repairRecipeStructure(sanitized, input.contract.language)
    : sanitized;

  const firstIssue = issues[0] ?? 'unknown';
  const status: ChatResponseQualityStatus = unusableRecipeSeed
    ? 'blocked'
    : hasOnlyRepairableIssues(issues) ? 'repaired' : 'blocked';
  return {
    status,
    text: repairedText,
    contract,
    issues,
    score: Math.max(0, 1 - issues.length * 0.2),
    qualityGateSkipped: !!phaseKSkipReason,
    qualityGateReason: phaseKSkipReason
      ?? (unusableRecipeSeed ? 'blocked:recipe_seed_unusable' : hasOnlyRepairableIssues(issues) ? `repaired:${firstIssue}` : `blocked:${firstIssue}`),
  };
}

/**
 * Phase K (2026-05-26): public-facing detector that wraps the
 * internal "with skip info" version. Existing callers continue to
 * receive only the string[] of issues.
 */
export function detectChatResponseQualityIssues(text: string, contract: NexusAnswerContract): string[] {
  return detectChatResponseQualityIssuesWithSkipInfo(text, contract).issues;
}

/**
 * Phase K internal helper — returns issues AND surfaces whether the
 * second-tier `unverified_success_claim` check was suppressed for a
 * creative-text owner (cooking/content). The caller uses this to set
 * `qualityGateSkipped` + `qualityGateReason` in the
 * `ChatResponseQualityGateResult` so audit_trail can record the
 * decision.
 */
function detectChatResponseQualityIssuesWithSkipInfo(
  text: string,
  contract: NexusAnswerContract,
): { issues: string[]; creativeTextOwnerSkipReason: string | null } {
  const issues = new Set<string>();
  const trimmed = text.trim();

  if (!trimmed) issues.add('empty_response');
  if (RAW_DEBUG_PATTERNS.some((pattern) => pattern.test(trimmed))) issues.add('raw_internal_content');
  // Codex QA round 2: quoted user text was treated as the model's own
  // claim. Strip text inside double/single quotes before the success
  // pattern scan so `You said: "I scheduled it for 2:00."` doesn't
  // fire a fake-success rewrite.
  const unquoted = stripQuotedText(trimmed);
  // Phase K Codex round-9 fix (F3): include SIDE_EFFECT_SUCCESS_VERBS
  // in `claimsSuccess`. Verbs like `publiquei`/`postei`/`programei`
  // aren't in SUCCESS_CLAIM_PATTERNS, so the previous predicate left
  // them unflagged in the gate — defeating the operator's defense
  // against content workflow false-success claims.
  const matchesSuccessClaim = SUCCESS_CLAIM_PATTERNS.some((pattern) => pattern.test(unquoted));
  const matchesImpliedSuccess = IMPLIED_SUCCESS_PATTERNS.some((pattern) => pattern.test(unquoted));
  const matchesSideEffectVerb = containsSideEffectSuccessVerb(unquoted);
  const claimsSuccess = matchesSuccessClaim || matchesImpliedSuccess || matchesSideEffectVerb;

  // Phase K Codex round-9 fix (F4): the live cooking contract comes
  // through as `actionability='execute'` (intent='cooking.create'),
  // not 'answer_only'. The first-tier check fires before the second-
  // tier creative-text skip is even considered, so cooking recipes
  // were still being replaced with the canned text. Apply the
  // CREATIVE_TEXT_OWNERS skip HERE too — but ONLY when there's no
  // side-effect verb. Cooking/content with side-effect verbs ("Publiquei
  // o reel") MUST still trip the gate. Finance and training remain
  // strict on the first-tier check.
  const isCreativeTextOwnerExecuteSkip =
    contract.actionability === 'execute'
    && claimsSuccess
    && contract.verificationStatus !== 'verified'
    && contract.verificationStatus !== 'partial_failure'
    && CREATIVE_TEXT_OWNERS.has(contract.ownerSkill)
    && !matchesSideEffectVerb;

  if (contract.actionability === 'execute'
    && claimsSuccess
    && contract.verificationStatus !== 'verified'
    && contract.verificationStatus !== 'partial_failure'
    && !isCreativeTextOwnerExecuteSkip) {
    issues.add('unverified_success_claim');
  }
  // Catch the harder case: actionability is "answer_only" (read/explain
  // turn) but the response still asserts a write happened. The model
  // had no tool authorization on this turn, so any past-tense write
  // verb is a hallucination, not a missing read-back.
  // Codex QA round 3 blocker: this check was corrupting deterministic
  // read responses (content-intelligence-shortcut, finance-state-shortcut,
  // chat-core-v2-deterministic) that legitimately return concrete state
  // from the backend. Gate it tightly:
  //   - skip when the route is a deterministic local read,
  //   - skip when the answer is grounded in real scoped state,
  //   - skip when verification already succeeded.
  // The remaining surface is the hallucination case: an answer_only
  // turn that claims a write happened with no grounding and no
  // verification.
  //
  // Phase K (2026-05-26) — added a final CREATIVE_TEXT_OWNERS predicate.
  // Cooking and content domains generate past-tense self-narrative
  // ("Criei uma receita...") that the model uses to describe its own
  // output. That's not a real action claim. Skip the second-tier check
  // for those owners — but ONLY when the response contains NO side-
  // effect success verb (publiquei/postei/agendei/enviei/scheduled/etc.).
  // Compute the "would have flagged but skipped" case explicitly so
  // the caller can set qualityGateSkipped correctly.
  const matchesAnswerOnlySuccessPattern =
    contract.actionability === 'answer_only'
    && claimsSuccess
    && hasConcreteStateSpecifics(unquoted)
    && contract.routeKind !== 'local_read'
    && !hasScopedStateGrounding(contract)
    && contract.verificationStatus !== 'verified';

  const isCreativeTextOwnerSkip =
    matchesAnswerOnlySuccessPattern
    && CREATIVE_TEXT_OWNERS.has(contract.ownerSkill)
    && !containsSideEffectSuccessVerb(unquoted);

  if (matchesAnswerOnlySuccessPattern && !isCreativeTextOwnerSkip) {
    issues.add('unverified_success_claim');
  }

  // Phase K (Codex round-9 fix F4): merge skip-decision across BOTH
  // tiers. If either the execute-path skip OR the answer_only skip
  // fired, surface a single `creative_text_owner:<ownerSkill>` reason.
  // Execute skip takes precedence in the reason string only because
  // it's the higher-risk path; the actual outcome (gate didn't fire)
  // is the same.
  const creativeTextOwnerSkipReason =
    isCreativeTextOwnerExecuteSkip ? `creative_text_owner:${contract.ownerSkill}:execute`
    : isCreativeTextOwnerSkip ? `creative_text_owner:${contract.ownerSkill}`
    : null;
  if (shouldEnforceLocalStateGrounding(contract)
    && !hasScopedStateGrounding(contract)
    && /\b(my|mine|today|this week|calendar|task|meu|minha|hoje|esta semana|agenda|tarefa)\b/i.test(unquoted)) {
    issues.add('state_claim_without_grounding');
  }
  // Codex QA round 6: bare time/date mentions ("2:00 PM is fine for
  // me") used to trip this gate even though they're not state claims.
  // Require the SPECIFIC to be paired with a success/action claim
  // OR a state assertion ("you have X at Y"). Otherwise the model is
  // just discussing a time, not asserting backend state.
  if (shouldEnforceLocalStateGrounding(contract)
    && !hasScopedStateGrounding(contract)
    && hasConcreteStateSpecifics(unquoted)
    && (claimsSuccess || hasStateAssertion(unquoted))) {
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

  return { issues: [...issues], creativeTextOwnerSkipReason };
}

// Strip ATTRIBUTED quoted text (3+ words inside a SINGLE quote pair)
// and markdown blockquotes. Single-word quotes (scare quotes) are
// kept so anti-detection like `I 'scheduled' it for 2:00.` still
// trips the gate. Codex QA round 4 caught the prior regex spanning
// across multiple quote pairs and deleting whole claims; the new
// version uses [^q] char classes to forbid cross-quote spanning, then
// counts words inside the captured group via a replace callback.
function stripQuotedText(text: string): string {
  const stripMultiWord = (match: string, inner: string): string => {
    const words = inner.trim().split(/\s+/).filter(Boolean);
    return words.length >= 3 ? '' : match;
  };
  return text
    // Codex QA round 4/5/6: tool-result attribution prefixes are NOT
    // assistant claims — they are the model echoing what a tool said.
    // Round 6 tightened to clause-level: strip up to the next CLAUSE
    // boundary (comma, semicolon, period, question, bang, newline)
    // rather than sentence-level. Otherwise "Tool returned: X, I
    // scheduled it for 2:00." would shield the comma-separated
    // assistant claim because the period-based sentence boundary was
    // too generous.
    .replace(/^\s*(?:the\s+tool\s+returned|tool\s+result|tool\s+output|the\s+system\s+returned|backend\s+returned|raw\s+result|o\s+resultado\s+da\s+ferramenta|resultado\s+da\s+ferramenta):[^,.?!;\n]*[,.?!;\n]?/gim, '')
    .replace(/^>\s[^\n]*$/gm, '')                           // markdown blockquote line — ReDoS-safe (CodeQL round 10)
    .replace(/"([^"]*)"/g, stripMultiWord)                  // ASCII double, no spanning
    .replace(/'([^']*)'/g, stripMultiWord)                  // ASCII single, no spanning
    .replace(/[“]([^“”]*)[”]/g, stripMultiWord)             // curly double
    .replace(/[‘]([^‘’]*)[’]/g, stripMultiWord);            // curly single
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
    // Codex QA round 7: `2pm`, `2 pm`, `14h00` — bare am/pm without
    // colon. Without this the state-assertion path missed "The 2pm
    // slot is yours.".
    || /\b\d{1,2}\s?(?:am|pm|a\.m\.|p\.m\.)\b/i.test(text)
    // Codex QA round 9: "9 in the morning" / "9 da manhã" — temporal
    // phrase where the hour digit is followed by a daypart phrase
    // instead of am/pm. "Your meeting at 9 in the morning is set"
    // slipped past the earlier patterns.
    || /\b\d{1,2}\s+(?:in\s+the\s+(?:morning|afternoon|evening|night)|at\s+night|da\s+manh[aã]|da\s+tarde|da\s+noite)\b/i.test(text)
    || /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(text)
    // Codex QA round 8: relative day anchors. "Tens reuniões marcadas
    // amanhã" had no date format my regex matched, even though
    // `amanhã` IS a concrete-state-specific in a scheduling claim.
    // ASCII-only words use \b; accented PT day names use explicit
    // non-word anchors because JS `\b` treats `ã/é/ç` as non-word
    // and refuses to match `\bamanhã\b` against `amanhã `.
    || /\b(?:today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|hoje|ontem|segunda|quarta|quinta|sexta|domingo)\b/i.test(text)
    || /(?:^|[^A-Za-z])(?:amanh[aã]|ter[cç]a|s[aá]bado)(?=$|[^A-Za-z])/i.test(text)
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

function recipeSeedUnavailableText(language: NexusAnswerContract['language']): string {
  if (language === 'pt' || language === 'mixed') {
    return 'Não consegui gerar uma receita confiável agora. Tenta novamente com o prato, número de pessoas e restrições, e eu devolvo ingredientes e modo de preparo.';
  }
  return 'I could not generate a reliable recipe right now. Try again with the dish, servings, and constraints, and I will return ingredients and method.';
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

function isUnusableRecipeSeed(text: string): boolean {
  const folded = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (/\b(nao consegui gerar|nao pude gerar|nao consegui criar|could not generate|couldn't generate|unable to generate|could not create|couldn't create|no pude generar|no consegui generar)\b/.test(folded)) {
    return true;
  }
  return /\b(proxima acao|bloco curto de foco|25 minutos|manter foco|next action|focus block|short focus)\b/.test(folded)
    && !hasRecipeContentSignal(folded);
}

function hasRecipeContentSignal(foldedText: string): boolean {
  return /\b(recipe|recipes|receita|receitas|receta|recetas|ingredientes?|ingredients?|modo de preparo|instructions?|directions?|method|preparo|cozimento|cook|cozinhe|cozinhar|asse|assar|forno|oven|servings?|porcoes|porcao|rende|macros?|calorias|calories|protein|proteina)\b/.test(foldedText)
    || /\b\d+\s?(?:g|kg|ml|l|cup|cups|tbsp|tsp|colher|colheres|xicara|xicaras|chávena|chávenas)\b/i.test(foldedText);
}
