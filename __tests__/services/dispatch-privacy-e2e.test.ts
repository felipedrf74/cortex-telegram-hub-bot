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
 *   1. Public/pre-redacted work uses the provider-native, no-tools
 *      structured capability with the exact approved model.
 *   2. Private optional work is always rejected before any cloud SDK call,
 *      including when operator config drifts to allow_raw.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as nodeFs } from 'fs';
import { rm } from 'fs/promises';
import * as path from 'path';

const { mockConfig, mockAuditState, mockAuditInsert, mockRequestContext } = vi.hoisted(() => ({
  mockConfig: {
    ollama: {
      enabled: true,
      model: 'qwen2.5:3b-instruct-q4_K_M',
      queue: { backend: 'memory' },
      artifacts: { storePrompts: false },
    },
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
  mockAuditState: { insertFails: false },
  mockAuditInsert: vi.fn(),
  mockRequestContext: {
    value: {} as { userId?: number; tenantId?: number },
  },
}));

vi.mock('../../src/config', () => ({ config: mockConfig }));
vi.mock('../../src/services/database', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  );
  const requiredColumns = [
    'ts', 'user_id', 'tenant_id', 'provider', 'model', 'model_digest',
    'task_label', 'prompt_tokens', 'completion_tokens', 'duration_ms',
    'load_duration_ms', 'validation_status', 'fallback_used',
    'requires_cloud_reasoning', 'requires_human_approval', 'risk_level',
    'artifact_count', 'meta_json',
  ];
  const db = {
    prepare: (sql: string) => {
      if (sql.includes('sqlite_master')) return { get: () => ({ name: 'script_generation_runs' }) };
      if (sql.includes('PRAGMA table_info')) return { all: () => requiredColumns.map(name => ({ name })) };
      return {
        run: (...args: unknown[]) => {
          mockAuditInsert(...args);
          if (mockAuditState.insertFails) throw new Error('synthetic audit persistence failure');
          return { changes: 1 };
        },
      };
    },
  };
  return {
    ...actual,
    getDb: () => db,
  };
});
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/utils/request-context', () => ({
  generateRequestId: () => 'test-request-id',
  getCurrentContext: () => mockRequestContext.value,
  getCurrentRequestId: () => 'test-request-id',
  runWithContext: (_context: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../src/services/secretary-tools', () => ({
  SECRETARY_TOOL_PACKS: {},
  analyzeIntent: vi.fn(),
  getFilteredToolsForMessage: vi.fn(() => []),
  getToolPacksForMessage: vi.fn(() => []),
  planSecretaryOptimization: () => ({ modelTier: 'light' as const, slicedHistory: [] }),
  secretaryNeedsHeavyModel: vi.fn(() => false),
  secretaryNeedsSonnet: vi.fn(() => false),
}));
vi.mock('../../src/services/anthropic', () => ({
  TOOLS: [],
  getDomainSystemPrompt: (d: string) => `system:${d}`,
  getClassifierSystemPrompt: () => 'classifier',
}));

const cloudCallDomainSpy = vi.fn();
const cloudStructuredGenerationSpy = vi.fn();
const cloudResponseQueue: Array<{ text: string; toolCalls: unknown[]; stopReason: string }> = [];
const callCloudStructuredGeneration = async (request: unknown) => {
  cloudStructuredGenerationSpy(request);
  return cloudResponseQueue.shift() ?? { text: 'cloud reply', stopReason: 'stop' };
};
const cloudProvider = {
  name: 'gemini',
  classify: async () => ({ domain: 'content' as const, confidence: 1 }),
  callDomain: async (...args: unknown[]) => {
    cloudCallDomainSpy(...args);
    return cloudResponseQueue.shift() ?? { text: 'cloud reply', toolCalls: [], stopReason: 'stop' };
  },
  callStructuredGeneration: callCloudStructuredGeneration,
  continueWithToolResults: async () => ({ text: 'cloud reply', toolCalls: [], stopReason: 'stop' }),
};

