import { describe, expect, it } from 'vitest';

import {
  CHAT_CORE_V2_ROUTE_DECISION_VERSION,
  buildChatCoreV2RouteDecision,
} from '../../src/services/chat-core-v2';

describe('Chat Core v2 route decision contract', () => {
  it('routes deterministic app reads without an LLM and preserves secondary domains', () => {
    const decision = buildChatCoreV2RouteDecision({
      intent: 'app_question',
      confidence: 0.96,
      domains: ['tasks', 'finance'],
      capabilityIds: ['tasks.today_summary', 'finance.summary'],
    });

    expect(decision).toMatchObject({
      routeDecisionVersion: CHAT_CORE_V2_ROUTE_DECISION_VERSION,
      primaryDomain: 'tasks',
      secondaryDomains: ['finance'],
      routeMethod: 'deterministic_read',
      reasoningTier: 'none',
      requiresLLM: false,
      riskEstimate: 'low',
    });
    expect(decision.reasonCodes).toEqual(['multi_domain_context', 'deterministic_read_available']);
  });

  it('routes low-risk task writes through command translation with selected capability metadata', () => {
    const decision = buildChatCoreV2RouteDecision({
      intent: 'create_action',
      confidence: 0.9,
      domains: ['tasks'],
      capabilityIds: ['tasks.create'],
    });

    expect(decision).toMatchObject({
      primaryDomain: 'tasks',
      secondaryDomains: [],
      selectedCapabilityIds: ['tasks.create'],
      routeMethod: 'llm_command_translation',
      reasoningTier: 'fast_extraction',
      requiresLLM: true,
      riskEstimate: 'low',
    });
    expect(decision.reasonCodes).toContain('llm_required');
  });

  it('clarifies instead of guessing when confidence is low even if candidate domains exist', () => {
    const decision = buildChatCoreV2RouteDecision({
      intent: 'modify_action',
      confidence: 0.42,
      domains: ['training', 'secretary'],
      capabilityIds: ['training.modify_session_preview', 'secretary.schedule_event_preview'],
    });

    expect(decision.routeMethod).toBe('needs_clarification');
    expect(decision.requiresLLM).toBe(false);
    expect(decision.primaryDomain).toBe('training');
    expect(decision.secondaryDomains).toEqual(['secretary']);
    expect(decision.reasonCodes).toEqual(['multi_domain_context', 'low_confidence']);
  });

  it('uses planner routing for confident multi-domain planning without executing commands', () => {
    const decision = buildChatCoreV2RouteDecision({
      intent: 'planning',
      confidence: 0.82,
      domains: ['training', 'secretary', 'tasks'],
      capabilityIds: ['training.modify_session_preview', 'secretary.schedule_event_preview', 'tasks.today_summary'],
    });

    expect(decision).toMatchObject({
      primaryDomain: 'training',
      secondaryDomains: ['secretary', 'tasks'],
      routeMethod: 'planner',
      reasoningTier: 'planner',
      requiresLLM: true,
      riskEstimate: 'medium',
    });
    expect(decision.reasonCodes).toEqual(['multi_domain_context', 'planner_required']);
  });

  it('blocks restricted finance execution capabilities before model routing', () => {
    const decision = buildChatCoreV2RouteDecision({
      intent: 'modify_action',
      confidence: 0.99,
      domains: ['finance'],
      capabilityIds: ['finance.payment_or_tax_action_blocked'],
    });

    expect(decision).toMatchObject({
      primaryDomain: 'finance',
      routeMethod: 'blocked',
      riskEstimate: 'restricted',
      reasoningTier: 'none',
      requiresLLM: false,
      unsupportedReason: 'restricted_domain',
    });
    expect(decision.reasonCodes).toEqual(['restricted_capability', 'blocked_capability']);
  });

  it('reports unknown capabilities and stays unsupported instead of inventing a route', () => {
    const decision = buildChatCoreV2RouteDecision({
      intent: 'create_action',
      confidence: 0.8,
      domains: ['connections'],
      capabilityIds: ['connections.rotate_secret'],
    });

    expect(decision).toMatchObject({
      primaryDomain: 'connections',
      selectedCapabilityIds: [],
      routeMethod: 'unsupported',
      reasoningTier: 'none',
      requiresLLM: false,
      riskEstimate: 'low',
    });
    expect(decision.reasonCodes).toEqual(['unknown_capability']);
  });

  it('deduplicates domains while preserving user-facing routing order', () => {
    const decision = buildChatCoreV2RouteDecision({
      intent: 'app_question',
      confidence: 1.2,
      domains: ['tasks', 'tasks', 'notifications'],
      capabilityIds: ['tasks.today_summary', 'notifications.summary'],
    });

    expect(decision.confidence).toBe(1);
    expect(decision.primaryDomain).toBe('tasks');
    expect(decision.secondaryDomains).toEqual(['notifications']);
  });
});
