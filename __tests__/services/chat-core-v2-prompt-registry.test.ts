import { describe, expect, it } from 'vitest';

import {
  CHAT_CORE_V2_CONTEXT_BUILDER_VERSION,
  CHAT_CORE_V2_PROMPT_REGISTRY_VERSION,
  buildChatCoreV2PromptRunConfig,
  getChatCoreV2ModelSettingsProfile,
  getChatCoreV2PromptTemplate,
  hashChatCoreV2ModelSettings,
  listChatCoreV2PromptFamiliesFromCapabilities,
  listChatCoreV2PromptTemplates,
} from '../../src/services/chat-core-v2';

describe('Chat Core v2 prompt registry', () => {
  it('defines a versioned prompt family for every capability registry prompt family', () => {
    const registeredFamilies = new Set(listChatCoreV2PromptTemplates().map((template) => template.promptFamily));

    for (const promptFamily of listChatCoreV2PromptFamiliesFromCapabilities()) {
      expect(registeredFamilies.has(promptFamily), `${promptFamily} is missing a prompt template`).toBe(true);
      expect(getChatCoreV2PromptTemplate(promptFamily).promptTemplateVersion).toBe(`${promptFamily}@1.0.0`);
    }
    expect(registeredFamilies.has('chat_v2_multi_domain')).toBe(true);
    expect(registeredFamilies.has('chat_v2_no_tools')).toBe(true);
  });

  it('keeps stable prompt prefixes static, hashed, and explicit about untrusted evidence', () => {
    const template = getChatCoreV2PromptTemplate('chat_v2_tasks');

    expect(template.registryVersion).toBe(CHAT_CORE_V2_PROMPT_REGISTRY_VERSION);
    expect(template.stablePrefixHash).toMatch(/^[a-f0-9]{16}$/);
    expect(template.stablePrefix).toContain('Never mutate state directly');
    expect(template.stablePrefix).toContain('untrusted evidence');
    expect(template.stablePrefix).not.toMatch(/\{\{|\}\}|\$\{/);
    expect(template.stablePrefix).not.toMatch(/userId|tenantId|conversationId|turnId/i);
  });

  it('selects model profiles by reasoning tier while keeping provider state disabled by default', () => {
    const fast = buildChatCoreV2PromptRunConfig({
      promptFamily: 'chat_v2_tasks',
      reasoningTier: 'fast_extraction',
      toolSchemaSetVersion: 'chat_core_v2_tools@1.0.0+abc123abc123',
    });
    const planner = buildChatCoreV2PromptRunConfig({
      promptFamily: 'chat_v2_multi_domain',
      reasoningTier: 'planner',
      toolSchemaSetVersion: 'chat_core_v2_tools@1.0.0+def456def456',
    });

    expect(fast).toMatchObject({
      promptTemplateVersion: 'chat_v2_tasks@1.0.0',
      contextBuilderVersion: CHAT_CORE_V2_CONTEXT_BUILDER_VERSION,
      reasoningTier: 'fast_extraction',
      modelProfile: {
        profileId: 'fast_extraction',
        provider: 'other',
        storeProviderState: false,
      },
    });
    expect(fast.modelSettingsHash).toMatch(/^settings:[a-f0-9]{16}$/);
    expect(planner.modelProfile.profileId).toBe('planner');
    expect(planner.promptTemplateVersion).toBe('chat_v2_multi_domain@1.0.0');
  });

  it('hashes model settings deterministically and changes when execution settings change', () => {
    const base = getChatCoreV2ModelSettingsProfile('standard_command');
    const same = getChatCoreV2ModelSettingsProfile('standard_command');
    const changed = { ...base, maxOutputTokens: base.maxOutputTokens + 1 };

    expect(hashChatCoreV2ModelSettings(base)).toBe(hashChatCoreV2ModelSettings(same));
    expect(hashChatCoreV2ModelSettings(changed)).not.toBe(hashChatCoreV2ModelSettings(base));
  });

  it('fails closed for unknown prompt families instead of falling back to generic prompts', () => {
    expect(() => getChatCoreV2PromptTemplate('chat_v2_everything')).toThrow(/Unknown Chat Core v2 prompt family/);
  });

  it('marks no-tools prompts as no-model and planner prompts as planner-only', () => {
    const noTools = getChatCoreV2PromptTemplate('chat_v2_no_tools');
    const multi = getChatCoreV2PromptTemplate('chat_v2_multi_domain');

    expect(noTools.modelProfileId).toBe('no_model');
    expect(noTools.allowedReasoningTiers).toEqual(['none']);
    expect(noTools.allowedRouteMethods).toEqual(['deterministic_read', 'needs_clarification', 'unsupported', 'blocked']);
    expect(multi.modelProfileId).toBe('planner');
    expect(multi.allowedRouteMethods).toEqual(['planner', 'background_planner']);
  });
});
