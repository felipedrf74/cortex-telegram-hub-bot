// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Dispatch-level privacy E2E — v3.1.
 *
 * In v3.1 the gate's `privacyAction` narrows to `'sent_raw'` only —
 * the `'sent_redacted'` path was removed entirely after 5 of 6 review
 * rounds found leak bypasses. This test set verifies that the
 * dispatch layer (provider-fallback.ts `dispatchFallbackForOptionalMethod`)
 * forwards the prompt unchanged to the cloud provider when the gate
 * approves, and rejects (no SDK call) when the gate rejects.
 *
 * Two acceptance properties:
 *   1. When gate approves with `privacyAction='sent_raw'`, the cloud
 *      provider's `callDomain` receives the ORIGINAL `prompt` and the
 *      `modelOverride` matches the gate's selection.
 *   2. When gate rejects (e.g., private data + mode='redacted_only'),
 *      the cloud provider's `callDomain` is NEVER invoked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    ollama: { enabled: true, queue: { backend: 'memory' } },
    cloudReasoningFallback: {
      enabled: true, provider: 'gemini', model: 'gemini-2.5-pro',
      requireApprovedModel: true, allowPreviewModels: false,
      approvedReasoningModels: ['gemini-2.5-pro'],
      disallowedSubstrings: ['flash', 'nano', 'mini', 'haiku', 'lite'],
      onUnapproved: 'return_local_result_with_warning',
      privacy: { mode: 'redacted_only', allowRawPrivateData: false },
    },
    providerRouting: { circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 } },
    localLLMEvaluation: { enabled: true, showProviderMetadata: true, requireLocalForScriptGen: false },
    isStaging: true,
  },
}));

