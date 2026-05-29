// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase K — chat-response-quality-gate behavioral tests.
 *
 * The Phase K plan listed this test file but it was never created until
 * this backfill. Covers the CREATIVE_TEXT_OWNERS + SIDE_EFFECT_SUCCESS_VERBS
 * behavior so regressions show up before they hit production.
 *
 * The original Phase K-triggering bug was at the FIRST-TIER
 * (actionability='execute') path: cooking responses arrive as
 * actionability='execute' (intent='cooking.create'), the model writes
 * "Criei uma receita..." which matches SUCCESS_CLAIM_PATTERNS, and the
 * gate replaced the recipe with a canned "I cannot honestly mark it
 * done" template.
 *
 * Phase K (Codex round-9 fix F4) added `isCreativeTextOwnerExecuteSkip`
 * to suppress that first-tier check for cooking + content when no
 * side-effect verb is present. Phase K (Codex round-9 fix F3) added
 * SIDE_EFFECT_SUCCESS_VERBS to `claimsSuccess` so side-effect verbs
 * (publiquei/postei/agendei/enviei/programei/etc.) STILL trip the gate
 * even on creative-text owners.
 *
 * The second-tier (answer_only) path also has the same skip predicate
 * for parity (Phase K original design), but its triggering condition
 * additionally requires `hasConcreteStateSpecifics` — i.e., the text
 * must include a time/date/money reference. Tests for that path use
 * texts that include a concrete time anchor.
 */

import { describe, it, expect } from 'vitest';
import {
  applyChatResponseQualityGate,
  detectChatResponseQualityIssues,
} from '../../src/services/chat-response-quality-gate';
import type { NexusAnswerContract } from '../../src/services/chat-answer-contract';

// ─── Test scaffolding ─────────────────────────────────────────────

function makeContract(overrides: Partial<NexusAnswerContract> = {}): NexusAnswerContract {
  return {
    version: 'nexus_answer_contract.v1',
    intent: 'test_intent',
    ownerSkill: 'cooking',
    routeKind: 'generic_skill_answer',
    groundingRequirement: 'none',
    expectedResponseShape: 'direct_answer',
    language: 'pt',
    ambiguityReasons: [],
    routeMethod: 'test',
    confidence: 0.9,
    groundingFacts: [],
    missingFacts: [],
    staleness: 'fresh',
    riskLevel: 'low',
    actionability: 'execute',  // First-tier-firing default; override per test
    verificationStatus: 'pending',
    fallbackUsed: false,
    fallback: {
      fallbackType: 'none',
      retryable: false,
      sourceFreshness: 'fresh',
      userActionRequired: false,
      operatorActionRequired: false,
    },
    userFacingSummary: 'Test answer.',
    nextBestActions: [],
    traceId: 'test-trace-id',
    latency: {
      tier: 'tier3_model_assisted',
      durationMs: 100,
      stageTimingsMs: {},
    },
    ...overrides,
  };
}

// ─── First-tier (execute) CREATIVE_TEXT_OWNERS skip ───────────────

