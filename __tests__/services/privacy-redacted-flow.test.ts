// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Privacy-redacted-flow E2E (mocked) — v3.1 architectural pivot.
 *
 * History: v1.0–v3.0 tried to ship a "redact-then-forward" path on the
 * cloud escalation. Codex broke every implementation in 5 of 6 review
 * rounds because PII coverage is structurally infinite and any deny-list
 * treats unmatched bytes as safe.
 *
 * v3.1 removes the redactor entirely. The gate's privacy policy for
 * `containsPrivateData=true` is fully fail-closed unless the operator
 * EXPLICITLY opts in to raw forwarding via
 * `mode='allow_raw' + allowRawPrivateData=true + allowCloudEscalation=true`.
 *
 * This file verifies:
 *   1. `mode='redacted_only'` ALWAYS REJECTS with
 *      `reason='redaction_unsupported'` and warning
 *      `'redaction_path_disabled_v3_1'`.
 *   2. `mode='never'` ALWAYS REJECTS with `reason='privacy_never'`.
 *   3. `mode='allow_raw'` + opt-in flags → forwards raw.
 *   4. Missing `allowCloudEscalation` always rejects regardless of mode.
 *   5. Non-private requests (`containsPrivateData=false`) forward raw.
 *   6. The gate's logger output for rejections contains NO raw prompt
 *      bytes (F2 from Codex round 6).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, mockLogger } = vi.hoisted(() => ({
  mockConfig: {
    ollama: {
      enabled: true,
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:3b-instruct-q4_K_M',
      classifierModel: 'qwen2.5:3b-instruct-q4_K_M',
      timeoutMs: 5000,
      tokenCaps: {
        classifyMaxInput: 1500, classifyMaxOutput: 128,
        scriptGenMaxInput: 6000, scriptGenMaxOutput: 4096,
        localReasoningMaxInput: 6000, localReasoningMaxOutput: 3000,
      },
      queue: {
        backend: 'memory',
        classifyDepth: 4, scriptGenDepth: 2, localReasoningDepth: 2,
        classifyMaxWaitMs: 5000, scriptGenMaxWaitMs: 30000, localReasoningMaxWaitMs: 30000,
        globalMaxDepth: 8,
      },
      rateLimit: { perUserDaily: 0, perUserHourly: 0, scriptGenPerUserDaily: 0 },
      artifacts: { retentionDays: 14, storePrompts: false, storeGenerated: true },
    },
    cloudReasoningFallback: {
      enabled: true,
      provider: 'gemini' as string,
      model: 'gemini-2.5-pro' as string,
      requireApprovedModel: true,
      allowPreviewModels: false,
      approvedReasoningModels: ['gemini-2.5-pro'] as string[],
      disallowedSubstrings: ['flash', 'nano', 'mini', 'haiku', 'lite'] as string[],
      onUnapproved: 'return_local_result_with_warning' as string,
      privacy: { mode: 'redacted_only' as string, allowRawPrivateData: false },
    },
    providerRouting: { circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 } },
    localLLMEvaluation: { enabled: true, showProviderMetadata: true, requireLocalForScriptGen: false },
  },
  mockLogger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('../../src/config', () => ({ config: mockConfig }));
vi.mock('../../src/utils/logger', () => ({ logger: mockLogger, LOGGER_REDACTION_PATHS: [] }));
vi.mock('../../src/utils/request-context', () => ({
  generateRequestId: () => 'test-request-id',
  getCurrentContext: () => ({}),
  getCurrentRequestId: () => 'test-request-id',
  runWithContext: (_context: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../src/services/ollama-provider', () => ({
  OllamaProvider: class { name = 'ollama'; },
  isOllamaConfigured: () => true,
  normalizeClassificationPayload: (payload: unknown) => payload,
  stripThinkBlocks: (text: string | null | undefined): string => String(text ?? ''),
}));

import { selectApprovedCloudReasoningProvider } from '../../src/services/cloud-reasoning-gate';
import type { AIProvider, AICallResult } from '../../src/services/ai-provider';

const RAW_PII_PROMPT = 'Email felipe@example.com and SSN 123-45-6789 are in our notes; please advise on the auth refactor. AWS key AKIAIOSFODNN7EXAMPLE was also leaked.';

const cloudCallSpy = vi.fn<(...args: unknown[]) => Promise<AICallResult>>();
function makeCloudProvider(name: string): AIProvider {
  cloudCallSpy.mockResolvedValue({ text: 'cloud answered', toolCalls: [], stopReason: 'stop' });
  return {
    name,
    classify: async () => ({ domain: 'content', confidence: 1 }),
    callDomain: async (...args: unknown[]) => cloudCallSpy(...args),
    continueWithToolResults: async () => ({ text: 'ok', toolCalls: [], stopReason: 'stop' }),
  };
}

beforeEach(() => {
  cloudCallSpy.mockReset();
  cloudCallSpy.mockResolvedValue({ text: 'cloud answered', toolCalls: [], stopReason: 'stop' });
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  mockLogger.debug.mockReset();
  // Restore default config (deep)
  mockConfig.cloudReasoningFallback.privacy.mode = 'redacted_only';
  mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = false;
  mockConfig.cloudReasoningFallback.enabled = true;
  mockConfig.cloudReasoningFallback.model = 'gemini-2.5-pro';
  mockConfig.cloudReasoningFallback.approvedReasoningModels = ['gemini-2.5-pro'];
});

describe('v3.1 Privacy gate — redacted_only path is REMOVED (fail-closed)', () => {
  it('mode=redacted_only + containsPrivateData=true + allowCloudEscalation=true → REJECT redaction_unsupported', async () => {
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: RAW_PII_PROMPT, containsPrivateData: true, allowCloudEscalation: true },
      (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) {
      expect(result.reason).toBe('redaction_unsupported');
      expect(result.warning).toBe('redaction_path_disabled_v3_1');
    }
  });

  it('mode=redacted_only + redactionRequired=true → still REJECT (redactionRequired has no effect)', async () => {
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: RAW_PII_PROMPT, containsPrivateData: true, allowCloudEscalation: true, redactionRequired: true },
      (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('redaction_unsupported');
  });

  it('rejection logger output contains NO raw prompt bytes (F2 Codex round 6)', async () => {
    await selectApprovedCloudReasoningProvider(
      { prompt: 'felipe@example.com AKIAIOSFODNN7EXAMPLE secret_payload', containsPrivateData: true, allowCloudEscalation: true },
      (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
    );
    // Walk every warn/error/info call and assert no raw bytes appear.
    const allArgs: string[] = [];
    for (const fn of [mockLogger.warn, mockLogger.error, mockLogger.info, mockLogger.debug]) {
      for (const call of fn.mock.calls as unknown[][]) {
        for (const arg of call) {
          allArgs.push(JSON.stringify(arg));
        }
      }
    }
    const combined = allArgs.join('\n');
    expect(combined).not.toContain('felipe@example.com');
    expect(combined).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(combined).not.toContain('secret_payload');
  });
});

describe('v3.1 Privacy gate — never mode always rejects private', () => {
  it('mode=never blocks all private data regardless of escalation flag', async () => {
    mockConfig.cloudReasoningFallback.privacy.mode = 'never';
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: RAW_PII_PROMPT, containsPrivateData: true, allowCloudEscalation: true },
      (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('privacy_never');
  });

  it('mode=never blocks private even without allowCloudEscalation', async () => {
    mockConfig.cloudReasoningFallback.privacy.mode = 'never';
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: RAW_PII_PROMPT, containsPrivateData: true },
      (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('privacy_never');
  });
});

describe('v3.1 Privacy gate — allow_raw is the only forward-private path', () => {
  it('mode=allow_raw + allowRawPrivateData + allowCloudEscalation → sent_raw', async () => {
    mockConfig.cloudReasoningFallback.privacy.mode = 'allow_raw';
    mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = true;
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: RAW_PII_PROMPT, containsPrivateData: true, allowCloudEscalation: true },
      (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
    );
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.privacyAction).toBe('sent_raw');
    }
  });

  it('mode=allow_raw + allowRawPrivateData=false → REJECT privacy_default_block', async () => {
    mockConfig.cloudReasoningFallback.privacy.mode = 'allow_raw';
    mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = false;
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: RAW_PII_PROMPT, containsPrivateData: true, allowCloudEscalation: true },
      (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('privacy_default_block');
  });

  it('mode=allow_raw + allowRawPrivateData + missing allowCloudEscalation → REJECT', async () => {
    mockConfig.cloudReasoningFallback.privacy.mode = 'allow_raw';
    mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = true;
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: RAW_PII_PROMPT, containsPrivateData: true /* no allowCloudEscalation */ },
      (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) expect(result.reason).toBe('request_disallows_cloud');
  });
});

