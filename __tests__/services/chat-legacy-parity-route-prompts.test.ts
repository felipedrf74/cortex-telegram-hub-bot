import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { parseContentStateShortcut, parseFinanceStateShortcut } from '../../src/api/routes/chat-shortcut-parsers';
import { detectChatCoreV2WriteIntent } from '../../src/services/chat-core-v2/action-gateway';
import {
  CHAT_V2_PHASE7_TARGET_ROUTE_READINESS,
  CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META,
  CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META_V1_HISTORICAL,
  CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION,
  CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION_V1_HISTORICAL,
  CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS,
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META,
  CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS,
  CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL,
  CHAT_V2_LEGACY_PARITY_WRITE_ROUTE_IDS,
} from '../../src/services/chat-legacy-parity-route-prompts';
import { inferChatTurnContract } from '../../src/services/chat-turn-contract';

function route(id: string) {
  const found = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.find((item) => item.routeId === id);
  if (!found) throw new Error(`missing route prompt:${id}`);
  return found;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const RETIRED_SPANISH_MIXED_PROMPTS = new Set([
  'Crea tarea write audit com subtasks preview confirm block',
  'Cancela decision dec_route_gate confirmation',
  'Remove todas las tareas now',
]);

describe('ChatV2 legacy parity route prompts', () => {
  it('keeps the Phase 7 route set unique and fully represented', () => {
    const routeIds = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.map((item) => item.routeId);

    expect(new Set(routeIds).size).toBe(routeIds.length);
    expect(routeIds.sort()).toEqual([
      'chat_message_shortcut_after_route',
      'chat_reasoning_engine_v1',
      'classifier_route_skill_orchestration',
      'decision_confirmation_shortcut',
      'destructive_confirmation_hold',
      'domain_handler_execution',
      'general_action_planner',
      'selective_internet_research',
      'training_plan_shortcut',
    ].sort());
  });

  it('uses a versioned compatibility corpus without rewriting historical v1 evidence', () => {
    expect(CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META).toMatchObject({
      schemaVersion: 'chat_v2_legacy_parity_route_corpus_meta.v1',
      frozenBeforeImplementation: false,
      mutationPolicy: 'claude_or_manual_signoff_required_before_runtime_replacement',
      reviewRubricVersion: 'chat_v2_legacy_parity_review_rubric.v2',
    });
    expect(CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION).toBe(
      'chat_v2_legacy_parity_route_prompts@1.5.0',
    );
    expect(CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META.corpusId).toBe(
      'chatv2_phase7_route_replacement_supported_locales_v2',
    );

    for (const routePrompt of CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS) {
      expect(routePrompt.evidenceTrack, routePrompt.routeId).toMatch(/parity|bundle|research/);
      expect(routePrompt.stateContract, routePrompt.routeId).toMatch(/snapshot|fresh_isolated/);
    }

    const prompts = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.flatMap((item) => item.prompts);
    const responseLanguages = new Set(prompts.map((prompt) => prompt.language));
    const requestLanguages = new Set(prompts.map((prompt) => prompt.requestLanguage));
    for (const language of ['en', 'pt-BR', 'pt-PT', 'pt-AO', 'mixed']) {
      expect(responseLanguages.has(language as never), `missing response ${language}`).toBe(true);
    }
    expect(responseLanguages.has('es' as never)).toBe(false);
    expect(responseLanguages.has('es-419' as never)).toBe(false);
    expect(requestLanguages.has('es' as never)).toBe(false);
    expect(requestLanguages.has('es-419' as never)).toBe(false);

    expect(CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION_V1_HISTORICAL).toBe(
      'chat_v2_legacy_parity_route_prompts@1.4.0',
    );
    expect(CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META_V1_HISTORICAL.corpusId).toBe(
      'chatv2_phase7_route_replacement_heldout',
    );
    expect(
      CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL
        .flatMap((item) => item.prompts)
        .some((prompt) => prompt.language === 'es' || prompt.language === 'es-419'),
    ).toBe(true);
    expect(sha256(CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL)).toBe(
      '1481be040b73f482f5213d2b6b005abfaa86afa4bd5f879e694f5ce15fbca0da',
    );
    expect(sha256(CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META_V1_HISTORICAL)).toBe(
      'cc6fec4c51283d20a843da0cea3d6b815d482b01512acd2380ffee0f4a9330de',
    );

    const tags = new Set(prompts.flatMap((prompt) => prompt.tags ?? []));
    for (const tag of [
      'negation',
      'hypothetical',
      'task_with_subtasks',
      'destructive_write',
      'confirmation_cancel',
      'recipe_generation',
      'ambiguous_cancel',
      'duplicate_title',
      'write_read_collision',
    ]) {
      expect(tags.has(tag), `missing ${tag}`).toBe(true);
    }
  });

  it('derives retirement proof only from the immutable v1.4 EN/PT projection', () => {
    expect(CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_CORPUS_META).toMatchObject({
      version: CHAT_V2_LEGACY_PARITY_ROUTE_PROMPT_VERSION_V1_HISTORICAL,
      frozenBeforeImplementation: true,
      projectionPolicy: 'immutable_v1_4_en_pt_br_pt_pt_only',
    });
    expect(CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS).toHaveLength(
      CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL.length,
    );

    for (const retirementRoute of CHAT_V2_LEGACY_PARITY_RETIREMENT_ROUTE_PROMPTS) {
      const historicalRoute = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL
        .find((routePrompt) => routePrompt.routeId === retirementRoute.routeId)!;
      expect(retirementRoute.prompts.length, retirementRoute.routeId).toBeGreaterThan(0);
      for (const prompt of retirementRoute.prompts) {
        expect(['en', 'pt-BR', 'pt-PT'], `${retirementRoute.routeId}:${prompt.text}`)
          .toContain(prompt.language);
        expect(historicalRoute.prompts).toContain(prompt);
      }
    }

    expect(sha256(CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL)).toBe(
      '1481be040b73f482f5213d2b6b005abfaa86afa4bd5f879e694f5ce15fbca0da',
    );
    expect(sha256(CHAT_V2_LEGACY_PARITY_ROUTE_CORPUS_META_V1_HISTORICAL)).toBe(
      'cc6fec4c51283d20a843da0cea3d6b815d482b01512acd2380ffee0f4a9330de',
    );
  });

  it('replaces every retired Spanish-authored slot one-for-one with an explicit EN/PT prompt', () => {
    const expectedRetiredCounts: Record<string, number> = {
      general_action_planner: 11,
      chat_reasoning_engine_v1: 13,
      training_plan_shortcut: 13,
      selective_internet_research: 13,
      decision_confirmation_shortcut: 13,
      destructive_confirmation_hold: 11,
      classifier_route_skill_orchestration: 10,
      domain_handler_execution: 10,
      chat_message_shortcut_after_route: 0,
    };
    let pairedCount = 0;

    for (const historicalRoute of CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL) {
      const supportedRoute = route(historicalRoute.routeId);
      expect(supportedRoute.prompts).toHaveLength(historicalRoute.prompts.length);

      const retiredRows = historicalRoute.prompts
        .map((prompt, index) => ({ prompt, index }))
        .filter(({ prompt }) =>
          prompt.language === 'es'
          || prompt.language === 'es-419'
          || RETIRED_SPANISH_MIXED_PROMPTS.has(prompt.text)
        );
      expect(retiredRows, historicalRoute.routeId).toHaveLength(
        expectedRetiredCounts[historicalRoute.routeId],
      );
      pairedCount += retiredRows.length;

      for (const { prompt, index } of retiredRows) {
        const replacement = supportedRoute.prompts[index]!;
        expect(['en', 'pt-BR', 'pt-PT'], `${historicalRoute.routeId}:${prompt.text}`)
          .toContain(replacement.language);
        expect(replacement.requestLanguage, `${historicalRoute.routeId}:${prompt.text}`)
          .toBe(replacement.language);
        expect(replacement.text, `${historicalRoute.routeId}:${prompt.text}`).not.toBe(prompt.text);
        expect(replacement.tags, `${historicalRoute.routeId}:${prompt.text}`).toEqual(prompt.tags);
      }
    }

    expect(pairedCount).toBe(94);
    const activeTexts = new Set(
      CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.flatMap((item) =>
        item.prompts.map((prompt) => prompt.text)),
    );
    const retiredTexts = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL
      .flatMap((item) => item.prompts)
      .filter((prompt) =>
        prompt.language === 'es'
        || prompt.language === 'es-419'
        || RETIRED_SPANISH_MIXED_PROMPTS.has(prompt.text))
      .map((prompt) => prompt.text);
    expect(retiredTexts).toHaveLength(94);
    for (const retiredText of retiredTexts) {
      expect(activeTexts.has(retiredText), retiredText).toBe(false);
    }
  });

  it('keeps training semantics and cardinality while replacing retired request text', () => {
    const historical = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL
      .find((item) => item.routeId === 'training_plan_shortcut')!;
    const supported = route('training_plan_shortcut');
    for (let index = 49; index <= 61; index += 1) {
      expect(supported.prompts[index]!.text).not.toBe(historical.prompts[index]!.text);
      expect(['en', 'pt-BR', 'pt-PT']).toContain(supported.prompts[index]!.language);
      expect(supported.prompts[index]!.requestLanguage).toBe(
        supported.prompts[index]!.language,
      );
      expect(supported.prompts[index]!.text).toMatch(
        /training|workout|treino|plano|sess(?:ão|ões)/i,
      );
    }
  });

  it('keeps every Phase 7 retirement route large enough for route-scoped held-out packages', () => {
    for (const routePrompt of CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS) {
      const distinctTexts = new Set(routePrompt.prompts.map((prompt) => prompt.text.trim().replace(/\s+/g, ' ')));

      expect(routePrompt.prompts.length, routePrompt.routeId).toBeGreaterThanOrEqual(50);
      expect(distinctTexts.size, routePrompt.routeId).toBe(routePrompt.prompts.length);
    }
  });

  it('covers required safety edge classes across core launch languages', () => {
    const prompts = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS.flatMap((item) => item.prompts);

    for (const tag of ['ambiguous_cancel', 'duplicate_title', 'write_read_collision']) {
      const languages = new Set(
        prompts
          .filter((prompt) => prompt.tags?.includes(tag))
          .map((prompt) => prompt.language),
      );
      for (const language of ['en', 'pt-BR', 'pt-PT']) {
        expect(languages.has(language as never), `missing ${tag}:${language}`).toBe(true);
      }
    }
  });

  it('uses research prompts that actually require the internet-research route', () => {
    const research = route('selective_internet_research');
    const distinctTexts = new Set(research.prompts.map((prompt) => prompt.text.trim().replace(/\s+/g, ' ')));
    const healthAdjacentCount = research.prompts.filter((prompt) => prompt.tags?.includes('health_adjacent')).length;

    expect(research.prompts.length).toBeGreaterThanOrEqual(50);
    expect(distinctTexts.size).toBe(research.prompts.length);
    expect(healthAdjacentCount).toBeGreaterThan(0);
    expect(healthAdjacentCount).toBeLessThanOrEqual(10);

    for (const [tag, minimum] of Object.entries(research.minSamplesPerSubcase ?? {})) {
      const matching = research.prompts.filter((prompt) =>
        prompt.tags?.some((item) => item === tag)
      );
      expect(matching.length, `missing research subcase coverage:${tag}`).toBeGreaterThanOrEqual(minimum);
    }

    for (const prompt of research.prompts) {
      const contract = inferChatTurnContract({ message: prompt.text });
      expect(contract.routeKind, prompt.text).toBe('internet_research');
      expect(['web', 'local_and_web'], prompt.text).toContain(contract.groundingRequired);
      expect(prompt.text, prompt.text).not.toMatch(/\b(my calendar|my task|my account|minha agenda|minha tarefa|minha conta|meu calendário|meu treino|mi calendario|mi cuenta)\b/i);
    }
  });

  it('uses post-route shortcut prompts instead of explicit slash token-zero commands', () => {
    for (const prompt of route('chat_message_shortcut_after_route').prompts) {
      expect(prompt.text.trim().startsWith('/')).toBe(false);
      expect(parseContentStateShortcut(prompt.text) ?? parseFinanceStateShortcut(prompt.text), prompt.text).toBeTruthy();
    }
  });

  it('keeps independent read route corpora large enough for route-scoped parity packages', () => {
    for (const routeId of ['training_plan_shortcut', 'chat_message_shortcut_after_route']) {
      const routePrompt = route(routeId);
      const distinctTexts = new Set(routePrompt.prompts.map((prompt) => prompt.text.trim().replace(/\s+/g, ' ')));

      expect(routePrompt.runtimeCoupling, routeId).toBe('independent_read_route');
      expect(routePrompt.prompts.length, routeId).toBeGreaterThanOrEqual(50);
      expect(distinctTexts.size, routeId).toBe(routePrompt.prompts.length);
      for (const prompt of routePrompt.prompts) {
        expect(prompt.text.trim().startsWith('/'), `${routeId}:${prompt.text}`).toBe(false);
      }
      for (const [tag, minimum] of Object.entries(routePrompt.minSamplesPerSubcase ?? {})) {
        const matching = routePrompt.prompts.filter((prompt) => prompt.tags?.includes(tag as never));
        expect(matching.length, `missing ${routeId}:${tag}`).toBeGreaterThanOrEqual(minimum);
      }
    }
  });

  it('marks every mutating parity route as a write route and detects write intent', () => {
    for (const routePrompt of CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS) {
      const shouldMutate = CHAT_V2_LEGACY_PARITY_WRITE_ROUTE_IDS.has(routePrompt.routeId);
      for (const prompt of routePrompt.prompts) {
        const probe = detectChatCoreV2WriteIntent(prompt.text);
        if (shouldMutate && !prompt.tags?.includes('negation') && !prompt.tags?.includes('hypothetical')) {
          expect(probe.mayMutate, `${routePrompt.routeId}:${prompt.text}`).toBe(true);
        }
      }
    }
  });

  it('documents the global coupling of write-route replacement', () => {
    for (const routePrompt of CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS) {
      if (!CHAT_V2_LEGACY_PARITY_WRITE_ROUTE_IDS.has(routePrompt.routeId)) continue;
      expect(routePrompt.evidenceTrack, routePrompt.routeId).toBe('write_firewall_bundle');
      expect(routePrompt.runtimeCoupling, routePrompt.routeId).toBe('global_write_firewall');
      expect(routePrompt.stateContract, routePrompt.routeId).toBe('fresh_isolated_user_per_prompt');
      expect(routePrompt.prompts.length, routePrompt.routeId).toBeGreaterThanOrEqual(50);
    }
  });

  it('uses decision-specific prompts for the Decision Center parity route', () => {
    for (const prompt of route('decision_confirmation_shortcut').prompts) {
      expect(prompt.text, prompt.text).toMatch(/\b(decision|decis(?:ao|ão)|decisi[oó]n)\b/i);
      expect(prompt.text, prompt.text).not.toMatch(/\b(training plan|plano de treino|calendar|agenda)\b/i);
    }
  });

  it('preserves decision action semantics and entity ids in every compatibility request', () => {
    const historical = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL
      .find((item) => item.routeId === 'decision_confirmation_shortcut')!;
    const supported = route('decision_confirmation_shortcut');
    const expected = new Map<number, string>([
      [2, 'dec_123'],
      [31, 'dec_123'],
      [32, 'dec_123'],
      [33, 'dec_launch_review'],
      [34, 'dec_launch_review'],
      [35, 'dec_launch_review'],
      [36, 'dec_budget_hold'],
      [37, 'dec_route_gate'],
      [38, 'dec_route_gate'],
      [39, 'dec_route_gate'],
      [40, 'dec_budget_hold'],
      [45, 'dec_route_gate'],
      [48, 'dec_security_review'],
    ]);

    const retiredIndexes = historical.prompts
      .map((prompt, index) => ({ prompt, index }))
      .filter(({ prompt }) =>
        prompt.language === 'es'
        || prompt.language === 'es-419'
        || RETIRED_SPANISH_MIXED_PROMPTS.has(prompt.text)
      )
      .map(({ index }) => index);
    expect(retiredIndexes).toEqual([...expected.keys()]);

    for (const [index, decisionId] of expected) {
      const replacement = supported.prompts[index]!;
      expect(['en', 'pt-BR', 'pt-PT'], historical.prompts[index]!.text)
        .toContain(replacement.language);
      expect(replacement.requestLanguage, historical.prompts[index]!.text)
        .toBe(replacement.language);
      expect(replacement.text, historical.prompts[index]!.text).not.toBe(
        historical.prompts[index]!.text,
      );
      expect(replacement.text, historical.prompts[index]!.text).toContain(decisionId);
      expect(replacement.tags, historical.prompts[index]!.text).toEqual(
        historical.prompts[index]!.tags,
      );
    }
  });

  it('preserves cancel-vs-delete and single-vs-whole-list hypothetical semantics', () => {
    const historical = CHAT_V2_LEGACY_PARITY_ROUTE_PROMPTS_V1_HISTORICAL
      .find((item) => item.routeId === 'destructive_confirmation_hold')!;
    const supported = route('destructive_confirmation_hold');

    expect(supported.prompts[10]!.text).not.toBe(historical.prompts[10]!.text);
    expect(supported.prompts[10]!.text).toMatch(/cancel|cancelar/i);
    expect(supported.prompts[10]!.text).toMatch(/without deleting|sem apagar/i);
    expect(supported.prompts[48]!.text).not.toBe(historical.prompts[48]!.text);
    expect(supported.prompts[48]!.text).toMatch(/one task|uma tarefa/i);
    expect(supported.prompts[48]!.text).toMatch(/whole list|lista inteira/i);
  });

  it('defines classifier-route readiness owners, language recall floors, and unresolved clarifier coverage', () => {
    const readiness = CHAT_V2_PHASE7_TARGET_ROUTE_READINESS.classifier_route_skill_orchestration;
    const classifier = route('classifier_route_skill_orchestration');
    const promptTexts = new Set(classifier.prompts.map((prompt) => prompt.text));

    expect(readiness.answerQualityReviewRequired).toBe(true);
    expect(Object.keys(readiness.recallAt8LanguageThresholds).sort()).toEqual([
      'en',
      'mixed',
      'pt-BR',
      'pt-PT',
    ]);
    for (const [language, threshold] of Object.entries(readiness.recallAt8LanguageThresholds)) {
      expect(threshold, language).toBeGreaterThanOrEqual(language === 'mixed' ? 0.9 : 0.95);
    }

    for (const ownership of readiness.promptOwnership) {
      expect(promptTexts.has(ownership.promptText), ownership.promptText).toBe(true);
    }

    expect(readiness.promptOwnership.some((entry) => entry.owner === 'deterministic_read')).toBe(true);
    expect(readiness.promptOwnership.some((entry) => entry.owner === 'local_chat_classifier')).toBe(true);
    expect(readiness.requiredMissingCoverage).toContain('owner_boundary_review');
    expect(classifier.prompts.some((prompt) => prompt.tags?.includes('low_confidence_clarification'))).toBe(true);
    expect(classifier.prompts.some((prompt) => prompt.tags?.includes('write_read_collision'))).toBe(true);
    expect(readiness.blockers.join(' ')).toMatch(/recall@8/i);
    expect(readiness.blockers.join(' ')).toMatch(/no reviewed labels/i);
    expect(readiness.blockers.join(' ')).not.toMatch(/\bes(?:-419)?\b/i);
  });

  it('defines domain-handler adapter order and per-domain signed parity floors', () => {
    const readiness = CHAT_V2_PHASE7_TARGET_ROUTE_READINESS.domain_handler_execution;

    expect(readiness.answerQualityReviewRequired).toBe(true);
    expect(readiness.replacementOrder).toEqual(['cooking', 'content', 'training', 'finance', 'secretary']);

    for (const domain of readiness.replacementOrder) {
      const floor = readiness.perDomainParityFloors[domain];
      expect(floor.replacement, domain).toMatch(/ChatV2/);
      expect(floor.minSamples, domain).toBeGreaterThanOrEqual(50);
      expect(floor.minParity, domain).toBeGreaterThanOrEqual(0.95);
      expect(floor.answerQualityReviewRequired, domain).toBe(true);
    }

    const domainHandler = route('domain_handler_execution');
    for (const tag of ['domain_cooking', 'domain_content', 'domain_training', 'domain_finance', 'domain_secretary']) {
      expect(domainHandler.prompts.some((prompt) => prompt.tags?.includes(tag as never)), tag).toBe(true);
    }
    expect(readiness.blockers.join(' ')).toMatch(/signed >=50-row parity package/);
  });

  it('keeps cooking domain-handler prompts generic while per-domain signed evidence is still missing', () => {
    const domainHandler = route('domain_handler_execution');
    const cookingDishNames = /\b(chicken|frango|salmon|salm[aã]o|pasta|massa|pizza|taco|burger|hamb[uú]rguer|risotto|risoto|omelet|omelete|soup|sopa|stew|ensopado|curry|lasagna|lasanha|bowl)\b/i;

    expect(CHAT_V2_PHASE7_TARGET_ROUTE_READINESS.domain_handler_execution.cookingGenericityRule).toMatch(/generic/i);
    for (const prompt of domainHandler.prompts.filter((item) => item.tags?.includes('domain_cooking'))) {
      expect(prompt.text, prompt.text).not.toMatch(cookingDishNames);
    }
  });
});
