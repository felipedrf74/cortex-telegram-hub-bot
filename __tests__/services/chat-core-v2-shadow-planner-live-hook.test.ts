// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Batch-A: the fire-and-forget, triple-gated, DEFAULT-OFF shadow-planner side
 * effect wired into the live synchronous shadow route hook.
 *
 * Invariants under test:
 *   - flag OFF (default) => dispatchLocalReasoning NEVER called, hook result
 *     byte-identical, NO planner span recorded.
 *   - flag ON + active orchestrator mode + not kill-switched => the background
 *     task runs (awaited via the onShadowPlannerSettled seam, NOT by the live
 *     caller), a `shadow_planner` span is recorded, the dispatch is invoked
 *     through the local-inference slot, and NO raw user text reaches the span.
 *   - NON-BLOCKING: the hook returns synchronously BEFORE a deliberately-slow
 *     mocked Ollama resolves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const dispatchLocalReasoning = vi.fn<(task: unknown) => Promise<unknown>>();

vi.mock('../../src/services/provider-registry', () => ({
  ensureActiveProvider: () => ({ dispatchLocalReasoning }),
}));

import {
  runChatCoreV2ShadowRouteHook,
  type ChatCoreV2ShadowRouteHookResult,
} from '../../src/services/chat-core-v2/shadow-route-hook';
import { listChatV2TraceSpansForTurn } from '../../src/services/chat-core-v2/trace-recorder';
import {
  _resetLocalInferenceGateForTests,
  getLocalInferenceGateSnapshot,
} from '../../src/services/chat-core-v2/local-inference-concurrency-gate';
import {
  CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
  CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
  type ChatTurnPlanMicro,
} from '../../src/services/chat-core-v2/plan-schema';

const SECRET_MESSAGE = 'SUPER_SECRET_user_text_buy_milk_42xyz';

const HMAC_ENV = {
  CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'true',
  CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: 'chat-core-v2-shadow-planner-live-secret',
};

// Triple gate satisfied: NEW planner flag on + active orchestrator mode.
const PLANNER_ON_ENV = {
  ...HMAC_ENV,
  CHAT_CORE_V2_SHADOW_PLANNER_ENABLED: 'true',
  CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow',
};

function baseInput(db: Database.Database, env: Record<string, string>) {
  let settled: Promise<void> | undefined;
  const input = {
    normalizedText: SECRET_MESSAGE,
    userId: 42,
    tenantId: 7,
    chatRequestId: `chat-planner-live-${Math.random().toString(36).slice(2)}`,
    userMessageId: 'msg-user-planner-live',
    clientMessageId: 'client-planner-live',
    locale: 'en',
    timezone: 'Europe/Lisbon',
    now: new Date('2026-05-30T10:00:00.000Z'),
    env,
    db,
    onShadowPlannerSettled: (p: Promise<void>) => {
      settled = p;
    },
  };
  return { input, getSettled: () => settled };
}

function validPlanJson(overrides: Partial<ChatTurnPlanMicro> = {}): string {
  return JSON.stringify({
    schemaVersion: CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
    intent: 'read',
    domains: ['tasks'],
    capabilityIds: ['tasks.today_summary'],
    requiredReads: [{ requestId: 'read-1', capabilityId: 'tasks.today_summary' }],
    proposedWrites: [],
    evidenceClaimIds: ['evidence:1'],
    confidence: 0.9,
    complexityScore: 0.2,
    escalationReasons: [],
    contextHash: 'ctx-1',
    promptVersion: CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
    ...overrides,
  });
}

let db: Database.Database;