describe('v3.1 Privacy gate — explicitly non-private requests forward raw', () => {
  it('containsPrivateData=false + mode=redacted_only → sent_raw (mode only matters for private)', async () => {
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'general public question about TypeScript', containsPrivateData: false },
      (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
    );
    expect(result.rejected).toBe(false);
    if (!result.rejected) {
      expect(result.privacyAction).toBe('sent_raw');
    }
  });

  it('omitting containsPrivateData entirely → rejects unknown privacy classification', async () => {
    const result = await selectApprovedCloudReasoningProvider(
      { prompt: 'general public question' } as unknown as Parameters<typeof selectApprovedCloudReasoningProvider>[0],
      (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
    );
    expect(result.rejected).toBe(true);
    if (result.rejected) {
      expect(result.reason).toBe('privacy_default_block');
      expect(result.warning).toBe('privacy_classification_required');
    }
  });
});

describe('v3.1 Type narrowing — CloudReasoningSelection.privacyAction is sent_raw only', () => {
  it('every non-rejected selection has privacyAction=sent_raw and no redactedPrompt', async () => {
    // Try every config combo that produces a selection.
    const cases: Array<{ name: string; cfg: () => void; req: Parameters<typeof selectApprovedCloudReasoningProvider>[0] }> = [
      {
        name: 'non-private',
        cfg: () => {},
        req: { prompt: 'hello', containsPrivateData: false },
      },
      {
        name: 'private + allow_raw + opt-in',
        cfg: () => {
          mockConfig.cloudReasoningFallback.privacy.mode = 'allow_raw';
          mockConfig.cloudReasoningFallback.privacy.allowRawPrivateData = true;
        },
        req: { prompt: RAW_PII_PROMPT, containsPrivateData: true, allowCloudEscalation: true },
      },
    ];
    for (const c of cases) {
      c.cfg();
      const result = await selectApprovedCloudReasoningProvider(
        c.req,
        (name) => name === 'gemini' ? makeCloudProvider('gemini') : null,
      );
      expect(result.rejected, `case: ${c.name}`).toBe(false);
      if (!result.rejected) {
        expect(result.privacyAction, `case: ${c.name}`).toBe('sent_raw');
        // redactedPrompt was removed from CloudReasoningSelection in v3.1.
        // Verify the field is undefined at runtime as a belt-and-suspenders.
        expect((result as unknown as Record<string, unknown>).redactedPrompt, `case: ${c.name}`).toBeUndefined();
      }
    }
  });
});
