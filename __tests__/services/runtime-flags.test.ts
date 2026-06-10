// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  areGlobalInvoiceVendorsEnabled,
  canUseAnthropicRuntimeFallback,
  getAICallTimeoutMs,
  getChatHybridPlannerMode,
  getDomainProviderExperimentOverrides,
  getGeminiDomainAllowlist,
  getGeminiIncludeSecretaryEnvOverride,
  getGeminiRoutingEnvOverride,
  isChatEscalationReviewerEnabled,
  isChatBilingualEvalGateEnabled,
  isChatContextCompilerEnabled,
  isChatCoreV2Enabled,
  isChatCoreV2RuntimeFlagEnabled,
  isChatHybridPlannerEnabled,
  isChatLlmTier1Enabled,
  isChatLlmTier2Enabled,
  isChatOpenSurfaceHandoffEnabled,
  isChatQualityGateEnabled,
  isChatResearchRouterEnabled,
  isChatSkillResponsePolicyEnabled,
  isChatTurnContractEnabled,
  isContentDeepResearchDisabled,
  isContentForceDraftOnlyEnabled,
  isContentFreshResearchDisabled,
  isContentFullLongformDisabled,
  isContentModelQualityAuditDisabled,
  isDecisionCenterFatigueCapsEnabled,
  isDecisionCenterCommandBusEnabled,
  isDecisionCenterGuidanceSkillEnabled,
  isDecisionCenterGuidanceV1Enabled,
  isDecisionChoiceOptionsEnabled,
  isDecisionFeedbackSuppressionEnabled,
  isDecisionHumanReviewGateEnabled,
  isDecisionReconnectAffordanceEnabled,
  isDecisionSemanticDedupEnabled,
  isDecisionSemanticSupersedeEnabled,
  isDecisionTypeSuppressionEnabled,
  isDecisionSkillCardsEnabled,
  isAnthropicRuntimeEnabled,
  isChatCoreV2ShadowRouteHookEnabled,
  isSecretaryHaikuRoutingEnabled,
  isTelegramLegacyDeliveryEnabled,
} from '../../src/services/runtime-flags';

