// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetChatCoreV2RuntimeOverridesForTests,
  setChatCoreV2RuntimeOverride,
} from '../../src/services/chat-core-v2/activation-flags';
import {
  CHAT_CORE_V2_UNSUPPORTED_FALLBACK_MIN_CONFIDENCE,
  CHAT_CORE_V2_UNSUPPORTED_FALLBACK_RESPONSE_VERSION,
  buildChatCoreV2UnsupportedFallbackResponse,
  evaluateChatCoreV2UnsupportedFallback,
} from '../../src/services/chat-core-v2/chat-core-v2-unsupported-fallback-response';

describe('Chat Core v2 unsupported fallback response (WP-20)', () => {
  afterEach(() => {
    _resetChatCoreV2RuntimeOverridesForTests();
  });

  it('builds a pure locale-aware unsupported response without model inputs', () => {
    const response = buildChatCoreV2UnsupportedFallbackResponse({
      locale: 'pt-PT',
      decisionReason: 'legacy_fallback_disabled',
      routeGuess: {
        intent: 'unsafe_or_disallowed',
        confidence: 0.96,
        domains: ['finance'],
        capabilityIds: ['finance.payment_or_tax_action_blocked'],
        unsupportedReason: 'restricted_domain',
      },
    });

    expect(response.kind).toBe('unsupported');
    expect(response.locale).toBe('pt-PT');
    expect(response.text).toMatch(/revis[aã]o manual/i);
    expect(response.reasonCodes).toEqual([
      'legacy_fallback_disabled',
      'restricted_domain',
      CHAT_CORE_V2_UNSUPPORTED_FALLBACK_RESPONSE_VERSION,
    ]);
  });

  it('is inert by default and when the master mode is off', () => {
    const defaultEval = evaluateChatCoreV2UnsupportedFallback({
      normalizedText: 'delete all my tasks',
      tenantId: 'tenant-a',
      env: {},
    });
    const offEval = evaluateChatCoreV2UnsupportedFallback({
      normalizedText: 'delete all my tasks',
      tenantId: 'tenant-a',
      env: {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
        CHAT_CORE_V2_LEGACY_FALLBACK_DISABLED: 'true',
        CHAT_CORE_V2_LEGACY_FALLBACK_DISABLED_TENANTS: 'tenant-a',
      },
    });

    expect(defaultEval.response).toBeNull();
    expect(defaultEval.legacyFallbackDisabled).toBe(false);
    expect(offEval.response).toBeNull();
    expect(offEval.legacyFallbackDisabled).toBe(false);
  });

  it('disables legacy fallback for one tenant without starving another', () => {
    const env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      CHAT_CORE_V2_LEGACY_FALLBACK_DISABLED: 'true',
      CHAT_CORE_V2_LEGACY_FALLBACK_DISABLED_TENANTS: 'tenant-a',
    };

    const tenantA = evaluateChatCoreV2UnsupportedFallback({
      normalizedText: 'what is my task and finance status?',
      tenantId: 'tenant-a',
      env,
    });
    const tenantB = evaluateChatCoreV2UnsupportedFallback({
      normalizedText: 'what is my task and finance status?',
      tenantId: 'tenant-b',
      env,
    });

    expect(tenantA.legacyFallbackDisabled).toBe(true);
    expect(tenantA.decisionReason).toBe('legacy_fallback_disabled');
    expect(tenantA.response?.reasonCodes).toContain('legacy_fallback_disabled');
    expect(tenantB.legacyFallbackDisabled).toBe(false);
    expect(tenantB.response).toBeNull();
  });

  it('honors a per-tenant runtime override without touching neighboring tenants', () => {
    setChatCoreV2RuntimeOverride('tenant-b', { legacyFallbackDisabled: true });

    const env = { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on' };
    expect(evaluateChatCoreV2UnsupportedFallback({
      normalizedText: 'what is my task status?',
      tenantId: 'tenant-a',
      env,
    }).response).toBeNull();
    expect(evaluateChatCoreV2UnsupportedFallback({
      normalizedText: 'what is my task status?',
      tenantId: 'tenant-b',
      env,
    }).decisionReason).toBe('legacy_fallback_disabled');
  });

  it('returns an unsupported response for high-confidence v2 misses in active modes', () => {
    const result = evaluateChatCoreV2UnsupportedFallback({
      normalizedText: 'delete all my tasks',
      tenantId: 'tenant-a',
      env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' },
    });

    expect(result.routeGuess.confidence).toBeGreaterThanOrEqual(CHAT_CORE_V2_UNSUPPORTED_FALLBACK_MIN_CONFIDENCE);
    expect(result.decisionReason).toBe('high_confidence_v2_unsupported');
    expect(result.response?.kind).toBe('unsupported');
    expect(result.response?.reasonCodes).toContain('unsafe_action');
  });

  it('logs multi-domain app-question leaks but does not block the legacy route at the 0.85 gate', () => {
    const result = evaluateChatCoreV2UnsupportedFallback({
      normalizedText: 'what are my tasks and notifications today?',
      tenantId: 'tenant-a',
      env: { CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' },
    });

    expect(result.routeGuess.intent).toBe('app_question');
    expect(result.routeGuess.confidence).toBeLessThan(CHAT_CORE_V2_UNSUPPORTED_FALLBACK_MIN_CONFIDENCE);
    expect(result.readIntentLeakedToLegacy).toBe(true);
    expect(result.response).toBeNull();
  });
});
