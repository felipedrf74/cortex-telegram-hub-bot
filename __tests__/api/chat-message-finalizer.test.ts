// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M8 — unified chat answer finalizer tests.
 *
 * Pins:
 *   - policy table: deterministic families 'contract_only', model-backed
 *     families 'full_gate', replay/planner families 'passthrough', and
 *     UNKNOWN families fail closed to 'full_gate';
 *   - fast-path family: heuristics skipped, contract enrichment still applied;
 *   - v2 local-answer family gated (adversarial hallucinated-success fixture);
 *   - verified-kept end-to-end: true claim + matching SQLite row keeps text
 *     and stamps metadata.qualityGate;
 *   - gate outcome counters (pass / verified_kept / surgical / replaced);
 *   - governance: chat-message-routes.ts has exactly ONE terminal pipeline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import type Database from 'better-sqlite3';

let testDb: Database.Database | null = null;

vi.mock('../../src/services/database', () => ({
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

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  finalizeChatMessageResponse,
  resolveChatFinalizerGatePolicy,
} from '../../src/api/routes/chat-message-finalizer';
import { createChatLatencyTracker } from '../../src/services/chat-answer-contract';
import {
  getChatQualityGateOutcomeCounters,
  resetChatQualityGateOutcomeCountersForTests,
} from '../../src/services/chat-hybrid-metrics';
import { upsertTask } from '../../src/services/task-store/unified-task-store';

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

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    normalizedText: 'schedule a meeting with maria tomorrow',
    userId: USER_ID,
    tenantId: TENANT_ID,
    chatRequestId: 'req-finalizer-test',
    tracker: createChatLatencyTracker(Date.now()),
    latencyTier: 'tier1_fast_read' as const,
    ...overrides,
  };
}

function baseResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    text: 'Here is your answer.',
    domain: 'secretary',
    routeMethod: 'fast-path',
    confidence: 1,
    buttons: null,
    metadata: { type: 'fast_path' },
    timestamp: '2026-07-20T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  seedUser();
  resetChatQualityGateOutcomeCountersForTests();
});

afterEach(() => {
  testDb?.close();
  testDb = null;
});

