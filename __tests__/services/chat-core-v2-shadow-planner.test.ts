// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  planChatCoreV2ShadowTurn,
  planChatCoreV2ShadowTurnWithPlanner,
  type ChatCoreV2ShadowRunPlanner,
  type ChatCoreV2ShadowTurnInput,
} from '../../src/services/chat-core-v2/shadow-orchestrator';
import {
  _resetChatCoreV2RuntimeOverridesForTests,
  setChatCoreV2RuntimeOverride,
} from '../../src/services/chat-core-v2/activation-flags';
import { type UltraCompactPlannerPacket } from '../../src/services/chat-core-v2/plan-schema';
import type { ChatV2TraceSpan } from '../../src/services/chat-core-v2/types';

const BASE: ChatCoreV2ShadowTurnInput = {
  turnId: 'turn_shadow_planner_1',
  tenantId: 'tenant_1',
  userId: 'user_1',
  intent: 'create_action',
  confidence: 0.91,
  domains: ['tasks'],
  capabilityIds: ['tasks.create'],
  now: new Date('2026-05-30T10:00:00.000Z'),
};

const SECRET = 'SUPER_SECRET_USER_MESSAGE_98765';

/**
 * A valid WIRE-shape planner response. The shadow orchestrator now drives the
 * PROVEN wire method (doctrine #10): the planner emits the tiny wire object and
 * parseAndValidateChatTurnPlanMicroWireJson(raw, packet) expands it against the
 * bound packet. `h` is omitted so the wire parser defaults contextHash to the
 * packet's contextHash (auto-matching the staleness guard). Required wire keys:
 * v, i, cf, x. We use i='r' (read) which needs no candidate to be schema-valid.
 */
function validWirePlanJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    i: 'r',
    cf: 0.9,
    x: 0.2,
    ...overrides,
  });
}

function plannerSpan(spans: ChatV2TraceSpan[]): ChatV2TraceSpan | undefined {
  return spans.find((span) => span.name === 'shadow_planner');
}

/** Recursively assert that no part of a span carries the raw secret text. */
function assertNoSecretLeak(span: ChatV2TraceSpan): void {
  const serialized = JSON.stringify(span);
  expect(serialized).not.toContain(SECRET);
}

