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
      },
    },
  };
});

vi.mock('../../src/config', () => ({ config: mockConfig }));
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

import { selectApprovedCloudReasoningProvider } from '../../src/services/cloud-reasoning-gate';
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
  };
});

describe('Quality gate — approved-model selection', () => {
  it('returns provider+model when approved model is configured', async () => {
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'hard question' },
      getProviderFn,
    );
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.model).toBe('gemini-2.5-pro');
      expect(result.provider.name).toBe('gemini');
      expect(result.privacyAction).toBe('sent_raw');
    }
  });

  it('rejects when fallback is disabled', async () => {
    mockConfig.cloudReasoningFallback.enabled = false;
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('disabled');
  });

  it('rejects when provider or model is empty', async () => {
    mockConfig.cloudReasoningFallback.model = '';
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('unconfigured');
  });
});

describe('Quality gate — disallowed substrings', () => {
  it('rejects gemini-2.5-flash (substring match)', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-2.5-flash';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-flash'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) {
      expect(result.reason).toBe('disallowed_substring');
      expect(result.warning).toBe('configured_cloud_model_matches_disallowed_substring');
    }
  });

  it('rejects gemini-2.5-flash-lite even if listed as approved', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-2.5-flash-lite';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-flash-lite'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
    expect(result.rejected).toBe(true);
  });

  it('rejects claude-haiku class', async () => {
    mockConfig.cloudReasoningFallback.provider = 'anthropic';
    mockConfig.cloudReasoningFallback.model = 'claude-haiku-4-5-20251001';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['claude-haiku-4-5-20251001'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
    expect(result.rejected).toBe(true);
  });

  it('rejects gpt-5-nano (nano substring)', async () => {
    mockConfig.cloudReasoningFallback.provider = 'openai';
    mockConfig.cloudReasoningFallback.model = 'gpt-5-nano';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gpt-5-nano'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
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
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('disallowed_substring');
  });
});

describe('Quality gate — preview blocking', () => {
  it('rejects preview models by default', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-3.1-pro-preview';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-3.1-pro-preview'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('preview_blocked');
  });

  it('allows gemini-non-preview (explicit negation skips preview-block, v2.8 fix)', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-non-preview';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-non-preview'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
    expect(result.rejected).toBe(false);
    if (!result.rejected) expect(result.model).toBe('gemini-non-preview');
  });

  it('allows gemini-not-preview (explicit negation v2.8)', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-not-preview';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-not-preview'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
    expect(result.rejected).toBe(false);
  });

  it('still rejects gemini-pro-preview (no negation present)', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-pro-preview';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-pro-preview'];
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('preview_blocked');
  });

  it('allows preview models when opt-in flag is set', async () => {
    mockConfig.cloudReasoningFallback.model = 'gemini-3.1-pro-preview';
    mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-3.1-pro-preview'];
    mockConfig.cloudReasoningFallback.allowPreviewModels = true;
    const result = await selectApprovedCloudReasoningProvider({ prompt: 'x' }, getProviderFn);
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
      { prompt: 'x' },
      (name) => (name === 'gemini' ? fakeProvider('gemini') : null),
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('provider_unavailable');
  });
});
