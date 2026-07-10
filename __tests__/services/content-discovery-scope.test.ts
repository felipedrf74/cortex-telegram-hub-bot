import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeOneShotWithSearch: vi.fn(),
  completeOneShotWithWebSearch: vi.fn(),
  isOpenAIConfigured: vi.fn(() => false),
  trackedCreate: vi.fn(),
  withAiBudgetReservation: vi.fn(),
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

import { runContentDiscovery } from '../../src/services/content-discovery';

describe('content discovery user scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