describe('planChatCoreV2ShadowTurnWithPlanner', () => {
  afterEach(() => {
    _resetChatCoreV2RuntimeOverridesForTests();
  });

  it('appends a shadow_planner span with schemaValid true when the planner returns a valid WIRE plan', async () => {
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>(async () => validWirePlanJson());

    const result = await planChatCoreV2ShadowTurnWithPlanner(BASE, { runPlanner });

    const span = plannerSpan(result.traceSpans);
    expect(span).toBeDefined();
    expect(span?.kind).toBe('model');
    expect(span?.status).toBe('success');
    expect(span?.attributes?.schemaValid).toBe(true);
    expect(span?.attributes?.outcome).toBe('valid');
    expect(span?.attributes?.attemptsUsed).toBe(0);
    expect(span?.attributes?.issueCodeCount).toBe(0);
    expect(runPlanner).toHaveBeenCalledTimes(1);
    // The injected callback received a bounded, text-free packet.
    const packet = runPlanner.mock.calls[0][0] as UltraCompactPlannerPacket;
    expect(packet.candidates).toContain('tasks.create');
    expect(packet.msg).toBe('shadow_observe_only');
  });

  it('reports outcome "repaired" when the first output is invalid and the repair returns a valid WIRE plan', async () => {
    // First call (initial planner) -> invalid; second call (repair) -> valid wire.
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>()
      .mockResolvedValueOnce('{"not":"a valid plan"}')
      .mockResolvedValueOnce(validWirePlanJson());

    const result = await planChatCoreV2ShadowTurnWithPlanner(BASE, { runPlanner });

    const span = plannerSpan(result.traceSpans);
    expect(span).toBeDefined();
    expect(span?.status).toBe('success');
    expect(span?.attributes?.schemaValid).toBe(true);
    expect(span?.attributes?.outcome).toBe('repaired');
    expect(span?.attributes?.attemptsUsed).toBe(1);
    // One initial call + exactly one bounded repair attempt.
    expect(runPlanner).toHaveBeenCalledTimes(2);
  });

  it('reports outcome "unrepairable" with schemaValid false when both passes are invalid', async () => {
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>(async () => '{"still":"invalid"}');

    const result = await planChatCoreV2ShadowTurnWithPlanner(BASE, { runPlanner });

    const span = plannerSpan(result.traceSpans);
    expect(span).toBeDefined();
    expect(span?.status).toBe('success');
    expect(span?.attributes?.schemaValid).toBe(false);
    expect(span?.attributes?.outcome).toBe('unrepairable');
    expect(span?.attributes?.issueCodeCount).toBeGreaterThan(0);
  });

  it('records a failed shadow_planner span and never throws when the planner throws', async () => {
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>(async () => {
      throw new Error('ollama unavailable');
    });

    const result = await planChatCoreV2ShadowTurnWithPlanner(BASE, { runPlanner });

    const span = plannerSpan(result.traceSpans);
    expect(span).toBeDefined();
    expect(span?.status).toBe('failed');
    expect(span?.attributes?.schemaValid).toBe(false);
    expect(span?.attributes?.outcome).toBe('unrepairable');
    expect(span?.attributes?.reasonCode).toBe('planner_threw');
    // The planner is called exactly once on the throwing path (no repair attempt).
    expect(runPlanner).toHaveBeenCalledTimes(1);
    // The raw error message never reaches the span.
    expect(JSON.stringify(span)).not.toContain('ollama unavailable');
  });

  it('honors plannerPinnedToRepairOnly by skipping fresh planner generation for that tenant', async () => {
    setChatCoreV2RuntimeOverride(BASE.tenantId, { plannerPinnedToRepairOnly: true });
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>(async () => {
      throw new Error('planner should not run while pinned');
    });

    const result = await planChatCoreV2ShadowTurnWithPlanner(BASE, { runPlanner });

    const span = plannerSpan(result.traceSpans);
    expect(runPlanner).not.toHaveBeenCalled();
    expect(span).toBeDefined();
    expect(span?.kind).toBe('model');
    expect(span?.status).toBe('skipped');
    expect(span?.attributes?.schemaValid).toBe(false);
    expect(span?.attributes?.outcome).toBe('skipped');
    expect(span?.attributes?.reasonCode).toBe('planner_pinned_to_repair_only');
    expect(span?.attributes?.attemptsUsed).toBe(0);
    expect(span?.attributes?.issueCodeCount).toBe(0);
    assertNoSecretLeak(span!);
  });

  it('is byte-identical to planChatCoreV2ShadowTurn when no planner is injected (DEFAULT-OFF)', async () => {
    const sync = planChatCoreV2ShadowTurn(BASE);
    const withPlanner = await planChatCoreV2ShadowTurnWithPlanner(BASE);
    const withEmptyDeps = await planChatCoreV2ShadowTurnWithPlanner(BASE, {});

    // No extra span, same trace bytes, same result.
    expect(plannerSpan(withPlanner.traceSpans)).toBeUndefined();
    expect(plannerSpan(withEmptyDeps.traceSpans)).toBeUndefined();
    expect(JSON.stringify(withPlanner)).toBe(JSON.stringify(sync));
    expect(JSON.stringify(withEmptyDeps)).toBe(JSON.stringify(sync));
  });

  it('never lets raw user/model text reach any span attribute or redactedSummary', async () => {
    // The planner echoes the secret into BOTH passes; the orchestrator must
    // never surface that raw text on the recorded span.
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>(async () => `{"echo":"${SECRET}"}`);

    const result = await planChatCoreV2ShadowTurnWithPlanner(
      { ...BASE, message: SECRET },
      { runPlanner },
    );

    const span = plannerSpan(result.traceSpans);
    expect(span).toBeDefined();
    assertNoSecretLeak(span!);
    // redactedSummary is the safe name:status marker only.
    expect(span?.redactedSummary).toBe('shadow_planner:success');
    // No span in the whole bundle leaks the secret either.
    for (const s of result.traceSpans) {
      assertNoSecretLeak(s);
    }
    // And the message text never reached the injected packet.
    const packet = runPlanner.mock.calls[0][0] as UltraCompactPlannerPacket;
    expect(JSON.stringify(packet)).not.toContain(SECRET);
  });

  it('preserves the base trace spans and appends the planner span last', async () => {
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>(async () => validWirePlanJson());

    const base = planChatCoreV2ShadowTurn(BASE);
    const result = await planChatCoreV2ShadowTurnWithPlanner(BASE, { runPlanner });

    // Every original span is preserved, byte-identical, in order.
    expect(result.traceSpans.slice(0, base.traceSpans.length)).toEqual(base.traceSpans);
    // The planner span is the single appended trailing span.
    expect(result.traceSpans).toHaveLength(base.traceSpans.length + 1);
    expect(result.traceSpans[result.traceSpans.length - 1].name).toBe('shadow_planner');
    // The rest of the result (route decision, verdicts, flags) is unchanged.
    expect(result.routeDecision).toEqual(base.routeDecision);
    expect(result.fallbackVerdict).toEqual(base.fallbackVerdict);
    expect(result.wouldExecute).toBe(false);
  });

  // ── PROVEN WIRE METHOD (doctrine #10) — packet-bound wire parser ──────────
  it('expands a candidate-index WIRE plan against the bound packet (read with c index)', async () => {
    // i='r' + c=[0] references candidate index 0, which the wire parser must
    // expand to packet.candidates[0] using THIS turn's packet (not the canonical
    // full schema). A valid expansion => outcome valid, schemaValid true.
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>(
      async (packet) => {
        // Sanity: the packet is the bounded text-free shadow packet.
        expect(packet.candidates.length).toBeGreaterThan(0);
        return validWirePlanJson({ i: 'r', c: [0], r: [0] });
      },
    );

    const result = await planChatCoreV2ShadowTurnWithPlanner(BASE, { runPlanner });

    const span = plannerSpan(result.traceSpans);
    expect(span?.attributes?.schemaValid).toBe(true);
    expect(span?.attributes?.outcome).toBe('valid');
    expect(span?.attributes?.issueCodeCount).toBe(0);
  });

  it('reports unrepairable when the WIRE plan is garbage in both passes (parser bound to packet)', async () => {
    // Full-canonical JSON is NOT valid wire JSON: the wire parser rejects the
    // canonical top-level keys. This proves the orchestrator now validates via
    // the WIRE parser, not the canonical one.
    const canonicalNotWire = JSON.stringify({
      schemaVersion: 'chat_turn_plan_micro@1.0.0',
      intent: 'read',
      domains: ['tasks'],
      capabilityIds: ['tasks.today_summary'],
      requiredReads: [],
      proposedWrites: [],
      evidenceClaimIds: [],
      confidence: 0.9,
      complexityScore: 0.2,
      escalationReasons: [],
      contextHash: 'mismatched-ctx',
      promptVersion: 'chat_turn_plan_micro_prompt@0.1.0',
    });
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>(async () => canonicalNotWire);

    const result = await planChatCoreV2ShadowTurnWithPlanner(BASE, { runPlanner });

    const span = plannerSpan(result.traceSpans);
    expect(span?.status).toBe('success');
    expect(span?.attributes?.schemaValid).toBe(false);
    expect(span?.attributes?.outcome).toBe('unrepairable');
    expect(span?.attributes?.issueCodeCount).toBeGreaterThan(0);
    // Still no raw text on the span.
    assertNoSecretLeak(span!);
  });
});