describe('gate policy table', () => {
  it('resolves deterministic families to contract_only', () => {
    for (const stageFamily of [
      'token_zero_shortcut',
      'cached_command',
      'authenticated_identity',
      'fast_path',
      'chat_core_v2_deterministic_read',
      'pending_work_cancelled',
      'action_gateway_stop',
    ]) {
      expect(resolveChatFinalizerGatePolicy({ stageFamily })).toBe('contract_only');
    }
  });

  it('resolves model-backed families to full_gate', () => {
    for (const stageFamily of [
      'legacy_response',
      'chat_core_v2_local_answer',
      'action_planner_model',
      'internet_research',
      'attachment',
    ]) {
      expect(resolveChatFinalizerGatePolicy({ stageFamily })).toBe('full_gate');
    }
  });

  it('resolves replay/planner families to passthrough', () => {
    expect(resolveChatFinalizerGatePolicy({ stageFamily: 'idempotent_replay' })).toBe('passthrough');
    expect(resolveChatFinalizerGatePolicy({ stageFamily: 'action_planner_deterministic' })).toBe('passthrough');
    expect(resolveChatFinalizerGatePolicy({ stageFamily: 'decision_confirmation_execute' })).toBe('passthrough');
  });

  it('fails closed: unknown stage family AND unknown routeMethod → full_gate', () => {
    expect(resolveChatFinalizerGatePolicy({ stageFamily: 'brand_new_family' })).toBe('full_gate');
    expect(resolveChatFinalizerGatePolicy({ routeMethod: 'never-seen-before' })).toBe('full_gate');
    expect(resolveChatFinalizerGatePolicy({})).toBe('full_gate');
  });

  it('falls back to the deterministic routeMethod table when no stage family is given', () => {
    expect(resolveChatFinalizerGatePolicy({ routeMethod: 'fast-path' })).toBe('contract_only');
    expect(resolveChatFinalizerGatePolicy({ routeMethod: 'authenticated-identity' })).toBe('contract_only');
  });

  // Adversarial-review fix: domain_shortcut is a MIXED family — split by
  // routeMethod, fail closed to full_gate.
  it('domain_shortcut: model-authored routeMethods run the full gate', () => {
    for (const routeMethod of ['content-refine', 'content-refine-fallback', 'content-script']) {
      expect(resolveChatFinalizerGatePolicy({ stageFamily: 'domain_shortcut', routeMethod })).toBe('full_gate');
    }
  });

  it('domain_shortcut: deterministic siblings keep contract_only', () => {
    for (const routeMethod of [
      'finance-state-shortcut',
      'content-intelligence-shortcut',
      'content-script-unavailable',
      'content-refine-unavailable',
    ]) {
      expect(resolveChatFinalizerGatePolicy({ stageFamily: 'domain_shortcut', routeMethod })).toBe('contract_only');
    }
  });

  it('domain_shortcut: unknown or missing routeMethod fails closed to full_gate', () => {
    expect(resolveChatFinalizerGatePolicy({ stageFamily: 'domain_shortcut' })).toBe('full_gate');
    expect(resolveChatFinalizerGatePolicy({ stageFamily: 'domain_shortcut', routeMethod: 'brand-new-shortcut' })).toBe('full_gate');
  });

  it('content-script without a stage family no longer resolves contract_only (model-authored)', () => {
    expect(resolveChatFinalizerGatePolicy({ routeMethod: 'content-script' })).toBe('full_gate');
  });

  it('degraded_response family is passthrough (hand-rolled degraded contract)', () => {
    expect(resolveChatFinalizerGatePolicy({ stageFamily: 'degraded_response' })).toBe('passthrough');
  });
});

describe('contract_only families — heuristics skipped, enrichment still applied', () => {
  it('fast-path family keeps a would-trip templated text verbatim and still stamps the contract', () => {
    // This exact text trips the execute-tier heuristic under the full gate.
    const text = 'Done. I scheduled it for 2:00.';
    const response = finalizeChatMessageResponse(
      baseResponse({ text, routeMethod: 'fast-path' }),
      baseCtx({
        stageFamily: 'fast_path',
        actionability: 'execute',
        verificationStatus: 'pending',
        compositionMode: 'templated',
      }),
    );

    expect(response.text).toBe(text); // heuristics skipped — text untouched
    const metadata = response.metadata as Record<string, any>;
    expect(metadata.chatReasoning).toBeDefined(); // enrichment still applied
    expect(metadata.responseQuality.status).toBe('pass');
    expect(metadata.qualityGate).toBeUndefined();
    expect(response.responseBlocks).toBeDefined();
  });
});

