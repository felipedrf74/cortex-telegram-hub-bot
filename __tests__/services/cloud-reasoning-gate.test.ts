// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cloud Reasoning Gate — quality + privacy matrix tests.
 *
 * Covers acceptance criteria 9, 10, 22, 23, 24 from the plan:
 *   - Flash / nano / lite / haiku / fast substring rejection
 *   - Disallow check OVERRIDES APPROVED_REASONING_MODELS (operators can't
 *     bypass safety by adding a flash model to the approved list)
 *   - Privacy gate refuses raw private data when not allowed
 *   - Successful selection returns the configured approved model so the
 *     caller can pass it via options.modelOverride
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock config first. Use vi.hoisted() so the mock factory can reference
// `mockConfig` before vi.mock is hoisted to the top of the file. Without
// hoisted(), the factory runs before the const initializer and throws
// `Cannot access 'mockConfig' before initialization`.
const { mockConfig } = vi.hoisted(() => {
  return {
    mockConfig: {
      ollama: { enabled: true },
      cloudReasoningFallback: {
        enabled: true,
        provider: 'gemini' as string,
        model: 'gemini-2.5-pro' as string,
        requireApprovedModel: true,
        allowPreviewModels: false,
        approvedReasoningModels: ['gemini-2.5-pro', 'claude-sonnet-4-6'] as string[],
        disallowedSubstrings: ['flash', 'flash-lite', 'nano', 'mini', 'haiku', 'lite', 'classifier', 'fast'] as string[],
        onUnapproved: 'return_local_result_with_warning' as string,
        privacy: { mode: 'redacted_only' as string, allowRawPrivateData: false },
        scriptDeliveryBindings: {
          standard: { provider: '', model: '', serviceTier: '' },
          scheduled: { provider: '', model: '', serviceTier: '' },
          priority: { provider: '', model: '', serviceTier: '' },
        },
      },
    },
  };
});

vi.mock('../../src/config', () => ({ config: mockConfig }));
const killSwitchEngagedMock = vi.hoisted(() => vi.fn(() => false));
vi.mock('../../src/services/hybrid-runtime-kill-switches', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/hybrid-runtime-kill-switches')>()),
  isHybridKillSwitchEngaged: killSwitchEngagedMock,
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));
// v2.8: cloud-reasoning-gate now statically imports stripThinkBlocks from
// ollama-provider. Stub it here to avoid the transitive import chain.
vi.mock('../../src/services/ollama-provider', () => ({
  stripThinkBlocks: (text: string | null | undefined): string => {
    if (!text) return '';
    const src = String(text);
    let out = ''; let depth = 0; let i = 0;
    while (i < src.length) {
      const rest = src.slice(i);
      const open = rest.match(/^<think\b[^>]*>/i);
      if (open) { depth++; i += open[0].length; continue; }
      const close = rest.match(/^<\/think\s*>/i);
      if (close) { if (depth > 0) depth--; i += close[0].length; continue; }
      if (depth === 0) out += src[i];
      i++;
    }
    return out.trim();
  },
  OllamaProvider: class { name = 'ollama'; },
  isOllamaConfigured: () => true,
  normalizeClassificationPayload: (payload: unknown) => payload,
}));

import {
  approveCloudScriptGeneration,
  canonicalCloudLocalReasoningOutboundInput,
  canonicalCloudScriptGenerationOutboundInput,
  consumeCloudScriptGenerationApproval,
  selectApprovedCloudReasoningProvider,
} from '../../src/services/cloud-reasoning-gate';
import type { AIProvider } from '../../src/services/ai-provider';

function fakeProvider(name: string): AIProvider {
  return {
    name,
    classify: async () => ({ domain: 'content', confidence: 1 }),
    callDomain: async () => ({ text: 'ok', toolCalls: [], stopReason: 'stop' }),
    continueWithToolResults: async () => ({ text: 'ok', toolCalls: [], stopReason: 'stop' }),
  };
}

