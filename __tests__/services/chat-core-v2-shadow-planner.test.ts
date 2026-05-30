// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it, vi } from 'vitest';

import {
  planChatCoreV2ShadowTurn,
  planChatCoreV2ShadowTurnWithPlanner,
  type ChatCoreV2ShadowRunPlanner,
  type ChatCoreV2ShadowTurnInput,
} from '../../src/services/chat-core-v2/shadow-orchestrator';
import {
  CHAT_TURN_PLAN_MICRO_PROMPT_VERSION,
  CHAT_TURN_PLAN_MICRO_SCHEMA_VERSION,
  type ChatTurnPlanMicro,
  type UltraCompactPlannerPacket,
} from '../../src/services/chat-core-v2/plan-schema';
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

function validPlan(overrides: Partial<ChatTurnPlanMicro> = {}): ChatTurnPlanMicro {
  return {
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
  };
}

function validPlanJson(overrides: Partial<ChatTurnPlanMicro> = {}): string {
  return JSON.stringify(validPlan(overrides));
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
  it('appends a shadow_planner span with schemaValid true when the planner returns valid JSON', async () => {
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>(async () => validPlanJson());

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

  it('reports outcome "repaired" when the first output is invalid and the repair returns valid JSON', async () => {
    // First call (initial planner) -> invalid; second call (repair) -> valid.
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>()
      .mockResolvedValueOnce('{"not":"a valid plan"}')
      .mockResolvedValueOnce(validPlanJson());

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
    const runPlanner = vi.fn<ChatCoreV2ShadowRunPlanner>(async () => validPlanJson());

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
});
