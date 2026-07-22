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

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import type Database from 'better-sqlite3';

let testDb: Database.Database | null = null;

// M8 gate redesign: token-zero verification reads go through the unified
// task store, so the shared migrated :memory: DB pattern applies. Tests
// that never pass a `verification` scope never touch the DB.
vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual('../../src/services/database')),
  getDb: () => {
    if (!testDb) throw new Error('testDb not initialized');
    return testDb;
  },
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  applyChatResponseQualityGate,
  detectChatResponseQualityIssues,
} from '../../src/services/chat-response-quality-gate';
import { upsertTask } from '../../src/services/task-store/unified-task-store';
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
});

// ─── M8 gate on-trip redesign ─────────────────────────────────────
//
// (a) token-zero verification first: an 'unverified_success_claim' about
//     an identifiable entity is checked against SQLite before any rewrite;
//     confirmed claims KEEP the original text with verificationStatus
//     'verified'. Id-or-exact-title match only — ambiguity falls through.
// (b) surgical downgrade: only the offending sentence(s) are removed.
// (c) full canned repair only when the entire answer is claim material.
// (d) every trip records { originalText, issues, action } on the result so
//     the finalizer can persist it under metadata.qualityGate.

const USER_ID = 42;
const TENANT_ID = 42;

function seedUser(): void {
  testDb!.prepare(`
    INSERT INTO users (
      id, telegram_id, first_name, language, timezone, tier, status,
      auth_provider, daily_message_limit, daily_token_limit, daily_cost_limit_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(USER_ID, USER_ID, 'Test', 'en', 'Europe/Lisbon', 'pro', 'active', 'telegram', 40, 100000, 1);
}

function seedTask(title: string, status: 'pending' | 'completed' = 'pending', externalId = `ext-${title}`): void {
  upsertTask(USER_ID, {
    provider: 'nexus',
    externalId,
    title,
    status,
    priority: 0,
  }, TENANT_ID);
}

describe('M8 — token-zero verification keeps true claims', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    seedUser();
  });

  afterEach(() => {
    testDb?.close();
    testDb = null;
  });

  it('keeps the original text when the created task exists with an exact title match', () => {
    seedTask('Email Maria');
    const text = 'I created the task "Email Maria" for you.';
    const contract = makeContract({
      ownerSkill: 'tasks',
      actionability: 'execute',
      intent: 'tasks.create',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({
      text,
      contract,
      verification: { userId: USER_ID, tenantId: TENANT_ID },
    });

    expect(result.status).toBe('pass');
    expect(result.text).toBe(text);
    expect(result.action).toBe('verified_kept');
    expect(result.contract.verificationStatus).toBe('verified');
    expect(result.issues).toEqual([]);
    expect(result.tripIssues).toContain('unverified_success_claim');
    expect(result.originalText).toBe(text);
  });

  it('keeps a completion claim only when the matched task is actually completed', () => {
    seedTask('Email Maria', 'completed');
    const text = 'I marked the task "Email Maria" as completed.';
    const contract = makeContract({
      ownerSkill: 'tasks',
      actionability: 'execute',
      intent: 'tasks.adjust',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({
      text,
      contract,
      verification: { userId: USER_ID, tenantId: TENANT_ID },
    });

    expect(result.action).toBe('verified_kept');
    expect(result.text).toBe(text);
  });

  it('does NOT verify a completion claim when the task is still pending', () => {
    seedTask('Email Maria', 'pending');
    const text = 'I marked the task "Email Maria" as completed.';
    const contract = makeContract({
      ownerSkill: 'tasks',
      actionability: 'execute',
      intent: 'tasks.adjust',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({
      text,
      contract,
      verification: { userId: USER_ID, tenantId: TENANT_ID },
    });

    expect(result.action).not.toBe('verified_kept');
    expect(result.text).not.toBe(text);
    expect(result.issues).toContain('unverified_success_claim');
  });

  it('falls through on a name collision (two tasks share the exact title)', () => {
    seedTask('Email Maria', 'pending', 'ext-1');
    seedTask('Email Maria', 'pending', 'ext-2');
    const text = 'I created the task "Email Maria" for you.';
    const contract = makeContract({
      ownerSkill: 'tasks',
      actionability: 'execute',
      intent: 'tasks.create',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({
      text,
      contract,
      verification: { userId: USER_ID, tenantId: TENANT_ID },
    });

    expect(result.action).not.toBe('verified_kept');
    expect(result.status).toBe('repaired');
  });

  it('does not attempt verification when no verification scope is provided', () => {
    const text = 'I created the task "Email Maria" for you.';
    const contract = makeContract({
      ownerSkill: 'tasks',
      actionability: 'execute',
      intent: 'tasks.create',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({ text, contract });
    expect(result.action).not.toBe('verified_kept');
    expect(result.issues).toContain('unverified_success_claim');
  });
});

describe('M8 — surgical downgrade preserves innocent sentences', () => {
  it('removes only the offending sentence and keeps the rest', () => {
    const text = 'Here is your plan for the afternoon. I scheduled it for 2:00. Let me know if you want a different slot.';
    const contract = makeContract({
      ownerSkill: 'secretary',
      actionability: 'execute',
      intent: 'secretary.schedule',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.status).toBe('repaired');
    expect(result.action).toBe('surgical_downgrade');
    expect(result.text).toContain('Here is your plan for the afternoon.');
    expect(result.text).toContain('Let me know if you want a different slot.');
    expect(result.text).not.toContain('I scheduled it for 2:00');
    expect(result.originalText).toBe(text);
    expect(result.issues).toContain('unverified_success_claim');
  });

  it('replaces the whole answer only when every sentence is claim material', () => {
    const text = 'I scheduled it for 2:00.';
    const contract = makeContract({
      ownerSkill: 'secretary',
      actionability: 'execute',
      intent: 'secretary.schedule',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.status).toBe('repaired');
    expect(result.action).toBe('replaced');
    expect(result.text).not.toContain('I scheduled it for 2:00');
    expect(result.text).toContain('cannot honestly say');
    expect(result.originalText).toBe(text);
  });

  it('records { originalText, issues, action } on every trip', () => {
    const text = 'I scheduled it for 2:00.';
    const contract = makeContract({
      ownerSkill: 'secretary',
      actionability: 'execute',
      intent: 'secretary.schedule',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({ text, contract });
    expect(result.originalText).toBe(text);
    expect(result.tripIssues).toEqual(result.issues);
    expect(['surgical_downgrade', 'replaced', 'verified_kept']).toContain(result.action);
  });

  it('a clean pass reports action "pass" with no originalText', () => {
    const contract = makeContract({ ownerSkill: 'secretary', actionability: 'answer_only', language: 'en' });
    const result = applyChatResponseQualityGate({
      text: 'You can review the agenda whenever you like.',
      contract,
    });
    expect(result.action).toBe('pass');
    expect(result.originalText).toBeUndefined();
  });
});

// ─── Adversarial-review fix: line-aware surgical downgrade ────────

describe('surgical downgrade preserves markdown line structure', () => {
  it('keeps a numbered list intact and removes only the offending item', () => {
    const text = [
      'Here is your afternoon plan.',
      '1. Review the budget draft.',
      '2. I scheduled it for 2:00.',
      '3. Prepare the client notes.',
    ].join('\n');
    const contract = makeContract({
      ownerSkill: 'secretary',
      actionability: 'execute',
      intent: 'secretary.schedule',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.status).toBe('repaired');
    expect(result.action).toBe('surgical_downgrade');
    const lines = result.text.split('\n');
    expect(lines).toContain('Here is your afternoon plan.');
    expect(lines).toContain('1. Review the budget draft.');
    expect(lines).toContain('3. Prepare the client notes.');
    expect(result.text).not.toContain('I scheduled it for 2:00');
  });

  it('removes only the offending sentence WITHIN a list line, keeping the marker', () => {
    const text = [
      'Plan for today:',
      '- Prepare the deck for the review. I scheduled it for 2:00.',
      '- Send the agenda draft.',
    ].join('\n');
    const contract = makeContract({
      ownerSkill: 'secretary',
      actionability: 'execute',
      intent: 'secretary.schedule',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.action).toBe('surgical_downgrade');
    const lines = result.text.split('\n');
    expect(lines).toContain('- Prepare the deck for the review.');
    expect(lines).toContain('- Send the agenda draft.');
    expect(result.text).not.toContain('I scheduled it for 2:00');
  });

  it('collapses the blank-line run left behind by a fully-dropped paragraph', () => {
    const text = 'Here is the summary you asked for.\n\nI scheduled it for 2:00.\n\nLet me know what to adjust.';
    const contract = makeContract({
      ownerSkill: 'secretary',
      actionability: 'execute',
      intent: 'secretary.schedule',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.action).toBe('surgical_downgrade');
    expect(result.text).not.toContain('I scheduled it for 2:00');
    expect(result.text).not.toContain('\n\n\n');
    expect(result.text).toContain('Here is the summary you asked for.');
    expect(result.text).toContain('Let me know what to adjust.');
  });
});

// ─── Adversarial-review fix: distinct non-claim trip actions ──────

describe('non-claim trips get distinct action labels', () => {
  it('raw internal content only → action "sanitized"', () => {
    const contract = makeContract({
      ownerSkill: 'secretary',
      actionability: 'answer_only',
      language: 'en',
    });
    const result = applyChatResponseQualityGate({
      text: 'Your summary is ready. TypeError: cannot read properties of undefined.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.action).toBe('sanitized');
    expect(result.issues).toContain('raw_internal_content');
    expect(result.text).not.toContain('TypeError');
  });

  it('recipe structure repair → action "recipe_restructured"', () => {
    const contract = makeContract({
      ownerSkill: 'cooking',
      actionability: 'answer_only',
      expectedResponseShape: 'recipe',
      language: 'en',
    });
    const result = applyChatResponseQualityGate({
      text: 'Just mix 500g chicken with soy sauce and fry it.',
      contract,
    });

    expect(result.status).toBe('repaired');
    expect(result.action).toBe('recipe_restructured');
    expect(result.issues).toContain('recipe_missing_structure');
  });
});

// ─── Adversarial-review fix: verified_kept is turn-scoped ─────────

describe('token-zero verification requires turn recency', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    seedUser();
  });

  afterEach(() => {
    testDb?.close();
    testDb = null;
  });

  function backdateAllTasks(): void {
    testDb!.prepare(
      "UPDATE unified_tasks SET created_at = datetime('now', '-7 days'), updated_at = datetime('now', '-7 days'), synced_at = datetime('now', '-7 days') WHERE user_id = ?",
    ).run(USER_ID);
  }

  it('does NOT verify a creation claim against a week-old task with the exact title (surgical path)', () => {
    seedTask('Email Maria');
    backdateAllTasks();
    const text = 'Here is your plan for today. I created the task "Email Maria" for you. Anything else?';
    const contract = makeContract({
      ownerSkill: 'tasks',
      actionability: 'execute',
      intent: 'tasks.create',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({
      text,
      contract,
      verification: { userId: USER_ID, tenantId: TENANT_ID, requestStartedAt: Date.now() },
    });

    expect(result.action).not.toBe('verified_kept');
    expect(result.action).toBe('surgical_downgrade');
    expect(result.contract.verificationStatus).not.toBe('verified');
    expect(result.text).toContain('Here is your plan for today.');
    expect(result.text).not.toContain('I created the task "Email Maria" for you.');
  });

  it('verifies a creation claim when the row was written within the request window', () => {
    seedTask('Email Maria');
    const text = 'I created the task "Email Maria" for you.';
    const contract = makeContract({
      ownerSkill: 'tasks',
      actionability: 'execute',
      intent: 'tasks.create',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({
      text,
      contract,
      verification: { userId: USER_ID, tenantId: TENANT_ID, requestStartedAt: Date.now() },
    });

    expect(result.action).toBe('verified_kept');
    expect(result.text).toBe(text);
    expect(result.contract.verificationStatus).toBe('verified');
  });

  it('applies the same recency requirement to "task #N" id-claims', () => {
    seedTask('Email Maria');
    const row = testDb!.prepare('SELECT id FROM unified_tasks WHERE user_id = ? LIMIT 1').get(USER_ID) as { id: number };
    backdateAllTasks();
    const text = `I updated task #${row.id} with the new due date.`;
    const contract = makeContract({
      ownerSkill: 'tasks',
      actionability: 'execute',
      intent: 'tasks.adjust',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({
      text,
      contract,
      verification: { userId: USER_ID, tenantId: TENANT_ID, requestStartedAt: Date.now() },
    });

    expect(result.action).not.toBe('verified_kept');
    expect(result.contract.verificationStatus).not.toBe('verified');
  });
});