function getProviderFn(name: string): AIProvider | null {
  if (name === 'gemini' || name === 'openai' || name === 'anthropic') return fakeProvider(name);
  return null;
}

beforeEach(() => {
  killSwitchEngagedMock.mockReset();
  killSwitchEngagedMock.mockReturnValue(false);
  // Reset config to defaults for each test
  mockConfig.cloudReasoningFallback = {
    enabled: true,
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    requireApprovedModel: true,
    allowPreviewModels: false,
    approvedReasoningModels: ['gemini-2.5-pro', 'claude-sonnet-4-6'],
    disallowedSubstrings: ['flash', 'flash-lite', 'nano', 'mini', 'haiku', 'lite', 'classifier', 'fast'],
    onUnapproved: 'return_local_result_with_warning',
    privacy: { mode: 'redacted_only', allowRawPrivateData: false },
    scriptDeliveryBindings: {
      standard: { provider: '', model: '', serviceTier: '' },
      scheduled: { provider: '', model: '', serviceTier: '' },
      priority: { provider: '', model: '', serviceTier: '' },
    },
  };
});

describe('Quality gate — approved-model selection', () => {
  it('returns provider+model when approved model is configured', async () => {
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'hard question', containsPrivateData: false },
      getProviderFn,
    );
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.model).toBe('gemini-2.5-pro');
      expect(result.provider.name).toBe('gemini');
      expect(result.privacyAction).toBe('sent_raw');
    }
  });

  it('rejects while the cloud_reasoning_fallback kill switch is engaged (NH-0040)', async () => {
    killSwitchEngagedMock.mockReturnValue(true);
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'x', containsPrivateData: false },
      getProviderFn,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) {
      expect(result.reason).toBe('disabled');
      expect(result.warning).toBe('cloud_reasoning_fallback_kill_switch_engaged');
    }
  });

  it('rejects when fallback is disabled', async () => {
    mockConfig.cloudReasoningFallback.enabled = false;
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x', containsPrivateData: false }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('disabled');
  });

  it('rejects when provider or model is empty', async () => {
    mockConfig.cloudReasoningFallback.model = '';
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x', containsPrivateData: false }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('unconfigured');
  });

  it('rejects a globally approved model paired with the wrong provider', async () => {
    mockConfig.cloudReasoningFallback.provider = 'anthropic';
    mockConfig.cloudReasoningFallback.model = 'gemini-2.5-pro';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-pro'];

    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'x', containsPrivateData: false },
      getProviderFn,
    );

    expect(result).toMatchObject({
      rejected: true,
      reason: 'provider_model_mismatch',
      warning: 'configured_cloud_provider_model_mismatch',
    });
  });

  it('rejects an approved Claude model paired with the OpenAI provider', async () => {
    mockConfig.cloudReasoningFallback.provider = 'openai';
    mockConfig.cloudReasoningFallback.model = 'claude-sonnet-4-6';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['claude-sonnet-4-6'];

    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'x', containsPrivateData: false },
      getProviderFn,
    );

    expect(result).toMatchObject({
      rejected: true,
      reason: 'provider_model_mismatch',
      warning: 'configured_cloud_provider_model_mismatch',
    });
  });
});