describe('Chat Core v2 shadow planner live hook (Batch-A)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    dispatchLocalReasoning.mockReset();
    _resetLocalInferenceGateForTests();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('is fully inert when the NEW planner flag is OFF (default): no dispatch, no span, identical result', async () => {
    dispatchLocalReasoning.mockResolvedValue({ text: validPlanJson() });
    // Route hook on, HMAC present, BUT planner flag absent (default off).
    const { input, getSettled } = baseInput(db, HMAC_ENV);

    const result = runChatCoreV2ShadowRouteHook(input);

    expect(result.enabled).toBe(true);
    expect(result.recorded).toBe(true);
    // No background task was ever spawned.
    expect(getSettled()).toBeUndefined();
    // The local model was never touched.
    expect(dispatchLocalReasoning).not.toHaveBeenCalled();
    // No planner span recorded.
    const spans = listChatV2TraceSpansForTurn(input.chatRequestId, db);
    expect(spans.some((s) => s.name === 'shadow_planner')).toBe(false);
  });

  it('does NOT dispatch when the planner flag is on but the orchestrator mode is off/absent (gate 2)', async () => {
    dispatchLocalReasoning.mockResolvedValue({ text: validPlanJson() });
    const { input, getSettled } = baseInput(db, {
      ...HMAC_ENV,
      CHAT_CORE_V2_SHADOW_PLANNER_ENABLED: 'true',
      // CHAT_CORE_V2_ORCHESTRATOR_MODE intentionally absent => parsed as 'off'.
    });

    const result = runChatCoreV2ShadowRouteHook(input);

    expect(result.recorded).toBe(true);
    expect(getSettled()).toBeUndefined();
    expect(dispatchLocalReasoning).not.toHaveBeenCalled();
  });

  it('does NOT dispatch when the per-tenant kill-switch forces orchestrator mode off (gate 3)', async () => {
    dispatchLocalReasoning.mockResolvedValue({ text: validPlanJson() });
    const { input, getSettled } = baseInput(db, {
      ...HMAC_ENV,
      CHAT_CORE_V2_SHADOW_PLANNER_ENABLED: 'true',
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
    });

    const result = runChatCoreV2ShadowRouteHook(input);

    expect(result.recorded).toBe(true);
    expect(getSettled()).toBeUndefined();
    expect(dispatchLocalReasoning).not.toHaveBeenCalled();
  });

  it('keeps the hook return byte-identical whether the planner flag is on or off', () => {
    dispatchLocalReasoning.mockResolvedValue({ text: validPlanJson() });
    const turnId = 'chat-planner-byte-identical';

    const offDb = new Database(':memory:');
    const onDb = new Database(':memory:');
    try {
      const off = runChatCoreV2ShadowRouteHook({
        ...baseInput(offDb, HMAC_ENV).input,
        chatRequestId: turnId,
        onShadowPlannerSettled: undefined,
      });
      const on = runChatCoreV2ShadowRouteHook({
        ...baseInput(onDb, PLANNER_ON_ENV).input,
        chatRequestId: turnId,
        onShadowPlannerSettled: undefined,
      });
      // The synchronous return shape/bytes are identical regardless of the
      // (fire-and-forget) planner side effect.
      const strip = (r: ChatCoreV2ShadowRouteHookResult) => ({ ...r, replayBundleId: 'X' });
      expect(JSON.stringify(strip(on))).toBe(JSON.stringify(strip(off)));
    } finally {
      offDb.close();
      onDb.close();
    }
  });

  it('runs the planner in the background (triple gate on): dispatch via slot, span recorded, NO raw text leaked', async () => {
    dispatchLocalReasoning.mockResolvedValue({ text: validPlanJson() });
    const { input, getSettled } = baseInput(db, PLANNER_ON_ENV);

    const result = runChatCoreV2ShadowRouteHook(input);
    expect(result.recorded).toBe(true);

    // The live caller did NOT await — but a background promise was handed out.
    const settled = getSettled();
    expect(settled).toBeDefined();
    await settled;

    // The dispatch ran exactly once, through the local-inference slot, with a
    // bounded text-free packet (no raw user message text in the prompt).
    expect(dispatchLocalReasoning).toHaveBeenCalledTimes(1);
    const task = dispatchLocalReasoning.mock.calls[0][0] as {
      prompt: string;
      think?: boolean;
      numPredict?: number;
      allowCloudEscalation?: boolean;
    };
    expect(task.think).toBe(false);
    expect(task.allowCloudEscalation).toBe(false);
    expect(typeof task.numPredict).toBe('number');
    expect(task.prompt).not.toContain(SECRET_MESSAGE);

    // A single `shadow_planner` span is persisted with machine-readable enums
    // only — and the raw user message is nowhere in the persisted span.
    const spans = listChatV2TraceSpansForTurn(input.chatRequestId, db);
    const plannerSpan = spans.find((s) => s.name === 'shadow_planner');
    expect(plannerSpan).toBeDefined();
    expect(plannerSpan?.kind).toBe('model');
    expect(plannerSpan?.status).toBe('success');
    expect(plannerSpan?.attributes?.schemaValid).toBe(true);
    expect(plannerSpan?.attributes?.outcome).toBe('valid');
    expect(JSON.stringify(plannerSpan)).not.toContain(SECRET_MESSAGE);

    // The slot was released (no leaked concurrency).
    const snapshot = getLocalInferenceGateSnapshot(PLANNER_ON_ENV);
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.queuedCount).toBe(0);
  });

  it('returns synchronously BEFORE a deliberately-slow Ollama resolves (proves non-blocking)', async () => {
    let releaseOllama: (() => void) | undefined;
    let dispatchStarted = false;
    dispatchLocalReasoning.mockImplementation(
      () =>
        new Promise<{ text: string }>((resolve) => {
          dispatchStarted = true;
          releaseOllama = () => resolve({ text: validPlanJson() });
        }),
    );

    const { input, getSettled } = baseInput(db, PLANNER_ON_ENV);

    const before = Date.now();
    const result = runChatCoreV2ShadowRouteHook(input);
    const elapsed = Date.now() - before;

    // The hook returned its full result synchronously while the (slow) Ollama
    // call is still pending — the live caller never blocked on it.
    expect(result.recorded).toBe(true);
    expect(result.result?.wouldExecute).toBe(false);
    expect(elapsed).toBeLessThan(200);

    // No planner span yet: the background task is still awaiting the slow model.
    expect(
      listChatV2TraceSpansForTurn(input.chatRequestId, db).some((s) => s.name === 'shadow_planner'),
    ).toBe(false);

    // Let the background task complete now and assert it eventually settles.
    const settled = getSettled();
    expect(settled).toBeDefined();
    // Flush the microtask queue so the dispatch has actually started.
    await Promise.resolve();
    expect(dispatchStarted).toBe(true);
    releaseOllama?.();
    await settled;

    const plannerSpan = listChatV2TraceSpansForTurn(input.chatRequestId, db).find(
      (s) => s.name === 'shadow_planner',
    );
    expect(plannerSpan).toBeDefined();
    expect(plannerSpan?.attributes?.schemaValid).toBe(true);
  });
});