// ─── M16: honest partial multi-step reports pass the gate ──────────

describe('M16 — partial-failure multi-step answers are not clobbered by the gate', () => {
  it('e2e: a LIVE partial_success planner envelope survives the gate through the PRODUCTION mapping', async () => {
    // Adversarial-review fix (M16/M8 seam): this test drives the REAL
    // mapping layers instead of a hand-built contract. The executor
    // (buildExecutedChatActionResponse) composes the honest partial answer
    // and stamps metadata; the pipeline seam
    // (actionabilityForReasoningStatus / verificationForReasoningMetadata)
    // derives the contract fields the finalizer passes to the full gate.
    // Before the fix, 'partial_success' fell through to
    // answer_only/not_required and the gate rewrote the live partial answer.
    const { buildExecutedChatActionResponse } = await import('../../src/services/chat/executor/result-response');
    const { actionabilityForReasoningStatus, verificationForReasoningMetadata } = await import('../../src/api/routes/chat-pipeline/support');

    const step = (stepId: string, title: string) => ({
      stepId,
      skill: 'tasks',
      type: 'provider_write',
      action: 'create_task',
      risk: 'safe_write',
      provider: 'nexus',
      args: { title },
      requiredArgsPresent: true,
      idempotencyKey: `idem-${stepId}`,
      verification: { required: true, method: 'local_read_back', expectedFields: {} },
    }) as never;
    const plan = {
      schemaVersion: 1,
      userId: String(USER_ID),
      tenantId: String(TENANT_ID),
      conversationId: 'conv-gate-e2e',
      messageId: 'msg-gate-e2e',
      locale: 'en-US',
      timezone: 'UTC',
      channel: 'ios',
      createdAt: '2026-07-20T12:00:00.000Z',
      planner: 'deterministic',
      steps: [step('step_1', 'alpha'), step('step_2', 'beta'), step('step_3', 'gamma')],
      requiresConfirmation: true,
      confidence: 0.9,
    } as never;
    const input = {
      text: 'create task alpha, create task beta and create task gamma',
      userId: USER_ID,
      tenantId: TENANT_ID,
      conversationId: 'conv-gate-e2e',
      messageId: 'msg-gate-e2e',
      channel: 'ios',
      locale: 'en-US',
      timezone: 'UTC',
      persistRuns: false,
    } as never;
    const planSteps = (plan as { steps: unknown[] }).steps;
    const results = [
      { step: planSteps[0], status: 'verified_success', result: { task: { id: 't-1' } } },
      { step: planSteps[1], status: 'failed', error: 'provider_rejected' },
      { step: planSteps[2], status: 'verified_success', result: { task: { id: 't-3' } } },
    ] as never;

    const envelope = buildExecutedChatActionResponse(input, plan, results);
    const metadata = envelope.metadata as Record<string, unknown>;
    const status = String(metadata.actionStatus);
    expect(status).toBe('partial_success');
    // The executor stamps the contract verification vocabulary so both
    // mapping layers agree.
    expect(metadata.verificationStatus).toBe('partial_failure');

    const actionability = actionabilityForReasoningStatus(status);
    const verificationStatus = verificationForReasoningMetadata(metadata, status);
    expect(actionability).toBe('execute');
    expect(verificationStatus).toBe('partial_failure');

    const contract = makeContract({
      ownerSkill: 'tasks',
      intent: 'tasks.create',
      language: 'en',
      actionability,
      verificationStatus,
    });

    const result = applyChatResponseQualityGate({ text: envelope.text, contract });

    expect(result.status).toBe('pass');
    expect(result.issues).not.toContain('unverified_success_claim');
    expect(result.text).toBe(envelope.text);
    // The succeeded-step lines survive verbatim.
    expect(result.text).toContain('done and verified');
    expect(result.text).toContain('2 of 3 steps verified');
  });

  it('e2e: a LIVE verified_success planner status maps to execute/verified (never answer_only/not_required)', async () => {
    const { actionabilityForReasoningStatus, verificationForReasoningMetadata } = await import('../../src/api/routes/chat-pipeline/support');
    expect(actionabilityForReasoningStatus('verified_success')).toBe('execute');
    // Envelope value ('verified_success') and status fallback both resolve
    // to the contract vocabulary 'verified'.
    expect(verificationForReasoningMetadata({ verificationStatus: 'verified_success' }, 'verified_success')).toBe('verified');
    expect(verificationForReasoningMetadata(undefined, 'verified_success')).toBe('verified');
  });

  it('still trips on a FULL success claim when verification reports pending', () => {
    // Control: the partial_failure exemption is narrow. The same claim
    // language without the partial_failure verification status still trips.
    const text = 'Done — I completed 3 steps and verified the result.';
    const contract = makeContract({
      ownerSkill: 'tasks',
      actionability: 'execute',
      intent: 'tasks.create',
      language: 'en',
      verificationStatus: 'pending',
    });

    const result = applyChatResponseQualityGate({ text, contract });

    expect(result.issues).toContain('unverified_success_claim');
    expect(result.text).not.toBe(text);
  });
});