vi.mock('../../src/services/provider-registry', () => ({
  getProvider: (name: string) => (name === 'gemini' ? cloudProvider : null),
  getActiveProvider: () => null,
  clearProviderCache: vi.fn(),
  createRoutingProvider: vi.fn(),
  ensureActiveProvider: vi.fn(),
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
  cloudStructuredGenerationSpy.mockClear();
  mockAuditInsert.mockClear();
  mockAuditState.insertFails = false;
  cloudResponseQueue.length = 0;
  mockRequestContext.value = {};
  cloudProvider.callStructuredGeneration = callCloudStructuredGeneration;
  mockConfig.localLLMEvaluation.enabled = true;
  mockConfig.localLLMEvaluation.requireLocalForScriptGen = false;
  mockConfig.cloudReasoningFallback.privacy.mode = 'redacted_only';
  mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = false;
});

afterEach(async () => {
  for (const runId of [
    'dispatch-cloud-script-test',
    'dispatch-cloud-audit-failure',
    'dispatch-cloud-finalization-cancelled',
    'dispatch-cloud-finalization-race',
  ]) {
    await rm(path.resolve('data/script-gen-runs', runId), { recursive: true, force: true });
  }
});

describe('small-only production dispatch', () => {
  it('keeps calibrated runtime roles local and gates offline evaluation independently', async () => {
    const localReason = vi.fn(async () => ({ text: 'local reply', stopReason: 'stop' }));
    const primary = { ...ollamaPrimaryThatFails, localReason } as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      localReasoning: {
        primary,
        fallback: 'approved_cloud_reasoning',
      },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    mockConfig.localLLMEvaluation.enabled = false;
    await expect(trp.dispatchLocalReasoning({
      workloadRole: 'validated_local_chat',
      prompt: 'bounded local chat',
    })).resolves.toMatchObject({ text: 'local reply' });
    await expect(trp.dispatchLocalReasoning({
      workloadRole: 'classifier_shadow',
      prompt: 'bounded classifier shadow',
    })).resolves.toMatchObject({ text: 'local reply' });
    expect(localReason).toHaveBeenCalledTimes(2);
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();

    await expect(trp.dispatchLocalReasoning({
      workloadRole: 'offline_evaluation',
      prompt: 'public offline evaluation',
      containsPrivateData: false,
    })).resolves.toMatchObject({ text: 'cloud reply' });
    expect(localReason).toHaveBeenCalledTimes(2);
    expect(cloudStructuredGenerationSpy).toHaveBeenCalledTimes(1);

    mockConfig.localLLMEvaluation.enabled = true;
    await expect(trp.dispatchLocalReasoning({
      workloadRole: 'offline_evaluation',
      prompt: 'enabled offline evaluation',
    })).resolves.toMatchObject({ text: 'local reply' });
    expect(localReason).toHaveBeenCalledTimes(3);

    await expect(trp.dispatchLocalReasoning({
      workloadRole: 'unapproved_generic_role',
      prompt: 'public generic reasoning',
      containsPrivateData: false,
    })).resolves.toMatchObject({ text: 'cloud reply' });
    expect(localReason).toHaveBeenCalledTimes(3);
    expect(cloudStructuredGenerationSpy).toHaveBeenCalledTimes(2);
  });

  it('requires both evaluation flags before script generation can execute locally', async () => {
    const generateScript = vi.fn(async () => ({ source: 'local' }));
    const primary = { ...ollamaPrimaryThatFails, generateScript } as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      scriptGeneration: { primary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });
    const task = {
      workloadRole: 'offline_evaluation',
      description: 'classification is intentionally absent',
    };

    mockConfig.localLLMEvaluation.enabled = true;
    mockConfig.localLLMEvaluation.requireLocalForScriptGen = false;
    await expect(trp.dispatchScriptGeneration(task)).rejects.toMatchObject({
      providerMetadata: { warning: 'privacy_classification_required' },
    });
    expect(generateScript).not.toHaveBeenCalled();

    mockConfig.localLLMEvaluation.requireLocalForScriptGen = true;
    await expect(trp.dispatchScriptGeneration(task)).resolves.toEqual({ source: 'local' });
    expect(generateScript).toHaveBeenCalledTimes(1);

    mockConfig.localLLMEvaluation.enabled = false;
    await expect(trp.dispatchScriptGeneration(task)).rejects.toMatchObject({
      providerMetadata: { warning: 'privacy_classification_required' },
    });
    expect(generateScript).toHaveBeenCalledTimes(1);
  });

  it('does not apply the Ollama cloud bypass to another provider or another fallback policy', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const otherLocalReason = vi.fn(async () => ({ text: 'other local' }));
    const otherPrimary = {
      ...ollamaPrimaryThatFails,
      name: 'test-local',
      localReason: otherLocalReason,
    } as unknown as AIProvider;
    const otherTrp = new TaskRoutingProvider({
      classify: { primary: otherPrimary },
      chat: { primary: otherPrimary },
      'tool-use': { primary: otherPrimary },
      localReasoning: { primary: otherPrimary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    await expect(otherTrp.dispatchLocalReasoning({
      workloadRole: 'unapproved_generic_role',
      prompt: 'kept on the configured non-Ollama provider',
    })).resolves.toEqual({ text: 'other local' });
    expect(otherLocalReason).toHaveBeenCalledTimes(1);
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();

    const ollamaLocalReason = vi.fn(async () => ({ text: 'ollama local' }));
    const ollamaPrimary = {
      ...ollamaPrimaryThatFails,
      localReason: ollamaLocalReason,
    } as unknown as AIProvider;
    const noneFallbackTrp = new TaskRoutingProvider({
      classify: { primary: ollamaPrimary },
      chat: { primary: ollamaPrimary },
      'tool-use': { primary: ollamaPrimary },
      localReasoning: { primary: ollamaPrimary, fallback: 'none' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    await expect(noneFallbackTrp.dispatchLocalReasoning({
      workloadRole: 'unapproved_generic_role',
      prompt: 'kept local because cloud fallback is disabled',
    })).resolves.toEqual({ text: 'ollama local' });
    expect(ollamaLocalReason).toHaveBeenCalledTimes(1);
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();
  });

  it('goes directly through the approved cloud gate when local reasoning evaluation is disabled', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const localReason = vi.fn(async () => {
      throw new Error('disabled local reasoning must not be invoked');
    });
    const primary = { ...ollamaPrimaryThatFails, localReason } as unknown as AIProvider;
    const pair: SentinelFallbackPair = {
      primary,
      fallback: 'approved_cloud_reasoning',
    };
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      localReasoning: pair,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    await trp.dispatchLocalReasoning({
      prompt: 'public architecture question',
      containsPrivateData: false,
    });

    expect(localReason).not.toHaveBeenCalled();
    expect(cloudStructuredGenerationSpy).toHaveBeenCalledTimes(1);
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
  });

  it('keeps validated private local chat fail-closed when Ollama is rollback-disabled', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const unavailableLocal = {
      ...ollamaPrimaryThatFails,
      name: 'unavailable:ollama',
    } as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary: unavailableLocal },
      chat: { primary: unavailableLocal },
      'tool-use': { primary: unavailableLocal },
      localReasoning: {
        primary: unavailableLocal,
        fallback: 'approved_cloud_reasoning',
      },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    await expect(trp.dispatchLocalReasoning({
      workloadRole: 'validated_local_chat',
      prompt: 'private local chat',
      containsPrivateData: true,
      allowCloudEscalation: true,
    })).rejects.toMatchObject({
      code: 'VALIDATED_LOCAL_CHAT_LOCAL_PROVIDER_UNAVAILABLE',
    });
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
  });

  it('narrows a generic cloud completion to the LocalReasoningResult contract', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      localReasoning: {
        primary,
        fallback: 'approved_cloud_reasoning',
      },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    const result = await trp.dispatchLocalReasoning({
      prompt: 'public architecture question',
      containsPrivateData: false,
    }) as Record<string, unknown>;

    expect(result.text).toBe('cloud reply');
    expect(result.stopReason).toBe('stop');
    expect(result).not.toHaveProperty('toolCalls');
    expect(result.providerMetadata).toMatchObject({
      providerUsed: 'gemini',
      modelUsed: 'gemini-2.5-pro',
      fallbackUsed: true,
      privacyAction: 'sent_raw',
    });
    expect(cloudStructuredGenerationSpy).toHaveBeenCalledWith(expect.objectContaining({
      category: 'cloud_local_reasoning',
      model: 'gemini-2.5-pro',
      responseFormat: 'text',
      userPrompt: 'public architecture question',
    }));
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
  });

  it('enforces every local-reasoning input and cloud-response boundary', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      localReasoning: { primary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    await expect(trp.dispatchLocalReasoning({
      containsPrivateData: false,
    })).rejects.toMatchObject({
      code: 'CLOUD_LOCAL_REASONING_CONTRACT_INVALID',
      reason: 'missing_prompt',
    });
    await expect(trp.dispatchLocalReasoning({
      prompt: '   ',
      containsPrivateData: false,
    })).rejects.toMatchObject({
      code: 'CLOUD_LOCAL_REASONING_CONTRACT_INVALID',
      reason: 'missing_prompt',
    });
    await expect(trp.dispatchLocalReasoning({
      prompt: 'public request',
      systemContext: 42,
      containsPrivateData: false,
    })).rejects.toMatchObject({
      code: 'CLOUD_LOCAL_REASONING_CONTRACT_INVALID',
      reason: 'invalid_system_context',
    });

    (cloudProvider as {
      callStructuredGeneration?: typeof callCloudStructuredGeneration;
    }).callStructuredGeneration = undefined;
    await expect(trp.dispatchLocalReasoning({
      prompt: 'public request',
      containsPrivateData: false,
    })).rejects.toMatchObject({
      code: 'CLOUD_LOCAL_REASONING_CONTRACT_INVALID',
      reason: 'structured_generation_capability_missing',
    });
    cloudProvider.callStructuredGeneration = callCloudStructuredGeneration;

    cloudResponseQueue.push({
      text: undefined as unknown as string,
      toolCalls: [],
      stopReason: 'stop',
    });
    await expect(trp.dispatchLocalReasoning({
      prompt: 'public request',
      containsPrivateData: false,
    })).rejects.toMatchObject({
      code: 'CLOUD_LOCAL_REASONING_CONTRACT_INVALID',
      reason: 'missing_text',
    });

    cloudResponseQueue.push({
      text: 'partial answer',
      toolCalls: [],
      stopReason: 'max_tokens',
    });
    await expect(trp.dispatchLocalReasoning({
      prompt: 'public request',
      containsPrivateData: false,
    })).rejects.toMatchObject({
      code: 'CLOUD_LOCAL_REASONING_CONTRACT_INVALID',
      reason: 'truncated_output',
    });

    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
      properties: { answer: { type: 'string' } },
    } as const;
    cloudResponseQueue.push({
      text: 'not-json',
      toolCalls: [],
      stopReason: 'stop',
    });
    await expect(trp.dispatchLocalReasoning({
      prompt: 'public request',
      outputSchema: schema,
      containsPrivateData: false,
    })).rejects.toMatchObject({
      code: 'CLOUD_LOCAL_REASONING_CONTRACT_INVALID',
      reason: 'invalid_json',
    });

    expect(trp.getProviderHealth()['gemini'].metrics).toMatchObject({
      fallbackTriggerCount: 4,
      usageCount: 4,
      failureCount: 4,
    });
  });

  it('normalizes identity and token bounds and omits absent optional response fields', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      localReasoning: { primary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    mockRequestContext.value = { userId: 42.9, tenantId: 88.8 };
    await trp.dispatchLocalReasoning({
      prompt: 'bounded from context',
      containsPrivateData: false,
      numPredict: 9000,
    });
    expect(cloudStructuredGenerationSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      userId: 42,
      tenantId: 88,
      maxTokens: 4096,
      responseFormat: 'text',
      systemPrompt: 'You are an expert reasoning assistant.\n\nUse no tools or external state. Return only the requested answer.',
    }));
    expect(cloudStructuredGenerationSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('jsonSchema');

    mockRequestContext.value = { userId: -5.3 };
    await trp.dispatchLocalReasoning({
      prompt: 'bounded negative context',
      containsPrivateData: false,
      numPredict: 0,
    });
    expect(cloudStructuredGenerationSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      userId: 0,
      tenantId: 0,
      maxTokens: 2048,
    }));

    mockRequestContext.value = {};
    await trp.dispatchLocalReasoning({
      prompt: 'bounded explicit identity',
      containsPrivateData: false,
      userId: 7.9,
      tenantId: Number.NaN,
      numPredict: 12.9,
    });
    expect(cloudStructuredGenerationSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      userId: 7,
      tenantId: 7,
      maxTokens: 12,
    }));

    cloudResponseQueue.push({
      text: 'answer without a stop reason',
      toolCalls: [],
    } as unknown as { text: string; toolCalls: unknown[]; stopReason: string });
    const result = await trp.dispatchLocalReasoning({
      prompt: 'omit absent stop reason',
      containsPrivateData: false,
    }) as Record<string, unknown>;
    expect(result.text).toBe('answer without a stop reason');
    expect(result).not.toHaveProperty('stopReason');
    expect(trp.getProviderHealth()['gemini'].metrics).toMatchObject({
      fallbackTriggerCount: 4,
      usageCount: 4,
      failureCount: 0,
    });
  });

  it('uses provider JSON mode and enforces the supplied schema before returning parsed output', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      localReasoning: { primary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
      properties: { answer: { type: 'string', minLength: 1 } },
    } as const;
    cloudResponseQueue.push({
      text: JSON.stringify({ answer: 'bounded result' }),
      toolCalls: [],
      stopReason: 'stop',
    });

    const result = await trp.dispatchLocalReasoning({
      prompt: 'return one bounded answer',
      systemContext: 'Follow the public architecture rubric.',
      outputSchema: schema,
      containsPrivateData: false,
      userId: 306,
      tenantId: 901,
      numPredict: 777,
    }) as Record<string, unknown>;

    expect(result.parsed).toEqual({ answer: 'bounded result' });
    expect(cloudStructuredGenerationSpy).toHaveBeenCalledWith(expect.objectContaining({
      category: 'cloud_local_reasoning',
      model: 'gemini-2.5-pro',
      maxTokens: 777,
      userId: 306,
      tenantId: 901,
      responseFormat: 'json',
      jsonSchema: schema,
      userPrompt: 'return one bounded answer',
    }));
    const [request] = cloudStructuredGenerationSpy.mock.calls[0];
    expect(request.systemPrompt).toContain('Follow the public architecture rubric.');
    expect(request.systemPrompt).toContain('JSON schema:');
    expect(request).not.toHaveProperty('tools');

    cloudStructuredGenerationSpy.mockClear();
    cloudResponseQueue.push({
      text: JSON.stringify({ unexpected: 'not allowed' }),
      toolCalls: [],
      stopReason: 'stop',
    });
    await expect(trp.dispatchLocalReasoning({
      prompt: 'return one bounded answer',
      outputSchema: schema,
      containsPrivateData: false,
    })).rejects.toMatchObject({
      code: 'CLOUD_LOCAL_REASONING_CONTRACT_INVALID',
      reason: 'required_property_missing',
    });
  });

  it('rejects unsupported output-schema keywords before the cloud SDK boundary', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      localReasoning: { primary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    await expect(trp.dispatchLocalReasoning({
      prompt: 'public request',
      containsPrivateData: false,
      outputSchema: { type: 'string', format: 'email' },
    })).rejects.toMatchObject({
      code: 'CLOUD_LOCAL_REASONING_CONTRACT_INVALID',
      reason: 'unsupported_schema_keyword',
    });
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
  });

  it('uses the approved provider/model through the two-pass ScriptGen adapter', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      scriptGeneration: {
        primary,
        fallback: 'approved_cloud_reasoning',
      },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    const plan = {
      plan: ['Create a release helper'],
      files_to_create: ['release-helper.md'],
      files_to_modify: [],
      commands_to_run: [],
      risk_level: 'low',
      requires_cloud_reasoning: true,
      requires_human_approval: false,
    } as const;
    cloudResponseQueue.push(
      { text: JSON.stringify(plan), toolCalls: [], stopReason: 'stop' },
      {
        text: JSON.stringify({
          ...plan,
          artifacts: [{ path: 'release-helper.md', kind: 'markdown', content: '# Release helper\n' }],
          validation_steps: [],
        }),
        toolCalls: [],
        stopReason: 'stop',
      },
    );

    const result = await trp.dispatchScriptGeneration({
      description: 'create a release helper',
      domainContext: 'PUBLIC_DOMAIN_CONTEXT_MARKER',
      containsPrivateData: false,
      runId: 'dispatch-cloud-script-test',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      run_id: 'dispatch-cloud-script-test',
      validation_status: 'passed',
    });
    expect(cloudStructuredGenerationSpy).toHaveBeenCalledTimes(2);
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
    for (const [request] of cloudStructuredGenerationSpy.mock.calls) {
      expect(request).toMatchObject({
        model: 'gemini-2.5-pro',
        userId: 0,
        tenantId: 0,
      });
      expect(request.userPrompt).toContain('PUBLIC_DOMAIN_CONTEXT_MARKER');
      expect(request.systemPrompt).not.toContain('PUBLIC_DOMAIN_CONTEXT_MARKER');
      expect(request).not.toHaveProperty('tools');
    }
  });

  it('forwards cancellation into approved-cloud ScriptGen and never starts its second pass', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      scriptGeneration: { primary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('account deletion in progress'), {
      name: 'AbortError',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    const plan = {
      plan: ['Create a release helper'],
      files_to_create: [],
      files_to_modify: [],
      commands_to_run: [],
      risk_level: 'low',
      requires_cloud_reasoning: true,
      requires_human_approval: false,
    };
    cloudProvider.callStructuredGeneration = async (request: unknown) => {
      cloudStructuredGenerationSpy(request);
      controller.abort(cancellation);
      return { text: JSON.stringify(plan), toolCalls: [], stopReason: 'stop' };
    };

    await expect(trp.dispatchScriptGeneration({
      description: 'create a release helper',
      containsPrivateData: false,
      abortSignal: controller.signal,
    })).rejects.toBe(cancellation);

    expect(cloudStructuredGenerationSpy).toHaveBeenCalledTimes(1);
    expect(cloudStructuredGenerationSpy.mock.calls[0]?.[0]).toMatchObject({
      abortSignal: controller.signal,
    });
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
  });

  it('cancels shared ScriptGen finalization, removes invocation-owned artifacts, and skips audit persistence', async () => {
    const {
      parseApprovedCloudScriptGenerationTask,
      runApprovedCloudScriptGenerationPipeline,
    } = await import('../../src/services/script-generation');
    const { approveCloudScriptGeneration } = await import('../../src/services/cloud-reasoning-gate');
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('client disconnected during finalization'), {
      name: 'AbortError',
      code: 'CHAT_REQUEST_CANCELLED',
    });
    const task = parseApprovedCloudScriptGenerationTask({
      description: 'create a cancellable public helper',
      containsPrivateData: false,
      runId: 'dispatch-cloud-finalization-cancelled',
    });
    const plan = {
      plan: ['Create helper'],
      files_to_create: ['cancelled-helper.md'],
      files_to_modify: [],
      commands_to_run: [],
      risk_level: 'low',
      requires_cloud_reasoning: true,
      requires_human_approval: false,
    };
    cloudResponseQueue.push(
      { text: JSON.stringify(plan), toolCalls: [], stopReason: 'stop' },
      {
        text: JSON.stringify({
          ...plan,
          artifacts: [{ path: 'cancelled-helper.md', kind: 'markdown', content: '# cancelled\n' }],
          validation_steps: [],
        }),
        toolCalls: [],
        stopReason: 'stop',
      },
    );
    const approval = await approveCloudScriptGeneration(task, () => cloudProvider as AIProvider);
    if (!('permit' in approval)) throw new Error('expected approved cloud ScriptGen permit');

    const originalMkdir = nodeFs.mkdir.bind(nodeFs) as (...args: any[]) => Promise<any>;
    const mkdirSpy = vi.spyOn(nodeFs, 'mkdir').mockImplementation(async (...args: any[]) => {
      const [target] = args;
      const result = await originalMkdir(...args);
      if (String(target).endsWith(`${path.sep}sandbox`)) controller.abort(cancellation);
      return result;
    });

    try {
      await expect(runApprovedCloudScriptGenerationPipeline(
        task,
        approval.permit,
        { abortSignal: controller.signal },
      )).rejects.toBe(cancellation);
    } finally {
      mkdirSpy.mockRestore();
    }

    expect(mockAuditInsert).not.toHaveBeenCalled();
    await expect(nodeFs.access(path.resolve(
      'data/script-gen-runs/dispatch-cloud-finalization-cancelled/sandbox',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a same-run artifact created by another writer when cancellation loses the exclusive-create race', async () => {
    const {
      parseApprovedCloudScriptGenerationTask,
      runApprovedCloudScriptGenerationPipeline,
    } = await import('../../src/services/script-generation');
    const { approveCloudScriptGeneration } = await import('../../src/services/cloud-reasoning-gate');
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('cancelled after competing artifact create'), {
      name: 'AbortError',
      code: 'CHAT_REQUEST_CANCELLED',
    });
    const task = parseApprovedCloudScriptGenerationTask({
      description: 'create a public helper without deleting a competing artifact',
      containsPrivateData: false,
      runId: 'dispatch-cloud-finalization-race',
    });
    const plan = {
      plan: ['Create helper'],
      files_to_create: ['winner.md'],
      files_to_modify: [],
      commands_to_run: [],
      risk_level: 'low',
      requires_cloud_reasoning: true,
      requires_human_approval: false,
    };
    cloudResponseQueue.push(
      { text: JSON.stringify(plan), toolCalls: [], stopReason: 'stop' },
      {
        text: JSON.stringify({
          ...plan,
          artifacts: [{ path: 'winner.md', kind: 'markdown', content: '# model output\n' }],
          validation_steps: [],
        }),
        toolCalls: [],
        stopReason: 'stop',
      },
    );
    const approval = await approveCloudScriptGeneration(task, () => cloudProvider as AIProvider);
    if (!('permit' in approval)) throw new Error('expected approved cloud ScriptGen permit');

    const artifactPath = path.resolve(
      'data/script-gen-runs/dispatch-cloud-finalization-race/sandbox/winner.md',
    );
    const originalWriteFile = nodeFs.writeFile.bind(nodeFs) as (...args: any[]) => Promise<any>;
    let competingWriteInjected = false;
    const writeFileSpy = vi.spyOn(nodeFs, 'writeFile').mockImplementation(async (...args: any[]) => {
      const [target] = args;
      if (!competingWriteInjected && String(target) === artifactPath) {
        competingWriteInjected = true;
        await originalWriteFile(artifactPath, '# competing writer\n', { flag: 'wx' });
        controller.abort(cancellation);
      }
      return originalWriteFile(...args);
    });

    try {
      await expect(runApprovedCloudScriptGenerationPipeline(
        task,
        approval.permit,
        { abortSignal: controller.signal },
      )).rejects.toBe(cancellation);
    } finally {
      writeFileSpy.mockRestore();
    }

    await expect(nodeFs.readFile(artifactPath, 'utf8')).resolves.toBe('# competing writer\n');
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('fails closed after one bounded retry when cloud JSON is invalid', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      scriptGeneration: { primary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });
    cloudResponseQueue.push(
      { text: 'not-json', toolCalls: [], stopReason: 'stop' },
      { text: 'still-not-json', toolCalls: [], stopReason: 'stop' },
    );

    await expect(trp.dispatchScriptGeneration({
      description: 'create a release helper',
      containsPrivateData: false,
    })).rejects.toMatchObject({
      code: 'CLOUD_SCRIPT_GENERATION_CONTRACT_INVALID',
      reason: 'plan_json_parse_failure',
    });
    expect(cloudStructuredGenerationSpy).toHaveBeenCalledTimes(2);
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
  });

  it('fails closed on extra schema properties and on missing privacy classification', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      scriptGeneration: { primary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });
    const invalidPlan = {
      plan: ['Create helper'],
      files_to_create: [],
      files_to_modify: [],
      commands_to_run: [],
      risk_level: 'low',
      requires_cloud_reasoning: true,
      requires_human_approval: false,
      unexpected: 'must be rejected',
    };
    cloudResponseQueue.push(
      { text: JSON.stringify(invalidPlan), toolCalls: [], stopReason: 'stop' },
      { text: JSON.stringify(invalidPlan), toolCalls: [], stopReason: 'stop' },
    );

    await expect(trp.dispatchScriptGeneration({
      description: 'create a release helper',
      containsPrivateData: false,
    })).rejects.toMatchObject({
      code: 'CLOUD_SCRIPT_GENERATION_CONTRACT_INVALID',
      reason: 'plan_additional_properties_forbidden',
    });
    expect(cloudStructuredGenerationSpy).toHaveBeenCalledTimes(2);
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();

    cloudStructuredGenerationSpy.mockClear();
    await expect(trp.dispatchScriptGeneration({
      description: 'classification is mandatory',
    })).rejects.toMatchObject({
      providerMetadata: {
        fallbackUsed: false,
        warning: 'privacy_classification_required',
      },
    });
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();
  });

  it('rejects a structurally fabricated approval permit', async () => {
    const {
      parseApprovedCloudScriptGenerationTask,
      runApprovedCloudScriptGenerationPipeline,
    } = await import('../../src/services/script-generation');
    const task = parseApprovedCloudScriptGenerationTask({
      description: 'must not run locally',
      containsPrivateData: false,
    });

    await expect(runApprovedCloudScriptGenerationPipeline(
      task,
      Object.freeze({}) as never,
    )).rejects.toMatchObject({
      code: 'CLOUD_SCRIPT_GENERATION_CONTRACT_INVALID',
      reason: 'approval_invalid',
    });
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();
  });

  it('binds a one-use approval to the exact complete payload', async () => {
    const {
      parseApprovedCloudScriptGenerationTask,
      runApprovedCloudScriptGenerationPipeline,
    } = await import('../../src/services/script-generation');
    const { approveCloudScriptGeneration } = await import('../../src/services/cloud-reasoning-gate');
    const task = parseApprovedCloudScriptGenerationTask({
      description: 'create a public helper',
      domainContext: 'public repository conventions',
      containsPrivateData: false,
    });
    const approval = await approveCloudScriptGeneration(task, () => cloudProvider as AIProvider);
    expect(approval.rejected).toBe(false);
    if (approval.rejected) throw new Error('expected approval');

    await expect(runApprovedCloudScriptGenerationPipeline(
      { ...task, domainContext: 'private tenant context added after approval' },
      approval.permit,
    )).rejects.toMatchObject({
      code: 'CLOUD_SCRIPT_GENERATION_CONTRACT_INVALID',
      reason: 'approval_payload_mismatch',
    });
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();
  });

  it('cannot mint a private ScriptGen approval while privacy mode is never', async () => {
    const { parseApprovedCloudScriptGenerationTask } = await import('../../src/services/script-generation');
    const { approveCloudScriptGeneration } = await import('../../src/services/cloud-reasoning-gate');
    mockConfig.cloudReasoningFallback.privacy.mode = 'never';
    const task = parseApprovedCloudScriptGenerationTask({
      description: 'create a helper',
      domainContext: 'DISALLOWED_PRIVATE_MARKER tenant secret context',
      containsPrivateData: true,
      allowCloudEscalation: true,
    });

    const approval = await approveCloudScriptGeneration(task, () => cloudProvider as AIProvider);
    expect(approval).toMatchObject({ rejected: true, reason: 'privacy_never' });
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();
  });

  it('blocks private ScriptGen even if operator config drifts to allow_raw', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    mockConfig.cloudReasoningFallback.privacy.mode = 'allow_raw';
    mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = true;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      scriptGeneration: { primary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });

    await expect(trp.dispatchScriptGeneration({
      description: 'generate from private tenant context',
      domainContext: 'PRIVATE_SCRIPT_MARKER',
      containsPrivateData: true,
      allowCloudEscalation: true,
    })).rejects.toMatchObject({ code: 'PRIVATE_OPTIONAL_CLOUD_WORKLOAD_FORBIDDEN' });
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
  });

  it('fails closed when the successful cloud artifact audit row cannot persist', async () => {
    mockConfig.localLLMEvaluation.enabled = false;
    mockAuditState.insertFails = true;
    const primary = ollamaPrimaryThatFails as unknown as AIProvider;
    const trp = new TaskRoutingProvider({
      classify: { primary },
      chat: { primary },
      'tool-use': { primary },
      scriptGeneration: { primary, fallback: 'approved_cloud_reasoning' },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    });
    const plan = {
      plan: ['Create helper'],
      files_to_create: ['audit-helper.md'],
      files_to_modify: [],
      commands_to_run: [],
      risk_level: 'low',
      requires_cloud_reasoning: true,
      requires_human_approval: false,
    };
    cloudResponseQueue.push(
      { text: JSON.stringify(plan), toolCalls: [], stopReason: 'stop' },
      {
        text: JSON.stringify({
          ...plan,
          artifacts: [{ path: 'audit-helper.md', kind: 'markdown', content: '# Audit helper\n' }],
          validation_steps: [],
        }),
        toolCalls: [],
        stopReason: 'stop',
      },
    );

    await expect(trp.dispatchScriptGeneration({
      description: 'create audited helper',
      containsPrivateData: false,
      runId: 'dispatch-cloud-audit-failure',
    })).rejects.toMatchObject({
      code: 'CLOUD_SCRIPT_GENERATION_CONTRACT_INVALID',
      reason: 'audit_persistence_failed',
    });
    expect(mockAuditInsert).toHaveBeenCalledTimes(1);
  });
});

describe('v3.1 dispatch — non-private + cloud-escalation → isolated cloud reasoning', () => {
  it('structured generation receives the exact approved model and raw user prompt', async () => {
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

    expect(cloudStructuredGenerationSpy).toHaveBeenCalledTimes(1);
    expect(cloudStructuredGenerationSpy).toHaveBeenCalledWith(expect.objectContaining({
      category: 'cloud_local_reasoning',
      model: 'gemini-2.5-pro',
      responseFormat: 'text',
      userPrompt: RAW,
    }));
    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
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
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();
  });
});

describe('v3.1 dispatch — private optional work stays blocked under allow_raw drift', () => {
  it('rejects generic larger reasoning before any cloud SDK call', async () => {
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
    await expect(trp.dispatchLocalReasoning({
      prompt: RAW,
      containsPrivateData: true,
      allowCloudEscalation: true,
    })).rejects.toMatchObject({ code: 'PRIVATE_OPTIONAL_CLOUD_WORKLOAD_FORBIDDEN' });

    expect(cloudCallDomainSpy).not.toHaveBeenCalled();
    expect(cloudStructuredGenerationSpy).not.toHaveBeenCalled();
  });
});
