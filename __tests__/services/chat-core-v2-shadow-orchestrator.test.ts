import { describe, expect, it } from 'vitest';

import {
  CHAT_CORE_V2_EMPTY_TOOL_SCHEMA_SET_VERSION,
  CHAT_CORE_V2_SHADOW_ORCHESTRATOR_VERSION,
  planChatCoreV2ShadowTurn,
} from '../../src/services/chat-core-v2';

const BASE = {
  turnId: 'turn_shadow_1',
  tenantId: 'tenant_1',
  userId: 'user_1',
  now: new Date('2026-05-24T10:00:00.000Z'),
};

describe('Chat Core v2 shadow orchestrator', () => {
  it('plans deterministic reads without model calls, tools, or execution', () => {
    const result = planChatCoreV2ShadowTurn({
      ...BASE,
      intent: 'app_question',
      confidence: 0.95,
      domains: ['tasks'],
      capabilityIds: ['tasks.today_summary'],
    });

    expect(result.orchestratorVersion).toBe(CHAT_CORE_V2_SHADOW_ORCHESTRATOR_VERSION);
    expect(result.mode).toBe('shadow');
    expect(result.routeDecision.routeMethod).toBe('deterministic_read');
    expect(result.reasoningPolicy.tier).toBe('none');
    expect(result.wouldCallModel).toBe(false);
    expect(result.wouldExecute).toBe(false);
    expect(result.toolSchemaSet.toolSchemaSetVersion).toBe(CHAT_CORE_V2_EMPTY_TOOL_SCHEMA_SET_VERSION);
    expect(result.toolSchemaSet.tools).toEqual([]);
    expect(result.fallbackVerdict.allowed).toBe(true);
  });

  it('plans low-risk command translation with selected tools but never executes in shadow mode', () => {
    const result = planChatCoreV2ShadowTurn({
      ...BASE,
      intent: 'create_action',
      confidence: 0.91,
      domains: ['tasks'],
      capabilityIds: ['tasks.create'],
      oldPathHasEquivalentSafety: false,
    });

    expect(result.routeDecision.routeMethod).toBe('llm_command_translation');
    expect(result.routeDecision.requiresLLM).toBe(true);
    expect(result.wouldCallModel).toBe(true);
    expect(result.wouldExecute).toBe(false);
    expect(result.toolSchemaSet.tools).toHaveLength(1);
    expect(result.toolSchemaSet.tools[0].capabilityId).toBe('tasks.create');
    expect(result.fallbackVerdict.allowed).toBe(false);
    expect(result.fallbackVerdict.blockedBecause).toBe('write_without_equivalent_safety');
  });

  it('blocks restricted finance routes without exposing model tools', () => {
    const result = planChatCoreV2ShadowTurn({
      ...BASE,
      intent: 'unsafe_or_disallowed',
      confidence: 0.99,
      domains: ['finance'],
      capabilityIds: ['finance.payment_or_tax_action_blocked'],
      sensitivity: 'financial',
    });

    expect(result.routeDecision.routeMethod).toBe('unsupported');
    expect(result.routeDecision.unsupportedReason).toBe('unsafe_action');
    expect(result.toolSchemaSet.tools).toEqual([]);
    expect(result.fallbackVerdict.allowed).toBe(false);
    expect(result.traceSpans.every((span) => span.sensitivity === 'financial')).toBe(true);
    expect(result.traceSpans.every((span) => span.retentionPolicy === '30d')).toBe(true);
  });

  it('stops model calls when the runtime budget is already exceeded', () => {
    const result = planChatCoreV2ShadowTurn({
      ...BASE,
      intent: 'create_action',
      confidence: 0.9,
      domains: ['tasks'],
      capabilityIds: ['tasks.create'],
      runtimeUsage: {
        modelCalls: 2,
      },
    });

    expect(result.routeDecision.requiresLLM).toBe(true);
    expect(result.budgetVerdict.ok).toBe(false);
    expect(result.budgetVerdict.limit).toBe('model_calls');
    expect(result.wouldCallModel).toBe(false);
    expect(result.traceSpans.find((span) => span.kind === 'budget')?.status).toBe('blocked');
  });

  it('caps planner tool schemas and reports omitted capabilities', () => {
    const result = planChatCoreV2ShadowTurn({
      ...BASE,
      intent: 'planning',
      confidence: 0.88,
      domains: ['tasks', 'training'],
      capabilityIds: ['tasks.create', 'training.modify_session_preview'],
      maxToolSchemas: 1,
    });

    expect(result.routeDecision.routeMethod).toBe('planner');
    expect(result.toolSchemaSet.tools).toHaveLength(1);
    expect(result.toolSchemaSet.tools[0].capabilityId).toBe('tasks.create');
    expect(result.toolSchemaSet.omittedCapabilities).toEqual([
      { capabilityId: 'training.modify_session_preview', reason: 'tool_limit' },
    ]);
  });
});