describe('runtime-flags', () => {
  it('treats only literal true as enabled for anthropic and telegram runtime flags', () => {
    expect(isAnthropicRuntimeEnabled({ ANTHROPIC_ENABLED: 'true' })).toBe(true);
    expect(isAnthropicRuntimeEnabled({ ANTHROPIC_ENABLED: 'yes' })).toBe(false);
    expect(isAnthropicRuntimeEnabled({})).toBe(false);

    expect(isTelegramLegacyDeliveryEnabled({ TELEGRAM_LEGACY_DELIVERY: 'true' })).toBe(true);
    expect(isTelegramLegacyDeliveryEnabled({ TELEGRAM_LEGACY_DELIVERY: '1' })).toBe(false);
    expect(isTelegramLegacyDeliveryEnabled({})).toBe(false);

    expect(areGlobalInvoiceVendorsEnabled({ FISCAL_ENABLE_GLOBAL_BUILTIN_VENDORS: 'true' })).toBe(true);
    expect(areGlobalInvoiceVendorsEnabled({ FISCAL_ENABLE_GLOBAL_BUILTIN_VENDORS: '1' })).toBe(false);
    expect(areGlobalInvoiceVendorsEnabled({})).toBe(false);
  });

  it('requires both runtime enablement and an api key for anthropic fallback use', () => {
    expect(
      canUseAnthropicRuntimeFallback({ ANTHROPIC_ENABLED: 'true', ANTHROPIC_API_KEY: 'key' }),
    ).toBe(true);
    expect(
      canUseAnthropicRuntimeFallback({ ANTHROPIC_ENABLED: 'true', ANTHROPIC_API_KEY: '' }),
    ).toBe(false);
    expect(
      canUseAnthropicRuntimeFallback({ ANTHROPIC_ENABLED: 'false', ANTHROPIC_API_KEY: 'key' }),
    ).toBe(false);
  });

  it('parses ai timeout defensively and falls back for invalid values', () => {
    expect(getAICallTimeoutMs({ AI_CALL_TIMEOUT_MS: '45000' })).toBe(45000);
    expect(getAICallTimeoutMs({ AI_CALL_TIMEOUT_MS: '0' })).toBe(30000);
    expect(getAICallTimeoutMs({ AI_CALL_TIMEOUT_MS: 'not-a-number' })).toBe(30000);
    expect(getAICallTimeoutMs({})).toBe(30000);
  });

  it('parses gemini routing overrides and domain allowlist consistently', () => {
    expect(getGeminiRoutingEnvOverride({ GEMINI_ROUTING_ENABLED: 'true' })).toBe(true);
    expect(getGeminiRoutingEnvOverride({ GEMINI_ROUTING_ENABLED: 'false' })).toBe(false);
    expect(getGeminiRoutingEnvOverride({ GEMINI_ROUTING_ENABLED: 'maybe' })).toBeNull();
    expect(getGeminiIncludeSecretaryEnvOverride({ GEMINI_INCLUDE_SECRETARY: 'true' })).toBe(true);
    expect(getGeminiIncludeSecretaryEnvOverride({ GEMINI_INCLUDE_SECRETARY: 'nope' })).toBeNull();
    expect(
      getGeminiDomainAllowlist({ GEMINI_DOMAINS: 'triathlon, content , finance,, cooking ' }),
    ).toEqual(['triathlon', 'content', 'finance', 'cooking']);
    expect(
      getDomainProviderExperimentOverrides({ AI_DOMAIN_PROVIDER_OVERRIDES: 'cooking=openai, finance = openai, broken, content=gemini' }),
    ).toEqual({ cooking: 'openai', finance: 'openai', content: 'gemini' });
  });

  it('treats secretary haiku routing as an explicit opt-in only', () => {
    expect(isSecretaryHaikuRoutingEnabled({ SECRETARY_HAIKU_ROUTING_ENABLED: 'true' })).toBe(true);
    expect(isSecretaryHaikuRoutingEnabled({ SECRETARY_HAIKU_ROUTING_ENABLED: 'false' })).toBe(false);
    expect(isSecretaryHaikuRoutingEnabled({})).toBe(false);
  });

  it('enables Decision Center guidance by default with scoped rollback overrides', () => {
    expect(isDecisionCenterGuidanceV1Enabled({})).toBe(true);
    expect(isDecisionCenterGuidanceV1Enabled({ DECISION_CENTER_GUIDANCE_V1_ENABLED: 'false' })).toBe(false);
    expect(isDecisionCenterGuidanceV1Enabled({
      DECISION_CENTER_GUIDANCE_V1_ENABLED: 'true',
      DECISION_CENTER_GUIDANCE_V1_ENABLED_USER_42: 'off',
    }, { userId: 42, tenantId: 42 })).toBe(false);
    expect(isDecisionCenterGuidanceV1Enabled({
      DECISION_CENTER_GUIDANCE_V1_ENABLED: 'false',
      DECISION_CENTER_GUIDANCE_V1_ENABLED_TENANT_9: 'true',
    }, { userId: 7, tenantId: 9 })).toBe(true);
  });

  it('allows Decision Center guidance to be rolled back per skill and scope', () => {
    expect(isDecisionCenterGuidanceSkillEnabled('secretary', {})).toBe(true);
    expect(isDecisionCenterGuidanceSkillEnabled('content', {
      DECISION_CENTER_GUIDANCE_V1_CONTENT_ENABLED: 'off',
    })).toBe(false);
    expect(isDecisionCenterGuidanceSkillEnabled('finance-review', {
      DECISION_CENTER_GUIDANCE_V1_FINANCE_REVIEW_ENABLED: 'true',
      DECISION_CENTER_GUIDANCE_V1_FINANCE_REVIEW_ENABLED_TENANT_9: '0',
    }, { userId: 7, tenantId: 9 })).toBe(false);
  });

  it('keeps Decision Center Command Bus default-off with scoped opt-in', () => {
    expect(isDecisionCenterCommandBusEnabled({})).toBe(false);
    expect(isDecisionCenterCommandBusEnabled({ DECISION_CENTER_COMMAND_BUS_ENABLED: 'true' })).toBe(true);
    expect(isDecisionCenterCommandBusEnabled({ DECISION_CENTER_COMMAND_BUS_ENABLED: 'on' })).toBe(true);
    expect(isDecisionCenterCommandBusEnabled({ DECISION_CENTER_COMMAND_BUS_ENABLED: '1' })).toBe(true);
    expect(isDecisionCenterCommandBusEnabled({ DECISION_CENTER_COMMAND_BUS_ENABLED: 'shadow' })).toBe(false);
    expect(isDecisionCenterCommandBusEnabled({
      DECISION_CENTER_COMMAND_BUS_ENABLED: 'false',
      DECISION_CENTER_COMMAND_BUS_ENABLED_TENANT_9: 'enabled',
    }, { userId: 7, tenantId: 9 })).toBe(true);
    expect(isDecisionCenterCommandBusEnabled({
      DECISION_CENTER_COMMAND_BUS_ENABLED: 'true',
      DECISION_CENTER_COMMAND_BUS_ENABLED_USER_42: 'off',
    }, { userId: 42, tenantId: 9 })).toBe(false);
  });

  it('parses chat hybrid planner rollout flags conservatively', () => {
    expect(getChatHybridPlannerMode({})).toBe('active');
    expect(getChatHybridPlannerMode({ CHAT_HYBRID_PLANNER_ENABLED: 'false' })).toBe('off');
    expect(getChatHybridPlannerMode({ CHAT_HYBRID_PLANNER_ENABLED: 'off' })).toBe('off');
    expect(getChatHybridPlannerMode({ CHAT_HYBRID_PLANNER_ENABLED: 'shadow' })).toBe('shadow');
    expect(getChatHybridPlannerMode({ CHAT_HYBRID_SHADOW_MODE: 'true' })).toBe('shadow');
    expect(isChatHybridPlannerEnabled({ CHAT_HYBRID_PLANNER_ENABLED: '0' })).toBe(false);
    expect(isChatHybridPlannerEnabled({ CHAT_HYBRID_PLANNER_ENABLED: 'shadow' })).toBe(true);
  });

  it('keeps chat LLM tiers and surface handoff independently switchable', () => {
    expect(isChatLlmTier1Enabled({})).toBe(false);
    expect(isChatLlmTier1Enabled({ CHAT_LLM_TIER1_ENABLED: 'true' })).toBe(true);
    expect(isChatLlmTier2Enabled({})).toBe(true);
    expect(isChatLlmTier2Enabled({ CHAT_LLM_TIER2_ENABLED: 'false' })).toBe(false);
    expect(isChatEscalationReviewerEnabled({})).toBe(false);
    expect(isChatEscalationReviewerEnabled({ CHAT_ESCALATION_REVIEWER_ENABLED: 'true' })).toBe(true);
    expect(isChatOpenSurfaceHandoffEnabled({})).toBe(true);
    expect(isChatOpenSurfaceHandoffEnabled({ CHAT_OPEN_SURFACE_HANDOFF_ENABLED: 'false' })).toBe(false);
  });

  it('supports scoped chat rollout overrides for owner/beta canaries', () => {
    expect(getChatHybridPlannerMode({
      CHAT_HYBRID_PLANNER_ENABLED: 'off',
      CHAT_HYBRID_PLANNER_ENABLED_USER_42: 'shadow',
    }, { userId: 42, tenantId: 99 })).toBe('shadow');
    expect(getChatHybridPlannerMode({
      CHAT_HYBRID_PLANNER_ENABLED: 'off',
      CHAT_HYBRID_PLANNER_ENABLED_TENANT_99: 'active',
    }, { userId: 41, tenantId: 99 })).toBe('active');
    expect(isChatLlmTier1Enabled({
      CHAT_LLM_TIER1_ENABLED: 'false',
      CHAT_LLM_TIER1_ENABLED_TENANT_99: 'true',
    }, { tenantId: 99 })).toBe(true);
    expect(isChatLlmTier2Enabled({
      CHAT_LLM_TIER2_ENABLED: 'true',
      CHAT_LLM_TIER2_ENABLED_USER_42: 'false',
    }, { userId: 42 })).toBe(false);
    expect(isChatOpenSurfaceHandoffEnabled({
      CHAT_OPEN_SURFACE_HANDOFF_ENABLED: 'true',
      CHAT_OPEN_SURFACE_HANDOFF_ENABLED_USER_42: 'false',
    }, { userId: 42 })).toBe(false);
  });

  it('supports scoped content cost-control kill switches', () => {
    const env = {
      CONTENT_FORCE_DRAFT_ONLY: 'false',
      CONTENT_FORCE_DRAFT_ONLY_USER_42: 'true',
      CONTENT_DISABLE_FRESH_RESEARCH: 'true',
      CONTENT_DISABLE_DEEP_RESEARCH_TENANT_99: 'true',
      CONTENT_DISABLE_FULL_YOUTUBE_LONGFORM: 'true',
      CONTENT_DISABLE_MODEL_QUALITY_AUDIT_USER_42: 'true',
    };

    expect(isContentForceDraftOnlyEnabled(env, { userId: 42, tenantId: 1 })).toBe(true);
    expect(isContentForceDraftOnlyEnabled(env, { userId: 7, tenantId: 1 })).toBe(false);
    expect(isContentFreshResearchDisabled(env, { userId: 7, tenantId: 1 })).toBe(true);
    expect(isContentDeepResearchDisabled(env, { userId: 7, tenantId: 99 })).toBe(true);
    expect(isContentFullLongformDisabled(env, { userId: 7, tenantId: 1 })).toBe(true);
    expect(isContentModelQualityAuditDisabled(env, { userId: 42, tenantId: 1 })).toBe(true);
  });

  it('keeps chat reliability rollout flags on by default with scoped rollback support', () => {
    expect(isChatTurnContractEnabled({})).toBe(true);
    expect(isChatSkillResponsePolicyEnabled({})).toBe(true);
    expect(isChatContextCompilerEnabled({})).toBe(true);
    expect(isChatResearchRouterEnabled({})).toBe(true);
    expect(isChatQualityGateEnabled({})).toBe(true);
    expect(isChatBilingualEvalGateEnabled({})).toBe(true);

    expect(isChatTurnContractEnabled({ CHAT_TURN_CONTRACT_ENABLED: 'false' })).toBe(false);
    expect(isChatResearchRouterEnabled({
      CHAT_RESEARCH_ROUTER_ENABLED: 'true',
      CHAT_RESEARCH_ROUTER_ENABLED_USER_42: 'false',
    }, { userId: 42, tenantId: 99 })).toBe(false);
    expect(isChatQualityGateEnabled({
      CHAT_QUALITY_GATE_ENABLED: 'true',
      CHAT_QUALITY_GATE_ENABLED_TENANT_99: 'false',
    }, { userId: 42, tenantId: 99 })).toBe(false);
  });

  it('keeps Chat Core v2 shadow route hook default-off with scoped opt-in', () => {
    expect(isChatCoreV2ShadowRouteHookEnabled({})).toBe(false);
    expect(isChatCoreV2ShadowRouteHookEnabled({ CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'true' })).toBe(true);
    expect(isChatCoreV2ShadowRouteHookEnabled({ CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'shadow' })).toBe(true);
    expect(isChatCoreV2ShadowRouteHookEnabled({
      CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'false',
      CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_TENANT_9: '1',
    }, { userId: 7, tenantId: 9 })).toBe(true);
    expect(isChatCoreV2ShadowRouteHookEnabled({
      CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'true',
      CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED_USER_42: 'off',
    }, { userId: 42, tenantId: 9 })).toBe(false);
  });

  it('keeps Chat Core v2 live capability flags default-off with scoped opt-in', () => {
    expect(isChatCoreV2Enabled({})).toBe(false);
    expect(isChatCoreV2Enabled({ CHAT_CORE_V2_ENABLED: 'true' })).toBe(true);
    expect(isChatCoreV2Enabled({ CHAT_CORE_V2_ENABLED: 'on' })).toBe(true);
    expect(isChatCoreV2Enabled({ CHAT_CORE_V2_ENABLED: 'enabled' })).toBe(true);
    expect(isChatCoreV2Enabled({ CHAT_CORE_V2_ENABLED: 'shadow' })).toBe(false);
    expect(isChatCoreV2Enabled({
      CHAT_CORE_V2_ENABLED: 'false',
      CHAT_CORE_V2_ENABLED_TENANT_9: '1',
    }, { userId: 7, tenantId: 9 })).toBe(true);
    expect(isChatCoreV2Enabled({
      CHAT_CORE_V2_ENABLED: 'true',
      CHAT_CORE_V2_ENABLED_USER_42: 'off',
    }, { userId: 42, tenantId: 9 })).toBe(false);

    expect(isChatCoreV2RuntimeFlagEnabled('CHAT_CORE_V2_ENABLED', {
      CHAT_CORE_V2_ENABLED: '1',
    })).toBe(true);
    expect(isChatCoreV2RuntimeFlagEnabled('chat_core_v2_tasks_enabled', {
      CHAT_CORE_V2_TASKS_ENABLED: 'true',
    })).toBe(true);
    expect(isChatCoreV2RuntimeFlagEnabled('CHAT_CORE_V3_ENABLED', {
      CHAT_CORE_V3_ENABLED: 'true',
    })).toBe(false);
  });

  it('keeps Decision Center fatigue caps default-off with scoped opt-in (C5)', () => {
    expect(isDecisionCenterFatigueCapsEnabled({})).toBe(false);
    expect(isDecisionCenterFatigueCapsEnabled({ DECISION_CENTER_FATIGUE_CAPS_ENABLED: 'true' })).toBe(true);
    expect(isDecisionCenterFatigueCapsEnabled({ DECISION_CENTER_FATIGUE_CAPS_ENABLED: 'on' })).toBe(true);
    expect(isDecisionCenterFatigueCapsEnabled({ DECISION_CENTER_FATIGUE_CAPS_ENABLED: '1' })).toBe(true);
    expect(isDecisionCenterFatigueCapsEnabled({ DECISION_CENTER_FATIGUE_CAPS_ENABLED: 'enabled' })).toBe(true);
    expect(isDecisionCenterFatigueCapsEnabled({ DECISION_CENTER_FATIGUE_CAPS_ENABLED: 'yes' })).toBe(false);
    expect(isDecisionCenterFatigueCapsEnabled({
      DECISION_CENTER_FATIGUE_CAPS_ENABLED: 'false',
      DECISION_CENTER_FATIGUE_CAPS_ENABLED_TENANT_9: 'true',
    }, { userId: 7, tenantId: 9 })).toBe(true);
    expect(isDecisionCenterFatigueCapsEnabled({
      DECISION_CENTER_FATIGUE_CAPS_ENABLED: 'true',
      DECISION_CENTER_FATIGUE_CAPS_ENABLED_USER_42: 'off',
    }, { userId: 42, tenantId: 9 })).toBe(false);
  });

  it('supports staged cohorts for dark Decision Center intelligence flags without changing default-off', () => {
    const env = { DECISION_CENTER_DARK_FLAGS_COHORT_PERCENT: '100' };
    const scope = { userId: 7, tenantId: 9 };
    expect(isDecisionCenterFatigueCapsEnabled(env, scope)).toBe(true);
    expect(isDecisionSemanticDedupEnabled(env, scope)).toBe(true);
    expect(isDecisionSemanticSupersedeEnabled(env, scope)).toBe(true);
    expect(isDecisionFeedbackSuppressionEnabled(env, scope)).toBe(true);

    expect(isDecisionFeedbackSuppressionEnabled({ DECISION_CENTER_DARK_FLAGS_COHORT_PERCENT: '0' }, scope)).toBe(false);
    expect(isDecisionFeedbackSuppressionEnabled(env)).toBe(false);
    expect(isDecisionFeedbackSuppressionEnabled({
      DECISION_CENTER_DARK_FLAGS_COHORT_PERCENT: '100',
      DECISION_FEEDBACK_SUPPRESSION_ENABLED_TENANT_9: 'off',
    }, scope)).toBe(false);
  });

  it('keeps the A2 reconnect affordance default-off with scoped opt-in', () => {
    expect(isDecisionReconnectAffordanceEnabled({})).toBe(false);
    expect(isDecisionReconnectAffordanceEnabled({ DECISION_RECONNECT_AFFORDANCE_ENABLED: 'true' })).toBe(true);
    expect(isDecisionReconnectAffordanceEnabled({ DECISION_RECONNECT_AFFORDANCE_ENABLED: '1' })).toBe(true);
    expect(isDecisionReconnectAffordanceEnabled({ DECISION_RECONNECT_AFFORDANCE_ENABLED: 'yes' })).toBe(false);
    // scoped opt-in: a tenant override flips it on for that tenant only
    expect(isDecisionReconnectAffordanceEnabled({
      DECISION_RECONNECT_AFFORDANCE_ENABLED: 'false',
      DECISION_RECONNECT_AFFORDANCE_ENABLED_TENANT_9: 'true',
    }, { userId: 7, tenantId: 9 })).toBe(true);
    // scoped opt-out: a user override flips it off even when the global is on
    expect(isDecisionReconnectAffordanceEnabled({
      DECISION_RECONNECT_AFFORDANCE_ENABLED: 'true',
      DECISION_RECONNECT_AFFORDANCE_ENABLED_USER_42: 'off',
    }, { userId: 42, tenantId: 9 })).toBe(false);
  });

  it('keeps the D secretary choice-options surface default-off with scoped opt-in', () => {
    expect(isDecisionChoiceOptionsEnabled({})).toBe(false);
    expect(isDecisionChoiceOptionsEnabled({ DECISION_CHOICE_OPTIONS_ENABLED: 'true' })).toBe(true);
    expect(isDecisionChoiceOptionsEnabled({ DECISION_CHOICE_OPTIONS_ENABLED: '1' })).toBe(true);
    expect(isDecisionChoiceOptionsEnabled({ DECISION_CHOICE_OPTIONS_ENABLED: 'yes' })).toBe(false);
    expect(isDecisionChoiceOptionsEnabled({
      DECISION_CHOICE_OPTIONS_ENABLED: 'false',
      DECISION_CHOICE_OPTIONS_ENABLED_TENANT_9: 'true',
    }, { userId: 7, tenantId: 9 })).toBe(true);
    expect(isDecisionChoiceOptionsEnabled({
      DECISION_CHOICE_OPTIONS_ENABLED: 'true',
      DECISION_CHOICE_OPTIONS_ENABLED_USER_42: 'off',
    }, { userId: 42, tenantId: 9 })).toBe(false);
  });

  it('keeps the B3 supersede + human-review gates default-off with scoped opt-in', () => {
    expect(isDecisionSemanticSupersedeEnabled({})).toBe(false);
    expect(isDecisionSemanticSupersedeEnabled({ DECISION_SEMANTIC_SUPERSEDE_ENABLED: 'true' })).toBe(true);
    expect(isDecisionSemanticSupersedeEnabled({ DECISION_SEMANTIC_SUPERSEDE_ENABLED: 'true', DECISION_SEMANTIC_SUPERSEDE_ENABLED_USER_5: 'off' }, { userId: 5, tenantId: 9 })).toBe(false);
    expect(isDecisionHumanReviewGateEnabled({})).toBe(false);
    expect(isDecisionHumanReviewGateEnabled({ DECISION_HUMAN_REVIEW_GATE_ENABLED: '1' })).toBe(true);
  });

  it('keeps the C3 type-suppression control default-off with scoped opt-in', () => {
    expect(isDecisionTypeSuppressionEnabled({})).toBe(false);
    expect(isDecisionTypeSuppressionEnabled({ DECISION_TYPE_SUPPRESSION_ENABLED: 'true' })).toBe(true);
    expect(isDecisionTypeSuppressionEnabled({ DECISION_TYPE_SUPPRESSION_ENABLED: '1' })).toBe(true);
    expect(isDecisionTypeSuppressionEnabled({ DECISION_TYPE_SUPPRESSION_ENABLED: 'yes' })).toBe(false);
    expect(isDecisionTypeSuppressionEnabled({
      DECISION_TYPE_SUPPRESSION_ENABLED: 'true',
      DECISION_TYPE_SUPPRESSION_ENABLED_USER_5: 'off',
    }, { userId: 5, tenantId: 9 })).toBe(false);
    expect(isDecisionTypeSuppressionEnabled({
      DECISION_TYPE_SUPPRESSION_ENABLED: 'false',
      DECISION_TYPE_SUPPRESSION_ENABLED_TENANT_9: 'true',
    }, { userId: 7, tenantId: 9 })).toBe(true);
  });

  it('keeps the D skill cards surface default-off with scoped opt-in', () => {
    expect(isDecisionSkillCardsEnabled({})).toBe(false);
    expect(isDecisionSkillCardsEnabled({ DECISION_SKILL_CARDS_ENABLED: 'true' })).toBe(true);
    expect(isDecisionSkillCardsEnabled({ DECISION_SKILL_CARDS_ENABLED: '1' })).toBe(true);
    expect(isDecisionSkillCardsEnabled({ DECISION_SKILL_CARDS_ENABLED: 'yes' })).toBe(false);
    expect(isDecisionSkillCardsEnabled({
      DECISION_SKILL_CARDS_ENABLED: 'false',
      DECISION_SKILL_CARDS_ENABLED_TENANT_9: 'true',
    }, { userId: 7, tenantId: 9 })).toBe(true);
    expect(isDecisionSkillCardsEnabled({
      DECISION_SKILL_CARDS_ENABLED: 'true',
      DECISION_SKILL_CARDS_ENABLED_USER_42: 'off',
    }, { userId: 42, tenantId: 9 })).toBe(false);
  });
});