describe('ScriptGen approval boundary', () => {
  it('canonicalizes domain context as part of the outbound payload inspected by the gate', () => {
    const canonical = canonicalCloudScriptGenerationOutboundInput({
      description: 'create a helper',
      domainContext: 'DISALLOWED_PRIVATE_MARKER',
      targetPath: 'not-sent-by-the-adapter',
      containsPrivateData: true,
    });

    expect(canonical).toContain('create a helper');
    expect(canonical).toContain('DISALLOWED_PRIVATE_MARKER');
    expect(canonical).not.toContain('not-sent-by-the-adapter');
  });

  it('canonicalizes every caller-controlled generic reasoning field', () => {
    const canonical = canonicalCloudLocalReasoningOutboundInput({
      prompt: 'PUBLIC_USER_MARKER',
      systemContext: 'PUBLIC_SYSTEM_MARKER',
      outputSchema: { type: 'string', enum: ['PUBLIC_SCHEMA_MARKER'] },
    });

    expect(canonical).toContain('PUBLIC_USER_MARKER');
    expect(canonical).toContain('PUBLIC_SYSTEM_MARKER');
    expect(canonical).toContain('PUBLIC_SCHEMA_MARKER');
  });

  it('mints and consumes an exact-model OpenAI ScriptGen permit when the capability is present', async () => {
    mockConfig.cloudReasoningFallback.provider = 'openai';
    mockConfig.cloudReasoningFallback.model = 'gpt-5.2';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gpt-5.2'];
    const openai = {
      ...fakeProvider('openai'),
      callStructuredGeneration: async () => ({ text: '{}', stopReason: 'stop' }),
    } satisfies AIProvider;

    const result = await approveCloudScriptGeneration({
      description: 'create a helper',
      containsPrivateData: false,
    }, () => openai);

    expect(result).toMatchObject({
      rejected: false,
      providerName: 'openai',
      model: 'gpt-5.2',
    });
    if (result.rejected) throw new Error('expected OpenAI ScriptGen approval');
    expect(consumeCloudScriptGenerationApproval(result.permit, {
      description: 'create a helper',
      containsPrivateData: false,
    })).toMatchObject({
      provider: openai,
      model: 'gpt-5.2',
      privacyAction: 'sent_raw',
    });
  });

  it('never mints a private ScriptGen permit under allow_raw operator drift', async () => {
    mockConfig.cloudReasoningFallback.privacy.mode = 'allow_raw';
    mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = true;
    const getProvider = vi.fn(getProviderFn);

    const result = await approveCloudScriptGeneration({
      description: 'public-looking description',
      domainContext: 'PRIVATE_SCRIPT_CONTEXT_MARKER',
      containsPrivateData: true,
      allowCloudEscalation: true,
    }, getProvider);

    expect(result).toMatchObject({
      rejected: true,
      reason: 'privacy_never',
      warning: 'private_script_generation_cloud_forbidden',
    });
    expect(getProvider).not.toHaveBeenCalled();
  });
});

describe('Quality gate — disallowed substrings', () => {
  it('rejects gemini-2.5-flash (substring match)', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-2.5-flash';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-flash'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x', containsPrivateData: false }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) {
      expect(result.reason).toBe('disallowed_substring');
      expect(result.warning).toBe('configured_cloud_model_matches_disallowed_substring');
    }
  });

  it('rejects gemini-2.5-flash-lite even if listed as approved', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-2.5-flash-lite';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-flash-lite'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x', containsPrivateData: false }, getProviderFn);
    expect(result.rejected).toBe(true);
  });

  it('rejects claude-haiku class', async () => {
    mockConfig.cloudReasoningFallback.provider = 'anthropic';
    mockConfig.cloudReasoningFallback.model = 'claude-haiku-4-5-20251001';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['claude-haiku-4-5-20251001'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x', containsPrivateData: false }, getProviderFn);
    expect(result.rejected).toBe(true);
  });

  it('rejects gpt-5-nano (nano substring)', async () => {
    mockConfig.cloudReasoningFallback.provider = 'openai';
    mockConfig.cloudReasoningFallback.model = 'gpt-5-nano';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gpt-5-nano'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x', containsPrivateData: false }, getProviderFn);
    expect(result.rejected).toBe(true);
  });

  it('disallow check OVERRIDES APPROVED_REASONING_MODELS (plan A23)', async () => {
    // The most important safety property: even when an operator adds a
    // flash model to the approved list (out of confusion / fat-finger),
    // the gate still rejects it.
    mockConfig.cloudReasoningFallback.approvedReasoningModels = [
      'gemini-2.5-pro',
      'claude-sonnet-4-6',
      'gemini-2.5-flash', // <-- intentionally bad addition
    ];
    mockConfig.cloudReasoningFallback.model = 'gemini-2.5-flash';
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x', containsPrivateData: false }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('disallowed_substring');
  });
});