vi.mock('../../src/config', () => ({ config: mockConfig }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/utils/request-context', () => ({ getCurrentContext: () => ({}) }));
vi.mock('../../src/services/secretary-tools', () => ({
  planSecretaryOptimization: () => ({ modelTier: 'light' as const, slicedHistory: [] }),
}));
vi.mock('../../src/services/anthropic', () => ({
  TOOLS: [],
  getDomainSystemPrompt: (d: string) => `system:${d}`,
  getClassifierSystemPrompt: () => 'classifier',
}));

const cloudCallDomainSpy = vi.fn();
const cloudProvider = {
  name: 'gemini',
  classify: async () => ({ domain: 'content' as const, confidence: 1 }),
  callDomain: async (...args: unknown[]) => {
    cloudCallDomainSpy(...args);
    return { text: 'cloud reply', toolCalls: [], stopReason: 'stop' };
  },
  continueWithToolResults: async () => ({ text: 'cloud reply', toolCalls: [], stopReason: 'stop' }),
};

vi.mock('../../src/services/provider-registry', () => ({
  getProvider: (name: string) => (name === 'gemini' ? cloudProvider : null),
}));

vi.mock('../../src/services/cloud-reasoning-gate', async () => {
  return await vi.importActual('../../src/services/cloud-reasoning-gate');
});

import { LocalLLMError } from '../../src/services/local-llm-error';

// Primary fails so fallback path engages. No redactor mock needed in
// v3.1 because the gate doesn't ask the local model for anything.
const ollamaPrimaryThatFails = {
  name: 'ollama',
  classify: async () => ({ domain: 'content' as const, confidence: 1 }),
  callDomain: async () => ({ text: 'local', toolCalls: [], stopReason: 'stop' }),
  continueWithToolResults: async () => ({ text: 'local', toolCalls: [], stopReason: 'stop' }),
  localReason: async () => {
    throw new LocalLLMError('capacity_exceeded', { taskType: 'localReasoning', reason: 'synthetic_test_failure' });
  },
  generateScript: async () => { throw new Error('synthetic primary failure'); },
};

import { TaskRoutingProvider, type SentinelFallbackPair } from '../../src/services/provider-fallback';
import type { AIProvider } from '../../src/services/ai-provider';

beforeEach(() => {
  cloudCallDomainSpy.mockClear();
  mockConfig.cloudReasoningFallback.privacy.mode = 'redacted_only';
  mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = false;
});

describe('v3.1 dispatch — non-private + cloud-escalation → raw prompt to cloud', () => {
  it('cloud callDomain receives modelOverride=gemini-2.5-pro and the raw prompt', async () => {
    const pair: SentinelFallbackPair = {
      primary: ollamaPrimaryThatFails as unknown as AIProvider,
      fallback: 'approved_cloud_reasoning',
    };
    const trp = new TaskRoutingProvider({
      classify: { primary: ollamaPrimaryThatFails as unknown as AIProvider },
      chat: { primary: ollamaPrimaryThatFails as unknown as AIProvider },
      'tool-use': { primary: ollamaPrimaryThatFails as unknown as AIProvider },
      localReasoning: pair,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    const RAW = 'public question about TypeScript generic constraints';
    await trp.dispatchLocalReasoning({ prompt: RAW, containsPrivateData: false });

    expect(cloudCallDomainSpy).toHaveBeenCalledTimes(1);
    const args = cloudCallDomainSpy.mock.calls[0] as unknown[];
    // callDomain(domain, history, currentMessage, stateContext, opts)
    const sentPrompt = args[2] as string;
    expect(sentPrompt).toBe(RAW);
    const opts = args[4] as { modelOverride?: string };
    expect(opts.modelOverride).toBe('gemini-2.5-pro');
  });
});

describe('v3.1 dispatch — private + mode=redacted_only → cloud NEVER called', () => {
  it('private prompt with default redacted_only mode results in zero cloud SDK calls', async () => {
    const pair: SentinelFallbackPair = {
      primary: ollamaPrimaryThatFails as unknown as AIProvider,
      fallback: 'approved_cloud_reasoning',
    };
    const trp = new TaskRoutingProvider({
      classify: { primary: ollamaPrimaryThatFails as unknown as AIProvider },
      chat: { primary: ollamaPrimaryThatFails as unknown as AIProvider },
      'tool-use': { primary: ollamaPrimaryThatFails as unknown as AIProvider },
      localReasoning: pair,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    const RAW = 'felipe@example.com SSN 123-45-6789 AWS key AKIAIOSFODNN7EXAMPLE';
    await expect(
      trp.dispatchLocalReasoning({
        prompt: RAW,
        containsPrivateData: true,
        allowCloudEscalation: true,
      }),
    ).rejects.toThrow();

    // CRITICAL invariant: no cloud SDK call ever happened — the gate
    // rejected with redaction_unsupported because v3.1 removed the
    // redact-then-forward path.
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
  });
});

describe('v3.1 dispatch — private + mode=allow_raw + opt-in → cloud receives raw', () => {
  it('explicit raw-private opt-in forwards the original prompt to cloud', async () => {
    mockConfig.cloudReasoningFallback.privacy.mode = 'allow_raw';
    mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = true;
    const pair: SentinelFallbackPair = {
      primary: ollamaPrimaryThatFails as unknown as AIProvider,
      fallback: 'approved_cloud_reasoning',
    };
    const trp = new TaskRoutingProvider({
      classify: { primary: ollamaPrimaryThatFails as unknown as AIProvider },
      chat: { primary: ollamaPrimaryThatFails as unknown as AIProvider },
      'tool-use': { primary: ollamaPrimaryThatFails as unknown as AIProvider },
      localReasoning: pair,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    const RAW = 'felipe@example.com SSN 123-45-6789 — operator chose allow_raw deliberately';
    await trp.dispatchLocalReasoning({
      prompt: RAW,
      containsPrivateData: true,
      allowCloudEscalation: true,
    });

    expect(cloudCallDomainSpy).toHaveBeenCalledTimes(1);
    const args = cloudCallDomainSpy.mock.calls[0] as unknown[];
    const sentPrompt = args[2] as string;
    // In allow_raw the entire raw prompt is forwarded by design.
    expect(sentPrompt).toBe(RAW);
  });
});
