// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M14 — deterministic routing-clarify pipeline terminal.
 *
 * Runs the REAL pre_routing + routing_clarify stages against a migrated
 * test database (real continuity/persistence, real finalizer contract_only
 * path). Proves:
 *   - a flag-on ambiguous write terminates at routing_clarify with the exact
 *     EN/PT/ES template (the model tail is never reached);
 *   - the stored assistant message IS the template, so the ANSWERING turn
 *     (continuity rebuilt from real conversation state) never re-clarifies;
 *   - reads never clarify; flag-off turns never clarify;
 *   - the clarify budget counter increments exactly once per pipeline turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Request, Response } from 'express';
import { createMigratedTestDatabase } from '../../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { runChatMessagePipeline } from '../../../src/api/routes/chat-pipeline/runner';
import { preRoutingStage } from '../../../src/api/routes/chat-pipeline/stages/pre-routing';
import { routingClarifyStage } from '../../../src/api/routes/chat-pipeline/stages/routing-clarify';
import type { ChatStage, ChatTurnCtx } from '../../../src/api/routes/chat-pipeline/types';
import { resetChatMessageContextForTests } from '../../../src/api/routes/chat-message-context';
import { clearAllConversations } from '../../../src/state/conversation';
import { isRoutingClarifyQuestion } from '../../../src/services/chat/planner/clarification';
import { _resetRoutingCalibrationForTests } from '../../../src/services/intent-resolution/confidence';
import {
  _setCompiledIntentVocabularyForTests,
  resetIntentVocabularyForTests,
  type CompiledCapabilityVocabulary,
} from '../../../src/services/intent-resolution/vocabulary';
import {
  getRoutingClarifyCounters,
  resetRoutingClarifyCountersForTests,
} from '../../../src/services/chat-hybrid-metrics';

function vocabularyEntry(
  capabilityId: string,
  domain: string,
  terms: string[],
  order = 0,
): CompiledCapabilityVocabulary {
  return {
    capabilityId,
    domain,
    skill: capabilityId,
    order,
    matchers: terms.map((term) => ({
      label: `locale:en:${term}`,
      regex: new RegExp(`\\b(?:${term})\\b`, 'i'),
    })),
    normalizedExamples: [],
  };
}

/**
 * "Add my workout expense" scores 2 (add+expense) for finance and 2
 * (add+workout) for triathlon → same calibration bucket → clarify-eligible
 * ambiguous write.
 */
const SYNTHETIC_VOCABULARY: CompiledCapabilityVocabulary[] = [
  vocabularyEntry('finance', 'finance', ['add', 'expense', 'receipt'], 0),
  vocabularyEntry('triathlon', 'triathlon', ['add', 'workout', 'session'], 1),
  vocabularyEntry('secretary', 'secretary', ['task', 'reminder'], 2),
];

const AMBIGUOUS_WRITE = 'Add my workout expense';
const USER_ID = 9301;
const TENANT_ID = 9301;

let seq = 0;

const tailSentinel: ChatStage = {
  name: 'tail_sentinel',
  traceStages: [],
  canHandle: () => true,
  handle: async (ctx: ChatTurnCtx) => {
    (ctx.res as Response).json({ text: 'TAIL', routeMethod: 'tail-sentinel' });
    return { kind: 'respond' };
  },
};