describe('Quality gate — preview blocking', () => {
  it('rejects preview models by default', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-3.1-pro-preview';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-3.1-pro-preview'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x', containsPrivateData: false }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('preview_blocked');
  });

  it('allows gemini-non-preview (explicit negation skips preview-block, v2.8 fix)', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-non-preview';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-non-preview'];
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'x', containsPrivateData: false },
      getProviderFn,
    );
    expect(result.rejected).toBe(false);
    if (!result.rejected) expect(result.model).toBe('gemini-non-preview');
  });

  it('allows gemini-not-preview (explicit negation v2.8)', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-not-preview';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-not-preview'];
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'x', containsPrivateData: false },
      getProviderFn,
    );
    expect(result.rejected).toBe(false);
  });

  it('still rejects gemini-pro-preview (no negation present)', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-pro-preview';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-pro-preview'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x', containsPrivateData: false }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('preview_blocked');
  });

  it('allows preview models when opt-in flag is set', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-3.1-pro-preview';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-3.1-pro-preview'];
    mockConfig.cloudReasoningFallback.allowPreviewModels = true;
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'x', containsPrivateData: false },
      getProviderFn,
    );
    expect(result.rejected).toBe(false);
  });
});

describe('Privacy gate', () => {
  it('refuses when containsPrivateData and !allowCloudEscalation', async () => {
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'private', containsPrivateData: true, allowCloudEscalation: false },
      getProviderFn,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('request_disallows_cloud');
  });

  it('refuses when privacy mode is "never" even with allowCloudEscalation', async () => {
    mockConfig.cloudReasoningFallback.privacy.mode = 'never';
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'private', containsPrivateData: true, allowCloudEscalation: true },
      getProviderFn,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('privacy_never');
  });

  it('v3.1: mode=redacted_only ALWAYS rejects with reason=redaction_unsupported (no redactor path)', async () => {
    // History: v3.0 had a static redactor that the gate ran on the
    // operator-controlled prompt. Codex round-6 reproduced raw AWS
    // keys and IBANs reaching cloud via PII the regex didn't catch.
    // v3.1 removed the redactor entirely. The `redacted_only` mode
    // remains as a valid config value (for backwards-compat) but it
    // now ALWAYS rejects — operators have to migrate to
    // `mode='allow_raw' + allowRawPrivateData=true` for explicit
    // raw-private opt-in, or stay on `mode='never'`.
    const result = await selectApprovedCloudReasoningProvider(
      {
        prompt: 'A user is asking how to refactor an auth module without breaking sessions.',
        containsPrivateData: true,
        allowCloudEscalation: true,
      },
      getProviderFn,
      null,  // <-- ollama explicitly null; gate doesn't touch it in v3.1
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) {
      expect(result.reason).toBe('redaction_unsupported');
      expect(result.warning).toBe('redaction_path_disabled_v3_1');
    }
  });

  it('v3.1: redactionRequired=true is now a no-op (still rejected because mode=redacted_only)', async () => {
    // Setting redactionRequired in v3.1 doesn't change the outcome
    // because the redactor itself is gone. The gate just hits the
    // mode=redacted_only rejection.
    const result = await selectApprovedCloudReasoningProvider(
      {
        prompt: '<think>SECRET</think>visible_summary',
        containsPrivateData: true,
        allowCloudEscalation: true,
        redactionRequired: true,
      },
      getProviderFn,
      null,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) {
      expect(result.reason).toBe('redaction_unsupported');
    }
  });

  it('allows raw private data when mode=allow_raw AND allowRawPrivateData AND allowCloudEscalation', async () => {
    mockConfig.cloudReasoningFallback.privacy.mode = 'allow_raw';
    mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = true;
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'private', containsPrivateData: true, allowCloudEscalation: true },
      getProviderFn,
    );
    expect(result.rejected).toBe(false);
    if (!result.rejected) expect(result.privacyAction).toBe('sent_raw');
  });

  it('refuses raw private data when mode=allow_raw but allowRawPrivateData=false', async () => {
    mockConfig.cloudReasoningFallback.privacy.mode = 'allow_raw';
    mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = false;
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'private', containsPrivateData: true, allowCloudEscalation: true },
      getProviderFn,
    );
    expect(result.rejected).toBe(true);
  });
});

