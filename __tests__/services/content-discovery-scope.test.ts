import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const mocks = vi.hoisted(() => ({
  completeOneShotWithSearch: vi.fn(),
  completeOneShotWithWebSearch: vi.fn(),
  isOpenAIConfigured: vi.fn(() => false),
  trackedCreate: vi.fn(),
  withAiBudgetReservation: vi.fn(),
  isDuplicateIdea: vi.fn(async () => ({ isDuplicate: false, confidence: 0 })),
  captureDiscoveredIdea: vi.fn(() => ({ replayed: false })),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  withAiBudgetReservation: (...args: unknown[]) => mocks.withAiBudgetReservation(...args),
}));

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShotWithSearch: (...args: unknown[]) => mocks.completeOneShotWithSearch(...args),
  isGeminiProviderConfigured: vi.fn(() => true),
}));

vi.mock('../../src/services/openai-provider', () => ({
  completeOneShotWithWebSearch: (...args: unknown[]) => mocks.completeOneShotWithWebSearch(...args),
  isOpenAIConfigured: (...args: unknown[]) => mocks.isOpenAIConfigured(...args),
}));

vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => false),
}));

vi.mock('../../src/portal/anthropic-hook', () => ({
  trackedCreate: (...args: unknown[]) => mocks.trackedCreate(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: vi.fn(() => 'en-US'),
}));

vi.mock('../../src/services/content-dedup', () => ({
  isDuplicateIdea: (...args: unknown[]) => mocks.isDuplicateIdea(...args),
}));

vi.mock('../../src/services/content-workspace-capture', () => ({
  captureDiscoveredIdea: (...args: unknown[]) => mocks.captureDiscoveredIdea(...args),
}));

import { runContentDiscovery } from '../../src/services/content-discovery';

describe('content discovery user scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAiBudgetReservation.mockImplementation(async (_request, providerCall) => providerCall());
  });

  it('rejects missing or invalid user scope before provider calls or saved-idea writes', async () => {
    await expect(runContentDiscovery(undefined as any)).rejects.toThrow(/userId required/);
    await expect(runContentDiscovery({ userId: 0 } as any)).rejects.toThrow(/userId required/);
    await expect(runContentDiscovery({ userId: 1.5 } as any)).rejects.toThrow(/userId required/);
    await expect(runContentDiscovery({ userId: Number.MAX_SAFE_INTEGER + 1 } as any)).rejects.toThrow(/userId required/);
  });

  it('rejects authenticated discovery without validated tenant scope', async () => {
    await expect(runContentDiscovery({ userId: 42 } as any)).rejects.toThrow(/runContentDiscovery requires a validated tenantId/);
  });

  it('reserves the complete interactive provider chain before Gemini or Anthropic can run', async () => {
    const denial = new Error('AI_PLAN_REQUIRED');
    mocks.withAiBudgetReservation.mockRejectedValueOnce(denial);

    await expect(runContentDiscovery({ userId: 42, tenantId: 42 })).rejects.toBe(denial);

    expect(mocks.withAiBudgetReservation).toHaveBeenCalledWith({
      userId: 42,
      requestSource: 'interactive',
      baseCategory: 'content_discovery',
      jobName: 'content_discovery',
    }, expect.any(Function));
    expect(mocks.completeOneShotWithSearch).not.toHaveBeenCalled();
    expect(mocks.trackedCreate).not.toHaveBeenCalled();
  });

  it('captures discovery output canonically and never writes the retired shared markdown file', async () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    mocks.completeOneShotWithSearch.mockResolvedValueOnce({
      text: [
        '# Content Ideas — 2026-07-17',
        '## Idea 1: Canonical discovery workspace',
        '**Why now:** Useful now.',
        '## Quick-Fire Shorts (bonus)',
        '- One-minute creator systems check',
      ].join('\n'),
      sources: ['https://example.test/fresh-source'],
    });

    const result = await runContentDiscovery({ userId: 42, tenantId: 42 });

    expect(result).toMatchObject({
      ideas: ['Canonical discovery workspace', 'One-minute creator systems check'],
      filePath: null,
      storage: 'content_workspace',
      provider: 'gemini',
    });
    expect(mocks.captureDiscoveredIdea).toHaveBeenCalledTimes(2);
    expect(mocks.captureDiscoveredIdea).toHaveBeenCalledWith(expect.objectContaining({
      scope: { tenantId: 42, userId: 42 },
      title: 'Canonical discovery workspace',
      provider: 'gemini',
    }));
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});