describe('CREATIVE_TEXT_OWNERS exemption — first-tier (execute path)', () => {
  it('cooking + execute + "Criei uma receita..." is NOT flagged (the Phase K-triggering case)', () => {
    // This is the EXACT case that prompted Phase K. Cooking intent
    // arrives as actionability='execute', model self-narrates with
    // "Criei...", and the canned-text replacement made the recipe
    // unusable. Phase K Codex round-9 F4 fix added the
    // isCreativeTextOwnerExecuteSkip predicate.
    const text = 'Criei uma receita de kibe de forno para duas pessoas. Ingredientes: 500g de carne moída, 100g de trigo para kibe, 1 cebola picada, 1 dente de alho. Modo de preparo: misture todos os ingredientes em uma tigela...';
    const contract = makeContract({
      ownerSkill: 'cooking',
      actionability: 'execute',
      intent: 'cooking.create',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.status).toBe('pass');
    expect(result.issues).not.toContain('unverified_success_claim');
    expect(result.text).toBe(text);
    expect(result.qualityGateSkipped).toBe(true);
    expect(result.qualityGateReason).toContain('cooking');
  });

  it('content + execute + "Criei 3 ideias de reel..." is NOT flagged', () => {
    const text = 'Criei 3 ideias de reel sobre hábitos matinais para você gravar esta semana. Ideia 1: rotina das 5 da manhã com timestamps...';
    const contract = makeContract({
      ownerSkill: 'content',
      actionability: 'execute',
      intent: 'content.create',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.status).toBe('pass');
    expect(result.issues).not.toContain('unverified_success_claim');
    expect(result.qualityGateSkipped).toBe(true);
    expect(result.qualityGateReason).toContain('content');
  });

  it('cooking + execute + English "I created..." is NOT flagged', () => {
    const text = "I created a chicken stir-fry recipe for two. Ingredients: 500g chicken breast diced, 2 bell peppers, 1 onion, soy sauce. Steps: heat the wok over high heat...";
    const contract = makeContract({
      ownerSkill: 'cooking',
      actionability: 'execute',
      intent: 'cooking.create',
      language: 'en',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.status).toBe('pass');
    expect(result.issues).not.toContain('unverified_success_claim');
    expect(result.qualityGateSkipped).toBe(true);
  });
});

// ─── SIDE_EFFECT_SUCCESS_VERBS override creative skip ─────────────

describe('SIDE_EFFECT_SUCCESS_VERBS override CREATIVE_TEXT_OWNERS exemption', () => {
  it('content + execute + "Publiquei o reel" IS flagged (publish is a side-effect verb)', () => {
    // Even though content is in CREATIVE_TEXT_OWNERS, side-effect verbs
    // assert external actions the model did NOT actually take. Phase K
    // Codex round-9 F3 added these to claimsSuccess so they trip the
    // gate. Cooking/content's creative exemption explicitly does NOT
    // apply when a side-effect verb appears.
    const text = 'Publiquei o reel no Instagram hoje.';
    const contract = makeContract({
      ownerSkill: 'content',
      actionability: 'execute',
      intent: 'content.publish',
    });

    const issues = detectChatResponseQualityIssues(text, contract);
    expect(issues).toContain('unverified_success_claim');
  });

  it('content + execute + "Agendei os posts para amanhã às 14h" IS flagged (schedule is a side-effect)', () => {
    const text = 'Agendei os posts para amanhã às 14h no Buffer.';
    const contract = makeContract({
      ownerSkill: 'content',
      actionability: 'execute',
      intent: 'content.schedule',
    });

    const issues = detectChatResponseQualityIssues(text, contract);
    expect(issues).toContain('unverified_success_claim');
  });

  it('content + execute + English "I published the reel" IS flagged', () => {
    const text = 'I published the reel on Instagram at 2pm today.';
    const contract = makeContract({
      ownerSkill: 'content',
      actionability: 'execute',
      intent: 'content.publish',
      language: 'en',
    });

    const issues = detectChatResponseQualityIssues(text, contract);
    expect(issues).toContain('unverified_success_claim');
  });
});

// ─── Domains that STAY STRICT (no creative exemption) ─────────────

describe('Strict domains — training, finance, secretary (no exemption)', () => {
  it('training + execute + "Programei seu bloco Z2 para amanhã" IS flagged', () => {
    // Phase K amendment A3: training is INTENTIONALLY excluded from
    // CREATIVE_TEXT_OWNERS. "Programei seu bloco Z2 para amanhã às 7h"
    // is a scheduling/execution claim — the strict gate must catch it.
    const text = 'Programei seu bloco Z2 para amanhã às 7h da manhã.';
    const contract = makeContract({
      ownerSkill: 'training',
      actionability: 'execute',
      intent: 'training.schedule',
    });

    const issues = detectChatResponseQualityIssues(text, contract);
    expect(issues).toContain('unverified_success_claim');
  });

  it('finance + execute + "Marquei R$ 1.235,00 como pago em janeiro" IS flagged', () => {
    // Phase K amendment A5: finance is INTENTIONALLY excluded. Past-
    // tense payment-marking asserts backend state.
    const text = 'Marquei R$ 1.235,00 como pago em janeiro de 2026.';
    const contract = makeContract({
      ownerSkill: 'finance',
      actionability: 'execute',
      intent: 'finance.mark_paid',
    });

    const issues = detectChatResponseQualityIssues(text, contract);
    expect(issues).toContain('unverified_success_claim');
  });

  it('secretary + execute + "I scheduled your meeting at 3pm" IS flagged', () => {
    const text = "I scheduled your meeting with Sarah at 3pm today.";
    const contract = makeContract({
      ownerSkill: 'secretary',
      actionability: 'execute',
      intent: 'secretary.schedule',
      verificationStatus: 'pending',
      language: 'en',
    });

    const issues = detectChatResponseQualityIssues(text, contract);
    expect(issues).toContain('unverified_success_claim');
  });
});

// ─── Second-tier (answer_only) parity for CREATIVE_TEXT_OWNERS ────

describe('CREATIVE_TEXT_OWNERS exemption — second-tier (answer_only path with concrete state)', () => {
  // The second-tier check additionally requires hasConcreteStateSpecifics
  // (time/date/money) AND the response isn't a local_read AND isn't
  // grounded. When those preconditions are met, the creative-text skip
  // mirrors the first-tier behavior.

  it('cooking + answer_only + "Criei uma receita para amanhã às 14h" is NOT flagged', () => {
    const text = 'Criei uma receita de kibe para amanhã às 14h. Ingredientes: 500g de carne, 100g de trigo. Modo de preparo: misture todos os ingredientes...';
    const contract = makeContract({
      ownerSkill: 'cooking',
      actionability: 'answer_only',
    });

    const result = applyChatResponseQualityGate({ text, contract });
    expect(result.issues).not.toContain('unverified_success_claim');
    expect(result.qualityGateSkipped).toBe(true);
  });
});

// ─── qualityGateReason metadata propagation ───────────────────────

describe('qualityGateReason metadata', () => {
  it('passes with no flagging → reason is "pass"', () => {
    // Plain neutral cooking text without past-tense self-narration.
    const text = 'Aqui está uma receita simples de pão de queijo. Você vai precisar de polvilho doce, leite, e ovo. Misture os ingredientes secos primeiro.';
    const contract = makeContract({
      ownerSkill: 'cooking',
      actionability: 'answer_only',
    });

    const result = applyChatResponseQualityGate({ text, contract });
    expect(result.status).toBe('pass');
    expect(result.qualityGateSkipped).toBe(false);
    expect(result.qualityGateReason).toBe('pass');
  });

  it('CREATIVE_TEXT_OWNERS execute skip → reason includes ":execute" marker', () => {
    const text = 'Criei uma receita de moqueca de peixe para quatro pessoas. Vamos precisar de 1 kg de peixe branco, 2 cebolas, 3 tomates, leite de coco. Comece refogando a cebola...';
    const contract = makeContract({
      ownerSkill: 'cooking',
      actionability: 'execute',
      intent: 'cooking.create',
    });

    const result = applyChatResponseQualityGate({ text, contract });
    expect(result.status).toBe('pass');
    expect(result.qualityGateSkipped).toBe(true);
    expect(result.qualityGateReason).toBe('creative_text_owner:cooking:execute');
  });

  it('does not turn generic productivity fallback text into fake recipe sections', () => {
    const text = 'Divide isso numa próxima ação pequena, faz um bloco curto de foco e revê o resultado antes de continuar.';
    const contract = makeContract({
      ownerSkill: 'cooking',
      actionability: 'answer_only',
      expectedResponseShape: 'recipe',
      language: 'pt',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.status).toBe('blocked');
    expect(result.qualityGateReason).toBe('blocked:recipe_seed_unusable');
    expect(result.text).toContain('Não consegui gerar uma receita confiável');
    expect(result.text).not.toContain('**Ingredientes:**');
    expect(result.text).not.toContain('- Divide isso');
    expect(result.contract.missingFacts).toContain('usable_recipe_content');
  });

  it('does not wrap degraded recipe generation text into fake recipe sections', () => {
    const text = 'Não consegui gerar uma receita completa com segurança agora. Tenta novamente com o prato, porções e preferências principais.';
    const contract = makeContract({
      ownerSkill: 'cooking',
      actionability: 'answer_only',
      expectedResponseShape: 'recipe',
      language: 'pt',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.status).toBe('blocked');
    expect(result.qualityGateReason).toBe('blocked:recipe_seed_unusable');
    expect(result.text).toContain('Não consegui gerar uma receita confiável');
    expect(result.text).not.toContain('**Ingredientes:**');
    expect(result.text).not.toContain('**Modo de preparo:**');
    expect(result.text).not.toContain('Observação: preservei');
    expect(result.contract.missingFacts).toContain('usable_recipe_content');
  });
});
