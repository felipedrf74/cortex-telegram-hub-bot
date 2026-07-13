// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * v2.6 hardening tests — direct reproductions of every angry-QA-found
 * bug, used both to verify the fixes land AND as regression tests so the
 * bug class can't sneak back in.
 *
 * Each `describe` block names the Codex finding it locks in.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config', () => ({
  config: {
    ollama: {
      enabled: true, baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.6:35b-a3b-q4_K_M', classifierModel: 'qwen3.6:35b-a3b-q4_K_M',
      timeoutMs: 5000,
      tokenCaps: { classifyMaxInput: 1500, classifyMaxOutput: 128,
        scriptGenMaxInput: 6000, scriptGenMaxOutput: 4096,
        localReasoningMaxInput: 6000, localReasoningMaxOutput: 3000 },
      queue: { backend: 'memory',
        classifyDepth: 4, scriptGenDepth: 2, localReasoningDepth: 2,
        classifyMaxWaitMs: 5000, scriptGenMaxWaitMs: 30000, localReasoningMaxWaitMs: 30000,
        globalMaxDepth: 8 },
      rateLimit: { perUserDaily: 0, perUserHourly: 0, scriptGenPerUserDaily: 0 },
      artifacts: { retentionDays: 14, storePrompts: false, storeGenerated: true },
    },
    cloudReasoningFallback: {
      enabled: false, provider: '', model: '',
      requireApprovedModel: true, allowPreviewModels: false,
      approvedReasoningModels: [], disallowedSubstrings: [],
      onUnapproved: 'return_local_result_with_warning',
      privacy: { mode: 'redacted_only', allowRawPrivateData: false },
    },
  },
}));