describe('Quality gate — provider unavailability', () => {
  it('rejects when configured provider is not available', async () => {
    mockConfig.cloudReasoningFallback.provider = 'anthropic';
    mockConfig.cloudReasoningFallback.model = 'claude-sonnet-4-6';
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'x', containsPrivateData: false },
      (name) => (name === 'gemini' ? fakeProvider('gemini') : null),
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('provider_unavailable');
  });
});

describe('per-class script delivery bindings (§1 / Addendum C)', () => {
  const bindings = () => mockConfig.cloudReasoningFallback.scriptDeliveryBindings;
  const resetBindings = () => {
    bindings().standard = { provider: '', model: '', serviceTier: '' };
    bindings().scheduled = { provider: '', model: '', serviceTier: '' };
    bindings().priority = { provider: '', model: '', serviceTier: '' };
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-pro', 'claude-sonnet-4-6'];
  };
  const providers: Record<string, unknown> = {
    gemini: { name: 'gemini' },
    openai: { name: 'openai' },
  };
  const getProvider = (name: string) => (providers[name] as never) ?? null;

  it('routes a bound class through its tier and unbound classes through the global pair', async () => {
    bindings().scheduled = { provider: 'openai', model: 'gpt-5.6-luna', serviceTier: 'flex' };
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-pro', 'gpt-5.6-luna'];
    try {
      const scheduled = await selectApprovedCloudReasoningProvider(
        { prompt: 'p', containsPrivateData: false, scriptDeliveryMode: 'scheduled' },
        getProvider,
        null,
      );
      expect(scheduled).toMatchObject({ model: 'gpt-5.6-luna', serviceTier: 'flex' });
      const standard = await selectApprovedCloudReasoningProvider(
        { prompt: 'p', containsPrivateData: false, scriptDeliveryMode: 'standard' },
        getProvider,
        null,
      );
      expect(standard).toMatchObject({ model: 'gemini-2.5-pro' });
      const plain = await selectApprovedCloudReasoningProvider(
        { prompt: 'p', containsPrivateData: false },
        getProvider,
        null,
      );
      expect(plain).toMatchObject({ model: 'gemini-2.5-pro' });
    } finally {
      resetBindings();
    }
  });

  it('fails closed before dispatch when payload authority requires OpenAI', async () => {
    const unbound = await selectApprovedCloudReasoningProvider(
      {
        prompt: 'p',
        containsPrivateData: false,
        scriptDeliveryMode: 'standard',
        requiredCloudProvider: 'openai',
      },
      getProvider,
      null,
    );
    expect(unbound).toMatchObject({
      rejected: true,
      reason: 'provider_not_authorized_for_request',
    });

    bindings().standard = {
      provider: 'openai',
      model: 'gpt-5.6-luna',
      serviceTier: 'default',
    };
    mockConfig.cloudReasoningFallback.approvedReasoningModels = [
      'gemini-2.5-pro',
      'gpt-5.6-luna',
    ];
    try {
      await expect(selectApprovedCloudReasoningProvider(
        {
          prompt: 'p',
          containsPrivateData: false,
          scriptDeliveryMode: 'standard',
          requiredCloudProvider: 'openai',
        },
        getProvider,
        null,
      )).resolves.toMatchObject({
        rejected: false,
        model: 'gpt-5.6-luna',
        serviceTier: 'default',
      });
    } finally {
      resetBindings();
    }
  });

  it('class bindings cannot bypass the quality gate or invent model suffixes for service tiers', async () => {
    bindings().priority = { provider: 'openai', model: 'gpt-5.6-luna', serviceTier: 'fast' };
    try {
      mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-pro', 'gpt-5.6-luna'];
      const fast = await selectApprovedCloudReasoningProvider(
        { prompt: 'p', containsPrivateData: false, scriptDeliveryMode: 'priority' },
        getProvider,
        null,
      );
      expect(fast).toMatchObject({ rejected: true, reason: 'script_delivery_service_tier_invalid' });
      // An unapproved (but not disallowed) tier also rejects.
      bindings().priority = { provider: 'openai', model: 'gpt-5.6-luna', serviceTier: 'priority' };
      mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-pro'];
      const unapproved = await selectApprovedCloudReasoningProvider(
        { prompt: 'p', containsPrivateData: false, scriptDeliveryMode: 'priority' },
        getProvider,
        null,
      );
      expect(unapproved).toMatchObject({ rejected: true, reason: 'not_in_approved_list' });
    } finally {
      resetBindings();
    }
  });

  it('a partial binding fails closed instead of silently using the global pair', async () => {
    bindings().standard = { provider: '', model: 'gpt-5.6-luna', serviceTier: 'flex' };
    try {
      const result = await selectApprovedCloudReasoningProvider(
        { prompt: 'p', containsPrivateData: false, scriptDeliveryMode: 'standard' },
        getProvider,
        null,
      );
      expect(result).toMatchObject({
        rejected: true,
        reason: 'script_delivery_binding_incomplete',
      });
    } finally {
      resetBindings();
    }
  });

  it('fails a scheduled Batch binding closed without durable state and admits it with durable state', async () => {
    bindings().scheduled = { provider: 'openai', model: 'gpt-5.6-luna', serviceTier: 'batch' };
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-pro', 'gpt-5.6-luna'];
    try {
      await expect(selectApprovedCloudReasoningProvider(
        { prompt: 'p', containsPrivateData: false, scriptDeliveryMode: 'scheduled' },
        getProvider,
        null,
      )).resolves.toMatchObject({
        rejected: true,
        reason: 'batch_transport_unavailable',
      });
      await expect(selectApprovedCloudReasoningProvider(
        {
          prompt: 'p',
          containsPrivateData: false,
          scriptDeliveryMode: 'scheduled',
          batchTransportAvailable: true,
        },
        getProvider,
        null,
      )).resolves.toMatchObject({
        rejected: false,
        model: 'gpt-5.6-luna',
        serviceTier: 'batch',
      });
    } finally {
      resetBindings();
    }
  });

  it('carries the selected delivery mode and service tier into the one-use ScriptGen permit', async () => {
    bindings().standard = { provider: 'openai', model: 'gpt-5.6-luna', serviceTier: 'flex' };
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-pro', 'gpt-5.6-luna'];
    const provider = fakeProvider('openai');
    provider.callStructuredGeneration = vi.fn();
    const payload = {
      description: 'Generate a public launch script',
      containsPrivateData: false,
      scriptDeliveryMode: 'standard' as const,
    };
    try {
      const approval = await approveCloudScriptGeneration(
        payload,
        (name) => (name === 'openai' ? provider : null),
      );
      expect(approval).toMatchObject({
        rejected: false,
        model: 'gpt-5.6-luna',
        serviceTier: 'flex',
      });
      if ('permit' in approval) {
        expect(consumeCloudScriptGenerationApproval(approval.permit, payload)).toMatchObject({
          model: 'gpt-5.6-luna',
          serviceTier: 'flex',
        });
      }
    } finally {
      resetBindings();
    }
  });
});
