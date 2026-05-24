import { describe, expect, it } from 'vitest';

import {
  CHAT_CORE_V2_CAPABILITIES,
  CHAT_CORE_V2_REASONING_POLICIES,
  GENERIC_JSON_PROVIDER_CAPABILITIES,
  OPENAI_RESPONSES_PROVIDER_CAPABILITIES,
  getChatCoreV2Capabilities,
  isChatCoreV2CapabilityEnabled,
  listEnabledChatCoreV2Capabilities,
  listChatCoreV2ExecutableCapabilities,
  listChatCoreV2ModelVisibleCapabilities,
  requiresBackendSchemaRetry,
  type ChatCoreV2Domain,
} from '../../src/services/chat-core-v2';

const ALL_DOMAINS: ChatCoreV2Domain[] = [
  'secretary',
  'tasks',
  'training',
  'content',
  'cooking',
  'finance',
  'connections',
  'notifications',
  'decision_center',
];

describe('Chat Core v2 foundation contracts', () => {
  it('keeps one deterministic read capability for every product domain in the MVP', () => {
    const capabilities = getChatCoreV2Capabilities();

    for (const domain of ALL_DOMAINS) {
      expect(
        capabilities.some((capability) =>
          capability.domain === domain
          && capability.rolloutStage === 'mvp_read'
          && capability.routeMethods.includes('deterministic_read')
          && capability.support.read === 'supported'),
        `${domain} is missing its MVP read model capability`,
      ).toBe(true);
    }
  });

  it('limits executable write MVP to low-risk Tasks, Notifications, and Decision Center capabilities', () => {
    const executable = listChatCoreV2ExecutableCapabilities();
    const executableDomains = new Set(executable.map((capability) => capability.domain));

    expect(executableDomains).toEqual(new Set(['tasks', 'notifications', 'decision_center']));
    for (const capability of executable) {
      expect(capability.rolloutStage, capability.capabilityId).toBe('mvp_confirmed_write');
      expect(capability.risk, capability.capabilityId).toBe('low');
      expect(capability.confirmationPolicy, capability.capabilityId).toBe('always_confirm_v1');
      expect(capability.verificationMode, capability.capabilityId).toBe('immediate_read_back');
      expect(capability.undoPolicy.supported, capability.capabilityId).toBe(true);
      expect(capability.previewCardType, capability.capabilityId).toMatch(/@1\.0\.0$/);
    }
  });

  it('keeps medium-risk and sensitive domains preview-only or blocked until later rollout gates', () => {
    const byId = new Map(CHAT_CORE_V2_CAPABILITIES.map((capability) => [capability.capabilityId, capability]));

    expect(byId.get('secretary.schedule_event_preview')?.support.execute).toBe('preview_only');
    expect(byId.get('training.modify_session_preview')?.support.execute).toBe('preview_only');
    expect(byId.get('training.modify_session_preview')?.sensitivity).toBe('health_adjacent');
    expect(byId.get('finance.payment_or_tax_action_blocked')?.support.execute).toBe('blocked');
    expect(byId.get('finance.payment_or_tax_action_blocked')?.risk).toBe('restricted');
    expect(byId.get('finance.payment_or_tax_action_blocked')?.modelVisible).toBe(false);
    expect(byId.get('finance.payment_or_tax_action_blocked')?.fallbackAllowed).toBe(false);
  });

  it('requires every model-visible capability to have versioned schemas, flags, permissions, and a prompt family', () => {
    for (const capability of listChatCoreV2ModelVisibleCapabilities()) {
      expect(capability.schemaVersion, capability.capabilityId).toMatch(/^chat_core_v2_capability@\d+\.\d+\.\d+$/);
      expect(capability.toolSchemaSetVersion, capability.capabilityId).toMatch(/^chat_core_v2_tools@\d+\.\d+\.\d+$/);
      expect(capability.enabledFlags, capability.capabilityId).toContain('CHAT_CORE_V2_ENABLED');
      expect(capability.requiredPermissions.length, capability.capabilityId).toBeGreaterThan(0);
      expect(capability.promptFamily, capability.capabilityId).toMatch(/^chat_v2_/);
    }
  });

  it('keeps live capability availability default-off and scoped by registry flags', () => {
    expect(listEnabledChatCoreV2Capabilities({ env: {} })).toEqual([]);
    expect(isChatCoreV2CapabilityEnabled('tasks.today_summary', { env: {} })).toBe(false);
    expect(isChatCoreV2CapabilityEnabled('unknown.capability', {
      env: { CHAT_CORE_V2_ENABLED: 'true' },
    })).toBe(false);

    const enabled = listEnabledChatCoreV2Capabilities({
      env: { CHAT_CORE_V2_ENABLED: 'true' },
    });
    expect(enabled.map((capability) => capability.capabilityId)).toEqual(
      getChatCoreV2Capabilities().map((capability) => capability.capabilityId),
    );
    expect(isChatCoreV2CapabilityEnabled('tasks.today_summary', {
      env: {
        CHAT_CORE_V2_ENABLED: 'false',
        CHAT_CORE_V2_ENABLED_TENANT_9: '1',
      },
      scope: { userId: 7, tenantId: 9 },
    })).toBe(true);
    expect(isChatCoreV2CapabilityEnabled('tasks.today_summary', {
      env: {
        CHAT_CORE_V2_ENABLED: 'true',
        CHAT_CORE_V2_ENABLED_USER_42: 'off',
      },
      scope: { userId: 42, tenantId: 9 },
    })).toBe(false);
  });

  it('keeps deterministic reads at zero model calls and bounds planner tiers with explicit budgets', () => {
    expect(CHAT_CORE_V2_REASONING_POLICIES.none.budget.maxModelCalls).toBe(0);
    expect(CHAT_CORE_V2_REASONING_POLICIES.none.allowWriteProposal).toBe(false);
    expect(CHAT_CORE_V2_REASONING_POLICIES.fast_extraction.budget.maxModelCalls).toBe(1);
    expect(CHAT_CORE_V2_REASONING_POLICIES.standard_command.allowWriteProposal).toBe(true);
    expect(CHAT_CORE_V2_REASONING_POLICIES.planner.allowMultiStepPlan).toBe(true);
    expect(CHAT_CORE_V2_REASONING_POLICIES.deep_planner.requiresHumanReview).toBe(true);
    expect(CHAT_CORE_V2_REASONING_POLICIES.background_planner.allowBackground).toBe(true);

    for (const policy of Object.values(CHAT_CORE_V2_REASONING_POLICIES)) {
      expect(policy.policyVersion).toMatch(/^chat_core_v2_reasoning_policy@\d+\.\d+\.\d+$/);
      expect(policy.budget.maxWallClockMs, policy.tier).toBeGreaterThan(0);
      expect(policy.budget.maxCostUsd, policy.tier).toBeGreaterThanOrEqual(0);
    }
  });

  it('records provider capability differences instead of hiding them behind a generic LLM interface', () => {
    expect(OPENAI_RESPONSES_PROVIDER_CAPABILITIES.supportsStrictStructuredOutputs).toBe(true);
    expect(OPENAI_RESPONSES_PROVIDER_CAPABILITIES.supportsFunctionCalling).toBe(true);
    expect(OPENAI_RESPONSES_PROVIDER_CAPABILITIES.supportsProviderStateOptOut).toBe(true);
    expect(requiresBackendSchemaRetry(OPENAI_RESPONSES_PROVIDER_CAPABILITIES)).toBe(false);

    expect(GENERIC_JSON_PROVIDER_CAPABILITIES.supportsStrictStructuredOutputs).toBe(false);
    expect(requiresBackendSchemaRetry(GENERIC_JSON_PROVIDER_CAPABILITIES)).toBe(true);
  });
});