describe('full_gate families — adversarial hallucinated success is caught', () => {
  it('gates the ChatCoreV2 local-answer family (hallucinated write claim downgraded)', () => {
    const text = 'I scheduled it for 2:00. It is confirmed on your side.';
    const response = finalizeChatMessageResponse(
      baseResponse({ text, routeMethod: 'chat-core-v2-local-llm', metadata: { type: 'chat_core_v2_local_llm' } }),
      baseCtx({
        stageFamily: 'chat_core_v2_local_answer',
        actionability: 'execute',
        verificationStatus: 'not_required',
        compositionMode: 'model_constrained',
      }),
    );

    expect(response.text).not.toContain('I scheduled it for 2:00');
    const metadata = response.metadata as Record<string, any>;
    expect(metadata.responseQuality.status).toBe('repaired');
    expect(metadata.qualityGate).toBeDefined();
    expect(metadata.qualityGate.originalText).toBe(text);
    expect(metadata.qualityGate.issues).toContain('unverified_success_claim');
    expect(['surgical_downgrade', 'replaced']).toContain(metadata.qualityGate.action);
  });

  it('unknown routeMethod runs the full gate (fail closed)', () => {
    const text = 'I scheduled it for 2:00.';
    const response = finalizeChatMessageResponse(
      baseResponse({ text, routeMethod: 'mystery-route' }),
      baseCtx({
        actionability: 'execute',
        verificationStatus: 'not_required',
      }),
    );

    expect(response.text).not.toContain('I scheduled it for 2:00');
    const metadata = response.metadata as Record<string, any>;
    expect(metadata.qualityGate.action).toBeDefined();
  });

  it('keeps a TRUE claim when the created task exists in SQLite (verified_kept end-to-end)', () => {
    upsertTask(USER_ID, {
      provider: 'nexus',
      externalId: 'ext-email-maria',
      title: 'Email Maria',
      status: 'pending',
      priority: 0,
    }, TENANT_ID);

    const text = 'I created the task "Email Maria" for you.';
    const response = finalizeChatMessageResponse(
      baseResponse({ text, routeMethod: 'mystery-route' }),
      baseCtx({
        actionability: 'execute',
        verificationStatus: 'pending',
      }),
    );

    expect(response.text).toBe(text);
    const metadata = response.metadata as Record<string, any>;
    expect(metadata.responseQuality.status).toBe('pass');
    expect(metadata.responseQuality.qualityGateReason).toContain('verified_kept');
    expect(metadata.qualityGate.action).toBe('verified_kept');
    expect(metadata.qualityGate.originalText).toBe(text);
    expect(metadata.chatReasoning.verificationStatus).toBe('verified');
  });
});

describe('domain_shortcut model-authored paths — Phase K F3 restored', () => {
  it('gates a content-refine response carrying an unverified side-effect success claim', () => {
    // Pre-fix this family was contract_only, so "Publiquei o reel" shipped
    // untouched. Model-authored shortcut routeMethods now run the full gate.
    const text = 'Publiquei o reel no Instagram hoje às 14h.';
    const response = finalizeChatMessageResponse(
      {
        id: 'msg-refine-1',
        text,
        domain: 'content',
        routeMethod: 'content-refine',
        confidence: 0.9,
        buttons: null,
        metadata: { type: 'content_refine', sourceLength: 120, degraded: false },
        timestamp: '2026-07-20T12:00:00.000Z',
      },
      baseCtx({
        normalizedText: 'publica o reel que preparamos',
        stageFamily: 'domain_shortcut',
        actionability: 'answer_only',
        verificationStatus: 'not_required',
      }),
    );

    expect(response.text).not.toContain('Publiquei o reel');
    const metadata = response.metadata as Record<string, any>;
    expect(metadata.qualityGate).toBeDefined();
    expect(metadata.qualityGate.issues).toContain('unverified_success_claim');
    expect(metadata.qualityGate.originalText).toBe(text);
  });

  it('keeps deterministic finance-state-shortcut text verbatim under the same family', () => {
    const text = 'Total spending this month: 1,500 EUR. Remaining budget: 500 EUR.';
    const response = finalizeChatMessageResponse(
      {
        id: 'msg-fin-1',
        text,
        domain: 'finance',
        routeMethod: 'finance-state-shortcut',
        confidence: 0.95,
        buttons: null,
        metadata: { type: 'finance_state_shortcut' },
        timestamp: '2026-07-20T12:00:00.000Z',
      },
      baseCtx({
        normalizedText: 'how is my budget',
        stageFamily: 'domain_shortcut',
        actionability: 'answer_only',
        verificationStatus: 'not_required',
      }),
    );

    expect(response.text).toBe(text);
    const metadata = response.metadata as Record<string, any>;
    expect(metadata.qualityGate).toBeUndefined();
  });
});