async function runTurn(message: string, options: { locale?: string } = {}): Promise<{
  responded: string | null;
  body: Record<string, unknown> | undefined;
}> {
  seq += 1;
  const json = vi.fn();
  const ctx = {
    req: { header: () => undefined, body: {} } as unknown as Request,
    res: { json } as unknown as Response,
    userId: USER_ID,
    tenantId: TENANT_ID,
    normalizedText: message,
    normalizedTextLower: message.toLowerCase(),
    normalizedAttachments: [],
    scopedClientMessageId: null,
    userMessageId: `user-msg-${seq}`,
    requestStartedAt: Date.now(),
    chatRequestId: `clarify-req-${seq}`,
    latency: {
      mark: vi.fn(),
      snapshot: vi.fn(() => ({ tier: 'tier1_fast_read', totalMs: 1, budgetMs: 100, withinBudget: true })),
    } as unknown as ChatTurnCtx['latency'],
    ensureModelBudget: vi.fn(async () => true),
    isNewUserFlow: false,
    recordDeterministicReadEvidence: vi.fn(),
    recordChatV2CompletionEvidenceForImmediateResponse: vi.fn(),
    bypassReadFastPathsForWriteIntent: false,
    chatCoreV2RouteLocale: options.locale ?? 'en-US',
    recordLegacyFallbackSample: vi.fn(),
    bypassNaturalLanguageTokenZeroForChatCoreV2: false,
  } as unknown as ChatTurnCtx;
  const responded = await runChatMessagePipeline(ctx, [preRoutingStage, routingClarifyStage, tailSentinel]);
  return { responded, body: json.mock.calls[0]?.[0] as Record<string, unknown> | undefined };
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  // Chat history rows FK-reference users; seed the corpus user.
  testDb.prepare(`
    INSERT INTO users (
      id, telegram_id, first_name, language, timezone, tier, status,
      auth_provider, daily_message_limit, daily_token_limit, daily_cost_limit_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(USER_ID, USER_ID, 'Test', 'en', 'Europe/Lisbon', 'pro', 'active', 'telegram', 40, 100000, 1);
  _setCompiledIntentVocabularyForTests(SYNTHETIC_VOCABULARY);
  resetRoutingClarifyCountersForTests();
  resetChatMessageContextForTests();
  clearAllConversations();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetIntentVocabularyForTests();
  _resetRoutingCalibrationForTests();
  resetRoutingClarifyCountersForTests();
  resetChatMessageContextForTests();
  clearAllConversations();
  testDb.close();
});

describe('flag ON — deterministic clarify terminal', () => {
  beforeEach(() => {
    vi.stubEnv('AI_ROUTING_CLARIFY', 'true');
  });

  it('responds with the exact EN template through the finalizer, never reaching the tail', async () => {
    const { responded, body } = await runTurn(AMBIGUOUS_WRITE);
    expect(responded).toBe('routing_clarify');
    expect(body).toBeDefined();
    expect(body!.text).toBe('Did you mean Finance or Training?');
    expect(body!.routeMethod).toBe('routing-clarify');
    expect(isRoutingClarifyQuestion(String(body!.text))).toBe(true);
    const metadata = body!.metadata as Record<string, unknown>;
    expect(metadata.type).toBe('chat_routing_clarify');
    expect(metadata.actionStatus).toBe('needs_clarification');
    expect(metadata.candidateDomains).toEqual(['finance', 'triathlon']);
  });

  it('renders the PT template for pt locales', async () => {
    const { responded, body } = await runTurn(AMBIGUOUS_WRITE, { locale: 'pt-BR' });
    expect(responded).toBe('routing_clarify');
    expect(body!.text).toBe('Queres dizer Finance ou Training?');
    expect(isRoutingClarifyQuestion(String(body!.text))).toBe(true);
  });

  it('renders the ES template for es locales', async () => {
    const { responded, body } = await runTurn(AMBIGUOUS_WRITE, { locale: 'es-419' });
    expect(responded).toBe('routing_clarify');
    expect(body!.text).toBe('¿Te refieres a Finance o a Training?');
    expect(isRoutingClarifyQuestion(String(body!.text))).toBe(true);
  });

  it('never re-clarifies the answering turn — continuity carries the stored template (e2e)', async () => {
    const first = await runTurn(AMBIGUOUS_WRITE);
    expect(first.responded).toBe('routing_clarify');

    // The user answers the clarify question; the pre_routing decision is
    // rebuilt from the REAL persisted continuity (conversation state +
    // durable chat_conversation_state written by the clarify terminal), so
    // even a still-ambiguous answer must NOT clarify again.
    const second = await runTurn(AMBIGUOUS_WRITE);
    expect(second.responded).toBe('tail_sentinel');
    expect(second.body!.text).toBe('TAIL');
  });

  it('survives a process restart: durable continuity alone still prevents re-clarify', async () => {
    const first = await runTurn(AMBIGUOUS_WRITE);
    expect(first.responded).toBe('routing_clarify');

    // Simulate restart: in-process conversation cache is gone; the durable
    // last_assistant_message_id pointer must recover the template.
    clearAllConversations();
    resetChatMessageContextForTests();

    const second = await runTurn(AMBIGUOUS_WRITE);
    expect(second.responded).toBe('tail_sentinel');
  });

  it('reads never clarify', async () => {
    const { responded, body } = await runTurn('my workout expense');
    expect(responded).toBe('tail_sentinel');
    expect(body!.text).toBe('TAIL');
  });

  it('counts the clarify budget exactly once per pipeline turn', async () => {
    await runTurn(AMBIGUOUS_WRITE);
    expect(getRoutingClarifyCounters()).toEqual({ evaluatedTurns: 1, clarifiedTurns: 1 });
    // The answering turn evaluates (once) but does not clarify.
    await runTurn(AMBIGUOUS_WRITE);
    expect(getRoutingClarifyCounters()).toEqual({ evaluatedTurns: 2, clarifiedTurns: 1 });
  });
});

describe('flag OFF (default) — the terminal is inert', () => {
  beforeEach(() => {
    vi.stubEnv('AI_ROUTING_CLARIFY', 'false');
  });

  it('an ambiguous write flows through to the tail and no telemetry is recorded', async () => {
    const { responded, body } = await runTurn(AMBIGUOUS_WRITE);
    expect(responded).toBe('tail_sentinel');
    expect(body!.text).toBe('TAIL');
    expect(getRoutingClarifyCounters()).toEqual({ evaluatedTurns: 0, clarifiedTurns: 0 });
  });
});
