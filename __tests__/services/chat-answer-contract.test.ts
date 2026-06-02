import { describe, expect, it } from 'vitest';

import { buildNexusAnswerContract, createChatLatencyTracker } from '../../src/services/chat-answer-contract';
import { applyChatFallbackPolicy, resolveChatFallbackPolicy } from '../../src/services/chat-fallback-policy';
import { buildChatGroundingEnvelope } from '../../src/services/chat-grounding-layer';
import { applyChatResponseQualityGate } from '../../src/services/chat-response-quality-gate';
import { getChatSkillCapability, getChatSkillCapabilityRegistry, resolveChatSkillCapability } from '../../src/services/chat-skill-capability-registry';

describe('nexus chat answer contract', () => {
  it('declares broad cross-skill capabilities with verifiers and latency budgets', () => {
    const registry = getChatSkillCapabilityRegistry();
    expect(registry.map((entry) => entry.skill)).toEqual(expect.arrayContaining([
      'secretary',
      'tasks',
      'training',
      'cooking',
      'finance',
      'content',
      'decision_center',
      'connections',
      'notifications',
      'owner_admin',
    ]));

    for (const capability of registry) {
      expect(capability.latencyBudgetMs).toBeGreaterThan(0);
      expect(capability.responseCardType).toBeTruthy();
      if (capability.executableActions.length > 0 && capability.skill !== 'owner_admin') {
        expect(capability.verifier).not.toBe('none');
      }
    }
    expect(getChatSkillCapability('finance').privacyPolicy).toBe('sensitive_redacted');
  });

  it('resolves skill ownership and missing facts for Portuguese calendar writes', () => {
    const grounding = buildChatGroundingEnvelope({
      message: 'Colocar no calendario evento no próximo sábado das 9h às 13h. Volei Lucas.',
      userId: 7,
      tenantId: 7,
      routedDomain: 'secretary',
    });

    expect(grounding.capability.ownerSkill).toBe('secretary');
    expect(grounding.capability.actionability).toBe('execute');
    expect(grounding.missingFacts).toEqual([]);
    expect(grounding.groundingFacts.map((fact) => fact.source)).toEqual(expect.arrayContaining([
      'auth.scope',
      'chat.skill_capability_registry',
    ]));
  });

  it('marks weak grounding as clarification instead of confident state claims', () => {
    const grounding = buildChatGroundingEnvelope({
      message: 'move it',
      userId: 7,
      tenantId: 7,
      routedDomain: 'secretary',
    });

    expect(grounding.missingFacts).toEqual(expect.arrayContaining(['date', 'time', 'title']));
    const contract = buildNexusAnswerContract({
      intent: grounding.capability.intent,
      ownerSkill: grounding.capability.ownerSkill,
      routeMethod: 'context',
      confidence: 0.4,
      groundingFacts: grounding.groundingFacts,
      missingFacts: grounding.missingFacts,
      actionability: 'clarify',
      verificationStatus: 'pending',
    });
    expect(contract.missingFacts).toContain('title');
    expect(contract.actionability).toBe('clarify');
  });

  it('quality gate repairs unverified success claims and blocks hallucinated completion', () => {
    const contract = buildNexusAnswerContract({
      intent: 'secretary.create',
      ownerSkill: 'secretary',
      routeMethod: 'model',
      actionability: 'execute',
      verificationStatus: 'not_required',
      groundingFacts: [],
      missingFacts: [],
      confidence: 0.8,
    });

    const result = applyChatResponseQualityGate({
      text: 'Pronto ✅ Agendei no Google/Outlook.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.issues).toContain('unverified_success_claim');
    expect(result.contract.verificationStatus).toBe('pending');
    expect(result.contract.missingFacts).toContain('read_back_verification');
    expect(result.text).not.toMatch(/Agendei|✅/);
  });

  it('quality gate catches unverified destructive success claims without relying on Pronto/Done prefixes', () => {
    const contract = buildNexusAnswerContract({
      intent: 'secretary.delete',
      ownerSkill: 'secretary',
      routeMethod: 'model',
      actionability: 'execute',
      verificationStatus: 'pending',
      groundingFacts: [],
      missingFacts: [],
      confidence: 0.8,
      language: 'pt',
    });

    for (const text of [
      'Apaguei todas as tarefas antigas.',
      'Removi todos os eventos.',
      'Cancelei a reunião.',
      'Deleted all matching tasks.',
    ]) {
      const result = applyChatResponseQualityGate({ text, contract });
      expect(result.status, text).toBe('repaired');
      expect(result.issues, text).toContain('unverified_success_claim');
      expect(result.text, text).not.toContain(text);
    }
  });

  it('quality gate catches first-person model action claims even when the route mislabeled the answer as answer-only', () => {
    const contract = buildNexusAnswerContract({
      intent: 'cooking.answer',
      ownerSkill: 'cooking',
      routeMethod: 'model',
      routeKind: 'generic_skill_answer',
      groundingRequirement: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'pt',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: [{
        statement: 'Cooking owns generic cooking help.',
        source: 'chat.skill_capability_registry',
        freshness: 'fresh',
        confidence: 0.9,
        safeForUser: true,
      }],
    });

    const result = applyChatResponseQualityGate({
      text: 'Guardei a receita na tua lista.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.issues).toContain('unverified_success_claim');
    expect(result.contract.verificationStatus).toBe('pending');
    expect(result.text).not.toContain('Guardei');
  });

  it('quality gate does not rewrite negated or confirmation-pending action text', () => {
    const contract = buildNexusAnswerContract({
      intent: 'secretary.clarify',
      ownerSkill: 'secretary',
      routeMethod: 'model',
      routeKind: 'clarification',
      groundingRequirement: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'pt',
      actionability: 'clarify',
      verificationStatus: 'pending',
      groundingFacts: [{
        statement: 'Secretary is asking for confirmation.',
        source: 'chat.action_gateway',
        freshness: 'fresh',
        confidence: 0.9,
        safeForUser: true,
      }],
    });

    for (const text of [
      'A tarefa ainda não foi concluída. Quer que eu prepare uma prévia?',
      'O evento não foi cancelado. Confirmas que queres apagar?',
      'Não cancelei o evento. Posso preparar uma prévia.',
    ]) {
      const result = applyChatResponseQualityGate({ text, contract });
      expect(result.status, text).toBe('pass');
      expect(result.issues, text).not.toContain('unverified_success_claim');
      expect(result.text, text).toBe(text);
    }
  });

  it('quality gate repairs Spanish unverified success claims in Spanish', () => {
    const contract = buildNexusAnswerContract({
      intent: 'cooking.answer',
      ownerSkill: 'cooking',
      routeMethod: 'model',
      routeKind: 'generic_skill_answer',
      groundingRequirement: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'es',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: [{
        statement: 'Cooking owns generic cooking help.',
        source: 'chat.skill_capability_registry',
        freshness: 'fresh',
        confidence: 0.9,
        safeForUser: true,
      }],
    });

    const result = applyChatResponseQualityGate({
      text: 'Guardé la receta en tu lista.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.issues).toContain('unverified_success_claim');
    expect(result.text).toContain('Entendí la petición');
    expect(result.text).toContain('No ejecuté');
    expect(result.text).not.toContain('I understood');
  });

  it('quality gate allows Spanish negated pending-action text', () => {
    const contract = buildNexusAnswerContract({
      intent: 'secretary.clarify',
      ownerSkill: 'secretary',
      routeMethod: 'model',
      routeKind: 'clarification',
      groundingRequirement: 'none',
      expectedResponseShape: 'direct_answer',
      language: 'es',
      actionability: 'clarify',
      verificationStatus: 'pending',
      groundingFacts: [{
        statement: 'Secretary is asking for confirmation.',
        source: 'chat.action_gateway',
        freshness: 'fresh',
        confidence: 0.9,
        safeForUser: true,
      }],
    });

    const text = 'El evento no fue cancelado todavía. Antes de cualquier cambio, dime si quieres que lo cancele.';
    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.status).toBe('pass');
    expect(result.issues).not.toContain('unverified_success_claim');
    expect(result.text).toBe(text);
  });

  it('quality gate strips raw backend/debug details from user-facing text', () => {
    const resolved = resolveChatSkillCapability({
      message: 'explain my training',
      routedDomain: 'triathlon',
    });
    const contract = buildNexusAnswerContract({
      intent: resolved.intent,
      ownerSkill: resolved.ownerSkill,
      routeMethod: 'context',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: [{
        statement: 'Training owns this response.',
        source: 'test',
        freshness: 'fresh',
        confidence: 1,
        safeForUser: true,
      }],
    });

    const result = applyChatResponseQualityGate({
      text: 'session_prescription · mp3 says calendar_busy_blocks.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.text).not.toMatch(/session_prescription|calendar_busy_blocks|mp3/);
  });

  it('quality gate converts unsupported concrete state details into clarification', () => {
    const contract = buildNexusAnswerContract({
      intent: 'secretary.answer',
      ownerSkill: 'secretary',
      routeMethod: 'model',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: [{
        statement: 'Secretary owns this response.',
        source: 'chat.skill_capability_registry',
        freshness: 'fresh',
        confidence: 0.9,
        safeForUser: true,
      }],
    });

    const result = applyChatResponseQualityGate({
      text: 'You have a calendar event on 15/05/2026 at 09:30.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.issues).toContain('unsupported_specific_state_claim');
    expect(result.contract.actionability).toBe('clarify');
    expect(result.contract.missingFacts).toContain('scoped_state_read');
    expect(result.text).toContain('current scoped read');
  });

  it('quality gate allows generic Cooking recipes with concrete quantities and times without scoped read', () => {
    const contract = buildNexusAnswerContract({
      intent: 'cooking.answer',
      ownerSkill: 'cooking',
      routeMethod: 'keyword',
      routeKind: 'generic_skill_answer',
      groundingRequirement: 'none',
      expectedResponseShape: 'recipe',
      language: 'pt',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: [{
        statement: 'Cooking owns generic recipe advice.',
        source: 'chat.skill_capability_registry',
        freshness: 'fresh',
        confidence: 0.9,
        safeForUser: true,
      }],
    });

    const result = applyChatResponseQualityGate({
      text: [
        '**Kibe de forno para 3 pessoas**',
        '',
        '**Ingredientes:** batata, cenoura, abobrinha, cebola, azeite, sal e ervas.',
        '',
        '**Modo de preparo:**',
        '1. Hidrate o trigo por 20 minutos e escorra bem.',
        '2. Misture com a carne, cebola e temperos.',
        '3. Asse a 180°C por 35 a 40 minutos.',
        '',
        'Rende 3 porções.',
      ].join('\n'),
      contract,
    });

    expect(result.status).toBe('pass');
    expect(result.issues).toEqual([]);
    expect(result.text).toContain('Kibe de forno');
    expect(result.text).not.toContain('scoped read');
  });

  it('quality gate does not treat recipe wording like cook until done as an app success claim', () => {
    const contract = buildNexusAnswerContract({
      intent: 'cooking.answer',
      ownerSkill: 'cooking',
      routeMethod: 'keyword',
      routeKind: 'generic_skill_answer',
      groundingRequirement: 'none',
      expectedResponseShape: 'recipe',
      language: 'en',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: [{
        statement: 'Cooking owns generic recipe advice.',
        source: 'chat.skill_capability_registry',
        freshness: 'fresh',
        confidence: 0.9,
        safeForUser: true,
      }],
    });

    const result = applyChatResponseQualityGate({
      text: [
        '**Quick soup**',
        '',
        '**Serves:** 2',
        '',
        '**Ingredients:**',
        '- 2 cups broth',
        '- 1 cup vegetables',
        '',
        '**Method:**',
        '1. Simmer the vegetables until done.',
        '2. Serve warm.',
      ].join('\n'),
      contract,
    });

    expect(result.status).toBe('pass');
    expect(result.issues).toEqual([]);
    expect(result.text).toContain('until done');
  });

  it('quality gate repairs recipe answers into user-visible recipe structure', () => {
    const contract = buildNexusAnswerContract({
      intent: 'cooking.answer',
      ownerSkill: 'cooking',
      routeMethod: 'keyword',
      routeKind: 'generic_skill_answer',
      groundingRequirement: 'none',
      expectedResponseShape: 'recipe',
      language: 'pt',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: [{
        statement: 'Cooking owns generic recipe advice.',
        source: 'chat.skill_capability_registry',
        freshness: 'fresh',
        confidence: 0.9,
        safeForUser: true,
      }],
    });

    const result = applyChatResponseQualityGate({
      text: 'Kibe de forno é uma boa opção para jantar. Tempere bem e asse até ficar dourado.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.issues).toContain('recipe_missing_structure');
    expect(result.contract.actionability).toBe('answer_only');
    expect(result.contract.missingFacts).not.toContain('recipe_structure');
    expect(result.text).toContain('Rende:');
    expect(result.text).toContain('Ingredientes');
    expect(result.text).toContain('Modo de preparo');
    expect(result.text).toContain('Kibe de forno é uma boa opção para jantar');
    expect(result.text).toContain('Tempere bem e asse até ficar dourado');
    expect(result.text).toContain('preservei os detalhes da resposta original');
    expect(result.text).not.toMatch(/Reescreva|Rewrite it/);
    expect(result.text).not.toContain('dados atuais do Nexus');
  });

  it('metadata-backed context sources count as scoped grounding', () => {
    const grounding = buildChatGroundingEnvelope({
      message: 'what tax is due next?',
      userId: 7,
      tenantId: 7,
      routedDomain: 'finance',
      contextSources: [{
        source: 'metadata.finance_tax_snapshot',
        freshness: 'fresh',
        confidence: 0.85,
        reason: 'Backend returned scoped finance tax snapshot metadata.',
      }],
    });
    const contract = buildNexusAnswerContract({
      intent: grounding.capability.intent,
      ownerSkill: grounding.capability.ownerSkill,
      routeMethod: 'finance-state-shortcut',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      groundingFacts: grounding.groundingFacts,
    });

    const result = applyChatResponseQualityGate({
      text: 'The next tax snapshot is for 2026-03.',
      contract,
    });

    expect(result.status).toBe('pass');
    expect(result.issues).toEqual([]);
  });

  it('records route latency budgets and budget overrun metadata', () => {
    const tracker = createChatLatencyTracker(Date.now() - 900);
    tracker.mark('routed');
    const snapshot = tracker.snapshot('tier1_fast_read', 800);

    expect(snapshot.budgetMs).toBe(800);
    expect(snapshot.budgetExceeded).toBe(true);
    expect(snapshot.stageTimingsMs.routed).toBeGreaterThanOrEqual(800);
  });

  it('fallback policy allows stale read-only answers only with freshness labels', () => {
    const contract = buildNexusAnswerContract({
      intent: 'finance.read',
      ownerSkill: 'finance',
      routeMethod: 'cached',
      actionability: 'answer_only',
      verificationStatus: 'not_required',
      staleness: 'stale',
      fallback: {
        fallbackType: 'cached_read',
        fallbackReason: 'provider_unavailable',
        retryable: true,
        sourceFreshness: 'stale',
      },
    });

    const policy = resolveChatFallbackPolicy(contract);
    expect(policy.operationKind).toBe('read_only_answer');
    expect(policy.fallbackAllowed).toBe(true);
    expect(policy.mayUseCachedData).toBe(true);
    expect(policy.requiresFreshnessLabel).toBe(true);
    expect(policy.mayClaimSuccess).toBe(false);
  });

  it('fallback policy blocks mutating fallback success without verifier', () => {
    const contract = buildNexusAnswerContract({
      intent: 'secretary.create',
      ownerSkill: 'secretary',
      routeMethod: 'model',
      actionability: 'execute',
      verificationStatus: 'pending',
      fallback: {
        fallbackType: 'provider_fallback',
        fallbackReason: 'primary_timeout',
        retryable: true,
      },
    });

    const result = applyChatFallbackPolicy(contract);
    expect(result.issues).toContain('fallback_not_allowed_for_operation');
    expect(result.issues).toContain('success_requires_verifier');
    expect(result.policy.responseMode).toBe('blocked');
    expect(result.contract.actionability).toBe('blocked');
    expect(result.contract.verificationStatus).toBe('blocked');
    expect(result.contract.missingFacts).toContain('verified_mutation_result');
  });
});