describe('gate-repaired text rebuilds responseBlocks (blocks/text coherence)', () => {
  it('rebuilds blocks from the REPAIRED text when the gate rewrote a planner-model response', () => {
    const staleBlocks = [
      { type: 'paragraph', markdown: 'I scheduled it for 2:00.' },
    ] as any;
    const response = finalizeChatMessageResponse(
      baseResponse({
        text: 'I scheduled it for 2:00.',
        routeMethod: 'chat-reasoning-engine',
        responseBlocks: staleBlocks,
      }),
      baseCtx({
        stageFamily: 'action_planner_model',
        actionability: 'execute',
        verificationStatus: 'not_required',
      }),
    );

    expect(response.text).not.toContain('I scheduled it for 2:00');
    expect(response.responseBlocks).toBeDefined();
    expect(response.responseBlocks).not.toBe(staleBlocks);
    const blocksJson = JSON.stringify(response.responseBlocks);
    expect(blocksJson).not.toContain('I scheduled it for 2:00');
  });

  it('keeps caller-provided blocks when the text is unchanged', () => {
    const callerBlocks = [
      { type: 'paragraph', markdown: 'Here is a neutral answer.' },
    ] as any;
    const response = finalizeChatMessageResponse(
      baseResponse({
        text: 'Here is a neutral answer.',
        routeMethod: 'chat-reasoning-engine',
        responseBlocks: callerBlocks,
      }),
      baseCtx({
        stageFamily: 'action_planner_model',
        actionability: 'answer_only',
        verificationStatus: 'not_required',
      }),
    );

    expect(response.text).toBe('Here is a neutral answer.');
    expect(response.responseBlocks).toBe(callerBlocks);
  });
});

describe('passthrough families', () => {
  it('returns the envelope byte-identical for idempotent replay', () => {
    const envelope = baseResponse({ routeMethod: 'idempotent-replay', text: 'I scheduled it for 2:00.' });
    const response = finalizeChatMessageResponse(envelope, baseCtx({ stageFamily: 'idempotent_replay' }));
    expect(response).toBe(envelope); // same reference, untouched
  });
});

describe('gate outcome counters', () => {
  it('counts pass / surgical / replaced / verified_kept for full-gate families only', () => {
    // pass
    finalizeChatMessageResponse(
      baseResponse({ text: 'Here is a neutral answer.', routeMethod: 'mystery-route' }),
      baseCtx({ actionability: 'answer_only', verificationStatus: 'not_required' }),
    );
    // replaced (single-sentence claim)
    finalizeChatMessageResponse(
      baseResponse({ text: 'I scheduled it for 2:00.', routeMethod: 'mystery-route' }),
      baseCtx({ actionability: 'execute', verificationStatus: 'not_required' }),
    );
    // surgical (multi-sentence, one bad)
    finalizeChatMessageResponse(
      baseResponse({
        text: 'Here is the plan for today. I scheduled it for 2:00. Tell me if that works.',
        routeMethod: 'mystery-route',
      }),
      baseCtx({ actionability: 'execute', verificationStatus: 'not_required' }),
    );
    // contract_only family must NOT count
    finalizeChatMessageResponse(
      baseResponse({ text: 'Done. I scheduled it for 2:00.', routeMethod: 'fast-path' }),
      baseCtx({ stageFamily: 'fast_path', actionability: 'execute', verificationStatus: 'pending', compositionMode: 'templated' }),
    );

    const counters = getChatQualityGateOutcomeCounters();
    expect(counters.pass).toBeGreaterThanOrEqual(1);
    expect(counters.replaced).toBe(1);
    expect(counters.surgical_downgrade).toBe(1);

    // verified_kept
    upsertTask(USER_ID, {
      provider: 'nexus',
      externalId: 'ext-call-joao',
      title: 'Call Joao',
      status: 'pending',
      priority: 0,
    }, TENANT_ID);
    finalizeChatMessageResponse(
      baseResponse({ text: 'I created the task "Call Joao" for you.', routeMethod: 'mystery-route' }),
      baseCtx({ actionability: 'execute', verificationStatus: 'pending' }),
    );
    expect(getChatQualityGateOutcomeCounters().verified_kept).toBe(1);
  });
});