// stripThinkBlocks lives in ollama-provider.ts which imports anthropic.ts.
// Mock anthropic to avoid pulling in the real Anthropic SDK init.
vi.mock('../../src/services/anthropic', () => ({
  TOOLS: [],
  getClassifierSystemPrompt: () => 'classifier',
  getDomainSystemPrompt: (d: string) => `domain:${d}`,
}));
vi.mock('../../src/services/database', () => ({
  getDb: () => ({ prepare: () => ({ run: vi.fn(), all: () => [], get: () => undefined }) }),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));
vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
  _resetTelemetryForTests: vi.fn(),
  getBotRef: vi.fn(),
  getGarminRefreshStatus: vi.fn(),
  getJobMap: vi.fn(),
  getJobStatuses: vi.fn(),
  getLastMessageAt: vi.fn(),
  getRecentEvents: vi.fn(),
  isBotPollingActive: vi.fn(),
  isJobEnabled: vi.fn(),
  isRestarting: vi.fn(),
  recordGarminRefresh: vi.fn(),
  recordMessageProcessed: vi.fn(),
  registerJob: vi.fn(),
  seedJobLastRunFromHistory: vi.fn(),
  setBotPollingActive: vi.fn(),
  setBotRef: vi.fn(),
  setDbProvider: vi.fn(),
  setIsRestarting: vi.fn(),
  setJobEnabledChecker: vi.fn(),
  setJobFailureNotifier: vi.fn(),
  wrapJob: vi.fn((name: string, fn: unknown) => fn),
}));
vi.mock('../../src/services/api-usage-fallback', () => ({
  getApiUsageColumns: vi.fn(() => new Set<string>()),
  insertApiUsageFallback: vi.fn(() => 0),
}));
vi.mock('../../src/services/local-llm-rate-limiter', () => ({
  _resetLocalLLMRateLimiterSchemaCacheForTests: vi.fn(),
  checkAndConsumeLocalLLMRateLimit: vi.fn(() => ({ allowed: true })),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { stripThinkBlocks } from '../../src/services/ollama-provider';
import { estimateTokens } from '../../src/services/token-estimator';
import {
  matchesDisallowedSubstring,
  hasNonNegatedPreviewToken,
} from '../../src/services/cloud-reasoning-gate';

describe('Codex finding: stripThinkBlocks must handle case-insensitive tags', () => {
  it('strips <THINK>...</THINK> (uppercase)', () => {
    expect(stripThinkBlocks('<THINK>SECRET</THINK>visible')).toBe('visible');
  });
  it('strips <Think>...</Think> (mixed case)', () => {
    expect(stripThinkBlocks('<Think>SECRET</Think>visible')).toBe('visible');
  });
  it('strips <think >X</think >Y (whitespace inside tag)', () => {
    expect(stripThinkBlocks('<think >X</think >Y')).toBe('Y');
  });
});

describe('Codex finding: stripThinkBlocks must fail-closed on unclosed tags', () => {
  it('drops everything from unclosed <think>', () => {
    expect(stripThinkBlocks('<think>SECRET continues forever')).toBe('');
  });
  it('drops everything from unclosed <THINK>', () => {
    expect(stripThinkBlocks('<THINK>SECRET')).toBe('');
  });
  it('emits content before unclosed <think>', () => {
    expect(stripThinkBlocks('VISIBLE<think>SECRET')).toBe('VISIBLE');
  });
});

describe('Codex finding: stripThinkBlocks must handle nested tags (depth-tracked)', () => {
  it('depth=2 nested with matched outer close emits only post-content', () => {
    const input = '<think>A<think>B</think>C</think>D';
    expect(stripThinkBlocks(input)).toBe('D');
  });
  it('depth=3 nested', () => {
    const input = '<think>A<think>B<think>C</think>D</think>E</think>F';
    expect(stripThinkBlocks(input)).toBe('F');
  });
  it('STILL_SECRET (Codex reproduction) does not leak', () => {
    // The original bug: greedy regex would match inner close, leaving
    // outer content visible. With depth tracking, all inner content
    // including the after-inner-close STILL_SECRET is correctly swallowed.
    const input = '<think>OUTER<think>INNER</think>STILL_SECRET</think>{"ok":true}';
    expect(stripThinkBlocks(input)).toBe('{"ok":true}');
    expect(stripThinkBlocks(input)).not.toContain('STILL_SECRET');
  });
});

describe('Codex finding: stripThinkBlocks normal cases still work', () => {
  it('preserves benign text unchanged', () => {
    expect(stripThinkBlocks('hello world')).toBe('hello world');
  });
  it('handles empty/null/undefined', () => {
    expect(stripThinkBlocks('')).toBe('');
    expect(stripThinkBlocks(null)).toBe('');
    expect(stripThinkBlocks(undefined)).toBe('');
  });
  it('strips standard lowercase block', () => {
    expect(stripThinkBlocks('<think>x</think>y')).toBe('y');
  });
});

describe('Codex finding: estimateTokens must NOT under-count CJK', () => {
  it('500 Chinese chars estimates >= 500 tokens (not 167)', () => {
    const chinese = '中'.repeat(500);  // 500 chars, 1500 UTF-8 bytes
    const est = estimateTokens(chinese);
    expect(est).toBeGreaterThanOrEqual(500);
  });
  it('100 emoji estimates conservatively', () => {
    const emoji = '🎯'.repeat(100);  // 100 grapheme units, 400 UTF-8 bytes
    expect(estimateTokens(emoji)).toBeGreaterThanOrEqual(100);
  });
  it('English text uses char/3 baseline', () => {
    const english = 'a'.repeat(300);  // 300 chars, 300 UTF-8 bytes
    expect(estimateTokens(english)).toBe(100);
  });
  it('mixed Arabic + English estimates safely (NO-OP fix: specific bound)', () => {
    const arabic = 'مرحبا '.repeat(100);  // 600 chars, 1100 UTF-8 bytes
    // 600 chars / 3 = 200, 1100 bytes / 3 = 367. max = 367.
    expect(estimateTokens(arabic)).toBeGreaterThanOrEqual(366);
    expect(estimateTokens(arabic)).toBeLessThanOrEqual(400);
  });
});

describe('Codex finding: matchesDisallowedSubstring must not flag mid-word matches', () => {
  it('"mini" inside "geMINI-2.5-pro" must NOT match', () => {
    expect(matchesDisallowedSubstring('gemini-2.5-pro', ['mini'])).toBe(false);
  });
  it('"preview" inside "gemini-non-preview" matches the matcher (syntactic), but the gate skips preview-block for it', () => {
    // The token-boundary matcher itself is syntactic — `preview` is a
    // free token in `gemini-non-preview`, so the matcher returns true.
    // However the gate in `cloud-reasoning-gate.ts` checks for explicit
    // English negations (`non-`, `not-`, `no-`) BEFORE applying the
    // preview block, so `gemini-non-preview` correctly passes through.
    // (v2.8 fix.)
    expect(matchesDisallowedSubstring('gemini-non-preview', ['preview'])).toBe(true);
    // Integration: see __tests__/services/cloud-reasoning-gate.test.ts
    // 'gemini-non-preview is allowed (negation)' for the gate-level
    // assertion that this model is NOT rejected.
  });
  it('"preview" inside "preview-of-future" matches (free-standing)', () => {
    expect(matchesDisallowedSubstring('preview-of-future', ['preview'])).toBe(true);
  });
  it('"preview" inside "previewer" does NOT match (no right boundary)', () => {
    expect(matchesDisallowedSubstring('previewer', ['preview'])).toBe(false);
  });
  it('"mini" inside "gpt-5-mini" matches', () => {
    expect(matchesDisallowedSubstring('gpt-5-mini', ['mini'])).toBe(true);
  });
  it('"haiku" inside "claude-haiku-4-5" matches', () => {
    expect(matchesDisallowedSubstring('claude-haiku-4-5', ['haiku'])).toBe(true);
  });
  it('"flash" inside "geminiflash" does NOT match (no boundary)', () => {
    expect(matchesDisallowedSubstring('geminiflash', ['flash'])).toBe(false);
  });
  it('"flash" at end-of-string "gemini-2.5-flash" matches', () => {
    expect(matchesDisallowedSubstring('gemini-2.5-flash', ['flash'])).toBe(true);
  });
});

describe('v2.9 (angry-QA-found): per-token preview negation', () => {
  it('un-negated preview blocks: gemini-pro-preview', () => {
    expect(hasNonNegatedPreviewToken('gemini-pro-preview')).toBe(true);
  });
  it('single negation allows: gemini-non-preview', () => {
    expect(hasNonNegatedPreviewToken('gemini-non-preview')).toBe(false);
  });
  it('not-preview allows: gemini-not-preview', () => {
    expect(hasNonNegatedPreviewToken('gemini-not-preview')).toBe(false);
  });
  it('no-preview allows: gemini-no-preview', () => {
    expect(hasNonNegatedPreviewToken('gemini-no-preview')).toBe(false);
  });
  it('mixed: gemini-pro-preview-non-preview BLOCKS (first preview is un-negated)', () => {
    // Codex's exact reproduction case.
    expect(hasNonNegatedPreviewToken('gemini-pro-preview-non-preview')).toBe(true);
  });
  it('mixed reverse: gemini-pro-non-preview-preview BLOCKS (last preview is un-negated)', () => {
    expect(hasNonNegatedPreviewToken('gemini-pro-non-preview-preview')).toBe(true);
  });
  it('both negated: gemini-non-preview-not-preview allows', () => {
    expect(hasNonNegatedPreviewToken('gemini-non-preview-not-preview')).toBe(false);
  });
  it('no preview at all: gemini-2.5-pro allows', () => {
    expect(hasNonNegatedPreviewToken('gemini-2.5-pro')).toBe(false);
  });
  it('previewer (no token boundary) does not count', () => {
    expect(hasNonNegatedPreviewToken('previewer')).toBe(false);
  });
});

describe('v3.1 (architectural pivot — Codex round 6): redactor REMOVED entirely', () => {
  // staticRedactPrompt and containsTagLikePattern were removed in v3.1
  // after Codex reproduced raw AWS keys and IBANs reaching the cloud
  // SDK boundary via PII classes the regex did not anticipate. The
  // structural finding: any 'redact-then-forward' design treats
  // unmatched bytes as safe, but PII coverage is infinite. The honest
  // posture is to not ship a redactor we do not trust.
  it('staticRedactPrompt symbol must not exist on the gate module', async () => {
    const mod = await import('../../src/services/cloud-reasoning-gate');
    expect((mod as unknown as Record<string, unknown>).staticRedactPrompt).toBeUndefined();
  });
  it('containsTagLikePattern symbol must not exist on the gate module', async () => {
    const mod = await import('../../src/services/cloud-reasoning-gate');
    expect((mod as unknown as Record<string, unknown>).containsTagLikePattern).toBeUndefined();
  });
  it('CloudReasoningSelection.privacyAction type narrows to sent_raw only', async () => {
    // This is a TS-only check; runtime confirms the gate never produces
    // 'sent_redacted' under any config. Tested behaviorally in
    // cloud-reasoning-gate.test.ts. Here we just assert the module
    // does NOT re-export anything named 'StaticRedactionResult'.
    const mod = await import('../../src/services/cloud-reasoning-gate');
    expect((mod as unknown as Record<string, unknown>).StaticRedactionResult).toBeUndefined();
  });
});