describe('governance — chat-message-routes.ts has ONE terminal pipeline', () => {
  const routesSource = fs.readFileSync(
    path.join(__dirname, '../../src/api/routes/chat-message-routes.ts'),
    'utf8',
  );

  it('routes file no longer references the gate/composer/enrichment primitives directly', () => {
    expect(routesSource).not.toContain('applyChatResponseQualityGate');
    expect(routesSource).not.toContain('composeNexusFinalAnswer');
    expect(routesSource).not.toContain('buildNexusComposedAnswerDraft');
    expect(routesSource).not.toContain('enrichChatResponseForContract');
    expect(routesSource).not.toMatch(/function buildChatAnswerMetadata/);
    expect(routesSource).toContain("from './chat-message-finalizer'");
  });

  it('every non-error terminal res.json in the /message handler returns a finalized identifier', () => {
    const handlerStart = routesSource.indexOf("router.post('/message'");
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = routesSource.slice(handlerStart);

    // Identifiers produced by the finalizer inside the handler.
    const finalized = new Set<string>();
    const finalizeCalls = [...handler.matchAll(/const (\w+) = finalizeChatMessageResponse\(/g)];
    for (const match of finalizeCalls) {
      finalized.add(match[1]!);
    }
    // Every terminal family must flow through the finalizer — pin the number
    // of finalize call sites so a new raw res.json family cannot slip in.
    expect(finalizeCalls.length).toBeGreaterThanOrEqual(20);
    // The legacy site builds the envelope from finalizeChatAnswerMetadata.
    if (/const enriched = finalizeChatAnswerMetadata\(\{[\s\S]*?const (\w+) = buildChatHandlerResponseEnvelope\(/.test(handler)) {
      const legacy = handler.match(/const enriched = finalizeChatAnswerMetadata\(\{[\s\S]*?const (\w+) = buildChatHandlerResponseEnvelope\(/);
      if (legacy) finalized.add(legacy[1]!);
    }

    // Every res.json(<identifier>) / res.status(...).json(<identifier>) must
    // use a finalized identifier. Inline object literals are allowed ONLY for
    // error envelopes ({ error: ... }).
    const terminalCalls = [...handler.matchAll(/res(?:\.status\((?:\d+|[A-Za-z][\w.]*(?:\([^)]*\))?)\))?\.json\(([^)]*)\)/g)];
    expect(terminalCalls.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const call of terminalCalls) {
      const arg = call[1]!.trim();
      if (arg.startsWith('{')) {
        // Inline literal: must be an error envelope.
        if (!/^\{\s*\n?\s*error\s*:/.test(arg) && !arg.startsWith('{ error')) offenders.push(arg.slice(0, 60));
        continue;
      }
      const identifier = arg.replace(/\.[\w.]+$/, '').trim();
      if (!finalized.has(identifier)) offenders.push(arg.slice(0, 60));
    }
    expect(offenders).toEqual([]);
  });

  // Adversarial-review fix: the degraded-response terminal used to bypass
  // the finalizer entirely. It now routes its envelope through
  // finalizeChatMessageResponse with the 'degraded_response' PASSTHROUGH
  // family (its contract is hand-rolled), so drift is caught here.
  it('degraded-response terminal routes through the finalizer', () => {
    const degradedSource = fs.readFileSync(
      path.join(__dirname, '../../src/api/routes/chat-message-degraded-response.ts'),
      'utf8',
    );
    expect(degradedSource).toContain("from './chat-message-finalizer'");
    expect(degradedSource).toMatch(/const response = finalizeChatMessageResponse\(/);
    expect(degradedSource).toContain("stageFamily: 'degraded_response'");
    // Its only non-error terminal must send the finalized identifier.
    const terminalCalls = [...degradedSource.matchAll(/res(?:\.status\(\d+\))?\.json\(([^)]*)\)/g)]
      .map((match) => match[1]!.trim())
      .filter((arg) => !arg.startsWith('{'));
    expect(terminalCalls).toEqual(['response']);
  });
});
